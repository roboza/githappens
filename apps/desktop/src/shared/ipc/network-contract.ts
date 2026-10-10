/**
 * SSH, proxy/TLS and stored-credential channels (spec 09 §5 `ssh:*`, `cred:*`, `proxy:*`; spec 13
 * `ssh:testConnection`). Settings themselves (`ssh.*`, `network.*`, `git.useCredentialHelpers`) go through
 * the regular `settings:set`; these channels cover actions and derived status. Secrets only flow
 * renderer → main (proxy password, key passphrase), never back.
 */

export type SshKeyType = 'ed25519' | 'rsa-4096';

export interface SshStatus {
  /** Effective selection: key file, local agent, or ssh's own defaults. */
  mode: 'key' | 'agent' | 'default';
  /** `windows-openssh` = `System32\OpenSSH\ssh.exe` (agent modes on Windows); otherwise git's ssh. */
  client: 'default' | 'windows-openssh';
  /** The `GIT_SSH_COMMAND` git network ops get, or null when ssh runs with its defaults. */
  sshCommand: string | null;
  privateKeyPath: string;
  publicKeyPath: string;
  privateKeyExists: boolean;
  publicKeyExists: boolean;
  /** Windows: which agent pipes exist (null = not Windows / unknown). */
  agentPipes: { openssh: boolean; pageant: boolean } | null;
  /** `ssh-keygen` used for generation, or null when none was found. */
  keygenPath: string | null;
  /** Suggested path for a new key (never an existing file). */
  defaultKeyPath: string;
  /** Suggested key comment (profile email). */
  defaultComment: string;
  warnings: string[];
}

export interface SshKeyInfo {
  publicKey: string;
  /** `SHA256:…` */
  fingerprint: string;
  algorithm: string;
  comment: string;
}

export interface GeneratedSshKey extends SshKeyInfo {
  privateKeyPath: string;
  publicKeyPath: string;
}

export type SshTestKind =
  | 'success'
  | 'auth'
  | 'hostkey'
  | 'hostkeyChanged'
  | 'network'
  | 'permissions'
  | 'keyFormat'
  | 'timeout'
  | 'cancelled'
  | 'notFound'
  | 'unknown';

export interface SshTestResult {
  ok: boolean;
  kind: SshTestKind;
  user?: string;
  message: string;
  output: string;
}

export interface StoredCredential {
  /** Opaque id for `cred:forget` (`<kind>/<key>`); never contains a secret. */
  id: string;
  kind: 'git' | 'ssh-passphrase' | 'proxy' | 'integration';
  /** Host, or the key path for SSH passphrases. */
  host: string;
  username?: string;
  /** `integration` rows come from connected accounts and are removed by disconnecting the account. */
  source: 'prompt' | 'integration';
}

export interface NetworkStatus {
  mode: 'system' | 'manual' | 'none';
  /** Proxy git network ops use (credentials stripped), or null for a direct connection. */
  gitProxy: string | null;
  /** OS proxy for https://github.com as resolved by Chromium (system mode), or null for DIRECT. */
  systemProxy: string | null;
  /** When the system proxy was last resolved (epoch ms). */
  resolvedAt: number | null;
  /** Saved proxy login for the current proxy host (password never returned). */
  proxyAuth: { host: string; username: string } | null;
  /** Git `-c` config injected for TLS / helpers / proxy, e.g. `http.sslBackend=schannel`. */
  gitConfig: string[];
  useCredentialHelpers: boolean;
  warnings: string[];
}

export interface NetworkIpcContract {
  // ---- SSH ----
  'ssh:status': { req: Record<string, never>; res: SshStatus };
  /**
   * Generate a key pair with ssh-keygen (argv only). `path` defaults to `SshStatus.defaultKeyPath`; an existing
   * file is never overwritten. `useAsDefault` stores the paths in `ssh.privateKeyPath`/`ssh.publicKeyPath`.
   */
  'ssh:key:generate': {
    req: { type: SshKeyType; comment?: string; passphrase?: string; path?: string; useAsDefault?: boolean };
    res: GeneratedSshKey;
  };
  /** Public key text + fingerprint; `path` defaults to `ssh.publicKeyPath` (or the private key + `.pub`). */
  'ssh:key:publicKey': { req: { path?: string }; res: SshKeyInfo & { path: string } };
  /** `ssh -T git@<host>` with the configured key/agent; host-key and passphrase prompts use askpass. */
  'ssh:testConnection': { req: { host: string }; res: SshTestResult };

  // ---- credentials (spec 09 §6.6) ----
  'cred:list': { req: Record<string, never>; res: StoredCredential[] };
  'cred:forget': { req: { id: string }; res: void };
  /** Removes every saved git login, SSH passphrase and proxy login of the active profile. */
  'cred:forgetAll': { req: Record<string, never>; res: { removed: number } };

  // ---- proxy / TLS (spec 09 §6.11) ----
  /** Re-resolves the system proxy, then reports what git and the app use. */
  'net:status': { req: Record<string, never>; res: NetworkStatus };
  /** Save the login for the current proxy host (SecretStore `<profileId>/proxy/<host>`). */
  'net:proxyAuth:set': { req: { username: string; password: string }; res: void };
  'net:proxyAuth:clear': { req: Record<string, never>; res: void };
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface NetworkEventContract {}

export const NETWORK_INVOKE_CHANNELS = [
  'ssh:status',
  'ssh:key:generate',
  'ssh:key:publicKey',
  'ssh:testConnection',
  'cred:list',
  'cred:forget',
  'cred:forgetAll',
  'net:status',
  'net:proxyAuth:set',
  'net:proxyAuth:clear',
] as const satisfies readonly (keyof NetworkIpcContract)[];

export const NETWORK_EVENT_CHANNELS = [] as const satisfies readonly (keyof NetworkEventContract)[];

type Exhaustive<All, Listed> = [Exclude<All, Listed>] extends [never]
  ? true
  : { missing: Exclude<All, Listed> };
const invokeExhaustive: Exhaustive<keyof NetworkIpcContract, (typeof NETWORK_INVOKE_CHANNELS)[number]> = true;
void invokeExhaustive;
