import type { PatchFile } from './types';

/**
 * Cloud Patch payload format and crypto (spec 14 §6.3). WebCrypto + CompressionStream only, so the
 * same code runs in Node ≥ 20 (desktop main, server tests) and in the browser viewer page.
 *
 * Blob layout
 *   plain:  "KLP0" | gzip(JSON PatchBundle)
 *   e2e:    "KLP1" | iv (12 bytes) | AES-256-GCM(gzip(JSON PatchBundle))  (tag appended by GCM)
 * The e2e key (32 random bytes) travels only in the link fragment `#k=<base64url>`.
 * (Spec 14 names XChaCha20-Poly1305; AES-GCM is used because WebCrypto has it in every browser.)
 */

export const PATCH_FORMAT = 'githappens-patch/1';

export interface PatchBundle {
  format: typeof PATCH_FORMAT;
  title: string;
  description?: string;
  kind: 'wip' | 'commit' | 'stash' | 'suggestion';
  baseSha: string;
  baseBranch?: string;
  /** App name + version that created it. */
  createdWith: string;
  /** `git diff --binary --full-index` output, or `git format-patch --stdout --binary` for commits. */
  patch: string;
  files: PatchFile[];
}

const MAGIC_PLAIN = 'KLP0';
const MAGIC_E2E = 'KLP1';
const enc = new TextEncoder();
const dec = new TextDecoder();

// ---- base64url ----

export function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---- gzip ----

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([data as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

export const gzip = (data: Uint8Array): Promise<Uint8Array> => pipe(data, new CompressionStream('gzip'));
export const gunzip = (data: Uint8Array): Promise<Uint8Array> => pipe(data, new DecompressionStream('gzip'));

// ---- hashing ----

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** HMAC-SHA256 → base64url; used for footprint path / branch hashes (spec 14 §6.5). */
export async function hmacBase64Url(keyB64Url: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    fromBase64Url(keyB64Url) as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return toBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message))));
}

// ---- seal / open ----

export interface SealedPatch {
  bytes: Uint8Array;
  sha256: string;
  /** base64url key for the `#k=` fragment; undefined when not e2e. */
  key?: string;
}

export async function sealPatchBundle(bundle: PatchBundle, opts: { e2e: boolean }): Promise<SealedPatch> {
  const zipped = await gzip(enc.encode(JSON.stringify(bundle)));
  let bytes: Uint8Array;
  let key: string | undefined;
  if (opts.e2e) {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const k = await crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt']);
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, k, zipped as BufferSource),
    );
    bytes = concat(enc.encode(MAGIC_E2E), iv, ct);
    key = toBase64Url(raw);
  } else {
    bytes = concat(enc.encode(MAGIC_PLAIN), zipped);
  }
  return { bytes, sha256: await sha256Hex(bytes), key };
}

/** Plain fields (no parameter properties) so Node's type stripping can run this file directly. */
export class PatchCryptoError extends Error {
  readonly code: 'needs-key' | 'bad-key' | 'corrupt' | 'unsupported';

  constructor(code: PatchCryptoError['code'], message: string) {
    super(message);
    this.name = 'PatchCryptoError';
    this.code = code;
  }
}

export function isEncryptedBlob(bytes: Uint8Array): boolean {
  return dec.decode(bytes.subarray(0, 4)) === MAGIC_E2E;
}

export async function openPatchBlob(bytes: Uint8Array, keyB64Url?: string): Promise<PatchBundle> {
  const magic = dec.decode(bytes.subarray(0, 4));
  let zipped: Uint8Array;
  if (magic === MAGIC_PLAIN) {
    zipped = bytes.subarray(4);
  } else if (magic === MAGIC_E2E) {
    if (!keyB64Url)
      throw new PatchCryptoError('needs-key', 'This patch is encrypted; ask for the full link.');
    const raw = fromBase64Url(keyB64Url);
    if (raw.length !== 32) throw new PatchCryptoError('bad-key', 'The link key is invalid.');
    const k = await crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['decrypt']);
    try {
      zipped = new Uint8Array(
        await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: bytes.subarray(4, 16) as BufferSource },
          k,
          bytes.subarray(16) as BufferSource,
        ),
      );
    } catch {
      throw new PatchCryptoError('bad-key', 'The link key does not decrypt this patch.');
    }
  } else {
    throw new PatchCryptoError('unsupported', 'Unknown patch format.');
  }
  let bundle: PatchBundle;
  try {
    bundle = JSON.parse(dec.decode(await gunzip(zipped))) as PatchBundle;
  } catch {
    throw new PatchCryptoError('corrupt', 'The patch data is damaged.');
  }
  if (bundle.format !== PATCH_FORMAT) {
    throw new PatchCryptoError('unsupported', `Unsupported patch format ${String(bundle.format)}.`);
  }
  return bundle;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ---- links ----

/** `githappens://patch/<id>#k=<key>` / `<server>/p/<id>#k=<key>` → parts. */
export function parsePatchLink(url: string): { id: string; key?: string; server?: string } | null {
  const m =
    /^(?:githappens:\/\/patch\/|(https?:\/\/[^/]+(?:\/[^#?]*?)?)\/p\/)([A-Za-z0-9]{16,32})(?:[?][^#]*)?(?:#(.*))?$/.exec(
      url.trim(),
    );
  if (!m) return null;
  const key = m[3] ? (new URLSearchParams(m[3]).get('k') ?? undefined) : undefined;
  return { id: m[2]!, key, server: m[1] };
}

export function patchDeepLink(id: string, key?: string): string {
  return `githappens://patch/${id}${key ? `#k=${key}` : ''}`;
}
