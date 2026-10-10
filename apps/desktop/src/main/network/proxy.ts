/**
 * Proxy configuration (spec 09 §6.11, spec 13 Network section). Pure helpers: no Electron.
 *
 * Git gets the proxy through env (`HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY`), which libcurl reads only when the
 * user's own `http.proxy` git config is unset — so the user's git config keeps winning (spec 09 §6.11).
 * "No proxy" additionally sets `http.proxy=` (empty disables proxying in git) and removes the env vars.
 */

export type ProxyMode = 'system' | 'manual' | 'none';

export interface ProxyAuth {
  username: string;
  password: string;
}

export interface ProxyPrefs {
  mode: ProxyMode;
  url: string;
  noProxy: string[];
}

const PROXY_ENV_KEYS = ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY'] as const;

/**
 * Convert a Chromium/PAC proxy list (`"PROXY host:port; DIRECT"`) to the first usable proxy URL, or null
 * for DIRECT. HTTPS → `https://`, SOCKS/SOCKS5 → `socks5://`, SOCKS4 → `socks4://`.
 */
export function parsePacResult(pac: string): string | null {
  for (const raw of pac.split(';')) {
    const entry = raw.trim();
    if (!entry) continue;
    const [type, hostPort] = entry.split(/\s+/, 2) as [string, string | undefined];
    const t = type.toUpperCase();
    if (t === 'DIRECT') return null;
    if (!hostPort || !/^[^\s/@]+$/.test(hostPort)) continue;
    if (t === 'PROXY') return `http://${hostPort}`;
    if (t === 'HTTPS') return `https://${hostPort}`;
    if (t === 'SOCKS' || t === 'SOCKS5') return `socks5://${hostPort}`;
    if (t === 'SOCKS4') return `socks4://${hostPort}`;
  }
  return null;
}

/** Host (and port) of a proxy URL, for the SecretStore key `<profileId>/proxy/<host>`. */
export function proxyHost(url: string): string | null {
  try {
    const u = new URL(url);
    return u.host || null;
  } catch {
    return null;
  }
}

/** Add percent-encoded credentials to a proxy URL. */
export function withProxyAuth(url: string, auth: ProxyAuth | null): string {
  if (!auth?.username) return url;
  try {
    const u = new URL(url);
    u.username = encodeURIComponent(auth.username);
    u.password = encodeURIComponent(auth.password);
    return u.toString().replace(/\/$/, '');
  } catch {
    return url;
  }
}

/** Strip credentials for display/logging. */
export function redactProxyUrl(url: string): string {
  try {
    const u = new URL(url);
    if (!u.username && !u.password) return url.replace(/\/$/, '');
    u.username = '';
    u.password = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return url.replace(/\/\/[^@/]*@/, '//');
  }
}

/** curl's NO_PROXY understands `.example.com` / `example.com`, not `*.example.com`. */
export function curlNoProxy(list: string[]): string {
  const out: string[] = [];
  for (const raw of list) {
    let h = raw.trim();
    if (!h || h === '<local>') continue;
    if (h.startsWith('*.')) h = h.slice(1);
    else if (h === '*') h = '*';
    if (/[\s,]/.test(h)) continue;
    if (!out.includes(h)) out.push(h);
  }
  return out.join(',');
}

/** Chromium bypass rules (`session.setProxy({ proxyBypassRules })`); `<local>` keeps plain host names direct. */
export function chromiumBypassRules(list: string[]): string {
  const rules = list.map((h) => h.trim()).filter((h) => h && !/[\s,;]/.test(h));
  if (!rules.includes('<local>')) rules.push('<local>');
  return rules.join(',');
}

export interface GitProxyConfig {
  env: Record<string, string | null>;
  config: Array<[string, string]>;
  /** Proxy git will use (credentials stripped), or null for direct / inherited. */
  effective: string | null;
}

/**
 * Git proxy env/config for the current mode. `systemProxy` is the URL resolved from the OS (Electron
 * `session.resolveProxy`), or null when the OS says DIRECT / resolution is unavailable.
 */
export function gitProxyConfig(
  prefs: ProxyPrefs,
  systemProxy: string | null,
  auth: ProxyAuth | null,
): GitProxyConfig {
  if (prefs.mode === 'none') {
    const env: Record<string, string | null> = {};
    for (const k of PROXY_ENV_KEYS) env[k] = null;
    return { env, config: [['http.proxy', '']], effective: null };
  }
  const url = prefs.mode === 'manual' ? prefs.url.trim() : systemProxy;
  if (!url) return { env: {}, config: [], effective: null };
  const withAuth = withProxyAuth(url, auth);
  const env: Record<string, string | null> = { HTTPS_PROXY: withAuth, HTTP_PROXY: withAuth };
  const noProxy = curlNoProxy(['localhost', '127.0.0.1', '::1', ...prefs.noProxy]);
  if (noProxy) env.NO_PROXY = noProxy;
  return { env, config: [], effective: redactProxyUrl(url) };
}

export type SessionProxyConfig =
  | { mode: 'system' }
  | { mode: 'direct' }
  | { mode: 'fixed_servers'; proxyRules: string; proxyBypassRules: string };

/** Electron `session.setProxy` config so provider APIs, AI, cloud and the updater follow the same setting. */
export function sessionProxyConfig(prefs: ProxyPrefs): SessionProxyConfig {
  if (prefs.mode === 'none') return { mode: 'direct' };
  if (prefs.mode === 'manual' && prefs.url.trim()) {
    return {
      mode: 'fixed_servers',
      // Chromium takes credentials from the `login` event, never from the rules.
      proxyRules: redactProxyUrl(prefs.url.trim()),
      proxyBypassRules: chromiumBypassRules(prefs.noProxy),
    };
  }
  return { mode: 'system' };
}
