import { describe, expect, it } from 'vitest';

import {
  DEFAULT_KEYBINDINGS,
  conflictsFor,
  resolveKeybindings,
} from '../src/renderer/src/commands/keybindings';
import { openPrsChip, prCell, withPrCounts } from '../src/renderer/src/workspaces/pr-counts';
import type { RepoStatusSummary } from '../src/shared/ipc/workspaces-contract';

const sum = (id: string): RepoStatusSummary => ({
  workspaceRepoId: id,
  exists: true,
  isRepo: true,
  ahead: 0,
  behind: 0,
  wip: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
  stashCount: 0,
});

describe('workspace open-PR counts (spec 11 §4.1)', () => {
  it('fills RepoStatusSummary.openPrs from Launchpad counts', () => {
    const counts = { a: { mine: 1, total: 3, needsMyReview: 2 } };
    const out = withPrCounts([sum('a'), sum('b')], counts);
    expect(out[0]!.openPrs).toEqual({ mine: 1, total: 3, needsMyReview: 2 });
    expect(out[1]!.openPrs).toBeUndefined();
    expect(withPrCounts([sum('b')], counts, true)[0]!.openPrs).toEqual({
      mine: 0,
      total: 0,
      needsMyReview: 0,
    });
    expect(withPrCounts([sum('a')], undefined)[0]!.openPrs).toBeUndefined();
  });

  it('formats the chip and the overview cell', () => {
    expect(openPrsChip(0, 0)).toBeNull();
    expect(openPrsChip(1, 0)).toBe('1 open PR');
    expect(openPrsChip(7, 2)).toBe('7 open PRs · 2 need your review');
    expect(openPrsChip(7, 1)).toBe('7 open PRs · 1 needs your review');
    expect(prCell(undefined).text).toBe('—');
    expect(prCell({ mine: 1, total: 4, needsMyReview: 0 })).toEqual({
      text: '1 / 4',
      title: '1 mine · 4 open',
    });
  });
});

describe('"Workspace: Open…" shortcut', () => {
  it('Ctrl/Cmd+Alt+O is bound and conflicts with nothing on either platform', () => {
    expect(DEFAULT_KEYBINDINGS.find((b) => b.command === 'workspace.open')?.key).toBe('mod+alt+o');
    for (const mac of [false, true]) {
      const resolved = resolveKeybindings(DEFAULT_KEYBINDINGS, [], mac);
      const mine = resolved.find((b) => b.command === 'workspace.open')!;
      expect(mine.key).toBe(mac ? 'alt+meta+o' : 'ctrl+alt+o');
      expect(conflictsFor(resolved, mine.key, 'workspace.open', mine.when)).toEqual([]);
    }
  });
});
