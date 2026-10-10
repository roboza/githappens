/**
 * Pathspec helper shared by every command that takes user paths (spec 02 §6.1, §11).
 *
 * Above the Windows command-line thresholds (50 paths or 8 KB of path data) paths go through
 * `--pathspec-from-file=- --pathspec-file-nul` with a NUL-joined stdin buffer; otherwise after `--`.
 * Paths are literal (`GIT_LITERAL_PATHSPECS=1`) unless the caller opts into glob magic.
 */

import { isRawPathKey, RAW_PATH_PREFIX, rawPathPattern } from '../ops/raw-path';

export const PATHSPEC_MAX_ARGS = 50;

/**
 * Paths that are not valid UTF-8 (spec 02 §8, Linux only) travel as `rawPathKey(entry.rawPath)` (see
 * ops/raw-path). Such paths always go through `--pathspec-from-file` so their exact bytes reach git, or,
 * for commands without it, a `:(glob)` pathspec (`argvPathspecs`).
 */
export { RAW_PATH_PREFIX, rawPathKey, isRawPathKey } from '../ops/raw-path';
/** Bytes of a path (decoding raw keys). */
export const pathBytes = (p: string): Buffer =>
  isRawPathKey(p) ? Buffer.from(p.slice(RAW_PATH_PREFIX.length), 'base64') : Buffer.from(p, 'utf8');

/** What the UI shows for a path: raw keys decoded lossily (U+FFFD for invalid bytes). */
export const displayPath = (p: string): string => (isRawPathKey(p) ? pathBytes(p).toString('utf8') : p);

/**
 * A `:(glob)` pathspec matching a raw (non-UTF-8) path for commands without `--pathspec-from-file`:
 * argv is always UTF-8, so every byte of an invalid sequence becomes `?` (wildmatch compares bytes and
 * `?` matches exactly one byte other than `/`); glob characters of the valid parts are escaped. Another
 * file whose name differs only in those bytes would also match.
 */
export function rawPathGlob(p: string): string {
  return `:(glob)${rawPathPattern(p, (s) => s.replace(/[*?[\]\\]/g, (c) => `\\${c}`))}`;
}

/**
 * Pathspec arguments (after `--`) for commands without `--pathspec-from-file` (diff, log): plain paths
 * as they are with `GIT_LITERAL_PATHSPECS=1`; with a raw key among them, every path gets explicit magic
 * (`:(glob)` for raw keys, `:(literal)` for the others) and literal mode is turned off.
 */
export function argvPathspecs(paths: string[]): { paths: string[]; env: Record<string, string> } {
  if (!paths.some(isRawPathKey)) return { paths: [...paths], env: { GIT_LITERAL_PATHSPECS: '1' } };
  return {
    paths: paths.map((p) => (isRawPathKey(p) ? rawPathGlob(p) : `:(literal)${p}`)),
    env: { GIT_LITERAL_PATHSPECS: '0' },
  };
}
export const PATHSPEC_MAX_BYTES = 8 * 1024;

export interface PathspecOptions {
  /** Allow pathspec magic / globs (`:(glob)`, `*`). Default false (literal). */
  glob?: boolean;
  /** Thresholds (tests); defaults to the spec values. */
  maxArgs?: number;
  maxBytes?: number;
}

export interface PathspecArgs {
  args: string[];
  stdin?: Buffer;
  env: Record<string, string>;
}

function pathspecEnv(o: PathspecOptions): Record<string, string> {
  return { GIT_LITERAL_PATHSPECS: o.glob ? '0' : '1' };
}

function exceeds(paths: string[], o: PathspecOptions): boolean {
  if (paths.length > (o.maxArgs ?? PATHSPEC_MAX_ARGS)) return true;
  let bytes = 0;
  for (const p of paths) bytes += Buffer.byteLength(p) + 1;
  return bytes > (o.maxBytes ?? PATHSPEC_MAX_BYTES);
}

/** For commands that support `--pathspec-from-file` (add, reset, restore, checkout, stash push, rm, commit, ls-files). */
export function withPathspec(args: string[], paths: string[], o: PathspecOptions = {}): PathspecArgs {
  const env = pathspecEnv(o);
  if (!paths.length) return { args: [...args], env };
  if (paths.some(isRawPathKey) || exceeds(paths, o)) {
    return {
      args: [...args, '--pathspec-from-file=-', '--pathspec-file-nul'],
      stdin: Buffer.concat(paths.flatMap((p) => [pathBytes(p), Buffer.from([0])])),
      env,
    };
  }
  return { args: [...args, '--', ...paths], env };
}

/** For commands without `--pathspec-from-file` (diff, log, clean, …): split into batches under the thresholds. */
export function batchPathspec(args: string[], paths: string[], o: PathspecOptions = {}): PathspecArgs[] {
  const env = pathspecEnv(o);
  if (!paths.length) return [{ args: [...args], env }];
  if (paths.some(isRawPathKey)) {
    // argv is always UTF-8: raw paths become `:(glob)` pathspecs (rare: one batch is plenty)
    const a = argvPathspecs(paths);
    return [{ args: [...args, '--', ...a.paths], env: o.glob ? pathspecEnv(o) : a.env }];
  }
  const maxArgs = o.maxArgs ?? PATHSPEC_MAX_ARGS;
  const maxBytes = o.maxBytes ?? PATHSPEC_MAX_BYTES;
  const out: PathspecArgs[] = [];
  let batch: string[] = [];
  let bytes = 0;
  for (const p of paths) {
    const b = Buffer.byteLength(p) + 1;
    if (batch.length && (batch.length >= maxArgs || bytes + b > maxBytes)) {
      out.push({ args: [...args, '--', ...batch], env });
      batch = [];
      bytes = 0;
    }
    batch.push(p);
    bytes += b;
  }
  out.push({ args: [...args, '--', ...batch], env });
  return out;
}
