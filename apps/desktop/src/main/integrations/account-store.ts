import path from 'node:path';

import type { ConnectedIntegration } from '@githappens/providers/types';

import { secretAccount, type SecretStore } from '../secrets/secret-store';
import { readJson, writeFileAtomic } from '../settings/atomic-file';

/** Secret part of a connected account (spec 10 §5.4 `StoredCredential`); never leaves main. */
export interface StoredCredential {
  type: 'oauth' | 'pat';
  accessToken: string;
  refreshToken?: string;
  /** epoch ms */
  expiresAt?: number;
  /** Username some providers need for Basic auth / git (Bitbucket app passwords, Jira email). */
  username?: string;
  /** Jira Cloud OAuth (3LO): Atlassian site id; API base `api.atlassian.com/ex/jira/<cloudId>/rest/api/3`. */
  cloudId?: string;
}

interface File {
  version: 1;
  integrations: ConnectedIntegration[];
}

/**
 * Connected accounts per profile: metadata in `profiles/<id>/integrations.json`,
 * tokens in the SecretStore under `<profileId>/integration/<integrationKey>` (spec 13 §5.1).
 */
export class AccountStore {
  private listeners = new Set<() => void>();

  constructor(
    private readonly profileDir: () => string,
    private readonly profileId: () => string,
    private readonly secrets: SecretStore,
  ) {}

  /** Profile directory for per-profile integration data (pr-filters.json, repos/<id>/issue-links.json). */
  dir(): string {
    return this.profileDir();
  }

  private get file(): string {
    return path.join(this.profileDir(), 'integrations.json');
  }

  /** Called after the list of connected accounts changed (settings sync of the integrations list). */
  onDidChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(): ConnectedIntegration[] {
    const r = readJson<File>(this.file);
    return r.kind === 'ok' && Array.isArray(r.value?.integrations) ? r.value.integrations : [];
  }

  get(key: string): ConnectedIntegration | undefined {
    return this.list().find((i) => i.key === key);
  }

  credential(key: string): StoredCredential | null {
    const raw = this.secrets.get(secretAccount(this.profileId(), 'integration', key));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as StoredCredential;
    } catch {
      return null;
    }
  }

  save(meta: ConnectedIntegration, cred: StoredCredential): void {
    // Secret first: if the keychain is unavailable we must not record a half-connected account.
    this.secrets.set(secretAccount(this.profileId(), 'integration', meta.key), JSON.stringify(cred));
    const list = this.list().filter((i) => i.key !== meta.key);
    this.write([...list, meta]);
  }

  updateCredential(key: string, cred: StoredCredential): void {
    this.secrets.set(secretAccount(this.profileId(), 'integration', key), JSON.stringify(cred));
  }

  remove(key: string): void {
    this.secrets.delete(secretAccount(this.profileId(), 'integration', key));
    this.write(this.list().filter((i) => i.key !== key));
  }

  private write(integrations: ConnectedIntegration[]): void {
    const data: File = { version: 1, integrations };
    writeFileAtomic(this.file, `${JSON.stringify(data, null, 2)}\n`);
    for (const l of [...this.listeners]) l();
  }
}
