import { describe, expect, it } from 'vitest';

import {
  formatRanges,
  groupOverlaps,
  indicatorView,
  overlapSummaryMarkdown,
} from '../src/renderer/src/conflicts/helpers';
import type { ConflictReport, TeammateOverlap } from '../src/shared/ipc/conflicts-contract';

const base: ConflictReport = {
  repoId: 'r',
  branch: 'feature/x',
  target: 'origin/main',
  checkedAt: '2026-10-09T00:00:00Z',
  targetConflicts: [],
  teammateOverlaps: [],
  state: 'ok',
  wip: false,
  ignoredCount: 0,
};

const overlap = (path: string, user = 'Ana', branchHash = 'abcdef123'): TeammateOverlap => ({
  user: { id: user, name: user },
  branchHash,
  path,
  pathHash: `h:${path}`,
  myRanges: [[45, 45]],
  theirRanges: [[40, 58]],
  updatedAt: '2026-10-01T00:00:00Z',
});

describe('target indicator view', () => {
  it('is hidden without a target or for detached HEAD', () => {
    expect(indicatorView(undefined).visible).toBe(false);
    expect(indicatorView({ ...base, state: 'hidden' }).visible).toBe(false);
    expect(indicatorView({ ...base, state: 'no-target' }).visible).toBe(false);
    expect(indicatorView({ ...base, state: 'disabled' }).visible).toBe(false);
  });

  it('grey when clean, amber with conflicts, red badge with teammate overlaps', () => {
    expect(indicatorView(base)).toMatchObject({ visible: true, tone: 'grey', badge: 0 });
    const conflicts = {
      ...base,
      state: 'conflicts' as const,
      targetConflicts: [{ path: 'a' }, { path: 'b' }],
    };
    expect(indicatorView(conflicts)).toMatchObject({ tone: 'amber', badge: 2, badgeTone: 'amber' });
    expect(indicatorView({ ...conflicts, teammateOverlaps: [overlap('c')] })).toMatchObject({
      tone: 'amber',
      badge: 3,
      badgeTone: 'red',
    });
    expect(indicatorView({ ...base, state: 'target-missing' }).tooltip).toContain('not available — fetch');
  });

  it('formats ranges, groups overlaps and builds the markdown summary', () => {
    expect(formatRanges([[40, 58]])).toBe('lines 40–58');
    expect(formatRanges([[7, 7]])).toBe('line 7');
    expect(formatRanges([])).toBe('whole file');
    const list = [overlap('src/a.ts'), overlap('src/b.ts'), overlap('src/a.ts', 'Bo', 'zzz')];
    expect(groupOverlaps(list).map((g) => g.items.length)).toEqual([2, 1]);
    const md = overlapSummaryMarkdown({
      ...base,
      teammateOverlaps: [{ ...list[0]!, branchLabel: 'ana/auth' }],
    });
    expect(md).toContain('**Ana** (ana/auth) is editing `src/a.ts` lines 40–58; my changes: line 45');
    expect(overlapSummaryMarkdown({ ...base, teammateOverlaps: [list[2]!] })).toContain('branch #zzz');
  });
});
