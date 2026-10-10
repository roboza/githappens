import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { checkoutPreflight } from '../src/ops/executors';
import type { PullOutcome, PushOutcome } from '../src/ops/types';
import { describeGit, useHarness } from './ops-harness';

describeGit('sync / remote executors (remote-pair)', () => {
  const h = useHarness('sync');

  /** local (1 ahead, 1 behind origin/main), other (another clone) and the bare remote. */
  const pair = async () => {
    const f = h.fixture('remote-pair');
    const svc = await h.open(f.path);
    return { local: f.path, other: f.facts.other as string, remote: f.facts.remote as string, svc };
  };
  const rev = (cwd: string, r: string) => h.git(cwd, 'rev-parse', r).trim();
  const exists = (cwd: string, r: string) => {
    try {
      h.git(cwd, 'rev-parse', '-q', '--verify', r);
      return true;
    } catch {
      return false;
    }
  };

  describe('pull', () => {
    let p: Awaited<ReturnType<typeof pair>>;
    let start: string;
    beforeAll(async () => {
      p = await pair();
      start = rev(p.local, 'HEAD');
    });
    beforeEach(() => {
      h.git(p.local, 'switch', '-q', '-f', 'main');
      h.git(p.local, 'reset', '-q', '--hard', start);
    });

    it('ff-only refuses diverged branches', async () => {
      const err = await h.fail(p.svc, { type: 'pull', strategy: 'ff-only' });
      expect(err.code).toBe('NotFastForwardable');
      expect(rev(p.local, 'HEAD')).toBe(start);
    });

    it('ff-if-possible merges diverged branches and passes credentials env', async () => {
      const credentialEnv = vi.fn(() => ({ GITHAPPENS_TEST_CRED: '1' }));
      const r = await h.run(p.svc, { type: 'pull', strategy: 'ff-if-possible' }, { credentialEnv });
      expect((r.data as PullOutcome).result).toBe('merge');
      expect(h.git(p.local, 'log', '-1', '--format=%P%n%s')).toMatch(
        /^\S+ \S+\nMerge remote-tracking branch 'origin\/main'/,
      );
      expect(credentialEnv).toHaveBeenCalledWith(r.opId, false);
    });

    it('rebase strategy replays local commits', async () => {
      const r = await h.run(p.svc, { type: 'pull', strategy: 'rebase' });
      expect((r.data as PullOutcome).result).toBe('rebase');
      expect(rev(p.local, 'HEAD~1')).toBe(rev(p.local, 'origin/main'));
      expect(h.git(p.local, 'log', '-1', '--format=%s').trim()).toBe('Local only');
    });

    it('fast-forwards, then reports up to date', async () => {
      h.git(p.local, 'reset', '-q', '--hard', 'origin/main~1');
      let r = await h.run(p.svc, { type: 'pull', strategy: 'ff-only' });
      expect((r.data as PullOutcome).result).toBe('fast-forward');
      expect(rev(p.local, 'HEAD')).toBe(rev(p.local, 'origin/main'));
      r = await h.run(p.svc, { type: 'pull', strategy: 'ff-if-possible' });
      expect((r.data as PullOutcome).result).toBe('up-to-date');
    });

    it('needs a branch with an upstream', async () => {
      h.git(p.local, 'switch', '-q', '-c', 'no-upstream');
      const err = await h.fail(p.svc, { type: 'pull', strategy: 'ff-only' });
      expect(err.code).toBe('NoUpstream');
      expect(err.details?.branch).toBe('no-upstream');
      h.git(p.local, 'switch', '-q', '--detach', 'HEAD');
      expect((await h.fail(p.svc, { type: 'pull', strategy: 'ff-only' })).code).toBe('DetachedHead');
      h.git(p.local, 'switch', '-q', 'main');
      h.git(p.local, 'branch', '-D', 'no-upstream');
    });

    it('surfaces merge conflicts with the conflicted files', async () => {
      h.write(path.join(p.other, 'a.txt'), 'theirs\n');
      h.git(p.other, 'commit', '-qam', 'theirs');
      h.git(p.other, 'push', '-q', 'origin', 'main');
      h.write(path.join(p.local, 'a.txt'), 'mine\n');
      h.git(p.local, 'commit', '-qam', 'mine');
      const err = await h.fail(p.svc, { type: 'pull', strategy: 'ff-if-possible' });
      expect(err.code).toBe('MergeConflict');
      expect(err.details?.files).toEqual(['a.txt']);
      expect(p.svc.repo.state).toBe('merging');
      h.git(p.local, 'merge', '--abort');
    });
  });

  describe('push', () => {
    let p: Awaited<ReturnType<typeof pair>>;
    beforeAll(async () => {
      p = await pair();
    });

    it('rejects non-fast-forward pushes, honours force-with-lease', async () => {
      const push = { type: 'push', localRef: 'main', remote: 'origin', remoteBranch: 'main' } as const;
      const nonFf = await h.fail(p.svc, push);
      expect(nonFf.code).toBe('PushRejectedNonFastForward');
      expect(nonFf.details?.ref).toBe('refs/heads/main');

      const stale = await h.fail(p.svc, { ...push, force: 'lease', expectedRemoteSha: rev(p.local, 'HEAD') });
      expect(stale.code).toBe('PushRejectedStaleLease');

      const r = await h.run(p.svc, {
        ...push,
        force: 'lease',
        expectedRemoteSha: rev(p.local, 'origin/main'),
      });
      const refs = (r.data as PushOutcome).refs;
      expect(refs).toHaveLength(1);
      expect(refs[0]).toMatchObject({ flag: '+', from: 'refs/heads/main', to: 'refs/heads/main' });
      expect(h.git(p.remote, 'rev-parse', 'main').trim()).toBe(rev(p.local, 'HEAD'));
    });

    it('new branch: NoUpstream without a target, then push with setUpstream', async () => {
      h.git(p.local, 'branch', 'feat');
      const err = await h.fail(p.svc, { type: 'push', localRef: 'feat', remote: '', remoteBranch: '' });
      expect(err.code).toBe('NoUpstream');
      expect(err.details?.branch).toBe('feat');

      const progress = vi.fn();
      const r = await h.run(
        p.svc,
        { type: 'push', localRef: 'feat', remote: 'origin', remoteBranch: 'feat', setUpstream: true },
        { onProgress: progress },
      );
      expect((r.data as PushOutcome).refs[0]).toMatchObject({ flag: '*', to: 'refs/heads/feat' });
      expect(h.git(p.local, 'config', 'branch.feat.remote').trim()).toBe('origin');
      const again = await h.run(p.svc, { type: 'push', localRef: 'feat', remote: '', remoteBranch: '' });
      expect((again.data as PushOutcome).refs[0]?.flag).toBe('=');
    });

    it('pushes and deletes tags and remote branches', async () => {
      h.git(p.local, 'tag', 'v1');
      h.git(p.local, 'tag', 'v2');
      await h.run(p.svc, { type: 'tag.push', name: 'v1', remote: 'origin' });
      expect(exists(p.remote, 'refs/tags/v1')).toBe(true);
      await h.run(p.svc, { type: 'push.tags', remote: 'origin', tags: 'all' });
      expect(exists(p.remote, 'refs/tags/v2')).toBe(true);
      await h.run(p.svc, { type: 'tag.delete', name: 'v1', local: true, remotes: ['origin'] });
      expect(exists(p.remote, 'refs/tags/v1')).toBe(false);
      expect(exists(p.local, 'refs/tags/v1')).toBe(false);

      h.git(p.local, 'push', '-q', 'origin', 'HEAD:refs/heads/tmp1', 'HEAD:refs/heads/tmp2');
      await h.run(p.svc, { type: 'push.delete', remote: 'origin', refs: ['tmp1', 'refs/tags/v2'] });
      expect(exists(p.remote, 'refs/heads/tmp1')).toBe(false);
      expect(exists(p.remote, 'refs/tags/v2')).toBe(false);

      h.git(p.local, 'branch', 'tmp2', 'HEAD');
      await h.run(p.svc, {
        type: 'branch.delete',
        branches: [{ name: 'tmp2', deleteRemote: { remote: 'origin', remoteBranch: 'tmp2' } }],
        force: true,
      });
      expect(exists(p.remote, 'refs/heads/tmp2')).toBe(false);
      expect(exists(p.local, 'refs/heads/tmp2')).toBe(false);
    });
  });

  describe('fetch, tracking and remotes', () => {
    let p: Awaited<ReturnType<typeof pair>>;
    beforeAll(async () => {
      p = await pair();
    });

    it('fetches new branches and prunes deleted ones', async () => {
      h.git(p.other, 'push', '-q', 'origin', 'HEAD:refs/heads/topic');
      await h.run(p.svc, { type: 'fetch', remote: 'origin' });
      expect(exists(p.local, 'refs/remotes/origin/topic')).toBe(true);
      h.git(p.other, 'push', '-q', 'origin', '--delete', 'topic');
      await h.run(p.svc, { type: 'fetch', remote: 'origin' });
      expect(exists(p.local, 'refs/remotes/origin/topic')).toBe(true);
      await h.run(p.svc, { type: 'fetch', remote: 'all', prune: true });
      expect(exists(p.local, 'refs/remotes/origin/topic')).toBe(false);
    });

    it('checks out a remote branch as a new tracking branch', async () => {
      h.git(p.other, 'push', '-q', 'origin', 'HEAD:refs/heads/remote-feature');
      await h.run(p.svc, { type: 'fetch', remote: 'origin' });
      const pre = await checkoutPreflight(p.svc, { kind: 'remoteBranch', remote: 'origin', name: 'main' });
      expect(pre.localExists).toEqual({ name: 'main', upstream: 'origin/main', relation: 'diverged' });
      await h.run(p.svc, {
        type: 'checkout.run',
        target: { kind: 'remoteBranch', remote: 'origin', name: 'remote-feature' },
        dirtyStrategy: 'carry',
      });
      expect(p.svc.repo.head).toMatchObject({ kind: 'branch', name: 'remote-feature' });
      expect(h.git(p.local, 'rev-parse', '--abbrev-ref', '@{upstream}').trim()).toBe('origin/remote-feature');
      h.git(p.local, 'switch', '-q', 'main');
    });

    it('fast-forwards a non-checked-out branch and sets / unsets upstreams', async () => {
      h.git(p.local, 'branch', '--no-track', 'lagging', 'origin/main~1');
      await h.run(p.svc, { type: 'fastForwardBranch', localBranch: 'lagging', upstream: 'origin/main' });
      expect(rev(p.local, 'lagging')).toBe(rev(p.local, 'origin/main'));

      await h.run(p.svc, { type: 'branch.setUpstream', localBranch: 'lagging', upstream: 'origin/main' });
      expect(h.git(p.local, 'rev-parse', '--abbrev-ref', 'lagging@{upstream}').trim()).toBe('origin/main');
      await h.run(p.svc, { type: 'branch.setUpstream', localBranch: 'lagging', upstream: null });
      expect(exists(p.local, 'lagging@{upstream}')).toBe(false);
      await h.run(p.svc, {
        type: 'branch.setUpstream',
        localBranch: 'lagging',
        upstream: 'origin/not-pushed-yet',
      });
      expect(h.git(p.local, 'config', 'branch.lagging.merge').trim()).toBe('refs/heads/not-pushed-yet');

      // local main is diverged from origin/main: not fast-forwardable
      expect(
        (await h.fail(p.svc, { type: 'fastForwardBranch', localBranch: 'main', upstream: 'origin/main' }))
          .code,
      ).toBe('NotFastForwardable');
    });

    it('adds (with fetch), edits and removes remotes', async () => {
      const url = pathToFileURL(p.remote).href;
      await h.run(p.svc, { type: 'remote.add', name: 'mirror', fetchUrl: url, pushUrl: `${url}#push` });
      expect(exists(p.local, 'refs/remotes/mirror/main')).toBe(true);
      expect(h.git(p.local, 'remote', 'get-url', '--push', 'mirror').trim()).toBe(`${url}#push`);
      expect(
        (await h.fail(p.svc, { type: 'remote.add', name: 'mirror', fetchUrl: url, fetchAfter: false })).code,
      ).toBe('RemoteAlreadyExists');

      await h.run(p.svc, { type: 'remote.edit', name: 'mirror', newName: 'backup', pushUrl: null });
      expect(h.git(p.local, 'remote').split(/\r?\n/)).toContain('backup');
      expect(h.git(p.local, 'remote', 'get-url', '--push', 'backup').trim()).toBe(url);
      expect(exists(p.local, 'refs/remotes/backup/main')).toBe(true);

      await h.run(p.svc, { type: 'remote.remove', name: 'backup' });
      expect(h.git(p.local, 'remote').split(/\r?\n/)).not.toContain('backup');
      expect((await h.fail(p.svc, { type: 'remote.remove', name: 'backup' })).code).toBe('RemoteNotFound');
    });
  });
});
