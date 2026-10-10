/**
 * In-process test harness: the full HTTP API on 127.0.0.1 against MemoryStore (default) or
 * PgStore when GH_CLOUD_TEST_PG_URL is set (fresh schema per server), a temp blob dir, a
 * controllable clock, a capturing mailer and a scriptable upstream fetch.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PatchFile } from '@githappens/cloud-api/types';
import { type CloudApp, createCloudApp } from '../src/app.ts';
import { type BlobStore, FsBlobStore } from '../src/blob.ts';
import { type CloudConfig, makeConfig } from '../src/config.ts';
import type { FetchLike } from '../src/context.ts';
import { loadKeyMaterial } from '../src/crypto.ts';
import type { LogEntry } from '../src/logger.ts';
import type { MailMessage } from '../src/mail.ts';
import { MemoryStore } from '../src/store/memory.ts';
import { PgStore } from '../src/store/pg.ts';
import type { Store } from '../src/store/types.ts';

export const PG_URL = process.env.GH_CLOUD_TEST_PG_URL;
export const STORE_KIND = PG_URL ? 'postgres' : 'memory';

export const REDIRECT = 'http://127.0.0.1:53682/callback';
export const DAY = 86_400_000;

export interface TestCloud {
  url: string;
  app: CloudApp;
  config: CloudConfig;
  store: Store;
  blobDir: string;
  clock: { now: number };
  mail: MailMessage[];
  logs: LogEntry[];
  setUpstream(f: FetchLike): void;
  close(): Promise<void>;
}

export async function startCloud(
  overrides: Partial<CloudConfig> = {},
  opts: { blobs?: (secret: Buffer) => BlobStore } = {},
): Promise<TestCloud> {
  const blobDir = mkdtempSync(join(tmpdir(), 'kl-cloud-test-'));
  const config = makeConfig({
    devLogin: true,
    mailTransport: 'log',
    blobDir,
    dataDir: blobDir,
    rateLimitIp: { capacity: 100_000, refillPerMinute: 100_000 },
    rateLimitUser: { capacity: 100_000, refillPerMinute: 100_000 },
    rateLimitAuth: { capacity: 100_000, refillPerMinute: 100_000 },
    ...overrides,
  });
  const schema = `t_${randomBytes(6).toString('hex')}`;
  const store: Store = PG_URL
    ? await PgStore.open({ connectionString: PG_URL, schema, max: 4 })
    : new MemoryStore();
  const keys = loadKeyMaterial(config, false);
  const clock = { now: Date.UTC(2026, 9, 1, 12, 0, 0) };
  const mail: MailMessage[] = [];
  const logs: LogEntry[] = [];
  let upstream: FetchLike = async () => new Response('no upstream configured', { status: 599 });
  const app = createCloudApp(config, {
    store,
    blobs: opts.blobs ? opts.blobs(keys.secret) : new FsBlobStore(blobDir, keys.secret),
    keys,
    now: () => clock.now,
    mailer: { send: async (m) => void mail.push(m) },
    fetch: (url, init) => upstream(url, init),
    logSink: (e) => logs.push(e),
  });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const { port } = app.server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  if (!overrides.publicUrl) config.publicUrl = url;
  return {
    url,
    app,
    config,
    store,
    blobDir,
    clock,
    mail,
    logs,
    setUpstream: (f) => {
      upstream = f;
    },
    close: async () => {
      await new Promise<void>((resolve) => {
        app.server.closeAllConnections();
        app.server.close(() => resolve());
      });
      if (store instanceof PgStore) await store.dropSchema(schema);
      await store.close();
      rmSync(blobDir, { recursive: true, force: true });
    },
  };
}

export interface Res {
  status: number;
  json: any;
  text: string;
  headers: Headers;
}

export async function call(
  cloud: { url: string },
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; headers?: Record<string, string>; raw?: Uint8Array | string } = {},
): Promise<Res> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  let body = opts.raw as RequestInit['body'];
  if (opts.body !== undefined) {
    headers['content-type'] ??= 'application/json';
    body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
  }
  const url = path.startsWith('http') ? path : `${cloud.url}${path}`;
  const res = await fetch(url, { method, headers, body, redirect: 'manual' });
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text, headers: res.headers };
}

export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export function authorizePath(challenge: string, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: 'desktop',
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'st-123',
    ...extra,
  });
  return `/oauth/authorize?${q}`;
}

export function hiddenAreq(html: string): string {
  const m = /name="areq" value="([^"]+)"/.exec(html);
  if (!m) throw new Error('no areq in page');
  return m[1]!.replace(/&#(\d+);/g, (_x, n: string) => String.fromCharCode(Number(n)));
}

export async function postForm(
  cloud: { url: string },
  path: string,
  form: Record<string, string>,
): Promise<Res> {
  return call(cloud, 'POST', path, {
    raw: new URLSearchParams(form).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
}

/** Run the dev-IdP PKCE flow up to the loopback redirect; returns the code. */
export async function devAuthorize(
  cloud: TestCloud,
  email: string,
  challenge: string,
  name?: string,
): Promise<URL> {
  const page = await call(cloud, 'GET', authorizePath(challenge, { idp: 'dev' }));
  if (page.status !== 200) throw new Error(`authorize page ${page.status}`);
  const res = await postForm(cloud, '/oauth/dev', {
    areq: hiddenAreq(page.text),
    email,
    ...(name ? { name } : {}),
  });
  if (res.status !== 302) throw new Error(`dev login ${res.status}: ${res.text}`);
  return new URL(res.headers.get('location')!);
}

export interface Session {
  access: string;
  refresh: string;
  userId: string;
  email: string;
}

export async function signIn(cloud: TestCloud, email: string, name?: string): Promise<Session> {
  const { verifier, challenge } = pkce();
  const loc = await devAuthorize(cloud, email, challenge, name);
  const tok = await call(cloud, 'POST', '/oauth/token', {
    body: {
      grant_type: 'authorization_code',
      code: loc.searchParams.get('code'),
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: 'desktop',
    },
  });
  if (tok.status !== 200) throw new Error(`token ${tok.status}: ${tok.text}`);
  const me = await call(cloud, 'GET', '/v1/me', { token: tok.json.access_token });
  return { access: tok.json.access_token, refresh: tok.json.refresh_token, userId: me.json.id, email };
}

/** Create an org owned by `owner` and add the others as members (via invites). */
export async function makeOrg(
  cloud: TestCloud,
  owner: Session,
  members: Array<{ s: Session; role?: 'admin' | 'member' | 'owner' }> = [],
  name = 'Acme',
): Promise<any> {
  const org = await call(cloud, 'POST', '/v1/orgs', { token: owner.access, body: { name } });
  if (org.status !== 201) throw new Error(`org ${org.status}: ${org.text}`);
  for (const m of members) {
    const inv = await call(cloud, 'POST', `/v1/orgs/${org.json.id}/invites`, {
      token: owner.access,
      body: { email: m.s.email, role: m.role ?? 'member' },
    });
    const token = String(inv.json.acceptUrl).split('/invite/')[1]!;
    const acc = await call(cloud, 'POST', `/v1/invites/${token}/accept`, { token: m.s.access });
    if (acc.status !== 200) throw new Error(`accept ${acc.status}: ${acc.text}`);
  }
  return org.json;
}

// ---- Cloud Patch blobs via the shared patch-crypto (loaded at runtime; see note) ---------------

export interface SealedPatch {
  bytes: Uint8Array;
  sha256: string;
  key?: string;
}

interface PatchCryptoModule {
  PATCH_FORMAT: 'githappens-patch/1';
  sealPatchBundle(bundle: unknown, opts: { e2e: boolean }): Promise<SealedPatch>;
  openPatchBlob(bytes: Uint8Array, key?: string): Promise<{ patch: string; title: string }>;
}

// patch-crypto.ts uses TS parameter properties, which this package's `erasableSyntaxOnly`
// typecheck rejects; importing it through a non-literal specifier keeps it out of our tsc run
// while vitest still loads the real implementation.
const PATCH_CRYPTO: string = '@githappens/cloud-api/patch-crypto';
export const patchCrypto = (): Promise<PatchCryptoModule> =>
  import(PATCH_CRYPTO) as Promise<PatchCryptoModule>;

export const SAMPLE_FILES: PatchFile[] = [{ path: 'src/app.ts', status: 'M', additions: 1, deletions: 1 }];

export async function sealSample(
  e2e: boolean,
  patchText = 'diff --git a/src/app.ts b/src/app.ts\n-old\n+new\n',
) {
  const pc = await patchCrypto();
  return pc.sealPatchBundle(
    {
      format: pc.PATCH_FORMAT,
      title: 'Fix the thing',
      kind: 'wip',
      baseSha: 'a'.repeat(40),
      createdWith: 'githappens-test',
      patch: patchText,
      files: SAMPLE_FILES,
    },
    { e2e },
  );
}

export function patchBody(sealed: SealedPatch, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'Fix the thing',
    kind: 'wip',
    baseSha: 'a'.repeat(40),
    baseBranch: 'main',
    repo: { provider: 'github', host: 'github.com', owner: 'acme', name: 'app' },
    e2e: false,
    files: SAMPLE_FILES,
    size: sealed.bytes.length,
    sha256: sealed.sha256,
    visibility: 'link',
    ...extra,
  };
}

/** Create + upload + complete. Returns the PatchMeta. */
export async function createPatch(
  cloud: TestCloud,
  s: Session,
  extra: Record<string, unknown> = {},
  e2e = false,
): Promise<{ meta: any; sealed: SealedPatch }> {
  const sealed = await sealSample(e2e);
  const created = await call(cloud, 'POST', '/v1/patches', {
    token: s.access,
    body: patchBody(sealed, { e2e, ...(e2e ? { files: undefined } : {}), ...extra }),
  });
  if (created.status !== 201) throw new Error(`create ${created.status}: ${created.text}`);
  const up = await call(cloud, 'PUT', created.json.uploadUrl, {
    raw: sealed.bytes,
    headers: { 'content-type': 'application/octet-stream' },
  });
  if (up.status !== 200) throw new Error(`upload ${up.status}: ${up.text}`);
  const done = await call(cloud, 'POST', `/v1/patches/${created.json.id}/complete`, { token: s.access });
  if (done.status !== 200) throw new Error(`complete ${done.status}: ${done.text}`);
  return { meta: done.json, sealed };
}
