import fs from 'node:fs';

import { writeFileAtomic } from '../settings/atomic-file';

/**
 * Secrets (provider tokens, AI keys, saved passphrases). Never stored as plain
 * text (spec 00 §2, spec 15 §9). Backed by Electron `safeStorage`, which uses the
 * OS keychain / DPAPI / libsecret to protect the encryption key.
 *
 * Account naming (spec 13 §5.1, binding for specs 09, 10, 12, 14):
 *   <profileId>/<kind>/<key>
 */

export type SecretKind =
  'integration' | 'git' | 'proxy' | 'ssh-passphrase' | 'gpg-passphrase' | 'ai' | 'cloud';

export function secretAccount(profileId: string, kind: SecretKind, key: string): string {
  if (!profileId || profileId.includes('/')) throw new Error('Invalid profile id');
  if (!key) throw new Error('Secret key must not be empty');
  return `${profileId}/${kind}/${key}`;
}

/** Abstraction over Electron safeStorage so the store is testable without Electron. */
export interface Encryptor {
  isAvailable(): boolean;
  /** Human-readable backend name, e.g. "dpapi", "keychain", "gnome_libsecret". */
  backend(): string;
  encrypt(plain: string): Buffer;
  decrypt(cipher: Buffer): string;
}

export class SecretStoreUnavailableError extends Error {
  constructor(backend: string) {
    super(
      `Secure storage is not available (${backend}). Install or unlock a system keyring to save credentials.`,
    );
    this.name = 'SecretStoreUnavailableError';
  }
}

export interface SecretStore {
  readonly available: boolean;
  readonly backend: string;
  get(account: string): string | null;
  set(account: string, secret: string): void;
  delete(account: string): boolean;
  /** Delete every account under a prefix, e.g. `<profileId>/` when a profile is removed. */
  deleteByPrefix(prefix: string): number;
  listAccounts(prefix?: string): string[];
}

const FILE_MAGIC = 'KLS1';

/**
 * Whole-map encryption: account names (which include hosts/usernames) are encrypted too.
 * File layout: "KLS1" + ciphertext of JSON `{ [account]: secret }`.
 */
export class EncryptedFileSecretStore implements SecretStore {
  private map: Map<string, string> | null = null;

  constructor(
    private readonly file: string,
    private readonly enc: Encryptor,
  ) {}

  get available(): boolean {
    return this.enc.isAvailable();
  }

  get backend(): string {
    return this.enc.backend();
  }

  get(account: string): string | null {
    if (!this.available) return null;
    return this.load().get(account) ?? null;
  }

  set(account: string, secret: string): void {
    this.requireAvailable();
    const m = this.load();
    m.set(account, secret);
    this.save(m);
  }

  delete(account: string): boolean {
    if (!this.available) return false;
    const m = this.load();
    const had = m.delete(account);
    if (had) this.save(m);
    return had;
  }

  deleteByPrefix(prefix: string): number {
    if (!this.available || !prefix) return 0;
    const m = this.load();
    let n = 0;
    for (const k of [...m.keys()]) {
      if (k.startsWith(prefix)) {
        m.delete(k);
        n++;
      }
    }
    if (n) this.save(m);
    return n;
  }

  listAccounts(prefix = ''): string[] {
    if (!this.available) return [];
    return [...this.load().keys()].filter((k) => k.startsWith(prefix)).sort();
  }

  private requireAvailable(): void {
    if (!this.available) throw new SecretStoreUnavailableError(this.backend);
  }

  private load(): Map<string, string> {
    if (this.map) return this.map;
    let raw: Buffer;
    try {
      raw = fs.readFileSync(this.file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return (this.map = new Map());
      throw e;
    }
    if (raw.subarray(0, 4).toString('latin1') !== FILE_MAGIC) {
      throw new Error(`Unrecognized secrets file format: ${this.file}`);
    }
    let obj: Record<string, string>;
    try {
      obj = JSON.parse(this.enc.decrypt(raw.subarray(4))) as Record<string, string>;
    } catch {
      // The OS key no longer opens the file (e.g. the macOS "<App> Safe Storage" keychain item changed,
      // or the profile came from another machine/user). Treat
      // every secret as missing so the user reconnects; keep the unreadable file aside, never crash.
      try {
        fs.copyFileSync(this.file, `${this.file}.undecryptable`);
      } catch {
        /* best effort */
      }
      return (this.map = new Map());
    }
    return (this.map = new Map(Object.entries(obj)));
  }

  private save(m: Map<string, string>): void {
    const cipher = this.enc.encrypt(JSON.stringify(Object.fromEntries(m)));
    writeFileAtomic(this.file, Buffer.concat([Buffer.from(FILE_MAGIC, 'latin1'), cipher]));
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      /* not supported on all filesystems */
    }
    this.map = m;
  }
}

/** Adapter for Electron's safeStorage. `basic_text` on Linux is obfuscation only, so treat it as unavailable. */
export function safeStorageEncryptor(safeStorage: {
  isEncryptionAvailable(): boolean;
  encryptString(s: string): Buffer;
  decryptString(b: Buffer): string;
  getSelectedStorageBackend?: () => string;
}): Encryptor {
  const backend = (): string =>
    process.platform === 'linux'
      ? (safeStorage.getSelectedStorageBackend?.() ?? 'unknown')
      : process.platform === 'darwin'
        ? 'keychain'
        : 'dpapi';
  return {
    backend,
    isAvailable: () => safeStorage.isEncryptionAvailable() && backend() !== 'basic_text',
    encrypt: (s) => safeStorage.encryptString(s),
    decrypt: (b) => safeStorage.decryptString(b),
  };
}
