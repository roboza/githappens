import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  createExtrasRegistry,
  createOpRegistry,
  createUndoOps,
  findOnPath,
  GitProcessRunner,
  type CommitIdentity,
  type GitOperation,
} from '@githappens/git';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OpBehaviour } from '../src/main/behaviour/op-behaviour';
import { RepoManager } from '../src/main/services/repo-manager';
import { ShellStateStore } from '../src/main/services/shell-state';
import { SettingsStore } from '../src/main/settings/settings-store';
import { defaultValues, type SettingKey, type SettingsValues } from '../src/shared/settings/registry';

const gitPath = findOnPath('git');
const d = gitPath ? describe : describe.skip;

let root = '';
let env: NodeJS.ProcessEnv = {};

function git(cwd: string, ...args: string[]): string {
  return execFileSync(gitPath!, args, { cwd, env, windowsHide: true, stdio: 'pipe' }).toString('utf8');
}

function initRepo(dir: string, bare = false): string {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '--initial-branch=main', ...(bare ? ['--bare'] : []));
  if (!bare) {
    git(dir, 'config', 'user.name', 'Test User');
    git(dir, 'config', 'user.email', 'test@example.com');
    git(dir, 'config', 'commit.gpgsign', 'false');
    git(dir, 'config', 'core.autocrlf', 'false');
  }
  return dir;
}

function commit(dir: string, message: string, files: Record<string, string> = {}): string {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--allow-empty', '-m', message);
  return git(dir, 'rev-parse', 'HEAD').trim();
}

let seq = 0;
const fresh = (name: string): string => path.join(root, `${++seq}-${name}`);

function settingsWith(over: Partial<SettingsValues> = {}) {
  const values = { ...defaultValues(), ...over } as SettingsValues;
  return <K extends SettingKey>(k: K) => values[k];
}

function manager(over: Partial<SettingsValues> = {}, identity?: () => CommitIdentity | null) {
  const runner = new GitProcessRunner({
    context: () => ({ gitPath: gitPath!, baseEnv: env, bundled: false }),
  });
  const behaviour = new OpBehaviour({
    settings: settingsWith(over),
    runOp: (id, op, bg) => repos.runOp(id, op, bg),
  });
  const repos: RepoManager = new RepoManager({
    runner: () => runner,
    features: () => undefined,
    watcherBackend: null,
    onChanged: () => undefined,
    registry: (journal) => ({ ...createOpRegistry(), ...createExtrasRegistry(), ...createUndoOps(journal) }),
    behaviour,
    identity,
  });
  return repos;
}

const managers: RepoManager[] = [];
async function open(dir: string, over: Partial<SettingsValues> = {}, identity?: () => CommitIdentity | null) {
  const repos = manager(over, identity);
  managers.push(repos);
  const info = await repos.open(dir);
  return { repos, id: info.id, run: (op: GitOperation) => repos.runOp(info.id, op) };
}

beforeAll(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-behaviour-')));
  const globalConfig = path.join(root, '.gitconfig');
  fs.writeFileSync(globalConfig, '');
  env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_TERMINAL_PROMPT: '0',
    GIT_EDITOR: 'true',
    GIT_MERGE_AUTOEDIT: 'no',
    LC_MESSAGES: 'C',
    // file:// submodules (git ≥ 2.38.1)
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'protocol.file.allow',
    GIT_CONFIG_VALUE_0: 'always',
  };
  delete env.LC_ALL;
});

afterAll(async () => {
  for (const m of managers) await m.disposeAll();
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    /* Windows may hold handles briefly */
  }
});

d('settings-driven op behaviour (OpBehaviour + RepoManager)', () => {
  it('git.pushFollowTags pushes annotated tags with the branch', async () => {
    for (const followTags of [false, true]) {
      const remote = initRepo(fresh('remote.git'), true);
      const local = initRepo(fresh('local'));
      commit(local, 'One', { 'a.txt': '1\n' });
      git(local, 'remote', 'add', 'origin', pathToFileURL(remote).href);
      git(local, 'tag', '-a', 'v1', '-m', 'release 1');
      const { run } = await open(local, { 'git.pushFollowTags': followTags });
      await run({
        type: 'push',
        localRef: 'main',
        remote: 'origin',
        remoteBranch: 'main',
        setUpstream: true,
      });
      const tags = git(remote, 'tag', '--list').trim();
      expect(tags, `followTags=${followTags}`).toBe(followTags ? 'v1' : '');
    }
  });

  it('git.pullRebaseMerges rewrites rebase pulls to --rebase-merges', async () => {
    const b = new OpBehaviour({
      settings: settingsWith({ 'git.pullRebaseMerges': true }),
      runOp: async () => ({ opId: '' }),
    });
    const fake = { revParse: async () => 'x', repo: { worktreeRoot: null } } as never;
    expect((await b.prepare(fake, { type: 'pull', strategy: 'rebase' })).op).toMatchObject({
      rebaseMerges: true,
    });
    expect((await b.prepare(fake, { type: 'pull', strategy: 'ff-only' })).op).not.toHaveProperty(
      'rebaseMerges',
    );
    expect(
      (await b.prepare(fake, { type: 'pull', strategy: 'rebase', rebaseMerges: false })).op,
    ).toMatchObject({ rebaseMerges: false });
  });

  it('a background auto-fetch is not an undo barrier; a user fetch is (spec 05)', async () => {
    const remote = initRepo(fresh('barrier.git'), true);
    const dir = initRepo(fresh('barrier'));
    commit(dir, 'Base', { 'a.txt': '1\n' });
    git(dir, 'remote', 'add', 'origin', pathToFileURL(remote).href);
    git(dir, 'push', '-q', '-u', 'origin', 'main');
    const r = await open(dir);
    await r.run({ type: 'branch.create', name: 'topic', startPoint: 'HEAD', checkout: false });
    expect(r.repos.journal(r.id).peek().undo).toBeTruthy();

    await r.repos.runOp(r.id, { type: 'fetch', remote: 'all', prune: true, background: true }, true);
    expect(r.repos.journal(r.id).peek().undo).toBeTruthy();

    await r.run({ type: 'fetch', remote: 'all', prune: true });
    expect(r.repos.journal(r.id).peek().undo).toBeUndefined();
  });

  it('general.autoUpdateSubmodules updates changed submodules after a pull', async () => {
    const lib = initRepo(fresh('lib'));
    const l1 = commit(lib, 'Lib 1', { 'lib.txt': '1\n' });
    const remote = initRepo(fresh('super.git'), true);
    const seed = initRepo(fresh('seed'));
    commit(seed, 'Super init', { 'README.md': '# super\n' });
    git(seed, 'submodule', 'add', '-q', pathToFileURL(lib).href, 'lib');
    commit(seed, 'Add lib');
    git(seed, 'remote', 'add', 'origin', pathToFileURL(remote).href);
    git(seed, 'push', '-q', '-u', 'origin', 'main');

    const clone = (name: string): string => {
      const dir = fresh(name);
      git(root, 'clone', '-q', '--recurse-submodules', pathToFileURL(remote).href, dir);
      git(dir, 'config', 'user.name', 'Test User');
      git(dir, 'config', 'user.email', 'test@example.com');
      return dir;
    };
    const on = clone('with-update');
    const off = clone('without-update');
    expect(git(path.join(on, 'lib'), 'rev-parse', 'HEAD').trim()).toBe(l1);

    // bump the gitlink upstream
    const l2 = commit(lib, 'Lib 2', { 'lib.txt': '2\n' });
    git(path.join(seed, 'lib'), 'pull', '-q', 'origin', 'main');
    commit(seed, 'Bump lib');
    git(seed, 'push', '-q', 'origin', 'main');

    const a = await open(on, { 'general.autoUpdateSubmodules': true });
    const ra = await a.run({ type: 'pull', strategy: 'ff-only' });
    expect(ra.summary).toMatch(/updated submodules/);
    expect(git(path.join(on, 'lib'), 'rev-parse', 'HEAD').trim()).toBe(l2);

    const b = await open(off, { 'general.autoUpdateSubmodules': false });
    await b.run({ type: 'pull', strategy: 'ff-only' });
    expect(git(path.join(off, 'lib'), 'rev-parse', 'HEAD').trim()).toBe(l1);
  }, 180_000); // two recursive clones + pushes: slow when the whole monorepo tests at once

  it('checkout.autoPopStash re-applies the autostash after checkout', async () => {
    for (const autoPop of [true, false]) {
      const dir = initRepo(fresh('pop'));
      commit(dir, 'Base', { 'a.txt': 'a\n', 'b.txt': 'b\n' });
      git(dir, 'branch', 'other');
      commit(dir, 'Main only', { 'a.txt': 'a main\n' });
      fs.writeFileSync(path.join(dir, 'b.txt'), 'b edited\n');
      const { run } = await open(dir, { 'checkout.autoPopStash': autoPop });
      const r = await run({
        type: 'checkout.run',
        target: { kind: 'branch', name: 'other' },
        dirtyStrategy: 'stash',
      });
      const data = r.data as { stashSha?: string; stashPopped?: boolean };
      expect(data.stashSha).toBeTruthy();
      expect(git(dir, 'branch', '--show-current').trim()).toBe('other');
      if (autoPop) {
        expect(data.stashPopped).toBe(true);
        expect(fs.readFileSync(path.join(dir, 'b.txt'), 'utf8')).toBe('b edited\n');
        expect(git(dir, 'stash', 'list').trim()).toBe('');
      } else {
        expect(data.stashPopped).toBeUndefined();
        expect(fs.readFileSync(path.join(dir, 'b.txt'), 'utf8')).toBe('b\n');
        expect(git(dir, 'stash', 'list').trim()).not.toBe('');
      }
    }
  });

  it('general.deleteOrigFiles removes .orig backups once a conflict is resolved', async () => {
    for (const del of [true, false]) {
      const dir = initRepo(fresh('orig'));
      commit(dir, 'Base', { 'f.txt': 'base\n' });
      git(dir, 'switch', '-q', '-c', 'theirs');
      commit(dir, 'Theirs', { 'f.txt': 'theirs\n' });
      git(dir, 'switch', '-q', 'main');
      commit(dir, 'Ours', { 'f.txt': 'ours\n' });
      try {
        git(dir, 'merge', 'theirs');
      } catch {
        /* conflict expected */
      }
      fs.writeFileSync(path.join(dir, 'f.txt.orig'), 'backup from a merge tool\n');
      const { run } = await open(dir, { 'general.deleteOrigFiles': del });
      await run({ type: 'conflict.take', paths: ['f.txt'], side: 'ours' });
      expect(fs.existsSync(path.join(dir, 'f.txt.orig')), `delete=${del}`).toBe(!del);
    }
  });

  it('commits use the profile identity unless the repository sets its own', async () => {
    const dir = initRepo(fresh('identity'));
    commit(dir, 'Base', { 'a.txt': 'a\n' });
    const profile = { name: 'Profile Person', email: 'profile@example.com' };
    const { run } = await open(dir, {}, () => profile);
    const op = (summary: string): GitOperation => ({
      type: 'commit.create',
      summary,
      description: '',
      coAuthors: [],
      amend: false,
      skipHooks: true,
      allowEmpty: true,
      sign: 'off',
      cleanup: 'strip',
    });
    // repo-local identity (set by initRepo) wins
    await run(op('local'));
    expect(git(dir, 'log', '-1', '--format=%an <%ae>').trim()).toBe('Test User <test@example.com>');
    git(dir, 'config', '--unset', 'user.name');
    git(dir, 'config', '--unset', 'user.email');
    await run(op('profile'));
    expect(git(dir, 'log', '-1', '--format=%an <%ae>|%cn').trim()).toBe(
      'Profile Person <profile@example.com>|Profile Person',
    );
  });
});

describe('settings migration and tab restore', () => {
  it('moves a stored general.conflictDetection to conflicts.detectTarget', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-settings-'));
    try {
      const s1 = new SettingsStore({ dir });
      s1.load();
      const file = path.join(dir, 'profiles', s1.activeProfile.id, 'settings.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ version: 1, values: { 'general.conflictDetection': false } }));
      const s2 = new SettingsStore({ dir });
      s2.load();
      expect(s2.get('conflicts.detectTarget')).toBe(false);
      // an explicit value for the new key wins
      fs.writeFileSync(
        file,
        JSON.stringify({
          version: 1,
          values: { 'general.conflictDetection': false, 'conflicts.detectTarget': true },
        }),
      );
      const s3 = new SettingsStore({ dir });
      s3.load();
      expect(s3.get('conflicts.detectTarget')).toBe(true);
      s3.set('ui.zoom', 1.1);
      expect(fs.readFileSync(file, 'utf8')).not.toContain('general.conflictDetection');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('general.rememberTabs=false restores no repository tabs', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-tabs-'));
    try {
      const state = {
        tabs: [
          { id: 'launchpad', kind: 'launchpad' as const },
          { id: 'r1', kind: 'repo' as const, repoPath: '/x' },
          { id: 'n1', kind: 'newTab' as const },
        ],
        activeTabId: 'r1',
      };
      new ShellStateStore(dir).saveTabs(state);
      expect(new ShellStateStore(dir, () => true).tabs().tabs.map((t) => t.id)).toEqual([
        'launchpad',
        'r1',
        'n1',
      ]);
      const off = new ShellStateStore(dir, () => false).tabs();
      expect(off.tabs.map((t) => t.id)).toEqual(['launchpad', 'n1']);
      expect(off.activeTabId).toBe('launchpad');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
