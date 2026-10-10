import fs from 'node:fs';
import path from 'node:path';

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { checkoutPreflight, validateBranchName, type CheckoutOutcome } from '../src/ops/executors';
import type { GitService } from '../src/service/git-service';
import { describeGit, useHarness } from './ops-harness';

describeGit('branch / checkout / tag / stash executors', () => {
  const h = useHarness('branch');

  describe('branches and tags (branchy)', () => {
    let dir: string;
    let svc: GitService;
    const refExists = (ref: string) => {
      try {
        h.git(dir, 'rev-parse', '-q', '--verify', ref);
        return true;
      } catch {
        return false;
      }
    };
    beforeAll(async () => {
      dir = h.fixture('branchy').path;
      svc = await h.open(dir);
    });

    it('validates branch names with check-ref-format', async () => {
      expect(await validateBranchName(svc, 'feature/ok-1')).toEqual({ valid: true });
      for (const bad of ['bad..name', '-x', 'a b', 'end.lock', '', 'x~1']) {
        const r = await validateBranchName(svc, bad);
        expect(r.valid, bad).toBe(false);
        expect(r.reason).toBeTruthy();
      }
    });

    it('creates, renames and deletes branches', async () => {
      await h.run(svc, { type: 'branch.create', name: 'side', startPoint: 'feature-a', checkout: false });
      expect(h.git(dir, 'rev-parse', 'side').trim()).toBe(h.git(dir, 'rev-parse', 'feature-a').trim());
      expect(h.git(dir, 'symbolic-ref', '--short', 'HEAD').trim()).toBe('main');

      await h.run(svc, { type: 'branch.create', name: 'topic/new', startPoint: 'HEAD', checkout: true });
      expect(svc.repo.head).toMatchObject({ kind: 'branch', name: 'topic/new' });
      expect(
        (await h.fail(svc, { type: 'branch.create', name: 'side', startPoint: 'HEAD', checkout: false }))
          .code,
      ).toBe('BranchAlreadyExists');

      await h.run(svc, { type: 'branch.rename', from: 'topic/new', to: 'topic/renamed' });
      expect(svc.repo.head).toMatchObject({ kind: 'branch', name: 'topic/renamed' });
      h.git(dir, 'switch', '-q', 'main');

      const unmerged = await h.fail(svc, {
        type: 'branch.delete',
        branches: [{ name: 'feature-b' }],
        force: false,
      });
      expect(unmerged.code).toBe('BranchNotFullyMerged');
      expect(refExists('refs/heads/feature-b')).toBe(true);
      await h.run(svc, {
        type: 'branch.delete',
        branches: [{ name: 'feature-b' }, { name: 'side' }],
        force: true,
      });
      expect(refExists('refs/heads/feature-b')).toBe(false);
      expect(refExists('refs/heads/side')).toBe(false);
      await h.run(svc, { type: 'branch.delete', branches: [{ name: 'feature-a' }], force: false });
      expect(refExists('refs/heads/feature-a')).toBe(false);
    });

    it('creates lightweight and annotated tags and deletes them', async () => {
      const head = h.git(dir, 'rev-parse', 'HEAD').trim();
      await h.run(svc, { type: 'tag.create', name: 'light', target: head });
      expect(h.git(dir, 'cat-file', '-t', 'refs/tags/light').trim()).toBe('commit');
      await h.run(svc, {
        type: 'tag.create',
        name: 'v2.0',
        target: head,
        annotated: { message: 'Release 2.0\n\nNotes' },
      });
      expect(h.git(dir, 'cat-file', '-t', 'refs/tags/v2.0').trim()).toBe('tag');
      expect(h.git(dir, 'tag', '-l', '--format=%(contents)', 'v2.0')).toContain('Release 2.0\n\nNotes');
      expect((await h.fail(svc, { type: 'tag.create', name: 'light', target: head })).code).toBe(
        'TagAlreadyExists',
      );
      await h.run(svc, { type: 'tag.delete', name: 'light', local: true, remotes: [] });
      await h.run(svc, { type: 'tag.delete', name: 'v2.0', local: true, remotes: [] });
      expect(refExists('refs/tags/light')).toBe(false);
      expect(refExists('refs/tags/v2.0')).toBe(false);
    });

    it('pushes, applies, pops and drops stashes (incl. conflict on pop)', async () => {
      const app = path.join(dir, 'app.txt');
      const original = h.read(app);
      const stashes = () => svc.stashList();
      const initial = (await stashes()).length;

      h.write(app, original.replace('line 5', 'line 5 (mine)'));
      h.write(path.join(dir, 'untracked-x.txt'), 'x\n');
      const pushed = await h.run(svc, { type: 'stash.push', message: 'my work', includeUntracked: true });
      const sha = (pushed.data as { sha: string }).sha;
      let list = await stashes();
      expect(list).toHaveLength(initial + 1);
      expect(list[0]).toMatchObject({ sha, index: 0 });
      expect(h.read(app)).toBe(original);
      expect(fs.existsSync(path.join(dir, 'untracked-x.txt'))).toBe(false);

      await h.run(svc, { type: 'stash.apply', index: 0, sha });
      expect(h.read(app)).toContain('line 5 (mine)');
      expect((await stashes()).length).toBe(initial + 1);
      h.git(dir, 'reset', '-q', '--hard');
      h.git(dir, 'clean', '-fdq');

      // conflict: HEAD changes the same line, then pop
      h.write(app, original.replace('line 5', 'line 5 (theirs)'));
      h.git(dir, 'commit', '-qam', 'theirs');
      const err = await h.fail(svc, { type: 'stash.pop', index: 0, sha });
      expect(err.code).toBe('StashConflict');
      expect(err.details?.files).toEqual(['app.txt']);
      list = await stashes();
      expect(list[0]?.sha).toBe(sha); // git keeps the stash on conflict
      h.git(dir, 'reset', '-q', '--hard');
      h.git(dir, 'clean', '-fdq');

      // index drift: drop the older stash by sha even though the index is stale
      const older = list[1]!;
      await h.run(svc, { type: 'stash.drop', index: 0, sha: older.sha });
      list = await stashes();
      expect(list.map((s) => s.sha)).toEqual([sha]);
      await h.run(svc, { type: 'stash.pop', index: 0, sha: list[0]!.sha }).catch(() => undefined);
      h.git(dir, 'reset', '-q', '--hard');
      expect((await h.fail(svc, { type: 'stash.drop', index: 0, sha: 'f'.repeat(40) })).message).toMatch(
        /no longer exists/,
      );
    });
  });

  describe('checkout (conflict fixture)', () => {
    let dir: string;
    let svc: GitService;
    const content = () => h.read(path.join(dir, 'content.txt'));
    const branch = () => h.git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
    beforeAll(async () => {
      dir = h.fixture('conflict').path;
      svc = await h.open(dir);
    });
    beforeEach(() => {
      h.git(dir, 'switch', '-q', '-f', 'main');
      h.git(dir, 'reset', '-q', '--hard');
      h.git(dir, 'clean', '-fdq');
    });

    it('preflights blocking paths (tracked + untracked)', async () => {
      expect(await checkoutPreflight(svc, { kind: 'branch', name: 'feature' })).toEqual({
        dirty: false,
        blockingPaths: [],
      });
      h.write(path.join(dir, 'content.txt'), 'mine\n');
      h.write(path.join(dir, 'delete-modify.txt'), 'untracked in the way\n');
      h.write(path.join(dir, 'harmless.txt'), 'h\n');
      const pre = await checkoutPreflight(svc, { kind: 'branch', name: 'feature' });
      expect(pre).toEqual({ dirty: true, blockingPaths: ['content.txt', 'delete-modify.txt'] });
    });

    it('carries non-conflicting changes, refuses conflicting ones', async () => {
      h.write(path.join(dir, 'harmless.txt'), 'h\n');
      await h.run(svc, {
        type: 'checkout.run',
        target: { kind: 'branch', name: 'feature' },
        dirtyStrategy: 'carry',
      });
      expect(branch()).toBe('feature');
      expect(fs.existsSync(path.join(dir, 'harmless.txt'))).toBe(true);
      h.git(dir, 'switch', '-q', 'main');

      h.write(path.join(dir, 'content.txt'), 'mine\n');
      const err = await h.fail(svc, {
        type: 'checkout.run',
        target: { kind: 'branch', name: 'feature' },
        dirtyStrategy: 'carry',
      });
      expect(err.code).toBe('LocalChangesWouldBeOverwritten');
      expect(err.details?.files).toEqual(['content.txt']);
      expect(branch()).toBe('main');
    });

    it('stashes, then checks out (autostash kept for the UI to pop)', async () => {
      h.write(path.join(dir, 'content.txt'), 'mine\n');
      h.write(path.join(dir, 'delete-modify.txt'), 'untracked in the way\n');
      const r = await h.run(svc, {
        type: 'checkout.run',
        target: { kind: 'branch', name: 'feature' },
        dirtyStrategy: 'stash',
      });
      const data = r.data as CheckoutOutcome;
      expect(data.branch).toBe('feature');
      expect(data.stashSha).toBe(h.git(dir, 'rev-parse', 'refs/stash').trim());
      expect(h.git(dir, 'stash', 'list', '-1', '--format=%gs')).toContain(
        'autostash: before checkout feature',
      );
      expect(content()).toContain('changed on feature');
      h.git(dir, 'stash', 'drop', '-q');
    });

    it('discards local changes and blocking untracked files', async () => {
      h.write(path.join(dir, 'content.txt'), 'mine\n');
      h.write(path.join(dir, 'delete-modify.txt'), 'untracked in the way\n');
      await h.run(svc, {
        type: 'checkout.run',
        target: { kind: 'branch', name: 'feature' },
        dirtyStrategy: 'discard',
      });
      expect(branch()).toBe('feature');
      expect(content()).toContain('changed on feature');
      expect(h.read(path.join(dir, 'delete-modify.txt'))).toBe('modified on feature\n');
      expect(h.git(dir, 'status', '--porcelain')).toBe('');
    });

    it('checks out a commit and a tag detached', async () => {
      const base = h.git(dir, 'rev-parse', 'main~1').trim();
      let r = await h.run(svc, {
        type: 'checkout.run',
        target: { kind: 'commit', sha: base },
        dirtyStrategy: 'carry',
      });
      expect(r.data).toMatchObject({ branch: null, sha: base });
      h.git(dir, 'tag', '-a', 'ftag', '-m', 'feature tag', 'feature');
      r = await h.run(svc, {
        type: 'checkout.run',
        target: { kind: 'tag', name: 'ftag' },
        dirtyStrategy: 'carry',
      });
      expect(r.data).toMatchObject({ branch: null, sha: h.git(dir, 'rev-parse', 'feature').trim() });
      expect(svc.repo.head.kind).toBe('detached');
    });
  });
});
