import fs from 'node:fs';
import path from 'node:path';

import type { ItemUserState, SavedView } from '@githappens/launchpad';
import type { ConnectedIntegration } from '@githappens/providers/types';

import type { ReconnectHint, SyncDataCategory } from '../../../shared/ipc/cloud-contract';
import type { Workspace, WorkspaceRepo } from '../../../shared/ipc/workspaces-contract';
import type { KeybindingOverride } from '../../../shared/settings/keybindings';
import { SETTING_KEYS, SETTINGS, validateSetting, type SettingKey } from '../../../shared/settings/registry';
import { writeFileAtomic } from '../../settings/atomic-file';
import { normalizeRemoteUrl } from '../../workspaces/util';
import { sameValue } from './canonical';
import type { MergeStrategy } from './merge';

/**
 * Category adapters for settings sync (spec 14 §6.2). Each exposes local state as a keyed record
 * (`key → JSON value`) WITHOUT local paths, tokens, SSH key paths or terminal environment, and
 * applies a merged record back. The sync engine does stamping, merging and encryption.
 */
export interface SyncSource {
  readonly category: SyncDataCategory;
  /** 'lww' = per-key last-writer-wins; 'strict' = concurrent edits of one key are conflicts. */
  readonly strategy: MergeStrategy;
  /** Document schema written by this app; remote documents with a newer schema are skipped. */
  readonly schema: number;
  read(): Promise<Record<string, unknown>>;
  write(data: Record<string, unknown>): Promise<void>;
  onChange(cb: () => void): () => void;
}

// ---- preferences -----------------------------------------------------------------------------------

/** Machine-specific or sensitive settings that never sync (paths, commands, keys, proxies, consent). */
const NEVER_SYNC = new Set<string>([
  'git.executable',
  'terminal.shell',
  'terminal.shellArgs',
  'tools.customDiffCmd',
  'tools.customMergeCmd',
  'tools.editorPath',
  'tools.terminalCommand',
  'tools.agentCommand',
  'tools.agentArgs',
  'signing.gpgProgram',
  'signing.signingKey',
  'signing.allowedSignersFile',
  'ssh.privateKeyPath',
  'ssh.publicKeyPath',
  'network.proxyUrl',
  'network.caBundlePath',
  'general.defaultCloneDirectory',
  'ai.consent',
]);
const NEVER_SYNC_PREFIXES = ['cloud.', 'sync.', 'team.'];

export function isSyncablePreference(key: string): key is SettingKey {
  if (!Object.hasOwn(SETTINGS, key)) return false;
  const d = SETTINGS[key as SettingKey] as { scope: string; type: string };
  return (
    d.scope === 'profile' &&
    d.type !== 'path' &&
    !NEVER_SYNC.has(key) &&
    !NEVER_SYNC_PREFIXES.some((p) => key.startsWith(p))
  );
}

export const SYNCABLE_PREFERENCE_KEYS: readonly SettingKey[] = SETTING_KEYS.filter(isSyncablePreference);

export interface PreferencesStoreLike {
  get(key: SettingKey): unknown;
  set(key: string, value: unknown): void;
  on(event: 'changed', listener: (c: { key: string }) => void): unknown;
  off(event: 'changed', listener: (c: { key: string }) => void): unknown;
}

/** Non-default values of syncable profile settings (sparse; a missing key means "default"). */
export function preferencesSource(settings: PreferencesStoreLike, log?: (m: string) => void): SyncSource {
  return {
    category: 'preferences',
    strategy: 'lww',
    schema: 1,
    async read() {
      const out: Record<string, unknown> = {};
      for (const k of SYNCABLE_PREFERENCE_KEYS) {
        const v = settings.get(k);
        if (!sameValue(v, SETTINGS[k].default)) out[k] = v;
      }
      return out;
    },
    async write(data) {
      for (const k of SYNCABLE_PREFERENCE_KEYS) {
        const target = Object.hasOwn(data, k) ? data[k] : structuredClone(SETTINGS[k].default);
        if (sameValue(settings.get(k), target)) continue;
        const v = validateSetting(k, target);
        if (!v.ok) {
          log?.(`sync: ignored invalid synced value for ${k}`);
          continue;
        }
        try {
          settings.set(k, v.value);
        } catch (e) {
          log?.(`sync: could not apply ${k}: ${(e as Error).message}`);
        }
      }
    },
    onChange(cb) {
      const l = (c: { key: string }): void => {
        if (isSyncablePreference(c.key)) cb();
      };
      settings.on('changed', l);
      return () => void settings.off('changed', l);
    },
  };
}

// ---- keybindings -----------------------------------------------------------------------------------

export interface KeybindingsStoreLike {
  readKeybindings(): KeybindingOverride[];
  writeKeybindings(overrides: unknown): KeybindingOverride[];
  on(event: 'keybindingsChanged', listener: () => void): unknown;
  off(event: 'keybindingsChanged', listener: () => void): unknown;
}

/** Keyed by command: a command's override entries replace its defaults as a unit. */
export function keybindingsSource(
  store: KeybindingsStoreLike,
  onApplied?: (saved: KeybindingOverride[]) => void,
): SyncSource {
  return {
    category: 'keybindings',
    strategy: 'lww',
    schema: 1,
    async read() {
      const out: Record<string, KeybindingOverride[]> = {};
      for (const o of store.readKeybindings()) (out[o.command] ??= []).push(o);
      return out;
    },
    async write(data) {
      const list: KeybindingOverride[] = [];
      for (const command of Object.keys(data).sort()) {
        const entries = data[command];
        if (!Array.isArray(entries)) continue;
        for (const e of entries)
          if (e && typeof e === 'object') list.push({ ...(e as KeybindingOverride), command });
      }
      if (sameValue(list, store.readKeybindings())) return;
      onApplied?.(store.writeKeybindings(list));
    },
    onChange(cb) {
      const l = (): void => cb();
      store.on('keybindingsChanged', l);
      return () => void store.off('keybindingsChanged', l);
    },
  };
}

// ---- themes ----------------------------------------------------------------------------------------

const THEME_FILE = /^[^\\/:*?"<>|]+\.jsonc$/;
const MAX_THEME_BYTES = 512 * 1024;

/** Custom theme files (`userData/themes/*.jsonc`), keyed by file name. */
export function themesSource(dir: string, log?: (m: string) => void): SyncSource {
  const list = (): string[] => {
    try {
      return fs.readdirSync(dir).filter((f) => THEME_FILE.test(f) && !f.startsWith('.'));
    } catch {
      return [];
    }
  };
  return {
    category: 'themes',
    strategy: 'strict',
    schema: 1,
    async read() {
      const out: Record<string, string> = {};
      for (const f of list()) {
        try {
          const file = path.join(dir, f);
          if (fs.statSync(file).size > MAX_THEME_BYTES) continue;
          out[f] = fs.readFileSync(file, 'utf8');
        } catch {
          /* unreadable file: not synced */
        }
      }
      return out;
    },
    async write(data) {
      fs.mkdirSync(dir, { recursive: true });
      for (const [name, text] of Object.entries(data)) {
        if (!THEME_FILE.test(name) || typeof text !== 'string' || text.length > MAX_THEME_BYTES) continue;
        const file = path.join(dir, name);
        try {
          if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) continue;
          writeFileAtomic(file, text);
        } catch (e) {
          log?.(`sync: could not write theme ${name}: ${(e as Error).message}`);
        }
      }
      // Deleted on another computer: keep a copy that is no longer listed as a theme.
      for (const f of list()) {
        if (Object.hasOwn(data, f)) continue;
        try {
          fs.renameSync(path.join(dir, f), path.join(dir, `${f}-removed`));
        } catch (e) {
          log?.(`sync: could not remove theme ${f}: ${(e as Error).message}`);
        }
      }
    },
    onChange(cb) {
      let timer: ReturnType<typeof setTimeout> | null = null;
      let watcher: fs.FSWatcher | null = null;
      try {
        fs.mkdirSync(dir, { recursive: true });
        watcher = fs.watch(dir, (_e, name) => {
          if (!name || !THEME_FILE.test(name.toString())) return;
          if (timer) clearTimeout(timer);
          timer = setTimeout(cb, 500);
        });
        watcher.on('error', () => undefined);
      } catch (e) {
        log?.(`sync: cannot watch the themes folder: ${(e as Error).message}`);
      }
      return () => {
        if (timer) clearTimeout(timer);
        watcher?.close();
      };
    },
  };
}

// ---- workspaces ------------------------------------------------------------------------------------

/** Remote URL safe to sync: credentials removed; local-path / file remotes dropped. */
export function sanitizeRemoteUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const u = url.trim();
  if (/^file:/i.test(u) || /^[a-z]:[\\/]/i.test(u) || /^[\\/.~]/.test(u)) return undefined;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) {
    try {
      const parsed = new URL(u);
      // http(s) user info may carry a token; ssh user names (`git@`) are kept.
      if (/^https?:$/i.test(parsed.protocol)) parsed.username = '';
      parsed.password = '';
      return parsed.toString();
    } catch {
      return undefined;
    }
  }
  return u; // scp-like git@host:owner/repo
}

interface SyncedRepo {
  id: string;
  name: string;
  provider?: WorkspaceRepo['provider'];
  remoteUrl?: string;
  addedAt: string;
}

/** Workspace as synced: no local paths, clone roots, timestamps of local edits or cloud links. */
export function serializeWorkspace(w: Workspace): Record<string, unknown> {
  const repos: SyncedRepo[] = w.repos.map((r) => {
    const remoteUrl = sanitizeRemoteUrl(r.remoteUrl);
    return {
      id: r.id,
      name: r.name,
      ...(r.provider ? { provider: { ...r.provider } } : {}),
      ...(remoteUrl ? { remoteUrl } : {}),
      addedAt: r.addedAt,
    };
  });
  return {
    id: w.id,
    name: w.name,
    ...(w.description ? { description: w.description } : {}),
    ...(w.color ? { color: w.color } : {}),
    ...(w.icon ? { icon: w.icon } : {}),
    order: w.order,
    hidden: w.hidden,
    repos,
    createdAt: w.createdAt,
  };
}

const providerKey = (p: WorkspaceRepo['provider']): string | null =>
  p ? `${p.integrationKey}/${p.owner}/${p.name}`.toLowerCase() : null;

/**
 * Merge synced workspaces into local ones: repos that exist on this computer keep their local path
 * (matched by repo id, then provider repo, then remote URL — across all local workspaces).
 */
export function mergeSyncedWorkspaces(
  synced: Record<string, unknown>,
  local: Workspace[],
  exists: (p: string) => boolean,
  now = new Date().toISOString(),
): Workspace[] {
  const byId = new Map(local.map((w) => [w.id, w]));
  const pathByRepoId = new Map<string, string>();
  const pathByProvider = new Map<string, string>();
  const pathByRemote = new Map<string, string>();
  for (const w of local) {
    for (const r of w.repos) {
      if (!r.localPath || !exists(r.localPath)) continue;
      pathByRepoId.set(`${w.id}/${r.id}`, r.localPath);
      const pk = providerKey(r.provider);
      if (pk && !pathByProvider.has(pk)) pathByProvider.set(pk, r.localPath);
      for (const u of [r.remoteUrl, r.provider?.cloneUrlHttps, r.provider?.cloneUrlSsh]) {
        if (u && !pathByRemote.has(normalizeRemoteUrl(u)))
          pathByRemote.set(normalizeRemoteUrl(u), r.localPath);
      }
    }
  }
  const out: Workspace[] = [];
  for (const [id, raw] of Object.entries(synced)) {
    if (!raw || typeof raw !== 'object') continue;
    const s = raw as Record<string, unknown> & { repos?: SyncedRepo[] };
    const prev = byId.get(id);
    const repos: WorkspaceRepo[] = (Array.isArray(s.repos) ? s.repos : [])
      .filter((r): r is SyncedRepo => !!r && typeof r.id === 'string' && typeof r.name === 'string')
      .map((r) => {
        const pk = providerKey(r.provider);
        const localPath =
          pathByRepoId.get(`${id}/${r.id}`) ??
          (pk ? pathByProvider.get(pk) : undefined) ??
          [r.remoteUrl, r.provider?.cloneUrlHttps, r.provider?.cloneUrlSsh]
            .filter((u): u is string => !!u)
            .map((u) => pathByRemote.get(normalizeRemoteUrl(u)))
            .find((p) => !!p);
        return {
          id: r.id,
          name: r.name,
          ...(localPath ? { localPath } : {}),
          ...(r.provider ? { provider: r.provider } : {}),
          ...(r.remoteUrl ? { remoteUrl: r.remoteUrl } : {}),
          addedAt: typeof r.addedAt === 'string' ? r.addedAt : now,
        };
      });
    const ws: Workspace = {
      id,
      kind: 'local',
      name: typeof s.name === 'string' && s.name ? s.name : 'Workspace',
      order: typeof s.order === 'number' ? s.order : out.length,
      hidden: s.hidden === true,
      repos,
      createdAt: typeof s.createdAt === 'string' ? s.createdAt : now,
      updatedAt: prev?.updatedAt ?? now,
    };
    for (const k of ['description', 'color', 'icon'] as const) {
      if (typeof s[k] === 'string' && s[k]) ws[k] = s[k] as string;
    }
    if (prev?.defaultCloneRoot) ws.defaultCloneRoot = prev.defaultCloneRoot;
    out.push(ws);
  }
  return out;
}

export interface WorkspacesLike {
  list(): Workspace[];
  replaceLocalWorkspaces(list: Workspace[]): void;
  onDidChange(cb: () => void): () => void;
}

/** Local (non-directory, non-cloud) workspaces, keyed by id. */
export function workspacesSource(ws: WorkspacesLike, exists: (p: string) => boolean): SyncSource {
  return {
    category: 'workspaces-local',
    strategy: 'strict',
    schema: 1,
    async read() {
      const out: Record<string, unknown> = {};
      for (const w of ws.list()) if (w.kind === 'local') out[w.id] = serializeWorkspace(w);
      return out;
    },
    async write(data) {
      const local = ws.list();
      const merged = mergeSyncedWorkspaces(data, local, exists);
      const current = local.filter((w) => w.kind === 'local');
      if (sameValue(merged.map(serializeWorkspace), current.map(serializeWorkspace))) return;
      ws.replaceLocalWorkspaces(merged);
    },
    onChange: (cb) => ws.onDidChange(cb),
  };
}

// ---- launchpad -------------------------------------------------------------------------------------

export interface LaunchpadLike {
  userState(): { itemStates: Record<string, ItemUserState>; savedViews: SavedView[] };
  applyUserState(itemStates: Record<string, ItemUserState>, savedViews: SavedView[]): void;
  onUserStateChange(cb: () => void): () => void;
}

/** Pins/snoozes (`s:<uid>`, without the machine-local `lastSeenAt`) and saved views (`v:<id>`). */
export function launchpadSource(lp: LaunchpadLike, now = (): string => new Date().toISOString()): SyncSource {
  return {
    category: 'launchpad',
    strategy: 'lww',
    schema: 1,
    async read() {
      const { itemStates, savedViews } = lp.userState();
      const out: Record<string, unknown> = {};
      for (const st of Object.values(itemStates)) {
        if (!st.pinnedAt && !st.snooze) continue;
        out[`s:${st.uid}`] = {
          uid: st.uid,
          ...(st.pinnedAt ? { pinnedAt: st.pinnedAt } : {}),
          ...(st.snooze ? { snooze: st.snooze } : {}),
        };
      }
      for (const v of savedViews) out[`v:${v.id}`] = v;
      return out;
    },
    async write(data) {
      const cur = lp.userState();
      const itemStates: Record<string, ItemUserState> = {};
      const views = new Map<string, SavedView>();
      for (const [k, v] of Object.entries(data)) {
        if (!v || typeof v !== 'object') continue;
        if (k.startsWith('s:')) {
          const st = v as ItemUserState;
          const uid = k.slice(2);
          if (!st.pinnedAt && !st.snooze) continue;
          itemStates[uid] = {
            uid,
            ...(st.pinnedAt ? { pinnedAt: st.pinnedAt } : {}),
            ...(st.snooze ? { snooze: st.snooze } : {}),
            lastSeenAt: cur.itemStates[uid]?.lastSeenAt ?? now(),
          };
        } else if (k.startsWith('v:')) {
          views.set(k.slice(2), { ...(v as SavedView), id: k.slice(2) });
        }
      }
      // Keep this computer's ordering for known views; append new ones.
      const savedViews = [
        ...cur.savedViews.filter((v) => views.has(v.id)).map((v) => views.get(v.id)!),
        ...[...views.values()].filter((v) => !cur.savedViews.some((x) => x.id === v.id)),
      ];
      const strip = (s: Record<string, ItemUserState>): unknown =>
        Object.fromEntries(
          Object.entries(s)
            .filter(([, x]) => x.pinnedAt || x.snooze)
            .map(([k, x]) => [k, { ...x, lastSeenAt: undefined }]),
        );
      if (sameValue(strip(itemStates), strip(cur.itemStates)) && sameValue(savedViews, cur.savedViews))
        return;
      lp.applyUserState(itemStates, savedViews);
    },
    onChange: (cb) => lp.onUserStateChange(cb),
  };
}

// ---- integrations list -----------------------------------------------------------------------------

export interface AccountsLike {
  list(): ConnectedIntegration[];
  onDidChange(cb: () => void): () => void;
}

export const hintKey = (kind: string, host: string, login: string): string =>
  `${kind}|${host}|${login}`.toLowerCase();

/**
 * Which services are connected (kind, host, login) — never tokens. Entries connected on another
 * computer but not here become Reconnect hints; they stay in the synced list until dismissed.
 */
export function integrationsListSource(
  accounts: AccountsLike,
  hints: { get(): ReconnectHint[]; set(hints: ReconnectHint[]): void },
): SyncSource {
  const connected = (): Map<string, { kind: string; host: string; login: string }> =>
    new Map(
      accounts
        .list()
        .map((i) => [hintKey(i.kind, i.host, i.login), { kind: i.kind, host: i.host, login: i.login }]),
    );
  return {
    category: 'integrations-list',
    strategy: 'lww',
    schema: 1,
    async read() {
      const out: Record<string, unknown> = {};
      for (const h of hints.get()) out[h.key] = { kind: h.kind, host: h.host, login: h.login };
      for (const [k, v] of connected()) out[k] = v;
      return out;
    },
    async write(data) {
      const here = connected();
      const next: ReconnectHint[] = [];
      for (const [key, v] of Object.entries(data)) {
        const e = v as { kind?: unknown; host?: unknown; login?: unknown } | null;
        if (!e || typeof e.kind !== 'string' || typeof e.host !== 'string' || typeof e.login !== 'string')
          continue;
        if (here.has(key)) continue;
        next.push({ key, kind: e.kind, host: e.host, login: e.login });
      }
      next.sort((a, b) => a.key.localeCompare(b.key));
      if (!sameValue(next, hints.get())) hints.set(next);
    },
    onChange: (cb) => accounts.onDidChange(cb),
  };
}
