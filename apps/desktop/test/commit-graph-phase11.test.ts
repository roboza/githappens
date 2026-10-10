import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createOpRegistry, findOnPath, GitProcessRunner, type OpStateEvent } from '@githappens/git';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createHandlers } from '../src/main/ipc/handlers';
import { CommitGraphMaintainer, hasCommitGraph } from '../src/main/repo-ui/commit-graph-maintenance';
import { RepoManager } from '../src/main/services/repo-manager';
import {
  commitGraphWrittenToast,
  gitBool,
  readWriteOnFetch,
  setWriteOnFetch,
  WRITE_ON_FETCH_KEY,
} from '../src/renderer/src/views/preferences/repo/commit-graph-pref';

/**
 * Phase 11, spec 02 §6.15.1: the "write commit-graph on fetch" opt-in (`fetch.writeCommitGraph`, queued
 * `config.set`, read back with `git:config:get`) and the background write as a queued, cancellable
 * `maintenance.commitGraph` op.
 */

describe('write-on-fetch helpers', () => {
  it("parses git's boolean syntax", () => {
    for (const v of ['true', 'TRUE', 'yes', 'on', '1', '']) expect(gitBool(v), v).toBe(true);
    for (const v of [null, undefined, 'false', 'no', 'off', '0']) expect(gitBool(v), String(v)).toBe(false);
  });

  it('sets / unsets the local key through git:config:set and reads it with git:config:get', async () => {
    const calls: unknown[][] = [];
    let stored: string | null = null;
    const invoke = (async (ch: string, req: { value?: string | null }) => {
      calls.push([ch, req]);
      if (ch === 'git:config:set') stored = req.value ?? null;
      return ch === 'git:config:get' ? stored : undefined;
    }) as never;
    expect(await readWriteOnFetch(invoke, 'r1')).toBe(false);
    await setWriteOnFetch(invoke, 'r1', true);
    expect(await readWriteOnFetch(invoke, 'r1')).toBe(true);
    await setWriteOnFetch(invoke, 'r1', false);
    expect(calls).toEqual([
      ['git:config:get', { repoId: 'r1', key: WRITE_ON_FETCH_KEY, scope: 'local' }],
      ['git:config:set', { repoId: 'r1', key: WRITE_ON_FETCH_KEY, value: 'true', scope: 'local' }],
      ['git:config:get', { repoId: 'r1', key: WRITE_ON_FETCH_KEY, scope: 'local' }],
      ['git:config:set', { repoId: 'r1', key: WRITE_ON_FETCH_KEY, value: null, scope: 'local' }],
    ]);
  });

  it('the completion toast offers the opt-in only while it is off', async () => {
    let enabled = 0;
    const off = commitGraphWrittenToast({
      repoName: 'big',
      writeOnFetch: false,
      enableWriteOnFetch: async () => void enabled++,
    });
    expect(off.title).toBe('Commit-graph written');
    expect(off.body).toMatch(/^big: the graph now loads faster/);
    expect(off.actions?.map((a) => a.label)).toEqual(['Update on fetch']);
    await off.actions![0]!.run();
    expect(enabled).toBe(1);
    const on = commitGraphWrittenToast({ writeOnFetch: true, enableWriteOnFetch: async () => undefined });
    expect(on.actions).toBeUndefined();
  });
});

const gitPath = findOnPath('git');
const d = gitPath ? describe : describe.skip;
let root = '';
let env: NodeJS.ProcessEnv = {};
const managers: RepoManager[] = [];

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(gitPath!, args, { cwd, env, windowsHide: true, stdio: 'pipe' }).toString('utf8');

function repo(name: string, commits = 3): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '--initial-branch=main');
  for (let i = 0; i < commits; i++) git(dir, 'commit', '-q', '--allow-empty', '-m', `c${i}`);
  return dir;
}

function manager(states: OpStateEvent[] = []): { repos: RepoManager; runner: GitProcessRunner } {
  const runner = new GitProcessRunner({
    context: () => ({ gitPath: gitPath!, baseEnv: env, bundled: false }),
  });
  const repos = new RepoManager({
    runner: () => runner,
    features: () => undefined,
    watcherBackend: null,
    onChanged: () => undefined,
    registry: () => createOpRegistry(),
    onOpState: (_id, e) => states.push(e),
  });
  managers.push(repos);
  return { repos, runner };
}

beforeAll(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-cg11-')));
  const globalConfig = path.join(root, '.gitconfig');
  fs.writeFileSync(globalConfig, '[user]\n\tname = Test User\n\temail = test@example.com\n');
  env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_TERMINAL_PROMPT: '0',
  };
});

afterAll(async () => {
  for (const m of managers) await m.disposeAll();
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    /* Windows may hold handles briefly */
  }
});

d('with real git (RepoManager + IPC handlers)', () => {
  it('the checkbox writes fetch.writeCommitGraph to .git/config through the queue', async () => {
    const dir = repo('opt-in');
    const states: OpStateEvent[] = [];
    const { repos, runner } = manager(states);
    const h = createHandlers({ engine: { runner }, repos } as never) as unknown as Record<
      string,
      (req: unknown, ctx: unknown) => Promise<unknown>
    >;
    const invoke = ((ch: string, req: unknown) => h[ch]!(req, { senderId: 1 })) as never;
    const { id } = await repos.open(dir);
    expect(await readWriteOnFetch(invoke, id)).toBe(false);
    await setWriteOnFetch(invoke, id, true);
    expect(git(dir, 'config', '--local', '--get', WRITE_ON_FETCH_KEY).trim()).toBe('true');
    expect(await readWriteOnFetch(invoke, id)).toBe(true);
    expect(states.filter((e) => e.type === 'config.set').map((e) => e.state)).toEqual([
      'queued',
      'running',
      'succeeded',
    ]);
    await setWriteOnFetch(invoke, id, false);
    expect(() => git(dir, 'config', '--local', '--get', WRITE_ON_FETCH_KEY)).toThrow();
    expect(await readWriteOnFetch(invoke, id)).toBe(false);
  });

  it('the maintainer writes the commit-graph as a visible maintenance op', async () => {
    const dir = repo('maintain', 5);
    const states: OpStateEvent[] = [];
    const { repos } = manager(states);
    const info = await repos.open(dir);
    const m = new CommitGraphMaintainer({
      enabled: () => true,
      threshold: 1,
      run: async (cwd, args) => git(cwd, ...args),
      write: async (r) => void (await repos.runOp(r.repoId!, { type: 'maintenance.commitGraph' }, true)),
    });
    m.onRepoOpened({ cwd: dir, commonDir: info.commonDir, repoId: info.id });
    await m.idle();
    expect(m.writes).toBe(1);
    expect(hasCommitGraph(info.commonDir)).toBe(true);
    expect(states.map((e) => [e.type, e.state, e.label])).toEqual([
      ['maintenance.commitGraph', 'queued', 'Write commit-graph'],
      ['maintenance.commitGraph', 'running', 'Write commit-graph'],
      ['maintenance.commitGraph', 'succeeded', 'Write commit-graph'],
    ]);
  });
});
