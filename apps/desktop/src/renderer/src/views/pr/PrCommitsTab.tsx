import type { RepoId } from '@githappens/git/types';
import type { PullRequest } from '@githappens/providers/types';
import { useQuery } from '@tanstack/react-query';
import { Loader2, RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';

import { formatDate, shortSha } from '../../lib/format';
import { intInvoke } from '../../integrations/api';
import { usePrCommits } from '../../integrations/queries';
import { ProviderErrorLine, uiStyles } from '../../integrations/ui';
import { useRepoUi, useRepoUiStore } from '../../stores/repo-ui';
import { pluralize } from './pr-view-helpers';
import s from './PullRequestView.module.css';

/**
 * `pr:fetch` for the Commits / Files changed tabs (spec 10 §4.7): fetches the PR head into
 * `refs/githappens/pr/<n>` and the base branch, without touching local branches. Shared by both tabs via
 * the query cache; re-fetched when the head sha changes.
 */
export function usePrFetch(repoId: RepoId, pr: PullRequest, enabled: boolean) {
  return useQuery({
    queryKey: ['pr', 'fetch', repoId, pr.repo.owner, pr.repo.name, pr.number, pr.head.sha],
    queryFn: () => intInvoke('pr:fetch', { repoId, pr }),
    enabled,
    staleTime: Infinity,
    gcTime: 10 * 60_000,
    retry: false,
  });
}

export type PrFetch = ReturnType<typeof usePrFetch>;

/** Loading / error states of `pr:fetch`; renders `children` with the local refs once fetched. */
export function PrFetchGate({
  pr,
  fetch,
  children,
}: {
  pr: PullRequest;
  fetch: PrFetch;
  children: (refs: { headRef: string; baseRef: string }) => ReactNode;
}) {
  if (fetch.data) return <>{children(fetch.data)}</>;
  if (fetch.error) {
    const gone = pr.state === 'merged' || pr.state === 'closed';
    return (
      <div className={s.tabPane}>
        {gone && (
          <div className={s.note}>
            This pull request is {pr.state}; its source branch
            {pr.head.repo ? '' : ' (and fork)'} may have been deleted, so its commits could not be fetched.
            The changes are still visible on the provider&apos;s website.
          </div>
        )}
        <ProviderErrorLine error={fetch.error} onRetry={() => void fetch.refetch()} />
      </div>
    );
  }
  return (
    <div className={s.loading}>
      <Loader2 size={13} className={uiStyles.spin} /> Fetching pull request…
    </div>
  );
}

/** Commits tab: local `git log base..head` of the fetched PR refs; click opens the commit detail. */
export function PrCommitsTab({ repoId, pr, fetch }: { repoId: RepoId; pr: PullRequest; fetch: PrFetch }) {
  return (
    <PrFetchGate pr={pr} fetch={fetch}>
      {(refs) => <CommitList repoId={repoId} baseRef={refs.baseRef} headRef={refs.headRef} fetch={fetch} />}
    </PrFetchGate>
  );
}

function CommitList({
  repoId,
  baseRef,
  headRef,
  fetch,
}: {
  repoId: RepoId;
  baseRef: string;
  headRef: string;
  fetch: PrFetch;
}) {
  const commits = usePrCommits(repoId, baseRef, headRef);
  const active = useRepoUi(repoId, (u) => (u.selection.kind === 'commit' ? u.selection.sha : null));
  const open = (sha: string): void =>
    useRepoUiStore.getState().update(repoId, () => ({ selection: { kind: 'commit', sha }, explain: null }));

  return (
    <div className={s.tabPane}>
      <div className={s.tabToolbar}>
        <span className={s.grow}>
          {commits.data ? pluralize(commits.data.length, 'commit') : 'Loading commits…'}
          {commits.data?.length === 250 ? ' (showing the newest 250)' : ''}
        </span>
        <button
          type="button"
          className={s.iconBtn}
          title="Fetch the pull request again"
          disabled={fetch.isFetching}
          onClick={() => {
            void fetch.refetch().then(() => void commits.refetch());
          }}
        >
          <RefreshCw size={12} className={fetch.isFetching ? uiStyles.spin : undefined} /> Fetch again
        </button>
      </div>
      {commits.error ? (
        <ProviderErrorLine error={commits.error} onRetry={() => void commits.refetch()} />
      ) : commits.data?.length === 0 ? (
        <div className={s.none}>No commits between the base and head of this pull request.</div>
      ) : (
        <div className={s.card} role="list" aria-label="Commits">
          {commits.data?.map((c) => (
            <button
              key={c.sha}
              type="button"
              role="listitem"
              className={s.commitRow}
              aria-current={active === c.sha || undefined}
              title="Click to show details · double-click to show in the graph"
              onClick={() => open(c.sha)}
              onDoubleClick={() => useRepoUiStore.getState().reveal(repoId, c.sha)}
            >
              <code>{shortSha(c.sha)}</code>
              <span className={s.subject}>{c.subject}</span>
              <span className={s.dim}>{c.authorName}</span>
              <span className={s.dim}>{formatDate(c.date)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
