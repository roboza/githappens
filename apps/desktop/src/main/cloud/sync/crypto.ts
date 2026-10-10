import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';

import type { SyncItem, SyncPut } from '@githappens/cloud-api';

import { gunzipJson, gzipJson } from './canonical';

/**
 * End-to-end encryption for settings sync (spec 14 §6.2), `node:crypto` only.
 *
 *   KEK  = scrypt(passphrase, salt = 'githappens-sync:' + userId, N = 2^16, r = 8, p = 1, 32 bytes)
 *   DEK  = 32 random bytes, wrapped with AES-256-GCM under the KEK → `_keys` category
 *   RKEK = HKDF-SHA256(recoveryKeyBytes, salt = 'githappens-sync:' + userId, info = 'recovery-kek')
 *          (the recovery key has 160 bits of entropy, so no slow KDF is needed) — also wraps the DEK
 *   category blob = AES-256-GCM(DEK, random 96-bit nonce, gzip(canonical JSON), AAD = category)
 *
 * Deviation from the spec: Argon2id/XChaCha20-Poly1305 (libsodium) are replaced by scrypt and
 * AES-256-GCM because the app takes no native crypto dependency; scrypt with N=2^16, r=8 costs
 * 64 MiB of memory per guess, comparable to the spec's Argon2id m=64MB.
 *
 * The `githappens-sync…` / `githappens-recovery` salts, AADs and labels below are wire-format
 * constants: they are mixed into every key and ciphertext, so changing them makes existing synced
 * data and recovery keys undecryptable.
 */

export const SYNC_KDF_DEFAULT = { alg: 'scrypt', N: 65536, r: 8, p: 1 } as const;
export type KdfParams = { alg: 'scrypt'; N: number; r: number; p: number };

export interface WrappedKey {
  /** base64url 12-byte IV. */
  iv: string;
  /** base64url ciphertext || 16-byte GCM tag. */
  ct: string;
}

/** Plaintext JSON stored in the `_keys` sync category (contains only wrapped keys). */
export interface SyncKeysDoc {
  v: 1;
  /** Identifies the DEK (detects "sync data was reset on another computer"). */
  keyId: string;
  kdf: KdfParams & { salt: 'githappens-sync:<userId>' };
  wrapped: { passphrase: WrappedKey; recovery?: WrappedKey };
  createdAt: string;
}

export class SyncKeyError extends Error {
  constructor(
    readonly code:
      'wrong_passphrase' | 'wrong_recovery_key' | 'invalid_recovery_key' | 'bad_keys' | 'decrypt',
    message: string,
  ) {
    super(message);
    this.name = 'SyncKeyError';
  }
}

const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64url');
const unb64 = (s: string): Buffer => Buffer.from(s, 'base64url');
const saltFor = (userId: string): Buffer => Buffer.from(`githappens-sync:${userId}`, 'utf8');

export function keyIdOf(dek: Uint8Array): string {
  return createHash('sha256').update('githappens-sync-keyid').update(dek).digest('hex').slice(0, 16);
}

export function deriveKek(
  passphrase: string,
  userId: string,
  kdf: KdfParams = SYNC_KDF_DEFAULT,
): Promise<Buffer> {
  if (kdf.alg !== 'scrypt')
    return Promise.reject(new SyncKeyError('bad_keys', 'Unsupported key derivation.'));
  const maxmem = 128 * kdf.N * kdf.r * kdf.p + 32 * 1024 * 1024;
  return new Promise((resolve, reject) =>
    scrypt(
      passphrase.normalize('NFKC'),
      saltFor(userId),
      32,
      { N: kdf.N, r: kdf.r, p: kdf.p, maxmem },
      (err, key) => (err ? reject(err) : resolve(key)),
    ),
  );
}

export function recoveryKek(recovery: Uint8Array, userId: string): Buffer {
  return Buffer.from(hkdfSync('sha256', recovery, saltFor(userId), 'recovery-kek', 32));
}

function seal(key: Uint8Array, plain: Uint8Array, aad: string): { iv: Buffer; ct: Buffer } {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  return { iv, ct };
}

function open(key: Uint8Array, iv: Uint8Array, ctAndTag: Uint8Array, aad: string): Buffer {
  if (ctAndTag.length < 16 || iv.length !== 12) throw new Error('truncated');
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAAD(Buffer.from(aad, 'utf8'));
  d.setAuthTag(ctAndTag.subarray(ctAndTag.length - 16));
  return Buffer.concat([d.update(ctAndTag.subarray(0, ctAndTag.length - 16)), d.final()]);
}

const WRAP_AAD = (slot: 'passphrase' | 'recovery'): string => `githappens-sync/v1:_keys:${slot}`;

export function wrapKey(kek: Uint8Array, dek: Uint8Array, slot: 'passphrase' | 'recovery'): WrappedKey {
  const { iv, ct } = seal(kek, dek, WRAP_AAD(slot));
  return { iv: b64(iv), ct: b64(ct) };
}

/** Throws (never returns garbage) when the KEK is wrong. */
export function unwrapKey(kek: Uint8Array, w: WrappedKey, slot: 'passphrase' | 'recovery'): Buffer {
  const dek = open(kek, unb64(w.iv), unb64(w.ct), WRAP_AAD(slot));
  if (dek.length !== 32) throw new Error('bad key length');
  return dek;
}

// ---- recovery key: 160 random bits + 20-bit checksum, Crockford base32, 9 groups of 4 ----------------

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function base32(bytes: Uint8Array): string {
  let bits = 0;
  let acc = 0;
  let out = '';
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32[(acc << (5 - bits)) & 31];
  return out;
}

function unbase32(s: string): Buffer | null {
  let bits = 0;
  let acc = 0;
  const out: number[] = [];
  for (const ch of s) {
    const v = B32.indexOf(ch);
    if (v < 0) return null;
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((acc >>> (bits - 8)) & 255);
      bits -= 8;
      acc &= (1 << bits) - 1;
    }
  }
  return Buffer.from(out);
}

const checksum = (entropy: Uint8Array): string =>
  base32(createHash('sha256').update('githappens-recovery').update(entropy).digest().subarray(0, 3)).slice(
    0,
    4,
  );

export function formatRecoveryKey(entropy: Uint8Array): string {
  const s = base32(entropy) + checksum(entropy);
  return s.match(/.{4}/g)!.join('-');
}

export function generateRecoveryKey(): { key: string; entropy: Buffer } {
  const entropy = randomBytes(20);
  return { key: formatRecoveryKey(entropy), entropy };
}

/** Accepts any case / spacing / dashes and Crockford look-alikes (O→0, I/L→1). */
export function parseRecoveryKey(input: string): Buffer {
  const s = input
    .toUpperCase()
    .replace(/[\s-]+/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (s.length !== 36) {
    throw new SyncKeyError('invalid_recovery_key', 'A recovery key has 36 characters in groups of four.');
  }
  const entropy = unbase32(s.slice(0, 32));
  if (!entropy || entropy.length !== 20) {
    throw new SyncKeyError('invalid_recovery_key', 'That recovery key contains invalid characters.');
  }
  const want = Buffer.from(checksum(entropy));
  const got = Buffer.from(s.slice(32));
  if (want.length !== got.length || !timingSafeEqual(want, got)) {
    throw new SyncKeyError('invalid_recovery_key', 'That recovery key is not valid — check for typos.');
  }
  return entropy;
}

// ---- key document ---------------------------------------------------------------------------------

export async function createSyncKeys(
  passphrase: string,
  userId: string,
  kdf: KdfParams = SYNC_KDF_DEFAULT,
  now = new Date(),
): Promise<{ dek: Buffer; recoveryKey: string; doc: SyncKeysDoc }> {
  const dek = randomBytes(32);
  const kek = await deriveKek(passphrase, userId, kdf);
  const recovery = generateRecoveryKey();
  const doc: SyncKeysDoc = {
    v: 1,
    keyId: keyIdOf(dek),
    kdf: { ...kdf, salt: 'githappens-sync:<userId>' },
    wrapped: {
      passphrase: wrapKey(kek, dek, 'passphrase'),
      recovery: wrapKey(recoveryKek(recovery.entropy, userId), dek, 'recovery'),
    },
    createdAt: now.toISOString(),
  };
  return { dek, recoveryKey: recovery.key, doc };
}

export function parseKeysDoc(v: unknown): SyncKeysDoc {
  const d = v as SyncKeysDoc | null;
  if (
    !d ||
    d.v !== 1 ||
    typeof d.keyId !== 'string' ||
    d.kdf?.alg !== 'scrypt' ||
    !Number.isInteger(d.kdf.N) ||
    d.kdf.N > 2 ** 20 ||
    typeof d.wrapped?.passphrase?.iv !== 'string'
  ) {
    throw new SyncKeyError('bad_keys', 'The sync keys on the server are unreadable (newer app version?).');
  }
  return d;
}

export async function unlockWithPassphrase(
  doc: SyncKeysDoc,
  passphrase: string,
  userId: string,
): Promise<Buffer> {
  const kek = await deriveKek(passphrase, userId, doc.kdf);
  try {
    return unwrapKey(kek, doc.wrapped.passphrase, 'passphrase');
  } catch {
    throw new SyncKeyError('wrong_passphrase', 'That sync passphrase is not correct.');
  }
}

export function unlockWithRecoveryKey(doc: SyncKeysDoc, recoveryKey: string, userId: string): Buffer {
  const entropy = parseRecoveryKey(recoveryKey);
  if (!doc.wrapped.recovery) {
    throw new SyncKeyError('wrong_recovery_key', 'No recovery key was set up for this sync data.');
  }
  try {
    return unwrapKey(recoveryKek(entropy, userId), doc.wrapped.recovery, 'recovery');
  } catch {
    throw new SyncKeyError('wrong_recovery_key', 'That recovery key does not match this sync data.');
  }
}

export async function rewrapPassphrase(
  doc: SyncKeysDoc,
  dek: Uint8Array,
  passphrase: string,
  userId: string,
): Promise<SyncKeysDoc> {
  const kek = await deriveKek(passphrase, userId, doc.kdf);
  return { ...doc, wrapped: { ...doc.wrapped, passphrase: wrapKey(kek, dek, 'passphrase') } };
}

export function rewrapRecovery(
  doc: SyncKeysDoc,
  dek: Uint8Array,
  userId: string,
): { doc: SyncKeysDoc; recoveryKey: string } {
  const r = generateRecoveryKey();
  return {
    doc: {
      ...doc,
      wrapped: { ...doc.wrapped, recovery: wrapKey(recoveryKek(r.entropy, userId), dek, 'recovery') },
    },
    recoveryKey: r.key,
  };
}

// ---- category payloads ----------------------------------------------------------------------------

const categoryAad = (category: string): string => `githappens-sync/v1:${category}`;

export function encryptCategory(
  dek: Uint8Array,
  category: string,
  value: unknown,
  deviceId: string,
): SyncPut {
  const { iv, ct } = seal(dek, gzipJson(value), categoryAad(category));
  return { ciphertext: b64(ct), nonce: b64(iv), deviceId };
}

export function decryptCategory(
  dek: Uint8Array,
  category: string,
  item: Pick<SyncItem, 'ciphertext' | 'nonce'>,
): unknown {
  let plain: Buffer;
  try {
    plain = open(dek, unb64(item.nonce), unb64(item.ciphertext), categoryAad(category));
  } catch {
    throw new SyncKeyError('decrypt', `Could not decrypt synced ${category} (different sync key?).`);
  }
  return gunzipJson(plain);
}

/**
 * The `_keys` category is not secret (it only holds wrapped keys), so it is stored as base64url
 * JSON; the nonce field is required by the API and carries random bytes that are not used.
 */
export function encodeKeysDoc(doc: SyncKeysDoc, deviceId: string): SyncPut {
  return { ciphertext: b64(Buffer.from(JSON.stringify(doc), 'utf8')), nonce: b64(randomBytes(12)), deviceId };
}

export function decodeKeysDoc(item: Pick<SyncItem, 'ciphertext'>): SyncKeysDoc {
  let parsed: unknown;
  try {
    parsed = JSON.parse(unb64(item.ciphertext).toString('utf8'));
  } catch {
    throw new SyncKeyError('bad_keys', 'The sync keys on the server are unreadable.');
  }
  return parseKeysDoc(parsed);
}
