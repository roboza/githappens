import type { InvocationExtras } from '@githappens/git';

import type { SettingKey, SettingValue } from '../../shared/settings/registry';
import type { SecretStore } from '../secrets/secret-store';
import { SshService, type SshServiceDeps } from '../ssh/ssh-service';
import { installNetBackedFetch } from './app-fetch';
import type { VerifyRequestLike } from './certs';
import { NetworkService } from './network-service';
import type { SessionProxyConfig } from './proxy';

export { NetworkService } from './network-service';
export { SshService } from '../ssh/ssh-service';

/** The parts of `SettingsStore` used here. */
export interface ConnectivitySettings {
  get<K extends SettingKey>(key: K): SettingValue<K>;
  set(key: string, value: unknown): void;
  readonly activeProfile: { id: string; authorEmail: string };
  on(event: 'changed', listener: (change: { key: string }) => void): unknown;
  on(event: 'profileSwitched', listener: (...args: unknown[]) => void): unknown;
}

/** The parts of Electron's `Session` used here (kept structural so tests need no Electron). */
export interface SessionLike {
  resolveProxy(url: string): Promise<string>;
  setProxy(config: SessionProxyConfig): Promise<void>;
  setCertificateVerifyProc(
    proc: ((req: VerifyRequestLike, callback: (code: number) => void) => void) | null,
  ): void;
}

export interface ConnectivityDeps {
  settings: ConnectivitySettings;
  secrets: SecretStore;
  bundledGitDir?: string;
  /** Electron `session.defaultSession`; omitted in tests. */
  session?: SessionLike;
  /** Electron `net.fetch`: when given, the main-process global `fetch` is routed through it. */
  netFetch?: typeof fetch;
  /** Askpass env for the SSH connection test (CredentialService.envFor / finish). */
  askpass?: SshServiceDeps['askpass'];
  log?: (message: string) => void;
}

export interface ConnectivityServices {
  ssh: SshService;
  network: NetworkService;
  /** Pass to `GitProcessRunner.setInvocationExtras` — applies to every git spawn (ops, clone, reads, LFS). */
  gitInvocation: () => InvocationExtras;
  dispose(): void;
}

/** Merge the SSH and network parts into one `InvocationExtras` (exported for tests). */
export function combineInvocation(
  ssh: { env: Record<string, string | null> },
  net: { env: Record<string, string | null>; config: Array<[string, string]> },
): InvocationExtras {
  return { env: { ...net.env, ...ssh.env }, config: [...net.config] };
}

/**
 * SSH + proxy/TLS + credential-helper policy for git and the app's HTTP (spec 09 §6.6, §6.7, §6.11).
 * Re-applies itself on `ssh.*` / `network.*` / `git.useCredentialHelpers` changes and profile switches.
 */
export function createConnectivityServices(d: ConnectivityDeps): ConnectivityServices {
  const s = d.settings;
  const ssh = new SshService({
    prefs: () => ({
      useLocalAgent: s.get('ssh.useLocalAgent'),
      privateKeyPath: s.get('ssh.privateKeyPath'),
      publicKeyPath: s.get('ssh.publicKeyPath'),
      useSshConfig: s.get('ssh.useSshConfig'),
      windowsAgent: s.get('ssh.windowsAgent'),
    }),
    setKeyPaths: (priv, pub) => {
      s.set('ssh.privateKeyPath', priv);
      s.set('ssh.publicKeyPath', pub);
    },
    defaultComment: () => s.activeProfile.authorEmail,
    bundledGitDir: d.bundledGitDir,
    askpass: d.askpass,
  });
  const network = new NetworkService({
    prefs: () => ({
      mode: s.get('network.proxyMode'),
      url: s.get('network.proxyUrl'),
      noProxy: s.get('network.noProxy'),
      useOsCertStore: s.get('network.useOsCertStore'),
      caBundlePath: s.get('network.caBundlePath'),
      useCredentialHelpers: s.get('git.useCredentialHelpers'),
    }),
    profileId: () => s.activeProfile.id,
    secrets: d.secrets,
    resolveProxy: d.session ? (url) => d.session!.resolveProxy(url) : undefined,
    setSessionProxy: d.session ? (cfg) => d.session!.setProxy(cfg) : undefined,
    setCertificateVerifyProc: d.session ? (proc) => d.session!.setCertificateVerifyProc(proc) : undefined,
    log: d.log,
  });

  const uninstallFetch = d.netFetch ? installNetBackedFetch(d.netFetch) : null;
  void network.start().catch((e: unknown) => d.log?.(`network start failed: ${(e as Error).message}`));
  s.on('changed', ({ key }) => {
    if (key.startsWith('network.')) void network.apply();
  });
  s.on('profileSwitched', () => void network.apply());

  return {
    ssh,
    network,
    gitInvocation: () => combineInvocation(ssh.invocation(), network.gitConfig()),
    dispose: () => {
      network.dispose();
      uninstallFetch?.();
    },
  };
}
