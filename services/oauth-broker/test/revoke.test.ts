import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACCESS, fullConfig, jsonResponse, post, SECRETS, startBroker, type TestBroker } from './helpers.ts';

let broker: TestBroker;

beforeEach(async () => {
  broker = await startBroker();
});
afterEach(async () => {
  await broker.close();
});

const form = (body: string): Record<string, string> => Object.fromEntries(new URLSearchParams(body));
const noContent = (): Response => new Response(null, { status: 204 });
const basic = (id: string, secret: string): string =>
  `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;

describe('POST /revoke/:provider — success', () => {
  it('github.com: DELETE /applications/{client_id}/token with Basic client auth', async () => {
    broker.setResponder(noContent);
    const res = await post(broker.url, '/revoke/github', { token: ACCESS });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ revoked: true });
    expect(res.headers.get('cache-control')).toBe('no-store');

    expect(broker.calls).toHaveLength(1);
    const call = broker.calls[0]!;
    expect(call.method).toBe('DELETE');
    expect(call.url).toBe('https://api.github.com/applications/gh-client/token');
    expect(call.headers.authorization).toBe(basic('gh-client', SECRETS.github));
    expect(call.headers.accept).toBe('application/vnd.github+json');
    expect(call.headers['x-github-api-version']).toBe('2022-11-28');
    expect(call.headers['content-type']).toBe('application/json');
    expect(JSON.parse(call.body)).toEqual({ access_token: ACCESS });
  });

  it('GitHub Enterprise Server uses the host API base and its own app', async () => {
    broker.setResponder(noContent);
    const res = await post(broker.url, '/revoke/github', { token: ACCESS, host: 'ghe.example.com' });
    expect(res.status).toBe(200);
    const call = broker.calls[0]!;
    expect(call.url).toBe('https://ghe.example.com/api/v3/applications/ghe-client/token');
    expect(call.headers.authorization).toBe(basic('ghe-client', SECRETS.ghe));
  });

  it('gitlab.com: POST /oauth/revoke form with client credentials', async () => {
    broker.setResponder(() => jsonResponse({}));
    const res = await post(broker.url, '/revoke/gitlab', { token: ACCESS });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ revoked: true });
    const call = broker.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe('https://gitlab.com/oauth/revoke');
    expect(call.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(form(call.body)).toEqual({ token: ACCESS, client_id: 'gl-client', client_secret: SECRETS.gitlab });
  });

  it('self-managed GitLab host', async () => {
    broker.setResponder(() => jsonResponse({}));
    const res = await post(broker.url, '/revoke/gitlab', { token: ACCESS, host: 'gitlab.example.com' });
    expect(res.status).toBe(200);
    expect(broker.calls[0]!.url).toBe('https://gitlab.example.com/oauth/revoke');
    expect(form(broker.calls[0]!.body)).toMatchObject({ client_id: 'glsm-client' });
  });

  it('public GitLab client sends no client_secret', async () => {
    await broker.close();
    broker = await startBroker(fullConfig({ providers: { gitlab: { clientId: 'gl' } } }));
    broker.setResponder(() => jsonResponse({}));
    const res = await post(broker.url, '/revoke/gitlab', { token: ACCESS });
    expect(res.status).toBe(200);
    expect(form(broker.calls[0]!.body)).toEqual({ token: ACCESS, client_id: 'gl' });
  });

  it.each([404, 422])('treats upstream %i (token already invalid) as revoked', async (status) => {
    broker.setResponder(() => jsonResponse({ message: 'Not Found' }, status));
    const res = await post(broker.url, '/revoke/github', { token: ACCESS });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ revoked: true });
  });
});

describe('POST /revoke/:provider — failures', () => {
  it.each([500, 503])('maps upstream %i to 502 upstream_error', async (status) => {
    broker.setResponder(() => new Response('<html>oops</html>', { status }));
    const res = await post(broker.url, '/revoke/github', { token: ACCESS });
    expect(res.status).toBe(502);
    expect(res.json).toEqual({ error: 'upstream_error', error_description: expect.any(String) });
  });

  it('maps network failures to 502 upstream_error', async () => {
    broker.setResponder(() => {
      throw new TypeError('fetch failed');
    });
    const res = await post(broker.url, '/revoke/gitlab', { token: ACCESS });
    expect(res.status).toBe(502);
    expect(res.json.error).toBe('upstream_error');
  });

  it('maps an upstream timeout to 502 upstream_error', async () => {
    broker.setResponder(
      (_call, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason));
        }),
    );
    const res = await post(broker.url, '/revoke/github', { token: ACCESS });
    expect(res.status).toBe(502);
    expect(res.json.error).toBe('upstream_error');
  });

  it('maps upstream 401 to 502 broker_misconfigured', async () => {
    broker.setResponder(() => jsonResponse({ error: 'invalid_client' }, 401));
    const res = await post(broker.url, '/revoke/gitlab', { token: ACCESS });
    expect(res.status).toBe(502);
    expect(res.json.error).toBe('broker_misconfigured');
  });

  it.each(['bitbucket', 'atlassian', 'azure-devops'])(
    '%s has no revocation API → 501 unsupported',
    async (provider) => {
      const res = await post(broker.url, `/revoke/${provider}`, { token: ACCESS });
      expect(res.status).toBe(501);
      expect(res.json).toEqual({ error: 'unsupported', error_description: expect.any(String) });
      expect(broker.calls).toHaveLength(0);
    },
  );

  it('unknown provider → 404 unsupported_provider', async () => {
    const res = await post(broker.url, '/revoke/sourcehut', { token: ACCESS });
    expect(res.status).toBe(404);
    expect(res.json.error).toBe('unsupported_provider');
  });

  it('known but unconfigured provider → 404 unsupported_provider', async () => {
    await broker.close();
    broker = await startBroker(fullConfig({ providers: { gitlab: { clientId: 'gl' } }, gheHosts: {} }));
    const res = await post(broker.url, '/revoke/github', { token: ACCESS });
    expect(res.status).toBe(404);
    expect(res.json.error).toBe('unsupported_provider');
  });

  it('rejects an unconfigured enterprise host', async () => {
    const res = await post(broker.url, '/revoke/github', { token: ACCESS, host: 'other.example.com' });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('unknown_host');
    expect(broker.calls).toHaveLength(0);
  });
});

describe('POST /revoke/:provider — request validation', () => {
  it.each([
    [{}, /token/],
    [{ token: '' }, /token/],
    [{ token: 42 }, /token/],
    [{ token: 'has space' }, /token/],
    [{ token: 'x'.repeat(4097) }, /token/],
    [{ token: ACCESS, extra: 1 }, /extra/],
    [{ token: ACCESS, host: 'evil.com/path' }, /host/],
  ])('rejects %j', async (body, descr) => {
    const res = await post(broker.url, '/revoke/github', body);
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('invalid_request');
    expect(res.json.error_description).toMatch(descr);
    expect(broker.calls).toHaveLength(0);
  });

  it('rejects token-route fields such as scope', async () => {
    const res = await post(broker.url, '/revoke/gitlab', { token: ACCESS, scope: 'x' });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('invalid_request');
  });

  it.each(['not json', '[1,2]', 'null', ''])('rejects body %j', async (raw) => {
    const res = await post(broker.url, '/revoke/github', raw);
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('invalid_request');
  });

  it('rejects non-JSON content types', async () => {
    const res = await post(broker.url, '/revoke/github', `token=${ACCESS}`, {
      'content-type': 'application/x-www-form-urlencoded',
    });
    expect(res.status).toBe(415);
    expect(res.json.error).toBe('unsupported_media_type');
  });

  it('rejects other methods', async () => {
    const get = await fetch(`${broker.url}/revoke/github`);
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
    const del = await fetch(`${broker.url}/revoke/github`, { method: 'DELETE' });
    expect(del.status).toBe(405);
  });

  it('denies browser (Origin) requests', async () => {
    const res = await post(
      broker.url,
      '/revoke/github',
      { token: ACCESS },
      { origin: 'https://evil.example' },
    );
    expect(res.status).toBe(403);
    expect(res.json.error).toBe('cors_denied');
    expect(broker.calls).toHaveLength(0);
  });

  it('is rate limited like the other routes', async () => {
    await broker.close();
    broker = await startBroker(fullConfig({ rateLimit: { capacity: 2, refillPerMinute: 1 } }));
    broker.setResponder(noContent);
    expect((await post(broker.url, '/revoke/github', { token: ACCESS })).status).toBe(200);
    expect((await post(broker.url, '/revoke/github', { token: ACCESS })).status).toBe(200);
    const limited = await post(broker.url, '/revoke/github', { token: ACCESS });
    expect(limited.status).toBe(429);
    expect(limited.json.error).toBe('rate_limited');
    expect(limited.headers.get('retry-after')).toMatch(/^\d+$/);
  });
});

describe('POST /revoke/:provider — logging', () => {
  it('never logs the token, secrets or Basic credentials', async () => {
    broker.setResponder((call) =>
      call.url.includes('gitlab')
        ? jsonResponse({ error: 'server_error', error_description: `bad token ${ACCESS}` }, 500)
        : noContent(),
    );
    await post(broker.url, '/revoke/github', { token: ACCESS });
    await post(broker.url, '/revoke/gitlab', { token: ACCESS });
    await post(broker.url, '/revoke/github', { token: ACCESS, extra: ACCESS });

    const dump = JSON.stringify(broker.logs);
    for (const sensitive of [ACCESS, ...Object.values(SECRETS)]) expect(dump).not.toContain(sensitive);
    expect(dump).not.toContain('Basic ');

    const ok = broker.logs.find((l) => l.route === '/revoke/:provider' && l.provider === 'github')!;
    expect(ok).toMatchObject({
      level: 'info',
      method: 'POST',
      host: 'github.com',
      status: 200,
      upstreamStatus: 204,
    });
    const failed = broker.logs.find(
      (l) => l.route === '/revoke/:provider' && l.provider === 'gitlab' && l.msg === 'request',
    )!;
    expect(failed).toMatchObject({
      level: 'error',
      status: 502,
      upstreamStatus: 500,
      error: 'upstream_error',
    });
  });
});
