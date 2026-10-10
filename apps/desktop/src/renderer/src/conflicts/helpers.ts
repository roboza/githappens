import type { ConflictReport, TeammateOverlap } from '../../../shared/ipc/conflicts-contract';

/** Indicator appearance (spec 14 §4.4): grey = clean / informational, amber = conflicts, red badge = + teammates. */
export interface IndicatorView {
  visible: boolean;
  tone: 'grey' | 'amber';
  badge: number;
  badgeTone: 'amber' | 'red';
  tooltip: string;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

export function indicatorView(r: ConflictReport | undefined): IndicatorView {
  const hidden: IndicatorView = { visible: false, tone: 'grey', badge: 0, badgeTone: 'amber', tooltip: '' };
  if (!r || r.state === 'hidden' || r.state === 'no-target') return hidden;
  const target = r.targetConflicts.length;
  const overlaps = r.teammateOverlaps.length;
  if (r.state === 'disabled' && !overlaps) return hidden;
  const lines: string[] = [];
  switch (r.state) {
    case 'ok':
      lines.push(`No conflicts with ${r.target}`);
      break;
    case 'conflicts':
      lines.push(`${r.branch} conflicts with ${r.target} in ${plural(target, 'file')}`);
      break;
    case 'target-missing':
      lines.push(`Target ${r.target} not available — fetch`);
      break;
    case 'ignored':
      lines.push(`Not detecting conflicts with ${r.target}`);
      break;
    case 'unsupported':
      lines.push('Conflict detection needs Git 2.38 or newer');
      break;
    case 'error':
      lines.push(`Conflict check failed: ${r.error ?? 'unknown error'}`);
      break;
    default:
      break;
  }
  if (overlaps) lines.push(`${plural(overlaps, 'teammate overlap')}`);
  if (r.wip) lines.push('Includes uncommitted changes');
  return {
    visible: true,
    tone: target || overlaps ? 'amber' : 'grey',
    badge: target + overlaps,
    badgeTone: overlaps ? 'red' : 'amber',
    tooltip: lines.join('\n'),
  };
}

export const formatRange = ([a, b]: [number, number]): string => (a === b ? `${a}` : `${a}–${b}`);

export function formatRanges(ranges: [number, number][]): string {
  if (!ranges.length) return 'whole file';
  const shown = ranges.slice(0, 4).map(formatRange).join(', ');
  return `${ranges.length === 1 && ranges[0]![0] === ranges[0]![1] ? 'line' : 'lines'} ${shown}${ranges.length > 4 ? ', …' : ''}`;
}

/** Short label for a teammate branch: plaintext label when shared, else a hash prefix. */
export const branchName = (o: Pick<TeammateOverlap, 'branchLabel' | 'branchHash'>): string =>
  o.branchLabel ?? `branch #${o.branchHash.slice(0, 6)}`;

/** Group overlaps by teammate + branch for the popover. */
export function groupOverlaps(list: TeammateOverlap[]): Array<{ key: string; items: TeammateOverlap[] }> {
  const groups = new Map<string, TeammateOverlap[]>();
  for (const o of list) {
    const key = `${o.user.id}\0${o.branchHash}`;
    groups.set(key, [...(groups.get(key) ?? []), o]);
  }
  return [...groups].map(([key, items]) => ({ key, items }));
}

/** "Copy summary" markdown (spec 14 §6.5): who, file, ranges, branches. */
export function overlapSummaryMarkdown(
  r: ConflictReport,
  list: TeammateOverlap[] = r.teammateOverlaps,
): string {
  const out = [`### Overlapping work on \`${r.branch}\``, ''];
  for (const o of list) {
    out.push(
      `- **${o.user.name}** (${branchName(o)}) is editing \`${o.path}\` ${formatRanges(o.theirRanges)}; ` +
        `my changes: ${formatRanges(o.myRanges)}`,
    );
  }
  if (r.targetConflicts.length) {
    out.push(
      '',
      `Conflicts with \`${r.target}\`: ${r.targetConflicts.map((c) => `\`${c.path}\``).join(', ')}`,
    );
  }
  return out.join('\n');
}

export const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
