import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

/**
 * The real GitHappens Cloud backend (`services/cloud`) as a child process for e2e tests: dev mode
 * (in-memory store, dev IdP), bound to 127.0.0.1 on a free port, keys in a temp data dir. Also the
 * dev-IdP sign-in automation (README "Automating the dev sign-in") and a PKCE token helper so tests can
 * call the HTTP API as a user.
 */

const serviceDir = path.resolve(__dirname, '..', '..', '..', 'services', 'cloud');

export interface CloudServer {
  url: string;
  port: number;
  /** Lines the server printed to stdout (structured JSON logs). */
  logs: string[];
  /** Number of logged API requests so far. */
  requestCount(): number;
  stop(): Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

export async function startCloudServer(dataDir: string): Promise<CloudServer> {
  fs.mkdirSync(dataDir, { recursive: true });
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = {};
  // Inherit only what node needs; no GH_CLOUD_* from the developer's shell.
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GH_CLOUD_')) env[k] = v;
  Object.assign(env, {
    GH_CLOUD_PORT: String(port),
    GH_CLOUD_HOST: '127.0.0.1',
    GH_CLOUD_PUBLIC_URL: url,
    GH_CLOUD_DATA_DIR: dataDir,
    GH_CLOUD_JOB_INTERVAL_SEC: '0',
    GH_CLOUD_RATE_AUTH_PER_MIN: '1000',
  });
  const child: ChildProcess = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', 'src/index.ts', '--dev'],
    { cwd: serviceDir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  const logs: string[] = [];
  let stderr = '';
  let buf = '';
  child.stdout!.setEncoding('utf8').on('data', (c: string) => {
    buf += c;
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    logs.push(...lines.filter(Boolean));
  });
  child.stderr!.setEncoding('utf8').on('data', (c: string) => (stderr += c));
  let exited: number | null = null;
  const exitedP = new Promise<void>((r) =>
    child.once('exit', (code) => {
      exited = code ?? -1;
      r();
    }),
  );

  const deadline = Date.now() + 20_000;
  for (;;) {
    if (exited !== null) throw new Error(`cloud server exited (${exited}):\n${stderr}`);
    try {
      const r = await fetch(`${url}/healthz`);
      if (r.ok) break;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`cloud server did not become healthy:\n${stderr}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  return {
    url,
    port,
    logs,
    requestCount: () => logs.filter((l) => l.includes('"msg":"request"')).length,
    stop: async () => {
      if (exited !== null) return;
      child.kill();
      await Promise.race([exitedP, new Promise((r) => setTimeout(r, 5_000))]);
    },
  };
}

const unescapeHtml = (s: string): string =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/**
 * Dev IdP: GET the authorize URL, read the hidden `areq`, POST `/oauth/dev` without following the
 * redirect. Returns the `Location` (the client's loopback callback with `code` + `state`).
 */
export async function devLogin(authorizeUrl: string, email: string, name: string): Promise<string> {
  const page = await fetch(authorizeUrl);
  const html = await page.text();
  const m = /name="areq" value="([^"]+)"/.exec(html);
  if (!m) throw new Error(`no areq field in the sign-in page (HTTP ${page.status})`);
  const res = await fetch(new URL('/oauth/dev', authorizeUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ areq: unescapeHtml(m[1]!), email, name }).toString(),
    redirect: 'manual',
  });
  const location = res.headers.get('location');
  if (res.status !== 302 || !location) throw new Error(`dev login failed: HTTP ${res.status}`);
  return location;
}

/** Sign in as `email` with our own PKCE client and return an access token for `/v1` calls. */
export async function accessToken(server: string, email: string, name: string): Promise<string> {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const redirectUri = 'http://127.0.0.1:9/callback'; // never contacted: we read the code from Location
  const state = randomBytes(8).toString('hex');
  const authorize = new URL('/oauth/authorize', server);
  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: 'desktop',
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    idp: 'dev',
  }).toString();
  const location = new URL(await devLogin(authorize.href, email, name));
  const code = location.searchParams.get('code');
  if (!code || location.searchParams.get('state') !== state)
    throw new Error(`bad redirect: ${location.href}`);
  const res = await fetch(new URL('/oauth/token', server), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      client_id: 'desktop',
    }),
  });
  const body = (await res.json()) as { access_token?: string };
  if (!res.ok || !body.access_token) throw new Error(`token exchange failed: HTTP ${res.status}`);
  return body.access_token;
}

/** `/v1` call with a bearer token; throws on non-2xx. */
export async function api<T>(
  server: string,
  token: string,
  method: string,
  route: string,
  body?: unknown,
): Promise<{ status: number; data: T; raw: string }> {
  const res = await fetch(new URL(route, server), {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`${method} ${route} → HTTP ${res.status}: ${raw}`);
  return { status: res.status, data: (raw ? JSON.parse(raw) : undefined) as T, raw };
}

/** Footprint HMAC exactly like the desktop (`footprintHash` in main/cloud/team/shaping.ts). */
export function footprintHash(
  salt: string,
  repo: { provider: string; host: string; owner: string; name: string },
  value: string,
): string {
  const key = `${repo.provider}:${repo.host.toLowerCase()}/${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}`;
  return createHmac('sha256', Buffer.from(salt, 'base64url'))
    .update(`${key}:${value}`, 'utf8')
    .digest('base64url');
}
