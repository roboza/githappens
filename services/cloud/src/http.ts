/** Small HTTP toolkit on top of node:http: errors in the contract's `ApiError` shape, body reading, routing. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiError } from '@githappens/cloud-api/types';

export class HttpError extends Error {
  readonly status: number;
  readonly code: ApiError['error'];
  readonly headers: Record<string, string>;
  readonly extra: Record<string, unknown>;
  constructor(
    status: number,
    code: ApiError['error'],
    message: string,
    opts: { headers?: Record<string, string>; extra?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.headers = opts.headers ?? {};
    this.extra = opts.extra ?? {};
  }
}

export const invalid = (message: string): HttpError => new HttpError(422, 'validation', message);
export const notFound = (what = 'Not found'): HttpError => new HttpError(404, 'not_found', what);
export const forbidden = (message = 'Forbidden'): HttpError => new HttpError(403, 'forbidden', message);
export const unauthorized = (message = 'Sign-in required'): HttpError =>
  new HttpError(401, 'unauthorized', message, { headers: { 'www-authenticate': 'Bearer' } });
export const conflict = (message: string): HttpError => new HttpError(409, 'conflict', message);
export const gone = (message: string): HttpError => new HttpError(410, 'gone', message);
export const tooLarge = (message: string): HttpError => new HttpError(413, 'too_large', message);
export const preconditionFailed = (currentVersion: number): HttpError =>
  new HttpError(412, 'precondition_failed', 'Version mismatch', { extra: { currentVersion } });

export const SECURITY_HEADERS: Record<string, string> = {
  'cache-control': 'no-store',
  pragma: 'no-cache',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-resource-policy': 'same-origin',
};

export const API_CSP = "default-src 'none'; frame-ancestors 'none'";

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  if (res.headersSent) return;
  if (status === 204) {
    res.writeHead(204, { ...SECURITY_HEADERS, 'content-security-policy': API_CSP, ...headers });
    res.end();
    return;
  }
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'content-security-policy': API_CSP,
    ...headers,
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function sendError(res: ServerResponse, err: HttpError): void {
  const body: ApiError & Record<string, unknown> = { error: err.code, message: err.message, ...err.extra };
  sendJson(res, err.status, body, err.headers);
}

export function sendHtml(
  res: ServerResponse,
  status: number,
  html: string,
  csp: string,
  headers: Record<string, string> = {},
): void {
  if (res.headersSent) return;
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    ...headers,
    'content-security-policy': csp,
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
  });
  res.end(html);
}

export function redirect(
  res: ServerResponse,
  location: string,
  headers: Record<string, string | string[]> = {},
): void {
  if (res.headersSent) return;
  res.writeHead(302, { ...SECURITY_HEADERS, ...headers, location, 'content-length': 0 });
  res.end();
}

/** Read the whole body, enforcing `limit` bytes (declared and actual). */
export function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = req.headers['content-length'];
  if (declared !== undefined && Number(declared) > limit) {
    return Promise.reject(tooLarge(`Request body exceeds ${limit} bytes`));
  }
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
        fail(tooLarge(`Request body exceeds ${limit} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', () => fail(invalid('Request stream error')));
  });
}

function mediaType(req: IncomingMessage): string {
  return (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
}

/** JSON body (object). Empty body → `{}` when `allowEmpty`. */
export async function readJson(
  req: IncomingMessage,
  limit: number,
  allowEmpty = false,
): Promise<Record<string, unknown>> {
  const buf = await readBody(req, limit);
  if (buf.length === 0) {
    if (allowEmpty) return {};
    throw invalid('Request body is empty');
  }
  if (mediaType(req) !== 'application/json') throw invalid('Content-Type must be application/json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(buf.toString('utf8'));
  } catch {
    throw invalid('Request body is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw invalid('Request body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/** JSON or `application/x-www-form-urlencoded` body as a flat string map / object (OAuth endpoints, HTML forms). */
export async function readFormOrJson(req: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  const type = mediaType(req);
  if (type === 'application/x-www-form-urlencoded') {
    const buf = await readBody(req, limit);
    const out: Record<string, unknown> = {};
    for (const [k, v] of new URLSearchParams(buf.toString('utf8'))) out[k] = v;
    return out;
  }
  return readJson(req, limit, true);
}

// ---- routing ------------------------------------------------------------------------------------

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RouteDef<C> {
  method: Method;
  pattern: string;
  handler: (ctx: C, params: Record<string, string>) => Promise<void>;
}

interface Compiled<C> extends RouteDef<C> {
  re: RegExp;
  keys: string[];
}

export class Router<C> {
  private routes: Compiled<C>[] = [];

  add(method: Method, pattern: string, handler: RouteDef<C>['handler']): this {
    const keys: string[] = [];
    const re = new RegExp(
      `^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:(\w+)/g, (_m, k: string) => {
        keys.push(k);
        return '([^/]+)';
      })}/?$`,
    );
    this.routes.push({ method, pattern, handler, re, keys });
    return this;
  }

  /** Registered routes (OpenAPI coverage test). */
  list(): Array<{ method: Method; pattern: string }> {
    return this.routes.map((r) => ({ method: r.method, pattern: r.pattern }));
  }

  /** `undefined` = no such path; `{ allowed }` = path exists but not for this method. */
  match(
    method: string,
    path: string,
  ): { route: RouteDef<C>; params: Record<string, string> } | { allowed: string[] } | undefined {
    const allowed: string[] = [];
    for (const r of this.routes) {
      const m = r.re.exec(path);
      if (!m) continue;
      if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) {
        allowed.push(r.method);
        continue;
      }
      const params: Record<string, string> = {};
      try {
        r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]!)));
      } catch {
        return undefined;
      }
      return { route: r, params };
    }
    return allowed.length ? { allowed } : undefined;
  }
}
