/**
 * Server-side crypto helpers: ids, opaque tokens, HMAC-signed stateless tokens, Ed25519 JWTs and
 * the key material (generated + persisted to the data dir when not configured).
 */
import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
  randomBytes,
  randomUUID,
  sign as edSign,
  timingSafeEqual,
  verify as edVerify,
} from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CloudConfig } from './config.ts';

export const uuid = (): string => randomUUID();

export const b64url = (buf: Uint8Array): string => Buffer.from(buf).toString('base64url');

export function fromB64url(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

export const B64URL_RE = /^[A-Za-z0-9_-]*$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const PATCH_ID_RE = /^[0-9A-Za-z]{22}$/;

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** 22-char base62 encoding of 128 random bits (contract: patch ids). */
export function newPatchId(): string {
  let n = BigInt(`0x${randomBytes(16).toString('hex')}`);
  let out = '';
  for (let i = 0; i < 22; i++) {
    out = BASE62[Number(n % 62n)]! + out;
    n /= 62n;
  }
  return out;
}

/** Opaque 256-bit token (refresh tokens, auth codes, invite tokens). */
export function randomToken(prefix = ''): string {
  return prefix + randomBytes(32).toString('base64url');
}

export function sha256(data: string | Uint8Array): Buffer {
  return createHash('sha256').update(data).digest();
}

export function safeEqual(a: string | Uint8Array, b: string | Uint8Array): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** RFC 7636 S256: base64url(sha256(verifier)). */
export function pkceChallenge(verifier: string): string {
  return sha256(verifier).toString('base64url');
}

// ---- key material -------------------------------------------------------------------------------

export interface KeyMaterial {
  /** 32-byte server secret (HMAC tokens, blob encryption key derivation). */
  secret: Buffer;
  jwtKid: string;
  jwtPrivateKey: KeyObject;
  /** kid → public key: the current key plus any previous keys still accepted. */
  jwtPublicKeys: Map<string, KeyObject>;
}

export function keyId(publicKey: KeyObject): string {
  return sha256(publicKey.export({ type: 'spki', format: 'der' }))
    .toString('base64url')
    .slice(0, 16);
}

function readOrCreate(path: string, create: () => string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const value = create();
  writeFileSync(path, value, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return value;
}

/**
 * Load the JWT signing key and server secret from config, or generate them once and persist them
 * in `dataDir` (mode 0600) so restarts keep tokens and blob encryption valid.
 */
export function loadKeyMaterial(config: CloudConfig, persist = true): KeyMaterial {
  let pem = config.jwtPrivateKeyPem;
  let secretText = config.secret;
  if ((!pem || !secretText) && persist) mkdirSync(config.dataDir, { recursive: true });
  if (!pem) {
    const gen = (): string =>
      generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    pem = persist ? readOrCreate(join(config.dataDir, 'jwt-ed25519.pem'), gen) : gen();
  }
  if (!secretText) {
    const gen = (): string => randomBytes(32).toString('base64url');
    secretText = persist ? readOrCreate(join(config.dataDir, 'server-secret'), gen).trim() : gen();
  }
  const jwtPrivateKey = createPrivateKey(pem);
  if (jwtPrivateKey.asymmetricKeyType !== 'ed25519')
    throw new Error('GH_CLOUD_JWT_KEY must be an Ed25519 key');
  const publicKey = createPublicKey(jwtPrivateKey);
  const jwtKid = keyId(publicKey);
  const jwtPublicKeys = new Map<string, KeyObject>([[jwtKid, publicKey]]);
  for (const prev of config.jwtPreviousPublicKeysPem) {
    const k = createPublicKey(prev);
    jwtPublicKeys.set(keyId(k), k);
  }
  // HKDF salt 'githappens-cloud' (here and in deriveKey): every derived key (blob-at-rest encryption,
  // signed tokens) depends on it, so changing it invalidates existing blobs and tokens.
  const secret = Buffer.from(hkdfSync('sha256', secretText, 'githappens-cloud', 'server-secret', 32));
  return { secret, jwtKid, jwtPrivateKey, jwtPublicKeys };
}

export function deriveKey(secret: Buffer, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, 'githappens-cloud', purpose, 32));
}

// ---- HMAC-signed stateless tokens ---------------------------------------------------------------

/**
 * `<base64url(JSON payload)>.<base64url(HMAC)>`, bound to a purpose (a token minted for one purpose
 * never verifies for another). Payloads carry `exp` in epoch seconds.
 */
export class TokenSigner {
  private readonly key: Buffer;
  constructor(secret: Buffer) {
    this.key = deriveKey(secret, 'signed-tokens');
  }

  sign(purpose: string, payload: Record<string, unknown> & { exp: number }): string {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${this.mac(purpose, body)}`;
  }

  verify<T extends { exp: number }>(purpose: string, token: string, nowMs: number): T | undefined {
    if (token.length > 8192) return undefined;
    const dot = token.indexOf('.');
    if (dot <= 0 || dot !== token.lastIndexOf('.')) return undefined;
    const body = token.slice(0, dot);
    const mac = token.slice(dot + 1);
    if (!B64URL_RE.test(body) || !B64URL_RE.test(mac)) return undefined;
    if (!safeEqual(mac, this.mac(purpose, body))) return undefined;
    let payload: T;
    try {
      payload = JSON.parse(fromB64url(body).toString('utf8')) as T;
    } catch {
      return undefined;
    }
    if (typeof payload !== 'object' || payload === null || typeof payload.exp !== 'number') return undefined;
    if (payload.exp * 1000 <= nowMs) return undefined;
    return payload;
  }

  private mac(purpose: string, body: string): string {
    return createHmac('sha256', this.key).update(`${purpose}\n${body}`).digest('base64url');
  }
}

// ---- JWT (EdDSA) --------------------------------------------------------------------------------

export interface AccessClaims {
  iss: string;
  aud: string;
  sub: string;
  iat: number;
  exp: number;
  jti: string;
}

export const JWT_AUDIENCE = 'githappens-desktop';

export function signJwt(keys: KeyMaterial, claims: AccessClaims): string {
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: keys.jwtKid })));
  const payload = b64url(Buffer.from(JSON.stringify(claims)));
  const sig = edSign(null, Buffer.from(`${header}.${payload}`), keys.jwtPrivateKey);
  return `${header}.${payload}.${b64url(sig)}`;
}

export function verifyJwt(
  keys: KeyMaterial,
  token: string,
  issuer: string,
  nowMs: number,
): AccessClaims | undefined {
  if (token.length > 4096) return undefined;
  const parts = token.split('.');
  if (parts.length !== 3 || !parts.every((p) => p.length > 0 && B64URL_RE.test(p))) return undefined;
  const [h, p, s] = parts as [string, string, string];
  let header: { alg?: unknown; kid?: unknown };
  let claims: AccessClaims;
  try {
    header = JSON.parse(fromB64url(h).toString('utf8')) as typeof header;
    claims = JSON.parse(fromB64url(p).toString('utf8')) as AccessClaims;
  } catch {
    return undefined;
  }
  if (header.alg !== 'EdDSA' || typeof header.kid !== 'string') return undefined;
  const key = keys.jwtPublicKeys.get(header.kid);
  if (!key) return undefined;
  if (!edVerify(null, Buffer.from(`${h}.${p}`), key, fromB64url(s))) return undefined;
  if (typeof claims !== 'object' || claims === null) return undefined;
  if (claims.iss !== issuer || claims.aud !== JWT_AUDIENCE) return undefined;
  if (typeof claims.sub !== 'string' || typeof claims.exp !== 'number') return undefined;
  if (claims.exp * 1000 <= nowMs) return undefined;
  return claims;
}
