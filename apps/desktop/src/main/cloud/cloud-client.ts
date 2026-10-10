import path from 'node:path';

import type { ApiError, IdpId, Me, ServerInfo, TokenResponse } from '@githappens/cloud-api';
import { runLoopbackOAuth } from '@githappens/providers';

import type { CloudSession, CloudStatus } from '../../shared/ipc/cloud-contract';
import { secretAccount, SecretStoreUnavailableError, type SecretStore } from '../secrets/secret-store';
import { readJson, writeFileAtomic } from '../settings/atomic-file';
import { CloudError, type CloudHttp } from './cloud-http';

/**
 * Desktop client for a GitHappens Cloud server (spec 14 §5.1, §6.1).
 *
 * - Server URL comes from `cloud.serverUrl` ('' = cloud off → no network calls at all). https is
 *   required except for loopback hosts (local development / tests).
 * - Sign-in: system browser + loopback redirect with PKCE (RFC 8252) via `runLoopbackOAuth`.
 * - Tokens live only in the SecretStore under `<profileId>/cloud/<serverUrl>|<userId>`; they are
 *   never written to plain-text files, logged, or returned to callers.
 * - Access tokens are refreshed single-flight shortly before expiry and once after a 401.
 * - `profiles/<id>/cloud.json` caches the server URL, user id, last `/v1/me` and the active org, so
 *   the account menu works offline.
 */

export interface CloudClientOptions {
  /** Raw `cloud.serverUrl` setting. */
  serverUrl(): string;
  profileId(): string;
  /** Active profile directory (`cloud.json` lives there). */
  profileDir(): string;
  secrets: SecretStore;
  /** Electron `shell.openExternal`. */
  openExternal(url: string): void | Promise<unknown>;
  fetch?: typeof fetch;
  now?: () => number;
  /** Per-request timeout (default 20 s). */
  timeoutMs?: number;
  /** Browser sign-in timeout (default 5 min). */
  signInTimeoutMs?: number;
  userAgent?: string;
  log?: (message: string) => void;
}

interface PersistedState {
  version: 1;
  serverUrl?: string;
  userId?: string;
  me?: Me;
  activeOrgId?: string;
}

/** Secret payload (JSON) — never leaves this module. */
interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  /** epoch ms */
  expiresAt: number;
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type RequestOpts = NonNullable<Parameters<CloudHttp['request']>[2]>;

const STATE_FILE = 'cloud.json';
const REFRESH_SKEW_MS = 30_000;

const STATUS_CODES: Record<number, ApiError['error']> = {
  400: 'validation',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  410: 'gone',
  412: 'precondition_failed',
  413: 'too_large',
  422: 'validation',
  429: 'rate_limited',
};

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.localhost');
}

/**
 * `cloud.example.com/` → `https://cloud.example.com`. Keeps a path prefix (reverse proxies), drops
 * the trailing slash; rejects credentials, query/fragment and plain http on non-loopback hosts.
 */
export function normalizeServerUrl(raw: string): { url: string } | { error: string } {
  const t = raw.trim();
  if (!t) return { error: 'Enter a server address.' };
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`);
  } catch {
    return { error: 'That is not a valid server address.' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    return { error: 'The server address must start with https://.' };
  }
  if (u.protocol === 'http:' && !isLoopbackHost(u.hostname)) {
    return { error: 'The server must use https:// (plain http is only allowed for localhost).' };
  }
  if (u.username || u.password) return { error: 'The server address must not contain credentials.' };
  if (u.search || u.hash) return { error: 'The server address must not contain a query or fragment.' };
  return { url: `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}` };
}

/** SecretStore key (inside `<profileId>/cloud/`) of a session; extra suffixes hang off it with `|`. */
export const cloudSecretKey = (serverUrl: string, userId: string): string => `${serverUrl}|${userId}`;

const isMe = (v: unknown): v is Me =>
  !!v &&
  typeof v === 'object' &&
  typeof (v as Me).id === 'string' &&
  typeof (v as Me).email === 'string' &&
  Array.isArray((v as Me).orgs);

function isServerInfo(v: unknown): v is ServerInfo {
  const o = v as ServerInfo | null;
  return !!o && typeof o === 'object' && typeof o.name === 'string' && Array.isArray(o.idps);
}

export class CloudClient implements CloudHttp {
  private state: PersistedState = { version: 1 };
  private loadedFrom: string | null = null;
  private refreshing: Promise<StoredTokens> | null = null;
  private listeners = new Set<() => void>();
  private offline = false;
  private expired = false;
  private signInAbort: AbortController | null = null;
  private infoCache: { url: string; info: ServerInfo } | null = null;

  constructor(private readonly o: CloudClientOptions) {}

  private get fetchFn(): typeof fetch {
    return this.o.fetch ?? fetch;
  }

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  // ---- configuration & state ---------------------------------------------------------------------

  /** Normalized configured server, or null when cloud is off / the URL is invalid. */
  serverUrl(): string | null {
    const r = normalizeServerUrl(this.o.serverUrl());
    return 'url' in r ? r.url : null;
  }

  private load(): PersistedState {
    const file = path.join(this.o.profileDir(), STATE_FILE);
    if (this.loadedFrom === file) return this.state;
    this.loadedFrom = file;
    const r = readJson<PersistedState>(file);
    this.state = r.kind === 'ok' && r.value && r.value.version === 1 ? r.value : { version: 1 };
    if (this.state.me && !isMe(this.state.me)) delete this.state.me;
    return this.state;
  }

  private save(next: PersistedState): void {
    this.state = next;
    const file = path.join(this.o.profileDir(), STATE_FILE);
    this.loadedFrom = file;
    writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
  }

  private account(serverUrl: string, userId: string): string {
    return secretAccount(this.o.profileId(), 'cloud', cloudSecretKey(serverUrl, userId));
  }

  private readTokens(serverUrl: string, userId: string): StoredTokens | null {
    const raw = this.o.secrets.get(this.account(serverUrl, userId));
    if (!raw) return null;
    try {
      const t = JSON.parse(raw) as StoredTokens;
      return typeof t.accessToken === 'string' && typeof t.refreshToken === 'string' ? t : null;
    } catch {
      return null;
    }
  }

  private writeTokens(serverUrl: string, userId: string, t: TokenResponse): StoredTokens {
    const stored: StoredTokens = {
      accessToken: t.access_token,
      refreshToken: t.refresh_token,
      expiresAt: this.now() + Math.max(0, Number(t.expires_in) || 0) * 1000,
    };
    this.o.secrets.set(this.account(serverUrl, userId), JSON.stringify(stored));
    return stored;
  }

  /** Current session coordinates when signed in to the configured server (tokens present). */
  private current(): { serverUrl: string; userId: string } | null {
    const url = this.serverUrl();
    const st = this.load();
    if (!url || st.serverUrl !== url || !st.userId) return null;
    if (!this.readTokens(url, st.userId)) return null;
    return { serverUrl: url, userId: st.userId };
  }

  /**
   * SecretStore account for per-session secrets of other cloud services (e.g. the sync key cache),
   * removed on sign-out. Null when signed out.
   */
  sessionSecretAccount(suffix: string): string | null {
    const c = this.current();
    return c ? `${this.account(c.serverUrl, c.userId)}|${suffix}` : null;
  }

  me(): Me | null {
    return this.current() ? (this.load().me ?? null) : null;
  }

  activeOrgId(): string | null {
    const me = this.me();
    if (!me) return null;
    const id = this.load().activeOrgId;
    if (id && me.orgs.some((o) => o.id === id)) return id;
    return me.orgs[0]?.id ?? null;
  }

  session(): CloudSession | null {
    const c = this.current();
    const me = c && this.load().me;
    if (!c || !me) return null;
    const active = this.activeOrgId();
    return {
      serverUrl: c.serverUrl,
      user: {
        id: me.id,
        email: me.email,
        name: me.name,
        ...(me.avatarUrl ? { avatarUrl: me.avatarUrl } : {}),
      },
      orgs: me.orgs.map((o) => ({ id: o.id, name: o.name, slug: o.slug, role: o.role })),
      ...(active ? { activeOrgId: active } : {}),
    };
  }

  status(): CloudStatus {
    const raw = this.o.serverUrl();
    const norm = raw.trim() ? normalizeServerUrl(raw) : null;
    return {
      serverUrl: norm && 'url' in norm ? norm.url : null,
      ...(norm && 'error' in norm ? { serverUrlError: norm.error } : {}),
      session: this.session(),
      offline: this.offline,
      signingIn: !!this.signInAbort,
      ...(this.expired ? { expired: true } : {}),
    };
  }

  onSessionChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of [...this.listeners]) {
      try {
        l();
      } catch (e) {
        this.o.log?.(`session listener failed: ${(e as Error).message}`);
      }
    }
  }

  private setOffline(v: boolean): void {
    if (this.offline === v) return;
    this.offline = v;
    this.emit();
  }

  /** Startup / profile switch: reload persisted state and refresh `/v1/me` in the background. */
  start(): void {
    this.loadedFrom = null;
    this.load();
    this.emit();
    if (this.current()) void this.refreshMe().catch(() => undefined);
  }

  /**
   * `cloud.serverUrl` changed: sign out of the previous server (revoking its refresh token) and
   * forget cached server info.
   */
  async serverUrlChanged(): Promise<void> {
    this.infoCache = null;
    this.offline = false;
    this.expired = false;
    const st = this.load();
    if (st.serverUrl && st.serverUrl !== this.serverUrl()) await this.signOut();
    else this.emit();
  }

  // ---- server validation ---------------------------------------------------------------------------

  /** GET `<url>/.well-known/githappens-cloud` for an arbitrary (not yet saved) URL. */
  async validateServer(raw: string): Promise<{ url: string; info: ServerInfo }> {
    const norm = normalizeServerUrl(raw);
    if ('error' in norm) throw new CloudError('validation', norm.error);
    const res = await this.send(norm.url, 'GET', '/.well-known/githappens-cloud', {}, null);
    const data = await this.parse<unknown>(res);
    if (!isServerInfo(data)) {
      throw new CloudError('validation', 'That address does not look like a GitHappens Cloud server.');
    }
    if (norm.url === this.serverUrl()) this.infoCache = { url: norm.url, info: data };
    return { url: norm.url, info: data };
  }

  /** ServerInfo of the configured server (cached), or null when cloud is off. */
  async serverInfo(refresh = false): Promise<ServerInfo | null> {
    const url = this.serverUrl();
    if (!url) return null;
    if (!refresh && this.infoCache?.url === url) return this.infoCache.info;
    return (await this.validateServer(url)).info;
  }

  // ---- sign-in / sign-out --------------------------------------------------------------------------

  async signIn(idp: IdpId, opts: { loginHint?: string } = {}): Promise<CloudSession> {
    const base = this.requireServer();
    if (this.signInAbort) throw new CloudError('conflict', 'A sign-in is already in progress.');
    if (!this.o.secrets.available) throw new SecretStoreUnavailableError(this.o.secrets.backend);
    const info = await this.serverInfo(true);
    if (info && !info.idps.includes(idp)) {
      throw new CloudError('validation', `This server does not offer sign-in with ${idp}.`);
    }
    const ac = new AbortController();
    this.signInAbort = ac;
    this.emit();
    try {
      let response: TokenResponse | null = null;
      await runLoopbackOAuth({
        authorizeUrl: `${base}/oauth/authorize`,
        clientId: 'desktop',
        scopes: [],
        extraParams: { idp, ...(opts.loginHint ? { login_hint: opts.loginHint } : {}) },
        openBrowser: async (url) => {
          await this.o.openExternal(url);
        },
        signal: ac.signal,
        timeoutMs: this.o.signInTimeoutMs,
        tokenExchange: async (code, codeVerifier, redirectUri) => {
          const res = await this.send(
            base,
            'POST',
            '/oauth/token',
            {
              body: {
                grant_type: 'authorization_code',
                code,
                code_verifier: codeVerifier,
                redirect_uri: redirectUri,
                client_id: 'desktop',
              },
            },
            null,
          );
          const t = await this.parse<TokenResponse>(res);
          if (!t?.access_token || !t.refresh_token) {
            throw new CloudError('server', 'The server returned an incomplete token response.');
          }
          response = t;
          return { accessToken: t.access_token, refreshToken: t.refresh_token, scopes: [] };
        },
      });
      const tokens = response as TokenResponse | null;
      if (!tokens) throw new CloudError('server', 'Sign-in did not return tokens.');
      const me = await this.parse<Me>(await this.send(base, 'GET', '/v1/me', {}, tokens.access_token));
      if (!isMe(me)) throw new CloudError('server', 'The server returned an invalid account.');

      // Replacing another session (different account or server): revoke it first.
      const prev = this.load();
      if (prev.serverUrl && prev.userId && (prev.serverUrl !== base || prev.userId !== me.id)) {
        await this.revokeAndForget(prev.serverUrl, prev.userId);
      }
      this.writeTokens(base, me.id, tokens);
      const keepOrg =
        prev.serverUrl === base && prev.userId === me.id && me.orgs.some((o) => o.id === prev.activeOrgId);
      this.save({
        version: 1,
        serverUrl: base,
        userId: me.id,
        me,
        ...(keepOrg && prev.activeOrgId ? { activeOrgId: prev.activeOrgId } : {}),
      });
      this.expired = false;
      this.offline = false;
      return this.session()!;
    } finally {
      this.signInAbort = null;
      this.emit();
    }
  }

  cancelSignIn(): void {
    this.signInAbort?.abort();
  }

  /** Revokes the refresh token (best effort) and forgets the session and its secrets. */
  async signOut(): Promise<void> {
    const st = this.load();
    if (st.serverUrl && st.userId) await this.revokeAndForget(st.serverUrl, st.userId);
    this.save({ version: 1 });
    this.expired = false;
    this.emit();
  }

  private async revokeAndForget(serverUrl: string, userId: string): Promise<void> {
    const tokens = this.readTokens(serverUrl, userId);
    if (tokens?.refreshToken) {
      try {
        const res = await this.send(
          serverUrl,
          'POST',
          '/oauth/revoke',
          { body: { token: tokens.refreshToken }, signal: AbortSignal.timeout(5000) },
          null,
        );
        await res.body?.cancel().catch(() => undefined);
      } catch {
        this.o.log?.('Could not revoke the cloud session on the server (offline?).');
      }
    }
    const account = this.account(serverUrl, userId);
    this.o.secrets.delete(account);
    this.o.secrets.deleteByPrefix(`${account}|`);
  }

  /** Re-fetch `/v1/me` and persist it (account menu, org list). */
  async refreshMe(): Promise<CloudSession | null> {
    if (!this.current()) return null;
    const { data } = await this.request<Me>('GET', '/v1/me');
    if (!isMe(data)) throw new CloudError('server', 'The server returned an invalid account.');
    const st = this.load();
    if (st.userId !== data.id) return this.session();
    this.save({ ...st, me: data });
    this.emit();
    return this.session();
  }

  setActiveOrg(orgId: string): CloudSession {
    const me = this.me();
    if (!me) throw new CloudError('signed_out', 'Sign in to GitHappens Cloud first.');
    if (!me.orgs.some((o) => o.id === orgId)) throw new CloudError('not_found', 'Unknown organization.');
    this.save({ ...this.load(), activeOrgId: orgId });
    this.emit();
    return this.session()!;
  }

  /** Schedules account deletion (spec 14 §6.8) and signs out locally. */
  async deleteAccount(): Promise<{ deleteAfter: string }> {
    const { data } = await this.request<{ deleteAfter: string }>('DELETE', '/v1/me');
    await this.signOut();
    return { deleteAfter: data?.deleteAfter ?? '' };
  }

  // ---- HTTP ---------------------------------------------------------------------------------------

  private requireServer(): string {
    const raw = this.o.serverUrl();
    if (!raw.trim()) throw new CloudError('not_configured', 'No GitHappens Cloud server is configured.');
    const norm = normalizeServerUrl(raw);
    if ('error' in norm) throw new CloudError('not_configured', norm.error);
    return norm.url;
  }

  async request<T>(
    method: Method,
    urlPath: string,
    opts: RequestOpts = {},
  ): Promise<{ status: number; data: T; headers: Headers }> {
    const base = this.requireServer();
    const mode = opts.auth ?? true;
    let token: string | null = null;
    if (mode !== false) {
      if (this.current()) token = await this.accessToken(false);
      else if (mode === true) throw new CloudError('signed_out', 'Sign in to GitHappens Cloud first.');
    }
    let res = await this.send(base, method, urlPath, opts, token);
    if (res.status === 401 && token) {
      await res.body?.cancel().catch(() => undefined);
      token = await this.accessToken(true, token);
      res = await this.send(base, method, urlPath, opts, token);
    }
    const data = await this.parse<T>(res);
    return { status: res.status, data, headers: res.headers };
  }

  /** Valid access token; refreshes (single flight) when close to expiry or when `force`. */
  private async accessToken(force: boolean, stale?: string): Promise<string> {
    const c = this.current();
    if (!c) throw new CloudError('signed_out', 'Sign in to GitHappens Cloud first.');
    const t = this.readTokens(c.serverUrl, c.userId)!;
    if (force && stale && t.accessToken !== stale) return t.accessToken; // refreshed meanwhile
    if (!force && t.expiresAt - REFRESH_SKEW_MS > this.now()) return t.accessToken;
    if (!this.refreshing) {
      this.refreshing = this.refreshTokens(c.serverUrl, c.userId, t).finally(() => {
        this.refreshing = null;
      });
    }
    return (await this.refreshing).accessToken;
  }

  private async refreshTokens(serverUrl: string, userId: string, t: StoredTokens): Promise<StoredTokens> {
    const res = await this.send(
      serverUrl,
      'POST',
      '/oauth/token',
      { body: { grant_type: 'refresh_token', refresh_token: t.refreshToken, client_id: 'desktop' } },
      null,
    );
    if (res.status === 400 || res.status === 401) {
      // Refresh token expired, revoked or reused → the session is over.
      await res.body?.cancel().catch(() => undefined);
      const account = this.account(serverUrl, userId);
      this.o.secrets.delete(account);
      this.o.secrets.deleteByPrefix(`${account}|`);
      this.expired = true;
      this.emit();
      throw new CloudError('signed_out', 'Your GitHappens Cloud session expired. Sign in again.', 401);
    }
    const body = await this.parse<TokenResponse>(res);
    if (!body?.access_token || !body.refresh_token) {
      throw new CloudError('server', 'The server returned an incomplete token response.');
    }
    return this.writeTokens(serverUrl, userId, body);
  }

  private async send(
    base: string,
    method: Method,
    urlPath: string,
    opts: RequestOpts,
    token: string | null,
  ): Promise<Response> {
    const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers };
    if (this.o.userAgent) headers['User-Agent'] = this.o.userAgent;
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    const timeout = AbortSignal.timeout(this.o.timeoutMs ?? 20_000);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    try {
      const res = await this.fetchFn(`${base}${urlPath}`, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal,
        redirect: 'error',
      });
      this.setOffline(false);
      return res;
    } catch (e) {
      throw this.networkError(e, base, opts.signal);
    }
  }

  private networkError(e: unknown, base: string, callerSignal?: AbortSignal): unknown {
    if (callerSignal?.aborted) return e;
    this.setOffline(true);
    const host = (() => {
      try {
        return new URL(base).host;
      } catch {
        return base;
      }
    })();
    const name = (e as Error)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      return new CloudError('network', `${host} did not respond in time.`);
    }
    const cause = (e as { cause?: { code?: string; message?: string } })?.cause;
    return new CloudError(
      'network',
      `Could not reach ${host}${cause?.code ? ` (${cause.code})` : ''}. Check your connection.`,
    );
  }

  private async parse<T>(res: Response): Promise<T> {
    const text = res.status === 204 ? '' : await res.text();
    let data: unknown = undefined;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = undefined;
      }
    }
    if (!res.ok) {
      const body =
        data && typeof data === 'object' && typeof (data as ApiError).error === 'string'
          ? (data as ApiError)
          : undefined;
      const code = body?.error ?? STATUS_CODES[res.status] ?? 'server';
      throw new CloudError(
        code,
        body?.message || `The cloud server responded with HTTP ${res.status}.`,
        res.status,
        body,
      );
    }
    return data as T;
  }

  /** Presigned upload; no Authorization header. */
  async upload(url: string, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
    this.assertBlobUrl(url);
    const timeout = AbortSignal.timeout(Math.max(this.o.timeoutMs ?? 20_000, 120_000));
    try {
      const res = await this.fetchFn(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: bytes as unknown as BodyInit,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      this.setOffline(false);
      if (!res.ok) await this.parse(res);
      else await res.body?.cancel().catch(() => undefined);
    } catch (e) {
      if (e instanceof CloudError) throw e;
      throw this.networkError(e, url, signal);
    }
  }

  /** Presigned download; no Authorization header. */
  async download(url: string, signal?: AbortSignal): Promise<Uint8Array> {
    this.assertBlobUrl(url);
    const timeout = AbortSignal.timeout(Math.max(this.o.timeoutMs ?? 20_000, 120_000));
    try {
      const res = await this.fetchFn(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      this.setOffline(false);
      if (!res.ok) await this.parse(res);
      return new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      if (e instanceof CloudError) throw e;
      throw this.networkError(e, url, signal);
    }
  }

  private assertBlobUrl(url: string): void {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new CloudError('validation', 'Invalid transfer URL.');
    }
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopbackHost(u.hostname))) {
      throw new CloudError('validation', 'Transfers require https.');
    }
  }
}
