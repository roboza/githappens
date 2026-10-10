/**
 * Paths that are not valid UTF-8 (spec 02 §8, Linux only). Status keeps their bytes (`rawPath`, base64);
 * every path-based op takes `rawPathKey(rawPath)` instead of the lossy decoded `path`: a NUL can never
 * occur in a real path, so the prefix is unambiguous. Pure (renderer-safe).
 */

import { escapeIgnoreLiteral, type IgnoreKind } from './ignore-pattern';

export const RAW_PATH_PREFIX = '\0raw:';
export const rawPathKey = (base64: string): string => RAW_PATH_PREFIX + base64;
export const isRawPathKey = (p: string): boolean => p.startsWith(RAW_PATH_PREFIX);

/** The key an op needs for a status entry / file row: its raw key when it has one, else its path. */
export const opPath = (e: { path: string; rawPath?: string }): string =>
  e.rawPath ? rawPathKey(e.rawPath) : e.path;

/** Bytes of a raw key (renderer and main: no Buffer). */
export function rawKeyBytes(key: string): Uint8Array {
  const bin = atob(key.slice(RAW_PATH_PREFIX.length));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** What the UI shows for a path or raw key: invalid bytes as U+FFFD (as status decodes `path`). */
export const shownPath = (p: string): string =>
  isRawPathKey(p) ? new TextDecoder().decode(rawKeyBytes(p)) : p;

/** Length of the valid UTF-8 sequence at `i`, or 0 when the byte there starts none. */
export function utf8SeqLen(b: Uint8Array, i: number): number {
  const c = b[i]!;
  if (c < 0x80) return 1;
  const n = c >= 0xc2 && c <= 0xdf ? 2 : c >= 0xe0 && c <= 0xef ? 3 : c >= 0xf0 && c <= 0xf4 ? 4 : 0;
  if (!n || i + n > b.length) return 0;
  for (let k = 1; k < n; k++) if ((b[i + k]! & 0xc0) !== 0x80) return 0;
  // overlongs, surrogates, > U+10FFFF
  if (c === 0xe0 && b[i + 1]! < 0xa0) return 0;
  if (c === 0xed && b[i + 1]! > 0x9f) return 0;
  if (c === 0xf0 && b[i + 1]! < 0x90) return 0;
  if (c === 0xf4 && b[i + 1]! > 0x8f) return 0;
  return n;
}

/**
 * A wildmatch pattern for a raw path: valid UTF-8 runs escaped with `escape`, every byte of an invalid
 * sequence a `?` (wildmatch compares bytes; `?` matches exactly one byte other than `/`). Another name
 * that differs only in those bytes also matches.
 */
export function rawPathPattern(key: string, escape: (s: string) => string): string {
  const b = rawKeyBytes(key);
  const dec = new TextDecoder();
  let out = '';
  let run = 0;
  const flush = (to: number): void => {
    if (to > run) out += escape(dec.decode(b.subarray(run, to)));
  };
  let i = 0;
  while (i < b.length) {
    const len = utf8SeqLen(b, i);
    if (len) {
      i += len;
      continue;
    }
    flush(i);
    out += '?';
    i++;
    run = i;
  }
  flush(b.length);
  return out;
}

/**
 * `ignorePatternFor` for a raw path (spec 06 §6.7): the same anchored file / extension / folder
 * patterns, with `?` for the bytes that are not valid UTF-8.
 */
export function rawIgnorePatternFor(kind: IgnoreKind, key: string): string | null {
  // valid runs escaped piecewise (an escaped `#`, `!` or space still matches itself); `?` stays a glob
  const segs = rawPathPattern(key, (s) => s.split('/').map(escapeIgnoreLiteral).join('/')).split('/');
  if (kind === 'file') return `/${segs.join('/')}`;
  if (kind === 'folder') return segs.length > 1 ? `/${segs.slice(0, -1).join('/')}/` : null;
  const base = segs.at(-1) ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 && dot < base.length - 1 ? `*${base.slice(dot)}` : null;
}
