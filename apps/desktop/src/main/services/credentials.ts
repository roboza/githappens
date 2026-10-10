import { randomUUID } from 'node:crypto';

import { AskpassServer, writeAskpassShims, type AskpassRequest } from '@githappens/git';

import type { EventContract } from '../../shared/ipc/contract';
import type { StoredCredential } from '../../shared/ipc/network-contract';
import { secretAccount, type SecretStore } from '../secrets/secret-store';

const PROMPT_TIMEOUT_MS = 5 * 60_000;
/** After a token from a connected account fails for a host, skip it for this long (keychain / prompt next). */
const INTEGRATION_BACKOFF_MS = 10 * 60_000;
/** Kinds `cred:list` / `cred:forget` manage (integration tokens are removed by disconnecting the account). */
const MANAGED_KINDS = ['git', 'ssh-passphrase', 'proxy'] as const;
type ManagedKind = (typeof MANAGED_KINDS)[number];

interface StoredLogin {
  username?: string;
  password: string;
}

export interface CredentialServiceOptions {
  shimsDir: string;
  /** Electron's executable; the shim runs it with ELECTRON_RUN_AS_NODE=1. */
  nodeExecutable: string;
  secrets: SecretStore;
  profileId: () => string;
  showPrompt: (p: EventContract['git:prompt']) => void;
  /** HTTPS login from a connected provider account for this host (spec 10 §4), tried before the keychain. */
  integrationLogin?: (host: string) => { username: string; password: string } | null;
  /** Connected hosting accounts, listed read-only by `cred:list`. */
  integrationAccounts?: () => Array<{ host: string; login: string }>;
  /** A token from a connected account was rejected for `host` (spec 09 §11: mark the integration expired). */
  onIntegrationAuthFailed?: (host: string) => void;
  log?: (message: string) => void;
}

/**
 * Credential resolution for git network ops (spec 02 §6.3, spec 09 §6.6). Git's own credential helpers run
 * first (unless `git.useCredentialHelpers` is off); then askpass reaches this chain:
 * connected integration token → stored keychain login → prompt in the UI.
 * A login typed with "Remember" is held per op and saved only after the op succeeds. Keychain logins that
 * were served and then failed are forgotten; integration tokens that failed are skipped for a while.
 */
export class CredentialService {
  private server: AskpassServer | null = null;
  private readonly pending = new Map<
    string,
    {
      resolve: (r: { value: string | null; remember: boolean }) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  /** Username typed earlier in the same op, per host (git asks username then password). */
  private readonly typedUser = new Map<string, string>();
  /** Accounts served from the keychain per op, to forget on auth failure. */
  private readonly served = new Map<string, Set<string>>();
  /** Hosts answered with an integration token per op. */
  private readonly servedIntegration = new Map<string, Set<string>>();
  /** Host → time its integration token failed. */
  private readonly integrationFailedAt = new Map<string, number>();
  /** "Remember" answers waiting for their op to succeed. */
  private readonly pendingSaves = new Map<string, Array<{ account: string; login: StoredLogin }>>();

  constructor(private readonly o: CredentialServiceOptions) {}

  async start(): Promise<void> {
    const shims = await writeAskpassShims(this.o.shimsDir, {
      nodeExecutable: this.o.nodeExecutable,
      runAsNodeEnv: true,
    });
    this.server = new AskpassServer({ shims, onPrompt: (r) => this.onPrompt(r), log: this.o.log });
    await this.server.start();
  }

  envFor(opId: string, background: boolean): Record<string, string> {
    return this.server?.envFor(opId, { nonInteractive: background }) ?? {};
  }

  /**
   * Call when an op ends. Success commits remembered logins; failure drops them. Failed auth also forgets
   * the keychain logins that were served and backs off from integration tokens for those hosts.
   */
  finish(opId: string, errorCode?: string): void {
    const pending = this.pendingSaves.get(opId);
    this.pendingSaves.delete(opId);
    if (!errorCode) for (const p of pending ?? []) this.save(p.account, p.login);
    if (errorCode === 'AuthenticationFailed') {
      for (const account of this.served.get(opId) ?? []) this.o.secrets.delete(account);
      for (const host of this.servedIntegration.get(opId) ?? []) {
        this.integrationFailedAt.set(host, Date.now());
        this.o.onIntegrationAuthFailed?.(host);
      }
    }
    this.served.delete(opId);
    this.servedIntegration.delete(opId);
    for (const k of [...this.typedUser.keys()]) if (k.startsWith(`${opId}|`)) this.typedUser.delete(k);
    this.server?.release(opId);
  }

  wasCancelled(opId: string): boolean {
    return this.server?.wasCancelled(opId) ?? false;
  }

  /** Renderer answered `git:prompt` (via `git:prompt:answer`). */
  answer(promptId: string, value: string | null, remember: boolean): void {
    const p = this.pending.get(promptId);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(promptId);
    p.resolve({ value, remember });
  }

  // ---- stored credentials (spec 09 §5 `cred:*`) ----------------------------------------------

  /** Saved logins/passphrases of the active profile (no secrets), plus connected accounts (read-only). */
  list(): StoredCredential[] {
    const profile = this.o.profileId();
    const out: StoredCredential[] = [];
    for (const kind of MANAGED_KINDS) {
      const prefix = `${profile}/${kind}/`;
      for (const account of this.safeList(prefix)) {
        const key = account.slice(prefix.length);
        const stored = kind === 'ssh-passphrase' ? null : this.load(account);
        out.push({ id: `${kind}/${key}`, kind, host: key, username: stored?.username, source: 'prompt' });
      }
    }
    for (const a of this.o.integrationAccounts?.() ?? []) {
      out.push({
        id: `integration/${a.host}/${a.login}`,
        kind: 'integration',
        host: a.host,
        username: a.login,
        source: 'integration',
      });
    }
    return out;
  }

  /** Forget one saved credential by `StoredCredential.id`. */
  forget(id: string): void {
    const slash = id.indexOf('/');
    const kind = id.slice(0, slash) as ManagedKind;
    const key = id.slice(slash + 1);
    if (slash <= 0 || !key || !MANAGED_KINDS.includes(kind)) {
      throw new Error(
        'Only saved logins and passphrases can be forgotten here; disconnect accounts in Integrations.',
      );
    }
    this.o.secrets.delete(secretAccount(this.o.profileId(), kind, key));
  }

  /** "Forget all credentials" (spec 09 §6.6): saved git logins, SSH passphrases and proxy logins. */
  forgetAll(): number {
    const profile = this.o.profileId();
    let removed = 0;
    for (const kind of MANAGED_KINDS) removed += this.o.secrets.deleteByPrefix(`${profile}/${kind}/`);
    this.integrationFailedAt.clear();
    return removed;
  }

  private safeList(prefix: string): string[] {
    try {
      return this.o.secrets.listAccounts(prefix);
    } catch {
      return [];
    }
  }

  async close(): Promise<void> {
    for (const id of [...this.pending.keys()]) this.answer(id, null, false);
    await this.server?.close();
  }

  // ---------------------------------------------------------------------------

  private async onPrompt(req: AskpassRequest): Promise<string | null> {
    const host = req.host ?? 'unknown';
    const profile = this.o.profileId();
    switch (req.kind) {
      case 'username': {
        const integration = this.integrationFor(host);
        if (integration) return this.serveIntegration(req.opId, host, integration.username);
        const account = secretAccount(profile, 'git', host);
        const stored = this.load(account);
        if (stored?.username) return this.serve(req.opId, account, stored.username);
        const r = await this.ask(req);
        if (r.value !== null) this.typedUser.set(`${req.opId}|${host}`, r.value);
        return r.value;
      }
      case 'password': {
        const user = req.username ?? this.typedUser.get(`${req.opId}|${host}`);
        const integration = this.integrationFor(host);
        if (integration && (!user || integration.username === user)) {
          return this.serveIntegration(req.opId, host, integration.password);
        }
        const account = secretAccount(profile, 'git', host);
        const stored = this.load(account);
        if (stored && (!user || !stored.username || stored.username === user)) {
          return this.serve(req.opId, account, stored.password);
        }
        const r = await this.ask(req);
        if (r.value !== null && r.remember)
          this.queueSave(req.opId, account, { username: user, password: r.value });
        return r.value;
      }
      case 'passphrase': {
        const account = secretAccount(profile, 'ssh-passphrase', req.keyPath ?? host);
        const stored = this.load(account);
        if (stored) return this.serve(req.opId, account, stored.password);
        const r = await this.ask(req);
        if (r.value !== null && r.remember) this.queueSave(req.opId, account, { password: r.value });
        return r.value;
      }
      default:
        return (await this.ask(req)).value;
    }
  }

  /** Integration login for `host`, unless its token failed recently. */
  private integrationFor(host: string): { username: string; password: string } | null {
    const failedAt = this.integrationFailedAt.get(host);
    if (failedAt !== undefined && Date.now() - failedAt < INTEGRATION_BACKOFF_MS) return null;
    return this.o.integrationLogin?.(host) ?? null;
  }

  private serveIntegration(opId: string, host: string, value: string): string {
    const set = this.servedIntegration.get(opId) ?? new Set<string>();
    set.add(host);
    this.servedIntegration.set(opId, set);
    return value;
  }

  private queueSave(opId: string, account: string, login: StoredLogin): void {
    const list = (this.pendingSaves.get(opId) ?? []).filter((p) => p.account !== account);
    list.push({ account, login });
    this.pendingSaves.set(opId, list);
  }

  private serve(opId: string, account: string, value: string): string {
    const set = this.served.get(opId) ?? new Set<string>();
    set.add(account);
    this.served.set(opId, set);
    return value;
  }

  private load(account: string): StoredLogin | null {
    try {
      const raw = this.o.secrets.get(account);
      return raw ? (JSON.parse(raw) as StoredLogin) : null;
    } catch {
      return null;
    }
  }

  private save(account: string, login: StoredLogin): void {
    try {
      this.o.secrets.set(account, JSON.stringify(login));
    } catch (e) {
      this.o.log?.(`Could not store credential: ${(e as Error).message}`);
    }
  }

  private ask(req: AskpassRequest): Promise<{ value: string | null; remember: boolean }> {
    const promptId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.answer(promptId, null, false), PROMPT_TIMEOUT_MS);
      this.pending.set(promptId, { resolve, timer });
      this.o.showPrompt({ promptId, kind: req.kind, text: req.prompt, host: req.host });
    });
  }
}
