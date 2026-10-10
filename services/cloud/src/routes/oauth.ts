/**
 * OAuth 2.0 Authorization Code + PKCE (S256) for the desktop app with a loopback redirect
 * (RFC 8252), federated to GitHub / GitLab / Google, email magic links, or the `dev` IdP.
 *
 * Contract clarifications (see README "Contract notes"):
 * - `/oauth/token` errors use the RFC 6749 §5.2 shape `{ error: 'invalid_grant' | 'invalid_request' |
 *   'unsupported_grant_type' | 'invalid_client', error_description }` with HTTP 400, plus a `message`
 *   field mirroring `error_description` so ApiError-style clients can display it. Rate limiting stays
 *   429 `rate_limited`.
 * - Signing in to an account that is scheduled for deletion is refused (no implicit undelete).
 */
import { randomBytes } from 'node:crypto';
import type { IdpId, ServerInfo, TokenResponse } from '@githappens/cloud-api/types';
import { enabledIdps, isLoopbackHost } from '../config.ts';
import type { Ctx } from '../context.ts';
import { JWT_AUDIENCE, pkceChallenge, randomToken, safeEqual, sha256, signJwt, uuid } from '../crypto.ts';
import { readFormOrJson, redirect, type Router, sendHtml, sendJson } from '../http.ts';
import { type FederatedIdp, federation, IdpError } from '../idp.ts';
import type { UserRec } from '../store/types.ts';
import { normalizeEmail } from '../validation.ts';
import { authCsp, chooserPage, emailFormPage, messagePage, newNonce } from '../views.ts';

export const ACCESS_TTL_SEC = 15 * 60;
export const REFRESH_TTL_MS = 30 * 86_400_000;
const CODE_TTL_MS = 5 * 60_000;
const AREQ_TTL_SEC = 30 * 60;
const MAGIC_TTL_SEC = 15 * 60;
const FED_TTL_SEC = 15 * 60;
const OAUTH_BODY_LIMIT = 16 * 1024;

const CODE_VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const STATE_RE = /^[\x21-\x7e]{1,512}$/;
const FED_COOKIE = 'gh_fed';

/** The pending desktop authorization request, carried (HMAC-signed) between sign-in pages. */
interface AuthzRequest {
  /** redirect_uri */ r: string;
  /** code_challenge */ c: string;
  /** state */ s?: string;
  /** login_hint */ h?: string;
}

/**
 * Only RFC 8252 loopback redirects: `http://127.0.0.1:<port>/…` or `http://localhost:<port>/…`
 * with an explicit port, no credentials and no fragment.
 */
export function isLoopbackRedirect(value: string): boolean {
  if (value.length > 2048 || !/^[\x21-\x7e]+$/.test(value) || value.includes('#')) return false;
  const m = /^http:\/\/(127\.0\.0\.1|localhost):(\d{1,5})\//.exec(value);
  if (!m) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const port = Number(m[2]);
  return !url.username && !url.password && port >= 1 && port <= 65535 && url.port === String(port);
}

function htmlPage(ctx: Ctx, status: number, title: string, message: string): void {
  const nonce = newNonce();
  sendHtml(ctx.res, status, messagePage(nonce, title, message), authCsp(nonce));
}

function redirectWithParams(ctx: Ctx, areq: AuthzRequest, params: Record<string, string>): void {
  const url = new URL(areq.r);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  if (areq.s !== undefined) url.searchParams.set('state', areq.s);
  redirect(ctx.res, url.toString());
}

function oauthError(ctx: Ctx, status: number, error: string, description: string): void {
  sendJson(ctx.res, status, { error, error_description: description, message: description });
}

function cookie(ctx: Ctx, name: string): string | undefined {
  const raw = ctx.req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}

function secureCookies(ctx: Ctx): boolean {
  return ctx.app.config.publicUrl.startsWith('https:');
}

/** Find or create the account for an external identity, then hand the desktop an authorization code. */
async function completeLogin(
  ctx: Ctx,
  areq: AuthzRequest,
  identity: { provider: string; host: string; subject: string },
  profile: { email?: string; name: string; avatarUrl?: string },
): Promise<void> {
  const { store } = ctx.app;
  let user: UserRec | undefined;
  const linked = await store.findIdentity(identity.provider, identity.host, identity.subject);
  if (linked) user = await store.getUser(linked.userId);
  if (!user) {
    if (!profile.email) {
      htmlPage(
        ctx,
        400,
        'Email required',
        'Your account has no verified email address. Verify one with the provider and try again.',
      );
      return;
    }
    user = await store.getUserByEmail(profile.email);
    if (!user) {
      const created: UserRec = {
        id: uuid(),
        email: profile.email,
        name: profile.name.slice(0, 100),
        avatarUrl: profile.avatarUrl,
        createdAt: ctx.date(),
      };
      try {
        await store.createUser(created);
        user = created;
      } catch {
        user = await store.getUserByEmail(profile.email); // concurrent sign-up with the same email
        if (!user) throw new Error('user creation failed');
      }
    }
    await store.linkIdentity({ ...identity, userId: user.id });
  }
  if (user.deletedAt) {
    htmlPage(
      ctx,
      403,
      'Account scheduled for deletion',
      'This account is being deleted and can no longer sign in.',
    );
    return;
  }
  if (!user.avatarUrl && profile.avatarUrl)
    await store.updateUserProfile(user.id, { avatarUrl: profile.avatarUrl });

  const code = randomToken();
  await store.saveAuthCode({
    hash: sha256(code),
    userId: user.id,
    codeChallenge: areq.c,
    redirectUri: areq.r,
    expiresAt: new Date(ctx.app.now() + CODE_TTL_MS),
  });
  redirectWithParams(ctx, areq, { code });
}

async function issueTokens(ctx: Ctx, userId: string, familyId: string): Promise<TokenResponse> {
  const nowSec = Math.floor(ctx.app.now() / 1000);
  const access = signJwt(ctx.app.keys, {
    iss: ctx.app.config.publicUrl,
    aud: JWT_AUDIENCE,
    sub: userId,
    iat: nowSec,
    exp: nowSec + ACCESS_TTL_SEC,
    jti: uuid(),
  });
  const refresh = randomToken('klr_');
  await ctx.app.store.insertRefreshToken({
    id: uuid(),
    userId,
    familyId,
    hash: sha256(refresh),
    createdAt: ctx.date(),
    expiresAt: new Date(ctx.app.now() + REFRESH_TTL_MS),
  });
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_SEC, refresh_token: refresh };
}

function verifyAreq(ctx: Ctx, token: unknown): AuthzRequest | undefined {
  if (typeof token !== 'string') return undefined;
  const p = ctx.app.signer.verify<AuthzRequest & { exp: number }>('areq', token, ctx.app.now());
  return p && isLoopbackRedirect(p.r) && CHALLENGE_RE.test(p.c)
    ? { r: p.r, c: p.c, s: p.s, h: p.h }
    : undefined;
}

function signAreq(ctx: Ctx, areq: AuthzRequest): string {
  return ctx.app.signer.sign('areq', { ...areq, exp: Math.floor(ctx.app.now() / 1000) + AREQ_TTL_SEC });
}

export function serverInfo(ctx: Ctx, version: string): ServerInfo {
  return {
    name: 'GitHappens Cloud',
    version,
    idps: enabledIdps(ctx.app.config),
    limits: {
      patchMaxBytes: ctx.app.config.patchMaxBytes,
      patchMaxExpiryDays: ctx.app.config.patchMaxExpiryDays,
    },
  };
}

export function registerOAuth(router: Router<Ctx>, version: string): void {
  router.add('GET', '/healthz', async (ctx) => ctx.json(200, { status: 'ok' }));

  router.add('GET', '/.well-known/githappens-cloud', async (ctx) => ctx.json(200, serverInfo(ctx, version)));

  router.add('GET', '/oauth/authorize', async (ctx) => {
    const q = ctx.query;
    const redirectUri = q.get('redirect_uri') ?? '';
    if (!isLoopbackRedirect(redirectUri)) {
      htmlPage(
        ctx,
        400,
        'Invalid sign-in request',
        'redirect_uri must be http://127.0.0.1:<port>/… or http://localhost:<port>/….',
      );
      return;
    }
    if (q.get('client_id') !== 'desktop') {
      htmlPage(ctx, 400, 'Invalid sign-in request', 'Unknown client_id.');
      return;
    }
    const state = q.get('state') ?? undefined;
    const base: AuthzRequest = {
      r: redirectUri,
      c: '',
      s: state && STATE_RE.test(state) ? state : undefined,
    };
    if (state !== undefined && !STATE_RE.test(state)) {
      redirectWithParams(ctx, base, { error: 'invalid_request', error_description: 'state is malformed' });
      return;
    }
    if (q.get('response_type') !== 'code') {
      redirectWithParams(ctx, base, { error: 'unsupported_response_type' });
      return;
    }
    const challenge = q.get('code_challenge') ?? '';
    if (q.get('code_challenge_method') !== 'S256' || !CHALLENGE_RE.test(challenge)) {
      redirectWithParams(ctx, base, {
        error: 'invalid_request',
        error_description: 'PKCE with code_challenge_method=S256 is required',
      });
      return;
    }
    const hint = q.get('login_hint') ?? undefined;
    const areq: AuthzRequest = {
      ...base,
      c: challenge,
      h: hint && hint.length <= 254 && /^[^\s<>"]+$/.test(hint) ? hint : undefined,
    };

    const idps = enabledIdps(ctx.app.config);
    const idp = q.get('idp') as IdpId | null;
    if (!idp || !idps.includes(idp)) {
      const links = idps.map((i) => {
        const u = new URL(ctx.url.pathname + ctx.url.search, 'http://x');
        u.searchParams.set('idp', i);
        return { idp: i, href: u.pathname + u.search };
      });
      const nonce = newNonce();
      sendHtml(ctx.res, 200, chooserPage(nonce, links), authCsp(nonce));
      return;
    }

    if (idp === 'dev' || idp === 'email') {
      const nonce = newNonce();
      sendHtml(
        ctx.res,
        200,
        emailFormPage(nonce, {
          action: `/oauth/${idp}`,
          areq: signAreq(ctx, areq),
          hint: areq.h,
          dev: idp === 'dev',
        }),
        authCsp(nonce),
      );
      return;
    }

    const fed = federation(ctx.app.config, idp)!;
    const browserNonce = randomBytes(16).toString('base64url');
    const fedState = ctx.app.signer.sign('fed', {
      a: areq,
      i: idp,
      n: browserNonce,
      exp: Math.floor(ctx.app.now() / 1000) + FED_TTL_SEC,
    });
    const callback = `${ctx.app.config.publicUrl}/oauth/callback/${idp}`;
    redirect(ctx.res, fed.spec.authorizeUrl(fed.client, callback, fedState, areq.h), {
      'set-cookie': `${FED_COOKIE}=${browserNonce}; Path=/oauth/callback; HttpOnly; SameSite=Lax; Max-Age=${FED_TTL_SEC}${
        secureCookies(ctx) ? '; Secure' : ''
      }`,
    });
  });

  router.add('GET', '/oauth/callback/:idp', async (ctx, params) => {
    const idp = params.idp as FederatedIdp;
    const fed = ['github', 'gitlab', 'google'].includes(idp) ? federation(ctx.app.config, idp) : undefined;
    if (!fed) {
      htmlPage(ctx, 404, 'Not found', 'This identity provider is not configured.');
      return;
    }
    const st = ctx.app.signer.verify<{ a: AuthzRequest; i: string; n: string; exp: number }>(
      'fed',
      ctx.query.get('state') ?? '',
      ctx.app.now(),
    );
    if (!st || st.i !== idp || !isLoopbackRedirect(st.a.r)) {
      htmlPage(
        ctx,
        400,
        'Sign-in expired',
        'This sign-in attempt expired or is invalid. Start again from the GitHappens app.',
      );
      return;
    }
    const browserNonce = cookie(ctx, FED_COOKIE);
    if (!browserNonce || !safeEqual(browserNonce, st.n)) {
      htmlPage(ctx, 400, 'Sign-in failed', 'Finish signing in in the same browser where you started.');
      return;
    }
    const clear = { 'set-cookie': `${FED_COOKIE}=; Path=/oauth/callback; HttpOnly; SameSite=Lax; Max-Age=0` };
    ctx.res.setHeader('set-cookie', clear['set-cookie']);
    if (!(await ctx.app.store.consumeNonce(`fed:${st.n}`, new Date(st.exp * 1000)))) {
      htmlPage(ctx, 400, 'Sign-in failed', 'This sign-in response was already used.');
      return;
    }
    const code = ctx.query.get('code');
    if (ctx.query.get('error') || !code || code.length > 2048) {
      redirectWithParams(ctx, st.a, { error: 'access_denied' });
      return;
    }
    try {
      const token = await fed.spec.exchange(
        fed.client,
        code,
        `${ctx.app.config.publicUrl}/oauth/callback/${idp}`,
        ctx.app.fetch,
      );
      const profile = await fed.spec.profile(token, ctx.app.fetch);
      await completeLogin(
        ctx,
        st.a,
        { provider: idp, host: profile.host, subject: profile.subject },
        profile,
      );
    } catch (err) {
      if (!(err instanceof IdpError)) throw err;
      ctx.log.detail = 'idp_error';
      htmlPage(ctx, 502, 'Sign-in failed', err.message);
    }
  });

  router.add('POST', '/oauth/dev', async (ctx) => {
    if (!ctx.app.config.devLogin) {
      htmlPage(ctx, 404, 'Not found', 'Development sign-in is disabled.');
      return;
    }
    const form = await readFormOrJson(ctx.req, OAUTH_BODY_LIMIT);
    const areq = verifyAreq(ctx, form.areq);
    if (!areq) {
      htmlPage(
        ctx,
        400,
        'Sign-in expired',
        'This sign-in attempt expired. Start again from the GitHappens app.',
      );
      return;
    }
    const email = normalizeEmail(form.email);
    if (!email) {
      const nonce = newNonce();
      sendHtml(
        ctx.res,
        422,
        emailFormPage(nonce, {
          action: '/oauth/dev',
          areq: signAreq(ctx, areq),
          dev: true,
          error: 'Enter a valid email address.',
        }),
        authCsp(nonce),
      );
      return;
    }
    const rawName =
      typeof form.name === 'string'
        ? form.name
            .replace(/[\x00-\x1f\x7f]/g, '')
            .trim()
            .slice(0, 100)
        : '';
    await completeLogin(
      ctx,
      areq,
      { provider: 'dev', host: 'dev', subject: email },
      { email, name: rawName || email.split('@')[0]! },
    );
  });

  router.add('POST', '/oauth/email', async (ctx) => {
    if (ctx.app.config.mailTransport === 'none') {
      htmlPage(ctx, 404, 'Not found', 'Email sign-in is disabled.');
      return;
    }
    const form = await readFormOrJson(ctx.req, OAUTH_BODY_LIMIT);
    const areq = verifyAreq(ctx, form.areq);
    if (!areq) {
      htmlPage(
        ctx,
        400,
        'Sign-in expired',
        'This sign-in attempt expired. Start again from the GitHappens app.',
      );
      return;
    }
    const email = normalizeEmail(form.email);
    if (!email) {
      const nonce = newNonce();
      sendHtml(
        ctx.res,
        422,
        emailFormPage(nonce, {
          action: '/oauth/email',
          areq: signAreq(ctx, areq),
          dev: false,
          error: 'Enter a valid email address.',
        }),
        authCsp(nonce),
      );
      return;
    }
    const token = ctx.app.signer.sign('magic', {
      e: email,
      a: areq,
      n: randomBytes(16).toString('base64url'),
      exp: Math.floor(ctx.app.now() / 1000) + MAGIC_TTL_SEC,
    });
    const link = `${ctx.app.config.publicUrl}/oauth/email/callback?t=${encodeURIComponent(token)}`;
    try {
      await ctx.app.mailer.send({
        kind: 'magic-link',
        to: email,
        subject: 'Your GitHappens sign-in link',
        text: `Open this link to sign in to GitHappens Cloud (valid for 15 minutes, works once):\n\n${link}\n\nIf you did not try to sign in, ignore this email.`,
        link,
      });
    } catch {
      ctx.log.detail = 'mail_failed';
      htmlPage(ctx, 502, 'Could not send email', 'The sign-in email could not be sent. Try again later.');
      return;
    }
    htmlPage(
      ctx,
      200,
      'Check your email',
      `We sent a sign-in link to ${email}. Open it on this computer to finish signing in.`,
    );
  });

  router.add('GET', '/oauth/email/callback', async (ctx) => {
    if (ctx.app.config.mailTransport === 'none') {
      htmlPage(ctx, 404, 'Not found', 'Email sign-in is disabled.');
      return;
    }
    const p = ctx.app.signer.verify<{ e: string; a: AuthzRequest; n: string; exp: number }>(
      'magic',
      ctx.query.get('t') ?? '',
      ctx.app.now(),
    );
    if (!p || !isLoopbackRedirect(p.a.r) || !normalizeEmail(p.e)) {
      htmlPage(
        ctx,
        400,
        'Link expired',
        'This sign-in link is invalid or expired. Request a new one from the GitHappens app.',
      );
      return;
    }
    if (!(await ctx.app.store.consumeNonce(`magic:${p.n}`, new Date(p.exp * 1000)))) {
      htmlPage(
        ctx,
        400,
        'Link already used',
        'This sign-in link was already used. Request a new one from the GitHappens app.',
      );
      return;
    }
    await completeLogin(
      ctx,
      p.a,
      { provider: 'email', host: 'email', subject: p.e },
      { email: p.e, name: p.e.split('@')[0]! },
    );
  });

  router.add('POST', '/oauth/token', async (ctx) => {
    const body = await readFormOrJson(ctx.req, OAUTH_BODY_LIMIT);
    const s = (k: string): string | undefined =>
      typeof body[k] === 'string' ? (body[k] as string) : undefined;
    if (s('client_id') !== 'desktop')
      return oauthError(ctx, 400, 'invalid_client', 'client_id must be "desktop"');
    const grant = s('grant_type');
    ctx.log.detail = grant === 'authorization_code' || grant === 'refresh_token' ? grant : undefined;
    const { store } = ctx.app;
    const now = ctx.date();

    if (grant === 'authorization_code') {
      const code = s('code');
      const verifier = s('code_verifier');
      const redirectUri = s('redirect_uri');
      if (!code || code.length > 256 || !verifier || !redirectUri) {
        return oauthError(ctx, 400, 'invalid_request', 'code, code_verifier and redirect_uri are required');
      }
      if (!CODE_VERIFIER_RE.test(verifier)) {
        return oauthError(
          ctx,
          400,
          'invalid_request',
          'code_verifier must be 43-128 characters of [A-Za-z0-9-._~]',
        );
      }
      const rec = await store.consumeAuthCode(sha256(code), now);
      if (!rec) return oauthError(ctx, 400, 'invalid_grant', 'The authorization code is invalid or expired');
      if (rec.redirectUri !== redirectUri)
        return oauthError(ctx, 400, 'invalid_grant', 'redirect_uri does not match');
      if (!safeEqual(pkceChallenge(verifier), rec.codeChallenge)) {
        return oauthError(ctx, 400, 'invalid_grant', 'PKCE verification failed');
      }
      const user = await store.getUser(rec.userId);
      if (!user || user.deletedAt) return oauthError(ctx, 400, 'invalid_grant', 'Account not found');
      ctx.log.userId = user.id;
      return ctx.json(200, await issueTokens(ctx, user.id, uuid()));
    }

    if (grant === 'refresh_token') {
      const rt = s('refresh_token');
      if (!rt || rt.length > 256) return oauthError(ctx, 400, 'invalid_request', 'refresh_token is required');
      const rec = await store.findRefreshToken(sha256(rt));
      if (!rec || rec.revokedAt || rec.expiresAt <= now) {
        return oauthError(ctx, 400, 'invalid_grant', 'The refresh token is invalid, expired or revoked');
      }
      if (rec.usedAt || !(await store.markRefreshTokenUsed(rec.id, now))) {
        // A rotated token came back: assume it leaked and kill every token of this sign-in.
        await store.revokeRefreshFamily(rec.familyId, now);
        ctx.log.detail = 'refresh_reuse';
        return oauthError(ctx, 400, 'invalid_grant', 'Refresh token reuse detected; sign in again');
      }
      const user = await store.getUser(rec.userId);
      if (!user || user.deletedAt) return oauthError(ctx, 400, 'invalid_grant', 'Account not found');
      ctx.log.userId = user.id;
      return ctx.json(200, await issueTokens(ctx, user.id, rec.familyId));
    }

    return oauthError(
      ctx,
      400,
      'unsupported_grant_type',
      'grant_type must be authorization_code or refresh_token',
    );
  });

  router.add('POST', '/oauth/revoke', async (ctx) => {
    const body = await readFormOrJson(ctx.req, OAUTH_BODY_LIMIT);
    const token = typeof body.token === 'string' ? body.token : undefined;
    if (token && token.length <= 256) {
      const rec = await ctx.app.store.findRefreshToken(sha256(token));
      if (rec) await ctx.app.store.revokeRefreshFamily(rec.familyId, ctx.date());
    }
    ctx.json(200, {});
  });
}

/** True when the public URL is served without TLS on a non-loopback host (warn at startup). */
export function insecurePublicUrl(publicUrl: string): boolean {
  const u = new URL(publicUrl);
  return u.protocol === 'http:' && !isLoopbackHost(u.hostname);
}
