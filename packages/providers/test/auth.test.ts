import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { authInfo, AUTH_INFO, buildAuthorizeUrl, type AuthInfoFactory } from '../src/auth/info';
import { createPkce, pkceChallenge } from '../src/auth/pkce';
import {
  brokerExchange,
  createRefreshingAuth,
  exchangeCode,
  parseTokenResponse,
  refreshToken,
  type TokenSet,
} from '../src/auth/token';
import { validateToken } from '../src/auth/validate';
import { ProviderError } from '../src/http';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('auth descriptors', () => {
  it('github.com', () => {
    const i = authInfo('github', 'github.com');
    expect(i).toMatchObject({
      host: 'github.com',
      authorizeUrl: 'https://github.com/login/oauth/authorize',
      tokenUrl: 'https://github.com/login/oauth/access_token',
      deviceCodeUrl: 'https://github.com/login/device/code',
      apiBaseUrl: 'https://api.github.com',
      graphqlUrl: 'https://api.github.com/graphql',
      usernameForGit: 'x-access-token',
      oauth: 'broker',
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    });
    expect(i.scopes).toEqual(['repo', 'read:org', 'read:user', 'user:email', 'workflow', 'write:public_key']);
    expect(i.patPageUrl).toBe(
      'https://github.com/settings/tokens/new?scopes=repo,read:org,read:user,user:email,workflow,write:public_key&description=GitHappens',
    );
    expect(i.authorization('abc')).toBe('Bearer abc');
  });

  it('GitHub Enterprise', () => {
    const i = authInfo('github', 'https://GHE.acme.com/');
    expect(i).toMatchObject({
      host: 'ghe.acme.com',
      apiBaseUrl: 'https://ghe.acme.com/api/v3',
      graphqlUrl: 'https://ghe.acme.com/api/graphql',
      tokenUrl: 'https://ghe.acme.com/login/oauth/access_token',
      oauth: 'none',
    });
    expect(i.patPageUrl.startsWith('https://ghe.acme.com/settings/tokens/new?scopes=repo,')).toBe(true);
  });

  it('GitLab.com and self-managed', () => {
    expect(authInfo('gitlab', 'gitlab.com')).toMatchObject({
      authorizeUrl: 'https://gitlab.com/oauth/authorize',
      tokenUrl: 'https://gitlab.com/oauth/token',
      apiBaseUrl: 'https://gitlab.com/api/v4',
      usernameForGit: 'oauth2',
      oauth: 'pkce-public',
      refreshable: true,
      scopes: ['api', 'read_user', 'read_repository', 'write_repository'],
    });
    const sm = authInfo('gitlab', 'git.acme.io');
    expect(sm.oauth).toBe('none');
    expect(sm.patPageUrl).toBe(
      'https://git.acme.io/-/user_settings/personal_access_tokens?name=GitHappens&scopes=api,read_user,write_repository',
    );
  });

  it('accepts an extended lookup table', () => {
    const extra: AuthInfoFactory = (host) => ({
      ...AUTH_INFO.github!(host),
      kind: 'bitbucket',
      usernameForGit: 'x-token-auth',
    });
    expect(authInfo('bitbucket', 'bitbucket.org', { ...AUTH_INFO, bitbucket: extra }).usernameForGit).toBe(
      'x-token-auth',
    );
    expect(() => authInfo('bitbucket', 'bitbucket.org')).toThrow(/No auth descriptor/);
  });
});

describe('PKCE', () => {
  it('matches the RFC 7636 appendix B vector', async () => {
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('creates verifier/challenge pairs', async () => {
    const p = await createPkce();
    expect(p.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.challenge).toBe(await pkceChallenge(p.verifier));
    expect(p.method).toBe('S256');
    expect((await createPkce()).verifier).not.toBe(p.verifier);
  });

  it('builds authorize URLs', () => {
    const u = new URL(
      buildAuthorizeUrl({
        authorizeUrl: 'https://gitlab.com/oauth/authorize',
        clientId: 'cid',
        redirectUri: 'http://127.0.0.1:5000/callback',
        scopes: ['api', 'read_user'],
        state: 'st',
        codeChallenge: 'ch',
      }),
    );
    expect(Object.fromEntries(u.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'cid',
      redirect_uri: 'http://127.0.0.1:5000/callback',
      scope: 'api read_user',
      state: 'st',
      code_challenge: 'ch',
      code_challenge_method: 'S256',
    });
  });
});

describe('token exchange & refresh', () => {
  it('parses token responses incl. expiry and errors', () => {
    expect(
      parseTokenResponse(
        { access_token: 'a', refresh_token: 'r', expires_in: 7200, scope: 'api read_user' },
        1000,
      ),
    ).toEqual({
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: 1000 + 7_200_000,
      scopes: ['api', 'read_user'],
      tokenType: undefined,
    });
    expect(parseTokenResponse('access_token=x&scope=repo%2Cread%3Aorg&token_type=bearer').scopes).toEqual([
      'repo',
      'read:org',
    ]);
    expect(() =>
      parseTokenResponse({
        error: 'bad_verification_code',
        error_description: 'The code passed is incorrect',
      }),
    ).toThrow(/incorrect/);
  });

  it('brokerExchange POSTs JSON to {broker}/token/{kind}', async () => {
    let body: unknown;
    server.use(
      http.post('https://broker.example/token/github', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ access_token: 'gho_x', scope: 'repo,read:org', token_type: 'bearer' });
      }),
    );
    const t = await brokerExchange({
      brokerUrl: 'https://broker.example/',
      kind: 'github',
      code: 'c',
      codeVerifier: 'v',
      redirectUri: 'http://127.0.0.1:1/callback',
    });
    expect(body).toEqual({ code: 'c', code_verifier: 'v', redirect_uri: 'http://127.0.0.1:1/callback' });
    expect(t).toMatchObject({ accessToken: 'gho_x', scopes: ['repo', 'read:org'] });
  });

  it('exchangeCode posts a form with the PKCE verifier', async () => {
    let form: URLSearchParams | undefined;
    server.use(
      http.post('https://gitlab.com/oauth/token', async ({ request }) => {
        form = new URLSearchParams(await request.text());
        return HttpResponse.json({ access_token: 'gl', refresh_token: 'r1', expires_in: 7200 });
      }),
    );
    const t = await exchangeCode({
      tokenUrl: 'https://gitlab.com/oauth/token',
      clientId: 'cid',
      code: 'c',
      codeVerifier: 'v',
      redirectUri: 'http://127.0.0.1:1/callback',
    });
    expect(Object.fromEntries(form!)).toEqual({
      grant_type: 'authorization_code',
      client_id: 'cid',
      code: 'c',
      code_verifier: 'v',
      redirect_uri: 'http://127.0.0.1:1/callback',
    });
    expect(t.refreshToken).toBe('r1');
  });

  it('refreshToken: direct, via broker, invalid_grant → auth_required', async () => {
    server.use(
      http.post('https://gitlab.com/oauth/token', async ({ request }) => {
        const f = new URLSearchParams(await request.text());
        if (f.get('refresh_token') === 'dead')
          return HttpResponse.json({ error: 'invalid_grant' }, { status: 400 });
        expect(f.get('grant_type')).toBe('refresh_token');
        return HttpResponse.json({ access_token: 'new', refresh_token: 'r2', expires_in: 7200 });
      }),
      http.post('https://broker.example/refresh/bitbucket', async ({ request }) => {
        expect(await request.json()).toEqual({ refresh_token: 'r' });
        return HttpResponse.json({ access_token: 'bb', expires_in: 7200 });
      }),
    );
    expect(
      await refreshToken({ tokenUrl: 'https://gitlab.com/oauth/token', clientId: 'cid', refreshToken: 'r1' }),
    ).toMatchObject({
      accessToken: 'new',
      refreshToken: 'r2',
    });
    // Broker response without a new refresh token keeps the old one.
    expect(
      await refreshToken({ brokerUrl: 'https://broker.example', kind: 'bitbucket', refreshToken: 'r' }),
    ).toMatchObject({
      accessToken: 'bb',
      refreshToken: 'r',
    });
    await expect(
      refreshToken({ tokenUrl: 'https://gitlab.com/oauth/token', refreshToken: 'dead' }),
    ).rejects.toMatchObject({
      code: 'auth_required',
    });
  });

  it('createRefreshingAuth refreshes once for concurrent callers', async () => {
    let current: TokenSet = { accessToken: 'old', refreshToken: 'r', expiresAt: 1000 + 60_000, scopes: [] };
    let refreshes = 0;
    const auth = createRefreshingAuth({
      get: () => current,
      refresh: async () => {
        refreshes++;
        await new Promise((r) => setTimeout(r, 20));
        return { accessToken: 'new', refreshToken: 'r2', expiresAt: 1000 + 7_200_000, scopes: [] };
      },
      save: (t) => {
        current = t;
      },
      now: () => 1000,
    });
    const headers = await Promise.all(Array.from({ length: 10 }, () => auth()));
    expect(refreshes).toBe(1);
    expect(new Set(headers)).toEqual(new Set(['Bearer new']));
    expect(await auth()).toBe('Bearer new');
    expect(refreshes).toBe(1);
  });
});

describe('validateToken', () => {
  it('GitHub classic PAT: user + X-OAuth-Scopes + missing scopes', async () => {
    server.use(
      http.get('https://api.github.com/user', ({ request }) => {
        expect(request.headers.get('authorization')).toBe('Bearer ghp_x');
        expect(request.headers.get('x-github-api-version')).toBe('2022-11-28');
        return HttpResponse.json(
          { id: 42, login: 'octo', name: 'Octo Cat', avatar_url: 'https://a/42' },
          { headers: { 'x-oauth-scopes': 'repo, admin:org, user, write:public_key' } },
        );
      }),
    );
    const v = await validateToken('github', 'github.com', 'ghp_x');
    expect(v.user).toEqual({
      id: '42',
      login: 'octo',
      name: 'Octo Cat',
      avatarUrl: 'https://a/42',
      email: undefined,
    });
    expect(v.scopesKnown).toBe(true);
    expect(v.scopes).toEqual(['repo', 'admin:org', 'user', 'write:public_key']);
    expect(v.missingScopes).toEqual(['workflow']);
  });

  it('GitHub fine-grained token: scopes unknown', async () => {
    server.use(http.get('https://ghe.acme.com/api/v3/user', () => HttpResponse.json({ id: 1, login: 'a' })));
    const v = await validateToken('github', 'ghe.acme.com', 'github_pat_x');
    expect(v).toMatchObject({ scopesKnown: false, scopes: [], missingScopes: [] });
  });

  it('401 → auth_required', async () => {
    server.use(
      http.get('https://api.github.com/user', () =>
        HttpResponse.json({ message: 'Bad credentials' }, { status: 401 }),
      ),
    );
    const err = await validateToken('github', 'github.com', 'bad').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).code).toBe('auth_required');
  });

  it('GitLab PAT: /personal_access_tokens/self scopes + version check', async () => {
    server.use(
      http.get('https://git.acme.io/api/v4/user', () =>
        HttpResponse.json({ id: 7, username: 'gl', name: 'G L', avatar_url: 'https://a/7' }),
      ),
      http.get('https://git.acme.io/api/v4/version', () => HttpResponse.json({ version: '16.11.2-ee' })),
      http.get('https://git.acme.io/api/v4/personal_access_tokens/self', () =>
        HttpResponse.json({ scopes: ['read_api', 'read_user'] }),
      ),
    );
    const v = await validateToken('gitlab', 'git.acme.io', 'glpat-x');
    expect(v.user).toMatchObject({ id: '7', login: 'gl' });
    expect(v.serverVersion).toBe('16.11.2-ee');
    expect(v.missingScopes).toEqual(['api', 'write_repository']);
  });

  it('GitLab OAuth token falls back to /oauth/token/info; old servers rejected', async () => {
    server.use(
      http.get('https://gitlab.com/api/v4/user', () => HttpResponse.json({ id: 7, username: 'gl' })),
      http.get('https://gitlab.com/api/v4/version', () => HttpResponse.json({ version: '17.0.0' })),
      http.get('https://gitlab.com/api/v4/personal_access_tokens/self', () =>
        HttpResponse.json({ message: '404 Not Found' }, { status: 404 }),
      ),
      http.get('https://gitlab.com/oauth/token/info', () =>
        HttpResponse.json({ scope: ['api', 'read_user', 'read_repository', 'write_repository'] }),
      ),
      http.get('https://old.acme.io/api/v4/user', () => HttpResponse.json({ id: 1, username: 'x' })),
      http.get('https://old.acme.io/api/v4/version', () => HttpResponse.json({ version: '12.10.0' })),
    );
    const v = await validateToken('gitlab', 'gitlab.com', 'oauth-token');
    expect(v).toMatchObject({ scopesKnown: true, missingScopes: [] });
    await expect(validateToken('gitlab', 'old.acme.io', 't')).rejects.toMatchObject({ code: 'unsupported' });
  });
});
