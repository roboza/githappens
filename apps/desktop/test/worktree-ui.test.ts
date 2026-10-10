import fs from 'node:fs';
import path from 'node:path';

import {
  createExtrasRegistry,
  createOpRegistry,
  listWorktrees,
  OperationQueue,
  type GitOperation,
} from '@githappens/git';
import { describe, expect, it } from 'vitest';

import { createRemotesHandlers } from '../src/main/ipc/remotes-handlers';
import { countPorcelainV2 } from '../src/main/remotes/remote-reads';
import { REMOTES_INVOKE_CHANNELS } from '../src/shared/ipc/remotes-contract';
import {
  branchSlug,
  buildWorktreeAddOp,
  defaultWorktreePath,
  pathLabel,
  removePlan,
  worktreeLabel,
  worktreeMatchText,
  worktreeSubtitle,
  type WorktreeForm,
} from '../src/renderer/src/views/worktrees/worktree-model';
import { gitPath, useTestRepos } from './ai-test-repo';

const form = (p: Partial<WorktreeForm>): WorktreeForm => ({
  mode: 'new',
  branch: '',
  newBranch: '',
  startPoint: '',
  path: '/w/repo.worktrees/x',
  open: 'new',
  ...p,
});

describe('worktree dialog model', () => {
  it('derives the default folder <parent>/<repo>.worktrees/<slug>', () => {
    expect(branchSlug('feature/login page')).toBe('feature-login-page');
    expect(branchSlug('///')).toBe('worktree');
    expect(defaultWorktreePath('/home/u/proj', 'feature/x')).toBe('/home/u/proj.worktrees/feature-x');
    expect(defaultWorktreePath('C:\\src\\proj\\', 'main')).toBe('C:\\src\\proj.worktrees\\main');
    expect(defaultWorktreePath(null, 'x')).toBe('');
    expect(pathLabel(form({ mode: 'detached', startPoint: 'refs/tags/v1' }))).toBe('detached-v1');
  });

  it('builds worktree.add for the three modes and validates', () => {
    const branches = ['main', 'dev', 'used'];
    const out = ['main', 'used'];
    expect(buildWorktreeAddOp(form({ newBranch: 'feat', startPoint: 'dev' }), branches, out)).toEqual({
      op: { type: 'worktree.add', path: '/w/repo.worktrees/x', newBranch: 'feat', startPoint: 'dev' },
    });
    expect(buildWorktreeAddOp(form({ newBranch: 'feat' }), branches, out)).toEqual({
      op: { type: 'worktree.add', path: '/w/repo.worktrees/x', newBranch: 'feat' },
    });
    expect(buildWorktreeAddOp(form({ mode: 'existing', branch: 'dev' }), branches, out)).toEqual({
      op: { type: 'worktree.add', path: '/w/repo.worktrees/x', branch: 'dev' },
    });
    expect(buildWorktreeAddOp(form({ mode: 'detached' }), branches, out)).toEqual({
      op: { type: 'worktree.add', path: '/w/repo.worktrees/x', detach: true, startPoint: 'HEAD' },
    });
    expect(buildWorktreeAddOp(form({ newBranch: 'dev' }), branches, out)).toHaveProperty('error');
    expect(buildWorktreeAddOp(form({ newBranch: '' }), branches, out)).toHaveProperty('error');
    expect(buildWorktreeAddOp(form({ mode: 'existing', branch: 'used' }), branches, out)).toEqual({
      error: expect.stringMatching(/already checked out/),
    });
    expect(buildWorktreeAddOp(form({ mode: 'existing', branch: 'nope' }), branches, out)).toHaveProperty(
      'error',
    );
    expect(buildWorktreeAddOp(form({ path: ' ' }), branches, out)).toHaveProperty('error');
  });

  it('labels rows and plans removal', () => {
    const w = {
      path: '/w/proj.worktrees/feature-x',
      branch: 'refs/heads/feature/x',
      head: 'c'.repeat(40),
      detached: false,
    };
    expect(worktreeLabel(w)).toBe('feature/x');
    expect(worktreeSubtitle(w)).toBeNull(); // folder is the branch slug
    expect(worktreeSubtitle({ ...w, path: '/w/elsewhere' })).toBe('elsewhere');
    expect(worktreeLabel({ ...w, branch: undefined, detached: true })).toBe('detached @ ccccccc');
    expect(worktreeMatchText(w)).toContain('feature-x');
    expect(removePlan({ ...w, locked: undefined }, { changed: 0 }, false)).toEqual({
      op: { type: 'worktree.remove', path: w.path },
      needsForce: false,
      branch: null,
    });
    expect(removePlan({ ...w, locked: true }, { changed: 0 }, true)).toMatchObject({
      op: { force: true },
      needsForce: true,
      branch: 'feature/x',
    });
    expect(removePlan(w, { changed: 3 }, false).op.force).toBe(true);
  });

  it('counts porcelain v2 entries (renames carry an extra path)', () => {
    const out = [
      '# branch.oid x',
      '1 .M N... 100644 100644 100644 a b f1',
      '2 R. N... 100644 100644 100644 a b R100 new',
      'old',
      '? u1',
      'u UU N... 1 1 1 1 a b c conflicted',
      '',
    ].join('\0');
    expect(countPorcelainV2(out)).toBe(4);
    expect(countPorcelainV2('')).toBe(0);
  });
});

const d = gitPath ? describe : describe.skip;

d('worktrees end to end (real git)', () => {
  const repos = useTestRepos('worktree-ui');
  const registry = { ...createOpRegistry(), ...createExtrasRegistry() };

  it('creates new-branch / existing / detached worktrees, reports dirty status, removes and prunes', async () => {
    const r = await repos.make();
    r.git('branch', 'dev');
    const run = (op: GitOperation) => new OperationQueue(r.svc, registry).enqueue(op).done;
    const handlers = createRemotesHandlers({ get: () => r.svc });
    const ctx = { senderId: 1 };
    expect(Object.keys(handlers).sort()).toEqual([...REMOTES_INVOKE_CHANNELS].sort());
    const root = path.dirname(r.dir);
    const p = (name: string): string => path.join(root, `${path.basename(r.dir)}.worktrees`, name);

    await run({ type: 'worktree.add', path: p('feat'), newBranch: 'feat', startPoint: 'main' });
    await run({ type: 'worktree.add', path: p('dev'), branch: 'dev' });
    await run({ type: 'worktree.add', path: p('detached'), detach: true, startPoint: 'HEAD' });
    let list = await listWorktrees(r.svc);
    expect(list[0]).toMatchObject({ isMain: true, branch: 'refs/heads/main' });
    expect(
      list
        .slice(1)
        .map((w) => [path.basename(w.path), w.branch ?? (w.detached ? 'detached' : '?')])
        .sort((x, y) => x[0]!.localeCompare(y[0]!)),
    ).toEqual([
      ['detached', 'detached'],
      ['dev', 'refs/heads/dev'],
      ['feat', 'refs/heads/feat'],
    ]);

    // dirty-files check before removing
    fs.writeFileSync(path.join(p('feat'), 'new.txt'), 'x\n');
    fs.writeFileSync(path.join(p('feat'), 'README.md'), 'changed\n');
    const st = await handlers['git:worktree:status']({ repoId: 'r', path: p('feat') }, ctx);
    expect(st).toMatchObject({ changed: 2, branch: 'feat', locked: false });
    await expect(
      handlers['git:worktree:status']({ repoId: 'r', path: path.join(root, 'nope') }, ctx),
    ).rejects.toThrow();

    // remove a dirty worktree needs force; then delete its branch
    await expect(run({ type: 'worktree.remove', path: p('feat') })).rejects.toThrow();
    await run({ type: 'worktree.remove', path: p('feat'), force: true });
    await run({ type: 'branch.delete', branches: [{ name: 'feat' }], force: true });
    expect(r.git('branch', '--list', 'feat').trim()).toBe('');

    // locked + clean: force (twice) removes it
    await run({ type: 'worktree.lock', path: p('dev'), reason: 'busy' });
    expect((await handlers['git:worktree:status']({ repoId: 'r', path: p('dev') }, ctx)).locked).toBe(true);
    await run({ type: 'worktree.remove', path: p('dev'), force: true });

    // a deleted folder is pruned
    fs.rmSync(p('detached'), { recursive: true, force: true });
    const pruned = await run({ type: 'worktree.prune' });
    expect((pruned.data as { pruned: string[] }).pruned.length).toBe(1);
    list = await listWorktrees(r.svc);
    expect(list).toHaveLength(1);
  });

  it('git:submodule:parent is null outside a submodule', async () => {
    const r = await repos.make();
    const handlers = createRemotesHandlers({ get: () => r.svc });
    expect(await handlers['git:submodule:parent']({ repoId: 'r' }, { senderId: 1 })).toBeNull();
  });
});
