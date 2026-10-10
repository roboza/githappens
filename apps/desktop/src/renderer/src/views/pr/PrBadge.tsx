import type { RepoId } from '@githappens/git/types';
import type { PrIndexEntry } from '@githappens/providers/types';
import { GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from 'lucide-react';

import { useToastStore } from '../../stores/toasts';
import { intInvoke } from '../../integrations/api';
import { pickRefForPr, prBadgeTitle, rollupTone, stateTone } from '../../integrations/helpers';
import { formatDate } from '../../lib/format';
import { isoSecs, toneClass } from '../../integrations/ui';
import { openPullRequestView } from './pr-actions';
import s from './PrBadge.module.css';

/** Open the PR center view for a graph badge entry (resolves the hosting repo from the remotes). */
export async function openPrFromIndex(repoId: RepoId, entry: PrIndexEntry): Promise<void> {
  try {
    const remotes = await intInvoke('provider:resolveRemotes', { repoId });
    const ref = pickRefForPr(remotes, entry.pr.webUrl, entry.remote);
    if (ref) openPullRequestView(repoId, ref, entry.pr.number);
    else
      useToastStore.getState().push({ kind: 'warning', title: `No connected account for ${entry.remote}` });
  } catch (e) {
    useToastStore.getState().push({ kind: 'error', title: 'Could not open pull request', body: String(e) });
  }
}

/** Badge tooltip: merged / closed PRs say when (they stay in the index for 7 days), open ones show checks. */
export function prBadgeTooltip(pr: PrIndexEntry['pr']): string {
  if (pr.state === 'merged' || pr.state === 'closed') {
    const when = pr.state === 'merged' ? (pr.mergedAt ?? pr.closedAt) : pr.closedAt;
    return `#${pr.number} ${pr.title} — ${pr.state}${when ? ` ${formatDate(isoSecs(when))}` : ''}`;
  }
  return prBadgeTitle(pr);
}

/**
 * Small PR glyph for graph ref pills (spec 10 §4.6): icon + number tinted by state, plus a rollup dot
 * for open PRs. Click calls `onOpen(entry)`; without it (and with `repoId`) opens the PR view.
 */
export function PrBadge({
  entry,
  onOpen,
  repoId,
}: {
  entry: PrIndexEntry;
  onOpen?: (entry: PrIndexEntry) => void;
  repoId?: RepoId;
}) {
  const { pr } = entry;
  const Icon =
    pr.state === 'merged'
      ? GitMerge
      : pr.state === 'closed'
        ? GitPullRequestClosed
        : pr.state === 'draft'
          ? GitPullRequestDraft
          : GitPullRequest;
  const live = pr.state === 'open' || pr.state === 'draft';
  // Open: rollup colour; draft grey; merged purple; closed red (spec 10 §4.6).
  const tone = pr.state === 'open' ? rollupTone(pr.rollup) : stateTone(pr.state);
  const tip = prBadgeTooltip(pr);
  const click = (): void => {
    if (onOpen) onOpen(entry);
    else if (repoId) void openPrFromIndex(repoId, entry);
  };
  return (
    <span
      role="button"
      tabIndex={0}
      className={`${s.badge} ${toneClass(tone)} ${live ? '' : s.done}`}
      title={tip}
      aria-label={tip}
      onClick={(e) => {
        e.stopPropagation();
        click();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          click();
        }
      }}
    >
      <Icon size={11} aria-hidden />
      <span className={s.num}>{pr.number}</span>
      {live && pr.rollup !== 'none' && (
        <span className={`${s.dot} ${toneClass(rollupTone(pr.rollup))}`} aria-hidden />
      )}
    </span>
  );
}
