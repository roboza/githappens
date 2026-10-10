import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

import { isolatedEnv } from '@githappens/fixtures';
import { describe, expect, it } from 'vitest';

import type { GitProcessRunner } from '../src/process/runner';
import { GitService } from '../src/service/git-service';
import {
  nextFrontier,
  StreamingLogCursor,
  type LogCursorArgs,
  type LogCursorDeps,
} from '../src/service/log-cursor';
import type { CommitSummary, LogQuery } from '../src/types';
import { describeGit, gitPath, useHarness, type Harness } from './ops-harness';

/**
 * Phase 11 (spec 02 §6.15.4): without a commit-graph, every graph page is a topologically ordered window
 * that is consistent with all later pages (no child after its parent), also with clock skew, and later
 * pages never wait for the full ordered walk.
 */

const commit = (sha: string, parents: string[] = []): CommitSummary => ({
  sha,
  parents,
  authorName: 'a',
  authorEmail: 'a@x',
  authorTime: 0,
  committerName: 'a',
  committerEmail: 'a@x',
  commitTime: 0,
  subject: sha,
});

describe('nextFrontier', () => {
  it('keeps the tips outside S and adds the parents of S outside S', () => {
    const s = [commit('a', ['b']), commit('b', ['c', 'x']), commit('m', ['a', 'y'])];
    expect(nextFrontier(['m', 't'], s).sort()).toEqual(['c', 't', 'x', 'y']);
    expect(nextFrontier(['a'], [commit('a')])).toEqual([]);
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
    for (const p of c.parents) {
      if (pos.has(p))
        expect(pos.get(p)!, `parent ${p} shown before its child ${c.sha}`).toBeGreaterThan(pos.get(c.sha)!);
    }
  }
}

/**
 * A branchy history with heavy clock skew (one `git fast-import`): 6 lanes, merges every few commits,
 * and every fifth commit dated up to 3 days before / after its neighbours, so many children are older
 * than their parents. Deterministic (seeded PRNG).
 */
function skewedRepo(
  h: Harness,
  name: string,
  count: number,
  o: { seed?: number; every?: number; days?: number } = {},
): string {
  const dir = path.join(h.root, name);
  fs.mkdirSync(dir, { recursive: true });
  const env = isolatedEnv(h.root);
  execFileSync(gitPath!, ['init', '-q', '--initial-branch=main'], { cwd: dir, env, windowsHide: true });
  let seed = o.seed ?? 42;
  const rnd = (): number => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const lanes: number[] = [];
  let out = '';
  let mark = 0;
  const base = 1_700_000_000;
  for (let i = 0; i < count; i++) {
    const m = ++mark;
    const lane = i < 6 ? i : Math.floor(rnd() * 6);
    const skew = i % (o.every ?? 5) === 0 ? Math.floor((rnd() - 0.5) * 2 * (o.days ?? 3) * 86_400) : 0;
    const when = base + i * 600 + skew;
    const msg = `c${i}`;
    out += `commit refs/heads/lane${lane}\nmark :${m}\n`;
    out += `committer T <t@x> ${when} +0000\ndata ${msg.length}\n${msg}\n`;
    const from = lanes[lane] ?? lanes[0];
    if (from !== undefined) out += `from :${from}\n`;
    if (i > 6 && i % 4 === 0) {
      const other = lanes[(lane + 1 + Math.floor(rnd() * 5)) % 6];
      if (other !== undefined && other !== from) out += `merge :${other}\n`;
    }
    out += `M 644 inline f${lane}.txt\ndata ${String(i).length}\n${i}\n\n`;
    lanes[lane] = m;
  }
  execFileSync(gitPath!, ['fast-import', '--quiet'], { cwd: dir, env, input: out, windowsHide: true });
  execFileSync(gitPath!, ['checkout', '-q', 'lane0'], { cwd: dir, env, windowsHide: true });
  return dir;
}

/** Page through a cursor with varying page sizes. */
async function drain(
  c: StreamingLogCursor,
  sizes: number[],
): Promise<{ all: CommitSummary[]; pages: number }> {
  const all: CommitSummary[] = [];
  let pages = 0;
  for (let i = 0; ; i++) {
    const p = await c.next(sizes[Math.min(i, sizes.length - 1)]!);
    all.push(...p.commits);
    pages++;
    if (p.done) break;
    if (pages > 10_000) throw new Error('runaway cursor');
  }
  return { all, pages };
}

/**
 * A cursor exactly as GitService builds it, except that the full ordered walk never prints: every page
 * then comes from a window (on these small repos the real walk would take over after a page or two).
 */
async function windowOnlyCursor(svc: GitService, h: Harness, q: LogQuery): Promise<StreamingLogCursor> {
  const built = await (svc as unknown as { logArgs(q: LogQuery): Promise<LogCursorArgs> }).logArgs(q);
  expect(built.window).toBeDefined();
  const silent = (): ReturnType<GitProcessRunner['stream']> => {
    const out = new Readable({ read() {} });
    return {
      stdout: out,
      done: new Promise(() => {}),
      cancel: () => out.destroy(),
    };
  };
  const runner = new Proxy(h.runner, {
    get(target, prop, recv) {
      if (prop === 'stream') {
        return (o: Parameters<GitProcessRunner['stream']>[0]) =>
          o.args.includes('--kl-never') ? silent() : target.stream(o);
      }
      const v = Reflect.get(target, prop, recv) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  const deps: LogCursorDeps = {
    runner,
    cwd: svc.repo.worktreeRoot ?? svc.repo.gitDir,
    buildArgs: async () => ({ ...built, args: ['log', '--kl-never'] }),
    hasCommitGraph: () => false,
  };
  return new StreamingLogCursor(deps);
}

describeGit('windowed graph pages without a commit-graph', () => {
  const h = useHarness('logwin');

  const allShas = (dir: string): string[] => h.git(dir, 'rev-list', '--all').trim().split(/\r?\n/).sort();

  it('branchy fixture: every page sequence is a valid topological order of the whole history', async () => {
    const f = h.fixture('huge', { count: 1500, lanes: 8, commitGraph: false });
    const svc = await GitService.open(h.runner, f.path, { commitGraphThreshold: 100 });
    try {
      expect(await svc.topoOrderStreams()).toBe(false);
      for (const order of ['topo', 'date'] as const) {
        for (const sizes of [[500, 2000], [37], [1, 3, 250]]) {
          const c = await windowOnlyCursor(svc, h, { revs: 'all', order });
          const { all } = await drain(c, sizes);
          assertTopological(all);
          expect(all.map((x) => x.sha).sort()).toEqual(allShas(f.path));
          expect(c.windowCount).toBeGreaterThan(1);
          expect(c.spawnCount).toBe(1); // the (silent) full walk only
        }
      }
    } finally {
      svc.dispose();
    }
  });

  it.each([
    { name: 'skew', seed: 42, every: 5, days: 3 },
    { name: 'skew-deep', seed: 7, every: 3, days: 30 },
  ])('clock skew ($name): children older than their parents never come after them', async (o) => {
    const dir = skewedRepo(h, o.name, 700, o);
    // the default order really is wrong here: some parent is printed before one of its children
    const dflt = h.git(dir, 'log', '--all', '--format=%H %P').trim().split(/\r?\n/);
    const seen = new Set<string>();
    let violations = 0;
    for (const line of dflt) {
      const [sha, ...parents] = line.split(' ');
      for (const p of parents) if (seen.has(p)) violations++;
      seen.add(sha!);
    }
    expect(violations).toBeGreaterThan(0);

    const svc = await GitService.open(h.runner, dir, { commitGraphThreshold: 50 });
    try {
      for (const order of ['topo', 'date'] as const) {
        for (const sizes of [[500, 2000], [25], [2, 5, 11]]) {
          const c = await windowOnlyCursor(svc, h, { revs: 'all', order });
          const { all } = await drain(c, sizes);
          assertTopological(all);
          expect(all.map((x) => x.sha).sort()).toEqual(allShas(dir));
        }
      }
      // and through GitService as the app uses it (the real walk may take over at any point)
      for (const sizes of [[500, 2000], [9], [1, 2, 3, 100]]) {
        const c = svc.log({ revs: 'all', order: 'topo' }) as StreamingLogCursor;
        const { all } = await drain(c, sizes);
        assertTopological(all);
        expect(all.map((x) => x.sha).sort()).toEqual(allShas(dir));
      }
    } finally {
      svc.dispose();
    }
  });

  it('switches to one streaming ordered walk once a commit-graph is written, and survives an idle kill', async () => {
    const dir = skewedRepo(h, 'skew-cg', 400);
    const svc = await GitService.open(h.runner, dir, { commitGraphThreshold: 50 });
    try {
      // commit-graph appears after the first page
      const c = await windowOnlyCursor(svc, h, { revs: 'all', order: 'topo' });
      let graph = false;
      (c as unknown as { deps: LogCursorDeps }).deps.hasCommitGraph = () => graph;
      const first = await c.next(60);
      expect(first.done).toBe(false);
      h.git(dir, 'commit-graph', 'write', '--reachable');
      graph = true;
      const rest = await drain(c, [50]);
      const all = [...first.commits, ...rest.all];
      assertTopological(all);
      expect(all.map((x) => x.sha).sort()).toEqual(allShas(dir));
      expect(c.spawnCount).toBe(2); // the silent walk, then the frontier walk
      fs.rmSync(path.join(dir, '.git', 'objects', 'info', 'commit-graph'), { force: true });

      // idle kill in windowed mode: the restarted full walk skips what was shown
      const d = svc.log({ revs: 'all', order: 'date' }) as StreamingLogCursor;
      const p1 = await d.next(40);
      d.suspend();
      const more = await drain(d, [70]);
      const all2 = [...p1.commits, ...more.all];
      assertTopological(all2);
      expect(all2.map((x) => x.sha).sort()).toEqual(allShas(dir));
    } finally {
      svc.dispose();
    }
  });
});
