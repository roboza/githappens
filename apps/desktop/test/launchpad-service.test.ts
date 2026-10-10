import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { prUid, snoozeFor, type WipStatus } from '@githappens/launchpad';
import {
  ProviderError,
  type ConnectedIntegration,
  type HostingProvider,
  type Issue,
  type IssueTracker,
  type MyPullRequest,
  type PullRequest,
} from '@githappens/providers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLaunchpadHandlers } from '../src/main/ipc/launchpad-handlers';
import {
  LaunchpadService,
  serializeError,
  type LaunchpadDeps,
} from '../src/main/launchpad/launchpad-service';
import { STATE_GC_MS } from '../src/main/launchpad/launchpad-store';

const NOW = Date.parse('2026-10-09T12:00:00Z');

const account = (
  kind: ConnectedIntegration['kind'],
  host: string,
  id: string,
  login = 'me',
): ConnectedIntegration => ({
  kind,
  host,
  accountId: id,
  key: `${kind}:${host}:${id}`,
  login,
  authType: 'pat',
  scopes: [],
  connectedAt: 0,
});
const GH = account('github', 'github.com', '1');
const GL = account('gitlab', 'gitlab.com', '7');
const JIRA = account('jira-cloud', 'acme.atlassian.net', 'J1');

function pr(
  o: Partial<PullRequest> & { owner?: string; name?: string; acc?: ConnectedIntegration } = {},
): PullRequest {
  const acc = o.acc ?? GH;
  const repo = {
    integration: { kind: acc.kind, host: acc.host, accountId: acc.accountId },
    owner: o.owner ?? 'acme',
    name: o.name ?? 'app',
  };
  const { owner: _o, name: _n, acc: _a, ...rest } = o;
  return {
    repo,
    number: 1,
    id: 'PR_1',
    title: 'Add login',
    body: 'long body',
    state: 'open',
    author: { id: '2', login: 'alice' },
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-08T00:00:00Z',
    head: { repo, branch: 'feature/login', sha: 'a' },
    base: { repo, branch: 'main' },
    reviewers: [],
    assignees: [],
    labels: [],
    reviewDecision: null,
    mergeable: 'unknown',
    checksRollup: 'pending',
    rollup: 'pending',
    commentsCount: 0,
    webUrl: 'https://example/pr/1',
    isCrossRepository: false,
    viewer: { canMerge: false, canEdit: false, canApprove: true, isAuthor: false, reviewRequested: true },
    allowedMergeMethods: ['merge'],
    ...rest,
  };
}

const jiraIssue = (key: string): Issue => ({
  tracker: {
    kind: 'jira-cloud',
    integration: { kind: 'jira-cloud', host: JIRA.host, accountId: 'J1' },
    scope: 'ABC',
  },
  key,
  id: key,
  title: `Issue ${key}`,
  body: 'desc',
  bodyFormat: 'markdown',
  state: 'To Do',
  stateCategory: 'todo',
  assignees: [{ id: 'J1', login: 'me' }],
  labels: [],
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-07T00:00:00Z',
  webUrl: `https://acme.atlassian.net/browse/${key}`,
});

const ghMatch = (url: string) => {
  const m = /github\.com[/:]([^/]+)\/([^/.]+)/.exec(url);
  return m ? { owner: m[1]!, name: m[2]! } : null;
};

interface Fakes {
  accounts: ConnectedIntegration[];
  prs: Record<string, () => Promise<MyPullRequest[]>>;
  issues: Record<string, () => Promise<Array<{ issue: Issue; involvement: never[] | Array<'assignee'> }>>>;
  team?: Record<string, PullRequest[]>;
  calls: Record<string, number>;
}

function fakeIntegrations(f: Fakes): LaunchpadDeps['integrations'] {
  return {
    list: () => f.accounts,
    provider: (key) => {
      if (!f.prs[key]) throw new Error('not a hosting account');
      return {
        searchMyPullRequests: () => {
          f.calls[key] = (f.calls[key] ?? 0) + 1;
          return f.prs[key]!();
        },
        matchRemoteUrl: (url: string) => (key.startsWith('github') ? ghMatch(url) : null),
        listPullRequests: async (ref: { owner: string; name: string }) => ({
          items: f.team?.[`${ref.owner}/${ref.name}`] ?? [],
        }),
      } as unknown as HostingProvider;
    },
    tracker: (key) => {
      if (!f.issues[key]) throw new Error('no tracker');
      return { searchMyIssues: () => f.issues[key]!() } as unknown as IssueTracker;
    },
  };
}

let dir: string;
let now: number;
let emitted: Array<{ event: string; payload: unknown }>;
let fakes: Fakes;
let wips: Array<WipStatus & { remotes?: string[] }>;
let openRepos: Array<{ path: string; branch?: string; remotes?: string[] }>;
const services: LaunchpadService[] = [];

function makeService(extra: Partial<LaunchpadDeps> = {}): LaunchpadService {
  const svc = new LaunchpadService({
    integrations: fakeIntegrations(fakes),
    openRepos: () => openRepos,
    wips: async () => wips,
    profileDir: () => path.join(dir, 'profiles', 'default'),
    cacheDir: () => path.join(dir, 'cache'),
    emit: (event, payload) => emitted.push({ event, payload }),
    now: () => now,
    ...extra,
  });
  services.push(svc);
  return svc;
}

const ALL = { scope: { kind: 'all' as const }, mode: 'personal' as const };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-launchpad-'));
  now = NOW;
  emitted = [];
  wips = [];
  openRepos = [];
  fakes = {
    accounts: [GH, GL, JIRA],
    prs: {
      [GH.key]: async () => [{ pr: pr(), involvement: ['review-requested'] }],
      [GL.key]: async () => {
        throw new ProviderError({ code: 'token_expired', message: 'GitLab token expired' });
      },
    },
    issues: { [JIRA.key]: async () => [{ issue: jiraIssue('ABC-1'), involvement: ['assignee'] }] },
    calls: {},
  };
});
afterEach(() => {
  for (const s of services.splice(0)) s.dispose();
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('LaunchpadService', () => {
  it('fans out per integration and reports partial failures as errors', async () => {
    const svc = makeService();
    const r = await svc.query({ filters: ALL, tab: 'all' });
    expect(r.items.map((i) => [i.type, i.group])).toEqual([
      ['pr', 'needs-review'],
      ['issue', 'todo'],
    ]);
    expect(r.errors).toEqual([
      {
        source: GL.key,
        label: 'GitLab (gitlab.com)',
        error: expect.objectContaining({ code: 'token_expired' }),
      },
    ]);
    expect(r.summary).toMatchObject({ needsReview: 1, partial: true });
    expect(r.counts).toEqual({ prs: 1, issues: 1, wips: 0, all: 2, snoozed: 0 });
    expect(r.hasIntegrations).toBe(true);
    expect(emitted.at(-1)?.event).toBe('launchpad:updated');
  });

  it('dedupes by uid and merges involvement', async () => {
    fakes.prs[GH.key] = async () => [
      { pr: pr(), involvement: ['assignee'] },
      { pr: pr({ title: 'Add login (v2)', updatedAt: '2026-10-09T00:00:00Z' }), involvement: ['mentioned'] },
    ];
    const svc = makeService();
    const r = await svc.query({ filters: ALL, tab: 'prs' });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.title).toBe('Add login (v2)');
    expect(r.items[0]!.involvement).toEqual(
      expect.arrayContaining(['assignee', 'mentioned', 'review-requested']),
    );
  });

  it('persists pins across restarts and keeps the status group', async () => {
    const svc = makeService();
    await svc.query({ filters: ALL, tab: 'all' });
    const uid = prUid(pr());
    expect(svc.setItemState({ uid, pin: true })).toMatchObject({
      uid,
      pinnedAt: new Date(NOW).toISOString(),
    });
    const again = makeService();
    const r = await again.query({ filters: ALL, tab: 'prs' });
    expect(r.items[0]).toMatchObject({ group: 'pinned', statusGroup: 'needs-review' });
    expect(again.setItemState({ uid, pin: false })).toBeNull();
    expect((await again.query({ filters: ALL, tab: 'prs' })).items[0]!.group).toBe('needs-review');
  });

  it('snoozes until expiry, then the item returns (timer emits an update)', async () => {
    vi.useFakeTimers({ now: NOW });
    const svc = makeService({ now: undefined });
    await svc.query({ filters: ALL, tab: 'all' });
    const uid = prUid(pr());
    svc.setItemState({ uid, snooze: snoozeFor('1h', Date.now()) });
    let r = await svc.query({ filters: ALL, tab: 'prs' });
    expect(r.items).toHaveLength(0);
    expect(r.counts.snoozed).toBe(1);
    expect((await svc.query({ filters: ALL, tab: 'snoozed' })).items[0]!.group).toBe('snoozed');
    expect(r.summary.needsReview).toBe(0);

    emitted = [];
    await vi.advanceTimersByTimeAsync(3_600_000 + 100);
    expect(emitted.some((e) => e.event === 'launchpad:updated')).toBe(true);
    r = await svc.query({ filters: ALL, tab: 'prs' });
    expect(r.items[0]!.group).toBe('needs-review');
  });

  it('pinning clears a snooze and snoozing clears a pin', async () => {
    const svc = makeService();
    const uid = 'pr:x';
    svc.setItemState({ uid, pin: true });
    expect(svc.setItemState({ uid, snooze: snoozeFor('indefinite', now) })).toMatchObject({
      snooze: { indefinite: true },
    });
    expect(svc.setItemState({ uid, pin: true })?.snooze).toBeUndefined();
    expect(svc.setItemState({ uid, pin: false })).toBeNull();
  });

  it('paints from the disk cache on startup and refreshes in the background', async () => {
    const first = makeService();
    await first.query({ filters: ALL, tab: 'all' });
    const cache = JSON.parse(fs.readFileSync(path.join(dir, 'cache', 'launchpad-default.json'), 'utf8'));
    expect(cache.sources.flatMap((s: any) => s.items).find((i: any) => i.type === 'pr').pr.body).toBe('');

    let release!: () => void;
    fakes.prs[GH.key] = () =>
      new Promise((res) => (release = () => res([{ pr: pr({ title: 'Fresh' }), involvement: [] }])));
    const second = makeService();
    const r = await second.query({ filters: ALL, tab: 'prs' });
    expect(r.stale).toBe(true);
    expect(r.refreshing).toBe(true);
    expect(r.items[0]!.title).toBe('Add login');
    release();
    await second.refresh();
    const r2 = await second.query({ filters: ALL, tab: 'prs' });
    expect(r2.stale).toBe(false);
    expect(r2.items[0]!.title).toBe('Fresh');
  });

  it('skips a rate-limited source until its reset and keeps its cached items', async () => {
    let fail = false;
    fakes.prs[GH.key] = async () => {
      if (fail)
        throw new ProviderError({ code: 'rate_limited', message: 'slow down', retryAt: NOW + 60_000 });
      return [{ pr: pr(), involvement: [] }];
    };
    const svc = makeService();
    await svc.refresh();
    fail = true;
    await svc.refresh();
    expect(fakes.calls[GH.key]).toBe(2);
    let r = await svc.query({ filters: ALL, tab: 'prs' });
    expect(r.items).toHaveLength(1);
    expect(r.errors.find((e) => e.source === GH.key)?.error.code).toBe('rate_limited');
    await svc.refresh();
    expect(fakes.calls[GH.key]).toBe(2); // skipped
    await svc.refresh({ force: true });
    expect(fakes.calls[GH.key]).toBe(3);
    now = NOW + 120_000;
    fail = false;
    await svc.refresh();
    r = await svc.query({ filters: ALL, tab: 'prs' });
    expect(r.errors.find((e) => e.source === GH.key)).toBeUndefined();
  });

  it('adds WIPs with changes, maps PRs to local repos and detects the current branch', async () => {
    wips = [
      {
        path: 'C:\\code\\app',
        name: 'app',
        branch: 'main',
        staged: 0,
        unstaged: 3,
        untracked: 1,
        conflicted: 0,
      },
      { path: 'C:\\code\\clean', name: 'clean', staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
    ];
    openRepos = [
      { path: 'C:\\code\\app', branch: 'feature/login', remotes: ['git@github.com:acme/app.git'] },
    ];
    const svc = makeService();
    const r = await svc.query({ filters: ALL, tab: 'all' });
    const p = r.items.find((i) => i.type === 'pr')!;
    expect(p.group).toBe('current-branch');
    expect(p.repo?.localPath).toBe('C:\\code\\app');
    expect(r.items.filter((i) => i.type === 'wip').map((i) => i.title)).toEqual(['app']);
    expect(r.counts.wips).toBe(1);
  });

  it('filters by workspace scope (provider repos + global trackers + local WIPs)', async () => {
    fakes.prs[GH.key] = async () => [
      { pr: pr(), involvement: [] },
      { pr: pr({ number: 2, id: 'PR_2', name: 'other' }), involvement: [] },
    ];
    wips = [
      { path: '/code/app', name: 'app', staged: 1, unstaged: 0, untracked: 0, conflicted: 0 },
      { path: '/code/zzz', name: 'zzz', staged: 1, unstaged: 0, untracked: 0, conflicted: 0 },
    ];
    const svc = makeService({
      workspaceRepos: async (id) =>
        id === 'ws1' ? [{ localPath: '/code/app', remotes: ['https://github.com/acme/app.git'] }] : null,
    });
    const r = await svc.query({
      filters: { scope: { kind: 'workspace', workspaceId: 'ws1' }, mode: 'personal' },
      tab: 'all',
    });
    expect(r.items.map((i) => i.title).sort()).toEqual(['Add login', 'Issue ABC-1', 'app']);
  });

  it('team mode lists every open PR of the workspace repos', async () => {
    fakes.team = {
      'acme/app': [
        pr({
          number: 5,
          id: 'PR_5',
          viewer: {
            canMerge: false,
            canEdit: false,
            canApprove: true,
            isAuthor: false,
            reviewRequested: false,
          },
        }),
      ],
    };
    const svc = makeService({
      workspaceRepos: async () => [{ integrationKey: GH.key, owner: 'acme', name: 'app' }],
    });
    const team = { scope: { kind: 'workspace' as const, workspaceId: 'ws1' }, mode: 'team' as const };
    const r = await svc.query({ filters: team, tab: 'prs' });
    expect(r.items.map((i) => [i.type === 'pr' && i.pr.number, i.group])).toEqual([[5, 'other']]);
    const bad = await svc.query({ filters: { ...ALL, mode: 'team' }, tab: 'prs' });
    expect(bad.teamUnavailable).toBe(true);
  });

  it('applies filters and tab counts', async () => {
    const svc = makeService();
    const r = await svc.query({ filters: { ...ALL, providers: ['jira-cloud'] }, tab: 'all' });
    expect(r.items.map((i) => i.type)).toEqual(['issue']);
    expect(r.counts).toMatchObject({ prs: 0, issues: 1 });
  });

  it('saves, lists and deletes views; remembers last filters', async () => {
    const svc = makeService();
    const v = svc.saveView({ name: ' Reviews ', tab: 'prs', filters: ALL, groupBy: 'status' });
    expect(v.name).toBe('Reviews');
    expect(() => svc.saveView({ name: ' ', tab: 'prs', filters: ALL, groupBy: 'none' })).toThrow();
    await svc.query({ filters: { ...ALL, labels: ['bug'] }, tab: 'all' });
    const again = makeService();
    expect(again.views().views.map((x) => x.id)).toEqual([v.id]);
    expect(again.views().lastFilters.labels).toEqual(['bug']);
    again.deleteView(v.id);
    expect(makeService().views().views).toEqual([]);
  });

  it('recovers from a corrupt state file', async () => {
    const pdir = path.join(dir, 'profiles', 'default');
    fs.mkdirSync(pdir, { recursive: true });
    fs.writeFileSync(path.join(pdir, 'launchpad.json'), '{oops');
    const svc = makeService();
    expect(svc.views().views).toEqual([]);
    expect(fs.readdirSync(pdir).some((f) => f.startsWith('launchpad.json.bak-'))).toBe(true);
  });

  it('garbage-collects pin/snooze state unseen for 30 days', async () => {
    const svc = makeService();
    svc.setItemState({ uid: 'pr:gone', pin: true });
    now = NOW + STATE_GC_MS + 1000;
    await svc.refresh();
    expect(svc.store.get('pr:gone')).toBeUndefined();
  });

  it('summary + handlers', async () => {
    const svc = makeService();
    const h = createLaunchpadHandlers(svc);
    const ctx = { senderId: 1 };
    const s = await h['launchpad:summary']({}, ctx);
    expect(s).toMatchObject({ needsReview: 1, hasIntegrations: true });
    expect(s.top[0]).toMatchObject({ ref: 'acme/app#1', group: 'needs-review' });
    const r = await h['launchpad:refresh']({ force: true }, ctx);
    expect(r.fetchedAt).toBe(NOW);
    expect(() => h['launchpad:setItemState']({ uid: '' }, ctx)).toThrow('Invalid uid');
  });

  it('works without integrations (WIPs only)', async () => {
    fakes.accounts = [];
    wips = [{ path: '/code/app', name: 'app', staged: 1, unstaged: 0, untracked: 0, conflicted: 0 }];
    const svc = makeService();
    const r = await svc.query({ filters: ALL, tab: 'wips' });
    expect(r.hasIntegrations).toBe(false);
    expect(r.items).toHaveLength(1);
  });
});

describe('serializeError', () => {
  it.each([
    [new ProviderError({ code: 'auth_required', message: 'x' }), 'auth_required'],
    [{ serialized: { message: 'm', details: { providerCode: 'rate_limited', retryAt: 5 } } }, 'rate_limited'],
    [new Error('fetch failed'), 'network'],
    [new Error('boom'), 'server'],
  ])('%#', (e, code) => {
    expect(serializeError(e).code).toBe(code);
  });
});
