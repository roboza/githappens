import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { prItem } from '@githappens/launchpad';
import type {
  ConnectedIntegration,
  HostingProvider,
  IssueTracker,
  MyIssue,
  MyPullRequest,
  PullRequest,
} from '@githappens/providers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLaunchpadHandlers } from '../src/main/ipc/launchpad-handlers';
import { LaunchpadService, type LaunchpadDeps } from '../src/main/launchpad/launchpad-service';
import { LAUNCHPAD_INVOKE_CHANNELS } from '../src/shared/ipc/launchpad-contract';

// Spec budgets are asserted as-is only with PERF_STRICT=1; shared CI runners (and a busy parallel
// test run) are several times slower, so normal runs get 5x slack and only catch real regressions.
const slack = process.env.PERF_STRICT === '1' ? 1 : 5;

/** Spec 11 Phase 9: workspace PR counts, offline mode, Trello/Azure Boards sources, startup paint. */

const NOW = Date.parse('2026-10-09T12:00:00Z');
const acc = (kind: ConnectedIntegration['kind'], host: string, id: string): ConnectedIntegration => ({
  kind,
  host,
  accountId: id,
  key: `${kind}:${host}:${id}`,
  login: 'me',
  authType: 'pat',
  scopes: [],
  connectedAt: 0,
});
const GH = acc('github', 'github.com', '1');
const TRELLO = acc('trello', 'trello.com', 'm1');
const BOARDS = acc('azure-boards', 'dev.azure.com/acme', 'az1');

function pr(n: number, o: Partial<PullRequest> & { name?: string } = {}): PullRequest {
  const repo = {
    integration: { kind: 'github' as const, host: 'github.com', accountId: '1' },
    owner: 'acme',
    name: o.name ?? 'app',
  };
  const { name: _n, ...rest } = o;
  return {
    repo,
    number: n,
    id: `PR_${n}`,
    title: `PR ${n}`,
    body: 'body',
    state: 'open',
    author: { id: '2', login: 'alice' },
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: new Date(NOW - n * 60_000).toISOString(),
    head: { repo, branch: `b${n}`, sha: 'a' },
    base: { repo, branch: 'main' },
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
    viewer: { canMerge: false, canEdit: false, canApprove: true, isAuthor: false, reviewRequested: false },
    allowedMergeMethods: ['merge'],
    ...rest,
  };
}
const issue = (kind: 'trello' | 'azure-boards', key: string, scope: string): MyIssue => ({
  issue: {
    tracker: {
      kind,
      integration:
        kind === 'trello'
          ? { kind, host: 'trello.com', accountId: 'm1' }
          : { kind, host: 'dev.azure.com/acme', accountId: 'az1' },
      scope,
    },
    key,
    id: key,
    title: `${kind} ${key}`,
    body: '',
    bodyFormat: 'markdown',
    state: 'Doing',
    stateCategory: 'in_progress',
    assignees: [],
    labels: [],
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-08T00:00:00Z',
    webUrl: `https://example/${key}`,
  },
  involvement: ['assignee'],
});

let dir: string;
let calls: Record<string, number>;
let myPrs: () => Promise<MyPullRequest[]>;
let team: Record<string, PullRequest[]>;
const services: LaunchpadService[] = [];

function integrations(accounts: ConnectedIntegration[]): LaunchpadDeps['integrations'] {
  return {
    list: () => accounts,
    provider: (key) => {
      if (key !== GH.key) throw new Error('not hosting');
      return {
        searchMyPullRequests: () => {
          calls.prs = (calls.prs ?? 0) + 1;
          return myPrs();
        },
        matchRemoteUrl: (url: string) => {
          const m = /github\.com[/:]([^/]+)\/([^/.]+)/.exec(url);
          return m ? { owner: m[1]!, name: m[2]! } : null;
        },
        listPullRequests: async (ref: { owner: string; name: string }) => {
          calls.team = (calls.team ?? 0) + 1;
          return { items: team[`${ref.owner}/${ref.name}`] ?? [] };
        },
      } as unknown as HostingProvider;
    },
    tracker: (key) => {
      if (key === TRELLO.key)
        return {
          searchMyIssues: async () => [issue('trello', 'abC1', 'b1/Product')],
        } as unknown as IssueTracker;
      if (key === BOARDS.key)
        return {
          searchMyIssues: async () => [issue('azure-boards', '42', 'acme/Web')],
        } as unknown as IssueTracker;
      throw new Error('no tracker');
    },
  };
}

function make(accounts = [GH, TRELLO, BOARDS], extra: Partial<LaunchpadDeps> = {}): LaunchpadService {
  const svc = new LaunchpadService({
    integrations: integrations(accounts),
    openRepos: () => [],
    wips: async () => [],
    profileDir: () => path.join(dir, 'profiles', 'default'),
    cacheDir: () => path.join(dir, 'cache'),
    emit: () => undefined,
    now: () => NOW,
    workspaceRepos: async (id) =>
      id === 'ws1'
        ? [
            { id: 'r-app', localPath: '/code/app', remotes: ['https://github.com/acme/app.git'] },
            { id: 'r-api', integrationKey: GH.key, owner: 'acme', name: 'api' },
            { id: 'r-none', localPath: '/code/none' },
          ]
        : null,
    ...extra,
  });
  services.push(svc);
  return svc;
}

const ALL = { scope: { kind: 'all' as const }, mode: 'personal' as const };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-lp9-'));
  calls = {};
  team = {};
  myPrs = async () => [
    {
      pr: pr(1, {
        author: { id: '1', login: 'me' },
        viewer: { canMerge: true, canEdit: true, canApprove: false, isAuthor: true, reviewRequested: false },
      }),
      involvement: ['author'],
    },
    {
      pr: pr(2, {
        viewer: { canMerge: false, canEdit: false, canApprove: true, isAuthor: false, reviewRequested: true },
      }),
      involvement: ['review-requested'],
    },
  ];
});
afterEach(() => {
  for (const s of services.splice(0)) s.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('Launchpad issue sources (Trello, Azure Boards)', () => {
  it('lists Trello cards and Azure Boards work items next to PRs', async () => {
    const svc = make();
    const r = await svc.query({ filters: ALL, tab: 'issues' });
    expect(
      r.items.map((i) => [i.type === 'issue' && i.issue.tracker.kind, i.repo?.fullName, i.group]),
    ).toEqual([
      ['azure-boards', 'acme/Web', 'in-progress'],
      ['trello', 'Product', 'in-progress'],
    ]);
    expect(r.counts.prs).toBe(2);
    const filtered = await svc.query({ filters: { ...ALL, providers: ['trello'] }, tab: 'all' });
    expect(filtered.items).toHaveLength(1);
  });
});

describe('workspace PR counts', () => {
  it('counts mine / needs-review from personal data, totals once the team listing landed', async () => {
    team = {
      'acme/app': [pr(1), pr(2), pr(3), pr(4, { state: 'draft' })],
      'acme/api': [pr(9, { name: 'api' })],
    };
    const svc = make();
    await svc.refresh();
    const first = await svc.workspacePrCounts({ workspaceId: 'ws1' });
    expect(first.hasIntegrations).toBe(true);
    // personal snapshot already known; team refresh started in the background
    expect(first.counts['r-app']).toMatchObject({ mine: 1, needsMyReview: 1 });
    await svc.refresh({ workspaceId: 'ws1' });
    const r = await svc.workspacePrCounts({ workspaceId: 'ws1' });
    expect(r.complete).toBe(true);
    expect(r.counts).toEqual({
      'r-app': { total: 4, mine: 1, needsMyReview: 1 },
      'r-api': { total: 1, mine: 0, needsMyReview: 0 },
    });
    expect(await svc.workspacePrCounts({ workspaceId: 'nope' })).toMatchObject({
      counts: {},
      complete: false,
    });
  });

  it('is exposed as launchpad:prCounts and validates input', async () => {
    const svc = make();
    const h = createLaunchpadHandlers(svc);
    expect(Object.keys(h).sort()).toEqual([...LAUNCHPAD_INVOKE_CHANNELS].sort());
    await svc.refresh();
    const r = await h['launchpad:prCounts']({ workspaceId: 'ws1' }, {} as never);
    expect(r.counts['r-app']?.mine).toBe(1);
    expect(() => h['launchpad:prCounts']({ workspaceId: '' }, {} as never)).toThrow(/workspace id/);
  });
});

describe('offline (§6.5)', () => {
  it('makes no provider requests and serves the cached snapshot', async () => {
    const online = make();
    await online.query({ filters: ALL, tab: 'prs' });
    expect(calls.prs).toBe(1);
    const svc = make();
    const r = await svc.query({ filters: ALL, tab: 'prs', offline: true });
    expect(r.stale).toBe(true);
    expect(r.refreshing).toBe(false);
    expect(r.items).toHaveLength(2);
    await svc.summary({ offline: true });
    await svc.workspacePrCounts({ workspaceId: 'ws1', offline: true });
    expect(calls.prs).toBe(1);
    expect(calls.team).toBeUndefined();
  });

  it('without a cache it returns nothing rather than blocking on the network', async () => {
    const svc = make();
    const r = await svc.query({ filters: ALL, tab: 'prs', offline: true });
    expect(r.items).toEqual([]);
    expect(r.fetchedAt).toBeNull();
    expect(calls.prs).toBeUndefined();
  });
});

describe('startup paint from the disk cache (acceptance: < 300 ms)', () => {
  it('loads a 1,500-item cache and answers the first query fast', async () => {
    const items = Array.from({ length: 1500 }, (_, i) => prItem(pr(i + 1), i % 3 ? [] : ['author']));
    fs.mkdirSync(path.join(dir, 'cache'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'cache', 'launchpad-default.json'),
      JSON.stringify({
        version: 1,
        classifier: 1,
        fetchedAt: NOW - 60_000,
        sources: [{ key: `${GH.key}#prs`, label: 'GitHub', items, fetchedAt: NOW - 60_000 }],
      }),
    );
    // Providers hang: the first paint must not wait for them.
    myPrs = () => new Promise(() => undefined);
    // Fresh service per sample (each loads + parses the cache); median of 3 to absorb CI/agent load.
    const samples: number[] = [];
    let r!: Awaited<ReturnType<LaunchpadService['query']>>;
    for (let k = 0; k < 3; k++) {
      const t0 = performance.now();
      const svc = make([GH]);
      svc.start();
      r = await svc.query({ filters: ALL, tab: 'prs' });
      samples.push(performance.now() - t0);
    }
    const ms = samples.sort((a, b) => a - b)[1]!;
    console.info(`[perf] startup paint from cache (1,500 items): median ${ms.toFixed(1)} ms`);
    expect(r.stale).toBe(true);
    expect(r.items).toHaveLength(1500);
    expect(ms).toBeLessThan(300 * slack);
  });
});
