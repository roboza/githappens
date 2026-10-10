import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { http, HttpResponse, passthrough } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runGitHubDeviceFlow } from '../src/auth/device';
import { runLoopbackOAuth } from '../src/auth/loopback';

/**
 * Extra coverage for the GitHub device flow (msw) and the loopback OAuth server (real 127.0.0.1
 * server; the "browser" is simulated with fetch, which msw passes through for loopback URLs).
 */

const loopback = http.all(/^http:\/\/127\.0\.0\.1:\d+\//, () => passthrough());
const server = setupServer(loopback);
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const deviceCode = (over: Record<string, unknown> = {}) =>
  http.post('https://github.com/login/device/code', () =>
    HttpResponse.json({
      device_code: 'DC',
      user_code: 'U',
      verification_uri: 'https://github.com/login/device',
      verification_uri_complete: 'https://github.com/login/device?user_code=U',
      expires_in: 900,
      interval: 1,
      ...over,
    }),
  );
const tokenReplies = (replies: Array<Record<string, unknown>>) =>
  http.post('https://github.com/login/oauth/access_token', () => HttpResponse.json(replies.shift() ?? {}));
const base = { host: 'github.com', clientId: 'cid', scopes: ['repo'] };

describe('GitHub device flow — error paths', () => {
  it('device_flow_disabled → unsupported; other start failures → auth_required', async () => {
    server.use(
      http.post('https://github.com/login/device/code', () =>
        HttpResponse.json({ error: 'device_flow_disabled', error_description: 'Device flow is disabled.' }),
      ),
    );
    await expect(runGitHubDeviceFlow({ ...base, onUserCode: () => {} })).rejects.toMatchObject({
      code: 'unsupported',
      message: 'Device flow is disabled.',
      serialized: { providerMessage: 'device_flow_disabled' },
    });
    server.use(http.post('https://github.com/login/device/code', () => HttpResponse.json({})));
    await expect(runGitHubDeviceFlow({ ...base, onUserCode: () => {} })).rejects.toMatchObject({
      code: 'auth_required',
      message: 'Device flow could not be started.',
    });
  });

  it('rejects once the local deadline passes', async () => {
    server.use(deviceCode({ expires_in: -1 }), tokenReplies([]));
    await expect(
      runGitHubDeviceFlow({ ...base, onUserCode: () => {}, sleep: async () => {} }),
    ).rejects.toMatchObject({ code: 'auth_required', message: 'The device code expired.' });
  });

  it('unknown token errors use error_description, or the error code', async () => {
    server.use(
      deviceCode(),
      tokenReplies([{ error: 'incorrect_client_credentials', error_description: 'Bad client' }]),
    );
    await expect(
      runGitHubDeviceFlow({ ...base, onUserCode: () => {}, sleep: async () => {} }),
    ).rejects.toMatchObject({
      message: 'Bad client',
      serialized: { providerMessage: 'incorrect_client_credentials' },
    });
    server.use(deviceCode(), tokenReplies([{ error: 'unsupported_grant_type' }]));
    await expect(
      runGitHubDeviceFlow({ ...base, onUserCode: () => {}, sleep: async () => {} }),
    ).rejects.toMatchObject({ message: 'unsupported_grant_type' });
  });

  it('the default sleep waits the interval, then succeeds', async () => {
    server.use(deviceCode(), tokenReplies([{ access_token: 'gho_x', token_type: 'bearer', scope: 'repo' }]));
    let shown: unknown;
    const started = Date.now();
    const t = await runGitHubDeviceFlow({
      ...base,
      onUserCode: (i) => {
        shown = i;
      },
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(t).toMatchObject({ accessToken: 'gho_x' });
    expect(shown).toMatchObject({ verificationUriComplete: 'https://github.com/login/device?user_code=U' });
  });

  it('aborting during the default sleep cancels the flow', async () => {
    server.use(deviceCode(), tokenReplies([]));
    const ac = new AbortController();
    await expect(
      runGitHubDeviceFlow({
        ...base,
        signal: ac.signal,
        onUserCode: () => void setTimeout(() => ac.abort(), 20),
      }),
    ).rejects.toMatchObject({ code: 'auth_required', message: 'Sign-in was cancelled.' });
  });
});

const opts = {
  authorizeUrl: 'https://idp.example/authorize',
  clientId: 'cid',
  scopes: ['openid'],
};
const callbackOf = (url: string) => {
  const u = new URL(url);
  return { redirect: u.searchParams.get('redirect_uri')!, state: u.searchParams.get('state')! };
};

describe('runLoopbackOAuth — edge cases', () => {
  it('404s other paths/methods, 400s a missing code, 409s while handling, escapes HTML', async () => {
    const pages: Array<[number, string]> = [];
    let release!: () => void;
    let browsing: Promise<void> = Promise.resolve();
    const gate = new Promise<void>((r) => (release = r));
    const result = await runLoopbackOAuth({
      ...opts,
      callbackPath: '/cb',
      appName: '<App & "Co">',
      extraParams: { prompt: 'consent' },
      scopeSeparator: ',',
      openBrowser: (url) => {
        const { redirect, state } = callbackOf(url);
        const origin = new URL(redirect).origin;
        const hit = async (u: string, init?: RequestInit) => {
          const r = await fetch(u, init);
          pages.push([r.status, await r.text()]);
        };
        browsing = (async () => {
          await hit(`${origin}/other`);
          await hit(`${redirect}?state=${state}`, { method: 'POST' });
          await hit(`${redirect}?state=${encodeURIComponent(state)}`);
          const first = fetch(`${redirect}?code=c1&state=${encodeURIComponent(state)}`);
          // Wait until the exchange has started, then a duplicate callback must get 409.
          await new Promise((r) => setTimeout(r, 50));
          await hit(`${redirect}?code=c2&state=${encodeURIComponent(state)}`);
          release();
          const r = await first;
          pages.push([r.status, await r.text()]);
        })();
      },
      tokenExchange: async (code, _v, redirectUri) => {
        expect(redirectUri).toMatch(/\/cb$/);
        await gate;
        return { accessToken: code, scopes: [] };
      },
      onAuthorizeUrl: (u) => {
        const p = new URL(u).searchParams;
        expect(p.get('prompt')).toBe('consent');
      },
    });
    await browsing;
    expect(result.accessToken).toBe('c1');
    expect(pages.map(([s]) => s)).toEqual([404, 404, 400, 409, 200]);
    expect(pages[2]![1]).toContain('No authorization code was returned.');
    expect(pages[3]![1]).toContain('Return to &lt;App &amp; &quot;Co&quot;&gt;.');
  });

  it('non-access_denied provider errors use the description; quotes are escaped', async () => {
    let page = '';
    await expect(
      runLoopbackOAuth({
        ...opts,
        openBrowser: (url) => {
          const { redirect, state } = callbackOf(url);
          void fetch(
            `${redirect}?error=invalid_scope&error_description=${encodeURIComponent("Scope 'x' <bad>")}&state=${encodeURIComponent(state)}`,
          ).then(async (r) => {
            page = await r.text();
          });
        },
        tokenExchange: async () => ({ accessToken: 'never', scopes: [] }),
      }),
    ).rejects.toMatchObject({
      code: 'auth_required',
      message: "Scope 'x' <bad>",
      serialized: { providerMessage: 'invalid_scope' },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(page).toContain('Scope &#39;x&#39; &lt;bad&gt;');
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      runLoopbackOAuth({
        ...opts,
        signal: ac.signal,
        openBrowser: () => {
          throw new Error('should not open');
        },
        tokenExchange: async () => ({ accessToken: 'never', scopes: [] }),
      }),
    ).rejects.toMatchObject({ message: 'Sign-in was cancelled.' });
  });

  it('propagates synchronous and asynchronous openBrowser failures', async () => {
    await expect(
      runLoopbackOAuth({
        ...opts,
        openBrowser: () => {
          throw new Error('no browser');
        },
        tokenExchange: async () => ({ accessToken: 'never', scopes: [] }),
      }),
    ).rejects.toThrow('no browser');
    await expect(
      runLoopbackOAuth({
        ...opts,
        openBrowser: async () => {
          throw new Error('xdg-open failed');
        },
        tokenExchange: async () => ({ accessToken: 'never', scopes: [] }),
      }),
    ).rejects.toThrow('xdg-open failed');
    await expect(
      runLoopbackOAuth({
        ...opts,
        onAuthorizeUrl: () => {
          throw new Error('clipboard');
        },
        openBrowser: () => {},
        tokenExchange: async () => ({ accessToken: 'never', scopes: [] }),
      }),
    ).rejects.toThrow('clipboard');
  });

  it('ignores a late openBrowser failure after sign-in completed', async () => {
    const t = await runLoopbackOAuth({
      ...opts,
      openBrowser: async (url) => {
        const { redirect, state } = callbackOf(url);
        await fetch(`${redirect}?code=ok&state=${encodeURIComponent(state)}`).then((r) => r.text());
        throw new Error('late');
      },
      tokenExchange: async (code) => ({ accessToken: code, scopes: [] }),
    });
    expect(t.accessToken).toBe('ok');
  });

  it('maps a port conflict to a network error', async () => {
    const busy: Server = createServer(() => {});
    await new Promise<void>((r) => busy.listen(0, '127.0.0.1', () => r()));
    const { port } = busy.address() as AddressInfo;
    try {
      await expect(
        runLoopbackOAuth({
          ...opts,
          port,
          openBrowser: () => {},
          tokenExchange: async () => ({ accessToken: 'never', scopes: [] }),
        }),
      ).rejects.toMatchObject({ code: 'network', message: expect.stringContaining('Loopback server error') });
    } finally {
      await new Promise((r) => busy.close(r));
    }
  });
});
