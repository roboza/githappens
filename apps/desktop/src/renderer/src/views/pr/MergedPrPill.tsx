import type { CheckoutTarget } from '@githappens/git/ops';
import type { RefInfo, RepoId } from '@githappens/git/types';
import { GitMerge, GitPullRequestClosed, Trash2 } from 'lucide-react';

import { choose } from '../../components/Dialogs';
import { invoke } from '../../lib/api';
import { formatDate } from '../../lib/format';
import { useRefs, useRepoInfo } from '../../repo/queries';
import { useToastStore } from '../../stores/toasts';
import { checkout, deleteBranch } from '../../actions/git-actions';
import { usePrIndex } from '../../integrations/queries';
import { toneClass, isoSecs } from '../../integrations/ui';
import { openPrFromIndex } from './PrBadge';
import s from './MergedPrPill.module.css';

type BranchTarget = Extract<CheckoutTarget, { kind: 'branch' | 'remoteBranch' }>;

/** Where to go before deleting the checked-out branch: origin's default branch, else main/master/develop. */
export function defaultBranchTarget(refs: readonly RefInfo[], current: string): BranchTarget | null {
  const locals = new Set(refs.filter((r) => r.type === 'local').map((r) => r.shortName));
  const remoteHead = refs.find(
    (r) => r.type === 'remote' && r.symrefTarget && r.shortName.startsWith('origin/'),
  );
  const fromHead = remoteHead?.symrefTarget?.replace(/^refs\/remotes\/origin\//, '');
  const candidates = [fromHead, 'main', 'master', 'develop', 'trunk'].filter(
    (b): b is string => !!b && b !== current,
  );
  for (const b of candidates) if (locals.has(b)) return { kind: 'branch', name: b };
  for (const b of candidates)
    if (refs.some((r) => r.type === 'remote' && r.shortName === `origin/${b}`))
      return { kind: 'remoteBranch', remote: 'origin', name: b };
  return null;
}

async function deleteMergedBranch(repoId: RepoId, branch: string, refs: readonly RefInfo[]): Promise<void> {
  const ref = refs.find((r) => r.type === 'local' && r.shortName === branch);
  if (!ref) return;
  if (ref.isHead) {
    const target = defaultBranchTarget(refs, branch);
    if (!target) {
      useToastStore.getState().push({
        kind: 'warning',
        title: `${branch} is checked out`,
        body: 'Check out another branch first, then delete it.',
      });
      return;
    }
    const pick = await choose({
      title: `Delete ${branch}?`,
      message: `${branch} is checked out. GitHappens will check out ${target.name} first.`,
      choices: [
        { value: 'cancel', label: 'Cancel' },
        { value: 'go', label: `Check out ${target.name} & delete`, primary: true },
      ],
    });
    if (pick?.value !== 'go') return;
    await checkout(repoId, target);
    const info = await invoke('git:repo:info', { repoId });
    if (info.head.kind === 'branch' && info.head.name === branch) return; // checkout cancelled / failed
  }
  await deleteBranch(repoId, { ...ref, isHead: false });
}

/**
 * "PR #n merged · Delete branch" / "PR #n closed" pill for the checked-out branch (spec 10 §4.6), shown
 * when the PR index holds a merged / closed PR (last 7 days) for it. Renders nothing otherwise.
 */
export function MergedPrPill({ repoId, className }: { repoId: RepoId; className?: string }) {
  const index = usePrIndex(repoId);
  const head = useRepoInfo(repoId).data?.head;
  const refs = useRefs(repoId).data;
  const branch = head?.kind === 'branch' ? head.name : null;
  if (!branch) return null;
  const local = refs?.find((r) => r.type === 'local' && r.shortName === branch);
  const upstream = local?.upstream?.fullName.replace(/^refs\/remotes\//, '');
  const entry = (upstream && index.get(upstream)) || index.get(branch);
  if (!entry || (entry.pr.state !== 'merged' && entry.pr.state !== 'closed')) return null;
  const merged = entry.pr.state === 'merged';
  const when = merged ? entry.pr.mergedAt : entry.pr.closedAt;
  const Icon = merged ? GitMerge : GitPullRequestClosed;
  const title = `#${entry.pr.number} ${entry.pr.title} — ${merged ? 'merged' : 'closed'}${
    when ? ` ${formatDate(isoSecs(when))}` : ''
  }`;
  return (
    <div className={`${s.pill} ${toneClass(merged ? 'purple' : 'red')} ${className ?? ''}`} role="status">
      <button
        type="button"
        className={s.main}
        title={title}
        onClick={() => void openPrFromIndex(repoId, entry)}
      >
        <Icon size={12} aria-hidden />
        <span>
          PR #{entry.pr.number} {merged ? 'merged' : 'closed'}
        </span>
      </button>
      {merged && local && (
        <button
          type="button"
          className={s.action}
          title={`Delete the local branch ${branch}`}
          onClick={() => refs && void deleteMergedBranch(repoId, branch, refs)}
        >
          <Trash2 size={11} aria-hidden /> Delete branch
        </button>
      )}
    </div>
  );
}
