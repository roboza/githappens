import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

import type { ProfileMeta, SettingsChange, SettingsSnapshot } from '../../shared/ipc/app-contract';
import { parseKeybindingOverrides, type KeybindingOverride } from '../../shared/settings/keybindings';
import {
  defaultValues,
  descriptors,
  isSettingKey,
  RENAMED_SETTINGS,
  SETTING_KEYS,
  SETTINGS,
  validateSetting,
  type SettingKey,
  type SettingScope,
  type SettingsValues,
  type SettingValue,
} from '../../shared/settings/registry';
import { backupCorrupt, readJson, writeFileAtomic } from './atomic-file';

/**
 * Settings storage (spec 13 §5.1):
 *   app.json                         AppFile (app-scope values, active/default profile)
 *   profiles/index.json              ProfileMeta[]
 *   profiles/<id>/settings.json      SettingsFile (sparse: only non-default values)
 *   profiles/<id>/keybindings.json   KeybindingOverride[]
 *   profiles/.trash/<id>-<ts>/       deleted profiles (kept for manual recovery)
 */

export const SETTINGS_FILE_VERSION = 1;

interface SettingsFile {
  version: number;
  values: Record<string, unknown>;
  /** Set in memory when migrations ran, so the file is rewritten at the current version. */
  migrated?: boolean;
}
interface AppFile extends SettingsFile {
  activeProfileId?: string;
  defaultProfileId?: string;
}

/** Ordered migrations: index i upgrades version i+1 → i+2. */
export type Migration = (values: Record<string, unknown>) => Record<string, unknown>;

export interface SettingsStoreOptions {
  dir: string;
  /** Reports recoverable problems (corrupt file, invalid value) to the UI as toasts. */
  onWarning?: (message: string) => void;
  /** Identity for the auto-created "Default" profile (from `git config --global`). */
  defaultIdentity?: () => { name?: string; email?: string };
  migrations?: Migration[];
  /** Current file format version (defaults to SETTINGS_FILE_VERSION; injectable for tests). */
  fileVersion?: number;
  /** Called after a profile was deleted, e.g. to clear its secrets (`<id>/` prefix). */
  onProfileDeleted?: (id: string) => void | Promise<void>;
  /**
   * Writes `git config --global user.name/user.email`. Called on switch / edit for profiles
   * with `syncGitConfig` (spec 13 §6 "Profile git identity sync").
   */
  setGlobalIdentity?: (name: string, email: string) => void | Promise<void>;
}

export type ProfileHooks = Pick<SettingsStoreOptions, 'onProfileDeleted' | 'setGlobalIdentity'>;

export interface CreateProfileInput {
  name: string;
  authorName?: string;
  authorEmail?: string;
  syncGitConfig?: boolean;
  avatarSource?: ProfileMeta['avatarSource'];
  /** Copy settings, keybindings, tabs, repos and per-repo state from this profile (never secrets). */
  duplicateFrom?: string;
}

export type ProfilePatch = Partial<Omit<ProfileMeta, 'id' | 'createdAt'>>;

export interface ProfilesState {
  profiles: ProfileMeta[];
  activeId: string;
  defaultId: string;
}

/** Files and folders copied when duplicating a profile. */
const DUPLICATED_ENTRIES = [
  'settings.json',
  'keybindings.json',
  'tabs.json',
  'layout.json',
  'repos.json',
  'repo-settings',
  'repo-ui',
];

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+$/;

const scopeOf = (key: SettingKey): SettingScope => SETTINGS[key].scope;
const isDefault = (key: SettingKey, value: unknown): boolean =>
  JSON.stringify(value) === JSON.stringify(SETTINGS[key].default);

export class SettingsStore extends EventEmitter<{
  changed: [SettingsChange];
  /** Emitted after the active profile changed and its settings were loaded. */
  profileSwitched: [ProfileMeta];
  /** Emitted after any profile list / metadata change. */
  profilesChanged: [ProfilesState];
  /** Emitted after `writeKeybindings` saved the active profile's overrides (settings sync). */
  keybindingsChanged: [KeybindingOverride[]];
}> {
  private values: SettingsValues = defaultValues();
  private appSparse: Record<string, unknown> = {};
  private profileSparse: Record<string, unknown> = {};
  /** Unknown keys are preserved on write (forward compatibility) but ignored. */
  private appUnknown: Record<string, unknown> = {};
  private profileUnknown: Record<string, unknown> = {};
  private profiles: ProfileMeta[] = [];
  private activeProfileId = '';
  private defaultProfileId = '';
  /** Files whose `version` is newer than this build understands → store is read-only (spec 13 §8). */
  private newerFiles = new Map<string, number>();
  /** Last text this store wrote per file, so the watcher ignores our own writes. */
  private lastWritten = new Map<string, string>();
  private watchers: fs.FSWatcher[] = [];
  private watchTimer: NodeJS.Timeout | null = null;

  constructor(private readonly o: SettingsStoreOptions) {
    super();
  }

  private get version(): number {
    return this.o.fileVersion ?? SETTINGS_FILE_VERSION;
  }

  private get appFile(): string {
    return path.join(this.o.dir, 'app.json');
  }
  private get indexFile(): string {
    return path.join(this.o.dir, 'profiles', 'index.json');
  }
  private profileFile(id = this.activeProfileId): string {
    return path.join(this.profileDir(id), 'settings.json');
  }

  /** `profiles/<id>` folder (tabs, repos, keybindings, … live here). */
  profileDir(id = this.activeProfileId): string {
    return path.join(this.o.dir, 'profiles', id);
  }

  /** Install / replace the profile lifecycle callbacks after construction. */
  setHooks(hooks: ProfileHooks): void {
    if (hooks.onProfileDeleted) this.o.onProfileDeleted = hooks.onProfileDeleted;
    if (hooks.setGlobalIdentity) this.o.setGlobalIdentity = hooks.setGlobalIdentity;
  }

  load(): void {
    const app = this.readSettingsFile<AppFile>(this.appFile);
    this.appSparse = {};
    this.appUnknown = {};
    this.absorb(app.values, 'app', this.appSparse, this.appUnknown);

    this.profiles = this.readProfiles();
    if (this.profiles.length === 0) this.profiles.push(this.createDefaultProfile());
    const ids = new Set(this.profiles.map((p) => p.id));
    this.defaultProfileId =
      app.defaultProfileId && ids.has(app.defaultProfileId) ? app.defaultProfileId : this.profiles[0]!.id;
    this.activeProfileId =
      app.activeProfileId && ids.has(app.activeProfileId) ? app.activeProfileId : this.defaultProfileId;
    if (
      !this.readOnlyReason &&
      (app.migrated ||
        app.activeProfileId !== this.activeProfileId ||
        app.defaultProfileId !== this.defaultProfileId)
    ) {
      this.writeApp();
    }
    this.loadProfileValues();
  }

  private loadProfileValues(): void {
    const prof = this.readSettingsFile<SettingsFile>(this.profileFile());
    this.profileSparse = {};
    this.profileUnknown = {};
    this.absorb(prof.values, 'profile', this.profileSparse, this.profileUnknown);
    if (prof.migrated && !this.readOnlyReason) this.persist('profile');
    this.values = { ...defaultValues(), ...this.appSparse, ...this.profileSparse } as SettingsValues;
  }

  /**
   * Why settings are read-only (a file was written by a newer app version — spec 13 §8 "don't
   * downgrade-write"), or null when writable.
   */
  get readOnlyReason(): string | null {
    if (this.newerFiles.size === 0) return null;
    const v = Math.max(...this.newerFiles.values());
    return `Settings were saved by a newer version of GitHappens (format ${v}; this version understands ${this.version}). They are read-only here so nothing is downgraded — update GitHappens to change them.`;
  }

  private assertWritable(): void {
    const reason = this.readOnlyReason;
    if (reason) throw new Error(reason);
  }

  /** Path of the active profile's `settings.json`. */
  settingsFilePath(): string {
    return this.profileFile();
  }

  /** Current file format version written by this build. */
  get fileVersion(): number {
    return this.version;
  }

  get<K extends SettingKey>(key: K): SettingValue<K> {
    return this.values[key];
  }

  snapshot(): SettingsSnapshot {
    return { values: structuredClone(this.values), profile: this.activeProfile, registry: descriptors() };
  }

  get activeProfile(): ProfileMeta {
    return this.profiles.find((p) => p.id === this.activeProfileId)!;
  }

  listProfiles(): ProfileMeta[] {
    return this.profiles.map((p) => ({ ...p }));
  }

  profilesState(): ProfilesState {
    return {
      profiles: this.listProfiles(),
      activeId: this.activeProfileId,
      defaultId: this.defaultProfileId,
    };
  }

  getProfile(id: string): ProfileMeta | undefined {
    const p = this.profiles.find((x) => x.id === id);
    return p ? { ...p } : undefined;
  }

  set(key: string, value: unknown): void {
    if (!isSettingKey(key)) throw new Error(`Unknown setting "${key}"`);
    const v = validateSetting(key, value);
    if (!v.ok) throw new Error(`Invalid value for "${key}": ${v.error}`);
    if (JSON.stringify(this.values[key]) === JSON.stringify(v.value)) return;
    this.assertWritable();
    const scope = scopeOf(key);
    const sparse = scope === 'app' ? this.appSparse : this.profileSparse;
    if (isDefault(key, v.value)) delete sparse[key];
    else sparse[key] = v.value;
    (this.values as Record<string, unknown>)[key] = v.value;
    this.persist(scope);
    this.emit('changed', { key, value: v.value, scope });
  }

  /** Reset one key, or every key when omitted. */
  reset(key?: string): void {
    if (key !== undefined && !isSettingKey(key)) throw new Error(`Unknown setting "${key}"`);
    const keys = key ? [key as SettingKey] : SETTING_KEYS;
    for (const k of keys) this.set(k, structuredClone(SETTINGS[k].default));
  }

  // ---- profiles (spec 13 §4.3, §7 step 5) ---------------------------------------------------------

  createProfile(input: CreateProfileInput): ProfileMeta {
    this.assertWritable();
    const src = input.duplicateFrom ? this.requireProfile(input.duplicateFrom) : undefined;
    const id = randomUUID();
    const patch = this.validatedPatch(
      {
        name: input.name,
        authorName: input.authorName ?? src?.authorName ?? '',
        authorEmail: input.authorEmail ?? src?.authorEmail ?? '',
        syncGitConfig: input.syncGitConfig ?? src?.syncGitConfig ?? false,
        avatarSource: input.avatarSource ?? src?.avatarSource ?? 'gravatar',
      },
      id,
    );
    const meta: ProfileMeta = {
      id,
      name: patch.name!,
      authorName: patch.authorName ?? '',
      authorEmail: patch.authorEmail ?? '',
      syncGitConfig: patch.syncGitConfig ?? false,
      avatarSource: patch.avatarSource ?? 'gravatar',
      createdAt: Date.now(),
    };
    const dir = this.profileDir(id);
    fs.mkdirSync(dir, { recursive: true });
    if (src) {
      const from = this.profileDir(src.id);
      for (const entry of DUPLICATED_ENTRIES) {
        const p = path.join(from, entry);
        if (fs.existsSync(p)) fs.cpSync(p, path.join(dir, entry), { recursive: true });
      }
    }
    this.profiles.push(meta);
    this.writeIndex();
    this.emitProfiles();
    return { ...meta };
  }

  /** Update name / identity / sync flag. Re-syncs the global git identity of the active profile. */
  updateProfile(id: string, patch: ProfilePatch): ProfileMeta {
    this.assertWritable();
    const p = this.requireProfile(id);
    const before = { ...p };
    Object.assign(p, this.validatedPatch(patch, id));
    this.writeIndex();
    this.emitProfiles();
    const identityChanged =
      before.authorName !== p.authorName ||
      before.authorEmail !== p.authorEmail ||
      (!before.syncGitConfig && p.syncGitConfig);
    if (id === this.activeProfileId && p.syncGitConfig && identityChanged) this.syncIdentity(p);
    return { ...p };
  }

  /** Delete a profile (never the active or last one). Its folder moves to `profiles/.trash`. */
  async deleteProfile(id: string): Promise<void> {
    this.assertWritable();
    this.requireProfile(id);
    if (this.profiles.length <= 1) throw new Error('The last profile cannot be deleted.');
    if (id === this.activeProfileId) throw new Error('Switch to another profile before deleting this one.');
    const dir = this.profileDir(id);
    if (fs.existsSync(dir)) {
      const trash = path.join(this.o.dir, 'profiles', '.trash');
      fs.mkdirSync(trash, { recursive: true });
      const dest = path.join(trash, `${id}-${Date.now()}`);
      try {
        fs.renameSync(dir, dest);
      } catch {
        fs.cpSync(dir, dest, { recursive: true });
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
    this.profiles = this.profiles.filter((x) => x.id !== id);
    if (this.defaultProfileId === id) this.defaultProfileId = this.activeProfileId;
    this.writeIndex();
    this.writeApp();
    this.emitProfiles();
    await this.o.onProfileDeleted?.(id);
  }

  /**
   * Make `id` the active profile: load its settings, emit `changed` for every key whose value
   * differs, sync the git identity if enabled, then emit `profileSwitched`.
   */
  switchProfile(id: string): ProfileMeta {
    const p = this.requireProfile(id);
    if (id === this.activeProfileId) return { ...p };
    this.assertWritable();
    const before = this.values;
    this.activeProfileId = id;
    this.writeApp();
    this.loadProfileValues();
    this.emitDiffs(before);
    if (this.watchers.length) this.watch();
    if (p.syncGitConfig) this.syncIdentity(p);
    this.emitProfiles();
    this.emit('profileSwitched', { ...p });
    return { ...p };
  }

  /** Profile opened on startup when the last active one is missing. */
  setDefaultProfile(id: string): void {
    this.assertWritable();
    this.requireProfile(id);
    this.defaultProfileId = id;
    this.writeApp();
    this.emitProfiles();
  }

  // ---- keybindings (spec 13 §7 step 9) -----------------------------------------------------------

  readKeybindings(id = this.activeProfileId): KeybindingOverride[] {
    const file = path.join(this.profileDir(id), 'keybindings.json');
    const r = readJson(file);
    if (r.kind === 'missing') return [];
    const parsed = r.kind === 'ok' ? parseKeybindingOverrides(r.value) : null;
    if (parsed?.ok) return parsed.value;
    backupCorrupt(file);
    this.o.onWarning?.(
      `Keybindings file was invalid and has been reset${parsed && !parsed.ok ? ` (${parsed.error})` : ''}.`,
    );
    return [];
  }

  writeKeybindings(overrides: unknown, id = this.activeProfileId): KeybindingOverride[] {
    this.requireProfile(id);
    const parsed = parseKeybindingOverrides(overrides);
    if (!parsed.ok) throw new Error(`Invalid keybindings: ${parsed.error}`);
    this.assertWritable();
    this.write(
      path.join(this.profileDir(id), 'keybindings.json'),
      `${JSON.stringify(parsed.value, null, 2)}\n`,
    );
    if (id === this.activeProfileId) this.emit('keybindingsChanged', parsed.value);
    return parsed.value;
  }

  // ---- settings.json: external edits, in-app editor, export / import (spec 13 §4.2 Advanced, §8) ----

  /**
   * Watch `app.json` and the active profile's `settings.json` for external edits (debounced). Our
   * own writes are ignored; unreadable / invalid files are ignored with a warning (never reset).
   */
  watch(debounceMs = 300): void {
    this.unwatch();
    const onEvent = (name: string | Buffer | null, expected: string): void => {
      if (name !== null && String(name) !== expected) return;
      if (this.watchTimer) clearTimeout(this.watchTimer);
      this.watchTimer = setTimeout(() => {
        this.watchTimer = null;
        this.reloadIfChangedExternally();
      }, debounceMs);
    };
    const add = (dir: string, expected: string): void => {
      try {
        fs.mkdirSync(dir, { recursive: true });
        const w = fs.watch(dir, { persistent: false }, (_e, name) => onEvent(name, expected));
        w.on('error', () => undefined);
        this.watchers.push(w);
      } catch {
        /* watching is best effort (network drives, exotic file systems) */
      }
    };
    add(this.o.dir, 'app.json');
    add(this.profileDir(), 'settings.json');
  }

  unwatch(): void {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = null;
  }

  private reloadIfChangedExternally(): void {
    const changed = [this.appFile, this.profileFile()].some((f) => {
      let text: string | null;
      try {
        text = fs.readFileSync(f, 'utf8');
      } catch {
        text = null;
      }
      return text !== null && text !== this.lastWritten.get(f);
    });
    if (changed) this.reloadFromDisk();
  }

  /**
   * Re-read `app.json` + the active profile's `settings.json` after an external edit and emit
   * `changed` for every value that differs. Returns false (with a warning) when a file is not
   * valid JSON / not a settings file; in-memory values are kept and nothing is overwritten.
   */
  reloadFromDisk(): boolean {
    const read = (file: string): SettingsFile | string => {
      const r = readJson<SettingsFile>(file);
      if (r.kind === 'missing') return { version: this.version, values: {} };
      if (r.kind === 'corrupt') return r.error;
      const shape = settingsFileShapeError(r.value);
      return shape ?? r.value;
    };
    const app = read(this.appFile);
    const prof = read(this.profileFile());
    for (const [label, res] of [
      ['app.json', app],
      ['settings.json', prof],
    ] as const) {
      if (typeof res === 'string') {
        this.o.onWarning?.(`Ignored the edited ${label} because it is not valid: ${res}`);
        return false;
      }
    }
    const a = app as SettingsFile;
    const p = prof as SettingsFile;
    for (const [file, data] of [
      [this.appFile, a],
      [this.profileFile(), p],
    ] as const) {
      if (Number.isInteger(data.version) && data.version > this.version)
        this.newerFiles.set(file, data.version);
      else this.newerFiles.delete(file);
    }
    const before = this.values;
    this.appSparse = {};
    this.appUnknown = {};
    this.absorb(a.values ?? {}, 'app', this.appSparse, this.appUnknown);
    this.profileSparse = {};
    this.profileUnknown = {};
    this.absorb(p.values ?? {}, 'profile', this.profileSparse, this.profileUnknown);
    this.values = { ...defaultValues(), ...this.appSparse, ...this.profileSparse } as SettingsValues;
    this.emitDiffs(before);
    return true;
  }

  /** Text of the active profile's settings.json (a default document when it does not exist yet). */
  readProfileJson(): string {
    try {
      return fs.readFileSync(this.profileFile(), 'utf8');
    } catch {
      return `${JSON.stringify({ version: this.version, values: {} }, null, 2)}\n`;
    }
  }

  /**
   * Validate and save settings.json text from the in-app editor. Nothing is written when there are
   * problems; otherwise the profile values are replaced and `changed` emitted for every difference.
   */
  applyProfileJson(text: string): SettingsJsonProblem[] {
    const r = validateSettingsDocument(text, {
      fileVersion: this.version,
      knownUnknownKeys: new Set(Object.keys(this.profileUnknown)),
    });
    if (r.problems.length) return r.problems;
    this.assertWritable();
    const before = this.values;
    this.profileSparse = {};
    this.profileUnknown = {};
    for (const [k, v] of Object.entries(r.values)) {
      if (!isSettingKey(k)) this.profileUnknown[k] = v;
      else if (!isDefault(k, v)) this.profileSparse[k] = v;
    }
    this.values = { ...defaultValues(), ...this.appSparse, ...this.profileSparse } as SettingsValues;
    this.persist('profile');
    this.emitDiffs(before);
    return [];
  }

  /** Every value that differs from its default (both scopes), for settings export. */
  nonDefaultValues(): Record<string, unknown> {
    return structuredClone(sorted({ ...this.appSparse, ...this.profileSparse }));
  }

  /** Apply imported values key by key; unknown / invalid keys are skipped and reported. */
  importValues(values: Record<string, unknown>): { applied: number; skipped: SettingsJsonProblem[] } {
    this.assertWritable();
    const skipped: SettingsJsonProblem[] = [];
    let applied = 0;
    for (const [k, v] of Object.entries(values)) {
      const key = isSettingKey(k) ? k : RENAMED_SETTINGS[k];
      if (!key) {
        skipped.push({ key: k, message: 'Unknown setting' });
        continue;
      }
      const r = validateSetting(key, v);
      if (!r.ok) {
        skipped.push({ key: k, message: r.error });
        continue;
      }
      this.set(key, r.value);
      applied++;
    }
    return { applied, skipped };
  }

  private emitDiffs(before: SettingsValues): void {
    for (const key of SETTING_KEYS) {
      if (JSON.stringify(before[key]) !== JSON.stringify(this.values[key])) {
        this.emit('changed', { key, value: this.values[key], scope: scopeOf(key) });
      }
    }
  }

  // ---------------------------------------------------------------------------

  private requireProfile(id: string): ProfileMeta {
    const p = this.profiles.find((x) => x.id === id);
    if (!p) throw new Error(`Unknown profile "${id}"`);
    return p;
  }

  private validatedPatch(patch: ProfilePatch, id: string): ProfilePatch {
    const out: ProfilePatch = {};
    if (patch.name !== undefined) {
      const name = String(patch.name).trim();
      if (!name) throw new Error('Profile name is required.');
      if (name.length > 100) throw new Error('Profile name is too long.');
      if (this.profiles.some((x) => x.id !== id && x.name.toLowerCase() === name.toLowerCase())) {
        throw new Error(`A profile named "${name}" already exists.`);
      }
      out.name = name;
    }
    if (patch.authorName !== undefined) {
      const v = String(patch.authorName).trim();
      if (v.length > 200 || /[<>\n]/.test(v)) throw new Error('Author name is not valid.');
      out.authorName = v;
    }
    if (patch.authorEmail !== undefined) {
      const v = String(patch.authorEmail).trim();
      if (v && (!EMAIL_RE.test(v) || v.length > 254)) throw new Error('Author email is not valid.');
      out.authorEmail = v;
    }
    if (patch.syncGitConfig !== undefined) out.syncGitConfig = !!patch.syncGitConfig;
    if (patch.avatarSource !== undefined) {
      if (!['provider', 'gravatar', 'initials'].includes(patch.avatarSource)) {
        throw new Error('Invalid avatar source.');
      }
      out.avatarSource = patch.avatarSource;
    }
    return out;
  }

  private syncIdentity(p: ProfileMeta): void {
    const set = this.o.setGlobalIdentity;
    if (!p.authorName || !p.authorEmail || !set) return;
    Promise.resolve()
      .then(() => set(p.authorName, p.authorEmail))
      .catch((e: unknown) =>
        this.o.onWarning?.(
          `Could not update the global git identity: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
  }

  private emitProfiles(): void {
    this.emit('profilesChanged', this.profilesState());
  }

  private absorb(
    raw: Record<string, unknown>,
    scope: 'app' | 'profile',
    sparse: Record<string, unknown>,
    unknown: Record<string, unknown>,
  ): void {
    for (const [k, v] of Object.entries(raw)) {
      if (!isSettingKey(k)) {
        // removed key: carry its value over to the replacement unless that is stored too
        const to = RENAMED_SETTINGS[k];
        if (!to) unknown[k] = v;
        else if (!Object.hasOwn(raw, to) && scopeOf(to) === scope) {
          const r = validateSetting(to, v);
          if (r.ok) sparse[to] = r.value;
        }
        continue;
      }
      if (scopeOf(k) !== scope) continue;
      const r = validateSetting(k, v);
      if (r.ok) sparse[k] = r.value;
      else this.o.onWarning?.(`Ignored invalid setting "${k}": ${r.error}. Using the default.`);
    }
  }

  private readSettingsFile<T extends SettingsFile>(file: string): T {
    const r = readJson<T>(file);
    if (r.kind === 'missing') return { version: this.version, values: {} } as T;
    if (r.kind === 'corrupt' || typeof r.value !== 'object' || r.value === null) {
      const bak = backupCorrupt(file);
      this.o.onWarning?.(`Settings file was unreadable and has been reset. A backup was saved to ${bak}.`);
      return { version: this.version, values: {} } as T;
    }
    const data = r.value;
    let values = typeof data.values === 'object' && data.values !== null ? { ...data.values } : {};
    const from = Number.isInteger(data.version) ? data.version : this.version;
    if (from > this.version) {
      this.newerFiles.set(file, from);
      return { ...data, values, migrated: false };
    }
    this.newerFiles.delete(file);
    const migrations = this.o.migrations ?? [];
    for (let v = from; v < this.version; v++) {
      const m = migrations[v - 1];
      if (m) values = m(values);
    }
    return { ...data, version: this.version, values, migrated: from < this.version };
  }

  private readProfiles(): ProfileMeta[] {
    const r = readJson<ProfileMeta[]>(this.indexFile);
    if (r.kind === 'ok' && Array.isArray(r.value)) {
      return r.value.filter((p): p is ProfileMeta => typeof p?.id === 'string' && typeof p.name === 'string');
    }
    if (r.kind === 'corrupt') {
      backupCorrupt(this.indexFile);
      this.o.onWarning?.('The profile list was unreadable and has been reset.');
    }
    return [];
  }

  private createDefaultProfile(): ProfileMeta {
    const id = randomUUID();
    const ident = this.o.defaultIdentity?.() ?? {};
    const meta: ProfileMeta = {
      id,
      name: 'Default',
      authorName: ident.name ?? '',
      authorEmail: ident.email ?? '',
      syncGitConfig: false,
      avatarSource: 'gravatar',
      createdAt: Date.now(),
    };
    this.write(this.indexFile, `${JSON.stringify([meta], null, 2)}\n`);
    return meta;
  }

  private writeIndex(): void {
    this.write(this.indexFile, `${JSON.stringify(this.profiles, null, 2)}\n`);
  }

  private write(file: string, text: string): void {
    writeFileAtomic(file, text);
    this.lastWritten.set(file, text);
  }

  private persist(scope: SettingScope): void {
    if (scope === 'app') this.writeApp();
    else {
      const file: SettingsFile = {
        version: this.version,
        values: { ...this.profileUnknown, ...sorted(this.profileSparse) },
      };
      this.write(this.profileFile(), `${JSON.stringify(file, null, 2)}\n`);
    }
  }

  private writeApp(): void {
    const file: AppFile = {
      version: this.version,
      activeProfileId: this.activeProfileId,
      defaultProfileId: this.defaultProfileId,
      values: { ...this.appUnknown, ...sorted(this.appSparse) },
    };
    this.write(this.appFile, `${JSON.stringify(file, null, 2)}\n`);
  }
}

const sorted = (o: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

export interface SettingsJsonProblem {
  key?: string;
  message: string;
}

function settingsFileShapeError(data: unknown): string | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return 'expected a JSON object';
  const d = data as Record<string, unknown>;
  if (d.version !== undefined && !Number.isInteger(d.version)) return '"version" must be an integer';
  if (
    d.values !== undefined &&
    (typeof d.values !== 'object' || d.values === null || Array.isArray(d.values))
  ) {
    return '"values" must be an object';
  }
  return null;
}

/** `line:col` of a character offset (1-based), for JSON parse errors. */
function lineCol(text: string, offset: number): string {
  const before = text.slice(0, offset);
  const line = before.split('\n').length;
  return `${line}:${offset - before.lastIndexOf('\n')}`;
}

/**
 * Validate a profile `settings.json` document (spec 13 §7 step 16): JSON syntax, `{ version, values }`
 * shape, version not newer than this build, known profile-scope keys, each value against the registry.
 * Unknown keys already preserved in the file (`knownUnknownKeys`, e.g. from a newer build) are allowed.
 */
export function validateSettingsDocument(
  text: string,
  o: { fileVersion?: number; knownUnknownKeys?: ReadonlySet<string> } = {},
): { values: Record<string, unknown>; problems: SettingsJsonProblem[] } {
  const fileVersion = o.fileVersion ?? SETTINGS_FILE_VERSION;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    const msg = (e as Error).message;
    const pos = /position (\d+)/.exec(msg);
    return {
      values: {},
      problems: [{ message: `Invalid JSON${pos ? ` at ${lineCol(text, Number(pos[1]))}` : ''}: ${msg}` }],
    };
  }
  const shape = settingsFileShapeError(data);
  if (shape) return { values: {}, problems: [{ message: shape }] };
  const d = data as { version?: number; values?: Record<string, unknown> };
  const problems: SettingsJsonProblem[] = [];
  if (d.version !== undefined && d.version > fileVersion) {
    problems.push({
      message: `"version" ${d.version} is newer than this build understands (${fileVersion}).`,
    });
  }
  const values: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d.values ?? {})) {
    const key = isSettingKey(k) ? k : RENAMED_SETTINGS[k];
    if (!key) {
      if (o.knownUnknownKeys?.has(k)) values[k] = v;
      else problems.push({ key: k, message: `Unknown setting "${k}".` });
      continue;
    }
    if (scopeOf(key) !== 'profile') {
      problems.push({ key: k, message: `"${k}" is app-wide; change it in Preferences instead.` });
      continue;
    }
    const r = validateSetting(key, v);
    if (r.ok) values[key] = r.value;
    else problems.push({ key: k, message: `Invalid value for "${k}": ${r.error}` });
  }
  return { values, problems };
}
