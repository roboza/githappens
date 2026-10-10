/**
 * GitHappens Cloud configuration (`GH_CLOUD_*` environment variables), validated up front so a
 * misconfigured deployment fails at boot (exit 78) instead of on the first sign-in.
 */
import type { IdpId } from '@githappens/cloud-api/types';
import type { S3Config } from './s3.ts';

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

export interface RateLimitConfig {
  /** Bucket size: the burst a single key may send. */
  capacity: number;
  /** Tokens added back per minute. */
  refillPerMinute: number;
}

export type MailTransport = 'none' | 'log' | 'webhook';

export interface CloudConfig {
  port: number;
  host: string;
  /** Origin used for every absolute URL the server hands out (no trailing slash). */
  publicUrl: string;
  /** Postgres connection string; undefined → in-memory store (development only). */
  databaseUrl?: string;
  /** Holds the generated JWT key / server secret when they are not given via env. */
  dataDir: string;
  blobDir: string;
  /** S3-compatible blob storage (`GH_CLOUD_S3_*`); undefined → files under `blobDir`. */
  s3?: S3Config;
  /** PEM (PKCS#8) Ed25519 private key that signs access tokens. Generated + persisted when absent. */
  jwtPrivateKeyPem?: string;
  /** Extra PEM public keys still accepted for verification (key rotation). */
  jwtPreviousPublicKeysPem: string[];
  /** HMAC / at-rest encryption secret. Generated + persisted when absent. */
  secret?: string;
  github?: OAuthClient;
  gitlab?: OAuthClient & { baseUrl: string };
  google?: OAuthClient;
  mailTransport: MailTransport;
  mailWebhook?: string;
  devLogin: boolean;
  patchMaxBytes: number;
  /** Server-wide cap on patch expiry; null = none. */
  patchMaxExpiryDays: number | null;
  syncMaxBytes: number;
  maxBodyBytes: number;
  rateLimitIp: RateLimitConfig;
  rateLimitUser: RateLimitConfig;
  /** Stricter per-IP bucket for /oauth/* (sign-in, token, magic link). */
  rateLimitAuth: RateLimitConfig;
  trustProxy: boolean;
  /** Background job interval in seconds; 0 disables the timer (jobs can still be run manually). */
  jobIntervalSec: number;
}

export class ConfigError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Invalid GitHappens Cloud configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

export const MB = 1024 * 1024;

export const DEFAULTS = {
  port: 8787,
  host: '0.0.0.0',
  dataDir: './data',
  patchMaxBytes: 25 * MB,
  syncMaxBytes: 1 * MB,
  maxBodyBytes: 2 * MB,
  rateIpPerMin: 600,
  rateUserPerMin: 1200,
  rateAuthPerMin: 30,
  jobIntervalSec: 3600,
} as const;

type Env = Record<string, string | undefined>;

function str(env: Env, key: string): string | undefined {
  const v = env[key]?.trim();
  return v ? v : undefined;
}

function int(env: Env, key: string, def: number, min: number, max: number, issues: string[]): number {
  const raw = str(env, key);
  if (raw === undefined) return def;
  if (!/^\d+$/.test(raw)) {
    issues.push(`${key} must be an integer`);
    return def;
  }
  const n = Number(raw);
  if (n < min || n > max) issues.push(`${key} must be between ${min} and ${max}`);
  return n;
}

function bool(env: Env, key: string, issues: string[]): boolean {
  const raw = str(env, key);
  if (raw === undefined) return false;
  if (/^(1|true|yes|on)$/i.test(raw)) return true;
  if (/^(0|false|no|off)$/i.test(raw)) return false;
  issues.push(`${key} must be true/false`);
  return false;
}

function client(env: Env, prefix: string, issues: string[]): OAuthClient | undefined {
  const clientId = str(env, `${prefix}_CLIENT_ID`);
  const clientSecret = str(env, `${prefix}_CLIENT_SECRET`);
  if (!clientId && !clientSecret) return undefined;
  if (!clientId || !clientSecret) {
    issues.push(`${prefix}_CLIENT_ID and ${prefix}_CLIENT_SECRET must be set together`);
    return undefined;
  }
  if (!/^[\x21-\x7e]{1,256}$/.test(clientId)) issues.push(`${prefix}_CLIENT_ID contains invalid characters`);
  return { clientId, clientSecret };
}

function httpUrl(value: string, key: string, issues: string[], originOnly: boolean): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    issues.push(`${key} is not a valid URL`);
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    issues.push(`${key} must be an http(s) URL`);
    return undefined;
  }
  if (url.username || url.password || url.search || url.hash) {
    issues.push(`${key} must not contain credentials, a query or a fragment`);
    return undefined;
  }
  if (originOnly && url.pathname !== '/') {
    issues.push(`${key} must be an origin without a path (serve the cloud at the root of its host)`);
    return undefined;
  }
  return originOnly ? url.origin : url.toString().replace(/\/$/, '');
}

function splitPems(raw: string | undefined): string[] {
  if (!raw) return [];
  const pems = raw.replace(/\\n/g, '\n').match(/-----BEGIN [A-Z ]+-----[\s\S]+?-----END [A-Z ]+-----/g);
  return pems ?? [];
}

/** True for hosts where plain http is acceptable (local development). */
export function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

/** Build and validate the config. Throws {@link ConfigError} listing every problem found. */
export function loadConfig(env: Env = process.env, argv: string[] = []): CloudConfig {
  const issues: string[] = [];
  const dev = argv.includes('--dev');

  const port = int(env, 'GH_CLOUD_PORT', int(env, 'PORT', DEFAULTS.port, 0, 65535, issues), 0, 65535, issues);
  const publicRaw = str(env, 'GH_CLOUD_PUBLIC_URL') ?? `http://localhost:${port}`;
  const publicUrl = httpUrl(publicRaw, 'GH_CLOUD_PUBLIC_URL', issues, true) ?? `http://localhost:${port}`;

  const databaseUrl = str(env, 'GH_CLOUD_DATABASE_URL') ?? str(env, 'DATABASE_URL');
  if (databaseUrl && !/^postgres(?:ql)?:\/\//.test(databaseUrl)) {
    issues.push('GH_CLOUD_DATABASE_URL must be a postgres:// connection string');
  }

  const dataDir = str(env, 'GH_CLOUD_DATA_DIR') ?? DEFAULTS.dataDir;
  const blobDir = str(env, 'GH_CLOUD_BLOB_DIR') ?? `${dataDir.replace(/[\\/]+$/, '')}/blobs`;

  const s3 = s3Config(env, issues);

  const jwtKeys = splitPems(str(env, 'GH_CLOUD_JWT_KEY'));
  if (str(env, 'GH_CLOUD_JWT_KEY') && jwtKeys.length !== 1) {
    issues.push('GH_CLOUD_JWT_KEY must contain exactly one PEM private key');
  }
  const previous = splitPems(str(env, 'GH_CLOUD_JWT_PREVIOUS_KEYS'));

  const secret = str(env, 'GH_CLOUD_SECRET');
  if (secret !== undefined && secret.length < 32)
    issues.push('GH_CLOUD_SECRET must be at least 32 characters');

  const github = client(env, 'GH_CLOUD_GITHUB', issues);
  const gitlabClient = client(env, 'GH_CLOUD_GITLAB', issues);
  const gitlabBase = httpUrl(
    str(env, 'GH_CLOUD_GITLAB_URL') ?? 'https://gitlab.com',
    'GH_CLOUD_GITLAB_URL',
    issues,
    false,
  );
  const google = client(env, 'GH_CLOUD_GOOGLE', issues);

  const mailRaw = (str(env, 'GH_CLOUD_MAIL_TRANSPORT') ?? (dev ? 'log' : 'none')).toLowerCase();
  let mailTransport: MailTransport = 'none';
  if (mailRaw === 'none' || mailRaw === 'log' || mailRaw === 'webhook') mailTransport = mailRaw;
  else issues.push('GH_CLOUD_MAIL_TRANSPORT must be none, log or webhook');
  const mailWebhookRaw = str(env, 'GH_CLOUD_MAIL_WEBHOOK');
  const mailWebhook = mailWebhookRaw
    ? httpUrl(mailWebhookRaw, 'GH_CLOUD_MAIL_WEBHOOK', issues, false)
    : undefined;
  if (mailTransport === 'webhook' && !mailWebhook) {
    issues.push('GH_CLOUD_MAIL_WEBHOOK is required when GH_CLOUD_MAIL_TRANSPORT=webhook');
  }

  const devLogin = dev || bool(env, 'GH_CLOUD_DEV_LOGIN', issues);

  const expiryRaw = str(env, 'GH_CLOUD_PATCH_MAX_EXPIRY_DAYS');
  const patchMaxExpiryDays =
    expiryRaw === undefined ? null : int(env, 'GH_CLOUD_PATCH_MAX_EXPIRY_DAYS', 30, 1, 3650, issues);

  const perMin = (key: string, def: number): RateLimitConfig => {
    const n = int(env, key, def, 1, 1_000_000, issues);
    return { capacity: n, refillPerMinute: n };
  };

  const config: CloudConfig = {
    port,
    host: str(env, 'GH_CLOUD_HOST') ?? DEFAULTS.host,
    publicUrl,
    databaseUrl,
    dataDir,
    blobDir,
    s3,
    jwtPrivateKeyPem: jwtKeys[0],
    jwtPreviousPublicKeysPem: previous,
    secret,
    github,
    gitlab: gitlabClient && gitlabBase ? { ...gitlabClient, baseUrl: gitlabBase } : undefined,
    google,
    mailTransport,
    mailWebhook,
    devLogin,
    patchMaxBytes: int(env, 'GH_CLOUD_PATCH_MAX_BYTES', DEFAULTS.patchMaxBytes, 1024, 1024 * MB, issues),
    patchMaxExpiryDays,
    syncMaxBytes: int(env, 'GH_CLOUD_SYNC_MAX_BYTES', DEFAULTS.syncMaxBytes, 1024, 64 * MB, issues),
    maxBodyBytes: int(env, 'GH_CLOUD_MAX_BODY_BYTES', DEFAULTS.maxBodyBytes, 16 * 1024, 128 * MB, issues),
    rateLimitIp: perMin('GH_CLOUD_RATE_IP_PER_MIN', DEFAULTS.rateIpPerMin),
    rateLimitUser: perMin('GH_CLOUD_RATE_USER_PER_MIN', DEFAULTS.rateUserPerMin),
    rateLimitAuth: perMin('GH_CLOUD_RATE_AUTH_PER_MIN', DEFAULTS.rateAuthPerMin),
    trustProxy: bool(env, 'GH_CLOUD_TRUST_PROXY', issues),
    jobIntervalSec: int(env, 'GH_CLOUD_JOB_INTERVAL_SEC', DEFAULTS.jobIntervalSec, 0, 7 * 86400, issues),
  };

  // Sync ciphertext travels base64url inside JSON: make sure the body limit can carry the item limit.
  if (Math.ceil((config.syncMaxBytes * 4) / 3) + 4096 > config.maxBodyBytes) {
    issues.push('GH_CLOUD_MAX_BODY_BYTES must be at least 4/3 × GH_CLOUD_SYNC_MAX_BYTES + 4 KB');
  }
  if (enabledIdps(config).length === 0) {
    issues.push(
      'no identity provider configured: set GH_CLOUD_GITHUB_*, GH_CLOUD_GITLAB_*, GH_CLOUD_GOOGLE_*, ' +
        'GH_CLOUD_MAIL_TRANSPORT (email magic link) or GH_CLOUD_DEV_LOGIN=1',
    );
  }

  if (issues.length > 0) throw new ConfigError(issues);
  return config;
}

/**
 * `GH_CLOUD_S3_ENDPOINT`, `_BUCKET`, `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY` (required together),
 * `_REGION` (us-east-1), `_SESSION_TOKEN`, `_FORCE_PATH_STYLE` (true), `_PREFIX` (patches/),
 * `_DIRECT` (false: clients upload/download through this server).
 */
function s3Config(env: Env, issues: string[]): S3Config | undefined {
  const endpointRaw = str(env, 'GH_CLOUD_S3_ENDPOINT');
  const bucket = str(env, 'GH_CLOUD_S3_BUCKET');
  const accessKeyId = str(env, 'GH_CLOUD_S3_ACCESS_KEY_ID');
  const secretAccessKey = str(env, 'GH_CLOUD_S3_SECRET_ACCESS_KEY');
  if (!endpointRaw && !bucket && !accessKeyId && !secretAccessKey) return undefined;
  if (!endpointRaw || !bucket || !accessKeyId || !secretAccessKey) {
    issues.push(
      'GH_CLOUD_S3_ENDPOINT, GH_CLOUD_S3_BUCKET, GH_CLOUD_S3_ACCESS_KEY_ID and GH_CLOUD_S3_SECRET_ACCESS_KEY must be set together',
    );
    return undefined;
  }
  const endpoint = httpUrl(endpointRaw, 'GH_CLOUD_S3_ENDPOINT', issues, true);
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket))
    issues.push('GH_CLOUD_S3_BUCKET is not a valid bucket name');
  const region = str(env, 'GH_CLOUD_S3_REGION') ?? 'us-east-1';
  if (!/^[a-z0-9-]{1,40}$/.test(region)) issues.push('GH_CLOUD_S3_REGION is malformed');
  const prefix = str(env, 'GH_CLOUD_S3_PREFIX') ?? 'patches/';
  if (!/^[A-Za-z0-9!_.*'()/-]{0,200}$/.test(prefix) || prefix.startsWith('/'))
    issues.push('GH_CLOUD_S3_PREFIX may only contain safe key characters and must not start with "/"');
  const pathStyleRaw = str(env, 'GH_CLOUD_S3_FORCE_PATH_STYLE');
  const sessionToken = str(env, 'GH_CLOUD_S3_SESSION_TOKEN');
  if (!endpoint) return undefined;
  return {
    endpoint,
    bucket,
    region,
    accessKeyId,
    secretAccessKey,
    ...(sessionToken ? { sessionToken } : {}),
    forcePathStyle: pathStyleRaw === undefined ? true : bool(env, 'GH_CLOUD_S3_FORCE_PATH_STYLE', issues),
    prefix,
    direct: bool(env, 'GH_CLOUD_S3_DIRECT', issues),
  };
}

/** Identity providers this server offers, in display order. */
export function enabledIdps(config: CloudConfig): IdpId[] {
  const out: IdpId[] = [];
  if (config.github) out.push('github');
  if (config.gitlab) out.push('gitlab');
  if (config.google) out.push('google');
  if (config.mailTransport !== 'none') out.push('email');
  if (config.devLogin) out.push('dev');
  return out;
}

/** Fill in defaults for a partially specified config (tests and embedding). */
export function makeConfig(partial: Partial<CloudConfig> = {}): CloudConfig {
  const rate = (n: number): RateLimitConfig => ({ capacity: n, refillPerMinute: n });
  return {
    port: 0,
    host: '127.0.0.1',
    publicUrl: 'http://localhost:8787',
    dataDir: DEFAULTS.dataDir,
    blobDir: `${DEFAULTS.dataDir}/blobs`,
    jwtPreviousPublicKeysPem: [],
    mailTransport: 'none',
    devLogin: false,
    patchMaxBytes: DEFAULTS.patchMaxBytes,
    patchMaxExpiryDays: null,
    syncMaxBytes: DEFAULTS.syncMaxBytes,
    maxBodyBytes: DEFAULTS.maxBodyBytes,
    rateLimitIp: rate(DEFAULTS.rateIpPerMin),
    rateLimitUser: rate(DEFAULTS.rateUserPerMin),
    rateLimitAuth: rate(DEFAULTS.rateAuthPerMin),
    trustProxy: false,
    jobIntervalSec: 0,
    ...partial,
  };
}
