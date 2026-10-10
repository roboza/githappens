import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { GitService } from '../src/service/git-service';
import { LOG_SEED_COUNT, seedOrder, type StreamingLogCursor } from '../src/service/log-cursor';
import type { CommitSummary } from '../src/types';
import { describeGit, tinyRepo, useHarness } from './ops-harness';

/**
 * spec 02 §6.15.4: large repo without a commit-graph → fast seeded first page (default-order probe),
 * then the ordered walk minus the seeded commits; and the spawn-free rev set (HEAD / stash from files).
 */

const commit = (sha: string, time: number, parents: string[] = []): CommitSummary => ({
  sha,
  parents,
  authorName: 'a',
  authorEmail: 'a@x',
  authorTime: time,
  committerName: 'a',
  committerEmail: 'a@x',
  commitTime: time,
  subject: sha,
});

describe('seedOrder', () => {
  it('drops the oldest timestamp (possibly incomplete) and puts children first on equal times', () => {
    // default order may print parent p before child c2 when they share a timestamp
    const probe = [commit('c1', 10, ['p']), commit('p', 9, ['o']), commit('c2', 9, ['p']), commit('o', 5)];
    expect(seedOrder(probe, false).map((c) => c.sha)).toEqual(['c1', 'c2', 'p']);
    expect(seedOrder(probe, true).map((c) => c.sha)).toEqual(['c1', 'c2', 'p', 'o']);
    expect(seedOrder([], false)).toEqual([]);
  });
});

/** Every commit appears once and before all of its parents. */
function assertTopological(commits: CommitSummary[]): void {
  const pos = new Map<string, number>();
  commits.forEach((c, i) => {
    expect(pos.has(c.sha), `duplicate ${c.sha}`).toBe(false);
    pos.set(c.sha, i);
  });
  for (const c of commits) {
    for (const p of c.parents)
      if (pos.has(p)) expect(pos.get(p)!, `${p} after ${c.sha}`).toBeGreaterThan(pos.get(c.sha)!);
  }
}

describeGit('seeded first page without a commit-graph (spec 02 §6.15.4)', () => {
  const h = useHarness('seed');

  it('shows a fast first page, then the full history in a valid order (also across an idle restart)', async () => {
    const f = h.fixture('huge', { count: LOG_SEED_COUNT + 300, lanes: 6, commitGraph: false });
    const all = h.git(f.path, 'rev-list', '--all').trim().split(/\r?\n/).sort();
    const svc = await GitService.open(h.runner, f.path, { commitGraphThreshold: 100 });
    try {
      expect(await svc.topoOrderStreams()).toBe(false);
      for (const order of ['topo', 'date'] as const) {
        for (const restart of [false, true]) {
          // a filtered query (the graph's plain query is windowed, see log-window.test.ts)
          const c = svc.log({ revs: 'all', order, since: 1 }) as StreamingLogCursor;
          const first = await c.next(2000);
          // the seed page comes back on its own, before the walk is read
          expect(first.done).toBe(false);
          expect(first.commits.length).toBeGreaterThan(0);
          expect(first.commits.length).toBeLessThan(LOG_SEED_COUNT);
          const got = [...first.commits];
          if (restart) {
            got.push(...(await c.next(100)).commits);
            c.suspend(); // idle timeout: the walk restarts with --skip
          }
          for (;;) {
            const p = await c.next(250);
            got.push(...p.commits);
            if (p.done) break;
          }
          assertTopological(got);
          expect(got.map((x) => x.sha).sort()).toEqual(all);
          if (restart) expect(c.spawnCount).toBe(2);
        }
      }
      // once a commit-graph exists, the plain ordered walk is used
      h.git(f.path, 'commit-graph', 'write', '--reachable');
      expect(await svc.topoOrderStreams()).toBe(true);
      const c = svc.log({ revs: 'all', order: 'topo' });
      expect((await c.next(LOG_SEED_COUNT)).commits).toHaveLength(LOG_SEED_COUNT);
      c.dispose();
    } finally {
      svc.dispose();
    }
  });

  it('a small history below the probe size is served from the probe alone', async () => {
    const r = await tinyRepo(h);
    for (let i = 0; i < 5; i++) r.commit(`c${i}`, { [`f${i}.txt`]: `${i}\n` });
    const svc = await GitService.open(h.runner, r.dir, { commitGraphThreshold: 2 });
    try {
      const c = svc.log({ revs: 'all', order: 'topo' }) as StreamingLogCursor;
      const p = await c.next(100);
      expect(p.done).toBe(true);
      expect(p.commits.map((x) => x.subject)).toEqual(['c4', 'c3', 'c2', 'c1', 'c0', 'Base']);
    } finally {
      svc.dispose();
    }
  });
});

describeGit('graph rev set without spawning git (HEAD / stash from files)', () => {
  const h = useHarness('revset');

  it('includes stash tips, a detached HEAD and a hidden current branch like rev-parse would', async () => {
    const r = await tinyRepo(h);
    const base = r.commit('base', { 'a.txt': 'a\n' });
    fs.writeFileSync(path.join(r.dir, 'a.txt'), 'wip 1\n');
    r.g('stash', 'push', '-q', '-m', 's1');
    fs.writeFileSync(path.join(r.dir, 'a.txt'), 'wip 2\n');
    r.g('stash', 'push', '-q', '-m', 's2');
    const stashes = r.g('stash', 'list', '--format=%H').trim().split(/\r?\n/);
    const svc = await GitService.open(h.runner, r.dir);
    const shas = async (hiddenRefs?: string[]): Promise<string[]> => {
      const c = svc.log({ revs: 'all', order: 'topo', hiddenRefs });
      const p = await c.next(100);
      c.dispose();
      return p.commits.map((x) => x.sha);
    };
    try {
      const withStash = await shas();
      for (const s of stashes) expect(withStash).toContain(s);

      // detached HEAD on a commit no ref points to
      r.g('checkout', '-q', '--detach');
      const lone = r.commit('detached only', { 'd.txt': 'd\n' });
      expect(await shas()).toContain(lone);

      // a hidden current branch still shows through HEAD (also when packed)
      r.g('checkout', '-q', '-b', 'side', base);
      const side = r.commit('side only', { 's.txt': 's\n' });
      expect(await shas(['refs/heads/side'])).toContain(side);
      r.g('pack-refs', '--all');
      expect(await shas(['refs/heads/side'])).toContain(side);

      r.g('stash', 'clear');
      for (const s of stashes) expect(await shas()).not.toContain(s);
    } finally {
      svc.dispose();
    }
  });
});

describeGit('status through the untracked cache (spec 02 §6.15.2)', () => {
  const h = useHarness('ucache');

  it('with core.untrackedCache, -unormal + expanded untracked dirs equals -uall', async () => {
    const r = await tinyRepo(h, { 'a.txt': 'a\n', 'src/b.txt': 'b\n' });
    r.g('config', 'core.untrackedCache', 'true');
    fs.writeFileSync(path.join(r.dir, 'a.txt'), 'changed\n');
    fs.writeFileSync(path.join(r.dir, 'top.txt'), 't\n');
    for (const rel of ['new/x.txt', 'new/deep/y.txt', 'src/fresh/z.txt', 'zz/w.txt']) {
      fs.mkdirSync(path.dirname(path.join(r.dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(r.dir, rel), `${rel}\n`);
    }
    const plain = await GitService.open(h.runner, r.dir);
    const svc = await GitService.open(h.runner, r.dir);
    try {
      const expected = await plain.status();
      await svc.status(); // starts the background config read
      await vi.waitFor(() =>
        expect((svc as unknown as { ucCheck: { value: boolean } }).ucCheck.value).toBe(true),
      );
      const got = await svc.status();
      expect(got.entries).toEqual(expected.entries);
      expect(got.entries.filter((e) => e.kind === 'untracked').map((e) => e.path)).toEqual([
        'new/deep/y.txt',
        'new/x.txt',
        'src/fresh/z.txt',
        'top.txt',
        'zz/w.txt',
      ]);
      // explosion threshold still applies
      const limited = await GitService.open(h.runner, r.dir, { untrackedLimit: 2 });
      await limited.status();
      await vi.waitFor(() =>
        expect((limited as unknown as { ucCheck: { value: boolean } }).ucCheck.value).toBe(true),
      );
      expect((await limited.status()).truncatedUntracked).toBe(true);
      limited.dispose();
    } finally {
      plain.dispose();
      svc.dispose();
    }
  });
});
