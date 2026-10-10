/**
 * Perf fixtures (spec 15 §7 "Perf", spec 02 §6.16 / §9, spec 04 §7 step 26):
 *
 * - `huge`        200k commits, branchy (up to `lanes` concurrent topic branches merged back with --no-ff),
 *                 commit-graph written (spec 04 §9: "huge fixture (200k commits, commit-graph present)").
 * - `huge-1m`     the same topology with 1M commits; only built by `pnpm bench` / on request.
 * - `files-100k`  100k tracked files (status benchmarks).
 * - `branches-5k` 5k local branches with upstreams + 5k remote-tracking branches (refs benchmarks).
 *
 * Everything is streamed through one `git fast-import` (input written to a temp file, never held in
 * memory as a whole) — no git process per commit. Dates, authors and topology come from a fixed clock
 * and a seeded PRNG, so SHAs are identical on every machine. Every generator takes small-size options
 * (`count`, `files`, `branches`, `commits`) so unit tests stay fast.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { FixtureContext, FixtureResult } from './generators';
import { AUTHORS, EPOCH, gitBinary, Repo } from './repo';

/** Fixtures too large for the default `pnpm fixtures` run (built explicitly or by the bench runner). */
export const HEAVY_FIXTURES: ReadonlySet<string> = new Set(['huge', 'huge-1m', 'files-100k', 'branches-5k']);

const opt = (o: FixtureContext['options'], key: string, dflt: number): number => {
  const v = o[key];
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
};
const flag = (o: FixtureContext['options'], key: string, dflt: boolean): boolean => {
  const v = o[key];
  if (v === undefined) return dflt;
  return !(v === false || v === 'false' || v === 0 || v === '0');
};

/** mulberry32: tiny seeded PRNG so topology is deterministic. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Buffered writer for a fast-import stream file (flushes every ~1 MB). */
class StreamFile {
  private readonly fd: number;
  private chunks: string[] = [];
  private size = 0;
  constructor(readonly file: string) {
    this.fd = fs.openSync(file, 'w');
  }
  write(s: string): void {
    this.chunks.push(s);
    this.size += s.length;
    if (this.size > 1 << 20) this.flush();
  }
  /** `data <n>\n<payload>\n` with the byte length fast-import expects. */
  data(payload: string): void {
    this.write(`data ${Buffer.byteLength(payload)}\n${payload}\n`);
  }
  flush(): void {
    if (!this.chunks.length) return;
    fs.writeSync(this.fd, this.chunks.join(''));
    this.chunks = [];
    this.size = 0;
  }
  close(): void {
    this.flush();
    fs.closeSync(this.fd);
  }
}

/** Run `git fast-import` with `file` as stdin (no shell, no in-memory copy of the stream). */
function fastImport(ctx: FixtureContext, file: string, extra: string[] = []): void {
  const fd = fs.openSync(file, 'r');
  try {
    const r = spawnSync(gitBinary(), ['fast-import', '--quiet', ...extra], {
      cwd: ctx.dir,
      env: ctx.env,
      stdio: [fd, 'pipe', 'pipe'],
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (r.error) throw r.error;
    if (r.status !== 0)
      throw new Error(`git fast-import failed in ${ctx.dir}: ${r.stderr?.toString() ?? ''}`);
  } finally {
    fs.closeSync(fd);
  }
}

/** Temp stream file next to the fixture (removed by makeFixture's `<name>.*` cleanup if left behind). */
function withStream<T>(ctx: FixtureContext, fn: (s: StreamFile) => T): { result: T; file: string } {
  const file = `${ctx.dir}.fast-import`;
  const s = new StreamFile(file);
  try {
    return { result: fn(s), file };
  } finally {
    s.close();
  }
}

const WHO = [AUTHORS.alice, AUTHORS.bob, AUTHORS.carol] as const;

/** Writes commits to a fast-import stream with sequential marks and a one-minute clock. */
class CommitWriter {
  mark = 0;
  private t = EPOCH;
  constructor(private readonly s: StreamFile) {}
  commit(
    ref: string,
    msg: string,
    o: { from?: number; merge?: number; files?: [string, string][] } = {},
  ): number {
    const m = ++this.mark;
    const who = WHO[m % 3]!;
    this.t += 60;
    const ident = `${who.name} <${who.email}> ${this.t} +0000`;
    this.s.write(`commit ${ref}\nmark :${m}\nauthor ${ident}\ncommitter ${ident}\n`);
    this.s.data(msg);
    if (o.from) this.s.write(`from :${o.from}\n`);
    if (o.merge) this.s.write(`merge :${o.merge}\n`);
    for (const [p, content] of o.files ?? []) {
      this.s.write(`M 644 inline ${p}\n`);
      this.s.data(content);
    }
    this.s.write('\n');
    return m;
  }
}

// ---------------------------------------------------------------------------

/**
 * Large branchy history. `count` commits (default 200k) are all reachable from `main`: up to `lanes`
 * (default 8) topic branches fork from main, get 2–40 commits each and merge back with a --no-ff
 * merge; main's first-parent line keeps moving meanwhile, so the graph shows several concurrent lanes.
 * `commitGraph` (default true) writes `objects/info/commit-graph` (generation numbers → streaming
 * `--topo-order`, spec 02 §6.15.4); `changedPaths` adds Bloom filters like the app's maintainer does.
 */
export function hugeHistory(ctx: FixtureContext): FixtureResult {
  const { dir, env, clock, options } = ctx;
  const count = opt(options, 'count', 200_000);
  const lanes = Math.min(opt(options, 'lanes', 8), 64);
  const rand = prng(opt(options, 'seed', 0x5eed));
  const r = Repo.init(dir, env, clock);

  let merges = 0;
  const { file } = withStream(ctx, (s) => {
    const w = new CommitWriter(s);
    type Topic = { tip: number; len: number; target: number; content: string };
    const topics: (Topic | null)[] = Array.from({ length: lanes }, () => null);
    let mainTip = 0;
    let produced = 0;
    const openCount = (): number => topics.reduce((n, t) => n + (t ? 1 : 0), 0);
    const mergeTopic = (slot: number): void => {
      const t = topics[slot]!;
      mainTip = w.commit('refs/heads/main', `Merge branch 'topic-${slot}' (${t.len} commits)`, {
        from: mainTip,
        merge: t.tip,
        files: [[`topics/t${slot}.txt`, t.content]],
      });
      topics[slot] = null;
      merges++;
    };
    while (produced < count) {
      const remaining = count - produced;
      const open = openCount();
      produced++;
      if (mainTip === 0) {
        mainTip = w.commit('refs/heads/main', 'Initial commit', {
          files: [['README.md', '# Huge\n']],
        });
        continue;
      }
      // Close topics while there is budget left so every commit ends up reachable from main.
      if (remaining <= open) {
        mergeTopic(topics.findIndex(Boolean));
        continue;
      }
      const x = rand();
      const finished = topics.findIndex((t) => t !== null && t.len >= t.target);
      if (finished >= 0 && x < 0.35) {
        mergeTopic(finished);
        continue;
      }
      const idle = topics.indexOf(null);
      if (idle >= 0 && x < 0.5 && remaining >= open + 2) {
        const content = `topic ${idle} @${produced}\n`;
        const tip = w.commit(`refs/heads/topic-${idle}`, `topic-${idle}: start at ${produced}`, {
          from: mainTip,
          files: [[`topics/t${idle}.txt`, content]],
        });
        topics[idle] = { tip, len: 1, target: 2 + Math.floor(rand() * 39), content };
        continue;
      }
      // A plain commit on main (weight 2) or on one of the open topics.
      const active = topics.flatMap((t, i) => (t ? [i] : []));
      const pick = Math.floor(rand() * (active.length + 2)) - 2;
      if (pick < 0) {
        mainTip = w.commit('refs/heads/main', `Commit ${produced}`, {
          from: mainTip,
          files: [[`src/f${produced % 50}.txt`, `${produced}\n`]],
        });
      } else {
        const slot = active[pick]!;
        const t = topics[slot]!;
        t.content = `topic ${slot} @${produced}\n`;
        t.tip = w.commit(`refs/heads/topic-${slot}`, `topic-${slot}: work ${t.len + 1}`, {
          from: t.tip,
          files: [[`topics/t${slot}.txt`, t.content]],
        });
        t.len++;
      }
    }
  });
  fastImport(ctx, file);
  fs.rmSync(file, { force: true });
  // every topic was merged: drop the temporary refs
  const topicRefs = r
    .git('for-each-ref', '--format=%(refname)', 'refs/heads/topic-*')
    .split('\n')
    .filter(Boolean);
  if (topicRefs.length)
    r.gitWith({ input: topicRefs.map((t) => `delete ${t}\n`).join('') }, 'update-ref', '--stdin');
  r.git('checkout', '-q', '-f', 'main');
  const commitGraph = flag(options, 'commitGraph', true);
  if (commitGraph) {
    r.git(
      'commit-graph',
      'write',
      '--reachable',
      ...(flag(options, 'changedPaths', false) ? ['--changed-paths'] : []),
    );
  }
  return { path: dir, facts: { commits: count, merges, lanes, commitGraph, head: r.head() } };
}

/**
 * `files` tracked files (default 100k) in a two-level tree of 100-file directories, plus a second commit
 * touching 1% of them. The worktree is checked out with parallel checkout workers.
 */
export function manyFiles(ctx: FixtureContext): FixtureResult {
  const { dir, env, clock, options } = ctx;
  const files = opt(options, 'files', opt(options, 'count', 100_000));
  const r = Repo.init(dir, env, clock);
  const fileAt = (i: number): string => {
    const d = Math.floor(i / 100);
    return `src/m${String(Math.floor(d / 100)).padStart(2, '0')}/d${String(d % 100).padStart(2, '0')}/f${String(i % 100).padStart(2, '0')}.txt`;
  };
  const { file } = withStream(ctx, (s) => {
    const w = new CommitWriter(s);
    const all: [string, string][] = [['README.md', `# ${files} files\n`]];
    for (let i = 0; i < files; i++) all.push([fileAt(i), `file ${i}\n`]);
    const first = w.commit('refs/heads/main', `Add ${files} files`, { files: all });
    const touched: [string, string][] = [];
    for (let i = 0; i < files; i += 100) touched.push([fileAt(i), `file ${i}\nrevised\n`]);
    w.commit('refs/heads/main', `Revise ${touched.length} files`, { from: first, files: touched });
  });
  fastImport(ctx, file);
  fs.rmSync(file, { force: true });
  r.git('-c', 'checkout.workers=0', 'checkout', '-q', '-f', 'main');
  return { path: dir, facts: { files: files + 1, sample: [fileAt(0), fileAt(files - 1)] } };
}

/**
 * `branches` local branches (default 5000) under `feature/`, each tracking `origin/feature/…` that is
 * 0–3 commits ahead or behind, on a `commits`-long main line (default 1000), plus `tags` lightweight
 * tags (default 100). Refs go straight into a sorted `packed-refs` (what `git pack-refs --all` writes).
 */
export function manyBranches(ctx: FixtureContext): FixtureResult {
  const { dir, env, clock, options } = ctx;
  const branches = opt(options, 'branches', opt(options, 'count', 5000));
  const commits = Math.max(opt(options, 'commits', 1000), 8);
  const tags = opt(options, 'tags', 100);
  const r = Repo.init(dir, env, clock);
  const marksFile = `${dir}.marks`;
  const { file } = withStream(ctx, (s) => {
    const w = new CommitWriter(s);
    let tip = 0;
    for (let i = 1; i <= commits; i++) {
      tip = w.commit('refs/heads/main', `Commit ${i}`, {
        ...(tip ? { from: tip } : {}),
        files: [[`src/f${i % 40}.txt`, `${i}\n`]],
      });
    }
  });
  fastImport(ctx, file, [`--export-marks=${marksFile}`]);
  fs.rmSync(file, { force: true });
  const shas: string[] = [];
  for (const line of fs.readFileSync(marksFile, 'utf8').split('\n')) {
    const m = /^:(\d+) ([0-9a-f]+)$/.exec(line);
    if (m) shas[Number(m[1]) - 1] = m[2]!;
  }
  fs.rmSync(marksFile, { force: true });

  const name = (i: number): string => `feature/b${String(i).padStart(5, '0')}`;
  const refs: [string, string][] = [];
  const config: string[] = [
    '[remote "origin"]',
    '\turl = ../origin.git',
    '\tfetch = +refs/heads/*:refs/remotes/origin/*',
  ];
  for (let i = 0; i < branches; i++) {
    const local = (i * 7919) % commits;
    const remote = Math.min(commits - 1, Math.max(0, local + ((i % 7) - 3)));
    refs.push([`refs/heads/${name(i)}`, shas[local]!], [`refs/remotes/origin/${name(i)}`, shas[remote]!]);
    config.push(`[branch "${name(i)}"]`, '\tremote = origin', `\tmerge = refs/heads/${name(i)}`);
  }
  refs.push(['refs/remotes/origin/main', shas[commits - 1]!]);
  for (let i = 0; i < tags; i++) refs.push([`refs/tags/v0.${i}`, shas[(i * 13) % commits]!]);
  refs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const gitDir = path.join(dir, '.git');
  fs.writeFileSync(
    path.join(gitDir, 'packed-refs'),
    '# pack-refs with: peeled fully-peeled sorted \n' + refs.map(([n, sha]) => `${sha} ${n}\n`).join(''),
  );
  fs.appendFileSync(path.join(gitDir, 'config'), config.join('\n') + '\n');
  r.git('checkout', '-q', '-f', 'main');
  r.git('branch', '-q', '--set-upstream-to=origin/main', 'main');
  return { path: dir, facts: { branches, remoteBranches: branches + 1, tags, commits } };
}

/** 1M-commit variant of `huge` for the bench runner (spec 15 §7: ≥1M commits). */
export function hugeMillion(ctx: FixtureContext): FixtureResult {
  return hugeHistory({ ...ctx, options: { count: 1_000_000, lanes: 16, ...ctx.options } });
}
