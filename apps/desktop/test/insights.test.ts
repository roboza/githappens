import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normalizeGitHubInsightsPr, type HostingProvider, type InsightsPr } from '@githappens/providers';
import { afterAll, describe, expect, it } from 'vitest';

import {
  computeDora,
  computePrMetrics,
  cycleTimeHrs,
  firstReviewHrs,
  globToRegExp,
  InsightsService,
  isoWeek,
  median,
  mergeToDeployLeadTimes,
  percentile,
  tagDeployEvents,
  weeksBetween,
} from '../src/main/cloud/insights';
import { createInsightsHandlers } from '../src/main/ipc/insights-handlers';
import { INSIGHTS_INVOKE_CHANNELS } from '../src/shared/ipc/insights-contract';
import type { Workspace } from '../src/shared/ipc/workspaces-contract';

const H = 3_600_000;
const T0 = Date.UTC(2026, 8, 1, 0, 0, 0); // Tue 2026-09-01

function pr(n: number, o: Partial<InsightsPr> & { createdH: number; mergedH: number }): InsightsPr {
  return {
    number: n,
    title: `PR ${n}`,
    author: o.author ?? 'ana',
    createdAt: new Date(T0 + o.createdH * H).toISOString(),
    mergedAt: new Date(T0 + o.mergedH * H).toISOString(),
    additions: o.additions ?? 10,
    deletions: o.deletions ?? 0,
    reviews: o.reviews ?? [],
    ...(o.readyAt ? { readyAt: o.readyAt } : {}),
  };
}

describe('insights calculators', () => {
  it('percentiles and medians', () => {
    expect(median([])).toBe(0);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(percentile([1, 2, 3, 4], 75)).toBe(3);
    expect(percentile([5], 90)).toBe(5);
  });

  it('ISO weeks', () => {
    expect(isoWeek('2026-01-01T00:00:00Z')).toBe('2026-W01');
    expect(isoWeek('2024-12-30T12:00:00Z')).toBe('2025-W01');
    expect(isoWeek('2026-10-10T00:00:00Z')).toBe('2026-W41');
    expect(weeksBetween(T0, T0 + 20 * 24 * H)).toEqual(['2026-W36', '2026-W37', '2026-W38', '2026-W39']);
  });

  it('cycle time, first review and size/load from fixtures', () => {
    const prs = [
      pr(1, { createdH: 0, mergedH: 10, reviews: [{ login: 'bo', at: new Date(T0 + 2 * H).toISOString() }] }),
      pr(2, {
        createdH: 0,
        mergedH: 30,
        readyAt: new Date(T0 + 10 * H).toISOString(), // draft: counts from ready-for-review
        additions: 400,
        reviews: [
          { login: 'ana', at: new Date(T0 + 11 * H).toISOString() }, // author's own review ignored
          { login: 'cy', at: new Date(T0 + 14 * H).toISOString() },
          { login: 'cy', at: new Date(T0 + 15 * H).toISOString() },
        ],
      }),
      pr(3, { createdH: 24 * 8, mergedH: 24 * 8 + 6, author: 'bo', additions: 2000, deletions: 5 }),
      pr(4, { createdH: -100, mergedH: -50 }), // merged before the range
    ];
    expect(cycleTimeHrs(prs[1]!)).toBe(20);
    expect(firstReviewHrs(prs[1]!)).toBe(4);
    const m = computePrMetrics(prs, { since: T0, until: T0 + 14 * 24 * H });
    expect(m.sampleSize).toBe(3);
    expect(m.prCycleTimeHrs).toEqual({ median: 10, p75: 20 });
    expect(m.timeToFirstReviewHrs).toEqual({ median: 3, p75: 4 });
    expect(m.mergedPerWeek).toEqual([
      { week: '2026-W36', count: 2 },
      { week: '2026-W37', count: 1 },
      { week: '2026-W38', count: 0 },
    ]);
    expect(m.cycleTimeTrend[0]).toEqual({ week: '2026-W36', medianHrs: 15 });
    expect(m.cycleTimeTrend[2]!.medianHrs).toBeNull();
    expect(m.prSize.buckets.map((b) => b.count)).toEqual([1, 0, 0, 1, 1]);
    expect(m.reviewLoad).toEqual([
      { reviewer: 'bo', count: 1 },
      { reviewer: 'cy', count: 1 },
    ]);
    expect(m.authors).toEqual(['ana', 'bo']);
    const onlyBo = computePrMetrics(prs, { since: T0, until: T0 + 14 * 24 * H, authors: ['BO'] });
    expect(onlyBo.sampleSize).toBe(1);
  });

  it('DORA from tags (lead time, change failure, MTTR)', () => {
    const tags = [
      {
        name: 'v1',
        at: T0 + 10 * H,
        commits: [
          { at: T0, subject: 'feat' },
          { at: T0 + 8 * H, subject: 'x' },
        ],
      },
      { name: 'v2', at: T0 + 30 * H, commits: [{ at: T0 + 20 * H, subject: 'Revert "feat"' }] }, // hotfix for v1
      { name: 'v3', at: T0 + 100 * H, commits: [{ at: T0 + 90 * H, subject: 'more' }] },
    ];
    const { events, leadTimesHrs } = tagDeployEvents(tags);
    expect(events.map((e) => e.failed)).toEqual([true, false, false]);
    expect(leadTimesHrs.sort((a, b) => a - b)).toEqual([2, 10, 10, 10]);
    const dora = computeDora(events, leadTimesHrs, { since: T0, until: T0 + 14 * 24 * H, signal: 'tags' });
    expect(dora).toEqual({
      deploymentsPerWeek: 1.5,
      leadTimeHrs: 10,
      changeFailureRate: 0.333,
      mttrHrs: 20,
      deployments: 3,
      signal: 'tags',
    });
    expect(globToRegExp('v*').test('v1.2.3')).toBe(true);
    expect(globToRegExp('release-?').test('release-10')).toBe(false);
  });

  it('merge → deploy lead time for deployment APIs', () => {
    const prs = [pr(1, { createdH: 0, mergedH: 5 }), pr(2, { createdH: 0, mergedH: 50 })];
    const deploys = [
      { at: T0 + 8 * H, failed: false },
      { at: T0 + 60 * H, failed: true },
      { at: T0 + 70 * H, failed: false },
    ];
    expect(mergeToDeployLeadTimes(prs, deploys)).toEqual([3, 20]);
  });

  it('normalizes GitHub GraphQL PR nodes', () => {
    const n = normalizeGitHubInsightsPr({
      number: 7,
      title: 't',
      url: 'https://github.com/a/b/pull/7',
      createdAt: '2026-09-01T00:00:00Z',
      mergedAt: '2026-09-02T00:00:00Z',
      additions: 3,
      deletions: 1,
      author: { login: 'ana' },
      mergeCommit: { oid: 'abc' },
      commits: { nodes: [{ commit: { authoredDate: '2026-08-31T00:00:00Z' } }] },
      timelineItems: { nodes: [{ createdAt: '2026-09-01T05:00:00Z' }] },
      reviews: {
        nodes: [
          { submittedAt: '2026-09-01T09:00:00Z', author: { login: 'bo' } },
          { submittedAt: '2026-09-01T06:00:00Z', author: { login: 'ana' } },
          { submittedAt: null, author: { login: 'cy' } },
        ],
      },
    });
    expect(n).toMatchObject({
      author: 'ana',
      readyAt: '2026-09-01T05:00:00Z',
      firstCommitAt: '2026-08-31T00:00:00Z',
      mergeCommitSha: 'abc',
      reviews: [{ login: 'bo', at: '2026-09-01T09:00:00Z' }],
    });
  });

  it('handlers cover the contract', () => {
    expect(Object.keys(createInsightsHandlers({} as never)).sort()).toEqual(
      [...INSIGHTS_INVOKE_CHANNELS].sort(),
    );
  });
});

describe('InsightsService', () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-insights-'));
  afterAll(() => fs.rmSync(cache, { recursive: true, force: true }));
  const now = T0 + 20 * 24 * H;

  it('computes over workspace repos, caches 6 h and reports skipped repos', async () => {
    let calls = 0;
    const provider = {
      insights: () => ({
        async mergedPullRequests(ref: { owner: string }, q: { since: string; max: number }) {
          calls++;
          expect(Date.parse(q.since)).toBe(clock - 30 * 24 * H);
          return {
            items: [
              pr(1, { createdH: 24 * 15, mergedH: 24 * 15 + 4, author: ref.owner }),
              pr(2, { createdH: 24 * 16, mergedH: 24 * 16 + 8, author: 'bo' }),
            ],
            truncated: false,
          };
        },
      }),
    } as unknown as HostingProvider;
    const ws: Workspace = {
      id: 'w1',
      kind: 'local',
      name: 'WS',
      order: 0,
      hidden: false,
      createdAt: '',
      updatedAt: '',
      repos: [
        {
          id: 'r1',
          name: 'app',
          addedAt: '',
          provider: {
            integrationKey: 'github:github.com:1',
            owner: 'acme',
            name: 'app',
            cloneUrlHttps: '',
            cloneUrlSsh: '',
            webUrl: '',
          },
        },
        { id: 'r2', name: 'lib', addedAt: '', remoteUrl: 'https://github.com/acme/lib.git' },
        { id: 'r3', name: 'other', addedAt: '', remoteUrl: 'https://gitlab.example.com/x/y.git' },
      ],
    };
    const progress: number[] = [];
    let clock = now;
    const svc = new InsightsService({
      workspaces: { list: () => [ws] },
      integrations: {
        list: () => [
          {
            key: 'github:github.com:1',
            kind: 'github',
            host: 'github.com',
            accountId: '1',
            login: 'me',
            authType: 'oauth',
            scopes: [],
            connectedAt: 0,
          },
        ],
        provider: () => provider,
      },
      runGit: async () => '',
      cacheDir: () => cache,
      defaultDeploy: () => ({ kind: 'none' }),
      emit: (_e, p) => progress.push(p.done),
      now: () => clock,
    });
    const r = await svc.compute({ workspaceId: 'w1', range: '30d' });
    expect(calls).toBe(2);
    expect(r.sampleSize).toBe(4);
    expect(r.repos.map((x) => x.state)).toEqual(['ok', 'ok', 'skipped']);
    expect(r.source).toBe('Computed locally from 4 PRs via GitHub API');
    expect(r.dora).toBeUndefined();
    expect(progress).toEqual([0, 1, 2, 3]);
    await svc.compute({ workspaceId: 'w1', range: '30d' });
    expect(calls).toBe(2); // cached
    clock += 7 * H; // > 6 h
    const later = await svc.compute({ workspaceId: 'w1', range: '30d', authors: ['bo'] });
    expect(calls).toBe(4);
    expect(later.sampleSize).toBe(2);
    await svc.compute({ workspaceId: 'w1', range: '30d', force: true });
    expect(calls).toBe(6);
    expect(svc.clearCache()).toBeNull();
  });
});
