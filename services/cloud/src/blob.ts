/**
 * Blob storage for Cloud Patch payloads. {@link FsBlobStore} keeps one file per blob under
 * `GH_CLOUD_BLOB_DIR`; `S3BlobStore` (s3.ts) uses any S3-compatible bucket (`GH_CLOUD_S3_*`).
 *
 * Server-side encryption at rest (spec 14 §6.8, independent of the client's optional e2e layer):
 * each file is `iv(12) | AES-256-GCM(ciphertext) | tag(16)` with a key derived from the server
 * secret. Losing the secret makes stored blobs unreadable.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { deriveKey, PATCH_ID_RE, uuid } from './crypto.ts';

export class BlobTooLargeError extends Error {
  constructor() {
    super('blob exceeds the declared size');
    this.name = 'BlobTooLargeError';
  }
}

export interface BlobInfo {
  size: number;
  sha256: string;
}

export interface BlobStore {
  /** Store `data` under `key`, refusing more than `maxBytes` (throws {@link BlobTooLargeError}). */
  put(key: string, data: AsyncIterable<Uint8Array>, maxBytes: number): Promise<BlobInfo>;
  /** Plaintext size, or undefined if absent. */
  stat(key: string): Promise<number | undefined>;
  /** Plaintext size + sha256 (reads the whole blob). */
  digest(key: string): Promise<BlobInfo | undefined>;
  /** Plaintext stream, or undefined if absent. */
  read(key: string): Promise<Readable | undefined>;
  delete(key: string): Promise<void>;
  /**
   * Presigned URL that lets a client upload/download the blob directly (S3 direct mode); undefined =
   * clients go through this server's `/v1/blobs/<token>` URLs.
   */
  presign?(key: string, op: 'put' | 'get', ttlSec: number): string | undefined;
  /** Origin of presigned URLs (web viewer CSP), when `presign` returns URLs. */
  readonly publicOrigin?: string;
}

const IV = 12;
const TAG = 16;

export class FsBlobStore implements BlobStore {
  private readonly key: Buffer;
  private readonly dir: string;
  constructor(dir: string, secret: Buffer) {
    this.dir = dir;
    this.key = deriveKey(secret, 'blob-at-rest');
  }

  private path(key: string): string {
    if (!PATCH_ID_RE.test(key)) throw new Error('invalid blob key');
    return join(this.dir, key.slice(0, 2).toLowerCase(), `${key}.bin`);
  }

  async put(key: string, data: AsyncIterable<Uint8Array>, maxBytes: number): Promise<BlobInfo> {
    const final = this.path(key);
    await mkdir(dirname(final), { recursive: true });
    const tmp = `${final}.${uuid()}.tmp`;
    const iv = randomBytes(IV);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const hash = createHash('sha256');
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > maxBytes) {
          cb(new BlobTooLargeError());
          return;
        }
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    const out = createWriteStream(tmp, { mode: 0o600 });
    try {
      out.write(iv);
      await pipeline(Readable.from(data), meter, cipher, out, { end: false });
      await new Promise<void>((resolve, reject) =>
        out.end(cipher.getAuthTag(), (err?: Error | null) => (err ? reject(err) : resolve())),
      );
      await rename(tmp, final);
    } catch (err) {
      out.destroy();
      await rm(tmp, { force: true });
      throw err;
    }
    return { size, sha256: hash.digest('hex') };
  }

  async stat(key: string): Promise<number | undefined> {
    try {
      const s = await stat(this.path(key));
      return Math.max(0, s.size - IV - TAG);
    } catch {
      return undefined;
    }
  }

  async read(key: string): Promise<Readable | undefined> {
    const p = this.path(key);
    let fh;
    try {
      fh = await open(p, 'r');
    } catch {
      return undefined;
    }
    let iv: Buffer;
    let tag: Buffer;
    let total: number;
    try {
      total = (await fh.stat()).size;
      if (total < IV + TAG) return undefined;
      iv = Buffer.alloc(IV);
      tag = Buffer.alloc(TAG);
      await fh.read(iv, 0, IV, 0);
      await fh.read(tag, 0, TAG, total - TAG);
    } finally {
      await fh.close();
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    if (total === IV + TAG) {
      // Empty plaintext: no ciphertext bytes to stream.
      return Readable.from([decipher.final()]);
    }
    const src = createReadStream(p, { start: IV, end: total - TAG - 1 });
    src.on('error', (err) => decipher.destroy(err));
    return src.pipe(decipher);
  }

  async digest(key: string): Promise<BlobInfo | undefined> {
    const stream = await this.read(key);
    if (!stream) return undefined;
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      size += chunk.length;
      hash.update(chunk);
    }
    return { size, sha256: hash.digest('hex') };
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
}
