import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { GitError, makeError, type CommandLogEntry, type GitErrorCode, type RepoId } from '@githappens/git';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DesktopNotifier } from '../src/main/notify/desktop-notifier';
import { FileLogger } from '../src/main/output/file-logger';
import { OutputLog, RingBuffer } from '../src/main/output/output-log';
import { createOutputHandlers } from '../src/main/ipc/output-handlers';
import { AutoFetchScheduler, type AutoFetchDeps } from '../src/main/services/auto-fetch';
import type { AutoFetchState } from '../src/shared/ipc/behaviour-contract';

const R1 = 'repo-1' as RepoId;
const R2 = 'repo-2' as RepoId;
const MIN = 60_000;

const gitErr = (code: GitErrorCode): GitError => new GitError(makeError(code, { argv: ['fetch'] }));

function scheduler(over: Partial<AutoFetchDeps> = {}) {
  const states: AutoFetchState[] = [];
  const fetch = vi.fn(async (_id: RepoId, _prune: boolean) => undefined as unknown);
  const s = new AutoFetchScheduler({
    settings: () => ({ intervalMin: 1, prune: true }),
    fetch,
    hasRemotes: async () => true,
    random: () => 0,
    emit: (st) => states.push(st),
    ...over,
  });
  return { s, fetch: (over.fetch as typeof fetch) ?? fetch, states };
}

describe('AutoFetchScheduler (spec 09 §6.2)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('first fetch ~10 s after open, then every interval', async () => {
    const { s, fetch } = scheduler();
    s.add(R1);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(R1, true);
    await vi.advanceTimersByTimeAsync(MIN);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(s.state(R1)).toMatchObject({ enabled: true, paused: false, failures: 0 });
    expect(s.state(R1)!.lastFetchAt).not.toBeNull();
    s.dispose();
  });

  it('interval 0 disables it; reschedule picks up a new interval', async () => {
    let interval = 0;
    const { s, fetch } = scheduler({ settings: () => ({ intervalMin: interval, prune: false }) });
    s.add(R1);
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(fetch).not.toHaveBeenCalled();
    expect(s.state(R1)!.enabled).toBe(false);
    interval = 2;
    s.reschedule();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    s.dispose();
  });

  it('backs off exponentially on network errors and resets on success', async () => {
    let fail = true;
    const fetch = vi.fn(async () => {
      if (fail) throw gitErr('NetworkUnreachable');
    });
    const { s } = scheduler({ fetch, backoffBaseMs: MIN });
    s.add(R1);
    await vi.advanceTimersByTimeAsync(10_000); // 1st attempt fails → failures 1 → max(1 min, 1 min)
    expect(s.state(R1)!.failures).toBe(1);
    await vi.advanceTimersByTimeAsync(MIN); // 2nd fails → 2 min
    expect(s.state(R1)!.failures).toBe(2);
    expect(s.delayFor(R1)).toBe(2 * MIN);
    await vi.advanceTimersByTimeAsync(2 * MIN); // 3rd fails → 4 min
    expect(s.state(R1)!.failures).toBe(3);
    expect(s.delayFor(R1)).toBe(4 * MIN);
    expect(s.state(R1)!.lastError?.code).toBe('NetworkUnreachable');
    fail = false;
    await vi.advanceTimersByTimeAsync(4 * MIN);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(s.state(R1)).toMatchObject({ failures: 0 });
    expect(s.state(R1)!.lastError).toBeUndefined();
    s.dispose();
  });

  it('caps the backoff at 30 minutes', () => {
    const { s } = scheduler();
    s.add(R1);
    (s as unknown as { repos: Map<RepoId, { failures: number }> }).repos.get(R1)!.failures = 20;
    expect(s.delayFor(R1)).toBe(30 * MIN);
    s.dispose();
  });

  it('pauses on auth failure until a manual fetch succeeds or Resume', async () => {
    const onFailure = vi.fn();
    let code: GitErrorCode | null = 'AuthenticationFailed';
    const fetch = vi.fn(async () => {
      if (code) throw gitErr(code);
    });
    const { s, states } = scheduler({ fetch, onFailure });
    s.add(R1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.state(R1)).toMatchObject({ paused: true, nextFetchAt: null });
    expect(onFailure).toHaveBeenCalledWith(
      R1,
      expect.objectContaining({ code: 'AuthenticationFailed' }),
      true,
    );
    expect(states.at(-1)!.paused).toBe(true);
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(fetch).toHaveBeenCalledTimes(1);

    // a successful manual fetch resumes
    code = null;
    s.onOpState(R1, { type: 'fetch', state: 'succeeded' });
    expect(s.state(R1)!.paused).toBe(false);
    await vi.advanceTimersByTimeAsync(MIN);
    expect(fetch).toHaveBeenCalledTimes(2);

    // pause again, then "Resume"
    code = 'HostKeyVerificationFailed';
    await vi.advanceTimersByTimeAsync(MIN);
    expect(s.state(R1)!.paused).toBe(true);
    code = null;
    s.resume(R1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(s.state(R1)!.paused).toBe(false);
    s.dispose();
  });

  it('runs at most 3 fetches at once across repos', async () => {
    const releases: (() => void)[] = [];
    let concurrent = 0;
    let peak = 0;
    const fetch = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          concurrent++;
          peak = Math.max(peak, concurrent);
          releases.push(() => {
            concurrent--;
            resolve();
          });
        }),
    );
    const { s } = scheduler({ fetch });
    const ids = ['a', 'b', 'c', 'd', 'e'] as RepoId[];
    ids.forEach((id) => s.add(id));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(s.running).toBe(3);
    releases.shift()!();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(4);
    while (releases.length) {
      releases.shift()!();
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(peak).toBe(3);
    s.dispose();
  });

  it('adds jitter to every schedule', async () => {
    const { s, fetch } = scheduler({ random: () => 0.5, jitterMs: 4_000 });
    s.add(R1);
    await vi.advanceTimersByTimeAsync(11_999);
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    s.dispose();
  });

  it('throttles background tabs to 5 minutes and skips busy / offline / remote-less repos', async () => {
    let online = true;
    let busy = false;
    const { s, fetch } = scheduler({
      isOnline: () => online,
      isBusy: () => busy,
      hasRemotes: async (id) => id !== R2,
    });
    s.add(R1);
    s.add(R2);
    s.setActive(R2); // R1 is now a background tab
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch).toHaveBeenCalledTimes(1); // R1 (first run); R2 has no remotes
    expect(s.delayFor(R1)).toBe(5 * MIN);
    await vi.advanceTimersByTimeAsync(MIN);
    expect(fetch).toHaveBeenCalledTimes(1);
    online = false;
    await vi.advanceTimersByTimeAsync(4 * MIN);
    expect(fetch).toHaveBeenCalledTimes(1); // offline tick skipped
    online = true;
    busy = true;
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(fetch).toHaveBeenCalledTimes(1); // busy tick skipped
    busy = false;
    s.setActive(R1); // foreground again: interval 1 min
    await vi.advanceTimersByTimeAsync(MIN);
    expect(fetch).toHaveBeenCalledTimes(2);
    s.remove(R1);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(fetch).toHaveBeenCalledTimes(2);
    s.dispose();
  });
});

const entry = (over: Partial<CommandLogEntry> = {}): CommandLogEntry => ({
  id: `e${Math.random()}`,
  argv: ['status'],
  cwd: '/repo/one',
  startedAt: 1,
  durationMs: 2,
  exitCode: 0,
  stdoutPreview: '',
  stderr: '',
  ...over,
});

describe('OutputLog (spec 02 §2 output log)', () => {
  it('ring buffer keeps the newest N, oldest first', () => {
    const b = new RingBuffer<number>(3);
    for (let i = 1; i <= 5; i++) b.push(i);
    expect(b.toArray()).toEqual([3, 4, 5]);
    expect(b.size).toBe(3);
    b.clear();
    expect(b.toArray()).toEqual([]);
  });

  it('routes commands to repos by cwd, redacts credentials and caps per repo', () => {
    const appended: [RepoId, CommandLogEntry][] = [];
    const log = new OutputLog({
      capacity: 3,
      maxOutputBytes: 20,
      repoIdFor: (cwd) => (cwd === '/repo/one' ? R1 : null),
      onAppend: (id, e) => appended.push([id, e]),
    });
    log.append(
      entry({
        argv: [
          'push',
          'https://user:s3cret@github.com/o/r.git',
          '-c',
          'http.extraheader=AUTHORIZATION: bearer abc',
        ],
        stderr: `${'x'.repeat(40)}\nfatal: https://bob:tok3n@host/r failed`,
        opId: 'op1',
      }),
    );
    const [first] = log.list(R1);
    expect(first!.argv.join(' ')).not.toMatch(/s3cret|abc/);
    expect(first!.argv[1]).toBe('https://user:***@github.com/o/r.git');
    expect(first!.stderr.startsWith('…')).toBe(true);
    expect(first!.stderr).not.toContain('tok3n');
    expect(first!.stderr.length).toBeLessThanOrEqual(21);
    expect(log.forOp(R1, 'op1')).toHaveLength(1);
    for (let i = 0; i < 5; i++) log.append(entry({ argv: ['log', String(i)] }));
    expect(log.list(R1).map((e) => e.argv[1])).toEqual(['2', '3', '4']);
    expect(log.list(R1, 2).map((e) => e.argv[1])).toEqual(['3', '4']);
    log.append(entry({ cwd: '/elsewhere' }));
    expect(log.list('' as RepoId)).toHaveLength(1);
    expect(appended).toHaveLength(7);

    const h = createOutputHandlers(log);
    expect(h['git:output:list']({ repoId: R1 }, { senderId: 1 })).toHaveLength(3);
    h['git:output:clear']({ repoId: R1 }, { senderId: 1 });
    expect(log.list(R1)).toEqual([]);
  });
});

describe('FileLogger (extended logging)', () => {
  it('writes only when enabled and rotates main.log', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-logs-'));
    try {
      let enabled = false;
      const logger = new FileLogger({ dir, enabled: () => enabled, maxBytes: 200, maxFiles: 2 });
      logger.log('info', 'test', 'hidden');
      expect(fs.existsSync(path.join(dir, 'main.log'))).toBe(false);
      enabled = true;
      logger.command(entry({ argv: ['fetch', 'https://u:pw@h/r'], exitCode: 128, stderr: 'fatal: nope' }));
      const text = fs.readFileSync(path.join(dir, 'main.log'), 'utf8');
      expect(text).toContain('git fetch https://u:***@h/r');
      expect(text).toContain('fatal: nope');
      for (let i = 0; i < 20; i++) logger.log('debug', 'x', `line ${i} ${'y'.repeat(40)}`);
      expect(fs.existsSync(path.join(dir, 'main.1.log'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'main.2.log'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'main.3.log'))).toBe(false);
      expect(fs.statSync(path.join(dir, 'main.log')).size).toBeLessThanOrEqual(200);

      const fake = { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
      const untap = logger.tapConsole(fake as unknown as Console);
      (fake as unknown as Console).warn('[askpass] something %d', 42);
      untap();
      expect(fs.readFileSync(path.join(dir, 'main.log'), 'utf8')).toContain('[askpass] something 42');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('DesktopNotifier (spec 01 §4.10)', () => {
  it('notifies only when enabled and unfocused; background successes stay silent', () => {
    let enabled = true;
    let focused = false;
    let t = 0;
    const show = vi.fn(() => true);
    const n = new DesktopNotifier({
      enabled: () => enabled,
      isFocused: () => focused,
      show,
      now: () => t,
      repoName: () => 'api',
    });
    const ev = (
      state: 'running' | 'succeeded' | 'failed',
      type: 'push' | 'fetch' | 'wip.stage' = 'push',
    ) => ({
      opId: `${type}-1`,
      type,
      label: type === 'push' ? 'Push main' : type,
      state,
      ...(state === 'failed' ? { error: makeError('NetworkUnreachable', { argv: [] }) } : {}),
    });
    n.onOpState(R1, ev('running'));
    n.onOpState(R1, ev('succeeded'));
    expect(show).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Push main finished — api' }));
    // quick local op: no notification
    n.onOpState(R1, ev('running', 'wip.stage'));
    n.onOpState(R1, ev('succeeded', 'wip.stage'));
    expect(show).toHaveBeenCalledTimes(1);
    // long local op: notification
    n.onOpState(R1, ev('running', 'wip.stage'));
    t += 5000;
    n.onOpState(R1, ev('succeeded', 'wip.stage'));
    expect(show).toHaveBeenCalledTimes(2);
    // background fetch: silent on success, failure only with autoFetchErrors
    n.onOpState(R1, ev('succeeded', 'fetch'), { background: true });
    n.onOpState(R1, ev('failed', 'fetch'), { background: true, notifyBackgroundFailure: false });
    expect(show).toHaveBeenCalledTimes(2);
    n.onOpState(R1, ev('failed', 'fetch'), { background: true, notifyBackgroundFailure: true });
    expect(show).toHaveBeenCalledTimes(3);
    // focused or disabled: nothing
    focused = true;
    n.onOpState(R1, ev('failed'));
    expect(n.notify('x')).toBe(false);
    focused = false;
    enabled = false;
    n.onOpState(R1, ev('failed'));
    expect(show).toHaveBeenCalledTimes(3);
    enabled = true;
    focused = true;
    expect(n.notify('forced', undefined, true)).toBe(true);
  });
});

describe('createBehaviourServices wiring', () => {
  it('provides a handler for every behaviour channel and works with SettingsStore', async () => {
    const { createBehaviourServices } = await import('../src/main/behaviour');
    const { SettingsStore } = await import('../src/main/settings/settings-store');
    const { BEHAVIOUR_INVOKE_CHANNELS } = await import('../src/shared/ipc/behaviour-contract');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-wiring-'));
    try {
      const settings = new SettingsStore({ dir });
      settings.load();
      const events: string[] = [];
      const b = createBehaviourServices({
        settings,
        repos: () => null,
        userDataDir: dir,
        broadcast: (e) => events.push(e),
        toast: () => undefined,
        isOnline: () => true,
        isFocused: () => true,
        showNotification: () => true,
        openPath: () => undefined,
      });
      expect(Object.keys(b.handlers).sort()).toEqual([...BEHAVIOUR_INVOKE_CHANNELS].sort());
      expect(b.repoManagerOptions.identity()).toMatchObject({ name: settings.activeProfile.authorName });
      b.onCommand(entry({ cwd: '/not/open' }));
      expect(b.outputLog.list('' as RepoId)).toHaveLength(1);
      expect(events).toEqual([]); // commands outside an open repo are not broadcast
      await b.handlers['logs:open']({}, { senderId: 1 });
      expect(fs.existsSync(path.join(dir, 'logs'))).toBe(true);
      b.dispose();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
