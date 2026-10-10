/** Shared per-app services and the per-request context handed to route handlers. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { BlobStore } from './blob.ts';
import type { CloudConfig } from './config.ts';
import { type KeyMaterial, type TokenSigner, verifyJwt } from './crypto.ts';
import { HttpError, readJson, sendJson, unauthorized } from './http.ts';
import type { LogFields, Logger } from './logger.ts';
import type { Mailer } from './mail.ts';
import type { TokenBucketLimiter } from './rate-limit.ts';
import type { Store, UserRec } from './store/types.ts';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface AppCore {
  config: CloudConfig;
  store: Store;
  blobs: BlobStore;
  keys: KeyMaterial;
  signer: TokenSigner;
  logger: Logger;
  mailer: Mailer;
  fetch: FetchLike;
  /** Epoch milliseconds (injectable clock for tests). */
  now: () => number;
  userLimiter: TokenBucketLimiter;
}

export class Ctx {
  readonly app: AppCore;
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly ip: string;
  readonly log: LogFields;
  readonly url: URL;
  private cachedUser: UserRec | null | undefined;

  constructor(app: AppCore, req: IncomingMessage, res: ServerResponse, ip: string, log: LogFields) {
    this.app = app;
    this.req = req;
    this.res = res;
    this.ip = ip;
    this.log = log;
    this.url = new URL(req.url ?? '/', 'http://cloud.invalid');
  }

  get query(): URLSearchParams {
    return this.url.searchParams;
  }

  date(): Date {
    return new Date(this.app.now());
  }

  json(status: number, body: unknown, headers: Record<string, string> = {}): void {
    sendJson(this.res, status, body, headers);
  }

  body(): Promise<Record<string, unknown>> {
    return readJson(this.req, this.app.config.maxBodyBytes);
  }

  /** Authenticated user from the Bearer token; undefined when no Authorization header is present. */
  async optionalUser(): Promise<UserRec | undefined> {
    if (this.cachedUser !== undefined) return this.cachedUser ?? undefined;
    const header = this.req.headers.authorization;
    if (header === undefined) {
      this.cachedUser = null;
      return undefined;
    }
    const m = /^Bearer\s+([A-Za-z0-9._-]{1,4096})$/i.exec(header.trim());
    if (!m) throw unauthorized('Malformed Authorization header');
    const claims = verifyJwt(this.app.keys, m[1]!, this.app.config.publicUrl, this.app.now());
    if (!claims) throw unauthorized('Access token is invalid or expired');
    const user = await this.app.store.getUser(claims.sub);
    if (!user || user.deletedAt) throw unauthorized('Account not found');
    const decision = this.app.userLimiter.take(`u:${user.id}`);
    if (!decision.allowed) {
      throw new HttpError(429, 'rate_limited', 'Too many requests; slow down', {
        headers: { 'retry-after': String(decision.retryAfterSec) },
      });
    }
    this.log.userId = user.id;
    this.cachedUser = user;
    return user;
  }

  async user(): Promise<UserRec> {
    const user = await this.optionalUser();
    if (!user) throw unauthorized();
    return user;
  }
}
