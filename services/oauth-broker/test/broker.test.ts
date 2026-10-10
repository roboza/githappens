import { request } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AZURE_DEVOPS_DEFAULT_SCOPE } from '../src/providers.ts';
import {
  ACCESS,
  CODE,
  fullConfig,
  jsonResponse,
  post,
  REDIRECT,
  REFRESH,
  SECRETS,
  startBroker,
  type TestBroker,
  VERIFIER,
} from './helpers.ts';

let broker: TestBroker;

beforeEach(async () => {
  broker = await startBroker();
});
afterEach(async () => {
  await broker.close();
});

const form = (body: string): Record<string, string> => Object.fromEntries(new URLSearchParams(body));

describe('GET /healthz', () => {
  it('reports ok and the enabled providers', async () => {
    const res = await fetch(`${broker.url}/healthz`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({
      status: 'ok',
      providers: ['github', 'gitlab', 'bitbucket', 'atlassian', 'azure-devops'],
    });
  });

  it('rejects other methods', async () => {
    const res = await fetch(`${broker.url}/healthz`, { method: 'DELETE' });
    expect(res.status).toBe(405);
  });
});

describe('POST /token/:provider — successful exchange', () => {
  it('github.com: form body with client secret, PKCE verifier, normalized comma scopes', async () => {
    broker.setResponder(() =>
      jsonResponse({ access_token: ACCESS, token_type: 'bearer', scope: 'repo,read:org,workflow' }),
    );
    const res = await post(broker.url, '/token/github', {
      code: CODE,
      code_verifier: VERIFIER,
      redirect_uri: REDIRECT,
    });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ access_token: ACCESS, token_type: 'bearer', scope: 'repo read:org workflow' });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();

    const call = broker.calls[0]!;
    expect(call.url).toBe('https://github.com/login/oauth/access_token');
    expect(call.headers.accept).toBe('application/json');
    expect(form(call.body)).toEqual({
      grant_type: 'authorization_code',
      code: CODE,
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
      client_id: 'gh-client',
      client_secret: SECRETS.github,
    });
  });

  it('GitHub Enterprise Server host from the host map', async () => {
    const res = await post(broker.url, '/token/github', {
      code: CODE,
      redirect_uri: REDIRECT,
      host: 'GHE.example.com',
    });
    expect(res.status).toBe(200);
    const call = broker.calls[0]!;
    expect(call.url).toBe('https://ghe.example.com/login/oauth/access_token');
    expect(form(call.body)).toMatchObject({ client_id: 'ghe-client', client_secret: SECRETS.ghe });
  });

  it('gitlab.com and self-managed GitLab', async () => {
    let res = await post(broker.url, '/token/gitlab', {
      code: CODE,
      code_verifier: VERIFIER,
      redirect_uri: REDIRECT,
    });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      access_token: ACCESS,
      token_type: 'bearer',
      refresh_token: REFRESH,
      expires_in: 7200,
      scope: 'api read_user',
    });
    expect(broker.calls[0]!.url).toBe('https://gitlab.com/oauth/token');
    expect(form(broker.calls[0]!.body)).toMatchObject({ client_id: 'gl-client', code_verifier: VERIFIER });

    res = await post(broker.url, '/token/gitlab', {
      code: CODE,
      redirect_uri: REDIRECT,
      host: 'gitlab.example.com',
    });
    expect(res.status).toBe(200);
    expect(broker.calls[1]!.url).toBe('https://gitlab.example.com/oauth/token');
    expect(form(broker.calls[1]!.body)).toMatchObject({
      client_id: 'glsm-client',
      client_secret: SECRETS.gitlabSm,
    });
  });

  it('bitbucket: HTTP Basic client auth, githappens:// redirect, no verifier forwarded', async () => {
    const res = await post(broker.url, '/token/bitbucket', {
      code: CODE,
      code_verifier: VERIFIER,
      redirect_uri: 'githappens://oauth/callback',
    });
    expect(res.status).toBe(200);
    const call = broker.calls[0]!;
    expect(call.url).toBe('https://bitbucket.org/site/oauth2/access_token');
    expect(call.headers.authorization).toBe(
      `Basic ${Buffer.from(`bb-client:${SECRETS.bitbucket}`).toString('base64')}`,
    );
    expect(form(call.body)).toEqual({
      grant_type: 'authorization_code',
      code: CODE,
      redirect_uri: 'githappens://oauth/callback',
    });
  });

  it('atlassian (Jira Cloud 3LO): JSON body', async () => {
    const res = await post(broker.url, '/token/atlassian', { code: CODE, redirect_uri: REDIRECT });
    expect(res.status).toBe(200);
    const call = broker.calls[0]!;
    expect(call.url).toBe('https://auth.atlassian.com/oauth/token');
    expect(call.headers['content-type']).toBe('application/json');
    expect(JSON.parse(call.body)).toEqual({
      grant_type: 'authorization_code',
      code: CODE,
      redirect_uri: REDIRECT,
      client_id: 'atl-client',
      client_secret: SECRETS.atlassian,
    });
  });

  it('azure-devops: Entra v2 organizations endpoint with the Azure DevOps scope', async () => {
    const res = await post(broker.url, '/token/azure-devops', {
      code: CODE,
      code_verifier: VERIFIER,
      redirect_uri: REDIRECT,
    });
    expect(res.status).toBe(200);
    const call = broker.calls[0]!;
    expect(call.url).toBe('https://login.microsoftonline.com/organizations/oauth2/v2.0/token');
    expect(form(call.body)).toMatchObject({
      client_id: 'az-client',
      scope: AZURE_DEVOPS_DEFAULT_SCOPE,
      code_verifier: VERIFIER,
    });
  });

  it('accepts a form-encoded upstream response (legacy GitHub)', async () => {
    broker.setResponder(
      () =>
        new Response(`access_token=${ACCESS}&token_type=bearer&scope=repo`, {
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
        }),
    );
    const res = await post(broker.url, '/token/github', { code: CODE, redirect_uri: REDIRECT });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ access_token: ACCESS, token_type: 'bearer', scope: 'repo' });
  });
});

describe('POST /refresh/:provider', () => {
  it('refreshes via the refresh_token grant', async () => {
    const res = await post(broker.url, '/refresh/gitlab', { refresh_token: REFRESH });
    expect(res.status).toBe(200);
    expect(res.json.access_token).toBe(ACCESS);
    expect(form(broker.calls[0]!.body)).toEqual({
      grant_type: 'refresh_token',
      refresh_token: REFRESH,
      client_id: 'gl-client',
      client_secret: SECRETS.gitlab,
    });
  });

  it('atlassian refresh uses JSON', async () => {
    const res = await post(broker.url, '/refresh/atlassian', { refresh_token: REFRESH });
    expect(res.status).toBe(200);
    expect(JSON.parse(broker.calls[0]!.body)).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: REFRESH,
    });
  });

  it('rejects code fields on refresh', async () => {
    const res = await post(broker.url, '/refresh/github', { refresh_token: REFRESH, code: CODE });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('invalid_request');
    expect(broker.calls).toHaveLength(0);
  });
});

describe('input validation', () => {
  it.each([
    [{ redirect_uri: REDIRECT }, /code/],
    [{ code: CODE }, /redirect_uri/],
    [{ code: 42, redirect_uri: REDIRECT }, /code/],
    [{ code: 'has space', redirect_uri: REDIRECT }, /code/],
    [{ code: CODE, redirect_uri: REDIRECT, code_verifier: 'short' }, /code_verifier/],
    [{ code: CODE, redirect_uri: REDIRECT, extra: 1 }, /extra/],
    [{ code: CODE, redirect_uri: REDIRECT, scope: 'x' }, /scope/],
    [{ code: CODE, redirect_uri: REDIRECT, host: 'evil.com/path' }, /host/],
  ])('rejects %j', async (body, descr) => {
    const res = await post(broker.url, '/token/github', body);
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('invalid_request');
    expect(res.json.error_description).toMatch(descr);
    expect(broker.calls).toHaveLength(0);
  });

  it('rejects host on single-host providers', async () => {
    const res = await post(broker.url, '/token/bitbucket', {
      code: CODE,
      redirect_uri: REDIRECT,
      host: 'x.org',
    });
    expect(res.status).toBe(400);
  });

  it('rejects an unconfigured enterprise host', async () => {
    const res = await post(broker.url, '/token/github', {
      code: CODE,
      redirect_uri: REDIRECT,
      host: 'other.example.com',
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('unknown_host');
    expect(broker.calls).toHaveLength(0);
  });

  it.each(['not json', '[1,2]', 'null', ''])('rejects body %j', async (raw) => {
    const res = await post(broker.url, '/token/github', raw);
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('invalid_request');
  });

  it('rejects non-JSON content types', async () => {
    const res = await post(broker.url, '/token/github', 'code=x', {
      'content-type': 'application/x-www-form-urlencoded',
    });
    expect(res.status).toBe(415);
    expect(res.json.error).toBe('unsupported_media_type');
  });

  it('rejects GET on token endpoints', async () => {
    const res = await fetch(`${broker.url}/token/github`);
    expect(res.status).toBe(405);
  });

  it('404s unknown paths', async () => {
    const res = await post(broker.url, '/oauth/github/token', {});
    expect(res.status).toBe(404);
    expect(res.json).toEqual({ error: 'not_found', error_description: expect.any(String) });
  });
});

describe('redirect_uri allow-list', () => {
  it.each([
    'https://evil.example.com/callback',
    'http://localhost:3000/callback',
    'http://127.0.0.1/callback',
    'http://127.0.0.1:0/callback',
    'http://127.0.0.1:99999/callback',
    'http://127.0.0.1.evil.com:80/callback',
    'http://user:pw@127.0.0.1:8080/callback',
    'http://127.0.0.1:8080/callback#frag',
    'http://[::1]:8080/callback',
    'javascript:alert(1)',
    'githappens:oauth',
    'otherapp://oauth/callback',
  ])('rejects %s', async (redirect_uri) => {
    const res = await post(broker.url, '/token/github', { code: CODE, redirect_uri });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('invalid_redirect_uri');
    expect(broker.calls).toHaveLength(0);
  });

  it.each(['http://127.0.0.1:1/', 'http://127.0.0.1:65535/cb?x=1', 'githappens://oauth/callback'])(
    'allows %s',
    async (redirect_uri) => {
      const res = await post(broker.url, '/token/github', { code: CODE, redirect_uri });
      expect(res.status).toBe(200);
    },
  );
});

describe('providers', () => {
  it('unknown provider → 404 unsupported_provider', async () => {
    const res = await post(broker.url, '/token/sourcehut', { code: CODE, redirect_uri: REDIRECT });
    expect(res.status).toBe(404);
    expect(res.json.error).toBe('unsupported_provider');
  });

  it('known but unconfigured provider → 404 unsupported_provider', async () => {
    await broker.close();
    broker = await startBroker(fullConfig({ providers: { gitlab: { clientId: 'gl' } }, gheHosts: {} }));
    const res = await post(broker.url, '/token/bitbucket', { code: CODE, redirect_uri: REDIRECT });
    expect(res.status).toBe(404);
    expect(res.json.error).toBe('unsupported_provider');
    const health = (await (await fetch(`${broker.url}/healthz`)).json()) as { providers: string[] };
    expect(health.providers).toEqual(['gitlab']);
  });

  it('public GitLab client sends no client_secret', async () => {
    await broker.close();
    broker = await startBroker(fullConfig({ providers: { gitlab: { clientId: 'gl' } } }));
    await post(broker.url, '/token/gitlab', { code: CODE, redirect_uri: REDIRECT, code_verifier: VERIFIER });
    expect(form(broker.calls[0]!.body)).not.toHaveProperty('client_secret');
  });
});

describe('upstream errors', () => {
  it('passes through a GitHub 200+error as 400 without leaking secrets', async () => {
    broker.setResponder(() =>
      jsonResponse({
        error: 'bad_verification_code',
        error_description: `The code ${CODE} passed is incorrect (secret ${SECRETS.github})`,
      }),
    );
    const res = await post(broker.url, '/token/github', { code: CODE, redirect_uri: REDIRECT });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('bad_verification_code');
    const text = JSON.stringify(res.json);
    expect(text).not.toContain(CODE);
    expect(text).not.toContain(SECRETS.github);
    expect(res.json.error_description).toContain('[redacted]');
  });

  it('passes through a 400 invalid_grant from GitLab', async () => {
    broker.setResponder(() =>
      jsonResponse(
        { error: 'invalid_grant', error_description: 'The provided authorization grant is invalid' },
        400,
      ),
    );
    const res = await post(broker.url, '/refresh/gitlab', { refresh_token: REFRESH });
    expect(res.status).toBe(400);
    expect(res.json).toEqual({
      error: 'invalid_grant',
      error_description: 'The provided authorization grant is invalid',
    });
  });

  it('maps invalid_client to 502 broker_misconfigured', async () => {
    broker.setResponder(() =>
      jsonResponse({ error: 'invalid_client', error_description: 'bad secret' }, 401),
    );
    const res = await post(broker.url, '/token/bitbucket', { code: CODE, redirect_uri: REDIRECT });
    expect(res.status).toBe(502);
    expect(res.json.error).toBe('broker_misconfigured');
  });

  it('maps upstream 5xx / non-JSON to 502 upstream_error', async () => {
    broker.setResponder(() => new Response('<html>oops</html>', { status: 503 }));
    const res = await post(broker.url, '/token/atlassian', { code: CODE, redirect_uri: REDIRECT });
    expect(res.status).toBe(502);
    expect(res.json.error).toBe('upstream_error');
  });

  it('maps a 200 without access_token to 502', async () => {
    broker.setResponder(() => jsonResponse({ token_type: 'bearer' }));
    const res = await post(broker.url, '/token/github', { code: CODE, redirect_uri: REDIRECT });
    expect(res.status).toBe(502);
    expect(res.json.error).toBe('upstream_invalid_response');
  });

  it('does not follow upstream redirects', async () => {
    broker.setResponder(
      () => new Response(null, { status: 302, headers: { location: 'https://evil.example' } }),
    );
    const res = await post(broker.url, '/token/github', { code: CODE, redirect_uri: REDIRECT });
    expect(res.status).toBe(502);
  });

  it('times out slow upstreams with 504', async () => {
    broker.setResponder(
      (_call, signal) =>
        new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason));
        }),
    );
    const res = await post(broker.url, '/token/github', { code: CODE, redirect_uri: REDIRECT });
    expect(res.status).toBe(504);
    expect(res.json.error).toBe('upstream_timeout');
  });

  it('maps network failures to 502 upstream_unreachable', async () => {
    broker.setResponder(() => {
      throw new TypeError('fetch failed');
    });
    const res = await post(broker.url, '/token/github', { code: CODE, redirect_uri: REDIRECT });
    expect(res.status).toBe(502);
    expect(res.json.error).toBe('upstream_unreachable');
  });
});

describe('CORS', () => {
  it('denies browser requests carrying an Origin header', async () => {
    const res = await post(
      broker.url,
      '/token/github',
      { code: CODE, redirect_uri: REDIRECT },
      { origin: 'https://evil.example' },
    );
    expect(res.status).toBe(403);
    expect(res.json.error).toBe('cors_denied');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(broker.calls).toHaveLength(0);
  });

  it('denies preflight', async () => {
    const res = await fetch(`${broker.url}/token/github`, {
      method: 'OPTIONS',
      headers: { 'access-control-request-method': 'POST' },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('rate limiting', () => {
  it('limits per IP with a token bucket and refills over time', async () => {
    await broker.close();
    broker = await startBroker(fullConfig({ rateLimit: { capacity: 3, refillPerMinute: 60 } }));
    const body = { code: CODE, redirect_uri: REDIRECT };
    for (let i = 0; i < 3; i++) expect((await post(broker.url, '/token/github', body)).status).toBe(200);
    const limited = await post(broker.url, '/token/github', body);
    expect(limited.status).toBe(429);
    expect(limited.json.error).toBe('rate_limited');
    expect(limited.headers.get('retry-after')).toBe('1');
    expect(broker.calls).toHaveLength(3);

    broker.clock.now += 1_000; // 60/min → one token per second
    expect((await post(broker.url, '/token/github', body)).status).toBe(200);
    expect((await post(broker.url, '/token/github', body)).status).toBe(429);
  });

  it('keys on X-Forwarded-For (rightmost) only when trustProxy is set', async () => {
    await broker.close();
    broker = await startBroker(
      fullConfig({ rateLimit: { capacity: 1, refillPerMinute: 1 }, trustProxy: true }),
    );
    const body = { code: CODE, redirect_uri: REDIRECT };
    expect(
      (await post(broker.url, '/token/github', body, { 'x-forwarded-for': '1.1.1.1, 10.0.0.1' })).status,
    ).toBe(200);
    // Spoofed leftmost entry does not buy a new bucket.
    expect(
      (await post(broker.url, '/token/github', body, { 'x-forwarded-for': '9.9.9.9, 10.0.0.1' })).status,
    ).toBe(429);
    expect((await post(broker.url, '/token/github', body, { 'x-forwarded-for': '10.0.0.2' })).status).toBe(
      200,
    );
  });

  it('does not rate-limit /healthz', async () => {
    await broker.close();
    broker = await startBroker(fullConfig({ rateLimit: { capacity: 1, refillPerMinute: 1 } }));
    for (let i = 0; i < 5; i++) expect((await fetch(`${broker.url}/healthz`)).status).toBe(200);
  });
});

describe('body size limit', () => {
  it('rejects a declared Content-Length over 8 KB', async () => {
    const res = await post(broker.url, '/token/github', {
      code: CODE,
      redirect_uri: REDIRECT,
      pad: 'x'.repeat(9000),
    });
    expect(res.status).toBe(413);
    expect(res.json.error).toBe('payload_too_large');
    expect(broker.calls).toHaveLength(0);
  });

  it('rejects an oversized chunked body', async () => {
    const { port } = broker.server.address() as { port: number };
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/token/github',
          headers: { 'content-type': 'application/json' },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.write(`{"code":"${'x'.repeat(5000)}",`);
      req.end(`"redirect_uri":"${'y'.repeat(5000)}"}`);
    });
    expect(status).toBe(413);
    expect(broker.calls).toHaveLength(0);
  });

  it('accepts a body just under the limit (then fails validation, not size)', async () => {
    const res = await post(broker.url, '/token/github', { code: 'x'.repeat(7000), redirect_uri: REDIRECT });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('invalid_request');
  });
});

describe('logging', () => {
  it('logs one structured line per request and never codes, tokens, verifiers or secrets', async () => {
    broker.setResponder((call) =>
      call.body.includes('refresh_token')
        ? jsonResponse({ error: 'invalid_grant', error_description: `token ${REFRESH} revoked` }, 400)
        : jsonResponse({
            access_token: ACCESS,
            refresh_token: REFRESH,
            token_type: 'bearer',
            expires_in: 60,
          }),
    );
    await post(broker.url, '/token/gitlab', { code: CODE, code_verifier: VERIFIER, redirect_uri: REDIRECT });
    await post(broker.url, '/refresh/gitlab', { refresh_token: REFRESH });
    await post(broker.url, '/token/github', { code: CODE, redirect_uri: 'https://evil.example/' });
    await post(broker.url, '/token/bitbucket', { code: CODE, redirect_uri: REDIRECT });

    expect(broker.logs.length).toBeGreaterThanOrEqual(4);
    const dump = JSON.stringify(broker.logs);
    for (const sensitive of [CODE, VERIFIER, REFRESH, ACCESS, ...Object.values(SECRETS)]) {
      expect(dump).not.toContain(sensitive);
    }
    expect(dump).not.toContain('Basic ');

    const first = broker.logs.find((l) => l.route === '/token/:provider' && l.provider === 'gitlab')!;
    expect(first).toMatchObject({
      level: 'info',
      msg: 'request',
      method: 'POST',
      provider: 'gitlab',
      grant: 'authorization_code',
      status: 200,
      upstreamStatus: 200,
    });
    expect(typeof first.ts).toBe('string');
    expect(typeof first.durationMs).toBe('number');
    const refresh = broker.logs.find((l) => l.route === '/refresh/:provider')!;
    expect(refresh).toMatchObject({ level: 'warn', status: 400, upstreamError: 'invalid_grant' });
  });

  it('redacts unexpected log fields', async () => {
    const { createLogger } = await import('../src/logger.ts');
    const entries: unknown[] = [];
    const logger = createLogger((e) => entries.push(e));
    logger.info({ msg: 'x', access_token: ACCESS } as never);
    expect(JSON.stringify(entries)).not.toContain(ACCESS);
  });
});
