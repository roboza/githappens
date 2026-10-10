import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import watcher from '@parcel/watcher';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RefreshScope } from '../src/shared/ipc/git-contract';
import {
  pollSnapshot,
  RepoWatcher,
  ScopeDebouncer,
  scopesForGitPath,
  scopesForWorktreePath,
  type WatcherBackend,
} from '../src/main/services/repo-watcher';

describe('scope mapping (spec 02 §6.14)', () => {
  it.each<[string, RefreshScope[]]>([
    ['HEAD', ['refs', 'graph', 'status', 'repoState']],
    ['index', ['status']],
    ['refs/heads/feature/x', ['refs', 'graph']],
    ['refs/remotes/origin/main', ['refs', 'graph']],
    ['packed-refs', ['refs', 'graph']],
    ['refs/stash', ['stash', 'graph']],
    ['logs/refs/stash', ['stash', 'graph']],
    ['FETCH_HEAD', ['refs']],
    ['MERGE_HEAD', ['repoState', 'conflicts', 'status']],
    ['rebase-merge/done', ['repoState', 'conflicts', 'status']],
    ['config', ['config', 'remotes', 'submodules']],
    ['worktrees/wt/HEAD', ['worktrees']],
    ['modules/lib/HEAD', ['submodules']],
    ['info/exclude', ['status']],
    ['objects/ab/cdef', []],
    ['refs/githappens/undo/1', []],
    ['HEAD.lock', []],
  ])('%s', (rel, scopes) => {
    expect(scopesForGitPath(rel, 'update')).toEqual(scopes);
  });

  it('treats index.lock removal as a status refresh', () => {
    expect(scopesForGitPath('index.lock', 'delete')).toEqual(['status']);
    expect(scopesForGitPath('index.lock', 'create')).toEqual([]);
  });

  it('maps worktree files', () => {
    expect(scopesForWorktreePath('src/a.ts')).toEqual(['status']);
    expect(scopesForWorktreePath('.gitmodules')).toEqual(['submodules', 'status']);
  });
});

describe('ScopeDebouncer', () => {
  afterEach(() => vi.useRealTimers());

  it('coalesces bursts (trailing 300 ms)', () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const d = new ScopeDebouncer(emit);
    d.push(['status']);
    vi.advanceTimersByTime(200);
    d.push(['refs', 'status']);
    vi.advanceTimersByTime(299);
    expect(emit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]![0].sort()).toEqual(['refs', 'status']);
  });

  it('emits at least every 1500 ms under a continuous flood', () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const d = new ScopeDebouncer(emit);
    for (let t = 0; t < 3000; t += 100) {
      d.push(['status']);
      vi.advanceTimersByTime(100);
    }
    expect(emit.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(emit.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('ignores empty pushes', () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    new ScopeDebouncer(emit).push([]);
    vi.advanceTimersByTime(5000);
    expect(emit).not.toHaveBeenCalled();
  });
});

describe('RepoWatcher', () => {
  let dir: string;
  afterEach(() => dir && fs.rmSync(dir, { recursive: true, force: true }));

  const git = (...args: string[]): void => {
    execFileSync(
      'git',
      ['-c', 'user.name=T', '-c', 'user.email=t@e.x', '-c', 'commit.gpgsign=false', ...args],
      {
        cwd: dir,
        stdio: 'ignore',
      },
    );
  };
  const waitFor = async (pred: () => boolean, ms = 20_000): Promise<void> => {
    const until = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > until) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  it('reports worktree edits and ref changes from a real repo', async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-watch-')));
    git('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');

    const seen: RefreshScope[][] = [];
    const w = new RepoWatcher({
      worktreeRoot: dir,
      gitDir: path.join(dir, '.git'),
      commonDir: path.join(dir, '.git'),
      backend: watcher as unknown as WatcherBackend,
      onChange: (s) => seen.push(s),
    });
    await w.start();
    try {
      // The native watcher may take a moment to arm under heavy load; keep touching the file.
      let n = 0;
      await waitFor(() => {
        if (n++ % 20 === 0) fs.writeFileSync(path.join(dir, 'a.txt'), `changed ${n}\n`);
        return seen.some((s) => s.includes('status'));
      });

      seen.length = 0;
      git('branch', 'feature');
      await waitFor(() => seen.some((s) => s.includes('refs') && s.includes('graph')));

      // muted: our own ops don't trigger refreshes
      seen.length = 0;
      w.mute();
      fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');
      await new Promise((r) => setTimeout(r, 800));
      expect(seen).toEqual([]);
      w.unmute();
    } finally {
      await w.dispose();
    }
  });

  it('falls back to polling when the backend fails', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-watch-'));
    fs.mkdirSync(path.join(dir, '.git'));
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const onError = vi.fn();
    const seen: RefreshScope[][] = [];
    const failing: WatcherBackend = { subscribe: () => Promise.reject(new Error('ENOSPC')) };
    const w = new RepoWatcher({
      worktreeRoot: dir,
      gitDir: path.join(dir, '.git'),
      commonDir: path.join(dir, '.git'),
      backend: failing,
      onChange: (s) => seen.push(s),
      onError,
      pollIntervalMs: 50,
    });
    await w.start();
    expect(onError).toHaveBeenCalled();
    expect(w.isPolling).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/other\n');
    fs.utimesSync(path.join(dir, '.git', 'HEAD'), new Date(), new Date(Date.now() + 5000));
    await waitFor(() => seen.length > 0, 3000);
    await w.dispose();
  });
});

describe('pollSnapshot (watcher fallback)', () => {
  it('changes when a branch is created or HEAD moves', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-poll-'));
    try {
      fs.mkdirSync(path.join(dir, 'refs', 'heads'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'HEAD'), 'ref: refs/heads/main\n');
      const a = pollSnapshot([dir]);
      fs.writeFileSync(path.join(dir, 'refs', 'heads', 'feature'), 'abc\n');
      const b = pollSnapshot([dir]);
      expect(b).not.toBe(a);
      fs.writeFileSync(path.join(dir, 'refs', 'heads', 'feature'), 'abc\n');
      expect(pollSnapshot([dir]).includes('feature')).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
