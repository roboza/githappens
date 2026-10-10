import type { BlameCommitInfo, BlameLine, Sha } from '@githappens/git/types';

/** Blame gutter helpers (spec 07 §4.10). Pure. */

export interface BlameBlock {
  sha: string;
  /** 1-based first line. */
  start: number;
  count: number;
}

/** Group consecutive lines from the same commit into blocks; unknown (not yet streamed) lines are ''. */
export function toBlocks(lineShas: readonly (string | undefined)[], lineCount: number): BlameBlock[] {
  const out: BlameBlock[] = [];
  for (let n = 1; n <= lineCount; n++) {
    const sha = lineShas[n] ?? '';
    const last = out[out.length - 1];
    if (last && last.sha === sha) last.count++;
    else out.push({ sha, start: n, count: 1 });
  }
  return out;
}

/** Fold streamed lines into the per-line sha table (index = final line number). */
export function applyBlameLines(table: (string | undefined)[], lines: readonly BlameLine[]): void {
  for (const l of lines) table[l.finalLine] = l.sha;
}

/** FNV-1a string hash. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** Stable per-author colour (`hash(email)` into the hue wheel). */
export function authorColor(email: string): string {
  const hue = hashString(email.toLowerCase()) % 360;
  return `hsl(${hue} 60% 55%)`;
}

/** Age heatmap: newest commit → 1, oldest → 0.15 (opacity of the accent bar). */
export function ageIntensity(time: number, min: number, max: number): number {
  if (max <= min) return 1;
  return 0.15 + (0.85 * (time - min)) / (max - min);
}

export function timeRange(commits: Record<Sha, BlameCommitInfo>): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const c of Object.values(commits)) {
    if (!c.authorTime) continue;
    min = Math.min(min, c.authorTime);
    max = Math.max(max, c.authorTime);
  }
  return Number.isFinite(min) ? { min, max } : { min: 0, max: 0 };
}

export const isUncommitted = (sha: string): boolean => /^0+$/.test(sha);
