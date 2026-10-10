import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RefreshScope } from '../src/shared/ipc/git-contract';
import {
  RepoWatcher,
  ScopeDebouncer,
  type FsEventType,
  type WatcherBackend,
} from '../src/main/services/repo-watcher';

/**
 * RepoWatcher with a fake clock and a fake backend (spec 02 §6.14, §6.16 "Queue/watcher tests: fake clock;
 * assert debouncing, coalescing, mute-during-op"): 300 ms trailing / 1500 ms max-wait debounce, flood mode,
 * mute, polling fallback with a mode change for the status bar, and inactive-tab worktree suspension.
 */

type Cb = (err: Error | null, events: { type: FsEventType; path: string }[]) => void;

class FakeBackend implements WatcherBackend {
  readonly subs = new Map<string, Cb>();
  readonly unsubscribed: string[] = [];
  fail: Error | null = null;
  async subscribe(dir: string, cb: Cb): Promise<{ unsubscribe(): Promise<void> }> {
    if (this.fail) throw this.fail;
    this.subs.set(dir, cb);
    return {
      unsubscribe: async () => {
        this.subs.delete(dir);
        this.unsubscribed.push(dir);
      },
    };
  }
  emit(dir: string, rel: string[], type: FsEventType = 'update'): void {
    this.subs.get(dir)?.(
      null,
      rel.map((r) => ({ type, path: path.join(dir, r) })),
    );
  }
}

let root: string;
let gitDir: string;
let backend: FakeBackend;
let seen: RefreshScope[][];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-wclock-')));
  gitDir = path.join(root, '.git');
  fs.mkdirSync(path.join(gitDir, 'refs', 'heads'), { recursive: true });
  fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
  backend = new FakeBackend();
  seen = [];
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(root, { recursive: true, force: true });
});

const watcher = (over: Partial<ConstructorParameters<typeof RepoWatcher>[0]> = {}): RepoWatcher =>
  new RepoWatcher({
    worktreeRoot: root,
    gitDir,
    commonDir: gitDir,
    backend,
    onChange: (s) => seen.push([...s].sort()),
    ...over,
  });

describe('debounce (300 ms trailing, 1500 ms max-wait)', () => {
  it('a single burst refreshes once, 300 ms after the last event, with the union of scopes', async () => {
    const w = watcher();
    await w.start();
    backend.emit(root, ['a.txt']);
    vi.advanceTimersByTime(250);
    backend.emit(gitDir, ['refs/heads/x']);
    vi.advanceTimersByTime(299);
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(seen).toEqual([['graph', 'refs', 'status']]);
    await w.dispose();
  });

  it('a steady trickle still refreshes every 1500 ms (max-wait)', async () => {
    const w = watcher();
    await w.start();
    for (let t = 0; t < 4500; t += 200) {
      backend.emit(root, [`f${t}.txt`]);
      vi.advanceTimersByTime(200);
    }
    // windows start at 0 and 1600 (max-wait fires at 1500 and 3100); the third is still open at 4600
    expect(seen).toHaveLength(2);
    vi.advanceTimersByTime(300);
    expect(seen).toHaveLength(3);
    await w.dispose();
  });
});

describe('flood mode (> 1000 events, e.g. npm install)', () => {
  it('switches to a single status refresh after quiet instead of one per 1.5 s', async () => {
    const w = watcher();
    await w.start();
    // 50k files over 6 s in batches (an ignored folder still reaches the watcher on some platforms)
    for (let t = 0; t < 6000; t += 100) {
      backend.emit(
        root,
        Array.from({ length: 800 }, (_, i) => `node_modules/pkg${t}/f${i}.js`),
        'create',
      );
      vi.advanceTimersByTime(100);
    }
    // the first window refreshed (max-wait) before the flood was detected? never more than one per 1.5 s
    const during = seen.length;
    expect(during).toBeLessThanOrEqual(1);
    vi.advanceTimersByTime(300);
    expect(seen.length).toBe(during + 1);
    expect(seen.at(-1)).toEqual(['status']);
    await w.dispose();
  });

  it('a never-ending flood is still refreshed by the 10 s safety cap', () => {
    const d = new ScopeDebouncer((s) => seen.push(s));
    for (let t = 0; t < 25_000; t += 100) {
      d.push(['status'], 600);
      vi.advanceTimersByTime(100);
    }
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.length).toBeLessThanOrEqual(3);
  });
});

describe('mute during our own ops (spec 02 §6.13 rule 2)', () => {
  it('drops events while muted; nested mute counts', async () => {
    const w = watcher();
    await w.start();
    w.mute();
    w.mute();
    backend.emit(root, ['a.txt']);
    backend.emit(gitDir, ['index']);
    w.unmute();
    backend.emit(gitDir, ['HEAD']);
    vi.advanceTimersByTime(2000);
    expect(seen).toEqual([]);
    w.unmute();
    backend.emit(root, ['b.txt']);
    vi.advanceTimersByTime(300);
    expect(seen).toEqual([['status']]);
    await w.dispose();
  });
});

describe('fallback polling (spec 02 §6.14 "Fallback")', () => {
  it('polls .git every 5 s after a watcher error and reports polling mode', async () => {
    backend.fail = new Error('ENOSPC: System limit for number of file watchers reached');
    const onError = vi.fn();
    const onModeChange = vi.fn();
    const w = watcher({ onError, onModeChange });
    await w.start();
    expect(onError).toHaveBeenCalledWith(backend.fail);
    expect(onModeChange).toHaveBeenCalledWith('polling');
    expect(w.mode).toBe('polling');

    vi.advanceTimersByTime(5000 + 300);
    expect(seen).toEqual([['status']]); // no .git change: status only (worktree edits are invisible)
    fs.writeFileSync(path.join(gitDir, 'refs', 'heads', 'feature'), 'abc\n');
    vi.advanceTimersByTime(5000 + 300);
    expect(seen.at(-1)).toEqual(['conflicts', 'graph', 'refs', 'repoState', 'stash', 'status']);
    await w.dispose();
  });

  it('an error event from a live subscription also switches to polling', async () => {
    const w = watcher();
    await w.start();
    expect(w.mode).toBe('native');
    backend.subs.get(root)!(new Error('watch dir removed'), []);
    expect(w.mode).toBe('polling');
    await w.dispose();
  });
});

describe('inactive tabs (spec 02 §6.14)', () => {
  it('suspends the worktree watch after 60 s in background and resumes with a status refresh', async () => {
    const w = watcher();
    await w.start();
    w.setActive(false);
    vi.advanceTimersByTime(59_000);
    expect(w.isSuspended).toBe(false);
    vi.advanceTimersByTime(1_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(w.isSuspended).toBe(true);
    expect(backend.unsubscribed).toEqual([root]);
    expect(backend.subs.has(gitDir)).toBe(true); // .git watch kept

    // .git changes still arrive while suspended
    backend.emit(gitDir, ['refs/heads/x']);
    vi.advanceTimersByTime(300);
    expect(seen).toEqual([['graph', 'refs']]);

    w.setActive(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(w.isSuspended).toBe(false);
    expect(backend.subs.has(root)).toBe(true);
    expect(seen.at(-1)).toEqual(['status']);
    await w.dispose();
  });

  it('re-activation within 60 s cancels the suspension', async () => {
    const w = watcher();
    await w.start();
    w.setActive(false);
    vi.advanceTimersByTime(30_000);
    w.setActive(true);
    vi.advanceTimersByTime(120_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(w.isSuspended).toBe(false);
    expect(backend.unsubscribed).toEqual([]);
    expect(seen).toEqual([]);
    await w.dispose();
  });
});

describe('leading edge (spec 02 §9: external save → WIP row < 500 ms)', () => {
  it('emits the first event after a quiet period at once, then a few follow-ups, then debounces', () => {
    const d = new ScopeDebouncer((s) => seen.push([...s].sort()), { leading: true });
    d.push(['status']);
    expect(seen).toEqual([['status']]);
    vi.advanceTimersByTime(100);
    // Phase 11: what follows right after the leading emit is not held for the trailing window
    d.push(['refs']);
    d.push(['status']);
    expect(seen).toEqual([['status'], ['refs'], ['status']]);
    // a burst beyond the follow-up budget (4 raw events) is debounced as before
    d.push(['status'], 3);
    d.push(['stash']);
    vi.advanceTimersByTime(299);
    expect(seen).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(seen.at(-1)).toEqual(['stash', 'status']);
    // quiet again: the next event is immediate
    vi.advanceTimersByTime(1000);
    d.push(['stash']);
    expect(seen.at(-1)).toEqual(['stash']);
  });

  it('a delete right after a save is emitted at once, not after the 300 ms window (Phase 11)', () => {
    const d = new ScopeDebouncer((s) => seen.push([...s].sort()), { leading: true });
    d.push(['status']); // save → WIP row
    vi.advanceTimersByTime(180); // status still being read in the renderer
    d.push(['status']); // the file is deleted
    expect(seen).toEqual([['status'], ['status']]); // the renderer re-runs once its read completes
    // and later saves / deletes keep being immediate while they come one at a time
    vi.advanceTimersByTime(250);
    d.push(['status']);
    expect(seen).toHaveLength(3);
    vi.advanceTimersByTime(400);
    d.push(['status']);
    expect(seen).toHaveLength(4);
  });

  it('keeps flood behaviour: one leading refresh, then a single status refresh after quiet', () => {
    const d = new ScopeDebouncer((s) => seen.push([...s].sort()), { leading: true });
    for (let t = 0; t < 6000; t += 100) {
      d.push(['status'], 800);
      vi.advanceTimersByTime(100);
    }
    expect(seen.length).toBeLessThanOrEqual(2); // leading + at most one max-wait before flood mode
    const during = seen.length;
    vi.advanceTimersByTime(300);
    expect(seen.length).toBe(during + 1);
  });
});

describe('start (spec 02 §6.14; repo open must not wait for the watch)', () => {
  it('names the native backend so @parcel/watcher never probes for watchman', async () => {
    const opts: unknown[] = [];
    const spy: WatcherBackend = {
      subscribe: async (_dir, _cb, o) => {
        opts.push(o);
        return { unsubscribe: async () => undefined };
      },
    };
    const w = watcher({ backend: spy, nativeBackend: 'windows' });
    await w.start();
    expect(opts).toEqual([
      { ignore: expect.any(Array), backend: 'windows' },
      { ignore: expect.any(Array), backend: 'windows' },
    ]);
    await w.dispose();
  });

  it('a dispose or suspension landing while subscribes are in flight drops them', async () => {
    const pending: Array<() => void> = [];
    const unsubscribed: string[] = [];
    const slow: WatcherBackend = {
      subscribe: (dir) =>
        new Promise((resolve) =>
          pending.push(() => resolve({ unsubscribe: async () => void unsubscribed.push(dir) })),
        ),
    };
    const w = watcher({ backend: slow, suspendAfterMs: 10 });
    const started = w.start();
    w.setActive(false);
    vi.advanceTimersByTime(10);
    await vi.advanceTimersByTimeAsync(0);
    expect(w.isSuspended).toBe(true);
    for (const r of pending.splice(0)) r();
    await started;
    expect(unsubscribed).toEqual([root]); // the worktree watch arrived after the suspension

    const w2 = watcher({ backend: slow });
    const started2 = w2.start();
    await w2.dispose();
    for (const r of pending.splice(0)) r();
    await started2;
    expect(unsubscribed.sort()).toEqual([gitDir, root, root].sort());
  });
});
