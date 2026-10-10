import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

/**
 * Canonical JSON (spec 14 §6.2 step 2): object keys sorted recursively, no whitespace, `undefined`
 * members dropped. Equal data always serializes to equal bytes, so hashes and "did it change?"
 * checks are stable across machines.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value)) ?? 'null';
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : sortDeep(x)));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = sortDeep(x);
    }
    return out;
  }
  return v;
}

/** Short content hash of a value's canonical JSON. */
export function hashValue(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('base64url').slice(0, 22);
}

export const sameValue = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);

export function gzipJson(value: unknown): Buffer {
  return gzipSync(Buffer.from(canonicalJson(value), 'utf8'));
}

/** Inflate + parse; caps the inflated size (defense against zip bombs from a hostile server). */
export function gunzipJson(bytes: Uint8Array, maxBytes = 32 * 1024 * 1024): unknown {
  const raw = gunzipSync(bytes, { maxOutputLength: maxBytes });
  return JSON.parse(raw.toString('utf8'));
}
