import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BulkRunner, type BulkRunnerDeps } from '../src/main/workspaces/bulk-runner';
import type {
  BulkOpProgress,
  RepoStatusSummary,
  Workspace,
  WorkspaceRepo,
} from '../src/shared/ipc/workspaces-contract';

type Summary = Omit<RepoStatusSummary, 'workspaceRepoId' | 'localPath'>;

const okStatus = (over: Partial<Summary> = {}): Summary => ({
  exists: true,
  isRepo: true,
  head: { branch: 'main', detached: false, sha: 'aaa' },
  upstream: 'origin/main',
  ahead: 0,
  behind: 0,
  wip: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
  stashCount: 0,
  ...over,
});

describe('BulkRunner (spec 11 §6.3)', () => {
  let dir: string;
  let events: BulkOpProgress[];
  let ws: Workspace;
  let located: Array<[string, string]>;

  const repo = (name: string, withPath = true, extra: Partial<WorkspaceRepo> = {}): WorkspaceRepo => {
    const p = path.join(dir, 'repos', name);
    if (withPath) fs.mkdirSync(p, { recursive: true });
    return { id: name, name, ...(withPath ? { localPath: p } : {}), addedAt: '', ...extra };
  };

  const deps = (over: Partial<BulkRunnerDeps> = {}): BulkRunnerDeps => ({
    workspace: () => ws,
    setRepoPath: (_w, repoId, p) => void located.push([repoId, p]),
    status: {
      forPath: async () => okStatus(),
      invalidate: () => undefined,
      locate: async () => null,
      remotes: async () => [],
    },
    openRepo: async (p) => `id:${path.basename(p)}`,
    closeRepo: async () => undefined,
    runOp: async () => undefined,
    clone: async (j) => {
      fs.mkdirSync(path.join(j.parentDir, j.folderName, '.git'), { recursive: true });
      return { path: path.join(j.parentDir, j.folderName) };
    },
    headSha: async () => 'aaa',
    countCommits: async () => 0,
    concurrency: () => 4,
    emit: (p) => void events.push(p),
    ...over,
  });

  const final = () => {
    const last = new Map<string, BulkOpProgress>();
    for (const e of events) last.set(e.repoId, e);
    return Object.fromEntries(
      [...last].map(([k, v]) => [k, `${v.state}${v.message ? `: ${v.message}` : ''}`]),
    );
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-ws-bulk-'));
    events = [];
    located = [];
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const workspace = (repos: WorkspaceRepo[], extra: Partial<Workspace> = {}): Workspace => ({
    id: 'ws',
    kind: 'local',
    name: 'W',
    order: 0,
    hidden: false,
    repos,
    createdAt: '',
    updatedAt: '',
    ...extra,
  });

  it('respects the concurrency limit and isolates per-repo errors', async () => {
    ws = workspace(['a', 'b', 'c', 'd', 'e'].map((n) => repo(n)).concat(repo('missing', false)));
    let inFlight = 0;
    let max = 0;
    const runner = new BulkRunner(
      deps({
        runOp: async (id) => {
          inFlight++;
          max = Math.max(max, inFlight);
          await new Promise((r) => setTimeout(r, 20));
          inFlight--;
          if (id === 'id:c') throw new Error('network down');
        },
      }),
    );
    const { done } = runner.start({
      workspaceId: 'ws',
      repoIds: ws.repos.map((r) => r.id),
      op: 'fetch',
      options: { concurrency: 2 },
    });
    await done;
    expect(max).toBe(2);
    expect(final()).toEqual({
      a: 'done: Fetched',
      b: 'done: Fetched',
      c: 'failed: network down',
      d: 'done: Fetched',
      e: 'done: Fetched',
      missing: 'skipped: Not cloned',
    });
    expect(events.filter((e) => e.state === 'queued')).toHaveLength(6);
  });

  it('cancel aborts running repos and skips the rest', async () => {
    ws = workspace(['a', 'b', 'c', 'd'].map((n) => repo(n)));
    let started = 0;
    const runner = new BulkRunner(
      deps({
        runOp: (_id, _op, signal) =>
          new Promise((_resolve, reject) => {
            started++;
            signal.addEventListener('abort', () => reject(new Error('killed')));
          }),
      }),
    );
    const { bulkId, done } = runner.start({
      workspaceId: 'ws',
      repoIds: ws.repos.map((r) => r.id),
      op: 'fetch',
      options: { concurrency: 2 },
    });
    while (started < 2) await new Promise((r) => setTimeout(r, 5));
    runner.cancel(bulkId);
    await done;
    expect(started).toBe(2);
    expect(Object.values(final())).toEqual([
      'skipped: Cancelled',
      'skipped: Cancelled',
      'skipped: Cancelled',
      'skipped: Cancelled',
    ]);
  });

  it('pull refuses repos with an operation in progress and reports results', async () => {
    ws = workspace([repo('merging'), repo('noUpstream'), repo('same'), repo('ff')]);
    const ops: string[] = [];
    const runner = new BulkRunner(
      deps({
        status: {
          forPath: async (p) => {
            const n = path.basename(p);
            if (n === 'merging') return okStatus({ operationInProgress: 'merge' });
            if (n === 'noUpstream') return okStatus({ upstream: undefined });
            return okStatus();
          },
          invalidate: () => undefined,
          locate: async () => null,
          remotes: async () => [],
        },
        runOp: async (_id, op) => void ops.push(JSON.stringify(op)),
        headSha: async (p) => (path.basename(p) === 'ff' ? 'bbb' : 'aaa'),
        countCommits: async () => 3,
      }),
    );
    const { done } = runner.start({
      workspaceId: 'ws',
      repoIds: ws.repos.map((r) => r.id),
      op: 'pull',
      options: { pullMode: 'ff-only' },
    });
    await done;
    expect(final()).toEqual({
      merging: 'failed: A merge is in progress — open repo',
      noUpstream: 'skipped: No upstream branch',
      same: 'done: Up to date',
      ff: 'done: Fast-forwarded 3 commits',
    });
    expect(ops).toEqual([
      JSON.stringify({ type: 'pull', strategy: 'ff-only' }),
      JSON.stringify({ type: 'pull', strategy: 'ff-only' }),
    ]);
  });

  it('clones missing repos with collision rules', async () => {
    const cloneRoot = path.join(dir, 'clones');
    const provider = (name: string) => ({
      integrationKey: 'github:github.com:1',
      owner: 'acme',
      name,
      cloneUrlHttps: `https://github.com/acme/${name}.git`,
      cloneUrlSsh: `git@github.com:acme/${name}.git`,
      webUrl: '',
    });
    // api: target exists as a clone of the same remote -> located
    fs.mkdirSync(path.join(cloneRoot, 'api', '.git'), { recursive: true });
    // web: target exists with another repo -> web-2
    fs.mkdirSync(path.join(cloneRoot, 'web', '.git'), { recursive: true });
    // empty: target exists but is empty -> used as is
    fs.mkdirSync(path.join(cloneRoot, 'empty'), { recursive: true });
    ws = workspace(
      [
        repo('api', false, { provider: provider('api') }),
        repo('web', false, { provider: provider('web') }),
        repo('empty', false, { remoteUrl: 'https://example.com/empty.git' }),
        repo('nourl', false),
        repo('fails', false, { provider: provider('fails') }),
        repo('present'),
      ],
      { defaultCloneRoot: cloneRoot },
    );
    const remotes: Record<string, string> = {
      api: 'git@github.com:acme/api.git',
      web: 'https://github.com/someone-else/web.git',
    };
    const cloned: string[] = [];
    const runner = new BulkRunner(
      deps({
        status: {
          forPath: async () => okStatus(),
          invalidate: () => undefined,
          locate: async (p) => ({
            toplevel: p,
            gitDir: path.join(p, '.git'),
            commonDir: path.join(p, '.git'),
          }),
          remotes: async (p) => [{ name: 'origin', url: remotes[path.basename(p)] ?? '' }],
        },
        clone: async (j) => {
          if (j.folderName === 'fails') throw new Error('Permission denied');
          cloned.push(`${j.url} -> ${j.folderName}`);
          j.onProgress(0.5, 'Receiving objects');
          return { path: path.join(j.parentDir, j.folderName) };
        },
      }),
    );
    const { done } = runner.start({
      workspaceId: 'ws',
      repoIds: ws.repos.map((r) => r.id),
      op: 'clone',
      options: { protocol: 'ssh' },
    });
    await done;
    expect(final()).toEqual({
      api: 'done: Already cloned — located',
      web: 'done: Cloned into web-2',
      empty: 'done: Cloned',
      nourl: 'skipped: No remote URL to clone from',
      fails: 'failed: Permission denied',
      present: 'skipped: Already cloned',
    });
    expect(cloned.sort()).toEqual([
      'git@github.com:acme/web.git -> web-2',
      'https://example.com/empty.git -> empty',
    ]);
    expect(located.map(([id]) => id).sort()).toEqual(['api', 'empty', 'web']);
    expect(events.some((e) => e.repoId === 'web' && e.progress === 0.5)).toBe(true);
  });

  it('fails clones without a clone folder and rejects empty selections', async () => {
    ws = workspace([repo('x', false, { remoteUrl: 'https://h/x.git' })]);
    const runner = new BulkRunner(deps());
    await runner.start({ workspaceId: 'ws', repoIds: ['x'], op: 'clone' }).done;
    expect(final()).toEqual({ x: 'failed: Choose a folder to clone into.' });
    expect(() => runner.start({ workspaceId: 'ws', repoIds: [], op: 'fetch' })).toThrow(/No repositories/);
  });

  it('push sends the current branch, skips what it must and publishes only when asked', async () => {
    ws = workspace(
      ['ahead', 'nothing', 'behind', 'diverged', 'detached', 'rebasing', 'newBranch', 'noRemote'].map((n) =>
        repo(n),
      ),
    );
    const status: Record<string, Summary> = {
      ahead: okStatus({ ahead: 2 }),
      nothing: okStatus(),
      behind: okStatus({ behind: 1 }),
      diverged: okStatus({ ahead: 1, behind: 1 }),
      detached: okStatus({ head: { detached: true, sha: 'aaa' }, ahead: 1 }),
      rebasing: okStatus({ operationInProgress: 'rebase', ahead: 1 }),
      newBranch: okStatus({ upstream: undefined, head: { branch: 'feat/x', detached: false, sha: 'aaa' } }),
      noRemote: okStatus({ upstream: undefined }),
    };
    const run = async (setUpstream: boolean) => {
      events = [];
      const ops: Array<[string, unknown]> = [];
      const runner = new BulkRunner(
        deps({
          status: {
            forPath: async (p) => status[path.basename(p)]!,
            invalidate: () => undefined,
            locate: async () => null,
            remotes: async (p) =>
              path.basename(p) === 'noRemote'
                ? []
                : [
                    { name: 'upstream', url: 'u' },
                    { name: 'origin', url: 'o' },
                  ],
          },
          runOp: async (id, op) => void ops.push([id, op]),
        }),
      );
      await runner.start({
        workspaceId: 'ws',
        repoIds: ws.repos.map((r) => r.id),
        op: 'push',
        options: setUpstream ? { setUpstream: true } : {},
      }).done;
      return ops;
    };

    const plain = await run(false);
    expect(final()).toEqual({
      ahead: 'done: Pushed 2 commits',
      nothing: 'skipped: Nothing to push',
      behind: 'skipped: Behind — pull first',
      diverged: 'skipped: Diverged from upstream — pull first',
      detached: 'skipped: Detached HEAD',
      rebasing: 'skipped: A rebase is in progress',
      newBranch: 'skipped: No upstream branch',
      noRemote: 'skipped: No upstream branch',
    });
    expect(plain).toEqual([['id:ahead', { type: 'push', localRef: 'main', remote: '', remoteBranch: '' }]]);

    const publish = await run(true);
    expect(final()).toMatchObject({
      ahead: 'done: Pushed 2 commits',
      newBranch: 'done: Published to origin/feat/x',
      noRemote: 'skipped: No remote',
    });
    expect(publish).toContainEqual([
      'id:newBranch',
      { type: 'push', localRef: 'feat/x', remote: 'origin', remoteBranch: 'feat/x', setUpstream: true },
    ]);
    // Never forced.
    expect(publish.every(([, op]) => !(op as { force?: string }).force)).toBe(true);
  });

  it('push runs at most two repos at once', async () => {
    ws = workspace(['a', 'b', 'c', 'd', 'e'].map((n) => repo(n)));
    let inFlight = 0;
    let max = 0;
    const runner = new BulkRunner(
      deps({
        status: {
          forPath: async () => okStatus({ ahead: 1 }),
          invalidate: () => undefined,
          locate: async () => null,
          remotes: async () => [],
        },
        runOp: async () => {
          inFlight++;
          max = Math.max(max, inFlight);
          await new Promise((r) => setTimeout(r, 20));
          inFlight--;
        },
        concurrency: () => 8,
      }),
    );
    await runner.start({ workspaceId: 'ws', repoIds: ws.repos.map((r) => r.id), op: 'push' }).done;
    expect(max).toBe(2);
    expect(Object.values(final()).every((v) => v === 'done: Pushed 1 commit')).toBe(true);
  });
});
