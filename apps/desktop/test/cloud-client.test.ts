import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CloudClient, normalizeServerUrl } from '../src/main/cloud/cloud-client';
import { CloudError } from '../src/main/cloud/cloud-http';
import type { SecretStore } from '../src/main/secrets/secret-store';

// ---- fakes ----------------------------------------------------------------------------------------

function memorySecrets(): SecretStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    available: true,
    backend: 'memory',
    get: (a) => map.get(a) ?? null,
    set: (a, s) => void map.set(a, s),
    delete: (a) => map.delete(a),
    deleteByPrefix: (p) => {
      let n = 0;
      for (const k of [...map.keys()]) if (k.startsWith(p) && map.delete(k)) n++;
      return n;
    },
    listAccounts: (p = '') => [...map.keys()].filter((k) => k.startsWith(p)),
  };
}

interface FakeServer {
  url: string;
  close(): Promise<void>;
  access: Set<string>;
  refresh: Set<string>;
  revoked: string[];
  refreshCalls: number;
  issued: string[];
  wellKnown: unknown;
}

const ME = {
  id: '11111111-1111-1111-1111-111111111111',
  name: 'Ada',
  email: 'ada@example.com',
  orgs: [
    { id: 'org-1', name: 'Acme', slug: 'acme', role: 'owner' },
    { id: 'org-2', name: 'Beta', slug: 'beta', role: 'member' },
  ],
};

async function startServer(): Promise<FakeServer> {
  const codes = new Map<string, { challenge: string; redirect: string }>();
  const s: FakeServer = {
    url: '',
    close: async () => undefined,
    access: new Set(),
    refresh: new Set(),
    revoked: [],
    refreshCalls: 0,
    issued: [],
    wellKnown: {
      name: 'Test cloud',
      version: '1.0.0',
      idps: ['dev', 'github'],
      limits: { patchMaxBytes: 1, patchMaxExpiryDays: null },
    },
  };
  const issue = (): Record<string, unknown> => {
    const access = `at-${randomBytes(8).toString('hex')}`;
    const refresh = `rt-${randomBytes(8).toString('hex')}`;
    s.access.add(access);
    s.refresh.add(refresh);
    s.issued.push(access, refresh);
    return { access_token: access, token_type: 'Bearer', expires_in: 900, refresh_token: refresh };
  };
  const json = (res: http.ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const body = raw ? (JSON.parse(raw) as Record<string, string>) : {};
      const bearer = req.headers.authorization?.replace(/^Bearer /, '');
      if (url.pathname === '/.well-known/githappens-cloud') return json(res, 200, s.wellKnown);
      if (url.pathname === '/oauth/authorize') {
        const q = url.searchParams;
        if (q.get('client_id') !== 'desktop' || q.get('code_challenge_method') !== 'S256' || !q.get('idp')) {
          return json(res, 400, { error: 'validation', message: 'bad authorize' });
        }
        const code = randomBytes(8).toString('hex');
        codes.set(code, { challenge: q.get('code_challenge')!, redirect: q.get('redirect_uri')! });
        res.writeHead(302, {
          Location: `${q.get('redirect_uri')}?code=${code}&state=${encodeURIComponent(q.get('state')!)}`,
        });
        return res.end();
      }
      if (url.pathname === '/oauth/token' && req.method === 'POST') {
        if (body.grant_type === 'authorization_code') {
          const c = codes.get(body.code!);
          const challenge = createHash('sha256')
            .update(body.code_verifier ?? '')
            .digest('base64url');
          if (!c || c.challenge !== challenge || c.redirect !== body.redirect_uri) {
            return json(res, 400, { error: 'validation', message: 'PKCE mismatch' });
          }
          codes.delete(body.code!);
          return json(res, 200, issue());
        }
        if (body.grant_type === 'refresh_token') {
          s.refreshCalls++;
          if (!s.refresh.delete(body.refresh_token!))
            return json(res, 400, { error: 'unauthorized', message: 'x' });
          return setTimeout(() => json(res, 200, issue()), 30);
        }
      }
      if (url.pathname === '/oauth/revoke') {
        s.revoked.push(body.token!);
        s.refresh.delete(body.token!);
        return json(res, 200, {});
      }
      if (!bearer || !s.access.has(bearer)) return json(res, 401, { error: 'unauthorized', message: 'no' });
      if (url.pathname === '/v1/me' && req.method === 'GET') return json(res, 200, ME);
      if (url.pathname === '/v1/me' && req.method === 'DELETE')
        return json(res, 202, { deleteAfter: '2030-01-01' });
      if (url.pathname === '/v1/conflict')
        return json(res, 412, { error: 'precondition_failed', message: 'v', currentVersion: 3 });
      return json(res, 404, { error: 'not_found', message: 'nope' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  s.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  s.close = () =>
    new Promise((r) => {
      server.closeAllConnections();
      server.close(() => r());
    });
  return s;
}

/** Plays the system browser: follows the authorize redirect to the loopback callback. */
async function fakeBrowser(url: string): Promise<void> {
  const r = await fetch(url, { redirect: 'manual' });
  const loc = r.headers.get('location');
  if (loc) await fetch(loc).then((x) => x.text());
}

let dir: string;
let server: FakeServer;
let serverUrl: string;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-cloud-'));
  server = await startServer();
  serverUrl = server.url;
});
afterEach(async () => {
  await server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeClient(over: Partial<ConstructorParameters<typeof CloudClient>[0]> = {}) {
  const secrets = memorySecrets();
  const opened: string[] = [];
  const client = new CloudClient({
    serverUrl: () => serverUrl,
    profileId: () => 'p1',
    profileDir: () => dir,
    secrets,
    openExternal: (u) => {
      opened.push(u);
      return fakeBrowser(u);
    },
    timeoutMs: 3000,
    ...over,
  });
  return { client, secrets, opened };
}

describe('normalizeServerUrl', () => {
  it('requires https except for loopback hosts', () => {
    expect(normalizeServerUrl('cloud.example.com/')).toEqual({ url: 'https://cloud.example.com' });
    expect(normalizeServerUrl('https://x.dev/kl/')).toEqual({ url: 'https://x.dev/kl' });
    expect(normalizeServerUrl('http://localhost:8080')).toEqual({ url: 'http://localhost:8080' });
    expect(normalizeServerUrl('http://127.0.0.1:1')).toEqual({ url: 'http://127.0.0.1:1' });
    expect(normalizeServerUrl('http://cloud.example.com')).toHaveProperty('error');
    expect(normalizeServerUrl('https://u:p@cloud.example.com')).toHaveProperty('error');
    expect(normalizeServerUrl('ftp://x')).toHaveProperty('error');
    expect(normalizeServerUrl('')).toHaveProperty('error');
  });
});

describe('CloudClient', () => {
  it('makes no network calls when no server is configured', async () => {
    let calls = 0;
    const { client } = makeClient({
      serverUrl: () => '',
      fetch: (() => {
        calls++;
        throw new Error('no');
      }) as typeof fetch,
    });
    client.start();
    expect(client.serverUrl()).toBeNull();
    expect(await client.serverInfo()).toBeNull();
    await expect(client.request('GET', '/v1/me')).rejects.toMatchObject({ code: 'not_configured' });
    expect(client.status()).toMatchObject({ serverUrl: null, session: null });
    expect(calls).toBe(0);
  });

  it('validates a server via the well-known document', async () => {
    const { client } = makeClient();
    const r = await client.validateServer(`${server.url}/`);
    expect(r.url).toBe(server.url);
    expect(r.info.idps).toEqual(['dev', 'github']);
    server.wellKnown = { hello: 'world' };
    await expect(client.validateServer(server.url)).rejects.toMatchObject({ code: 'validation' });
    await expect(client.validateServer('http://example.com')).rejects.toMatchObject({ code: 'validation' });
  });

  it('signs in with PKCE through the browser and never exposes tokens', async () => {
    const { client, secrets, opened } = makeClient();
    const changes: number[] = [];
    client.onSessionChange(() => changes.push(1));
    const session = await client.signIn('dev');
    expect(opened[0]).toContain('/oauth/authorize?');
    expect(opened[0]).toContain('idp=dev');
    expect(opened[0]).toContain('code_challenge_method=S256');
    expect(session).toMatchObject({ serverUrl: server.url, user: { id: ME.id, email: ME.email } });
    expect(session.activeOrgId).toBe('org-1');
    expect(changes.length).toBeGreaterThan(0);

    // Tokens are only in the secret store, under <profile>/cloud/<server>|<user>.
    const accounts = [...secrets.map.keys()];
    expect(accounts).toEqual([`p1/cloud/${server.url}|${ME.id}`]);
    const visible = JSON.stringify([
      session,
      client.status(),
      client.me(),
      fs.readFileSync(path.join(dir, 'cloud.json'), 'utf8'),
    ]);
    for (const t of server.issued) expect(visible).not.toContain(t);

    expect(client.setActiveOrg('org-2').activeOrgId).toBe('org-2');
    // Persisted across restarts.
    const again = makeClient({ secrets } as never);
    again.client.start();
    expect(again.client.activeOrgId()).toBe('org-2');
  });

  it('rejects an idp the server does not offer', async () => {
    const { client } = makeClient();
    await expect(client.signIn('google')).rejects.toMatchObject({ code: 'validation' });
  });

  it('refreshes once (single flight) on 401 and retries', async () => {
    const { client } = makeClient();
    await client.signIn('dev');
    server.access.clear(); // every access token is now rejected
    const results = await Promise.all([
      client.request('GET', '/v1/me'),
      client.request('GET', '/v1/me'),
      client.request('GET', '/v1/me'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(server.refreshCalls).toBe(1);
  });

  it('ends the session when the refresh token is rejected', async () => {
    const { client, secrets } = makeClient();
    await client.signIn('dev');
    server.access.clear();
    server.refresh.clear();
    await expect(client.request('GET', '/v1/me')).rejects.toMatchObject({ code: 'signed_out' });
    expect(client.status()).toMatchObject({ session: null, expired: true });
    expect(secrets.map.size).toBe(0);
  });

  it('maps API errors to CloudError codes', async () => {
    const { client } = makeClient();
    await client.signIn('dev');
    const e = await client.request('GET', '/v1/conflict').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(CloudError);
    expect(e).toMatchObject({ code: 'precondition_failed', status: 412, body: { currentVersion: 3 } });
    await expect(client.request('GET', '/v1/nothing')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('revokes the refresh token on sign-out and clears secrets', async () => {
    const { client, secrets } = makeClient();
    await client.signIn('dev');
    secrets.set(client.sessionSecretAccount('sync-dek')!, 'dek');
    const refresh = [...server.refresh][0]!;
    await client.signOut();
    expect(server.revoked).toEqual([refresh]);
    expect(secrets.map.size).toBe(0);
    expect(client.session()).toBeNull();
    await expect(client.request('GET', '/v1/me')).rejects.toMatchObject({ code: 'signed_out' });
  });

  it('signs out of the old server when cloud.serverUrl changes', async () => {
    const { client, secrets } = makeClient();
    await client.signIn('dev');
    serverUrl = 'https://other.example.com';
    await client.serverUrlChanged();
    expect(server.revoked).toHaveLength(1);
    expect(secrets.map.size).toBe(0);
    expect(client.session()).toBeNull();
  });

  it('reports offline with a network CloudError and keeps the cached session', async () => {
    const { client } = makeClient();
    await client.signIn('dev');
    await server.close();
    const e = await client.request('GET', '/v1/me').catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'network' });
    expect(client.status()).toMatchObject({ offline: true, session: { user: { id: ME.id } } });
  });

  it('deletes the account then signs out', async () => {
    const { client } = makeClient();
    await client.signIn('dev');
    expect(await client.deleteAccount()).toEqual({ deleteAfter: '2030-01-01' });
    expect(client.session()).toBeNull();
  });
});
