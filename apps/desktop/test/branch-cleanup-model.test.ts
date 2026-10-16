import type { BranchCleanupCandidate, BranchCleanupReason } from '@githappens/git/types';
import { describe, expect, it } from 'vitest';

import {
  cleanupOp,
  defaultSelection,
  groupCandidates,
  unmergedSelected,
} from '../src/renderer/src/views/remotes/branch-cleanup-model';

const c = (name: string, reason: BranchCleanupReason): BranchCleanupCandidate => ({
  name,
  sha: `sha-${name}`,
  reason,
  upstreamGone: reason === 'upstream-gone',
  aheadOfBase: reason === 'merged' ? 0 : 1,
  committerDate: 0,
  authorName: 'a',
  subject: 's',
});

describe('branch cleanup model', () => {
  const all = [
    c('ff', 'merged'),
    c('sq', 'squash-merged'),
    c('rb', 'rebase-merged'),
    c('closed', 'upstream-gone'),
  ];

  it('groups merged kinds together and preselects only them', () => {
    const groups = groupCandidates(all, 'origin/main');
    expect(groups.map((g) => [g.id, g.items.map((i) => i.name), g.preselected])).toEqual([
      ['merged', ['ff', 'sq', 'rb'], true],
      ['gone', ['closed'], false],
    ]);
    expect([...defaultSelection(groups)]).toEqual(['ff', 'sq', 'rb']);
  });

  it('drops empty groups', () => {
    expect(groupCandidates([c('closed', 'upstream-gone')], 'main').map((g) => g.id)).toEqual(['gone']);
    expect(groupCandidates([], 'main')).toEqual([]);
  });

  it('flags selected unmerged branches and builds a guarded local-only delete', () => {
    const sel = new Set(['ff', 'closed']);
    expect(unmergedSelected(all, sel).map((x) => x.name)).toEqual(['closed']);
    expect(cleanupOp(all, sel)).toEqual({
      type: 'branch.delete',
      branches: [
        { name: 'ff', expectedSha: 'sha-ff' },
        { name: 'closed', expectedSha: 'sha-closed' },
      ],
      force: true,
    });
  });
});
