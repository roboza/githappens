import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { presignUrl, S3BlobStore, type S3Config } from '../src/s3.ts';
import { call, createPatch, patchCrypto, signIn, startCloud } from './helpers.ts';

describe('SigV4 presigning', () => {
  it('matches the AWS documentation example (virtual-hosted GET)', () => {
    const url = presignUrl(
      {
        endpoint: 'https://s3.amazonaws.com',
        bucket: 'examplebucket',
        region: 'us-east-1',
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        forcePathStyle: false,
        prefix: '',
        direct: false,
      },
      { method: 'GET', key: 'test.txt', expiresSec: 86400, now: new Date('2013-05-24T00:00:00Z') },
    );
    expect(url.startsWith('https://examplebucket.s3.amazonaws.com/test.txt?')).toBe(true);
    expect(new URL(url).searchParams.get('X-Amz-Signature')).toBe(
      'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    );
  });

  it('parses GH_CLOUD_S3_* configuration', () => {
    const base = { GH_CLOUD_DEV_LOGIN: '1' };
    expect(loadConfig(base).s3).toBeUndefined();
    const c = loadConfig({
      ...base,
      GH_CLOUD_S3_ENDPOINT: 'http://127.0.0.1:9000',
      GH_CLOUD_S3_BUCKET: 'kl-patches',
      GH_CLOUD_S3_ACCESS_KEY_ID: 'ak',
      GH_CLOUD_S3_SECRET_ACCESS_KEY: 'sk',
    });
    expect(c.s3).toMatchObject({
      region: 'us-east-1',
      forcePathStyle: true,
      prefix: 'patches/',
      direct: false,
    });
    expect(() => loadConfig({ ...base, GH_CLOUD_S3_BUCKET: 'x' })).toThrow(/must be set together/);
  });
});

/** Minimal S3 server: verifies presigned signatures (recomputed) and keeps objects in memory. */
function fakeS3(cfg: () => S3Config): { server: Server; objects: Map<string, Buffer>; rejected: number } {
  const objects = new Map<string, Buffer>();
  const state = { server: null as unknown as Server, objects, rejected: 0 };
  state.server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const amzDate = u.searchParams.get('X-Amz-Date') ?? '';
    const now = new Date(
      `${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`,
    );
    const c = cfg();
    const prefix = `/${c.bucket}/`;
    const key = decodeURIComponent(u.pathname.slice(prefix.length));
    const expected = presignUrl(c, {
      method: req.method as 'GET',
      key,
      expiresSec: Number(u.searchParams.get('X-Amz-Expires')),
      now,
    });
    const ok =
      u.pathname.startsWith(prefix) &&
      new URL(expected).searchParams.get('X-Amz-Signature') === u.searchParams.get('X-Amz-Signature') &&
      now.getTime() + Number(u.searchParams.get('X-Amz-Expires')) * 1000 > Date.now();
    if (!ok) {
      state.rejected++;
      res.writeHead(403).end('<Error><Code>SignatureDoesNotMatch</Code></Error>');
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const obj = objects.get(key);
      if (req.method === 'PUT') {
        objects.set(key, Buffer.concat(chunks));
        res.writeHead(200).end();
      } else if (req.method === 'DELETE') {
        objects.delete(key);
        res.writeHead(204).end();
      } else if (!obj) res.writeHead(404).end();
      else if (req.method === 'HEAD') res.writeHead(200, { 'content-length': obj.length }).end();
      else res.writeHead(200, { 'content-length': obj.length }).end(obj);
    });
  });
  return state;
}

for (const direct of [false, true]) {
  describe(`S3 blob store against a fake S3 (${direct ? 'direct' : 'proxied'})`, () => {
    let s3: ReturnType<typeof fakeS3>;
    let cfg: S3Config;
    beforeAll(async () => {
      s3 = fakeS3(() => cfg);
      await new Promise<void>((r) => s3.server.listen(0, '127.0.0.1', r));
      cfg = {
        endpoint: `http://127.0.0.1:${(s3.server.address() as AddressInfo).port}`,
        bucket: 'kl-test',
        region: 'us-east-1',
        accessKeyId: 'AKTEST',
        secretAccessKey: 'secret-test-key',
        forcePathStyle: true,
        prefix: 'patches/',
        direct,
      };
    });
    afterAll(() => new Promise<void>((r) => s3.server.close(() => r())));

    it('stores, serves and purges Cloud Patch blobs', async () => {
      const cloud = await startCloud({}, { blobs: (secret) => new S3BlobStore(cfg, secret) });
      try {
        const s = await signIn(cloud, 's3@example.com');
        const { meta, sealed } = await createPatch(cloud, s);
        const stored = s3.objects.get(`patches/${meta.id}`)!;
        expect(stored).toBeDefined();
        // proxied mode encrypts at rest (iv + tag overhead); direct mode keeps the uploaded bytes
        expect(stored.length).toBe(sealed.bytes.length + (direct ? 0 : 28));
        expect(Buffer.from(stored).equals(Buffer.from(sealed.bytes))).toBe(direct);

        const got = await call(cloud, 'GET', `/v1/patches/${meta.id}`);
        expect(got.status).toBe(200);
        expect(got.json.downloadUrl.startsWith(direct ? cfg.endpoint : `${cloud.url}/v1/blobs/`)).toBe(true);
        const bytes = new Uint8Array(await (await fetch(got.json.downloadUrl)).arrayBuffer());
        expect(Buffer.from(bytes).equals(Buffer.from(sealed.bytes))).toBe(true);
        expect((await (await patchCrypto()).openPatchBlob(bytes)).patch).toContain('+new');
        if (direct) {
          const page = await fetch(`${cloud.url}/p/${meta.id}`);
          expect(page.headers.get('content-security-policy')).toContain(cfg.endpoint);
        }

        expect((await call(cloud, 'DELETE', `/v1/patches/${meta.id}`, { token: s.access })).status).toBe(204);
        await cloud.app.runJobs();
        expect(s3.objects.has(`patches/${meta.id}`)).toBe(false);
        expect(s3.rejected).toBe(0);
      } finally {
        await cloud.close();
      }
    });

    it('rejects a wrong secret (signature check is real)', async () => {
      const store = new S3BlobStore({ ...cfg, secretAccessKey: 'wrong' }, Buffer.alloc(32, 1));
      const before = s3.rejected;
      await expect(
        store.put(
          'A'.repeat(22),
          (async function* () {
            yield new Uint8Array([1, 2, 3]);
          })(),
          10,
        ),
      ).rejects.toThrow(/403/);
      expect(s3.rejected).toBe(before + 1);
    });
  });
}

/** Optional: real MinIO (`GH_CLOUD_TEST_S3_URL=http://127.0.0.1:9000`, bucket created by the test). */
const MINIO = process.env.GH_CLOUD_TEST_S3_URL;
describe.skipIf(!MINIO)('S3 blob store against MinIO', () => {
  it('round-trips through a real S3 implementation', async () => {
    const cfg: S3Config = {
      endpoint: MINIO!,
      bucket: process.env.GH_CLOUD_TEST_S3_BUCKET ?? 'kl-test',
      region: 'us-east-1',
      accessKeyId: process.env.GH_CLOUD_TEST_S3_KEY ?? 'minioadmin',
      secretAccessKey: process.env.GH_CLOUD_TEST_S3_SECRET ?? 'minioadmin',
      forcePathStyle: true,
      prefix: 'patches/',
      direct: false,
    };
    // create the bucket (409 when it already exists)
    const mk = await fetch(presignUrl(cfg, { method: 'PUT', expiresSec: 60 }), { method: 'PUT' });
    expect([200, 409]).toContain(mk.status);
    for (const direct of [false, true]) {
      const cloud = await startCloud({}, { blobs: (secret) => new S3BlobStore({ ...cfg, direct }, secret) });
      try {
        const s = await signIn(cloud, `minio-${direct}@example.com`);
        const { meta, sealed } = await createPatch(cloud, s);
        const got = await call(cloud, 'GET', `/v1/patches/${meta.id}`);
        const bytes = new Uint8Array(await (await fetch(got.json.downloadUrl)).arrayBuffer());
        expect(Buffer.from(bytes).equals(Buffer.from(sealed.bytes))).toBe(true);
        await call(cloud, 'DELETE', `/v1/patches/${meta.id}`, { token: s.access });
        await cloud.app.runJobs();
        const head = await fetch(
          presignUrl(cfg, { method: 'HEAD', key: `patches/${meta.id}`, expiresSec: 60 }),
          {
            method: 'HEAD',
          },
        );
        expect(head.status).toBe(404);
      } finally {
        await cloud.close();
      }
    }
  });
});
