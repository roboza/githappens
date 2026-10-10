import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { hugeHistory, hugeMillion, manyBranches, manyFiles } from './perf';
import { Clock, gitBinary, isolatedEnv, Repo } from './repo';

export interface FixtureContext {
  /** Directory the fixture is created in (must not exist or be empty). */
  dir: string;
  /** Scratch root for helper repos (submodule sources, remotes). */
  root: string;
  env: NodeJS.ProcessEnv;
  clock: Clock;
  options: Record<string, string | number | boolean>;
}

export interface FixtureResult {
  /** Path to open in the app / run GitService against. */
  path: string;
  /** Free-form facts tests can assert on. */
  facts: Record<string, unknown>;
}

export class SkipFixture extends Error {}

type Generator = (ctx: FixtureContext) => FixtureResult;

const lines = (n: number, prefix = 'line'): string =>
  Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n') + '\n';

// ---------------------------------------------------------------------------

/** 100 commits on main by rotating authors. */
const linear: Generator = ({ dir, env, clock, options }) => {
  const count = Number(options.count ?? 100);
  const r = Repo.init(dir, env, clock);
  const authors = ['alice', 'bob', 'carol'] as const;
  for (let i = 1; i <= count; i++) {
    r.commit(
      `Commit ${i}`,
      { 'README.md': `# Linear\n\nrevision ${i}\n`, [`src/file${i % 10}.txt`]: `v${i}\n` },
      authors[i % 3],
    );
  }
  const tagBack = Math.floor(count / 2);
  r.git('tag', 'v1.0', `HEAD~${tagBack}`);
  return { path: dir, facts: { commits: count, head: r.head(), tagBack } };
};

/** Feature branches, --no-ff merges, an octopus merge, a criss-cross merge, tags and a stash. */
const branchy: Generator = ({ dir, env, clock }) => {
  const r = Repo.init(dir, env, clock);
  r.commit('Initial commit', { 'README.md': '# Branchy\n', 'app.txt': lines(10) });
  r.commit('Add config', { 'config.json': '{ "a": 1 }\n' }, 'bob');

  // feature-a: merged with --no-ff
  r.checkout('feature-a', true);
  r.commit('feature-a: part 1', { 'a.txt': 'a1\n' });
  r.commit('feature-a: part 2', { 'a.txt': 'a1\na2\n' });
  r.checkout('main');
  r.commit('Main moves on', { 'main.txt': 'm1\n' }, 'carol');
  r.gitAs('alice', 'merge', '--no-ff', '-q', '-m', "Merge branch 'feature-a'", 'feature-a');

  // octopus: three topic branches merged at once
  const base = r.head();
  for (const t of ['topic-1', 'topic-2', 'topic-3']) {
    r.git('checkout', '-q', '-b', t, base);
    r.commit(`${t}: work`, { [`${t}.txt`]: `${t}\n` }, 'bob');
  }
  r.checkout('main');
  r.gitAs('alice', 'merge', '--no-ff', '-q', '-m', 'Octopus merge topics', 'topic-1', 'topic-2', 'topic-3');
  r.git('tag', '-a', 'v1.0', '-m', 'Release 1.0');

  // criss-cross: x and y merge each other
  const cc = r.head();
  r.git('checkout', '-q', '-b', 'cross-x', cc);
  r.commit('cross-x: 1', { 'x.txt': 'x1\n' });
  r.git('checkout', '-q', '-b', 'cross-y', cc);
  r.commit('cross-y: 1', { 'y.txt': 'y1\n' }, 'carol');
  const y1 = r.head();
  r.checkout('cross-x');
  const x1 = r.head();
  r.gitAs('alice', 'merge', '--no-ff', '-q', '-m', 'Merge cross-y into cross-x', y1);
  r.checkout('cross-y');
  r.gitAs('carol', 'merge', '--no-ff', '-q', '-m', 'Merge cross-x into cross-y', x1);
  r.checkout('cross-x');
  r.commit('cross-x: 2', { 'x.txt': 'x1\nx2\n' });
  r.checkout('cross-y');
  r.commit('cross-y: 2', { 'y.txt': 'y1\ny2\n' }, 'carol');

  // unmerged feature + lightweight tag
  r.checkout('main');
  r.checkout('feature-b', true);
  r.commit('feature-b: WIP', { 'b.txt': 'b\n' }, 'bob');
  r.git('tag', 'lightweight-tag');
  r.checkout('main');

  // a stash with tracked + untracked changes
  r.write('app.txt', lines(10).replace('line 3', 'line 3 (stashed)'));
  r.write('untracked.txt', 'u\n');
  r.gitAs('alice', 'stash', 'push', '-q', '--include-untracked', '-m', 'WIP on app');

  return {
    path: dir,
    facts: {
      branches: ['main', 'feature-a', 'feature-b', 'topic-1', 'topic-2', 'topic-3', 'cross-x', 'cross-y'],
      tags: ['v1.0', 'lightweight-tag'],
      stashes: 1,
    },
  };
};

/**
 * main and feature diverge: content conflict, delete/modify, add/add and binary.
 * `options.inProgress` leaves a merge stopped on conflicts (MERGE_HEAD present).
 */
const conflict: Generator = ({ dir, env, clock, options }) => {
  const r = Repo.init(dir, env, clock);
  r.commit('Base', {
    'content.txt': lines(5),
    'delete-modify.txt': 'original\n',
    'binary.dat': Buffer.from([0, 1, 2, 3, 4, 5]),
  });
  r.checkout('feature', true);
  r.commit(
    'Feature changes',
    {
      'content.txt': lines(5).replace('line 3', 'line 3 changed on feature'),
      'delete-modify.txt': 'modified on feature\n',
      'add-add.txt': 'feature version\n',
      'binary.dat': Buffer.from([0, 1, 2, 3, 4, 5, 0xfe, 0xff]),
    },
    'bob',
  );
  r.checkout('main');
  r.remove('delete-modify.txt');
  r.commit('Main changes', {
    'content.txt': lines(5).replace('line 3', 'line 3 changed on main'),
    'add-add.txt': 'main version\n',
    'binary.dat': Buffer.from([0, 1, 2, 3, 4, 5, 0xaa]),
  });
  if (options.inProgress) {
    r.gitAsAllowFail('alice', 'merge', '--no-ff', 'feature');
  }
  return {
    path: dir,
    facts: {
      conflictedFiles: ['add-add.txt', 'binary.dat', 'content.txt', 'delete-modify.txt'],
      inProgress: Boolean(options.inProgress),
    },
  };
};

/** `git init` only: unborn branch. */
const empty: Generator = ({ dir, env, clock }) => {
  Repo.init(dir, env, clock);
  return { path: dir, facts: { unborn: true } };
};

/** A bare "remote" plus a clone that is 1 ahead / 1 behind after fetch. */
const remotePair: Generator = ({ dir, env, clock }) => {
  const remote = path.join(dir, 'remote.git');
  const local = path.join(dir, 'local');
  const other = path.join(dir, 'other');
  Repo.init(remote, env, clock, { bare: true });
  const url = pathToFileURL(remote).href;

  const seed = Repo.init(path.join(dir, 'seed'), env, clock);
  seed.commit('Seed', { 'README.md': '# Remote pair\n' });
  seed.commit('Second', { 'a.txt': 'a\n' });
  seed.git('remote', 'add', 'origin', url);
  seed.git('push', '-q', 'origin', 'main');
  fs.rmSync(seed.dir, { recursive: true, force: true });

  for (const target of [local, other]) {
    new Repo(dir, env, clock).git('clone', '-q', url, path.basename(target));
    new Repo(target, env, clock).configure();
  }
  const o = new Repo(other, env, clock);
  o.commit('Pushed by someone else', { 'remote-only.txt': 'r\n' }, 'bob');
  o.git('push', '-q', 'origin', 'main');

  const l = new Repo(local, env, clock);
  l.commit('Local only', { 'local-only.txt': 'l\n' });
  l.git('fetch', '-q', 'origin');
  return { path: local, facts: { remote, other, ahead: 1, behind: 1 } };
};

/** Bare repository on its own. */
const bare: Generator = ({ dir, env, clock }) => {
  const work = Repo.init(`${dir}.work`, env, clock);
  work.commit('One', { 'a.txt': '1\n' });
  work.commit('Two', { 'a.txt': '2\n' });
  new Repo(path.dirname(dir), env, clock).git('clone', '-q', '--bare', work.dir, path.basename(dir));
  fs.rmSync(work.dir, { recursive: true, force: true });
  return { path: dir, facts: { bare: true, commits: 2 } };
};

/** Paths with unicode, spaces, leading dash, nested non-latin dirs, CRLF and no-EOL files. */
const unicodePaths: Generator = ({ dir, env, clock }) => {
  const r = Repo.init(dir, env, clock);
  const files: Record<string, string> = {
    'ünï cødé.txt': 'unicode\n',
    '日本語/ファイル.md': '# こんにちは\n',
    'with space/a b.txt': 'spaces\n',
    '-leading-dash.txt': 'dash\n',
    'emoji-😀.txt': 'emoji\n',
    'crlf.txt': 'one\r\ntwo\r\n',
    'no-eol.txt': 'no newline at end',
  };
  r.commit('Add tricky paths', files);
  r.write('ünï cødé.txt', 'unicode changed\n');
  r.write('new 新しい.txt', 'untracked\n');
  return {
    path: dir,
    facts: { files: Object.keys(files), modified: ['ünï cødé.txt'], untracked: ['new 新しい.txt'] },
  };
};

/** Superproject with a submodule that itself has a nested submodule. */
const submodules: Generator = ({ dir, env, clock }) => {
  const leaf = Repo.init(`${dir}.leaf-src`, env, clock);
  leaf.commit('Leaf init', { 'leaf.txt': 'leaf\n' });
  const lib = Repo.init(`${dir}.lib-src`, env, clock);
  lib.commit('Lib init', { 'lib.txt': 'lib\n' });
  lib.gitAs(
    'alice',
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'add',
    '-q',
    pathToFileURL(leaf.dir).href,
    'vendor/leaf',
  );
  lib.commit('Add leaf submodule');

  const sup = Repo.init(dir, env, clock);
  sup.commit('Super init', { 'README.md': '# Super\n' });
  sup.gitAs(
    'alice',
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'add',
    '-q',
    pathToFileURL(lib.dir).href,
    'lib',
  );
  sup.git('-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive', '-q');
  sup.commit('Add lib submodule');
  // make the submodule out of sync with what the superproject records
  const libInSuper = new Repo(path.join(dir, 'lib'), env, clock);
  libInSuper.configure();
  libInSuper.commit('Local change inside submodule', { 'lib.txt': 'lib changed\n' });
  return { path: dir, facts: { submodules: ['lib', 'lib/vendor/leaf'], outOfSync: ['lib'] } };
};

/** Main worktree plus two linked worktrees (one on a branch, one detached). */
const worktrees: Generator = ({ dir, env, clock }) => {
  const r = Repo.init(path.join(dir, 'main'), env, clock);
  r.commit('Init', { 'a.txt': 'a\n' });
  r.commit('Second', { 'a.txt': 'a\nb\n' });
  r.git('worktree', 'add', '-q', '-b', 'feature', path.join(dir, 'wt-feature'));
  r.git('worktree', 'add', '-q', '--detach', path.join(dir, 'wt-detached'), 'HEAD~1');
  const wt = new Repo(path.join(dir, 'wt-feature'), env, clock);
  wt.commit('Work in worktree', { 'f.txt': 'f\n' });
  wt.write('f.txt', 'f\ndirty\n');
  return {
    path: r.dir,
    facts: { worktrees: [path.join(dir, 'wt-feature'), path.join(dir, 'wt-detached')] },
  };
};

/** Git LFS-tracked binary (requires git-lfs; skipped otherwise). */
const lfs: Generator = ({ dir, env, clock }) => {
  const r = Repo.init(dir, env, clock);
  try {
    r.git('lfs', 'install', '--local');
  } catch {
    throw new SkipFixture('git-lfs is not installed');
  }
  r.git('lfs', 'track', '*.bin');
  r.commit('Track bin with LFS', { 'asset.bin': Buffer.alloc(2048, 7), 'README.md': '# LFS\n' });
  return { path: dir, facts: { lfsFiles: ['asset.bin'] } };
};

export const FIXTURES = {
  linear,
  branchy,
  conflict,
  'conflict-in-progress': (ctx: FixtureContext) =>
    conflict({ ...ctx, options: { ...ctx.options, inProgress: true } }),
  empty,
  bare,
  'remote-pair': remotePair,
  'unicode-paths': unicodePaths,
  submodules,
  worktrees,
  huge: hugeHistory,
  'huge-1m': hugeMillion,
  'files-100k': manyFiles,
  'branches-5k': manyBranches,
  lfs,
} satisfies Record<string, Generator>;

export type FixtureName = keyof typeof FIXTURES;

export interface MakeOptions {
  /** Root directory for all fixtures (default: test/fixtures/.repos). */
  root: string;
  /** Replace an existing fixture directory. */
  force?: boolean;
  options?: FixtureContext['options'];
}

export function makeFixture(name: FixtureName, o: MakeOptions): FixtureResult {
  const dir = path.join(o.root, name);
  if (fs.existsSync(o.root)) {
    // helper repos live next to the fixture as `<name>.<suffix>`
    const owned = fs.readdirSync(o.root).filter((e) => e === name || e.startsWith(`${name}.`));
    if (owned.length && !o.force) throw new Error(`Fixture directory already exists: ${dir}`);
    for (const e of owned) fs.rmSync(path.join(o.root, e), { recursive: true, force: true });
  }
  fs.mkdirSync(o.root, { recursive: true });
  const ctx: FixtureContext = {
    dir,
    root: o.root,
    env: isolatedEnv(o.root),
    clock: new Clock(),
    options: o.options ?? {},
  };
  return FIXTURES[name](ctx);
}

export { gitBinary };
