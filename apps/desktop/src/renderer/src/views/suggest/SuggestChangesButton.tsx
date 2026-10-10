import type { RepoId } from '@githappens/git/types';
import type { PullRequest } from '@githappens/providers/types';
import { Lightbulb } from 'lucide-react';
import { useEffect, useState } from 'react';

import { errorText, extrasInvoke } from '../../cloud/extras-api';
import { useTabsStore } from '../../stores/tabs';
import { useToastStore } from '../../stores/toasts';
import { toSuggestPr, useSuggestStore } from './suggest-store';

/**
 * "Suggest changes" (spec 14 §4.3) for the PullRequestView header: creates an isolated worktree at the
 * PR head (the main checkout is untouched) and opens it as a tab; the SuggestModeBanner there offers
 * Submit / Discard. Mount: `<SuggestChangesButton repoId={repoId} pr={pr} />`.
 */
export function SuggestChangesButton({
  repoId,
  pr,
  className,
}: {
  repoId: RepoId;
  pr: PullRequest;
  className?: string;
}) {
  const sessions = useSuggestStore((s) => s.sessions);
  const refresh = useSuggestStore((s) => s.refresh);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!useSuggestStore.getState().loaded) void refresh();
  }, [refresh]);

  const existing = sessions.find(
    (s) =>
      s.pr.number === pr.number &&
      s.pr.ref.owner.toLowerCase() === pr.repo.owner.toLowerCase() &&
      s.pr.ref.name.toLowerCase() === pr.repo.name.toLowerCase(),
  );
  const closed = pr.state === 'merged' || pr.state === 'closed';

  const start = async (): Promise<void> => {
    if (existing) {
      await useTabsStore.getState().openRepo(existing.worktreePath);
      return;
    }
    setBusy(true);
    try {
      const session = await extrasInvoke('suggest:start', { repoId, pr: toSuggestPr(pr) });
      await refresh();
      await useTabsStore.getState().openRepo(session.worktreePath);
      useToastStore.getState().push({
        kind: 'info',
        title: `Suggesting changes on PR #${pr.number}`,
        body: 'Edit any file in this tab (your own checkout is untouched), then Submit suggestion.',
      });
    } catch (e) {
      useToastStore
        .getState()
        .push({ kind: 'error', title: 'Could not start a suggestion', body: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      className={className}
      onClick={() => void start()}
      disabled={busy || closed}
      title={
        closed
          ? 'The pull request is closed'
          : existing
            ? 'Continue your suggestion for this pull request'
            : 'Edit any file of this pull request in an isolated worktree and suggest the changes'
      }
    >
      <Lightbulb size={14} /> {existing ? 'Continue suggestion' : busy ? 'Preparing…' : 'Suggest changes'}
    </button>
  );
}
