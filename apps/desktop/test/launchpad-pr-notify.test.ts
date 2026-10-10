import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { prUid, type PrNotification } from '@githappens/launchpad';
import {
  ProviderError,
  type ConnectedIntegration,
  type HostingProvider,
  type MyPullRequest,
  type PullRequest,
} from '@githappens/providers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LaunchpadService, type LaunchpadDeps } from '../src/main/launchpad/launchpad-service';
import { PR_NOTIFY_FILE, PrNotifier, type PrNotificationDeps } from '../src/main/launchpad/pr-notifier';

/**
 * Launchpad PR notifications end to end in main: fake hosting providers (no network) → refresh →
 * diff against the persisted snapshot → `launchpad:prNotifications` + OS notification.
 */

const NOW = Date.parse('2026-10-09T12:00:00Z');
const GH: ConnectedIntegration = {
  kind: 'github',
  host: 'github.com',
  accountId: '1',
  key: 'github:github.com:1',
  login: 'me',
  authType: 'pat',
  scopes: [],
  connectedAt: 0,
};
const REPO = {
  integration: { kind: GH.kind, host: GH.host, accountId: GH.accountId },
  owner: 'acme',
  name: 'app',
};

function pr(
  n: number,
  o: Partial<PullRequest> & { viewer?: Partial<PullRequest['viewer']> } = {},
): PullRequest {
  const { viewer, ...rest } = o;
  return {
    repo: REPO,
    number: n,
    id: `PR_${n}`,
    title: `PR ${n}`,
    body: 'long body',
    state: 'open',
    author: { id: '2', login: 'alice' },
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-08T00:00:00Z',
    head: { repo: REPO, branch: `b${n}`, sha: 'a' },
    base: { repo: REPO, branch: 'main' },
    reviewers: [],
    assignees: [],
    labels: [],
    reviewDecision: null,
    mergeable: 'unknown',
    checksRollup: 'pending',
    rollup: 'pending',
    commentsCount: 0,
    webUrl: `https://github.com/acme/app/pull/${n}`,
    isCrossRepository: false,
    viewer: {
      canMerge: false,
      canEdit: false,
      canApprove: true,
      isAuthor: false,
      reviewRequested: false,
      ...viewer,
    },
    allowedMergeMethods: ['merge'],
    ...rest,
  };
}
const requested = (n: number): MyPullRequest => ({
  pr: pr(n, { viewer: { reviewRequested: true } }),
  involvement: ['review-requested'],
});
const mine = (n: number, o: Partial<PullRequest> = {}): MyPullRequest => ({
  pr: pr(n, { author: { id: '1', login: 'me' }, viewer: { isAuthor: true }, ...o }),
  involvement: ['author'],
});

let dir: string;
let now: number;
let emitted: Array<{ event: string; payload: unknown }>;
let shown: Array<{ title: string; body?: string; onClick?: () => void }>;
let result: () => Promise<MyPullRequest[]>;
let flags: { enabled: boolean; desktop: boolean; online: boolean; focused: boolean; supported: boolean };
let focusCalls: number;
const services: LaunchpadService[] = [];

const profileDir = (): string => path.join(dir, 'profiles', 'default');

function notifyDeps(): PrNotificationDeps {
  return {
    enabled: () => flags.enabled,
    desktopEnabled: () => flags.desktop,
    isOnline: () => flags.online,
    isFocused: () => flags.focused,
    showNotification: (n) => {
      if (!flags.supported) return false;
      shown.push(n);
      return true;
    },
    focusWindow: () => void focusCalls++,
  };
}

function make(extra: Partial<LaunchpadDeps> = {}): LaunchpadService {
  const svc = new LaunchpadService({
    integrations: {
      list: () => [GH],
      provider: () =>
        ({ searchMyPullRequests: () => result(), matchRemoteUrl: () => null }) as unknown as HostingProvider,
      tracker: () => {
        throw new Error('no tracker');
      },
    },
    openRepos: () => [],
    wips: async () => [],
    profileDir,
    cacheDir: () => path.join(dir, 'cache'),
    emit: (event, payload) => emitted.push({ event, payload }),
    now: () => now,
    prNotifications: notifyDeps(),
    ...extra,
  });
  services.push(svc);
  return svc;
}

/** Let the post-refresh classification (async) run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

async function refresh(svc: LaunchpadService, data: MyPullRequest[]): Promise<PrNotification[]> {
  result = async () => data;
  const before = emitted.length;
  await svc.refresh();
  await settle();
  return emitted
    .slice(before)
    .filter((e) => e.event === 'launchpad:prNotifications')
    .flatMap((e) => (e.payload as { notifications: PrNotification[] }).notifications);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-prnotify-'));
  now = NOW;
  emitted = [];
  shown = [];
  focusCalls = 0;
  result = async () => [];
  flags = { enabled: true, desktop: true, online: true, focused: false, supported: true };
});
afterEach(() => {
  for (const s of services.splice(0)) s.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('Launchpad PR notifications (service)', () => {
  it('first refresh is a silent baseline; new events notify with toast + OS notification', async () => {
    const svc = make();
    expect(await refresh(svc, [requested(1), mine(2)])).toEqual([]);
    expect(shown).toEqual([]);
    expect(fs.existsSync(path.join(profileDir(), PR_NOTIFY_FILE))).toBe(true);

    const out = await refresh(svc, [requested(1), mine(2, { reviewDecision: 'approved' }), requested(3)]);
    expect(out.map((n) => [n.kind, n.title])).toEqual([
      ['approved', 'Pull request approved: acme/app#2'],
      ['review-requested', 'Review requested: acme/app#3'],
    ]);
    // payload items are list-only
    expect(out[0]!.item?.type === 'pr' && out[0]!.item.pr.body).toBe('');
    expect(shown.map((s) => s.title)).toEqual(out.map((n) => n.title));

    // OS click → focus + open that PR in the renderer
    shown[1]!.onClick!();
    expect(focusCalls).toBe(1);
    const open = emitted.find((e) => e.event === 'launchpad:openNotification')!.payload as {
      id: string;
      item?: { uid: string };
    };
    expect(open.item?.uid).toBe(prUid(requested(3).pr));

    // unchanged data → nothing
    expect(await refresh(svc, [requested(1), mine(2, { reviewDecision: 'approved' }), requested(3)])).toEqual(
      [],
    );
  });

  it('a restart neither re-notifies nor re-baselines (persisted snapshot)', async () => {
    const a = make();
    await refresh(a, [mine(1)]);
    expect(await refresh(a, [mine(1, { checksRollup: 'failure' })])).toHaveLength(1);
    a.dispose();

    const b = make();
    // same state after restart → quiet
    expect(await refresh(b, [mine(1, { checksRollup: 'failure' })])).toEqual([]);
    // but a change since the last run is still caught (no silent re-baseline)
    expect(await refresh(b, [mine(1, { checksRollup: 'failure' }), requested(5)])).toHaveLength(1);
  });

  it('setting off → no toast / OS notification, and no backlog when turned back on', async () => {
    const svc = make();
    await refresh(svc, []);
    flags.enabled = false;
    expect(await refresh(svc, [requested(1)])).toEqual([]);
    expect(shown).toEqual([]);
    flags.enabled = true;
    expect(await refresh(svc, [requested(1)])).toEqual([]);
    expect(await refresh(svc, [requested(1), requested(2)])).toHaveLength(1);
  });

  it('notifications.desktop off or a focused window → toast only', async () => {
    const svc = make();
    await refresh(svc, []);
    flags.desktop = false;
    expect(await refresh(svc, [requested(1)])).toHaveLength(1);
    flags.desktop = true;
    flags.focused = true;
    expect(await refresh(svc, [requested(1), requested(2)])).toHaveLength(1);
    expect(shown).toEqual([]);
  });

  it('unsupported OS notifications still toast', async () => {
    flags.supported = false;
    const svc = make();
    await refresh(svc, []);
    expect(await refresh(svc, [requested(1)])).toHaveLength(1);
  });

  it('offline → no events, and the next online refresh diffs against the old snapshot', async () => {
    const svc = make();
    await refresh(svc, []);
    flags.online = false;
    expect(await refresh(svc, [requested(1)])).toEqual([]);
    flags.online = true;
    expect(await refresh(svc, [requested(1)])).toHaveLength(1);
  });

  it('snoozed PRs do not notify', async () => {
    const svc = make();
    await refresh(svc, []);
    svc.setItemState({
      uid: prUid(requested(1).pr),
      snooze: { indefinite: true, snoozedAt: new Date(now).toISOString() },
    });
    expect(await refresh(svc, [requested(1)])).toEqual([]);
  });

  it('batches more than 3 events into one notification that opens the Launchpad', async () => {
    const svc = make();
    await refresh(svc, []);
    const out = await refresh(svc, [1, 2, 3, 4].map(requested));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'batch', title: '4 pull requests need attention', count: 4 });
    expect(shown).toHaveLength(1);
    shown[0]!.onClick!();
    const open = emitted.find((e) => e.event === 'launchpad:openNotification')!.payload as { item?: unknown };
    expect(open.item).toBeUndefined();
  });

  it('a failing source produces no events from its cached items', async () => {
    const svc = make();
    await refresh(svc, [mine(1)]);
    result = async () => {
      throw new ProviderError({ code: 'network', message: 'offline' });
    };
    await svc.refresh();
    await settle();
    expect(emitted.some((e) => e.event === 'launchpad:prNotifications')).toBe(false);
    expect(await refresh(svc, [mine(1, { checksRollup: 'failure' })])).toHaveLength(1);
  });

  it('per-profile state files', async () => {
    let profile = 'default';
    const svc = make({ profileDir: () => path.join(dir, 'profiles', profile) });
    await refresh(svc, []);
    expect(await refresh(svc, [requested(1)])).toHaveLength(1);
    profile = 'work';
    // new profile: silent baseline
    expect(await refresh(svc, [requested(1), requested(2)])).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'profiles', 'work', PR_NOTIFY_FILE))).toBe(true);
  });

  it('without prNotifications deps nothing is emitted', async () => {
    const svc = make({ prNotifications: undefined });
    await refresh(svc, []);
    expect(await refresh(svc, [requested(1)])).toEqual([]);
    expect(fs.existsSync(path.join(profileDir(), PR_NOTIFY_FILE))).toBe(false);
  });
});

describe('PrNotifier', () => {
  it('a corrupt state file re-baselines silently', () => {
    fs.mkdirSync(profileDir(), { recursive: true });
    fs.writeFileSync(path.join(profileDir(), PR_NOTIFY_FILE), '{nope');
    const events: unknown[] = [];
    const n = new PrNotifier({
      ...notifyDeps(),
      profileDir,
      emit: (e, p) => events.push([e, p]),
      now: () => now,
    });
    expect(n.onRefresh([], [GH.key])).toEqual([]);
    const saved = JSON.parse(fs.readFileSync(path.join(profileDir(), PR_NOTIFY_FILE), 'utf8'));
    expect(saved).toMatchObject({ version: 1, accounts: [GH.key] });
  });

  it('throwing hooks are treated as off', () => {
    const n = new PrNotifier({
      ...notifyDeps(),
      isOnline: () => {
        throw new Error('x');
      },
      profileDir,
      emit: () => undefined,
      now: () => now,
    });
    expect(n.onRefresh([], [GH.key])).toEqual([]);
    expect(fs.existsSync(path.join(profileDir(), PR_NOTIFY_FILE))).toBe(false);
  });
});

describe('background refresh (main process, PR notifications)', () => {
  const MIN = 60_000;
  let calls: number;
  let minutes: number;
  let accounts: ConnectedIntegration[];

  /** Service whose provider counts searches; `now` follows the fake clock. */
  function bg(extra: Partial<LaunchpadDeps> = {}): LaunchpadService {
    return make({
      now: () => Date.now(),
      integrations: {
        list: () => accounts,
        provider: () =>
          ({
            searchMyPullRequests: () => {
              calls++;
              return result();
            },
            matchRemoteUrl: () => null,
          }) as unknown as HostingProvider,
        tracker: () => {
          throw new Error('no tracker');
        },
      },
      prNotifications: { ...notifyDeps(), refreshMinutes: () => minutes },
      ...extra,
    });
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(NOW);
    calls = 0;
    minutes = 3;
    accounts = [GH];
    result = async () => [requested(1)];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Advance the fake clock and let the async refresh pipeline run. */
  async function advance(ms: number): Promise<void> {
    // 1 s slices so each fired timer's async refresh settles (setImmediate stays real)
    for (let left = ms; left > 0; left -= 1_000) {
      await vi.advanceTimersByTimeAsync(Math.min(1_000, left));
      await settle();
    }
  }

  it('refreshes every interval while enabled; a runtime toggle takes effect on the next tick', async () => {
    const svc = bg();
    svc.start();
    await advance(5_000); // startup refresh (3 s)
    expect(calls).toBe(1);
    await advance(3 * MIN + 2_000);
    expect(calls).toBe(2);
    flags.enabled = false;
    await advance(10 * MIN);
    expect(calls).toBe(2);
    flags.enabled = true;
    await advance(3 * MIN + 2_000);
    expect(calls).toBe(3);
  });

  it('notifies from background refreshes (unfocused window, renderer not polling)', async () => {
    result = async () => [];
    const svc = bg();
    svc.start();
    await advance(5_000);
    result = async () => [requested(7)];
    await advance(3 * MIN + 2_000);
    expect(shown.map((s) => s.title)).toEqual(['Review requested: acme/app#7']);
  });

  it('interval follows launchpad.refreshMinutes with a 3 min floor', async () => {
    minutes = 1;
    const svc = bg();
    svc.start();
    await advance(5_000);
    await advance(2 * MIN);
    expect(calls).toBe(1); // 1 min setting → still 3 min
    await advance(MIN + 2_000);
    expect(calls).toBe(2);
    minutes = 10;
    await advance(3 * MIN + 2_000); // the timer armed with 3 min fires once more, then re-arms with 10
    const after = calls;
    await advance(5 * MIN);
    expect(calls).toBe(after); // now on 10 min
  });

  it('no integrations / offline / suspended / screen locked → no requests', async () => {
    accounts = [];
    const svc = bg();
    svc.start();
    await advance(30 * MIN);
    expect(calls).toBe(0);

    accounts = [GH];
    flags.online = false;
    await advance(10 * MIN);
    expect(calls).toBe(0);
    flags.online = true;

    svc.onSuspend();
    await advance(10 * MIN);
    expect(calls).toBe(0);
    svc.onResume();
    await advance(3 * MIN + 2_000);
    expect(calls).toBe(1);

    svc.setScreenLocked(true);
    await advance(10 * MIN);
    expect(calls).toBe(1);
    svc.setScreenLocked(false);
    await advance(3 * MIN + 2_000);
    expect(calls).toBe(2);
  });

  it('skips while the renderer keeps the snapshot fresh (no double refresh)', async () => {
    const svc = bg();
    svc.start();
    await advance(5_000);
    expect(calls).toBe(1);
    // renderer polls every 2 minutes
    for (let i = 0; i < 5; i++) {
      await advance(2 * MIN);
      await svc.refresh();
    }
    expect(calls).toBe(6); // only the renderer's refreshes
  });

  it('backs off while every PR source is rate-limited', async () => {
    const svc = bg();
    svc.start();
    const retryAt = Date.now() + 30 * MIN;
    result = async () => {
      throw new ProviderError({ code: 'rate_limited', message: 'slow down', retryAt });
    };
    await advance(5_000);
    expect(calls).toBe(1);
    await advance(20 * MIN);
    expect(calls).toBe(1); // backing off until the reset
    result = async () => [requested(1)];
    await advance(12 * MIN);
    expect(calls).toBe(2);
  });

  it('coalesces with an in-flight refresh', async () => {
    let release!: () => void;
    const svc = bg();
    result = () =>
      new Promise((r) => {
        release = () => r([requested(1)]);
      });
    const manual = svc.refresh();
    expect(calls).toBe(1);
    expect(await svc.backgroundTick()).toBe(false);
    expect(calls).toBe(1);
    release();
    await manual;
  });

  it('a direct tick runs when stale and enabled, not otherwise', async () => {
    const svc = bg();
    expect(await svc.backgroundTick()).toBe(true);
    expect(calls).toBe(1);
    expect(await svc.backgroundTick()).toBe(false); // fresh
    const off = bg({ prNotifications: undefined });
    expect(await off.backgroundTick()).toBe(false);
  });
});
