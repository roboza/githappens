import { expect, it } from 'vitest';

import { GitService } from '../src/service/git-service';
import type { RefInfo } from '../src/types';
import { describeGit, useHarness } from './ops-harness';

/**
 * Phase 11 (spec 02 §6.15.5): with many tracking branches the background ahead/behind pass is chunked,
 * prioritized (hinted branches, then most recently committed), notifies as chunks land, restarts cleanly
 * when refs move and stops on dispose.
 */

describeGit('progressive ahead/behind for many tracking branches', () => {
  const h = useHarness('track');

  const truthOf = (dir: string): Map<string, { ahead: number; behind: number; gone: boolean }> =>
    new Map(
      h
        .git(dir, 'for-each-ref', '--format=%(refname)|%(upstream:track,nobracket)', 'refs/heads')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((l) => {
          const [name, t = ''] = l.split('|') as [string, string?];
          return [
            name,
            {
              ahead: Number(/ahead (\d+)/.exec(t)?.[1] ?? 0),
              behind: Number(/behind (\d+)/.exec(t)?.[1] ?? 0),
              gone: t === 'gone',
            },
          ];
        }),
    );
  const tracked = (refs: RefInfo[]): RefInfo[] => refs.filter((r) => r.type === 'local' && r.upstream);
  /** Branches whose (tip, upstream tip) pair the service has counted (internal cache). */
  const known = (svc: GitService, refs: RefInfo[]): Set<string> => {
    const cache = (svc as unknown as { trackCache: Map<string, unknown> }).trackCache;
    const sha = new Map(refs.map((r) => [r.fullName, r.sha]));
    return new Set(
      tracked(refs)
        .filter((r) => cache.has(`${r.sha}:${sha.get(r.upstream!.fullName)}`))
        .map((r) => r.fullName),
    );
  };

  it('fills in chunk by chunk, newest first, and ends equal to git', async () => {
    const f = h.fixture('branches-5k', { branches: 40, commits: 30, tags: 2 });
    const truth = truthOf(f.path);
    const dates = new Map(
      h
        .git(f.path, 'for-each-ref', '--format=%(refname)|%(creatordate:unix)', 'refs/heads')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((l) => l.split('|') as [string, string])
        .map(([n, d]) => [n, Number(d)] as const),
    );
    const svc = await GitService.open(h.runner, f.path, {
      trackSyncLimit: 4,
      trackPriorityCount: 2,
      trackChunkSize: 5,
      trackNotifyMs: 0,
    });
    try {
      let refs: RefInfo[] = [];
      const snapshots: Set<string>[] = [];
      svc.onTrackUpdated(() => snapshots.push(known(svc, refs)));
      refs = await svc.refs();
      const pending = tracked(refs)
        .filter((r) => r.upstream!.trackPending)
        .map((r) => r.fullName)
        .sort((a, b) => dates.get(b)! - dates.get(a)! || (a < b ? -1 : 1));
      expect(pending.length).toBeGreaterThan(20);
      await svc.whenTrackIdle();
      // one notification per chunk (no throttle here): several of them, growing
      expect(snapshots.length).toBeGreaterThanOrEqual(3);
      for (let i = 1; i < snapshots.length; i++)
        expect(snapshots[i]!.size).toBeGreaterThanOrEqual(snapshots[i - 1]!.size);
      // most recently committed first: after the first chunk the newest pending branch is counted, the
      // oldest is not
      expect(snapshots[0]!.has(pending[0]!)).toBe(true);
      expect(snapshots[0]!.has(pending.at(-1)!)).toBe(false);

      const done = tracked(await svc.refs());
      expect(done.every((r) => !r.upstream!.trackPending)).toBe(true);
      for (const r of done) expect(r.upstream, r.fullName).toMatchObject(truth.get(r.fullName)!);
    } finally {
      svc.dispose();
    }
  });

  it('computes prioritized branches first', async () => {
    const f = h.fixture('branches-5k', { branches: 30, commits: 20, tags: 0 });
    const svc = await GitService.open(h.runner, f.path, {
      trackSyncLimit: 4,
      trackPriorityCount: 1,
      trackChunkSize: 4,
      trackNotifyMs: 0,
    });
    try {
      const all = tracked(await svc.refs().then(async (r) => (await svc.whenTrackIdle(), r)));
      // a fresh service (empty cache), hinted at the four oldest branches
      const hint = [...all]
        .sort((a, b) => (a.creatorDate ?? 0) - (b.creatorDate ?? 0))
        .slice(0, 4)
        .map((r) => r.fullName);
      const fresh = await GitService.open(h.runner, f.path, {
        trackSyncLimit: 4,
        trackPriorityCount: 1,
        trackChunkSize: 4,
        trackNotifyMs: 0,
      });
      try {
        fresh.prioritizeTrack(hint);
        let refs: RefInfo[] = [];
        // Two chunks run concurrently, so which lands first is load-dependent. What is guaranteed:
        // the hinted branches are complete while most of the remaining branches are still pending.
        let knownWhenHintDone: number | null = null;
        fresh.onTrackUpdated(() => {
          const got = known(fresh, refs);
          if (knownWhenHintDone === null && hint.every((n) => got.has(n))) knownWhenHintDone = got.size;
        });
        refs = await fresh.refs();
        await fresh.whenTrackIdle();
        expect(knownWhenHintDone).not.toBeNull();
        expect(knownWhenHintDone!).toBeLessThan(tracked(refs).length);
      } finally {
        fresh.dispose();
      }
    } finally {
      svc.dispose();
    }
  });

  it('restarts with fresh tips when a branch moves mid-pass, and stops on dispose', async () => {
    const f = h.fixture('branches-5k', { branches: 40, commits: 20, tags: 0 });
    const svc = await GitService.open(h.runner, f.path, {
      trackSyncLimit: 4,
      trackPriorityCount: 1,
      trackChunkSize: 3,
      trackNotifyMs: 0,
    });
    try {
      let moved = false;
      const branches = tracked(await svc.refs());
      const victim = branches.find((r) => r.upstream!.trackPending)!;
      svc.onTrackUpdated(() => {
        if (moved) return;
        moved = true;
        // the branch gains a commit on top of its upstream: ahead grows by one
        const sha = h
          .git(f.path, 'commit-tree', `${victim.sha}^{tree}`, '-p', victim.sha, '-m', 'moved')
          .trim();
        h.git(f.path, 'update-ref', victim.fullName, sha);
        void svc.refs(); // what the refs refresh after a notification does
      });
      await svc.whenTrackIdle();
      expect(moved).toBe(true);
      // a refs() after the move may have restarted the pass: wait for that one too
      await svc.refs();
      await svc.whenTrackIdle();
      const truth = truthOf(f.path);
      const final = tracked(await svc.refs());
      expect(final.every((r) => !r.upstream!.trackPending)).toBe(true);
      for (const r of final) expect(r.upstream, r.fullName).toMatchObject(truth.get(r.fullName)!);
      expect(final.find((r) => r.fullName === victim.fullName)!.upstream!.ahead).toBe(
        truth.get(victim.fullName)!.ahead,
      );
    } finally {
      svc.dispose();
    }

    // dispose mid-pass: the pass stops, no more notifications
    const svc2 = await GitService.open(h.runner, f.path, {
      trackSyncLimit: 4,
      trackPriorityCount: 1,
      trackChunkSize: 2,
      trackNotifyMs: 0,
    });
    let after = 0;
    svc2.onTrackUpdated(() => {
      if (!after++) svc2.dispose();
    });
    await svc2.refs();
    await svc2.whenTrackIdle();
    expect(after).toBe(1);
  });
});
