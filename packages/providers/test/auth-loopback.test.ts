/**
 * Loopback OAuth flow against a real 127.0.0.1 server. No msw here: the "browser" is simulated
 * by GETting the redirect URL with the real global fetch.
 */
import { describe, expect, it } from 'vitest';
import { runLoopbackOAuth } from '../src/auth/loopback';
import { pkceChallenge } from '../src/auth/pkce';

describe('runLoopbackOAuth', () => {
  it('validates state, exchanges the code with the PKCE verifier and shows a close-tab page', async () => {
    const pages: Array<{ status: number; text: string }> = [];
    let authUrl: URL | undefined;
    let exchanged: { code: string; verifier: string; redirectUri: string } | undefined;
    let copied = '';

    const result = await runLoopbackOAuth({
      authorizeUrl: 'https://gitlab.com/oauth/authorize',
      clientId: 'cid',
      scopes: ['api', 'read_user'],
      onAuthorizeUrl: (u) => {
        copied = u;
      },
      openBrowser: (url) => {
        authUrl = new URL(url);
        const redirect = authUrl.searchParams.get('redirect_uri')!;
        const state = authUrl.searchParams.get('state')!;
        void (async () => {
          for (const u of [
            `${redirect}?code=bad&state=wrong`,
            `${redirect}?code=c0de&state=${encodeURIComponent(state)}`,
          ]) {
            const r = await fetch(u);
            pages.push({ status: r.status, text: await r.text() });
          }
        })();
      },
      tokenExchange: async (code, verifier, redirectUri) => {
        exchanged = { code, verifier, redirectUri };
        return { accessToken: 'tok', scopes: ['api'] };
      },
    });

    expect(result).toEqual({ accessToken: 'tok', scopes: ['api'] });
    expect(copied).toBe(authUrl!.toString());
    const p = authUrl!.searchParams;
    expect(p.get('response_type')).toBe('code');
    expect(p.get('client_id')).toBe('cid');
    expect(p.get('scope')).toBe('api read_user');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(p.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(exchanged!.code).toBe('c0de');
    expect(exchanged!.redirectUri).toBe(p.get('redirect_uri'));
    expect(await pkceChallenge(exchanged!.verifier)).toBe(p.get('code_challenge'));

    // wait for the browser simulation to read the success page
    for (let i = 0; i < 50 && pages.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    expect(pages[0]!.status).toBe(400);
    expect(pages[1]!.status).toBe(200);
    expect(pages[1]!.text).toContain('You can close this tab and return to GitHappens');

    // server is closed afterwards
    await expect(fetch(p.get('redirect_uri')!)).rejects.toThrow();
  });

  it('rejects when the provider returns an error (access_denied)', async () => {
    await expect(
      runLoopbackOAuth({
        authorizeUrl: 'https://github.com/login/oauth/authorize',
        clientId: 'cid',
        scopes: ['repo'],
        openBrowser: (url) => {
          const u = new URL(url);
          void fetch(
            `${u.searchParams.get('redirect_uri')}?error=access_denied&state=${u.searchParams.get('state')}`,
          ).catch(() => {});
        },
        tokenExchange: async () => {
          throw new Error('should not be called');
        },
      }),
    ).rejects.toMatchObject({ code: 'auth_required', message: 'Authorization was denied in the browser.' });
  });

  it('propagates token exchange failures', async () => {
    await expect(
      runLoopbackOAuth({
        authorizeUrl: 'https://github.com/login/oauth/authorize',
        clientId: 'cid',
        scopes: [],
        openBrowser: (url) => {
          const u = new URL(url);
          void fetch(
            `${u.searchParams.get('redirect_uri')}?code=x&state=${u.searchParams.get('state')}`,
          ).catch(() => {});
        },
        tokenExchange: async () => {
          throw new Error('broker down');
        },
      }),
    ).rejects.toThrow('broker down');
  });

  it('cancels via AbortSignal and times out', async () => {
    const ac = new AbortController();
    await expect(
      runLoopbackOAuth({
        authorizeUrl: 'https://x/authorize',
        clientId: 'c',
        scopes: [],
        signal: ac.signal,
        openBrowser: () => void setTimeout(() => ac.abort(), 10),
        tokenExchange: async () => ({ accessToken: 'never', scopes: [] }),
      }),
    ).rejects.toMatchObject({ message: 'Sign-in was cancelled.' });

    await expect(
      runLoopbackOAuth({
        authorizeUrl: 'https://x/authorize',
        clientId: 'c',
        scopes: [],
        timeoutMs: 30,
        openBrowser: () => {},
        tokenExchange: async () => ({ accessToken: 'never', scopes: [] }),
      }),
    ).rejects.toMatchObject({ message: 'Timed out waiting for the browser sign-in.' });
  });
});
