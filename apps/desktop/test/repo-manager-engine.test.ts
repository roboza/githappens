import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createOpRegistry, findOnPath, GitProcessRunner, type OpRegistry } from '@githappens/git';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createHandlers } from '../src/main/ipc/handlers';
import { RepoManager } from '../src/main/services/repo-manager';
import type { FsEventType, WatcherBackend } from '../src/main/services/repo-watcher';

/**
 * spec 02 Phase 10 wiring in main: per-commonDir queue lanes across linked worktrees (RepoManager),
 * the config / merge-base / conflicts / worktree-status / watch-state channels, and tab activation
 * driving watcher suspension.
 */

const gitPath = findOnPath('git');
const d = gitPath ? describe : describe.skip;

let root = '';
let env: NodeJS.ProcessEnv = {};
const managers: RepoManager[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync(gitPath!, args, { cwd, env, windowsHide: true, stdio: 'pipe' }).toString('utf8');
}

function repoWithWorktree(name: string): { main: string; wt: string } {
  const main = path.join(root, name);
  fs.mkdirSync(main, { recursive: true });
  git(main, 'init', '-q', '--initial-branch=main');
  git(main, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(main, 'a.txt'), 'a\n');
  git(main, 'add', '-A');
  git(main, 'commit', '-q', '-m', 'one');
  const wt = path.join(root, `${name}-wt`);
  git(main, 'worktree', 'add', '-q', '-b', 'feature', wt);
  return { main, wt };
}

class FakeBackend implements WatcherBackend {
  readonly subs = new Map<string, (err: Error | null, e: { type: FsEventType; path: string }[]) => void>();
  async subscribe(dir: string, cb: (err: Error | null, e: { type: FsEventType; path: string }[]) => void) {
    this.subs.set(dir, cb);
    return { unsubscribe: async () => void this.subs.delete(dir) };
  }
}

function manager(
  o: {
    registry?: OpRegistry;
    backend?: WatcherBackend | null;
    suspendWatchAfterMs?: number;
    onChanged?: ConstructorParameters<typeof RepoManager>[0]['onChanged'];
  } = {},
) {
  const runner = new GitProcessRunner({
    context: () => ({ gitPath: gitPath!, baseEnv: env, bundled: false }),
  });
  const repos = new RepoManager({
    runner: () => runner,
    features: () => undefined,
    watcherBackend: o.backend ?? null,
    onChanged: o.onChanged ?? (() => undefined),
    registry: () => o.registry ?? createOpRegistry(),
    suspendWatchAfterMs: o.suspendWatchAfterMs,
  });
  managers.push(repos);
  return { repos, runner };
}

beforeAll(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-rm-engine-')));
  const globalConfig = path.join(root, '.gitconfig');
  fs.writeFileSync(
    globalConfig,
    '[user]\n\tname = Test User\n\temail = test@example.com\n[commit]\n\tgpgsign = false\n',
  );
  env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_TERMINAL_PROMPT: '0',
    GIT_EDITOR: 'true',
    LC_MESSAGES: 'C',
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

d('RepoManager: one queue lane per repository commonDir (spec 02 §6.13)', () => {
  it('serializes exclusive ops of a repo and its linked worktree, not of unrelated repos', async () => {
    const a = repoWithWorktree('lanes');
    const other = repoWithWorktree('other');
    let active = 0;
    let max = 0;
    const exec = async () => {
      active++;
      max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, 40));
      active--;
      return {};
    };
    const meta = {
      label: () => 'x',
      mutating: true,
      network: false,
      cancellable: true,
      touches: [],
      undoable: false,
      exclusive: 'repo' as const,
    };
    const { repos } = manager({ registry: { 'merge.abort': { meta, execute: exec } } });
    const main = await repos.open(a.main);
    const linked = await repos.open(a.wt);
    expect(linked.id).not.toBe(main.id);
    expect(linked.commonDir).toBe(main.commonDir);
    await Promise.all([
      repos.runOp(main.id, { type: 'merge.abort' }),
      repos.runOp(linked.id, { type: 'merge.abort' }),
      repos.runOp(main.id, { type: 'merge.abort' }),
    ]);
    expect(max).toBe(1);

    // a different repository has its own lane
    max = 0;
    const unrelated = await repos.open(other.main);
    await Promise.all([
      repos.runOp(main.id, { type: 'merge.abort' }),
      repos.runOp(unrelated.id, { type: 'merge.abort' }),
    ]);
    expect(max).toBe(2);
  });

  it('real ref ops from both worktrees never hit a lock error', async () => {
    const a = repoWithWorktree('real');
    for (let i = 0; i < 6; i++) git(a.main, 'branch', `old${i}`);
    git(a.main, 'pack-refs', '--all');
    const { repos } = manager();
    const main = await repos.open(a.main);
    const linked = await repos.open(a.wt);
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        repos.runOp(i % 2 ? linked.id : main.id, {
          type: 'branch.delete',
          branches: [{ name: `old${i}` }],
          force: true,
        }),
      ),
    );
    expect(git(a.main, 'branch', '--list', 'old*').trim()).toBe('');
  });
});

d('git channels added in Phase 10 (spec 02 §5.3)', () => {
  it('config list/get/set (queued), merge-base, conflicts, worktree status, watch state, perf advice', async () => {
    const a = repoWithWorktree('channels');
    const { repos, runner } = manager({ backend: new FakeBackend() });
    const engine = { runner, info: { features: { builtinFsmonitor: true } } };
    const h = createHandlers({ engine, repos } as never) as unknown as Record<
      string,
      (req: unknown, ctx: unknown) => Promise<unknown>
    >;
    const ctx = { senderId: 1 };
    const { id } = await repos.open(a.main);

    await h['git:config:set']!(
      { repoId: id, key: 'gitflow.branch.master', value: 'main', scope: 'local' },
      ctx,
    );
    await h['git:config:set']!({ repoId: id, key: 'kl.token', value: 'secret', scope: 'local' }, ctx);
    expect(await h['git:config:list']!({ repoId: id, scope: 'local', pattern: '^gitflow\\.' }, ctx)).toEqual([
      expect.objectContaining({ key: 'gitflow.branch.master', value: 'main', scope: 'local' }),
    ]);
    expect(await h['git:config:get']!({ repoId: id, key: 'kl.token' }, ctx)).toBe('***');
    expect(await h['git:config:get']!({ key: 'user.name', scope: 'global' }, ctx)).toBe('Test User');
    await h['git:config:set']!({ key: 'kl.global', value: 'yes', scope: 'global' }, ctx);
    expect(fs.readFileSync(env.GIT_CONFIG_GLOBAL!, 'utf8')).toMatch(/global = yes/);
    await expect(h['git:config:set']!({ key: 'kl.local', value: '1', scope: 'local' }, ctx)).rejects.toThrow(
      /needs an open repository/,
    );
    await expect(
      h['git:config:set']!({ repoId: id, key: '-bad', value: '1', scope: 'local' }, ctx),
    ).rejects.toThrow(/Invalid config key/);

    const head = git(a.main, 'rev-parse', 'HEAD').trim();
    expect(await h['git:mergeBase']!({ repoId: id, a: 'main', b: 'feature' }, ctx)).toBe(head);
    expect(await h['git:isAncestor']!({ repoId: id, ancestor: 'main', descendant: 'feature' }, ctx)).toBe(
      true,
    );
    expect(await h['git:conflicts']!({ repoId: id }, ctx)).toEqual([]);

    fs.writeFileSync(path.join(a.wt, 'only-in-wt.txt'), 'x\n');
    const wtStatus = (await h['git:status']!({ repoId: id, worktreePath: a.wt }, ctx)) as {
      entries: { path: string }[];
    };
    expect(wtStatus.entries.map((e) => e.path)).toEqual(['only-in-wt.txt']);

    expect(await h['git:watch:state']!({ repoId: id }, ctx)).toEqual({ mode: 'native' });
    expect(await h['git:perf:advice']!({ repoId: id }, ctx)).toMatchObject({ trackedFiles: 1, large: false });
  });

  it('a pre-existing index.lock → IndexLocked with lock details; "Delete lock & retry" succeeds', async () => {
    const a = repoWithWorktree('locked');
    const { repos, runner } = manager();
    const h = createHandlers({ engine: { runner }, repos } as never) as unknown as Record<
      string,
      (req: unknown, ctx: unknown) => Promise<unknown>
    >;
    const { id, gitDir } = await repos.open(a.main);
    const lockPath = path.join(gitDir, 'index.lock');
    fs.writeFileSync(lockPath, '');
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(lockPath, old, old);
    fs.writeFileSync(path.join(a.main, 'b.txt'), 'b\n');

    const err = (await repos.runOp(id, { type: 'wip.stageAll' }).catch((e: unknown) => e)) as {
      code: string;
      serialized: { details: Record<string, unknown> };
    };
    expect(err.code).toBe('IndexLocked');
    expect(err.serialized.details).toMatchObject({ lockPath, ageSec: 120 });

    // the handler only deletes *.lock files inside this repo's git dirs
    await expect(
      h['git:lock:remove']!({ repoId: id, lockPath: path.join(a.main, 'a.txt') }, {}),
    ).rejects.toThrow(/not a Git lock/);
    await expect(
      h['git:lock:remove']!({ repoId: id, lockPath: path.join(root, 'x.lock') }, {}),
    ).rejects.toThrow(/not a Git lock/);
    await h['git:lock:remove']!({ repoId: id, lockPath }, {});
    expect(fs.existsSync(lockPath)).toBe(false);
    await repos.runOp(id, { type: 'wip.stageAll' });
    expect(git(a.main, 'diff', '--cached', '--name-only').trim()).toBe('b.txt');
  });

  it('two rapid mutating ops in one repo never race on index.lock (spec 02 §9)', async () => {
    const a = repoWithWorktree('rapid');
    const { repos } = manager();
    const { id } = await repos.open(a.main);
    const runs: Promise<unknown>[] = [];
    for (let i = 0; i < 6; i++) {
      fs.writeFileSync(path.join(a.main, `r${i}.txt`), `${i}\n`);
      runs.push(repos.runOp(id, { type: 'wip.stage', paths: [`r${i}.txt`] }));
      runs.push(repos.runOp(id, { type: 'wip.unstage', paths: [`r${i}.txt`] }));
      runs.push(repos.runOp(id, { type: 'wip.stage', paths: [`r${i}.txt`] }));
    }
    await Promise.all(runs);
    expect(git(a.main, 'diff', '--cached', '--name-only').trim().split(/\r?\n/)).toHaveLength(6);
  });

  it('tab activation suspends background repos’ worktree watch (spec 02 §6.14)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const a = repoWithWorktree('active-a');
      const b = repoWithWorktree('active-b');
      const backend = new FakeBackend();
      const { repos } = manager({ backend, suspendWatchAfterMs: 60_000 });
      const ra = await repos.open(a.main);
      const rb = await repos.open(b.main);
      const rootA = ra.worktreeRoot!;
      const rootB = rb.worktreeRoot!;
      repos.setActiveRepo(ra.id);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(backend.subs.has(rootA)).toBe(true);
      expect(backend.subs.has(rootB)).toBe(false); // background for 60 s
      repos.setActiveRepo(rb.id);
      await vi.advanceTimersByTimeAsync(0);
      expect(backend.subs.has(rootB)).toBe(true);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(backend.subs.has(rootA)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

d('RepoManager: opening never waits for the file watcher (spec 02 §6.14)', () => {
  it('open resolves while subscribe is pending; a status refresh follows once the watch is armed', async () => {
    const a = repoWithWorktree('watch-late');
    const pending: Array<() => void> = [];
    const slow: WatcherBackend = {
      subscribe: () =>
        new Promise((resolve) => pending.push(() => resolve({ unsubscribe: async () => undefined }))),
    };
    const changed: Array<[string, string[], string]> = [];
    const { repos } = manager({ backend: slow, onChanged: (id, s, r) => changed.push([id, s, r]) });
    const { id } = await repos.open(a.main);
    expect(pending.length).toBeGreaterThan(0); // still subscribing
    expect(changed).toEqual([]);
    for (const r of pending.splice(0)) r();
    await vi.waitFor(() => expect(changed).toEqual([[id, ['status'], 'watcher']]));
  });
});

d('RepoManager: background index refresh (spec 02 §6.15.2)', () => {
  it('writes the untracked cache through the queue when core.untrackedCache is on, silently', async () => {
    const a = repoWithWorktree('ucache');
    git(a.main, 'config', 'core.untrackedCache', 'true');
    fs.writeFileSync(path.join(a.main, 'new.txt'), 'n\n');
    const index = path.join(a.main, '.git', 'index');
    const hasUntr = (): boolean => fs.readFileSync(index).includes(Buffer.from('UNTR'));
    expect(hasUntr()).toBe(false);
    const states: string[] = [];
    const runner = new GitProcessRunner({
      context: () => ({ gitPath: gitPath!, baseEnv: env, bundled: false }),
    });
    const repos = new RepoManager({
      runner: () => runner,
      features: () => undefined,
      watcherBackend: null,
      onChanged: () => undefined,
      onOpState: (_id, e) => states.push(e.type),
      registry: () => createOpRegistry(),
      indexRefreshDelayMs: 50,
    });
    managers.push(repos);
    await repos.open(a.main);
    await vi.waitFor(() => expect(hasUntr()).toBe(true), { timeout: 15_000, interval: 100 });
    expect(states).toEqual([]);
  });
});

d('RepoManager.borrow: validate → open discovers the repository once', () => {
  it('reuses the validation service for open() and the open service for later validations', async () => {
    const a = repoWithWorktree('borrow');
    const argv: string[] = [];
    const runner = new GitProcessRunner({
      context: () => ({ gitPath: gitPath!, baseEnv: env, bundled: false }),
      onCommand: (c) => argv.push(c.argv.join(' ')),
    });
    const repos = new RepoManager({
      runner: () => runner,
      features: () => undefined,
      watcherBackend: null,
      onChanged: () => undefined,
      registry: () => createOpRegistry(),
      indexRefreshIntervalMs: 0,
    });
    managers.push(repos);
    const discoveries = () => argv.filter((x) => x.startsWith('rev-parse --is-bare-repository')).length;
    const v = await repos.borrow(a.main);
    expect(v.repo.worktreeRoot).toBeTruthy();
    const info = await repos.open(a.main);
    expect(repos.get(info.id)).toBe(v);
    expect(await repos.borrow(a.main)).toBe(v);
    expect(discoveries()).toBe(1);
  });
});
