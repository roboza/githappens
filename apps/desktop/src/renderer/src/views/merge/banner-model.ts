import type { GitOperation } from '@githappens/git/ops';
import type { ConflictFileInfo, InProgressOp, RepoOperationState } from '@githappens/git/types';

import { shortSha } from '../../lib/format';

/** Pure model of the in-progress operation banner (spec 08 §4.2, §6.7); DOM-free for unit tests. */

/** Whether the file opens in the 3-way text tool (vs. the special-conflict card). */
export const isTextConflict = (c: ConflictFileInfo): boolean =>
  c.kind === 'text' && (c.code === 'UU' || c.code === 'AA');

/** True when every conflicted file is a text file without remaining markers ("Mark all resolved"). */
export const allMarkersGone = (s: RepoOperationState | undefined): boolean =>
  !!s?.conflicts.length && s.conflicts.every((c) => isTextConflict(c) && c.unresolvedChunks === 0);

export const OP_NOUN: Record<InProgressOp, string> = {
  merge: 'merge',
  rebase: 'rebase',
  'cherry-pick': 'cherry-pick',
  revert: 'revert',
  'stash-apply': 'stash apply',
  am: 'patch apply',
};

export const ABORT: Partial<Record<InProgressOp, GitOperation>> = {
  merge: { type: 'merge.abort' },
  rebase: { type: 'rebase.abort' },
  'cherry-pick': { type: 'sequencer.abort' },
  revert: { type: 'sequencer.abort' },
  am: { type: 'am.abort' },
};
export const SKIP: Partial<Record<InProgressOp, GitOperation>> = {
  rebase: { type: 'rebase.skip' },
  'cherry-pick': { type: 'sequencer.skip' },
  revert: { type: 'sequencer.skip' },
  am: { type: 'am.skip' },
};
export const CONTINUE_LABEL: Partial<Record<InProgressOp, string>> = {
  merge: 'Commit merge…',
  rebase: 'Continue rebase',
  'cherry-pick': 'Continue cherry-pick',
  revert: 'Continue revert',
  am: 'Continue',
};
/** Toast when the operation finished (no longer in progress after Continue / Skip). */
export const DONE_TOAST: Partial<Record<InProgressOp, string>> = {
  rebase: 'Rebase complete',
  'cherry-pick': 'Cherry-pick complete',
  revert: 'Revert complete',
  am: 'All patches applied',
};
/** Toast when more steps remain. */
export const NEXT_TOAST: Partial<Record<InProgressOp, string>> = {
  rebase: 'Rebase continued',
  'cherry-pick': 'Cherry-pick continued',
  revert: 'Revert continued',
  am: 'Patch applied',
};

export const BANNER_OPS: GitOperation['type'][] = [
  'merge.continue',
  'merge.abort',
  'rebase.continue',
  'rebase.skip',
  'rebase.abort',
  'sequencer.continue',
  'sequencer.skip',
  'sequencer.abort',
  'am.continue',
  'am.skip',
  'am.abort',
  'conflict.resetMerge',
  'conflict.markResolved',
];

const ref = (x: { label: string; sha: string | null }): string => x.label || (x.sha ? shortSha(x.sha) : '?');

/** Banner text per operation (spec 08 §4.2). */
export function describeOperation(s: RepoOperationState): string {
  switch (s.op) {
    case 'merge':
      return `Merging ${ref(s.incoming)} into ${ref(s.current)}`;
    case 'rebase': {
      const r = s.rebase;
      let t = `Rebasing onto ${r?.ontoLabel || ref(s.current)}`;
      if (r && r.total) t += ` — step ${r.step}/${r.total}`;
      if (r?.currentCommit) t += `: ${shortSha(r.currentCommit.sha)} ${r.currentCommit.subject}`;
      return t;
    }
    case 'cherry-pick': {
      const more = s.sequencer?.remaining.length ?? 0;
      return `Cherry-picking ${s.incoming.sha ? shortSha(s.incoming.sha) : ref(s.incoming)} onto ${ref(s.current)}${more ? ` (${more} more queued)` : ''}`;
    }
    case 'revert': {
      const more = s.sequencer?.remaining.length ?? 0;
      return `Reverting ${s.incoming.sha ? shortSha(s.incoming.sha) : ref(s.incoming)}${more ? ` (${more} more queued)` : ''}`;
    }
    case 'stash-apply':
      return `Applying ${s.stash ? `stash@{${s.stash.index}}` : ref(s.incoming)} — conflicts`;
    case 'am':
      return 'Applying patches (git am)';
    default:
      return '';
  }
}

/**
 * What the banner should offer (pure, unit-tested): which buttons exist and whether Continue / Mark all
 * resolved are enabled (spec 08 §4.2, §6.7).
 */
export function bannerModel(s: RepoOperationState): {
  abort: 'abort' | 'reset' | null;
  skip: boolean;
  continueLabel: string | null;
  canContinue: boolean;
  markAll: boolean;
  status: string;
} {
  const op = s.op!;
  const conflicts = s.conflicts.length;
  const resolved = s.resolvedPending?.length ?? 0;
  const status =
    conflicts > 0
      ? `${conflicts} conflicted file${conflicts === 1 ? '' : 's'}${resolved ? `, ${resolved} resolved` : ''}`
      : op === 'rebase' && s.rebase?.currentCommit
        ? 'stopped — ready to continue'
        : 'no conflicts remaining';
  return {
    abort: op === 'stash-apply' ? 'reset' : ABORT[op] ? 'abort' : null,
    skip: !!SKIP[op],
    continueLabel: CONTINUE_LABEL[op] ?? null,
    canContinue: conflicts === 0,
    markAll: allMarkersGone(s),
    status,
  };
}
