import type { RepoId } from '@githappens/git/types';
import type { PullRequest } from '@githappens/providers/types';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Lightbulb } from 'lucide-react';
import { useEffect, useMemo } from 'react';

import { errorText, extrasInvoke, extrasKeys, extrasOn } from '../../cloud/extras-api';
import s from './Suggest.module.css';
import { toSuggestPr } from './suggest-store';
import { openSuggestionView } from './SuggestionView';

/**
 * SuggestionsBox (spec 14 §4.3) for the PullRequestView: suggestions found in PR comments (link pattern,
 * works without the server) merged with the server list; opening one shows the SuggestionView.
 * Mount: `<SuggestionsBox repoId={repoId} pr={pr} />` (renders nothing when there are none).
 */
export function SuggestionsBox({ repoId, pr }: { repoId: RepoId; pr: PullRequest }) {
  const qc = useQueryClient();
  const spr = useMemo(() => toSuggestPr(pr), [pr]);
  const key = extrasKeys.suggestions(pr.repo.owner, pr.repo.name, pr.number);
  const q = useQuery({
    queryKey: key,
    queryFn: () => extrasInvoke('suggest:list', { repoId, pr: spr }),
    staleTime: 60_000,
  });
  useEffect(
    () => extrasOn('suggest:changed', () => void qc.invalidateQueries({ queryKey: ['suggest', 'list'] })),
    [qc],
  );

  if (q.isError) {
    return (
      <div className={s.box}>
        <div className={s.boxHeader}>
          <Lightbulb size={14} /> Code suggestions
        </div>
        <p className={s.error}>{errorText(q.error)}</p>
      </div>
    );
  }
  const items = q.data?.items ?? [];
  if (!items.length) return null;
  return (
    <section className={s.box} aria-label="Code suggestions">
      <div className={s.boxHeader}>
        <Lightbulb size={14} /> Code suggestions <span className={s.pill}>{items.length}</span>
      </div>
      {items.map((it) => (
        <div key={it.key} className={s.row}>
          <span className={s.rowTitle} title={it.title}>
            {it.title}
          </span>
          <span className={s.muted}>{it.author.login ?? it.author.name ?? ''}</span>
          <span className={s.pill} data-status={it.status}>
            {it.status}
          </span>
          {it.prHeadSha && it.prHeadSha !== pr.head.sha && (
            <span className={s.muted} title="Made on an older head of this pull request">
              older head
            </span>
          )}
          <button
            type="button"
            onClick={() => void openSuggestionView({ repoId, info: it, pr: spr }).then(() => q.refetch())}
          >
            Review
          </button>
        </div>
      ))}
    </section>
  );
}
