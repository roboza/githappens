import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  authorizePath,
  call,
  devAuthorize,
  hiddenAreq,
  pkce,
  postForm,
  REDIRECT,
  signIn,
  startCloud,
  type TestCloud,
} from './helpers.ts';

let cloud: TestCloud;
beforeEach(async () => {
  cloud = await startCloud();
});
afterEach(async () => {
  await cloud.close();
});

async function exchange(code: string, verifier: string, redirectUri = REDIRECT) {
  return call(cloud, 'POST', '/oauth/token', {
    body: {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      client_id: 'desktop',
    },
  });
}

describe('discovery', () => {
  it('serves /healthz and /.well-known/githappens-cloud', async () => {
    expect((await call(cloud, 'GET', '/healthz')).json).toEqual({ status: 'ok' });
    const info = await call(cloud, 'GET', '/.well-known/githappens-cloud');
    expect(info.status).toBe(200);
    expect(info.json).toMatchObject({
      name: 'GitHappens Cloud',
      idps: ['email', 'dev'],
      limits: { patchMaxBytes: 25 * 1024 * 1024, patchMaxExpiryDays: null },
    });
    expect(info.headers.get('access-control-allow-origin')).toBeNull();
    expect(info.headers.get('cache-control')).toBe('no-store');
  });

  it('returns ApiError JSON for unknown routes and wrong methods', async () => {
    const r = await call(cloud, 'GET', '/v1/nope');
    expect(r.status).toBe(404);
    expect(r.json).toMatchObject({ error: 'not_found' });
    const m = await call(cloud, 'DELETE', '/healthz');
    expect(m.status).toBe(405);
    const pre = await call(cloud, 'OPTIONS', '/v1/me', { headers: { origin: 'https://evil.example' } });
    expect(pre.status).toBe(405);
    expect(pre.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('PKCE sign-in with the dev IdP', () => {
  it('issues tokens for a valid code + verifier and returns state', async () => {
    const { verifier, challenge } = pkce();
    const loc = await devAuthorize(cloud, 'Ana@Example.com', challenge, 'Ana');
    expect(loc.origin + loc.pathname).toBe(REDIRECT);
    expect(loc.searchParams.get('state')).toBe('st-123');
    const tok = await exchange(loc.searchParams.get('code')!, verifier);
    expect(tok.status).toBe(200);
    expect(tok.json).toMatchObject({ token_type: 'Bearer', expires_in: 900 });
    expect(tok.json.access_token.split('.')).toHaveLength(3);
    expect(tok.json.refresh_token).toMatch(/^klr_/);
    const header = JSON.parse(Buffer.from(tok.json.access_token.split('.')[0], 'base64url').toString());
    expect(header).toMatchObject({ alg: 'EdDSA', typ: 'JWT' });
    expect(typeof header.kid).toBe('string');

    const me = await call(cloud, 'GET', '/v1/me', { token: tok.json.access_token });
    expect(me.status).toBe(200);
    expect(me.json).toMatchObject({ email: 'ana@example.com', name: 'Ana', orgs: [] });
  });

  it('shows an IdP chooser when idp is missing and an email form for dev', async () => {
    const { challenge } = pkce();
    const chooser = await call(cloud, 'GET', authorizePath(challenge));
    expect(chooser.status).toBe(200);
    expect(chooser.text).toContain('idp=dev');
    expect(chooser.text).toContain('idp=email');
    const csp = chooser.headers.get('content-security-policy')!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain('form-action');
  });

  it('rejects a wrong verifier, and the code is single-use', async () => {
    const { verifier, challenge } = pkce();
    const loc = await devAuthorize(cloud, 'bob@example.com', challenge);
    const bad = await exchange(loc.searchParams.get('code')!, pkce().verifier);
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe('invalid_grant');
    // Consumed by the failed attempt.
    expect((await exchange(loc.searchParams.get('code')!, verifier)).status).toBe(400);
  });

  it('rejects malformed verifiers and redirect mismatches', async () => {
    const { verifier, challenge } = pkce();
    const loc = await devAuthorize(cloud, 'bob@example.com', challenge);
    expect((await exchange(loc.searchParams.get('code')!, 'short')).json.error).toBe('invalid_request');
    const loc2 = await devAuthorize(cloud, 'bob@example.com', challenge);
    const mismatch = await exchange(
      loc2.searchParams.get('code')!,
      verifier,
      'http://127.0.0.1:9999/callback',
    );
    expect(mismatch.status).toBe(400);
    expect(mismatch.json.error).toBe('invalid_grant');
  });

  it('expires authorization codes', async () => {
    const { verifier, challenge } = pkce();
    const loc = await devAuthorize(cloud, 'bob@example.com', challenge);
    cloud.clock.now += 6 * 60_000;
    expect((await exchange(loc.searchParams.get('code')!, verifier)).json.error).toBe('invalid_grant');
  });

  it('refuses non-loopback redirect URIs without redirecting', async () => {
    const { challenge } = pkce();
    for (const redirect_uri of [
      'https://evil.example/cb',
      'http://127.0.0.1/cb',
      'http://evil.example:8080/cb',
      'http://127.0.0.1:8080@evil.example/cb',
      'githappens://callback',
    ]) {
      const r = await call(cloud, 'GET', authorizePath(challenge, { redirect_uri, idp: 'dev' }));
      expect(r.status, redirect_uri).toBe(400);
      expect(r.headers.get('location')).toBeNull();
    }
    const localhost = await call(
      cloud,
      'GET',
      authorizePath(challenge, { redirect_uri: 'http://localhost:4000/cb', idp: 'dev' }),
    );
    expect(localhost.status).toBe(200);
  });

  it('requires S256 PKCE and the desktop client', async () => {
    const { challenge } = pkce();
    const plain = await call(
      cloud,
      'GET',
      authorizePath(challenge, { code_challenge_method: 'plain', idp: 'dev' }),
    );
    expect(plain.status).toBe(302);
    const loc = new URL(plain.headers.get('location')!);
    expect(loc.searchParams.get('error')).toBe('invalid_request');
    expect(loc.searchParams.get('state')).toBe('st-123');
    expect((await call(cloud, 'GET', authorizePath(challenge, { client_id: 'other' }))).status).toBe(400);
  });

  it('rejects tampered authorize requests and disabled dev login', async () => {
    const { challenge } = pkce();
    const page = await call(cloud, 'GET', authorizePath(challenge, { idp: 'dev' }));
    const areq = hiddenAreq(page.text);
    const tampered = await postForm(cloud, '/oauth/dev', { areq: `${areq}x`, email: 'a@example.com' });
    expect(tampered.status).toBe(400);
    cloud.config.devLogin = false;
    expect((await postForm(cloud, '/oauth/dev', { areq, email: 'a@example.com' })).status).toBe(404);
  });
});

describe('access tokens', () => {
  it('rejects missing, malformed, tampered and expired tokens with 401', async () => {
    const s = await signIn(cloud, 'carol@example.com');
    expect((await call(cloud, 'GET', '/v1/me')).status).toBe(401);
    expect((await call(cloud, 'GET', '/v1/me', { headers: { authorization: 'Basic abc' } })).status).toBe(
      401,
    );
    const [h, p, sig] = s.access.split('.');
    const claims = JSON.parse(Buffer.from(p!, 'base64url').toString());
    const forged = `${h}.${Buffer.from(JSON.stringify({ ...claims, sub: '00000000-0000-4000-8000-000000000000' })).toString('base64url')}.${sig}`;
    const r = await call(cloud, 'GET', '/v1/me', { token: forged });
    expect(r.status).toBe(401);
    expect(r.json.error).toBe('unauthorized');
    cloud.clock.now += 16 * 60_000;
    expect((await call(cloud, 'GET', '/v1/me', { token: s.access })).status).toBe(401);
  });
});

describe('refresh tokens', () => {
  const refresh = (token: string) =>
    call(cloud, 'POST', '/oauth/token', {
      body: { grant_type: 'refresh_token', refresh_token: token, client_id: 'desktop' },
    });

  it('rotates on every use and accepts form-encoded requests', async () => {
    const s = await signIn(cloud, 'dan@example.com');
    const r1 = await refresh(s.refresh);
    expect(r1.status).toBe(200);
    expect(r1.json.refresh_token).not.toBe(s.refresh);
    const r2 = await postForm(cloud, '/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: r1.json.refresh_token,
      client_id: 'desktop',
    });
    expect(r2.status).toBe(200);
    expect((await call(cloud, 'GET', '/v1/me', { token: r2.json.access_token })).status).toBe(200);
  });

  it('detects reuse of a rotated token and revokes the whole family', async () => {
    const s = await signIn(cloud, 'erin@example.com');
    const other = await signIn(cloud, 'erin@example.com'); // separate sign-in = separate family
    const r1 = await refresh(s.refresh);
    expect(r1.status).toBe(200);
    const reuse = await refresh(s.refresh);
    expect(reuse.status).toBe(400);
    expect(reuse.json.error).toBe('invalid_grant');
    // The legitimate successor is dead too.
    expect((await refresh(r1.json.refresh_token)).status).toBe(400);
    // Other sign-ins are unaffected.
    expect((await refresh(other.refresh)).status).toBe(200);
  });

  it('expires after 30 days', async () => {
    const s = await signIn(cloud, 'fay@example.com');
    cloud.clock.now += 31 * 86_400_000;
    expect((await refresh(s.refresh)).status).toBe(400);
  });

  it('revokes via /oauth/revoke (always 200)', async () => {
    const s = await signIn(cloud, 'gus@example.com');
    const rev = await call(cloud, 'POST', '/oauth/revoke', { body: { token: s.refresh } });
    expect(rev.status).toBe(200);
    expect(rev.json).toEqual({});
    expect((await refresh(s.refresh)).status).toBe(400);
    expect((await call(cloud, 'POST', '/oauth/revoke', { body: { token: 'unknown' } })).status).toBe(200);
  });

  it('rejects unknown grant types and clients', async () => {
    expect(
      (await call(cloud, 'POST', '/oauth/token', { body: { grant_type: 'password', client_id: 'desktop' } }))
        .json.error,
    ).toBe('unsupported_grant_type');
    expect(
      (await call(cloud, 'POST', '/oauth/token', { body: { grant_type: 'refresh_token' } })).json.error,
    ).toBe('invalid_client');
  });
});

describe('email magic link', () => {
  it('mails a single-use link that completes the PKCE flow', async () => {
    const { verifier, challenge } = pkce();
    const page = await call(
      cloud,
      'GET',
      authorizePath(challenge, { idp: 'email', login_hint: 'hana@example.com' }),
    );
    expect(page.text).toContain('value="hana@example.com"');
    const sent = await postForm(cloud, '/oauth/email', {
      areq: hiddenAreq(page.text),
      email: 'hana@example.com',
    });
    expect(sent.status).toBe(200);
    expect(cloud.mail).toHaveLength(1);
    expect(cloud.mail[0]!.to).toBe('hana@example.com');
    const link = cloud.mail[0]!.link;
    expect(link.startsWith(`${cloud.url}/oauth/email/callback?t=`)).toBe(true);

    const cb = await call(cloud, 'GET', link);
    expect(cb.status).toBe(302);
    const loc = new URL(cb.headers.get('location')!);
    const tok = await exchange(loc.searchParams.get('code')!, verifier);
    expect(tok.status).toBe(200);
    const me = await call(cloud, 'GET', '/v1/me', { token: tok.json.access_token });
    expect(me.json.email).toBe('hana@example.com');

    expect((await call(cloud, 'GET', link)).status).toBe(400); // reused
  });

  it('rejects expired links', async () => {
    const { challenge } = pkce();
    const page = await call(cloud, 'GET', authorizePath(challenge, { idp: 'email' }));
    await postForm(cloud, '/oauth/email', { areq: hiddenAreq(page.text), email: 'ivy@example.com' });
    cloud.clock.now += 16 * 60_000;
    expect((await call(cloud, 'GET', cloud.mail[0]!.link)).status).toBe(400);
  });
});

describe('GitHub federation', () => {
  it('redirects to GitHub, checks state + browser cookie, and links by verified email', async () => {
    cloud.config.github = { clientId: 'gh-client', clientSecret: 'gh-secret' };
    const existing = await signIn(cloud, 'jo@example.com');
    cloud.setUpstream(async (url, init) => {
      if (url === 'https://github.com/login/oauth/access_token') {
        expect(String(init.body)).toContain('client_secret=gh-secret');
        return Response.json({ access_token: 'gho_upstream' });
      }
      if (url === 'https://api.github.com/user')
        return Response.json({ id: 42, login: 'jo', name: 'Jo', avatar_url: 'https://avatars.example/42' });
      if (url === 'https://api.github.com/user/emails') {
        return Response.json([
          { email: 'other@example.com', verified: false, primary: false },
          { email: 'Jo@Example.com', verified: true, primary: true },
        ]);
      }
      return new Response('unexpected', { status: 500 });
    });
    const { verifier, challenge } = pkce();
    const start = await call(cloud, 'GET', authorizePath(challenge, { idp: 'github' }));
    expect(start.status).toBe(302);
    const gh = new URL(start.headers.get('location')!);
    expect(gh.origin).toBe('https://github.com');
    expect(gh.searchParams.get('redirect_uri')).toBe(`${cloud.url}/oauth/callback/github`);
    const cookie = start.headers.get('set-cookie')!.split(';')[0]!;
    const state = gh.searchParams.get('state')!;

    const noCookie = await call(
      cloud,
      'GET',
      `/oauth/callback/github?code=c&state=${encodeURIComponent(state)}`,
    );
    expect(noCookie.status).toBe(400);

    const cb = await call(cloud, 'GET', `/oauth/callback/github?code=c&state=${encodeURIComponent(state)}`, {
      headers: { cookie },
    });
    expect(cb.status).toBe(302);
    const loc = new URL(cb.headers.get('location')!);
    const tok = await exchange(loc.searchParams.get('code')!, verifier);
    const me = await call(cloud, 'GET', '/v1/me', { token: tok.json.access_token });
    expect(me.json.id).toBe(existing.userId);
    expect(me.json.avatarUrl).toBe('https://avatars.example/42');

    // State replay is refused.
    const replay = await call(
      cloud,
      'GET',
      `/oauth/callback/github?code=c&state=${encodeURIComponent(state)}`,
      { headers: { cookie } },
    );
    expect(replay.status).toBe(400);
  });
});

describe('logging', () => {
  it('never logs tokens, codes, emails or raw paths', async () => {
    const s = await signIn(cloud, 'kim@example.com');
    await call(cloud, 'POST', '/oauth/token', {
      body: { grant_type: 'refresh_token', refresh_token: s.refresh, client_id: 'desktop' },
    });
    const all = JSON.stringify(cloud.logs);
    expect(all).not.toContain(s.refresh);
    expect(all).not.toContain(s.access);
    expect(all).not.toContain('kim@example.com');
    expect(all).not.toContain('areq');
    expect(cloud.logs.some((l) => l.route === '/oauth/token')).toBe(true);
  });
});
