/**
 * Input validation helpers. Unknown fields in request bodies are ignored (forward compatibility
 * with newer clients) but every field the server reads is type-, length- and format-checked.
 */
import type { RepoIdentity } from '@githappens/cloud-api/types';
import { B64URL_RE, PATCH_ID_RE, UUID_RE } from './crypto.ts';
import { invalid, notFound } from './http.ts';

type Obj = Record<string, unknown>;

/** No C0/C1 control characters except tab/newline/CR. */
const TEXT_RE = /^[^\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]*$/;
/** Single line: no control characters at all. */
const LINE_RE = /^[^\x00-\x1f\x7f-\x9f]*$/;

export interface StrOpts {
  max: number;
  min?: number;
  multiline?: boolean;
  pattern?: RegExp;
}

export function optString(o: Obj, key: string, opts: StrOpts): string | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw invalid(`"${key}" must be a string`);
  if (v.length < (opts.min ?? 0) || v.length > opts.max) {
    throw invalid(`"${key}" must be ${opts.min ?? 0}-${opts.max} characters`);
  }
  if (!(opts.multiline ? TEXT_RE : LINE_RE).test(v)) throw invalid(`"${key}" contains control characters`);
  if (opts.pattern && !opts.pattern.test(v)) throw invalid(`"${key}" is malformed`);
  return v;
}

export function reqString(o: Obj, key: string, opts: StrOpts): string {
  const v = optString(o, key, { min: 1, ...opts });
  if (v === undefined) throw invalid(`"${key}" is required`);
  return v;
}

export function optBool(o: Obj, key: string): boolean | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw invalid(`"${key}" must be a boolean`);
  return v;
}

export function reqBool(o: Obj, key: string): boolean {
  const v = optBool(o, key);
  if (v === undefined) throw invalid(`"${key}" is required`);
  return v;
}

export function reqInt(o: Obj, key: string, min: number, max: number): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw invalid(`"${key}" must be an integer`);
  if (v < min || v > max) throw invalid(`"${key}" must be between ${min} and ${max}`);
  return v;
}

export function reqEnum<T extends string>(o: Obj, key: string, values: readonly T[]): T {
  const v = o[key];
  if (typeof v !== 'string' || !values.includes(v as T))
    throw invalid(`"${key}" must be one of ${values.join(', ')}`);
  return v as T;
}

export function optEnum<T extends string>(o: Obj, key: string, values: readonly T[]): T | undefined {
  return o[key] === undefined || o[key] === null ? undefined : reqEnum(o, key, values);
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

export function parseIso(value: unknown, key: string): Date {
  if (typeof value !== 'string' || !ISO_RE.test(value)) throw invalid(`"${key}" must be an ISO-8601 time`);
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw invalid(`"${key}" must be an ISO-8601 time`);
  return d;
}

export function optIso(o: Obj, key: string): Date | undefined {
  const v = o[key];
  return v === undefined || v === null ? undefined : parseIso(v, key);
}

export function asObject(v: unknown, key: string): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw invalid(`"${key}" must be an object`);
  return v as Obj;
}

export function asArray(v: unknown, key: string, max: number): unknown[] {
  if (!Array.isArray(v)) throw invalid(`"${key}" must be an array`);
  if (v.length > max) throw invalid(`"${key}" may have at most ${max} entries`);
  return v;
}

export function uuidList(v: unknown, key: string, max: number): string[] {
  const out = asArray(v, key, max).map((x) => {
    if (typeof x !== 'string' || !UUID_RE.test(x)) throw invalid(`"${key}" must contain user ids`);
    return x;
  });
  return [...new Set(out)];
}

/** Path parameter that must be a UUID; anything else is simply "not found". */
export function uuidParam(v: string | undefined, what = 'Not found'): string {
  if (!v || !UUID_RE.test(v)) throw notFound(what);
  return v;
}

export function patchIdParam(v: string | undefined): string {
  if (!v || !PATCH_ID_RE.test(v)) throw notFound('Patch not found');
  return v;
}

export function base64url(o: Obj, key: string, maxChars: number): Buffer {
  const v = o[key];
  if (typeof v !== 'string' || !B64URL_RE.test(v) || v.length % 4 === 1) {
    throw invalid(`"${key}" must be base64url without padding`);
  }
  if (v.length > maxChars) throw invalid(`"${key}" is too large`);
  return Buffer.from(v, 'base64url');
}

export const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const SEGMENT_RE = /^[A-Za-z0-9._~@+-][A-Za-z0-9._~@+/ -]{0,199}$/;
const HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(?::\d{1,5})?$/;

export function repoIdentity(v: unknown, key = 'repo'): RepoIdentity {
  const o = asObject(v, key);
  const repo: RepoIdentity = {
    provider: reqString(o, 'provider', { max: 40, pattern: /^[a-z0-9-]+$/ }),
    host: reqString(o, 'host', { max: 253, pattern: HOST_RE }),
    owner: reqString(o, 'owner', { max: 200, pattern: SEGMENT_RE }),
    name: reqString(o, 'name', { max: 200, pattern: SEGMENT_RE }),
  };
  const initial = optString(o, 'initialCommitSha', { max: 64, pattern: SHA_RE });
  if (initial) repo.initialCommitSha = initial;
  return repo;
}

/** Parse `If-Match` (bare number, `"3"`, or `W/"3"`); undefined when absent. */
export function ifMatch(header: string | string[] | undefined): number | undefined {
  if (header === undefined) return undefined;
  const raw = (Array.isArray(header) ? header[0]! : header).trim();
  const m = /^(?:W\/)?"?(\d{1,15})"?$/.exec(raw);
  if (!m) throw invalid('If-Match must be a version number');
  return Number(m[1]);
}

const EMAIL_RE =
  /^[^\s@<>()",;:\\[\]]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/** Lower-cased, trimmed email address, or undefined when malformed. */
export function normalizeEmail(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const e = v.trim().toLowerCase();
  return e.length <= 254 && EMAIL_RE.test(e) ? e : undefined;
}

export function email(v: unknown, key = 'email'): string {
  const e = normalizeEmail(v);
  if (!e) throw invalid(`"${key}" must be an email address`);
  return e;
}

/** Pagination params: `limit` default 50, max 200; opaque cursor. */
export function pageParams(q: URLSearchParams): { limit: number; cursor?: string } {
  const raw = q.get('limit');
  let limit = 50;
  if (raw !== null) {
    if (!/^\d{1,4}$/.test(raw)) throw invalid('"limit" must be an integer');
    limit = Math.min(200, Math.max(1, Number(raw)));
  }
  const cursor = q.get('cursor') ?? undefined;
  if (cursor !== undefined && (cursor.length > 200 || !B64URL_RE.test(cursor)))
    throw invalid('"cursor" is malformed');
  return { limit, cursor: cursor || undefined };
}
