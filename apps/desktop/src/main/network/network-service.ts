import fs from 'node:fs';

import type { NetworkStatus } from '../../shared/ipc/network-contract';
import { secretAccount, type SecretStore } from '../secrets/secret-store';
import {
  createCertificateVerifyProc,
  gitTlsConfig,
  pemBodies,
  type TlsPrefs,
  type TrustSource,
  type VerifyRequestLike,
} from './certs';
import {
  gitProxyConfig,
  parsePacResult,
  proxyHost,
  sessionProxyConfig,
  type ProxyAuth,
  type ProxyPrefs,
  type SessionProxyConfig,
} from './proxy';

export type NetworkPrefs = ProxyPrefs & TlsPrefs & { useCredentialHelpers: boolean };

export interface NetworkServiceDeps {
  prefs: () => NetworkPrefs;
  profileId: () => string;
  secrets: SecretStore;
  platform?: NodeJS.Platform;
  /** Electron `session.defaultSession.resolveProxy`. */
  resolveProxy?: (url: string) => Promise<string>;
  /** Electron `session.defaultSession.setProxy`. */
  setSessionProxy?: (config: SessionProxyConfig) => Promise<void>;
  /** Electron `session.defaultSession.setCertificateVerifyProc` (null restores Chromium's default). */
  setCertificateVerifyProc?: (
    proc: ((req: VerifyRequestLike, callback: (code: number) => void) => void) | null,
  ) => void;
  readFile?: (p: string) => string;
  log?: (message: string) => void;
}

/** URL used to resolve the OS proxy for git (PAC may differ per host; see report/limits). */
const PROBE_URL = 'https://github.com/';
const SYSTEM_REFRESH_MS = 5 * 60_000;

export interface GitNetworkConfig {
  env: Record<string, string | null>;
  config: Array<[string, string]>;
  effectiveProxy: string | null;
  warnings: string[];
}

/**
 * Proxy, TLS and credential-helper policy for git and for the app's own HTTP (spec 09 §6.6, §6.11).
 * Git: env + `GIT_CONFIG_*` built synchronously per spawn from cached state. App HTTP: the Electron session
 * proxy and certificate verify proc are re-applied whenever the Network settings change.
 */
export class NetworkService {
  private systemProxy: string | null = null;
  private resolvedAt: number | null = null;
  private caBodies: ReadonlySet<string> = new Set();
  private readonly trustSources = new Set<TrustSource>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly platform: NodeJS.Platform;

  constructor(private readonly d: NetworkServiceDeps) {
    this.platform = d.platform ?? process.platform;
  }

  async start(): Promise<void> {
    await this.apply();
    this.timer = setInterval(() => void this.resolveSystemProxy(), SYSTEM_REFRESH_MS);
    this.timer.unref?.();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Re-apply after a `network.*` setting (or the profile) changed. */
  async apply(): Promise<void> {
    const prefs = this.d.prefs();
    this.loadCaBundle(prefs.caBundlePath);
    if (this.d.setCertificateVerifyProc) {
      try {
        this.d.setCertificateVerifyProc(this.verifyProc());
      } catch (e) {
        this.d.log?.(`setCertificateVerifyProc failed: ${(e as Error).message}`);
      }
    }
    await this.d.setSessionProxy?.(sessionProxyConfig(prefs)).catch((e: unknown) => {
      this.d.log?.(`setProxy failed: ${(e as Error).message}`);
    });
    await this.resolveSystemProxy();
  }

  /** CA bundle proc extended with registered trust sources; null = Chromium's default. */
  private verifyProc(): ((req: VerifyRequestLike, callback: (code: number) => void) => void) | null {
    if (!this.caBodies.size && !this.trustSources.size) return null;
    const bundle = createCertificateVerifyProc(() => this.caBodies);
    return (req, callback) => {
      if (req.errorCode !== 0) {
        for (const source of this.trustSources) {
          try {
            if (source(req)) return callback(0);
          } catch {
            /* a failing source has no opinion */
          }
        }
      }
      bundle(req, callback);
    };
  }

  /**
   * Plug an extra trust decision into the Electron verify proc (e.g. a pinned self-signed cloud server
   * certificate). Returns a function that removes it.
   */
  addTrustSource(source: TrustSource): () => void {
    this.trustSources.add(source);
    this.reinstallVerifyProc();
    return () => {
      this.trustSources.delete(source);
      this.reinstallVerifyProc();
    };
  }

  private reinstallVerifyProc(): void {
    try {
      this.d.setCertificateVerifyProc?.(this.verifyProc());
    } catch (e) {
      this.d.log?.(`setCertificateVerifyProc failed: ${(e as Error).message}`);
    }
  }

  private loadCaBundle(p: string): void {
    const file = p.trim();
    if (!file) {
      this.caBodies = new Set();
      return;
    }
    try {
      const text = (this.d.readFile ?? ((f: string) => fs.readFileSync(f, 'utf8')))(file);
      this.caBodies = new Set(pemBodies(text));
    } catch {
      this.caBodies = new Set();
    }
  }

  /** Resolve the OS proxy (system mode) through Chromium; DIRECT / failure → null. */
  async resolveSystemProxy(): Promise<string | null> {
    if (this.d.prefs().mode !== 'system' || !this.d.resolveProxy) {
      this.systemProxy = null;
      this.resolvedAt = null;
      return null;
    }
    try {
      this.systemProxy = parsePacResult(await this.d.resolveProxy(PROBE_URL));
    } catch (e) {
      this.d.log?.(`resolveProxy failed: ${(e as Error).message}`);
      this.systemProxy = null;
    }
    this.resolvedAt = Date.now();
    return this.systemProxy;
  }

  /** The proxy URL in use (before credentials), for the SecretStore host key. */
  private currentProxyUrl(prefs = this.d.prefs()): string | null {
    if (prefs.mode === 'manual') return prefs.url.trim() || null;
    if (prefs.mode === 'system') return this.systemProxy;
    return null;
  }

  private authAccount(prefs = this.d.prefs()): string | null {
    const url = this.currentProxyUrl(prefs);
    const host = url ? proxyHost(url) : null;
    return host ? secretAccount(this.d.profileId(), 'proxy', host) : null;
  }

  private loadAuth(prefs = this.d.prefs()): ProxyAuth | null {
    const account = this.authAccount(prefs);
    if (!account) return null;
    try {
      const raw = this.d.secrets.get(account);
      const v = raw ? (JSON.parse(raw) as Partial<ProxyAuth>) : null;
      return v?.username ? { username: v.username, password: v.password ?? '' } : null;
    } catch {
      return null;
    }
  }

  /** Env + config for every git invocation. Sync: uses the cached system proxy. */
  gitConfig(): GitNetworkConfig {
    const prefs = this.d.prefs();
    const proxy = gitProxyConfig(prefs, this.systemProxy, this.loadAuth(prefs));
    const tls = gitTlsConfig(prefs, this.platform);
    const config = [...proxy.config, ...tls.config];
    // Empty `credential.helper` resets git's helper list, so only GitHappens' askpass chain answers.
    if (!prefs.useCredentialHelpers) config.push(['credential.helper', '']);
    return { env: proxy.env, config, effectiveProxy: proxy.effective, warnings: tls.warnings };
  }

  async status(): Promise<NetworkStatus> {
    await this.resolveSystemProxy();
    const prefs = this.d.prefs();
    const g = this.gitConfig();
    const url = this.currentProxyUrl(prefs);
    const auth = this.loadAuth(prefs);
    const warnings = [...g.warnings];
    if (prefs.mode === 'manual' && !prefs.url.trim())
      warnings.push('Manual proxy is selected but no proxy URL is set.');
    if (prefs.caBundlePath.trim() && !this.caBodies.size) {
      warnings.push('The custom CA bundle contains no PEM certificates the app could read.');
    }
    return {
      mode: prefs.mode,
      gitProxy: g.effectiveProxy,
      systemProxy: this.systemProxy,
      resolvedAt: this.resolvedAt,
      proxyAuth: auth && url ? { host: proxyHost(url) ?? '', username: auth.username } : null,
      gitConfig: g.config.map(([k, v]) => `${k}=${v}`),
      useCredentialHelpers: prefs.useCredentialHelpers,
      warnings,
    };
  }

  setProxyAuth(username: string, password: string): void {
    const account = this.authAccount();
    if (!account) throw new Error('No proxy is in use; set a manual proxy URL first.');
    if (!username.trim() || /[\0\r\n]/.test(username + password)) throw new Error('Invalid proxy login.');
    this.d.secrets.set(account, JSON.stringify({ username: username.trim(), password }));
  }

  clearProxyAuth(): void {
    const account = this.authAccount();
    if (account) this.d.secrets.delete(account);
  }

  /**
   * Answer Chromium's proxy auth challenge (`app.on('login')` with `authInfo.isProxy`) from the saved login
   * for that proxy host. Returns null when nothing is saved.
   */
  proxyLogin(authInfo: { isProxy: boolean; host: string; port: number }): ProxyAuth | null {
    if (!authInfo.isProxy) return null;
    const profile = this.d.profileId();
    for (const host of [`${authInfo.host}:${authInfo.port}`, authInfo.host]) {
      try {
        const raw = this.d.secrets.get(secretAccount(profile, 'proxy', host));
        const v = raw ? (JSON.parse(raw) as Partial<ProxyAuth>) : null;
        if (v?.username) return { username: v.username, password: v.password ?? '' };
      } catch {
        // try the next form
      }
    }
    return null;
  }
}
