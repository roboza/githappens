import type { ProviderErrorCode, SerializedProviderError } from './types';

/**
 * Small fetch-based HTTP client shared by all providers (spec 10 §5.3 "HttpClient (injected,
 * with auth + rate-limit middleware)"). Pure: no Electron; `fetch` is injectable for tests
 * (msw intercepts the global fetch in Vitest).
 */

export class ProviderError extends Error {
  constructor(readonly serialized: SerializedProviderError) {
    super(serialized.message);
    this.name = 'ProviderError';
  }
  get code(): ProviderErrorCode {
    return this.serialized.code;
  }
}

export interface RateLimitInfo {
  remaining: number;
  limit: number;
  /** epoch ms */
  resetAt: number;
}

/**
 * Per-integration request budget (spec 10 §6.4): a concurrency cap (default 4, FIFO), serialized
 * mutations, and a background-poll pause while the remaining rate-limit budget is below
 * `pauseBelowRatio` (default 10%) until the reset. One instance per integration, shared by every
 * HttpClient built for that account. User-initiated requests are never paused.
 */
export class RequestGate {
  private readonly maxConcurrent: number;
  private readonly pauseBelowRatio: number;
  private readonly now: () => number;
  private latest: RateLimitInfo | null = null;
  private active = 0;
  private mutationActive = false;
  private readonly queue: Array<{ mutation: boolean; start: () => void }> = [];

  constructor(o: Partial<{ maxConcurrent: number; pauseBelowRatio: number; now: () => number }> = {}) {
    this.maxConcurrent = Math.max(1, o.maxConcurrent ?? 4);
    this.pauseBelowRatio = o.pauseBelowRatio ?? 0.1;
    this.now = o.now ?? Date.now;
  }

  /** Remembers the latest rate-limit budget seen for this integration. */
  observe(r: RateLimitInfo): void {
    this.latest = r;
  }

  get budget(): RateLimitInfo | null {
    return this.latest;
  }

  /** In-flight request count (diagnostics/tests). */
  get inFlight(): number {
    return this.active;
  }

  /** True while the remaining budget is below the threshold and the reset is still ahead. */
  paused(): boolean {
    const b = this.latest;
    if (!b || !(b.limit > 0)) return false;
    return b.remaining / b.limit < this.pauseBelowRatio && b.resetAt > this.now();
  }

  /** Waits for a slot; resolves with an idempotent release function. */
  async acquire(o: { mutation: boolean; background: boolean }): Promise<() => void> {
    if (o.background && this.paused()) {
      throw new ProviderError({
        code: 'rate_limited',
        message: 'Background refresh paused until the rate limit resets.',
        retryAt: this.latest!.resetAt,
      });
    }
    await new Promise<void>((resolve) => {
      this.queue.push({ mutation: o.mutation, start: resolve });
      this.pump();
    });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      if (o.mutation) this.mutationActive = false;
      this.pump();
    };
  }

  private pump(): void {
    // FIFO; a mutation waiting behind another mutation doesn't hold up reads queued after it.
    for (let i = 0; i < this.queue.length && this.active < this.maxConcurrent;) {
      const next = this.queue[i]!;
      if (next.mutation && this.mutationActive) {
        i++;
        continue;
      }
      this.queue.splice(i, 1);
      this.active++;
      if (next.mutation) this.mutationActive = true;
      next.start();
    }
  }
}

/** In-memory LRU of conditional-GET results keyed by URL (spec 10 §6.4: 2,000 entries). */
export class EtagStore {
  private readonly map = new Map<string, { etag: string; data: unknown }>();

  constructor(readonly capacity = 2000) {}

  get(key: string): { etag: string; data: unknown } | undefined {
    const v = this.map.get(key);
    if (v) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key: string, v: { etag: string; data: unknown }): void {
    this.map.delete(key);
    this.map.set(key, v);
    while (this.map.size > this.capacity) this.map.delete(this.map.keys().next().value!);
  }

  get size(): number {
    return this.map.size;
  }
}

export interface HttpClientOptions {
  baseUrl: string;
  /** Returns the Authorization header value (e.g. "Bearer x", "Basic y"), or null when anonymous. */
  auth?: () => string | null | Promise<string | null>;
  /** Extra default headers (Accept, API version, …). */
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  /** Called after every response that carries rate-limit headers. */
  onRateLimit?: (r: RateLimitInfo) => void;
  /** Maps provider-specific error payloads to a message (optional). */
  errorMessage?: (status: number, body: unknown) => string | undefined;
  /** Retries for 5xx / network errors (idempotent methods only). Default 2. */
  retries?: number;
  userAgent?: string;
  timeoutMs?: number;
  /** Shared per-integration budget (concurrency cap, serialized mutations, background pause). */
  gate?: RequestGate;
  /** Requests of this client are background polls (paused while the budget is low). */
  background?: boolean;
  /** Transparent conditional GETs (If-None-Match → cached data on 304). One store per integration. */
  etagStore?: EtagStore;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  headers?: Record<string, string>;
  /** Conditional GET; a 304 resolves with `notModified: true`. */
  etag?: string;
  /** Absolute URL (pagination `next` links). */
  url?: string;
  signal?: AbortSignal;
}

export interface HttpResponse<T> {
  status: number;
  data: T;
  headers: Headers;
  notModified: boolean;
  etag?: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class HttpClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly o: HttpClientOptions) {
    this.fetchImpl = o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  }

  get baseUrl(): string {
    return this.o.baseUrl;
  }

  buildUrl(path: string, query?: RequestOptions['query']): string {
    const base = this.o.baseUrl.replace(/\/+$/, '');
    const u = new URL(/^https?:\/\//.test(path) ? path : `${base}/${path.replace(/^\/+/, '')}`);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  async request<T = unknown>(path: string, ro: RequestOptions = {}): Promise<HttpResponse<T>> {
    const method = ro.method ?? 'GET';
    const url = ro.url ?? this.buildUrl(path, ro.query);
    const idempotent = method === 'GET' || method === 'PUT' || method === 'DELETE';
    const maxRetries = idempotent ? (this.o.retries ?? 2) : 0;

    const gate = this.o.gate;
    const store = method === 'GET' && !ro.etag ? this.o.etagStore : undefined;

    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = {
        Accept: 'application/json',
        ...(this.o.userAgent ? { 'User-Agent': this.o.userAgent } : {}),
        ...this.o.headers,
        ...ro.headers,
      };
      const auth = await this.o.auth?.();
      if (auth) headers.Authorization = auth;
      const cached = store?.get(url);
      if (ro.etag) headers['If-None-Match'] = ro.etag;
      else if (cached) headers['If-None-Match'] = cached.etag;
      let body: string | URLSearchParams | undefined;
      if (ro.body !== undefined) {
        if (typeof ro.body === 'string' || ro.body instanceof URLSearchParams) body = ro.body;
        else {
          body = JSON.stringify(ro.body);
          headers['Content-Type'] ??= 'application/json';
        }
      }

      const release = gate
        ? await gate.acquire({ mutation: method !== 'GET', background: !!this.o.background })
        : undefined;
      let retryDelay = 0;
      try {
        let res: Response;
        const timeout = this.o.timeoutMs ? AbortSignal.timeout(this.o.timeoutMs) : undefined;
        const signal = ro.signal && timeout ? AbortSignal.any([ro.signal, timeout]) : (ro.signal ?? timeout);
        try {
          res = await this.fetchImpl(url, { method, headers, body, signal });
        } catch (e) {
          if (attempt < maxRetries && !ro.signal?.aborted) {
            retryDelay = 250 * 2 ** attempt;
            continue;
          }
          throw new ProviderError({ code: 'network', message: `Network error: ${(e as Error).message}` });
        }

        this.trackRateLimit(res.headers);
        if (res.status === 304) {
          if (cached) {
            // Transparent ETag cache: the caller sees the previous payload.
            return {
              status: 304,
              data: cached.data as T,
              headers: res.headers,
              notModified: false,
              etag: cached.etag,
            };
          }
          return {
            status: 304,
            data: undefined as T,
            headers: res.headers,
            notModified: true,
            etag: ro.etag,
          };
        }
        if (res.status >= 500 && attempt < maxRetries) {
          retryDelay = 250 * 2 ** attempt;
          continue;
        }
        const text = await res.text();
        let data: unknown = text;
        if (text && (res.headers.get('content-type') ?? '').includes('json')) {
          try {
            data = JSON.parse(text);
          } catch {
            /* keep text */
          }
        } else if (!text) data = undefined;

        if (!res.ok) {
          const err = this.toError(res, data);
          if (gate && err.code === 'rate_limited' && err.serialized.retryAt) {
            gate.observe({ remaining: 0, limit: gate.budget?.limit ?? 1, resetAt: err.serialized.retryAt });
          }
          throw err;
        }
        const etag = res.headers.get('etag') ?? undefined;
        if (store && etag && res.status === 200) store.set(url, { etag, data });
        return { status: res.status, data: data as T, headers: res.headers, notModified: false, etag };
      } finally {
        release?.();
        if (retryDelay) await sleep(retryDelay);
      }
    }
  }

  get<T>(path: string, ro: Omit<RequestOptions, 'method' | 'body'> = {}): Promise<T> {
    return this.request<T>(path, { ...ro, method: 'GET' }).then((r) => r.data);
  }
  post<T>(path: string, body?: unknown, ro: Omit<RequestOptions, 'method' | 'body'> = {}): Promise<T> {
    return this.request<T>(path, { ...ro, method: 'POST', body }).then((r) => r.data);
  }
  put<T>(path: string, body?: unknown, ro: Omit<RequestOptions, 'method' | 'body'> = {}): Promise<T> {
    return this.request<T>(path, { ...ro, method: 'PUT', body }).then((r) => r.data);
  }
  patch<T>(path: string, body?: unknown, ro: Omit<RequestOptions, 'method' | 'body'> = {}): Promise<T> {
    return this.request<T>(path, { ...ro, method: 'PATCH', body }).then((r) => r.data);
  }
  delete<T = void>(path: string, ro: Omit<RequestOptions, 'method' | 'body'> = {}): Promise<T> {
    return this.request<T>(path, { ...ro, method: 'DELETE' }).then((r) => r.data);
  }

  private trackRateLimit(h: Headers): void {
    const remaining = h.get('x-ratelimit-remaining') ?? h.get('ratelimit-remaining');
    const limit = h.get('x-ratelimit-limit') ?? h.get('ratelimit-limit');
    const reset = h.get('x-ratelimit-reset') ?? h.get('ratelimit-reset');
    if (remaining === null || limit === null) return;
    const resetNum = Number(reset ?? 0);
    // GitHub sends epoch seconds; some providers send seconds-until-reset.
    const resetAt = resetNum > 1e9 ? resetNum * 1000 : Date.now() + resetNum * 1000;
    const info: RateLimitInfo = { remaining: Number(remaining), limit: Number(limit), resetAt };
    this.o.gate?.observe(info);
    this.o.onRateLimit?.(info);
  }

  private toError(res: Response, body: unknown): ProviderError {
    const providerMessage =
      this.o.errorMessage?.(res.status, body) ??
      (typeof body === 'object' && body && 'message' in body
        ? String((body as { message: unknown }).message)
        : undefined) ??
      (typeof body === 'string' ? body.slice(0, 300) : undefined);
    const h = res.headers;
    const scopesNeeded = h.get('x-accepted-oauth-scopes');
    const scopesHave = h.get('x-oauth-scopes');
    const retryAfter = h.get('retry-after');
    const remaining = h.get('x-ratelimit-remaining') ?? h.get('ratelimit-remaining');
    const reset = Number(h.get('x-ratelimit-reset') ?? h.get('ratelimit-reset') ?? 0);
    const base = { providerMessage, message: providerMessage ?? `HTTP ${res.status}` };
    switch (true) {
      case res.status === 401:
        return new ProviderError({
          ...base,
          code: 'auth_required',
          message: 'Authentication required or the token is no longer valid.',
        });
      case res.status === 429 || (res.status === 403 && remaining === '0'): {
        const retryAt = retryAfter
          ? Date.now() + Number(retryAfter) * 1000
          : reset > 1e9
            ? reset * 1000
            : Date.now() + 60_000;
        return new ProviderError({ ...base, code: 'rate_limited', message: 'Rate limit exceeded.', retryAt });
      }
      case res.status === 403 && /SAML|organization.*(policy|restrict)/i.test(providerMessage ?? ''):
        return new ProviderError({ ...base, code: 'forbidden_org_policy' });
      case res.status === 403 && !!scopesNeeded: {
        const have = new Set((scopesHave ?? '').split(',').map((x) => x.trim()));
        const missing = scopesNeeded!
          .split(',')
          .map((x) => x.trim())
          .filter((x) => x && !have.has(x));
        return new ProviderError({ ...base, code: 'insufficient_scope', missingScopes: missing });
      }
      case res.status === 403:
        return new ProviderError({ ...base, code: 'insufficient_scope' });
      case res.status === 404:
        return new ProviderError({ ...base, code: 'not_found' });
      case res.status === 409:
        return new ProviderError({ ...base, code: 'conflict' });
      case res.status === 422 || res.status === 400:
        return new ProviderError({ ...base, code: 'validation' });
      default:
        return new ProviderError({ ...base, code: 'server' });
    }
  }
}

/** Parse an RFC 5988 `Link` header into rel → url. */
export function parseLinkHeader(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="([^"]+)"/.exec(part.trim());
    if (m) out[m[2]!] = m[1]!;
  }
  return out;
}

/** Parse "https://host/owner/repo(.git)", "git@host:owner/repo.git", "ssh://git@host:22/owner/repo.git". */
export function parseRemoteUrl(url: string): { host: string; path: string } | null {
  const u = url.trim();
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/\/)(.+)$/.exec(u);
  if (scp && !/^[a-z]+:\/\//i.test(u))
    return { host: scp[1]!.toLowerCase(), path: scp[2]!.replace(/\.git$/i, '').replace(/\/+$/, '') };
  try {
    const parsed = new URL(u);
    return {
      host: parsed.hostname.toLowerCase(),
      path: decodeURIComponent(parsed.pathname)
        .replace(/^\/+/, '')
        .replace(/\.git$/i, '')
        .replace(/\/+$/, ''),
    };
  } catch {
    return null;
  }
}
