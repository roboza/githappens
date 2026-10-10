/**
 * S3-compatible object storage (AWS S3, MinIO, Ceph RGW, R2, …) for Cloud Patch blobs, implemented
 * with `node:crypto` (AWS Signature Version 4 query presigning) and global `fetch` — no AWS SDK.
 *
 * Every request the server makes is itself a presigned URL (signed headers: `host` only, payload
 * `UNSIGNED-PAYLOAD`), so the same code produces the URLs that `GH_CLOUD_S3_DIRECT=1` hands to
 * clients for direct upload/download.
 *
 * At rest: unless `direct` is on, blobs are stored as `iv(12) | AES-256-GCM(ciphertext) | tag(16)`
 * with a key derived from the server secret (same layout as {@link FsBlobStore}), independent of any
 * bucket-side encryption. In direct mode clients read/write the bucket themselves, so bytes are stored
 * as uploaded; configure default bucket encryption (SSE-S3 / SSE-KMS) instead.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { BlobTooLargeError, type BlobInfo, type BlobStore } from './blob.ts';
import { deriveKey, PATCH_ID_RE } from './crypto.ts';

export interface S3Config {
  /** `https://s3.eu-west-1.amazonaws.com`, `http://127.0.0.1:9000`, … (no trailing slash). */
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** `<endpoint>/<bucket>/<key>` (MinIO default) instead of `<bucket>.<endpoint host>/<key>`. */
  forcePathStyle: boolean;
  /** Key prefix inside the bucket, e.g. `patches/`. */
  prefix: string;
  /** Hand presigned bucket URLs to clients (upload/download bypass this server). */
  direct: boolean;
}

export interface PresignInput {
  method: 'GET' | 'PUT' | 'HEAD' | 'DELETE';
  /** Object key (already including the prefix); `undefined` addresses the bucket itself. */
  key?: string;
  expiresSec: number;
  /** Signing time (tests). */
  now?: Date;
  /** Extra query parameters to sign (e.g. `list-type=2`). */
  query?: Record<string, string>;
}

/** RFC 3986 encoding as SigV4 requires (`encodeURIComponent` leaves `!'()*` alone). */
export function uriEncode(value: string, keepSlash = false): string {
  const out = encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return keepSlash ? out.replace(/%2F/g, '/') : out;
}

const sha256hex = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string): Buffer => createHmac('sha256', key).update(data).digest();

function amzDate(d: Date): { date: string; stamp: string } {
  const iso = d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  return { stamp: iso, date: iso.slice(0, 8) };
}

/** Host + canonical path for a key under the configured addressing style. */
export function objectLocation(c: S3Config, key: string | undefined): { origin: string; path: string } {
  const ep = new URL(c.endpoint);
  const keyPath = key ? `/${uriEncode(key, true)}` : '/';
  if (c.forcePathStyle) {
    return { origin: ep.origin, path: `/${uriEncode(c.bucket)}${key ? keyPath : ''}` };
  }
  return { origin: `${ep.protocol}//${c.bucket}.${ep.host}`, path: keyPath };
}

/** AWS SigV4 query-string presigned URL (signed headers: host). */
export function presignUrl(c: S3Config, input: PresignInput): string {
  const { origin, path } = objectLocation(c, input.key);
  const host = new URL(origin).host;
  const { date, stamp } = amzDate(input.now ?? new Date());
  const scope = `${date}/${c.region}/s3/aws4_request`;
  const params: Record<string, string> = {
    ...input.query,
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${c.accessKeyId}/${scope}`,
    'X-Amz-Date': stamp,
    'X-Amz-Expires': String(Math.max(1, Math.min(604_800, Math.floor(input.expiresSec)))),
    'X-Amz-SignedHeaders': 'host',
  };
  if (c.sessionToken) params['X-Amz-Security-Token'] = c.sessionToken;
  const canonicalQuery = Object.keys(params)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(params[k]!)}`)
    .join('&');
  const canonicalRequest = [
    input.method,
    path,
    canonicalQuery,
    `host:${host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256hex(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${c.secretAccessKey}`, date);
  const kRegion = hmac(kDate, c.region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return `${origin}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

export class S3Error extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'S3Error';
    this.status = status;
  }
}

const IV = 12;
const TAG = 16;
const SIGN_TTL = 300;

export type S3Fetch = (url: string, init: RequestInit) => Promise<Response>;

export class S3BlobStore implements BlobStore {
  private readonly key: Buffer;
  private readonly c: S3Config;
  private readonly fetchImpl: S3Fetch;
  constructor(config: S3Config, secret: Buffer, fetchImpl: S3Fetch = (u, i) => fetch(u, i)) {
    this.c = config;
    this.key = deriveKey(secret, 'blob-at-rest');
    this.fetchImpl = fetchImpl;
  }

  get direct(): boolean {
    return this.c.direct;
  }

  /** Origin clients talk to in direct mode (web viewer CSP `connect-src`). */
  get publicOrigin(): string {
    return objectLocation(this.c, 'x').origin;
  }

  private objectKey(key: string): string {
    if (!PATCH_ID_RE.test(key)) throw new Error('invalid blob key');
    return `${this.c.prefix}${key}`;
  }

  /** Presigned URL for clients (direct mode only). */
  presign(key: string, op: 'put' | 'get', ttlSec: number): string | undefined {
    if (!this.c.direct) return undefined;
    return presignUrl(this.c, {
      method: op === 'put' ? 'PUT' : 'GET',
      key: this.objectKey(key),
      expiresSec: ttlSec,
    });
  }

  private async send(method: PresignInput['method'], key: string, body?: Buffer): Promise<Response> {
    const url = presignUrl(this.c, { method, key: this.objectKey(key), expiresSec: SIGN_TTL });
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        ...(body ? { body, headers: { 'content-type': 'application/octet-stream' } } : {}),
      });
    } catch (err) {
      throw new S3Error(0, `object storage unreachable: ${(err as Error).message}`);
    }
    return res;
  }

  async put(key: string, data: AsyncIterable<Uint8Array>, maxBytes: number): Promise<BlobInfo> {
    const chunks: Buffer[] = [];
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of data) {
      size += chunk.length;
      if (size > maxBytes) throw new BlobTooLargeError();
      const b = Buffer.from(chunk);
      hash.update(b);
      chunks.push(b);
    }
    const plain = Buffer.concat(chunks);
    const body = this.c.direct ? plain : this.seal(plain);
    const res = await this.send('PUT', key, body);
    await res.arrayBuffer().catch(() => undefined);
    if (!res.ok) throw new S3Error(res.status, `object storage PUT failed (${res.status})`);
    return { size, sha256: hash.digest('hex') };
  }

  async stat(key: string): Promise<number | undefined> {
    const res = await this.send('HEAD', key);
    await res.arrayBuffer().catch(() => undefined);
    if (res.status === 404) return undefined;
    if (!res.ok) throw new S3Error(res.status, `object storage HEAD failed (${res.status})`);
    const len = Number(res.headers.get('content-length') ?? NaN);
    if (!Number.isFinite(len)) return undefined;
    return this.c.direct ? len : Math.max(0, len - IV - TAG);
  }

  private async getBytes(key: string): Promise<Buffer | undefined> {
    const res = await this.send('GET', key);
    if (res.status === 404) {
      await res.arrayBuffer().catch(() => undefined);
      return undefined;
    }
    if (!res.ok) {
      await res.arrayBuffer().catch(() => undefined);
      throw new S3Error(res.status, `object storage GET failed (${res.status})`);
    }
    const raw = Buffer.from(await res.arrayBuffer());
    return this.c.direct ? raw : this.open(raw);
  }

  async read(key: string): Promise<Readable | undefined> {
    const bytes = await this.getBytes(key);
    return bytes ? Readable.from([bytes]) : undefined;
  }

  async digest(key: string): Promise<BlobInfo | undefined> {
    const bytes = await this.getBytes(key);
    if (!bytes) return undefined;
    return { size: bytes.length, sha256: sha256hex(bytes) };
  }

  async delete(key: string): Promise<void> {
    const res = await this.send('DELETE', key);
    await res.arrayBuffer().catch(() => undefined);
    if (!res.ok && res.status !== 404)
      throw new S3Error(res.status, `object storage DELETE failed (${res.status})`);
  }

  private seal(plain: Buffer): Buffer {
    const iv = randomBytes(IV);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    return Buffer.concat([iv, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  }

  private open(sealed: Buffer): Buffer {
    if (sealed.length < IV + TAG) throw new S3Error(500, 'stored blob is truncated');
    const decipher = createDecipheriv('aes-256-gcm', this.key, sealed.subarray(0, IV));
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG));
    return Buffer.concat([decipher.update(sealed.subarray(IV, sealed.length - TAG)), decipher.final()]);
  }
}
