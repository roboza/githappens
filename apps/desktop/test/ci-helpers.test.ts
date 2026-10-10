import type { RepoRef } from '@githappens/providers/types';
import { describe, expect, it } from 'vitest';

import type { CiRun } from '../src/shared/ipc/integrations-contract';
import {
  ciSectionTitle,
  ciStatusTone,
  dedupeRuns,
  groupRuns,
  pickCiRemote,
  runActions,
  runDuration,
  runTooltip,
  shortAge,
} from '../src/renderer/src/views/ci/ci-helpers';

const ref: RepoRef = {
  integration: { kind: 'github', host: 'github.com', accountId: '1' },
  owner: 'acme',
  name: 'app',
};

const run = (p: Partial<CiRun>): CiRun => ({
  id: p.id ?? '1',
  name: p.name ?? 'build',
  status: p.status ?? 'success',
  canRerun: p.canRerun ?? true,
  provider: 'actions',
  ...p,
});

describe('ci helpers', () => {
  it('titles the section per provider', () => {
    expect(ciSectionTitle('github')).toBe('ACTIONS');
    expect(ciSectionTitle('gitlab')).toBe('PIPELINES');
    expect(ciSectionTitle(undefined)).toBe('PIPELINES');
  });

  it('picks origin first, preferring connected remotes', () => {
    expect(
      pickCiRemote([
        { remote: 'upstream', ref, integrationKey: 'k' },
        { remote: 'origin', ref, integrationKey: 'k' },
      ])?.remote,
    ).toBe('origin');
    expect(
      pickCiRemote([
        { remote: 'origin', ref },
        { remote: 'fork', ref, integrationKey: 'k' },
      ])?.remote,
    ).toBe('fork');
    expect(pickCiRemote([{ remote: 'origin' }, { remote: 'b', ref }])?.remote).toBe('b');
    expect(pickCiRemote([{ remote: 'origin' }])).toBeUndefined();
  });

  it('derives run actions from status', () => {
    expect(runActions(run({ status: 'in_progress' }))).toEqual({
      open: false,
      rerun: false,
      rerunFailed: false,
      cancel: true,
    });
    expect(runActions(run({ status: 'failure', detailsUrl: 'u' }))).toEqual({
      open: true,
      rerun: true,
      rerunFailed: true,
      cancel: false,
    });
    expect(runActions(run({ status: 'success', canRerun: false }))).toMatchObject({
      rerun: false,
      rerunFailed: false,
    });
  });

  it('groups by workflow in first-seen order and dedupes', () => {
    const runs = [
      run({ id: 'a', group: 'CI' }),
      run({ id: 'b', group: 'Deploy' }),
      run({ id: 'c', group: 'CI' }),
      run({ id: 'd', name: 'lint' }),
    ];
    expect(groupRuns(runs).map((g) => [g.group, g.runs.map((r) => r.id)])).toEqual([
      ['CI', ['a', 'c']],
      ['Deploy', ['b']],
      ['lint', ['d']],
    ]);
    expect(dedupeRuns([...runs, run({ id: 'a' })]).map((r) => r.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('formats ages, durations and tooltips', () => {
    const now = Date.parse('2026-01-10T12:00:00Z');
    expect(shortAge('2026-01-10T11:59:30Z', now)).toBe('now');
    expect(shortAge('2026-01-10T11:55:00Z', now)).toBe('5m');
    expect(shortAge('2026-01-10T09:00:00Z', now)).toBe('3h');
    expect(shortAge('2026-01-08T12:00:00Z', now)).toBe('2d');
    expect(shortAge('2025-12-20T12:00:00Z', now)).toBe('3w');
    expect(shortAge(undefined, now)).toBe('');
    expect(runDuration({ startedAt: '2026-01-10T11:58:55Z', completedAt: '2026-01-10T12:00:00Z' })).toBe(
      '1m 05s',
    );
    expect(runDuration({ startedAt: '2026-01-10T11:59:50Z' }, now)).toBe('10s');
    expect(
      runTooltip(
        run({
          group: 'CI',
          runNumber: 42,
          status: 'failure',
          branch: 'main',
          event: 'push',
          actor: { id: '1', login: 'alice' },
        }),
        now,
      ),
    ).toBe('CI · build #42\nFailed\nBranch: main\nEvent: push\nBy alice');
    expect(ciStatusTone('timed_out')).toBe('red');
    expect(ciStatusTone('queued')).toBe('yellow');
    expect(ciStatusTone('skipped')).toBe('grey');
  });
});
