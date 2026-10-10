import { describe, expect, it } from 'vitest';

import { createExtrasRegistry } from '../src/ops/executors/extras';

const NETWORK = [
  'submodule.add',
  'submodule.update',
  'lfs.pull',
  'lfs.fetch',
  'lfs.push',
  'lfs.lock',
  'lfs.unlock',
];
const ALL = [
  'submodule.add',
  'submodule.update',
  'submodule.remove',
  'submodule.setUrl',
  'worktree.add',
  'worktree.remove',
  'worktree.lock',
  'worktree.unlock',
  'worktree.prune',
  'lfs.install',
  'lfs.track',
  'lfs.untrack',
  'lfs.pull',
  'lfs.fetch',
  'lfs.push',
  'lfs.prune',
  'lfs.convert',
  'lfs.lock',
  'lfs.unlock',
];

describe('createExtrasRegistry', () => {
  it('defines all 19 variants with the expected meta', () => {
    const reg = createExtrasRegistry() as Record<string, { meta: Record<string, unknown> } | undefined>;
    expect(Object.keys(reg).sort()).toEqual([...ALL].sort());
    for (const type of ALL) {
      const m = reg[type]!.meta;
      expect(m.mutating, type).toBe(true);
      expect(m.undoable, type).toBe(false);
      expect(m.network, type).toBe(NETWORK.includes(type));
      expect(m.cancellable, type).toBe(NETWORK.includes(type));
      expect(m.exclusive, type).toBe('repo');
    }
    const label = (reg['worktree.add']!.meta.label as (op: unknown) => string)({
      type: 'worktree.add',
      path: '/x/wt-a',
    });
    expect(label).toBe('Create worktree wt-a');
  });
});
