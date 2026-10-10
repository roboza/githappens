import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { findOnPath, GitProcessRunner } from '@githappens/git';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { normalizeRemoteUrl } from '../src/main/workspaces/util';
import {
  globToRegExp,
  makeIgnore,
  parseCodeWorkspace,
  scanForRepos,
} from '../src/main/workspaces/directory-scan';
import { parseTrack, WorkspaceStatus } from '../src/main/workspaces/workspace-status';
import { WorkspaceService, type WorkspaceServiceDeps } from '../src/main/workspaces/workspace-service';
import type { WorkspacesEventContract } from '../src/shared/ipc/workspaces-contract';

// Real git on PATH, isolated from the user's config.
const gitPath = findOnPath('git');
const d = gitPath ? describe : describe.skip;

describe('pure helpers', () => {
  it('normalizes remote URLs across protocols', () => {
    const want = 'github.com/acme/api';
    for (const u of [
      'https://github.com/acme/api.git',
      'https://user@github.com/acme/api/',
      'git@github.com:acme/api.git',
      'ssh://git@github.com:22/acme/api.git',
      'ssh://git@GitHub.com/acme/API',
    ]) {
      expect(normalizeRemoteUrl(u)).toBe(want);
    }
    expect(normalizeRemoteUrl('https://github.com/acme/web.git')).not.toBe(want);
  });

  it('matches ignore globs against names and relative paths', () => {
    expect(globToRegExp('node_modules').test('node_modules')).toBe(true);
    expect(globToRegExp('*.tmp').test('a.tmp')).toBe(true);
    expect(globToRegExp('**/build').test('x/y/build')).toBe(true);
    const ignored = makeIgnore(['node_modules', 'vendor/*', '.cache']);
    expect(ignored('node_modules')).toBe(true);
    expect(ignored('a/node_modules')).toBe(true);
    expect(ignored('a/vendor/lib')).toBe(true);
    expect(ignored('a/vendor')).toBe(false);
    expect(ignored('src')).toBe(false);
  });

  it('parses upstream track strings', () => {
    expect(parseTrack('[ahead 2, behind 3]', 'origin/main')).toEqual({
      upstream: 'origin/main',
      ahead: 2,
      behind: 3,
      gone: false,
    });
    expect(parseTrack('[gone]', 'origin/x').gone).toBe(true);
    expect(parseTrack('')).toEqual({ ahead: 0, behind: 0, gone: false });
  });

  it('parses .code-workspace JSONC', () => {
    const file = path.join(os.tmpdir(), 'proj', 'acme.code-workspace');
    const folders = parseCodeWorkspace(
      `{
        // comment
        "folders": [
          { "path": "api" },
          { "name": "Web", "path": "../web", },
          { "uri": "vscode-remote://ssh-remote+box/home/x" },
        ],
        "settings": {},
      }`,
      file,
    );
    expect(folders.map((f) => f.path)).toEqual([
      path.resolve(path.dirname(file), 'api'),
      path.resolve(path.dirname(file), '../web'),
      null,
    ]);
    expect(folders[1]!.name).toBe('Web');
    expect(() => parseCodeWorkspace('{"settings": {}}', file)).toThrow(/folders/);
  });
});

d('workspaces against real git', () => {
  let root: string;
  let env: NodeJS.ProcessEnv;
  let runner: GitProcessRunner;

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync(gitPath!, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (p: string, text: string): void => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  };
  const initRepo = (p: string): string => {
    fs.mkdirSync(p, { recursive: true });
    git(p, 'init', '-q', '-b', 'main');
    write(path.join(p, 'README.md'), 'hi\n');
    git(p, 'add', '.');
    git(p, 'commit', '-q', '-m', 'init');
    return p;
  };

  beforeAll(() => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-ws-git-')));
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, '.gitconfig'), '');
    env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@example.com',
      GIT_TERMINAL_PROMPT: '0',
    };
    runner = new GitProcessRunner({
      context: () => ({ gitPath: gitPath!, baseEnv: env, bundled: false }),
    });
  });
  afterAll(() => {
    runner.killAll();
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      /* Windows may hold handles briefly */
    }
  });

  it('scans a directory to depth, skipping ignored folders and nested repos', async () => {
    const base = path.join(root, 'scan');
    initRepo(path.join(base, 'a'));
    initRepo(path.join(base, 'group', 'b'));
    initRepo(path.join(base, 'group', 'deep', 'c')); // depth 3
    initRepo(path.join(base, 'node_modules', 'pkg'));
    initRepo(path.join(base, 'a', 'nested'));
    fs.mkdirSync(path.join(base, 'plain'));

    const r = await scanForRepos({ root: base, depth: 2, ignore: ['node_modules'] });
    expect(r.truncated).toBe(false);
    expect(r.paths.map((p) => path.relative(base, p)).sort()).toEqual(['a', path.join('group', 'b')]);

    const deep = await scanForRepos({ root: base, depth: 3, ignore: ['node_modules'], includeNested: true });
    expect(deep.paths.map((p) => path.relative(base, p)).sort()).toEqual(
      ['a', path.join('a', 'nested'), path.join('group', 'b'), path.join('group', 'deep', 'c')].sort(),
    );

    const capped = await scanForRepos({ root: base, depth: 3, ignore: [], cap: 2 });
    expect(capped.paths).toHaveLength(2);
    expect(capped.truncated).toBe(true);
  });

  it('summarizes repos in mixed states', async () => {
    const base = path.join(root, 'status');
    const bare = path.join(base, 'remote.git');
    fs.mkdirSync(bare, { recursive: true });
    git(bare, 'init', '-q', '--bare', '-b', 'main');

    const clean = initRepo(path.join(base, 'clean'));

    const dirty = initRepo(path.join(base, 'dirty'));
    write(path.join(dirty, 'README.md'), 'changed\n');
    write(path.join(dirty, 'staged.txt'), 's\n');
    git(dirty, 'add', 'staged.txt');
    write(path.join(dirty, 'new.txt'), 'u\n');
    write(path.join(dirty, 'stash.txt'), 'x\n');
    git(dirty, 'stash', 'push', '-q', '-u', '--', 'stash.txt');

    // ahead 1 / behind 1 against a local bare remote
    const tracking = initRepo(path.join(base, 'tracking'));
    git(tracking, 'remote', 'add', 'origin', bare);
    git(tracking, 'push', '-q', '-u', 'origin', 'main');
    const other = path.join(base, 'other');
    git(base, 'clone', '-q', bare, other);
    write(path.join(other, 'o.txt'), 'o\n');
    git(other, 'add', '.');
    git(other, 'commit', '-q', '-m', 'other');
    git(other, 'push', '-q');
    write(path.join(tracking, 't.txt'), 't\n');
    git(tracking, 'add', '.');
    git(tracking, 'commit', '-q', '-m', 'local');
    git(tracking, 'fetch', '-q');

    // merge in progress with a conflict
    const merging = initRepo(path.join(base, 'merging'));
    git(merging, 'checkout', '-q', '-b', 'side');
    write(path.join(merging, 'README.md'), 'side\n');
    git(merging, 'commit', '-q', '-am', 'side');
    git(merging, 'checkout', '-q', 'main');
    write(path.join(merging, 'README.md'), 'main\n');
    git(merging, 'commit', '-q', '-am', 'main');
    try {
      git(merging, 'merge', 'side');
    } catch {
      /* conflict expected */
    }

    const notRepo = path.join(base, 'not-a-repo');
    fs.mkdirSync(notRepo);

    const status = new WorkspaceStatus(() => runner);
    const repos = [
      { id: 'clean', localPath: clean },
      { id: 'dirty', localPath: dirty },
      { id: 'tracking', localPath: tracking },
      { id: 'merging', localPath: merging },
      { id: 'missing', localPath: path.join(base, 'gone') },
      { id: 'notRepo', localPath: notRepo },
      { id: 'uncloned' },
    ].map((r) => ({ ...r, name: r.id, addedAt: '' }));
    const s = Object.fromEntries((await status.forRepos(repos)).map((x) => [x.workspaceRepoId, x]));

    expect(s.clean).toMatchObject({
      exists: true,
      isRepo: true,
      head: { branch: 'main', detached: false },
      ahead: 0,
      behind: 0,
      wip: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
      stashCount: 0,
    });
    expect(s.clean!.lastFetchAt).toBeUndefined();
    expect(s.dirty).toMatchObject({
      wip: { staged: 1, unstaged: 1, untracked: 1, conflicted: 0 },
      stashCount: 1,
    });
    expect(s.tracking).toMatchObject({ upstream: 'origin/main', ahead: 1, behind: 1 });
    expect(s.tracking!.lastFetchAt).toMatch(/^\d{4}-/);
    expect(s.merging).toMatchObject({ operationInProgress: 'merge', wip: { conflicted: 1 } });
    expect(s.missing).toMatchObject({ exists: false, isRepo: false, error: 'Folder not found' });
    expect(s.notRepo).toMatchObject({ exists: true, isRepo: false });
    expect(s.uncloned).toMatchObject({ exists: false, isRepo: false });
    expect(s.uncloned!.localPath).toBeUndefined();

    // cached by realpath until invalidated
    write(path.join(clean, 'x.txt'), 'x\n');
    expect((await status.forPath(clean)).wip.untracked).toBe(0);
    expect((await status.forPath(clean, true)).wip.untracked).toBe(1);

    const details = await status.details(tracking);
    expect(details.branches).toEqual([
      { name: 'main', current: true, upstream: 'origin/main', ahead: 1, behind: 1, gone: false },
    ]);
    expect(details.commits.map((c) => c.subject)).toEqual(['local', 'init']);
  });

  it('directory sync watcher picks up a newly cloned repo within 5 s', async () => {
    const base = path.join(root, 'watch');
    const dir = path.join(base, 'code');
    initRepo(path.join(dir, 'first'));
    fs.mkdirSync(path.join(dir, 'team'));
    const synced: string[][] = [];
    const svc = new WorkspaceService({
      profileDir: () => path.join(base, 'profile'),
      runner: () => runner,
      openRepo: async () => 'id',
      closeRepo: async () => undefined,
      runOp: async () => undefined,
      clone: async () => ({ path: '' }),
      bulkConcurrency: () => 4,
      scanDepth: () => 2,
      emit: (event, payload) => {
        const sync =
          event === 'workspace:changed' && (payload as WorkspacesEventContract['workspace:changed']).sync;
        if (sync) synced.push(sync.added);
      },
    });
    try {
      const ws = await svc.create({
        kind: 'directory',
        name: 'Watched',
        directory: { root: dir, depth: 2, includeNested: false, ignore: [] },
      });
      svc.start();
      await new Promise((r) => setTimeout(r, 500)); // initial scan arms the watchers
      git(dir, 'clone', '-q', path.join(dir, 'first'), path.join(dir, 'team', 'second'));
      const t0 = Date.now();
      while (Date.now() - t0 < 5000 && svc.store.get(ws.id).repos.length < 2) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(
        svc.store
          .get(ws.id)
          .repos.map((r) => r.name)
          .sort(),
      ).toEqual(['first', 'second']);
      expect(synced).toContainEqual(['second']);
    } finally {
      svc.dispose();
    }
  });

  describe('WorkspaceService', () => {
    const events: Array<{ event: string; payload: unknown }> = [];
    let svc: WorkspaceService;
    let base: string;

    beforeAll(() => {
      base = path.join(root, 'svc');
      fs.mkdirSync(base, { recursive: true });
      const deps: WorkspaceServiceDeps = {
        profileDir: () => path.join(base, 'profile'),
        runner: () => runner,
        openRepo: async () => 'id',
        closeRepo: async () => undefined,
        runOp: async () => undefined,
        clone: async () => ({ path: '' }),
        bulkConcurrency: () => 4,
        scanDepth: () => 2,
        emit: <E extends keyof WorkspacesEventContract>(event: E, payload: WorkspacesEventContract[E]) =>
          void events.push({ event, payload }),
        watchDirectories: false,
      };
      svc = new WorkspaceService(deps);
    });
    afterAll(() => svc.dispose());

    it('imports a .code-workspace keeping exactly the referenced git repos', async () => {
      const api = initRepo(path.join(base, 'cw', 'api'));
      initRepo(path.join(base, 'cw', 'web'));
      fs.mkdirSync(path.join(base, 'cw', 'api', 'src'), { recursive: true });
      fs.mkdirSync(path.join(base, 'cw', 'docs'));
      git(api, 'remote', 'add', 'origin', 'https://github.com/acme/api.git');
      const file = path.join(base, 'cw', 'acme.code-workspace');
      fs.writeFileSync(
        file,
        `{ "folders": [
            { "path": "api" },
            { "path": "api/src" },   // inside api -> same repo
            { "name": "Website", "path": "web" },
            { "path": "docs" },
            { "path": "missing" },
            { "uri": "vscode-remote://wsl+Ubuntu/home/me/x" },
          ] }`,
      );
      const r = await svc.importCodeWorkspace(file);
      expect(r!.workspace.name).toBe('acme');
      expect(r!.workspace.repos.map((x) => x.name)).toEqual(['api', 'Website']);
      expect(r!.workspace.repos[0]!.remoteUrl).toBe('https://github.com/acme/api.git');
      expect(r!.skipped.map((x) => x.reason)).toEqual([
        'Not in a git repository',
        'Folder not found',
        'Remote folder',
      ]);
    });

    it('creates directory-synced workspaces and picks up new repos on refresh', async () => {
      const dir = path.join(base, 'synced');
      initRepo(path.join(dir, 'one'));
      const ws = await svc.create({
        kind: 'directory',
        name: 'Synced',
        directory: { root: dir, depth: 2, includeNested: false, ignore: [] },
      });
      expect(ws.repos.map((r) => r.name)).toEqual(['one']);
      initRepo(path.join(dir, 'two'));
      fs.rmSync(path.join(dir, 'one'), { recursive: true, force: true });
      events.length = 0;
      const summaries = await svc.statusOf(ws.id, true);
      expect(svc.store.get(ws.id).repos.map((r) => r.name)).toEqual(['two']);
      expect(summaries).toHaveLength(1);
      const changed = events.find(
        (e) => e.event === 'workspace:changed' && (e.payload as { sync?: unknown }).sync,
      );
      expect((changed!.payload as WorkspacesEventContract['workspace:changed']).sync).toMatchObject({
        added: ['two'],
        removed: ['one'],
      });
      expect(events.some((e) => e.event === 'workspace:statusUpdated')).toBe(true);
    });

    it('locates repos, warning on remote mismatch', async () => {
      const provider = {
        integrationKey: 'github:github.com:1',
        owner: 'acme',
        name: 'lib',
        cloneUrlHttps: 'https://github.com/acme/lib.git',
        cloneUrlSsh: 'git@github.com:acme/lib.git',
        webUrl: 'https://github.com/acme/lib',
      };
      const ws = await svc.create({ kind: 'cloud', name: 'Provider', repos: [{ provider }] });
      const repoId = ws.repos[0]!.id;
      const wrong = initRepo(path.join(base, 'loc', 'wrong'));
      git(wrong, 'remote', 'add', 'origin', 'https://github.com/acme/other.git');
      const right = initRepo(path.join(base, 'loc', 'right'));
      git(right, 'remote', 'add', 'origin', 'git@github.com:acme/lib.git');

      const miss = await svc.locate(ws.id, repoId, wrong);
      expect(miss.mismatch).toEqual({
        expected: provider.cloneUrlHttps,
        actual: ['https://github.com/acme/other.git'],
      });
      expect(svc.store.get(ws.id).repos[0]!.localPath).toBeUndefined();

      const ok = await svc.locate(ws.id, repoId, path.join(right));
      expect(ok.repo!.localPath).toBe(right);
      await expect(svc.locate(ws.id, repoId, path.join(base, 'loc'))).rejects.toThrow(/not a git repository/);
    });

    it('validates added paths and builds the branch matrix', async () => {
      const a = initRepo(path.join(base, 'bm', 'a'));
      const b = initRepo(path.join(base, 'bm', 'b'));
      git(a, 'branch', 'feature/x');
      git(b, 'branch', 'feature/x');
      git(a, 'branch', 'only-a');
      const ws = await svc.create({ kind: 'local', name: 'BM', repos: [{ localPath: path.join(a) }] });
      await expect(svc.addRepos(ws.id, [{ localPath: path.join(base, 'bm') }])).rejects.toThrow(/Not a git/);
      const after = await svc.addRepos(ws.id, [{ localPath: b }, { localPath: a }]);
      expect(after.repos.map((r) => r.name)).toEqual(['a', 'b']);
      const m = await svc.branches(ws.id);
      expect(m.rows.map((r) => r.branch)).toEqual(['feature/x', 'main']);
      expect(Object.values(m.rows[0]!.cells).every((c) => c && c.ahead === 0)).toBe(true);
      expect(svc.openAll(ws.id).paths).toEqual([a, b]);
    });

    it('exports and re-imports JSON', async () => {
      const ws = svc.store.list()[0]!;
      const out = path.join(base, 'export.json');
      expect(await svc.exportJson(ws.id, out)).toEqual({ path: out });
      const imported = await svc.importJson(out);
      expect(imported).toHaveLength(1);
      expect(imported![0]!.name).toBe(ws.name);
      expect(imported![0]!.id).not.toBe(ws.id);
    });
  });
});
