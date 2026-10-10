import type { RepoId, Sha } from '@githappens/git/types';

import { openCompose, openExplain } from '../../ai/actions';
import { aiEnabled } from '../../ai/hooks';
import type { MenuEntry } from '../../components/ContextMenu';
import { invoke } from '../../lib/api';
import { shortSha } from '../../lib/format';
import {
  cherryPickCommits,
  rebaseCommitsOnto,
  revertCommits,
  saveCommitsPatch,
  squashCommits,
  type CommitLite,
} from './branching-actions';
import { isChain } from './ref-names';

export { isChain };

export interface MultiCommitContext {
  headSha: Sha | null;
  /** Checked-out branch, null when detached. */
  headBranch: string | null;
}

/**
 * Context menu for a multi-commit graph selection (spec 04 §4.10, spec 05 §4.2 "Multiple commits selected").
 * `commits` are in graph row order (newest first).
 */
export function multiCommitMenu(repoId: RepoId, commits: CommitLite[], ctx: MultiCommitContext): MenuEntry[] {
  const n = commits.length;
  const shas = commits.map((c) => c.sha);
  const newest = commits[0];
  const oldest = commits[n - 1];
  const chain = isChain(commits);
  const merges = commits.some((c) => c.parents.length > 1);
  const endsAtHead = !!newest && newest.sha === ctx.headSha;
  const onHeadLine = chain && !merges && !!ctx.headBranch;
  const copy = (text: string) => (): void => void invoke('shell:copyText', { text });

  const items: MenuEntry[] = [
    {
      label: `Cherry-pick ${n} commits`,
      disabled: !ctx.headSha,
      title: 'Applied oldest first onto the current branch',
      onSelect: () => void cherryPickCommits(repoId, [...commits].reverse()),
    },
    {
      label: `Revert ${n} commits`,
      title: 'Reverted newest first',
      onSelect: () => void revertCommits(repoId, commits),
    },
    {
      label: `Squash ${n} commits…`,
      disabled: !onHeadLine,
      title: onHeadLine
        ? 'Combine into one commit (you can edit the message)'
        : merges
          ? 'Merge commits cannot be squashed'
          : !ctx.headBranch
            ? 'Check out a branch first'
            : 'Select a contiguous range of commits on the current branch',
      onSelect: () => void squashCommits(repoId, shas),
    },
    {
      label: `Rebase ${n} commits onto…`,
      disabled: !(chain && endsAtHead && ctx.headBranch && !merges),
      title:
        chain && endsAtHead && ctx.headBranch
          ? `Move these commits of ${ctx.headBranch} onto another branch or commit`
          : 'Select a contiguous range ending at the tip of the checked-out branch',
      onSelect: () =>
        oldest && ctx.headBranch && void rebaseCommitsOnto(repoId, oldest.sha, ctx.headBranch, n),
    },
  ];
  if (aiEnabled()) {
    items.push(
      'separator',
      {
        label: `Recompose ${n} commits with AI`,
        disabled: !(chain && endsAtHead && !merges && ctx.headBranch),
        title: 'Split the combined changes into new commits (the newest selected commit must be HEAD)',
        onSelect: () =>
          oldest && newest && openCompose(repoId, { kind: 'range', from: oldest.sha, to: newest.sha }),
      },
      {
        label: `Explain ${n} commits`,
        onSelect: () => openExplain(repoId, { kind: 'commits', shas: [...shas].reverse() }),
      },
    );
  }
  items.push(
    'separator',
    { label: 'Create patch from commits…', onSelect: () => void saveCommitsPatch(repoId, shas) },
    { label: `Copy ${n} commit SHAs`, onSelect: copy([...shas].reverse().join('\n')) },
    { label: 'Copy short SHAs', onSelect: copy([...shas].reverse().map(shortSha).join(' ')) },
  );
  return items;
}
