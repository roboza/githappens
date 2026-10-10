/**
 * GitHappens Cloud HTTP server (spec 14 §5): wires config, store, blob store, keys and routes into
 * a node:http server. No request bodies, query strings, raw paths or tokens are ever logged.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { BlobStore } from './blob.ts';
import type { CloudConfig } from './config.ts';
import { type AppCore, Ctx, type FetchLike } from './context.ts';
import { type KeyMaterial, TokenSigner } from './crypto.ts';
import { HttpError, Router, sendError } from './http.ts';
import { runJobs, scheduleJobs, type JobReport } from './jobs.ts';
import { createLogger, type LogFields, type LogSink } from './logger.ts';
import { createMailer, type Mailer } from './mail.ts';
import { TokenBucketLimiter } from './rate-limit.ts';
import { registerAccount } from './routes/account.ts';
import { registerFootprints } from './routes/footprints.ts';
import { registerOAuth } from './routes/oauth.ts';
import { registerOpenApi } from './routes/openapi.ts';
import { registerOrgs } from './routes/orgs.ts';
import { registerPatches } from './routes/patches.ts';
import { registerSuggestions } from './routes/suggestions.ts';
import { registerSync } from './routes/sync.ts';
import { registerWorkspaces } from './routes/workspaces.ts';
import type { Store } from './store/types.ts';

export const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

export interface CloudDeps {
  store: Store;
  blobs: BlobStore;
  keys: KeyMaterial;
  /** Upstream HTTP (IdP federation, mail webhook). Defaults to global fetch. */
  fetch?: FetchLike;
  mailer?: Mailer;
  logSink?: LogSink;
  /** Epoch-ms clock (tests). */
  now?: () => number;
}

export interface CloudApp {
  server: Server;
  core: AppCore;
  runJobs(): Promise<JobReport>;
  /** Start the periodic job timer (index.ts); returns a stop function. */
  startJobs(): () => void;
}

function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    const value = Array.isArray(xff) ? xff.join(',') : xff;
    const last = value
      ?.split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .pop();
    if (last) return last;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

export function createCloudApp(config: CloudConfig, deps: CloudDeps): CloudApp {
  const now = deps.now ?? Date.now;
  const fetchImpl: FetchLike = deps.fetch ?? ((url, init) => fetch(url, init));
  const logger = createLogger(deps.logSink);
  const core: AppCore = {
    config,
    store: deps.store,
    blobs: deps.blobs,
    keys: deps.keys,
    signer: new TokenSigner(deps.keys.secret),
    logger,
    mailer: deps.mailer ?? createMailer(config, fetchImpl),
    fetch: fetchImpl,
    now,
    userLimiter: new TokenBucketLimiter(config.rateLimitUser, now),
  };
  const ipLimiter = new TokenBucketLimiter(config.rateLimitIp, now);
  const authLimiter = new TokenBucketLimiter(config.rateLimitAuth, now);

  const router = new Router<Ctx>();
  registerOAuth(router, VERSION);
  registerAccount(router);
  registerSync(router);
  registerWorkspaces(router);
  registerOrgs(router);
  registerPatches(router);
  registerFootprints(router);
  registerSuggestions(router);
  registerOpenApi(router);

  async function handle(ctx: Ctx): Promise<void> {
    const path = ctx.url.pathname;
    const method = ctx.req.method ?? 'GET';
    if (path !== '/healthz') {
      const ipDecision = ipLimiter.take(`ip:${ctx.ip}`);
      const authDecision =
        path.startsWith('/oauth/') && method === 'POST' ? authLimiter.take(`auth:${ctx.ip}`) : undefined;
      const denied = !ipDecision.allowed
        ? ipDecision
        : authDecision && !authDecision.allowed
          ? authDecision
          : undefined;
      if (denied) {
        throw new HttpError(429, 'rate_limited', 'Too many requests; slow down', {
          headers: { 'retry-after': String(denied.retryAfterSec) },
        });
      }
    }
    // CORS is not offered: no Access-Control-* headers anywhere, so preflights (OPTIONS) end in 405.
    const found = router.match(method, path);
    if (!found) {
      ctx.log.route = '(unmatched)';
      throw new HttpError(404, 'not_found', 'No such endpoint');
    }
    if ('allowed' in found) {
      ctx.log.route = '(method)';
      throw new HttpError(405, 'not_found', 'Method not allowed', {
        headers: { allow: found.allowed.join(', ') },
      });
    }
    ctx.log.route = found.route.pattern;
    await found.route.handler(ctx, found.params);
  }

  const server = createServer({ maxHeaderSize: 16 * 1024 }, (req, res) => {
    const started = process.hrtime.bigint();
    const log: LogFields = { msg: 'request', reqId: randomUUID(), method: req.method ?? '?' };
    res.setHeader('x-request-id', log.reqId!);
    if (config.publicUrl.startsWith('https:')) {
      res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
    }
    res.on('finish', () => {
      if (log.route === '/healthz' && res.statusCode === 200) return;
      log.status = res.statusCode;
      log.durationMs = Number((process.hrtime.bigint() - started) / 1_000_000n);
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      logger[level]({ ...log, msg: 'request' });
    });

    let ctx: Ctx;
    try {
      ctx = new Ctx(core, req, res, clientIp(req, config.trustProxy), log);
    } catch {
      sendError(res, new HttpError(400, 'validation', 'Malformed request URL'));
      return;
    }
    handle(ctx).catch((err: unknown) => {
      if (err instanceof HttpError) {
        if (err.status === 413) {
          // Stop reading an oversized body; close the connection after replying.
          res.setHeader('connection', 'close');
          res.on('finish', () => req.destroy());
        }
        log.error = err.code;
        if (res.headersSent) res.destroy();
        else sendError(res, err);
        return;
      }
      log.error = 'server';
      logger.error({
        msg: 'unhandled error',
        reqId: log.reqId,
        route: log.route,
        error: (err as Error)?.name ?? 'Error',
      });
      if (res.headersSent) res.destroy();
      else sendError(res, new HttpError(500, 'server', 'Internal error'));
    });
  });

  server.requestTimeout = 120_000; // patch uploads up to the size limit
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;

  return {
    server,
    core,
    runJobs: () => runJobs(core),
    startJobs: () => scheduleJobs(core, config.jobIntervalSec),
  };
}
