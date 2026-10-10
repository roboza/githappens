/**
 * Load test (spec 14 §7 step 12: "1k patches/min"). Creates Cloud Patches end to end — POST
 * /v1/patches → PUT blob → POST complete → GET metadata → GET blob — at a target rate and reports
 * throughput and latency percentiles.
 *
 *   node --disable-warning=ExperimentalWarning scripts/load-test.ts [--rate=1000] [--total=1000]
 *        [--concurrency=64] [--url=http://localhost:8787] [--size=8192]
 *
 * Without `--url` an in-process server is started (memory store, temp blob dir, dev login, rate limits
 * lifted). With `--url` the target must run with `GH_CLOUD_DEV_LOGIN=1` and generous rate limits.
 * `GH_CLOUD_DATABASE_URL` (in-process only) uses Postgres instead of the memory store.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCloudApp } from '../src/app.ts';
import { FsBlobStore } from '../src/blob.ts';
import { makeConfig } from '../src/config.ts';
import { loadKeyMaterial } from '../src/crypto.ts';
import { MemoryStore } from '../src/store/memory.ts';
import { PgStore } from '../src/store/pg.ts';
import type { Store } from '../src/store/types.ts';

const arg = (name: string, def: string): string =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? def;

const RATE = Number(arg('rate', '1000')); // patches per minute
const TOTAL = Number(arg('total', '1000'));
const CONCURRENCY = Number(arg('concurrency', '64'));
const SIZE = Number(arg('size', '8192'));
const REDIRECT = 'http://127.0.0.1:53682/callback';

async function startLocal(): Promise<{ url: string; stop(): Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), 'kl-load-'));
  const big = { capacity: 10_000_000, refillPerMinute: 10_000_000 };
  const config = makeConfig({
    devLogin: true,
    blobDir: dir,
    dataDir: dir,
    rateLimitIp: big,
    rateLimitUser: big,
    rateLimitAuth: big,
  });
  const pgUrl = process.env.GH_CLOUD_DATABASE_URL;
  const schema = `load_${randomBytes(4).toString('hex')}`;
  const store: Store = pgUrl
    ? await PgStore.open({ connectionString: pgUrl, schema, max: 20 })
    : new MemoryStore();
  const keys = loadKeyMaterial(config, false);
  const app = createCloudApp(config, {
    store,
    blobs: new FsBlobStore(dir, keys.secret),
    keys,
    logSink: () => undefined,
  });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  config.publicUrl = url;
  return {
    url,
    stop: async () => {
      app.server.closeAllConnections();
      await new Promise<void>((r) => app.server.close(() => r()));
      if (store instanceof PgStore) await store.dropSchema(schema);
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function signIn(base: string, email: string): Promise<string> {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: 'desktop',
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'load',
    idp: 'dev',
  });
  const page = await (await fetch(`${base}/oauth/authorize?${q}`)).text();
  const areq = /name="areq" value="([^"]+)"/
    .exec(page)?.[1]
    ?.replace(/&#(\d+);/g, (_x, n: string) => String.fromCharCode(Number(n)));
  if (!areq) throw new Error('dev login is not enabled on the target server');
  const res = await fetch(`${base}/oauth/dev`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ areq, email }).toString(),
  });
  const code = new URL(res.headers.get('location')!).searchParams.get('code');
  const tok = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: 'desktop',
    }),
  });
  return ((await tok.json()) as { access_token: string }).access_token;
}

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

async function onePatch(base: string, token: string): Promise<number[]> {
  const t: number[] = [];
  const bytes = randomBytes(SIZE);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const step = async <T>(fn: () => Promise<Response>, expect: number): Promise<T> => {
    const s = performance.now();
    const res = await fn();
    const body =
      res.status === 204
        ? undefined
        : res.headers.get('content-type')?.includes('json')
          ? await res.json()
          : await res.arrayBuffer();
    t.push(performance.now() - s);
    if (res.status !== expect) throw new Error(`HTTP ${res.status}: ${JSON.stringify(body)}`);
    return body as T;
  };
  const created = await step<{ id: string; uploadUrl: string }>(
    () =>
      fetch(`${base}/v1/patches`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          title: 'load test',
          kind: 'wip',
          baseSha: 'a'.repeat(40),
          e2e: true,
          size: bytes.length,
          sha256,
          visibility: 'link',
        }),
      }),
    201,
  );
  await step(() => fetch(created.uploadUrl, { method: 'PUT', body: bytes }), 200);
  await step(
    () => fetch(`${base}/v1/patches/${created.id}/complete`, { method: 'POST', headers: auth }),
    200,
  );
  const meta = await step<{ downloadUrl: string }>(() => fetch(`${base}/v1/patches/${created.id}`), 200);
  await step(() => fetch(meta.downloadUrl), 200);
  return t;
}

async function main(): Promise<void> {
  const target = arg('url', '');
  const local = target ? null : await startLocal();
  const base = target || local!.url;
  try {
    const tokens = await Promise.all(
      Array.from({ length: 8 }, (_, i) => signIn(base, `load${i}@example.com`)),
    );
    const intervalMs = 60_000 / RATE;
    const totals: number[] = [];
    const steps: number[][] = [[], [], [], [], []];
    let failures = 0;
    let inFlight = 0;
    const started = performance.now();
    const pending: Promise<void>[] = [];
    for (let i = 0; i < TOTAL; i++) {
      const due = started + i * intervalMs;
      const wait = due - performance.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      while (inFlight >= CONCURRENCY) await new Promise((r) => setTimeout(r, 1));
      inFlight++;
      const s = performance.now();
      pending.push(
        onePatch(base, tokens[i % tokens.length]!)
          .then((t) => {
            totals.push(performance.now() - s);
            t.forEach((v, k) => steps[k]!.push(v));
          })
          .catch((e: unknown) => {
            failures++;
            if (failures <= 3) process.stderr.write(`patch ${i} failed: ${(e as Error).message}\n`);
          })
          .finally(() => inFlight--),
      );
    }
    await Promise.all(pending);
    const elapsed = (performance.now() - started) / 1000;
    totals.sort((a, b) => a - b);
    const names = ['create', 'upload', 'complete', 'get meta', 'download'];
    const fmt = (n: number): string => `${n.toFixed(1)} ms`;
    process.stdout.write(
      [
        `target: ${target || `in-process (${process.env.GH_CLOUD_DATABASE_URL ? 'postgres' : 'memory'} store)`}`,
        `patches: ${TOTAL - failures}/${TOTAL} ok, ${failures} failed, blob ${SIZE} B, concurrency ≤ ${CONCURRENCY}`,
        `elapsed: ${elapsed.toFixed(1)} s → ${(((TOTAL - failures) / elapsed) * 60).toFixed(0)} patches/min (target ${RATE}/min)`,
        `end-to-end (5 requests): p50 ${fmt(pct(totals, 50))}, p95 ${fmt(pct(totals, 95))}, p99 ${fmt(pct(totals, 99))}, max ${fmt(totals.at(-1) ?? 0)}`,
        ...names.map((n, k) => {
          const s = steps[k]!.sort((a, b) => a - b);
          return `  ${n.padEnd(9)} p50 ${fmt(pct(s, 50))}  p95 ${fmt(pct(s, 95))}  p99 ${fmt(pct(s, 99))}`;
        }),
      ].join('\n') + '\n',
    );
    if (failures) process.exitCode = 1;
  } finally {
    await local?.stop();
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`load test failed: ${(e as Error).message}\n`);
  process.exit(1);
});
