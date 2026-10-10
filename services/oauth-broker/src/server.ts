/**
 * GitHappens OAuth broker (spec 10 §6.1, spec 00 §4 `/services/oauth-broker`).
 *
 * A stateless code→token / refresh proxy that adds the OAuth client secret a desktop app cannot
 * keep. It stores nothing, and never logs request bodies, codes, verifiers, tokens or secrets.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { type BrokerConfig, type ClientCredentials, type ProviderId, PROVIDER_IDS } from './config.ts';
import { createLogger, type LogFields, type Logger, type LogSink } from './logger.ts';
import {
  type Grant,
  isProviderEnabled,
  isProviderId,
  PROVIDERS,
  type ProviderSpec,
  resolveCredentials,
} from './providers.ts';
import { TokenBucketLimiter } from './rate-limit.ts';
import { HttpError, parseExchangeBody, parseRefreshBody, parseRevokeBody } from './validation.ts';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface BrokerOptions {
  /** Upstream HTTP client; tests inject a mock. Defaults to global fetch. */
  fetch?: FetchLike;
  /** Where structured log entries go. Defaults to one JSON line per entry on stdout. */
  logSink?: LogSink;
  /** Millisecond clock for the rate limiter (tests). */
  now?: () => number;
}

/** Normalized token response returned to the desktop app. */
export interface TokenResponse {
  access_token: string;
  token_type: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
  scope?: string;
}

const MAX_UPSTREAM_BYTES = 64 * 1024;
const ERROR_CODE_RE = /^[A-Za-z0-9_.-]{1,64}$/;

const SECURITY_HEADERS: Record<string, string> = {
  'cache-control': 'no-store',
  pragma: 'no-cache',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'cross-origin-resource-policy': 'same-origin',
};

type Route =
  { kind: 'health' } | { kind: 'token' | 'refresh' | 'revoke'; provider: string } | { kind: 'none' };

function matchRoute(pathname: string): Route {
  if (pathname === '/healthz') return { kind: 'health' };
  const m = /^\/(token|refresh|revoke)\/([^/]{1,64})\/?$/.exec(pathname);
  if (m) return { kind: m[1] as 'token' | 'refresh' | 'revoke', provider: m[2]! };
  return { kind: 'none' };
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  if (res.headersSent) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    ...headers,
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendError(res: ServerResponse, err: HttpError): void {
  sendJson(res, err.status, { error: err.error, error_description: err.description }, err.headers);
}

function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    const value = Array.isArray(xff) ? xff.join(',') : xff;
    if (value) {
      // The rightmost entry is the one appended by our own proxy; earlier ones are client-controlled.
      const parts = value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const last = parts[parts.length - 1];
      if (last) return last;
    }
  }
  return req.socket.remoteAddress ?? 'unknown';
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const fail = (err: HttpError): void => {
      if (done) return;
      done = true;
      req.removeAllListeners('data');
      req.pause();
      reject(err);
    };
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        fail(new HttpError(413, 'payload_too_large', `Request body exceeds ${limit} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', () => fail(new HttpError(400, 'invalid_request', 'Request stream error')));
  });
}

function parseJson(buf: Buffer): unknown {
  if (buf.length === 0) throw new HttpError(400, 'invalid_request', 'Request body is empty');
  const text = buf.toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid_request', 'Request body is not valid JSON');
  }
}

function secretsOf(creds: ClientCredentials, grant: Grant): string[] {
  const out: string[] = [];
  if (creds.clientSecret) out.push(creds.clientSecret);
  if (grant.type === 'authorization_code') {
    out.push(grant.code);
    if (grant.codeVerifier) out.push(grant.codeVerifier);
  } else {
    out.push(grant.refreshToken);
  }
  return out.filter((s) => s.length >= 4);
}

/** Make an upstream-provided string safe to echo: printable, short, and free of our secrets. */
function sanitizeDescription(value: unknown, secrets: string[]): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  let s = value.replace(/[^\x20-\x7e]/g, ' ').slice(0, 512);
  for (const secret of secrets) s = s.split(secret).join('[redacted]');
  return s.slice(0, 300);
}

function parseUpstreamBody(text: string, contentType: string | null): Record<string, unknown> | undefined {
  if (contentType?.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(text));
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return undefined;
}

function toInt(value: unknown): number | undefined {
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

function normalizeToken(provider: ProviderId, body: Record<string, unknown>): TokenResponse | undefined {
  const accessToken = body.access_token;
  if (typeof accessToken !== 'string' || accessToken.length === 0) return undefined;
  const out: TokenResponse = {
    access_token: accessToken,
    token_type:
      typeof body.token_type === 'string' && body.token_type ? body.token_type.toLowerCase() : 'bearer',
  };
  if (typeof body.refresh_token === 'string' && body.refresh_token) out.refresh_token = body.refresh_token;
  const expiresIn = toInt(body.expires_in);
  if (expiresIn !== undefined) out.expires_in = expiresIn;
  const rtExpiresIn = toInt(body.refresh_token_expires_in);
  if (rtExpiresIn !== undefined) out.refresh_token_expires_in = rtExpiresIn;
  if (typeof body.scope === 'string') {
    // GitHub reports scopes comma-separated; RFC 6749 says space-separated.
    out.scope = (provider === 'github' ? body.scope.split(',') : body.scope.split(' '))
      .map((s) => s.trim())
      .filter(Boolean)
      .join(' ');
  }
  return out;
}

interface Upstream {
  response: TokenResponse;
  upstreamStatus: number;
}

async function callUpstream(
  fetchImpl: FetchLike,
  spec: ProviderSpec,
  creds: ClientCredentials,
  grant: Grant,
  host: string,
  config: BrokerConfig,
  logFields: LogFields,
  logger: Logger,
): Promise<Upstream> {
  const request = spec.build(creds, grant, host, config);
  const secrets = secretsOf(creds, grant);

  let res: Response;
  try {
    res = await fetchImpl(request.url, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(config.upstreamTimeoutMs),
    });
  } catch (err) {
    const name = (err as { name?: unknown } | null)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      logger.warn({ ...logFields, msg: 'upstream timeout' });
      throw new HttpError(504, 'upstream_timeout', `${spec.id} token endpoint did not respond in time`);
    }
    logger.warn({ ...logFields, msg: 'upstream unreachable' });
    throw new HttpError(502, 'upstream_unreachable', `Could not reach the ${spec.id} token endpoint`);
  }

  logFields.upstreamStatus = res.status;
  let text: string;
  try {
    text = await res.text();
  } catch {
    throw new HttpError(502, 'upstream_error', `Failed reading the ${spec.id} token response`);
  }
  if (text.length > MAX_UPSTREAM_BYTES) {
    throw new HttpError(502, 'upstream_error', `${spec.id} token response too large`);
  }
  const body = parseUpstreamBody(text, res.headers.get('content-type'));

  // GitHub answers errors with HTTP 200 + {error}; everyone else uses 4xx.
  const upstreamError = body && typeof body.error === 'string' ? body.error : undefined;
  if (res.ok && !upstreamError) {
    const token = body ? normalizeToken(spec.id, body) : undefined;
    if (token) return { response: token, upstreamStatus: res.status };
    throw new HttpError(502, 'upstream_invalid_response', `${spec.id} returned no access_token`);
  }

  const clientError = res.ok || (res.status >= 400 && res.status < 500);
  if (!clientError || !upstreamError) {
    throw new HttpError(502, 'upstream_error', `${spec.id} token endpoint returned HTTP ${res.status}`);
  }

  const code = ERROR_CODE_RE.test(upstreamError) ? upstreamError : 'invalid_grant';
  logFields.upstreamError = code;
  if (
    code === 'invalid_client' ||
    code === 'unauthorized_client' ||
    code === 'incorrect_client_credentials'
  ) {
    // Our registration is wrong, not the user's grant: surface it as a server-side problem.
    logger.error({ ...logFields, msg: 'upstream rejected broker client credentials' });
    throw new HttpError(502, 'broker_misconfigured', `${spec.id} rejected the broker's client credentials`);
  }
  const description =
    sanitizeDescription(body?.error_description, secrets) ??
    sanitizeDescription(body?.message, secrets) ??
    `${spec.id} rejected the request`;
  const status = res.status === 429 ? 429 : 400;
  throw new HttpError(status, code, description);
}

/**
 * Revoke a user token upstream (spec 10 §9 "Disconnect"). 2xx, and 404/422 for a token that is
 * already invalid, count as revoked: either way the token can no longer be used. The upstream
 * body is never read into a response or a log, since it may echo the token.
 */
async function revokeUpstream(
  fetchImpl: FetchLike,
  spec: ProviderSpec,
  creds: ClientCredentials,
  token: string,
  host: string,
  config: BrokerConfig,
  logFields: LogFields,
  logger: Logger,
): Promise<void> {
  const request = spec.revoke!(creds, token, host);
  let res: Response;
  try {
    res = await fetchImpl(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(config.upstreamTimeoutMs),
    });
  } catch (err) {
    const name = (err as { name?: unknown } | null)?.name;
    const timedOut = name === 'TimeoutError' || name === 'AbortError';
    logger.warn({ ...logFields, msg: timedOut ? 'upstream timeout' : 'upstream unreachable' });
    throw new HttpError(
      502,
      'upstream_error',
      timedOut
        ? `${spec.id} revocation endpoint did not respond in time`
        : `Could not reach the ${spec.id} revocation endpoint`,
    );
  }
  logFields.upstreamStatus = res.status;
  // Drain without inspecting; nothing from the body is surfaced.
  await res.body?.cancel().catch(() => undefined);

  if ((res.status >= 200 && res.status < 300) || res.status === 404 || res.status === 422) return;
  if (res.status === 401 || res.status === 403) {
    logger.error({ ...logFields, msg: 'upstream rejected broker client credentials' });
    throw new HttpError(502, 'broker_misconfigured', `${spec.id} rejected the broker's client credentials`);
  }
  throw new HttpError(502, 'upstream_error', `${spec.id} revocation endpoint returned HTTP ${res.status}`);
}

/** Create the broker HTTP server (not yet listening). */
export function createBroker(config: BrokerConfig, options: BrokerOptions = {}): Server {
  const fetchImpl: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const logger = createLogger(options.logSink);
  const limiter = new TokenBucketLimiter(config.rateLimit, options.now);
  const enabled = PROVIDER_IDS.filter((id) => isProviderEnabled(config, id));

  async function handle(req: IncomingMessage, res: ServerResponse, log: LogFields): Promise<void> {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://broker.invalid').pathname;
    } catch {
      throw new HttpError(400, 'invalid_request', 'Malformed request URL');
    }
    const route = matchRoute(pathname);

    if (route.kind === 'health') {
      log.route = '/healthz';
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        throw new HttpError(405, 'method_not_allowed', 'Use GET', { allow: 'GET, HEAD' });
      }
      sendJson(res, 200, { status: 'ok', providers: enabled });
      return;
    }
    if (route.kind === 'none') throw new HttpError(404, 'not_found', 'No such endpoint');

    log.route = `/${route.kind}/:provider`;
    if (isProviderId(route.provider)) log.provider = route.provider;

    // Browsers always send Origin on cross-origin requests; the desktop app calls from Node.
    if (req.headers.origin !== undefined || req.method === 'OPTIONS') {
      throw new HttpError(403, 'cors_denied', 'Browser (cross-origin) requests are not allowed');
    }
    if (req.method !== 'POST') {
      throw new HttpError(405, 'method_not_allowed', 'Use POST', { allow: 'POST' });
    }

    const decision = limiter.take(clientIp(req, config.trustProxy));
    if (!decision.allowed) {
      throw new HttpError(429, 'rate_limited', 'Too many requests; slow down', {
        'retry-after': String(decision.retryAfterSec),
      });
    }

    const contentType = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    if (contentType !== 'application/json') {
      throw new HttpError(415, 'unsupported_media_type', 'Content-Type must be application/json');
    }
    const declared = req.headers['content-length'];
    if (declared !== undefined && Number(declared) > config.maxBodyBytes) {
      throw new HttpError(413, 'payload_too_large', `Request body exceeds ${config.maxBodyBytes} bytes`);
    }
    const body = parseJson(await readBody(req, config.maxBodyBytes));

    if (!isProviderId(route.provider) || !isProviderEnabled(config, route.provider)) {
      throw new HttpError(404, 'unsupported_provider', 'This broker does not serve that provider');
    }
    const spec = PROVIDERS[route.provider];

    if (route.kind === 'revoke') {
      if (!spec.revoke) {
        throw new HttpError(501, 'unsupported', `${spec.id} has no token revocation API`);
      }
      const revoke = parseRevokeBody(body, spec);
      log.host = revoke.host;
      const revokeCreds = resolveCredentials(config, spec, revoke.host);
      if (!revokeCreds) {
        throw new HttpError(400, 'unknown_host', `This broker has no ${spec.id} OAuth app for that host`);
      }
      await revokeUpstream(fetchImpl, spec, revokeCreds, revoke.token, revoke.host, config, log, logger);
      sendJson(res, 200, { revoked: true });
      return;
    }

    const parsed = route.kind === 'token' ? parseExchangeBody(body, spec) : parseRefreshBody(body, spec);
    log.grant = parsed.grant.type;
    log.host = parsed.host;

    const creds = resolveCredentials(config, spec, parsed.host);
    if (!creds) {
      throw new HttpError(400, 'unknown_host', `This broker has no ${spec.id} OAuth app for that host`);
    }

    const result = await callUpstream(fetchImpl, spec, creds, parsed.grant, parsed.host, config, log, logger);
    sendJson(res, 200, result.response);
  }

  const server = createServer({ maxHeaderSize: 8 * 1024 }, (req, res) => {
    const started = process.hrtime.bigint();
    const log: LogFields = { msg: 'request', reqId: randomUUID(), method: req.method ?? '?' };
    res.setHeader('x-request-id', log.reqId!);

    res.on('finish', () => {
      // Container health probes would otherwise drown the log.
      if (log.route === '/healthz' && res.statusCode === 200) return;
      log.status = res.statusCode;
      log.durationMs = Number((process.hrtime.bigint() - started) / 1_000_000n);
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      logger[level]({ ...log, msg: 'request' });
    });

    handle(req, res, log).catch((err: unknown) => {
      if (err instanceof HttpError) {
        if (err.status === 413) {
          // Stop reading an oversized body; close the connection after replying.
          res.setHeader('connection', 'close');
          res.on('finish', () => req.destroy());
        }
        log.error = err.error;
        sendError(res, err);
        return;
      }
      log.error = 'server_error';
      logger.error({ msg: 'unhandled error', reqId: log.reqId, error: (err as Error)?.name ?? 'Error' });
      sendError(res, new HttpError(500, 'server_error', 'Internal error'));
    });
  });

  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;
  return server;
}
