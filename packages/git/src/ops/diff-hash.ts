import type { DiffOptions, FileDiff } from '../types';

/**
 * Hunk/line staging identifies hunks and lines by index into a diff the UI showed
 * (spec 06 §5 `LineSelection.diffHash`). Both sides must compute that diff with the
 * same options, and the executor refuses when the current diff hashes differently.
 * Pure (no Node APIs) so the renderer can use it.
 */
export const STAGING_DIFF_OPTIONS: Readonly<DiffOptions> = Object.freeze({
  contextLines: 3,
  ignoreWhitespace: 'none',
});

/** FNV-1a 32-bit over the hunks' headers and lines; stable across processes. */
export function diffHash(file: Pick<FileDiff, 'hunks'>): string {
  let h = 0x811c9dc5;
  const mix = (s: string): void => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  };
  for (const hunk of file.hunks) {
    mix(hunk.header);
    mix('\n');
    for (const line of hunk.lines) {
      mix(line.type);
      mix(line.content);
      mix('\n');
    }
  }
  return h.toString(16).padStart(8, '0');
}
