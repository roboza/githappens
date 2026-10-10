import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type { SyncCategoryInfo, SyncItem } from '@githappens/cloud-api';

import {
  SYNC_DATA_CATEGORIES,
  SYNC_CATEGORY_LABELS,
  type ReconnectHint,
  type SyncDataCategory,
  type SyncStatus,
} from '../../../shared/ipc/cloud-contract';
import type { SettingKey } from '../../../shared/settings/registry';
import type { SecretStore } from '../../secrets/secret-store';
import { readJson, writeFileAtomic } from '../../settings/atomic-file';
import { CloudError, type CloudHttp } from '../cloud-http';
import type { SyncSource } from './adapters';
import { hashValue } from './canonical';
import {
  createSyncKeys,
  decodeKeysDoc,
  decryptCategory,
  encodeKeysDoc,
  encryptCategory,
  keyIdOf,
  rewrapPassphrase,
  rewrapRecovery,
  SyncKeyError,
  unlockWithPassphrase,
  unlockWithRecoveryKey,
  type KdfParams,
  type SyncKeysDoc,
} from './crypto';
import { liveValues, merge3, pruneTombstones, sameItems, type SyncItems } from './merge';

/**
 * Settings sync engine (spec 14 §6.2): end-to-end encrypted, per-category documents with optimistic
 * concurrency (`If-Match`), keyed 3-way merge on conflicts, pull on start / focus (≥ 5 min) / every
 * 15 min, push 10 s after local changes. Nothing happens unless a server is configured, the user is
 * signed in and `sync.enabled` is on. A wrong passphrase never deletes anything.
 */

export const CATEGORY_SETTING: Record<SyncDataCategory, SettingKey> = {
  preferences: 'sync.preferences',
  keybindings: 'sync.keybindings',
  themes: 'sync.themes',
  'workspaces-local': 'sync.workspaces',
  launchpad: 'sync.launchpad',
  'integrations-list': 'sync.integrationsList',
};

/** HTTP surface the engine needs: CloudHttp plus the per-session secret slot of CloudClient. */
export interface SyncHttp extends Pick<CloudHttp, 'request' | 'me' | 'serverUrl' | 'onSessionChange'> {
  sessionSecretAccount(suffix: string): string | null;
}

export interface SyncEngineOptions {
  http: SyncHttp;
  secrets: Pick<SecretStore, 'get' | 'set' | 'delete'>;
  sources: SyncSource[];
  settings: { get(key: SettingKey): unknown; set(key: string, value: unknown): void };
  profileDir(): string;
  onStatus(status: SyncStatus): void;
  now?: () => number;
  /** Key derivation parameters for new keys (tests use a cheap N). */
  kdf?: KdfParams;
  pushDebounceMs?: number;
  pullIntervalMs?: number;
  focusPullMs?: number;
  log?: (message: string) => void;
}

interface CategoryState {
  /** Server version this device last agreed on (0 = never synced). */
  version: number;
  /** Items at that version (3-way merge base). */
  base: SyncItems;
  /** Last observed local value hash + change stamp per key (tombstone hash = DEL). */
  local: Record<string, { h: string; at: number }>;
  /** False until the first read: initial values get stamp 0 so synced values win on first join. */
  observed: boolean;
  /** Unresolved conflict awaiting keep local / keep remote. */
  pending?: { keys: string[] };
}

interface SyncStateFile {
  v: 1;
  /** `<serverUrl>|<userId>` the state belongs to. */
  account?: string;
  deviceId: string;
  lastSyncAt?: string;
  keysVersion?: number;
  /** Key the category versions/bases belong to; a new key (reset elsewhere) restarts them. */
  keyId?: string;
  categories: Partial<Record<SyncDataCategory, CategoryState>>;
  hints: ReconnectHint[];
}

interface SyncDoc {
  v: 1;
  category: string;
  schema: number;
  items: SyncItems;
}

const STATE_FILE = 'cloud-sync.json';
const DEL = '\u0000del';
const DEK_SLOT = 'sync-dek';
const RECOVERY_SLOT = 'sync-recovery';

const isNotFound = (e: unknown): boolean => e instanceof CloudError && e.code === 'not_found';
const isPrecondition = (e: unknown): boolean => e instanceof CloudError && e.code === 'precondition_failed';

export class SyncEngine {
  private file: SyncStateFile | null = null;
  private fileDir: string | null = null;
  private dek: Buffer | null = null;
  private keyId: string | null = null;
  private keyState: SyncStatus['keyState'] = 'unknown';
  private state: SyncStatus['state'] = 'off';
  private error: string | undefined;
  private skipped = new Map<SyncDataCategory, string>();
  private queue: Promise<unknown> = Promise.resolve();
  private busy = 0;
  private active = false;
  private lastPullAt = 0;
  private pullTimer: ReturnType<typeof setInterval> | null = null;
  private pushTimers = new Map<SyncDataCategory, ReturnType<typeof setTimeout>>();
  private unsubs: Array<() => void> = [];
  private started = false;

  constructor(private readonly o: SyncEngineOptions) {}

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  // ---- lifecycle -----------------------------------------------------------------------------------

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const src of this.o.sources) {
      this.unsubs.push(src.onChange(() => this.schedulePush(src.category)));
    }
    this.unsubs.push(this.o.http.onSessionChange(() => this.reevaluate()));
    this.reevaluate();
  }

  dispose(): void {
    this.started = false;
    for (const u of this.unsubs.splice(0)) u();
    this.stopTimers();
  }

  /** Profile switch: drop in-memory state and start over for the new profile. */
  reload(): void {
    this.file = null;
    this.fileDir = null;
    this.forgetDekInMemory();
    this.active = false;
    this.reevaluate();
  }

  /** `sync.*` setting changed. */
  settingChanged(key: string): void {
    if (key.startsWith('sync.')) this.reevaluate(true);
  }

  /** Window focus: pull when the last pull is ≥ 5 min old. */
  onFocus(): void {
    if (this.active && this.dek && this.now() - this.lastPullAt >= (this.o.focusPullMs ?? 5 * 60_000)) {
      void this.enqueue(() => this.pullAll()).catch(() => undefined);
    }
  }

  private available(): boolean {
    return !!this.o.http.serverUrl() && !!this.o.http.me();
  }

  private enabled(): boolean {
    return this.o.settings.get('sync.enabled') === true;
  }

  private categoryEnabled(c: SyncDataCategory): boolean {
    return this.o.settings.get(CATEGORY_SETTING[c]) !== false;
  }

  private reevaluate(pullNow = false): void {
    const shouldRun = this.started && this.available() && this.enabled();
    if (!shouldRun) {
      if (this.active || this.dek) {
        this.active = false;
        this.stopTimers();
        this.forgetDekInMemory();
      }
      this.state = 'off';
      this.emit();
      return;
    }
    const wasActive = this.active;
    this.active = true;
    if (!this.pullTimer) {
      this.pullTimer = setInterval(
        () => void this.enqueue(() => this.pullAll()).catch(() => undefined),
        this.o.pullIntervalMs ?? 15 * 60_000,
      );
      this.pullTimer.unref?.();
    }
    if (!wasActive || pullNow) void this.enqueue(() => this.pullAll()).catch(() => undefined);
    else this.emit();
  }

  private stopTimers(): void {
    if (this.pullTimer) clearInterval(this.pullTimer);
    this.pullTimer = null;
    for (const t of this.pushTimers.values()) clearTimeout(t);
    this.pushTimers.clear();
  }

  private schedulePush(category: SyncDataCategory): void {
    if (!this.active || !this.categoryEnabled(category)) return;
    const prev = this.pushTimers.get(category);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      this.pushTimers.delete(category);
      const src = this.o.sources.find((s) => s.category === category);
      if (src && this.active && this.dek) {
        void this.enqueue(() => this.run(() => this.syncCategory(src, undefined))).catch(() => undefined);
      }
    }, this.o.pushDebounceMs ?? 10_000);
    t.unref?.();
    this.pushTimers.set(category, t);
  }

  /** Serialize all sync work. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => undefined);
    return p;
  }

  /** Wait for queued work (tests). */
  idle(): Promise<void> {
    return this.queue.then(() => undefined);
  }

  // ---- status --------------------------------------------------------------------------------------

  status(): SyncStatus {
    const f = this.available() ? this.stateFile() : null;
    const categories = Object.fromEntries(
      SYNC_DATA_CATEGORIES.map((c) => [c, this.categoryEnabled(c)]),
    ) as Record<SyncDataCategory, boolean>;
    const conflicts = SYNC_DATA_CATEGORIES.flatMap((c) => {
      const p = f?.categories[c]?.pending;
      return p && categories[c] ? [{ category: c, keys: p.keys }] : [];
    });
    const recovery = this.o.http.sessionSecretAccount(RECOVERY_SLOT);
    return {
      enabled: this.enabled(),
      categories,
      available: this.available(),
      keyState: this.keyState,
      state: !this.active ? 'off' : this.busy ? 'syncing' : this.state,
      ...(f?.lastSyncAt ? { lastSyncAt: f.lastSyncAt } : {}),
      ...(this.error ? { error: this.error } : {}),
      conflicts,
      skipped: [...this.skipped].map(([category, reason]) => ({ category, reason })),
      reconnect: f && categories['integrations-list'] && this.enabled() ? [...f.hints] : [],
      hasRecoveryKey: !!(recovery && this.o.secrets.get(recovery)),
    };
  }

  private emit(): void {
    try {
      this.o.onStatus(this.status());
    } catch (e) {
      this.o.log?.(`sync status listener failed: ${(e as Error).message}`);
    }
  }

  // ---- persisted state -----------------------------------------------------------------------------

  private accountKey(): string {
    return `${this.o.http.serverUrl()}|${this.o.http.me()?.id ?? ''}`;
  }

  private stateFile(): SyncStateFile {
    const dir = this.o.profileDir();
    if (!this.file || this.fileDir !== dir) {
      const r = readJson<SyncStateFile>(path.join(dir, STATE_FILE));
      this.file =
        r.kind === 'ok' && r.value?.v === 1 && r.value.categories
          ? { ...r.value, hints: Array.isArray(r.value.hints) ? r.value.hints : [] }
          : { v: 1, deviceId: randomUUID(), categories: {}, hints: [] };
      this.fileDir = dir;
    }
    const account = this.accountKey();
    if (this.file.account !== account) {
      this.file = { v: 1, account, deviceId: this.file.deviceId, categories: {}, hints: [] };
    }
    return this.file;
  }

  private saveState(): void {
    if (!this.file || !this.fileDir) return;
    writeFileAtomic(path.join(this.fileDir, STATE_FILE), `${JSON.stringify(this.file)}\n`);
  }

  private cat(c: SyncDataCategory): CategoryState {
    const f = this.stateFile();
    return (f.categories[c] ??= { version: 0, base: {}, local: {}, observed: false });
  }

  /** Reconnect hints (integrations-list adapter storage). */
  readonly hints = {
    get: (): ReconnectHint[] => (this.available() ? this.stateFile().hints : []),
    set: (hints: ReconnectHint[]): void => {
      if (!this.available()) return;
      this.stateFile().hints = hints;
      this.saveState();
      this.emit();
    },
  };

  // ---- keys ----------------------------------------------------------------------------------------

  private userId(): string {
    const me = this.o.http.me();
    if (!me) throw new CloudError('signed_out', 'Sign in to GitHappens Cloud first.');
    return me.id;
  }

  private forgetDekInMemory(): void {
    this.dek = null;
    this.keyId = null;
    this.keyState = 'unknown';
  }

  private forgetDek(): void {
    const slot = this.o.http.sessionSecretAccount(DEK_SLOT);
    if (slot) this.o.secrets.delete(slot);
    const rec = this.o.http.sessionSecretAccount(RECOVERY_SLOT);
    if (rec) this.o.secrets.delete(rec);
    this.forgetDekInMemory();
  }

  private cacheDek(dek: Buffer, recoveryKey?: string): void {
    this.dek = dek;
    this.keyId = keyIdOf(dek);
    this.keyState = 'unlocked';
    const f = this.stateFile();
    if (f.keyId !== this.keyId) {
      for (const cs of Object.values(f.categories)) {
        cs.version = 0;
        cs.base = {};
        delete cs.pending;
      }
      f.keyId = this.keyId;
      this.saveState();
    }
    const slot = this.o.http.sessionSecretAccount(DEK_SLOT);
    if (slot) this.o.secrets.set(slot, JSON.stringify({ k: dek.toString('base64url'), id: this.keyId }));
    const rec = this.o.http.sessionSecretAccount(RECOVERY_SLOT);
    if (rec && recoveryKey) this.o.secrets.set(rec, recoveryKey);
  }

  private loadCachedDek(): boolean {
    if (this.dek) return true;
    const slot = this.o.http.sessionSecretAccount(DEK_SLOT);
    const raw = slot ? this.o.secrets.get(slot) : null;
    if (!raw) return false;
    try {
      const { k } = JSON.parse(raw) as { k: string };
      const dek = Buffer.from(k, 'base64url');
      if (dek.length !== 32) return false;
      this.dek = dek;
      this.keyId = keyIdOf(dek);
      this.keyState = 'unlocked';
      return true;
    } catch {
      return false;
    }
  }

  private async fetchKeys(): Promise<{ doc: SyncKeysDoc; version: number } | null> {
    try {
      const { data } = await this.o.http.request<SyncItem>('GET', '/v1/sync/_keys');
      return { doc: decodeKeysDoc(data), version: data.version };
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  private async putKeys(doc: SyncKeysDoc, ifMatch: number): Promise<void> {
    const { data } = await this.o.http.request<{ version: number }>('PUT', '/v1/sync/_keys', {
      body: encodeKeysDoc(doc, this.stateFile().deviceId),
      headers: { 'If-Match': String(ifMatch) },
    });
    this.stateFile().keysVersion = data.version;
    this.saveState();
  }

  /** Cached DEK, else find out whether keys exist (missing) or need a passphrase (locked). */
  private async ensureKeys(): Promise<boolean> {
    if (this.loadCachedDek()) return true;
    const keys = await this.fetchKeys();
    this.keyState = keys ? 'locked' : 'missing';
    this.state = 'locked';
    this.error = undefined;
    return false;
  }

  private requirePassphrase(passphrase: string): void {
    if (typeof passphrase !== 'string' || passphrase.length < 8) {
      throw new Error('Use a sync passphrase of at least 8 characters.');
    }
  }

  async setupPassphrase(passphrase: string): Promise<{ recoveryKey: string | null }> {
    this.requirePassphrase(passphrase);
    return this.enqueue(async () => {
      const userId = this.userId();
      const existing = await this.fetchKeys();
      if (existing) {
        if (!this.loadCachedDek() || existing.doc.keyId !== this.keyId) {
          throw new Error(
            'Sync is already set up from another computer. Unlock it with that passphrase or your recovery key, or reset sync data.',
          );
        }
        const doc = await rewrapPassphrase(existing.doc, this.dek!, passphrase, userId);
        await this.putKeys(doc, existing.version);
        this.emit();
        return { recoveryKey: null };
      }
      const created = await createSyncKeys(passphrase, userId, this.o.kdf);
      try {
        await this.putKeys(created.doc, 0);
      } catch (e) {
        if (isPrecondition(e)) {
          throw new Error('Sync was just set up from another computer. Unlock it with that passphrase.', {
            cause: e,
          });
        }
        throw e;
      }
      this.cacheDek(created.dek, created.recoveryKey);
      if (!this.enabled()) this.o.settings.set('sync.enabled', true);
      this.reevaluate(true);
      return { recoveryKey: created.recoveryKey };
    });
  }

  async unlock(input: { passphrase?: string; recoveryKey?: string }): Promise<SyncStatus> {
    await this.enqueue(async () => {
      const userId = this.userId();
      const keys = await this.fetchKeys();
      if (!keys) {
        this.keyState = 'missing';
        throw new Error('No sync data exists yet — set up a sync passphrase instead.');
      }
      // Wrong passphrase / key: throw, never touch local or server data.
      const dek = input.recoveryKey
        ? unlockWithRecoveryKey(keys.doc, input.recoveryKey, userId)
        : await unlockWithPassphrase(keys.doc, input.passphrase ?? '', userId);
      this.cacheDek(dek, input.recoveryKey?.trim() || undefined);
      this.stateFile().keysVersion = keys.version;
      this.saveState();
      this.error = undefined;
      this.state = 'idle';
    });
    this.reevaluate(true);
    await this.idle();
    return this.status();
  }

  async exportRecoveryKey(regenerate = false): Promise<{ recoveryKey: string }> {
    return this.enqueue(async () => {
      const rec = this.o.http.sessionSecretAccount(RECOVERY_SLOT);
      const stored = rec ? this.o.secrets.get(rec) : null;
      if (stored && !regenerate) return { recoveryKey: stored };
      if (!this.loadCachedDek()) throw new Error('Unlock sync first.');
      const keys = await this.fetchKeys();
      if (!keys || keys.doc.keyId !== this.keyId)
        throw new Error('Sync keys changed on the server; unlock again.');
      const next = rewrapRecovery(keys.doc, this.dek!, this.userId());
      await this.putKeys(next.doc, keys.version);
      if (rec) this.o.secrets.set(rec, next.recoveryKey);
      this.emit();
      return { recoveryKey: next.recoveryKey };
    });
  }

  /** Lost passphrase: wipe server sync data, create new keys, re-upload everything from here. */
  async reset(passphrase: string): Promise<{ recoveryKey: string }> {
    this.requirePassphrase(passphrase);
    const out = await this.enqueue(async () => {
      const userId = this.userId();
      await this.o.http.request('DELETE', '/v1/sync');
      this.resetCategories();
      this.forgetDek();
      const created = await createSyncKeys(passphrase, userId, this.o.kdf);
      await this.putKeys(created.doc, 0);
      this.cacheDek(created.dek, created.recoveryKey);
      return { recoveryKey: created.recoveryKey };
    });
    if (!this.enabled()) this.o.settings.set('sync.enabled', true);
    this.reevaluate(true);
    return out;
  }

  /** Danger zone: delete all synced data on the server and turn sync off. */
  async deleteCloudData(): Promise<SyncStatus> {
    await this.enqueue(async () => {
      await this.o.http.request('DELETE', '/v1/sync');
      this.resetCategories();
      this.forgetDek();
      this.keyState = 'missing';
    });
    if (this.enabled()) this.o.settings.set('sync.enabled', false);
    this.reevaluate();
    return this.status();
  }

  private resetCategories(): void {
    const f = this.stateFile();
    f.categories = {};
    delete f.keysVersion;
    delete f.lastSyncAt;
    this.skipped.clear();
    this.saveState();
  }

  // ---- public actions -----------------------------------------------------------------------------

  async syncNow(): Promise<SyncStatus> {
    if (!this.available()) throw new CloudError('signed_out', 'Sign in to GitHappens Cloud first.');
    if (!this.enabled()) throw new Error('Turn on settings sync first.');
    await this.enqueue(() => this.pullAll());
    return this.status();
  }

  setEnabled(req: {
    enabled?: boolean;
    categories?: Partial<Record<SyncDataCategory, boolean>>;
  }): SyncStatus {
    for (const [c, on] of Object.entries(req.categories ?? {})) {
      const key = CATEGORY_SETTING[c as SyncDataCategory];
      if (key && typeof on === 'boolean') this.o.settings.set(key, on);
    }
    if (typeof req.enabled === 'boolean') this.o.settings.set('sync.enabled', req.enabled);
    return this.status();
  }

  async resolveConflict(category: SyncDataCategory, keep: 'local' | 'remote'): Promise<SyncStatus> {
    const src = this.o.sources.find((s) => s.category === category);
    if (!src) throw new Error(`Unknown sync category "${category}".`);
    await this.enqueue(() => this.run(() => this.syncCategory(src, -1, keep)));
    return this.status();
  }

  dismissReconnect(key: string): SyncStatus {
    this.hints.set(this.hints.get().filter((h) => h.key !== key));
    return this.status();
  }

  // ---- sync ----------------------------------------------------------------------------------------

  /** Run one unit of sync work with status bookkeeping and error mapping. */
  private async run(fn: () => Promise<void>): Promise<void> {
    this.busy++;
    this.emit();
    try {
      await fn();
      this.state = this.isLocked() ? 'locked' : 'idle';
      this.error = undefined;
    } catch (e) {
      await this.handleError(e);
      if (this.isLocked()) this.state = 'locked';
    } finally {
      this.busy--;
      this.emit();
    }
  }

  private isLocked(): boolean {
    return !this.dek && (this.keyState === 'locked' || this.keyState === 'missing');
  }

  private async handleError(e: unknown): Promise<void> {
    if (e instanceof SyncKeyError && e.code === 'decrypt') {
      // Another computer may have reset sync data (new key) → ask for the passphrase again.
      const keys = await this.fetchKeys().catch(() => undefined);
      if (keys === null || (keys && keys.doc.keyId !== this.keyId)) {
        this.forgetDek();
        this.keyState = keys ? 'locked' : 'missing';
        this.state = 'locked';
        this.error = 'Sync data was reset on another computer. Enter the sync passphrase again.';
        return;
      }
    }
    this.state = 'error';
    this.error =
      e instanceof CloudError && e.code === 'network'
        ? `Offline — will retry. ${e.message}`
        : e instanceof Error
          ? e.message
          : String(e);
    this.o.log?.(`sync failed: ${this.error}`);
  }

  private async pullAll(): Promise<void> {
    if (!this.active) return;
    await this.run(async () => {
      if (!(await this.ensureKeys())) return;
      const { data } = await this.o.http.request<SyncCategoryInfo[]>('GET', '/v1/sync');
      const infos = new Map((Array.isArray(data) ? data : []).map((i) => [i.category, i]));
      const f = this.stateFile();
      const keysInfo = infos.get('_keys');
      if (!keysInfo) {
        this.forgetDek();
        this.keyState = 'missing';
        throw new SyncKeyError('bad_keys', 'Sync data was deleted. Set up a sync passphrase to sync again.');
      }
      // Versions restart after a reset elsewhere, so compare the key id itself (tiny document).
      const keys = await this.fetchKeys();
      if (!keys || keys.doc.keyId !== this.keyId) {
        this.forgetDek();
        this.keyState = keys ? 'locked' : 'missing';
        throw new SyncKeyError(
          'bad_keys',
          'Sync data was reset on another computer. Enter the sync passphrase again.',
        );
      }
      f.keysVersion = keys.version;
      for (const src of this.o.sources) {
        if (!this.categoryEnabled(src.category)) continue;
        await this.syncCategory(src, infos.get(src.category)?.version ?? 0);
      }
      f.lastSyncAt = new Date(this.now()).toISOString();
      this.lastPullAt = this.now();
      this.saveState();
    });
  }

  /** Observe local data → keyed items with change stamps. */
  private async localItems(src: SyncSource, cs: CategoryState): Promise<SyncItems> {
    const data = await src.read();
    const now = this.now();
    const stamp = cs.observed ? now : 0;
    const items: SyncItems = {};
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      const h = hashValue(v);
      if (cs.local[k]?.h !== h) cs.local[k] = { h, at: stamp };
      items[k] = { v, at: cs.local[k]!.at };
    }
    for (const [k, p] of Object.entries(cs.local)) {
      if (Object.hasOwn(items, k)) continue;
      if (p.h !== DEL) cs.local[k] = { h: DEL, at: stamp };
      items[k] = { del: true, at: cs.local[k]!.at };
    }
    cs.observed = true;
    const pruned = pruneTombstones(items, now);
    for (const k of Object.keys(cs.local)) if (!pruned[k]) delete cs.local[k];
    return pruned;
  }

  private async applyLocal(src: SyncSource, cs: CategoryState, merged: SyncItems): Promise<void> {
    await src.write(liveValues(merged));
    cs.local = {};
    for (const [k, e] of Object.entries(merged)) cs.local[k] = { h: e.del ? DEL : hashValue(e.v), at: e.at };
  }

  private async fetchCategory(
    src: SyncSource,
  ): Promise<{ version: number; items: SyncItems } | null | 'skip'> {
    let item: SyncItem;
    try {
      item = (await this.o.http.request<SyncItem>('GET', `/v1/sync/${src.category}`)).data;
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
    const doc = decryptCategory(this.dek!, src.category, item) as SyncDoc;
    if (!doc || doc.v !== 1 || typeof doc.items !== 'object' || doc.items === null) {
      this.skipped.set(src.category, `Synced ${SYNC_CATEGORY_LABELS[src.category]} are unreadable.`);
      return 'skip';
    }
    if (doc.schema > src.schema) {
      this.skipped.set(
        src.category,
        `Update the app to sync ${SYNC_CATEGORY_LABELS[src.category]} (written by a newer version).`,
      );
      return 'skip';
    }
    this.skipped.delete(src.category);
    return { version: item.version, items: doc.items };
  }

  /**
   * Sync one category. `remoteVersion`: server version from the list (pull), `undefined` for a
   * local-change push, `-1` to force a fetch (conflict resolution with `prefer`).
   */
  private async syncCategory(
    src: SyncSource,
    remoteVersion: number | undefined,
    prefer?: 'local' | 'remote',
  ): Promise<void> {
    if (!this.dek) return;
    const cs = this.cat(src.category);
    if (remoteVersion === 0 && cs.version > 0) {
      // Removed on the server (e.g. reset elsewhere): upload ours as new.
      cs.version = 0;
      cs.base = {};
    }
    let needFetch = prefer !== undefined || (remoteVersion !== undefined && remoteVersion !== cs.version);
    for (let attempt = 0; attempt < 4; attempt++) {
      const local = await this.localItems(src, cs);
      let target = local;
      let expected = cs.version;
      let serverItems: SyncItems | null = cs.version > 0 ? cs.base : null;
      if (needFetch) {
        const remote = await this.fetchCategory(src);
        if (remote === 'skip') return;
        if (remote) {
          const { merged, conflicts } = merge3(cs.base, local, remote.items, src.strategy, prefer);
          if (conflicts.length) {
            cs.pending = { keys: conflicts };
            this.saveState();
            return;
          }
          if (!sameItems(merged, local)) await this.applyLocal(src, cs, merged);
          target = merged;
          expected = remote.version;
          serverItems = remote.items;
        } else {
          expected = 0;
          serverItems = null;
          cs.base = {};
        }
      }
      delete cs.pending;
      if (serverItems && sameItems(target, serverItems)) {
        cs.version = expected;
        cs.base = target;
        this.saveState();
        return;
      }
      const doc: SyncDoc = { v: 1, category: src.category, schema: src.schema, items: target };
      try {
        const { data } = await this.o.http.request<{ version: number }>('PUT', `/v1/sync/${src.category}`, {
          body: encryptCategory(this.dek, src.category, doc, this.stateFile().deviceId),
          headers: { 'If-Match': String(expected) },
        });
        cs.version = data.version;
        cs.base = target;
        this.saveState();
        return;
      } catch (e) {
        if (!isPrecondition(e)) throw e;
        needFetch = true; // someone else wrote meanwhile → merge and retry
      }
    }
    throw new Error(`Could not sync ${SYNC_CATEGORY_LABELS[src.category]}: the server kept changing.`);
  }
}
