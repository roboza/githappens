/**
 * Broker configuration, loaded from environment variables and validated up front so a
 * misconfigured deployment fails at boot rather than on the first user's sign-in.
 */

export const PROVIDER_IDS = ['github', 'gitlab', 'bitbucket', 'atlassian', 'azure-devops'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface ClientCredentials {
  clientId: string;
  /** Optional only for providers that accept public clients (GitLab, Azure DevOps / Entra ID). */
  clientSecret?: string;
}

export interface RateLimitConfig {
  /** Bucket size: the burst a single IP may send. */
  capacity: number;
  /** Tokens added back per minute. */
  refillPerMinute: number;
}

export interface BrokerConfig {
  port: number;
  host: string;
  /** Default-host credentials per provider (github.com, gitlab.com, bitbucket.org, …). */
  providers: Partial<Record<ProviderId, ClientCredentials>>;
  /** GitHub Enterprise Server: hostname (optionally :port) → that instance's OAuth app. */
  gheHosts: Record<string, ClientCredentials>;
  /** GitLab self-managed: hostname (optionally :port) → that instance's OAuth application. */
  gitlabHosts: Record<string, ClientCredentials>;
  /** Entra ID tenant for Azure DevOps; `organizations` = any work/school account. */
  azureTenant: string;
  upstreamTimeoutMs: number;
  maxBodyBytes: number;
  rateLimit: RateLimitConfig;
  /** When behind a reverse proxy (Fly.io, Render, …) take the client IP from X-Forwarded-For. */
  trustProxy: boolean;
}

export class ConfigError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Invalid oauth-broker configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

export const DEFAULTS = {
  port: 8080,
  host: '0.0.0.0',
  azureTenant: 'organizations',
  upstreamTimeoutMs: 10_000,
  maxBodyBytes: 8 * 1024,
  rateLimit: { capacity: 20, refillPerMinute: 20 },
} as const;

const HOST_RE =
  /^(?=.{1,253}(?::\d{1,5})?$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::\d{1,5})?$/;
const CLIENT_ID_RE = /^[\x21-\x7e]{1,256}$/;
const TENANT_RE =
  /^(?:common|organizations|consumers|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9-]+(?:\.[a-z0-9-]+)+)$/i;

export function isValidHost(host: string): boolean {
  return HOST_RE.test(host);
}

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
  if (/^(1|true|yes)$/i.test(raw)) return true;
  if (/^(0|false|no)$/i.test(raw)) return false;
  issues.push(`${key} must be true/false`);
  return false;
}

function creds(
  env: Env,
  prefix: string,
  secretRequired: boolean,
  issues: string[],
): ClientCredentials | undefined {
  const clientId = str(env, `${prefix}_CLIENT_ID`);
  const clientSecret = str(env, `${prefix}_CLIENT_SECRET`);
  if (!clientId) {
    if (clientSecret) issues.push(`${prefix}_CLIENT_SECRET is set but ${prefix}_CLIENT_ID is missing`);
    return undefined;
  }
  if (!CLIENT_ID_RE.test(clientId)) issues.push(`${prefix}_CLIENT_ID contains invalid characters`);
  if (secretRequired && !clientSecret) {
    issues.push(`${prefix}_CLIENT_SECRET is required when ${prefix}_CLIENT_ID is set`);
  }
  return clientSecret ? { clientId, clientSecret } : { clientId };
}

function hostMap(
  env: Env,
  key: string,
  secretRequired: boolean,
  issues: string[],
): Record<string, ClientCredentials> {
  const raw = str(env, key);
  if (raw === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    issues.push(`${key} is not valid JSON`);
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    issues.push(`${key} must be a JSON object of {"host": {"clientId": "...", "clientSecret": "..."}}`);
    return {};
  }
  const out: Record<string, ClientCredentials> = Object.create(null) as Record<string, ClientCredentials>;
  for (const [rawHost, value] of Object.entries(parsed as Record<string, unknown>)) {
    const host = rawHost.toLowerCase();
    if (!isValidHost(host)) {
      issues.push(`${key}: "${rawHost}" is not a valid hostname`);
      continue;
    }
    const v = value as Record<string, unknown> | null;
    const clientId = typeof v?.clientId === 'string' ? v.clientId.trim() : '';
    const clientSecret = typeof v?.clientSecret === 'string' ? v.clientSecret.trim() : '';
    if (!clientId || !CLIENT_ID_RE.test(clientId)) {
      issues.push(`${key}: "${host}" needs a valid clientId`);
      continue;
    }
    if (secretRequired && !clientSecret) {
      issues.push(`${key}: "${host}" needs a clientSecret`);
      continue;
    }
    out[host] = clientSecret ? { clientId, clientSecret } : { clientId };
  }
  return out;
}

/** Build and validate the config. Throws {@link ConfigError} listing every problem found. */
export function loadConfig(env: Env = process.env): BrokerConfig {
  const issues: string[] = [];

  const providers: Partial<Record<ProviderId, ClientCredentials>> = {};
  const github = creds(env, 'GH_GITHUB', true, issues);
  const gitlab = creds(env, 'GH_GITLAB', false, issues);
  const bitbucket = creds(env, 'GH_BITBUCKET', true, issues);
  const atlassian = creds(env, 'GH_ATLASSIAN', true, issues);
  const azure = creds(env, 'GH_AZURE', false, issues);
  if (github) providers.github = github;
  if (gitlab) providers.gitlab = gitlab;
  if (bitbucket) providers.bitbucket = bitbucket;
  if (atlassian) providers.atlassian = atlassian;
  if (azure) providers['azure-devops'] = azure;

  const gheHosts = hostMap(env, 'GH_GHE_HOSTS', true, issues);
  const gitlabHosts = hostMap(env, 'GH_GITLAB_HOSTS', false, issues);
  if ('github.com' in gheHosts) issues.push('GH_GHE_HOSTS must not contain github.com (use GH_GITHUB_*)');
  if ('gitlab.com' in gitlabHosts)
    issues.push('GH_GITLAB_HOSTS must not contain gitlab.com (use GH_GITLAB_*)');

  const azureTenant = str(env, 'GH_AZURE_TENANT') ?? DEFAULTS.azureTenant;
  if (!TENANT_RE.test(azureTenant))
    issues.push('GH_AZURE_TENANT must be organizations/common/consumers, a GUID or a domain');

  const config: BrokerConfig = {
    port: int(env, 'GH_BROKER_PORT', int(env, 'PORT', DEFAULTS.port, 0, 65535, issues), 0, 65535, issues),
    host: str(env, 'GH_BROKER_HOST') ?? DEFAULTS.host,
    providers,
    gheHosts,
    gitlabHosts,
    azureTenant,
    upstreamTimeoutMs: int(
      env,
      'GH_BROKER_UPSTREAM_TIMEOUT_MS',
      DEFAULTS.upstreamTimeoutMs,
      500,
      60_000,
      issues,
    ),
    maxBodyBytes: DEFAULTS.maxBodyBytes,
    rateLimit: {
      capacity: int(env, 'GH_BROKER_RATE_CAPACITY', DEFAULTS.rateLimit.capacity, 1, 10_000, issues),
      refillPerMinute: int(
        env,
        'GH_BROKER_RATE_REFILL_PER_MIN',
        DEFAULTS.rateLimit.refillPerMinute,
        1,
        100_000,
        issues,
      ),
    },
    trustProxy: bool(env, 'GH_BROKER_TRUST_PROXY', issues),
  };

  const anyProvider =
    Object.keys(providers).length > 0 ||
    Object.keys(gheHosts).length > 0 ||
    Object.keys(gitlabHosts).length > 0;
  if (!anyProvider) issues.push('no provider configured: set at least one GH_<PROVIDER>_CLIENT_ID');

  if (issues.length > 0) throw new ConfigError(issues);
  return config;
}

/** Fill in defaults for a partially specified config (handy for tests and embedding). */
export function makeConfig(partial: Partial<BrokerConfig> = {}): BrokerConfig {
  return {
    port: DEFAULTS.port,
    host: DEFAULTS.host,
    providers: {},
    gheHosts: {},
    gitlabHosts: {},
    azureTenant: DEFAULTS.azureTenant,
    upstreamTimeoutMs: DEFAULTS.upstreamTimeoutMs,
    maxBodyBytes: DEFAULTS.maxBodyBytes,
    rateLimit: { ...DEFAULTS.rateLimit },
    trustProxy: false,
    ...partial,
  };
}
