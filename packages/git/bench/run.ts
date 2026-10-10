/**
 * Git engine benchmarks (spec 15 §7 "Perf", spec 02 §6.15 / §6.16 / §9, spec 04 §7 step 26).
 *
 *   pnpm bench                       # everything (builds/reuses cached fixtures, incl. 1M commits)
 *   pnpm bench --quick               # skip the 1M-commit repo and the graph layout bench
 *   pnpm bench --only=log,status     # suites: log, million, status, refs, graph
 *   pnpm bench --out=results.json    # default: <repo>/bench-results/git-bench.json
 *   BENCH_STRICT=1 pnpm bench        # exit 1 when a threshold is missed (nightly CI)
 *
 * Fixtures are generated once into GH_BENCH_CACHE (default test/fixtures/.repos/bench, gitignored)
 * and reused while the generator sources, options and git version are unchanged.
 * Uses the real GitService / OperationQueue / GitProcessRunner from this package and the git on PATH
 * (override with GH_BENCH_GIT).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import v8 from 'node:v8';
import vm from 'node:vm';

import { makeFixture, type FixtureName, type FixtureResult } from '@githappens/fixtures';

import {
  bundledGitEnv,
  bundledGitExecutable,
  createOpRegistry,
  findOnPath,
  GitProcessRunner,
  GitService,
  OperationQueue,
  type CommitSummary,
  type LogQuery,
} from '../src';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

// ---- CLI ----

const argv = process.argv.slice(2);
const flags = new Map(
  argv
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const [k, ...v] = a.slice(2).split('=');
      return [k!, v.length ? v.join('=') : 'true'] as const;
    }),
);
const quick = flags.has('quick');
const ALL_SUITES = ['log', 'million', 'status', 'refs', 'graph'] as const;
type Suite = (typeof ALL_SUITES)[number];
const only = new Set(
  (flags.get('only')?.split(',') ??
    ALL_SUITES.filter((s) => !(quick && (s === 'million' || s === 'graph')))) as Suite[],
);
const strict = process.env.BENCH_STRICT === '1';
// relative paths are resolved against the directory `pnpm bench` was started from (INIT_CWD)
const userCwd = process.env.INIT_CWD ?? process.cwd();
const outFile = path.resolve(
  userCwd,
  flags.get('out') ?? path.join(repoRoot, 'bench-results', 'git-bench.json'),
);
const cacheRoot = path.resolve(
  userCwd,
  process.env.GH_BENCH_CACHE ?? path.join(repoRoot, 'test', 'fixtures', '.repos', 'bench'),
);
const numFlag = (k: string, d: number): number => (flags.has(k) ? Number(flags.get(k)) : d);
const SIZES = {
  huge: numFlag('huge-count', 200_000),
  million: numFlag('million-count', 1_000_000),
  files: numFlag('files', 100_000),
  branches: numFlag('branches', 5000),
};

/**
 * The engine under test mirrors the app: the bundled portable git (dugite's download in development,
 * spec 15 §6.2) with its own system config (core.fscache etc. on Windows), falling back to git on PATH.
 * The user's global config is replaced by an empty file so personal settings don't skew results.
 * Fixtures are generated with the git on PATH (GITHAPPENS_FIXTURE_GIT) in their isolated env.
 */
function resolveEngine(): { gitPath: string; env: NodeJS.ProcessEnv; label: string } {
  const emptyGlobal = path.join(cacheRoot, '.gitconfig-bench');
  fs.mkdirSync(cacheRoot, { recursive: true });
  if (!fs.existsSync(emptyGlobal)) fs.writeFileSync(emptyGlobal, '');
  const base: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: emptyGlobal,
    GIT_TERMINAL_PROMPT: '0',
  };
  delete base.GIT_CONFIG_NOSYSTEM;
  if (process.env.GH_BENCH_GIT)
    return { gitPath: process.env.GH_BENCH_GIT, env: base, label: 'GH_BENCH_GIT' };
  try {
    const req = createRequire(path.join(repoRoot, 'apps', 'desktop', 'package.json'));
    const layout = {
      dir: path.join(path.dirname(req.resolve('dugite/package.json')), 'git'),
      platform: process.platform,
      arch: process.arch,
    };
    const exe = bundledGitExecutable(layout);
    if (fs.existsSync(exe))
      return { gitPath: exe, env: { ...base, ...bundledGitEnv(layout, base) }, label: 'bundled (dugite)' };
  } catch {
    /* dugite not installed */
  }
  const onPath = findOnPath('git');
  if (!onPath) {
    console.error('bench: no bundled git and none on PATH (set GH_BENCH_GIT)');
    process.exit(1);
  }
  return { gitPath: onPath, env: base, label: 'system (PATH)' };
}
const engine = resolveEngine();
const gitPath = engine.gitPath;
process.env.GITHAPPENS_FIXTURE_GIT ??= findOnPath('git') ?? gitPath;
const gitVersion = spawnSync(gitPath, ['--version'], { encoding: 'utf8', env: engine.env }).stdout.trim();
const fixtureGitVersion = spawnSync(process.env.GITHAPPENS_FIXTURE_GIT, ['--version'], {
  encoding: 'utf8',
}).stdout.trim();

// ---- results ----

interface Result {
  suite: Suite;
  name: string;
  value: number;
  unit: 'ms' | 'MB' | 'commits/s' | 'pass';
  /** Upper bound (lower is better) — omitted for informational numbers. */
  threshold?: number;
  /** Where the threshold comes from. */
  source?: string;
  ok?: boolean;
  note?: string;
}
const results: Result[] = [];
const record = (r: Result): void => {
  const ok = r.ok ?? (r.threshold === undefined ? undefined : r.value <= r.threshold);
  results.push({ ...r, ...(ok === undefined ? {} : { ok }) });
  const lim = r.threshold === undefined ? '' : ` (≤ ${r.threshold} ${r.unit})`;
  const flag = ok === undefined ? '  ' : ok ? 'ok' : '!!';
  console.log(`  ${flag} ${r.name.padEnd(46)} ${fmt(r.value).padStart(10)} ${r.unit}${lim}`);
};
const fmt = (n: number): string => (n >= 100 ? n.toFixed(0) : n.toFixed(1));

const now = (): number => performance.now();
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)]!;
};
async function timeIt<T>(fn: () => Promise<T>): Promise<[number, T]> {
  const t0 = now();
  const v = await fn();
  return [now() - t0, v];
}
async function sampleMedian(n: number, fn: () => Promise<unknown>): Promise<number> {
  const xs: number[] = [];
  for (let i = 0; i < n; i++) xs.push((await timeIt(fn))[0]);
  return median(xs);
}

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc') as () => void;
const heapMb = (): number => {
  gc();
  return process.memoryUsage().heapUsed / 2 ** 20;
};

// ---- fixtures (cached) ----

const generatorHash = (() => {
  const h = createHash('sha256');
  const src = path.join(repoRoot, 'test', 'fixtures', 'src');
  for (const f of fs.readdirSync(src).sort()) h.update(f).update(fs.readFileSync(path.join(src, f)));
  return h.update(fixtureGitVersion).digest('hex').slice(0, 16);
})();

function fixture(name: FixtureName, options: Record<string, number | string | boolean>): FixtureResult {
  const stamp = path.join(cacheRoot, `${name}.stamp.json`);
  const key = `${generatorHash}:${JSON.stringify(options)}`;
  try {
    const s = JSON.parse(fs.readFileSync(stamp, 'utf8')) as { key: string; result: FixtureResult };
    if (s.key === key && fs.existsSync(s.result.path)) {
      console.log(`  fixture ${name}: cached (${s.result.path})`);
      return s.result;
    }
  } catch {
    /* not cached */
  }
  process.stdout.write(`  fixture ${name}: generating ${JSON.stringify(options)} … `);
  const t0 = now();
  const result = makeFixture(name, { root: cacheRoot, force: true, options });
  console.log(`${((now() - t0) / 1000).toFixed(1)} s`);
  fs.writeFileSync(stamp, JSON.stringify({ key, result }, null, 2));
  return result;
}

// ---- engine ----

const runner = new GitProcessRunner({
  context: () => ({ gitPath, baseEnv: engine.env, bundled: engine.label.startsWith('bundled') }),
});
const services: GitService[] = [];
const open = async (p: string): Promise<GitService> => {
  const s = await GitService.open(runner, p);
  services.push(s);
  return s;
};
const git = (cwd: string, ...args: string[]): string => {
  const r = spawnSync(gitPath, args, {
    cwd,
    env: engine.env,
    encoding: 'utf8',
    maxBuffer: 256 * 2 ** 20,
    windowsHide: true,
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};

/** Like git(), ignoring failures (e.g. unsetting a config key that is not set). */
const gitTry = (cwd: string, ...args: string[]): void => {
  spawnSync(gitPath, args, { cwd, env: engine.env, windowsHide: true });
};

const TOPO: LogQuery = { revs: 'all', order: 'topo' };
const DATE: LogQuery = { revs: 'all', order: 'date' };

/** First page (cold cursor: spawn + rev walk + parse) and the page after it. */
async function logPages(
  svc: GitService,
  q: LogQuery,
  runs = 5,
): Promise<{ first: number; next: number; firstCount: number }> {
  const firsts: number[] = [];
  const nexts: number[] = [];
  let firstCount = 0;
  for (let i = 0; i < runs; i++) {
    const c = svc.log(q);
    try {
      const [t1, p1] = await timeIt(() => c.next(500));
      firstCount = p1.commits.length;
      const [t2] = await timeIt(() => c.next(2000));
      firsts.push(t1);
      nexts.push(t2);
    } finally {
      c.dispose();
    }
  }
  return { first: median(firsts), next: median(nexts), firstCount };
}

/** Temporarily hide the commit-graph (and split chain) to measure the no-commit-graph path. */
async function withoutCommitGraph<T>(gitDir: string, fn: () => Promise<T>): Promise<T> {
  const info = path.join(gitDir, 'objects', 'info');
  const moved: [string, string][] = [];
  for (const n of ['commit-graph', 'commit-graphs']) {
    const p = path.join(info, n);
    if (fs.existsSync(p)) {
      fs.renameSync(p, `${p}.bench-off`);
      moved.push([`${p}.bench-off`, p]);
    }
  }
  try {
    return await fn();
  } finally {
    for (const [from, to] of moved) fs.renameSync(from, to);
  }
}

function ensureCommitGraph(dir: string): void {
  if (!fs.existsSync(path.join(dir, '.git', 'objects', 'info', 'commit-graph'))) {
    git(dir, 'commit-graph', 'write', '--reachable');
  }
}

// ---- suites ----

async function suiteLog(): Promise<void> {
  console.log(`\n[log] huge fixture (${SIZES.huge.toLocaleString()} commits, branchy)`);
  const f = fixture('huge', { count: SIZES.huge });
  ensureCommitGraph(f.path);
  const svc = await open(f.path);
  await withoutCommitGraph(svc.repo.commonDir, async () => {
    const topo = await logPages(svc, TOPO, 3);
    record({
      suite: 'log',
      name: `huge: first page (${topo.firstCount}), topo, no commit-graph`,
      value: topo.first,
      unit: 'ms',
      note: 'informational: windowed first page (default-order stream + a short ordered window walk); the full ordered walk needs the whole history without generation numbers',
    });
    record({
      suite: 'log',
      name: 'huge: next 2000, topo, no commit-graph',
      value: topo.next,
      unit: 'ms',
      note: 'informational: next window (Phase 11; before: waited for the full ordered walk, ≈ 1.1 s)',
    });
    const date = await logPages(svc, DATE, 3);
    record({
      suite: 'log',
      name: `huge: first page (${date.firstCount}), date-order, no commit-graph`,
      value: date.first,
      unit: 'ms',
      note: 'informational: windowed first page, see above',
    });
  });
  const cg = await logPages(svc, TOPO, 5);
  record({
    suite: 'log',
    name: 'huge: first 500, topo, commit-graph',
    value: cg.first,
    unit: 'ms',
    threshold: 300,
    source: 'spec 02 §6.15.4 / §9 (spec 04 §7.4: first chunk < 150 ms)',
  });
  record({
    suite: 'log',
    name: 'huge: next 2000, topo, commit-graph',
    value: cg.next,
    unit: 'ms',
    threshold: 150,
    source: 'spec 02 §9 (next page < 150 ms)',
  });
}

async function suiteMillion(): Promise<void> {
  console.log(`\n[million] synthetic ${SIZES.million.toLocaleString()}-commit repo`);
  const f = fixture('huge-1m', { count: SIZES.million });
  ensureCommitGraph(f.path);
  const svc = await open(f.path);
  const pages = await logPages(svc, TOPO, 5);
  record({
    suite: 'million',
    name: '1M: first 500, topo, commit-graph',
    value: pages.first,
    unit: 'ms',
    threshold: 300,
    source: 'spec 02 §9',
  });
  record({
    suite: 'million',
    name: '1M: next 2000, topo, commit-graph',
    value: pages.next,
    unit: 'ms',
    threshold: 150,
    source: 'spec 02 §9',
  });

  // Stream the whole history through the cursor; keep the first 100k to measure their footprint.
  const base = heapMb();
  const kept: CommitSummary[] = [];
  let total = 0;
  let heapAt100k = NaN;
  const c = svc.log(TOPO);
  const t0 = now();
  try {
    for (;;) {
      const p = await c.next(10_000);
      total += p.commits.length;
      if (kept.length < 100_000) kept.push(...p.commits.slice(0, 100_000 - kept.length));
      if (kept.length >= 100_000 && Number.isNaN(heapAt100k)) heapAt100k = heapMb() - base;
      if (p.done) break;
    }
  } finally {
    c.dispose();
  }
  const ms = now() - t0;
  record({
    suite: 'million',
    name: `1M: stream all ${total.toLocaleString()} commits`,
    value: ms,
    unit: 'ms',
  });
  record({
    suite: 'million',
    name: '1M: streaming throughput',
    value: total / (ms / 1000),
    unit: 'commits/s',
  });
  record({
    suite: 'million',
    name: '1M: heap for 100k loaded commits',
    value: heapAt100k,
    unit: 'MB',
    threshold: 300,
    source: 'spec 02 §9 (memory < 300 MB for 100k loaded commits)',
  });
  kept.length = 0;
}

async function suiteStatus(): Promise<void> {
  console.log(`\n[status] files-100k fixture (${SIZES.files.toLocaleString()} tracked files)`);
  const f = fixture('files-100k', { files: SIZES.files });
  const svc = await open(f.path);
  // restore a clean, fsmonitor-free state if a previous run was interrupted
  gitTry(f.path, 'config', '--unset-all', 'core.fsmonitor');
  git(f.path, 'reset', '-q', '--hard');
  await svc.status(); // warm the OS file cache

  const clean = await sampleMedian(5, () => svc.status());
  record({ suite: 'status', name: 'status, clean (warm)', value: clean, unit: 'ms', note: 'no fsmonitor' });

  const all = git(f.path, 'ls-files', '-z')
    .split('\0')
    .filter((p) => p.startsWith('src/'));
  const step = Math.max(1, Math.floor(all.length / 100));
  const touched = all.filter((_, i) => i % step === 0).slice(0, 100);
  try {
    for (const p of touched) fs.appendFileSync(path.join(f.path, p), 'bench edit\n');
    const dirty = await sampleMedian(3, () => svc.status());
    record({ suite: 'status', name: `status, ${touched.length} files modified`, value: dirty, unit: 'ms' });

    const queue = new OperationQueue(svc, createOpRegistry());
    const [stage] = await timeIt(() => queue.enqueue({ type: 'wip.stage', paths: touched }).done);
    record({ suite: 'status', name: `queue: wip.stage ${touched.length} files`, value: stage, unit: 'ms' });
    const [unstage] = await timeIt(() => queue.enqueue({ type: 'wip.unstage', paths: touched }).done);
    record({
      suite: 'status',
      name: `queue: wip.unstage ${touched.length} files`,
      value: unstage,
      unit: 'ms',
    });
  } finally {
    git(f.path, 'reset', '-q', '--hard');
  }

  // spec 02 §6.15.2 / §9: builtin fsmonitor daemon (Windows / macOS only) + untracked cache
  if (process.platform === 'win32' || process.platform === 'darwin') {
    try {
      git(f.path, 'config', 'core.fsmonitor', 'true');
      git(f.path, 'config', 'core.untrackedCache', 'true');
      // The app's own status runs with GIT_OPTIONAL_LOCKS=0; the background `index.refresh` op (a locking
      // status, scheduled by RepoManager) starts the daemon and writes the fsmonitor token + untracked cache.
      const q = new OperationQueue(svc, createOpRegistry());
      await q.enqueue({ type: 'index.refresh' }, { background: true }).done;
      await new Promise((r) => setTimeout(r, 1000));
      const [refresh] = await timeIt(() => q.enqueue({ type: 'index.refresh' }, { background: true }).done);
      record({ suite: 'status', name: 'queue: index.refresh (background)', value: refresh, unit: 'ms' });
      await svc.indexCachesEnabledNow(); // status takes the untracked-cache path once the config is read
      await svc.status();
      const fsm = await sampleMedian(5, () => svc.status());
      record({
        suite: 'status',
        name: 'status, clean, fsmonitor (warm)',
        value: fsm,
        unit: 'ms',
        threshold: 200,
        source: 'spec 02 §9',
      });
    } finally {
      gitTry(f.path, 'fsmonitor--daemon', 'stop');
      gitTry(f.path, 'config', '--unset-all', 'core.fsmonitor');
      gitTry(f.path, 'config', '--unset-all', 'core.untrackedCache');
    }
  } else {
    console.log('  -- status with fsmonitor: skipped (builtin fsmonitor needs Windows or macOS)');
  }
}

async function suiteRefs(): Promise<void> {
  console.log(`\n[refs] branches-5k fixture (${SIZES.branches.toLocaleString()} local + remote branches)`);
  const f = fixture('branches-5k', { branches: SIZES.branches });
  const svc = await open(f.path);
  // like the app: every notification refreshes refs (the renderer's `refs` query)
  const t0 = now();
  let notifications = 0;
  const refreshes: Promise<unknown>[] = [];
  const firstChunk = new Promise<number>((resolve) => {
    svc.onTrackUpdated(() => {
      if (!notifications++) resolve(now() - t0);
      refreshes.push(svc.refs());
    });
  });
  const [cold, first] = await timeIt(() => svc.refs());
  const count = first.length;
  const pending = first.filter((r) => r.upstream?.trackPending).length;
  record({
    suite: 'refs',
    name: `refs() first call — ${count.toLocaleString()} refs`,
    value: cold,
    unit: 'ms',
    threshold: 500,
    source: 'inferred (spec 02 §6.15.5 split track call; spec 04 §8 ≈50 ms per 10k refs w/o track)',
    note: `${pending} branches with ahead/behind pending (computed in the background)`,
  });
  record({
    suite: 'refs',
    name: 'refs: background ahead/behind, first chunk',
    value: await firstChunk,
    unit: 'ms',
    note: 'informational: progressive pass, newest branches first (spec 02 §6.15.5)',
  });
  await svc.whenTrackIdle();
  const complete = now() - t0;
  await Promise.all(refreshes);
  record({
    suite: 'refs',
    name: 'refs: background ahead/behind, all branches',
    value: complete,
    unit: 'ms',
    note: `informational: ${notifications} notifications → refs refreshes while it ran`,
  });
  const refsMs = await sampleMedian(5, () => svc.refs());
  record({
    suite: 'refs',
    name: `refs() — ${count.toLocaleString()} refs, local ahead/behind (cached)`,
    value: refsMs,
    unit: 'ms',
    threshold: 500,
    source: 'inferred (spec 02 §6.15.5 split track call; spec 04 §8 ≈50 ms per 10k refs w/o track)',
  });
  const noTrack = await sampleMedian(3, () =>
    svc.runRead([
      'for-each-ref',
      '--format=%(refname)%00%(objectname)',
      'refs/heads',
      'refs/remotes',
      'refs/tags',
    ]),
  );
  record({ suite: 'refs', name: 'for-each-ref, all refs, no ahead/behind', value: noTrack, unit: 'ms' });
  const pages = await logPages(svc, TOPO, 3);
  record({
    suite: 'refs',
    name: 'first 500 with all branch tips',
    value: pages.first,
    unit: 'ms',
    threshold: 300,
    source: 'spec 02 §6.15.4',
  });
}

/** packages/graph layout/render benchmarks (GRAPH_BENCH=1 → strict ceilings, 1M case enabled). */
function suiteGraph(): void {
  console.log('\n[graph] packages/graph layout benchmarks (GRAPH_BENCH=1)');
  const graphDir = path.join(repoRoot, 'packages', 'graph');
  const req = createRequire(path.join(graphDir, 'package.json'));
  const vitest = path.join(path.dirname(req.resolve('vitest/package.json')), 'vitest.mjs');
  const t0 = now();
  const r = spawnSync(process.execPath, [vitest, 'run', 'test/perf.test.ts', '--disableConsoleIntercept'], {
    cwd: graphDir,
    env: { ...process.env, GRAPH_BENCH: '1', FORCE_COLOR: '0', NO_COLOR: '1' },
    encoding: 'utf8',
    maxBuffer: 64 * 2 ** 20,
    windowsHide: true,
  });
  const out = `${r.stdout}\n${r.stderr}`;
  for (const line of out.split('\n').filter((l) => l.includes('[bench]'))) console.log(`     ${line.trim()}`);
  record({
    suite: 'graph',
    name: 'packages/graph perf.test.ts (GRAPH_BENCH=1)',
    value: r.status === 0 ? 1 : 0,
    unit: 'pass',
    ok: r.status === 0,
    source: 'packages/graph/test/perf.test.ts ceilings (spec 04 §7 step 26, §9)',
    note: out
      .split('\n')
      .filter((l) => l.includes('[bench]'))
      .map((l) => l.trim())
      .join(' | '),
  });
  if (r.status !== 0) console.log(out.split('\n').slice(-40).join('\n'));
  console.log(`     (${((now() - t0) / 1000).toFixed(1)} s)`);
}

// ---- main ----

async function main(): Promise<void> {
  fs.mkdirSync(cacheRoot, { recursive: true });
  console.log(
    `GitHappens git benchmarks — ${gitVersion} [${engine.label}], node ${process.version}, ${os.platform()} ${os.arch()}`,
  );
  console.log(`  cpus: ${os.cpus().length} × ${os.cpus()[0]?.model ?? '?'}; fixtures: ${cacheRoot}`);
  console.log(`  suites: ${[...only].join(', ')}${strict ? ' (BENCH_STRICT)' : ''}`);
  const t0 = now();
  try {
    if (only.has('log')) await suiteLog();
    if (only.has('million')) await suiteMillion();
    if (only.has('status')) await suiteStatus();
    if (only.has('refs')) await suiteRefs();
    if (only.has('graph')) suiteGraph();
  } finally {
    for (const s of services) s.dispose();
    runner.killAll();
  }

  const failed = results.filter((r) => r.ok === false);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(
    outFile,
    JSON.stringify(
      {
        date: new Date().toISOString(),
        git: gitVersion,
        engine: engine.label,
        fixtureGit: fixtureGitVersion,
        node: process.version,
        platform: `${os.platform()}-${os.arch()}`,
        cpu: os.cpus()[0]?.model,
        cpus: os.cpus().length,
        sizes: SIZES,
        strict,
        durationMs: Math.round(now() - t0),
        results,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`\n${results.length} measurements, ${failed.length} over threshold → ${outFile}`);
  for (const r of failed)
    console.log(`  !! ${r.name}: ${fmt(r.value)} ${r.unit} > ${r.threshold} (${r.source ?? ''})`);
  if (failed.length && strict) process.exitCode = 1;
  else if (failed.length) console.log('  (warning only — set BENCH_STRICT=1 to fail)');
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
