import { describe, expect, it } from 'vitest';

import { buildHunks, createOpRegistry, parsePorcelainPush } from '../src/ops/executors';
import { lineKey as lineKeyForTest } from '../src/ops/executors/patch';
import type { FileDiff } from '../src/types';

const ALL = [
  'wip.stage',
  'wip.unstage',
  'wip.stageAll',
  'index.refresh',
  'wip.unstageAll',
  'wip.stageHunk',
  'wip.unstageHunk',
  'wip.discardHunk',
  'wip.stageLines',
  'wip.unstageLines',
  'wip.discardLines',
  'wip.discard',
  'wip.discardAll',
  'wip.ignore',
  'commit.create',
  'commit.rewordHead',
  'commit.saveTemplate',
  'config.set',
  'maintenance.commitGraph',
  'branch.create',
  'branch.rename',
  'branch.delete',
  'branch.setUpstream',
  'checkout.run',
  'tag.create',
  'tag.delete',
  'tag.push',
  'stash.push',
  'stash.apply',
  'stash.pop',
  'stash.drop',
  'fetch',
  'pull',
  'fastForwardBranch',
  'push',
  'push.tags',
  'push.delete',
  'remote.add',
  'remote.edit',
  'remote.remove',
  // Phase 3 (history rewriting, conflicts, editor)
  'merge.run',
  'merge.continue',
  'merge.abort',
  'rebase.run',
  'rebase.interactive',
  'rebase.continue',
  'rebase.skip',
  'rebase.abort',
  'cherryPick.run',
  'revert.run',
  'sequencer.continue',
  'sequencer.skip',
  'sequencer.abort',
  'reset.run',
  'ff.run',
  'conflict.saveFile',
  'conflict.take',
  'conflict.resolveSpecial',
  'conflict.markResolved',
  'conflict.markUnresolved',
  'conflict.mergetool',
  // Phase 8: stash-apply reset, git am (spec 08 §6.7)
  'conflict.resetMerge',
  'am.continue',
  'am.skip',
  'am.abort',
  'file.write',
  // Phase 7: diff viewer
  'diff.revertHunk',
  'file.checkoutAt',
  // Phase 4
  'pr.checkout',
  // Phase 5: AI
  'ai.compose',
  // Phase 5: Git Flow
  'gitflow.init',
  'gitflow.start',
  'gitflow.finish',
  'gitflow.continue',
  'gitflow.abort',
  'gitflow.reset',
  // Phase 6: Cloud Patches
  'patch.apply',
  // Phase 8: branching gaps (spec 05)
  'squash.run',
  'stash.rename',
  'stash.applyFile',
  'stash.branch',
  'reset.branch',
  'reflog.restore',
  'branch.renameRemote',
  // Phase 9: sparse checkout (spec 03)
  'sparse.set',
  'sparse.add',
  'sparse.disable',
  'sparse.reapply',
];
const UNDOABLE = [
  'commit.create',
  'commit.rewordHead',
  'checkout.run',
  'wip.discard',
  'wip.discardAll',
  'wip.discardHunk',
  'wip.discardLines',
  'diff.revertHunk',
  'file.checkoutAt',
  'branch.create',
  'branch.delete',
  'branch.rename',
  'tag.create',
  'tag.delete',
  'stash.push',
  'stash.pop',
  'stash.drop',
  'merge.run',
  'rebase.run',
  'rebase.interactive',
  'cherryPick.run',
  'revert.run',
  'reset.run',
  'ff.run',
  'ai.compose',
  'gitflow.start',
  'gitflow.finish',
  'gitflow.continue',
  'patch.apply',
  // Phase 8
  'squash.run',
  'stash.rename',
  'stash.applyFile',
  'stash.branch',
  'reset.branch',
  'reflog.restore',
  'remote.remove',
  'conflict.markResolved',
];
const NETWORK = [
  'fetch',
  'pull',
  'push',
  'push.tags',
  'push.delete',
  'remote.add',
  'fastForwardBranch',
  'tag.push',
  'tag.delete',
  'branch.delete',
  'pr.checkout',
  'gitflow.start',
  'gitflow.finish',
  'gitflow.continue',
  'branch.renameRemote',
  'sparse.set',
  'sparse.add',
  'sparse.disable',
  'sparse.reapply',
];

describe('createOpRegistry', () => {
  const reg = createOpRegistry() as Record<
    string,
    {
      meta: {
        undoable: boolean;
        network: boolean;
        cancellable: boolean;
        mutating: boolean;
        touches: string[];
        label: (op: never) => string;
      };
    }
  >;

  it('covers every operation except undo/redo', () => {
    expect(Object.keys(reg).sort()).toEqual([...ALL].sort());
    expect(reg['undo.run']).toBeUndefined();
    expect(reg['redo.run']).toBeUndefined();
  });

  it('declares undoable / network / cancellable metadata', () => {
    for (const t of ALL) {
      const m = reg[t]!.meta;
      expect(m.undoable, t).toBe(UNDOABLE.includes(t));
      expect(m.network, t).toBe(NETWORK.includes(t));
      if (m.network) expect(m.cancellable, t).toBe(true);
      expect(m.mutating).toBe(true);
      expect(m.touches.length, t).toBeGreaterThan(0);
    }
    expect(
      reg.push!.meta.label({
        type: 'push',
        localRef: 'main',
        remote: 'origin',
        remoteBranch: 'main',
      } as never),
    ).toBe('Push main to origin');
  });
});

describe('patch builder', () => {
  const file = (hunks: FileDiff['hunks']): FileDiff => ({
    oldPath: 'f',
    newPath: 'f',
    status: 'M',
    binary: false,
    hunks,
    additions: 0,
    deletions: 0,
  });
  const line = (type: 'context' | 'add' | 'del', content: string, i: number) => ({
    type,
    content,
    patchOffset: i,
  });

  it('offsets later hunks by the delta of emitted ones and handles pure insertions', () => {
    const f = file([
      {
        header: '@@ -1,2 +1,3 @@',
        oldStart: 1,
        oldLines: 2,
        newStart: 1,
        newLines: 3,
        lines: [line('context', 'a', 0), line('add', 'x', 1), line('context', 'b', 2)],
      },
      {
        header: '@@ -10,0 +12,1 @@',
        oldStart: 10,
        oldLines: 0,
        newStart: 12,
        newLines: 1,
        lines: [line('add', 'y', 0)],
      },
    ]);
    const all = new Set([lineKeyForTest(0, 1), lineKeyForTest(1, 0)]);
    expect(buildHunks(f, all, 'stage')).toBe('@@ -1,2 +1,3 @@\n a\n+x\n b\n@@ -10,0 +12 @@\n+y\n');
    expect(buildHunks(f, new Set([lineKeyForTest(1, 0)]), 'stage')).toBe('@@ -10,0 +11 @@\n+y\n');
    expect(buildHunks(f, new Set([lineKeyForTest(1, 0)]), 'unstage')).toBe('@@ -11,0 +12 @@\n+y\n');
    expect(buildHunks(f, new Set([lineKeyForTest(0, 1)]), 'unstage')).toBe('@@ -1,2 +1,3 @@\n a\n+x\n b\n');
  });

  it('parses push --porcelain output', () => {
    expect(
      parsePorcelainPush(
        'To ../x.git\n!\trefs/heads/main:refs/heads/main\t[rejected] (non-fast-forward)\n-\t:refs/heads/x\t[deleted]\nDone\n',
      ),
    ).toEqual([
      { flag: '!', from: 'refs/heads/main', to: 'refs/heads/main', summary: '[rejected] (non-fast-forward)' },
      { flag: '-', from: '', to: 'refs/heads/x', summary: '[deleted]' },
    ]);
  });
});
