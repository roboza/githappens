/** Strict request-body validation. Everything the broker forwards upstream passes through here. */
import { isValidHost } from './config.ts';
import { type Grant, type ProviderSpec } from './providers.ts';

export class HttpError extends Error {
  readonly status: number;
  readonly error: string;
  readonly description: string;
  readonly headers: Record<string, string>;
  constructor(status: number, error: string, description: string, headers: Record<string, string> = {}) {
    super(`${error}: ${description}`);
    this.name = 'HttpError';
    this.status = status;
    this.error = error;
    this.description = description;
    this.headers = headers;
  }
}

const invalid = (description: string): HttpError => new HttpError(400, 'invalid_request', description);

const PRINTABLE = /^[\x21-\x7e]+$/;
/** RFC 7636 §4.1 */
const CODE_VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
const SCOPE = /^[\x21\x23-\x5b\x5d-\x7e]+(?: [\x21\x23-\x5b\x5d-\x7e]+)*$/;

const MAX_CODE = 2048;
const MAX_REFRESH_TOKEN = 4096;
const MAX_REDIRECT_URI = 2048;
const MAX_SCOPE = 1024;

/**
 * Only native-app redirect URIs (RFC 8252) are allowed: the IPv4 loopback with an explicit port
 * (`http://127.0.0.1:<port>/...`) or the app's private-use scheme (`githappens://...`).
 */
export function isAllowedRedirectUri(value: string): boolean {
  if (value.length > MAX_REDIRECT_URI || !PRINTABLE.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password || url.hash || value.includes('#')) return false;
  if (url.protocol === 'githappens:') {
    return /^githappens:\/\/[a-z0-9-]+(?:\/|$)/i.test(value);
  }
  if (url.protocol === 'http:') {
    const m = /^http:\/\/127\.0\.0\.1:(\d{1,5})\//.exec(value);
    if (!m || url.hostname !== '127.0.0.1') return false;
    const port = Number(m[1]);
    return port >= 1 && port <= 65535 && url.port === String(port);
  }
  return false;
}

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalid('Request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

function rejectUnknown(obj: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) throw invalid(`Unknown field "${key.slice(0, 64)}"`);
  }
}

function requiredString(obj: Record<string, unknown>, key: string, max: number): string {
  const v = obj[key];
  if (v === undefined || v === null || v === '') throw invalid(`Missing required field "${key}"`);
  if (typeof v !== 'string') throw invalid(`Field "${key}" must be a string`);
  if (v.length > max || !PRINTABLE.test(v)) throw invalid(`Field "${key}" is malformed`);
  return v;
}

function optionalString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw invalid(`Field "${key}" must be a string`);
  return v;
}

function parseHost(obj: Record<string, unknown>, spec: ProviderSpec): string {
  const raw = optionalString(obj, 'host');
  if (raw === undefined) return spec.defaultHost;
  const host = raw.toLowerCase();
  if (!isValidHost(host)) throw invalid('Field "host" must be a bare hostname, optionally with :port');
  return host;
}

function parseScope(obj: Record<string, unknown>): string | undefined {
  const scope = optionalString(obj, 'scope');
  if (scope === undefined) return undefined;
  if (scope.length === 0 || scope.length > MAX_SCOPE || !SCOPE.test(scope)) {
    throw invalid('Field "scope" is malformed');
  }
  return scope;
}

export interface ParsedRequest {
  grant: Grant;
  host: string;
}

export function parseExchangeBody(body: unknown, spec: ProviderSpec): ParsedRequest {
  const obj = asObject(body);
  const allowed = ['code', 'code_verifier', 'redirect_uri'];
  if (spec.multiHost) allowed.push('host');
  if (spec.acceptsScope) allowed.push('scope');
  rejectUnknown(obj, allowed);

  const code = requiredString(obj, 'code', MAX_CODE);
  const redirectUri = requiredString(obj, 'redirect_uri', MAX_REDIRECT_URI);
  if (!isAllowedRedirectUri(redirectUri)) {
    throw new HttpError(
      400,
      'invalid_redirect_uri',
      'redirect_uri must be http://127.0.0.1:<port>/... (loopback) or githappens://...',
    );
  }
  const codeVerifier = optionalString(obj, 'code_verifier');
  if (codeVerifier !== undefined && !CODE_VERIFIER.test(codeVerifier)) {
    throw invalid('Field "code_verifier" must be 43-128 characters of [A-Za-z0-9-._~] (RFC 7636)');
  }
  const host = parseHost(obj, spec);
  const scope = spec.acceptsScope ? parseScope(obj) : undefined;

  const grant: Grant = { type: 'authorization_code', code, redirectUri };
  if (codeVerifier !== undefined) grant.codeVerifier = codeVerifier;
  if (scope !== undefined) grant.scope = scope;
  return { grant, host };
}

export function parseRefreshBody(body: unknown, spec: ProviderSpec): ParsedRequest {
  const obj = asObject(body);
  const allowed = ['refresh_token'];
  if (spec.multiHost) allowed.push('host');
  if (spec.acceptsScope) allowed.push('scope');
  rejectUnknown(obj, allowed);

  const refreshToken = requiredString(obj, 'refresh_token', MAX_REFRESH_TOKEN);
  const host = parseHost(obj, spec);
  const scope = spec.acceptsScope ? parseScope(obj) : undefined;

  const grant: Grant = { type: 'refresh_token', refreshToken };
  if (scope !== undefined) grant.scope = scope;
  return { grant, host };
}

export interface ParsedRevokeRequest {
  token: string;
  host: string;
}

export function parseRevokeBody(body: unknown, spec: ProviderSpec): ParsedRevokeRequest {
  const obj = asObject(body);
  const allowed = ['token'];
  if (spec.multiHost) allowed.push('host');
  rejectUnknown(obj, allowed);

  const token = requiredString(obj, 'token', MAX_REFRESH_TOKEN);
  const host = parseHost(obj, spec);
  return { token, host };
}
