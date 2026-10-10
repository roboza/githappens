/**
 * Large-file and huge-diff safeguards (spec 07 §4.14). Pure decisions; the UI remembers "Load anyway"
 * per session in `allowLarge`.
 */

export const LARGE_FILE_BYTES = 1024 * 1024;
export const LARGE_FILE_LINES = 20_000;
/** Never loaded into Monaco. */
export const HUGE_FILE_BYTES = 50 * 1024 * 1024;
/** Minified lines: tokenization and word diff limited. */
export const LONG_LINE_CHARS = 10_000;
/** Commits above this skip numstat and truncate the list. */
export const MAX_LISTED_FILES = 5_000;

export type LargeVerdict = 'ok' | 'confirm' | 'refuse';

export interface SizeInfo {
  bytes: number;
  lines?: number;
}

/** Worst verdict over the sides of a diff. */
export function largeFileVerdict(sides: (SizeInfo | null | undefined)[]): LargeVerdict {
  let v: LargeVerdict = 'ok';
  for (const s of sides) {
    if (!s) continue;
    if (s.bytes > HUGE_FILE_BYTES) return 'refuse';
    if (s.bytes > LARGE_FILE_BYTES || (s.lines ?? 0) > LARGE_FILE_LINES) v = 'confirm';
  }
  return v;
}

/** Line count without splitting (no big temporary arrays). */
export function countLines(text: string): number {
  if (!text) return 0;
  let n = 1;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) n++;
  return text.endsWith('\n') ? n - 1 : n;
}

/** True when any line exceeds `limit` characters. */
export function hasLongLines(text: string, limit = LONG_LINE_CHARS): boolean {
  if (text.length <= limit) return false;
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = text.length;
    if (end - start > limit) return true;
    start = end + 1;
  }
  return false;
}

const allowed = new Set<string>();

/** "Load anyway" is remembered per session (spec 07 §4.14). */
export const allowLarge = {
  has: (key: string): boolean => allowed.has(key),
  add: (key: string): void => void allowed.add(key),
  clear: (): void => allowed.clear(),
};
