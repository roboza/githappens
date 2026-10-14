import { randomUUID } from 'node:crypto';
import path from 'node:path';

import {
  hiddenRepoKey,
  type CreateWorkspaceInput,
  type NewWorkspaceRepo,
  type Workspace,
  type WorkspaceFile,
  type WorkspacePatch,
  type WorkspaceRepo,
} from '../../shared/ipc/workspaces-contract';
import { backupCorrupt, readJson, writeFileAtomic } from '../settings/atomic-file';
import { canonicalPath } from '../services/canonical-path';
import { nowIso, pathKey } from './util';

export const WORKSPACES_FILE = 'workspaces.json';
const KINDS = new Set(['local', 'directory', 'cloud']);

export interface WorkspaceStoreOptions {
  /** Active profile directory; the store reloads when it changes (profile switch). */
  profileDir: () => string;
  onChange?: (workspaces: Workspace[]) => void;
  /** A corrupt file was moved aside to `backup` and the store started empty. */
  onCorrupt?: (backup: string, error: string) => void;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

function sanitizeRepo(r: unknown): WorkspaceRepo | null {
  if (!r || typeof r !== 'object') return null;
  const o = r as Record<string, unknown>;
  const name = str(o.name);
  if (!name) return null;
  const p = o.provider as Record<string, unknown> | undefined;
  return {
    id: str(o.id) ?? randomUUID(),
    name,
    ...(str(o.localPath) ? { localPath: str(o.localPath) } : {}),
    ...(p && str(p.integrationKey) && str(p.owner) && str(p.name)
      ? {
          provider: {
            integrationKey: str(p.integrationKey)!,
            owner: str(p.owner)!,
            name: str(p.name)!,
            cloneUrlHttps: str(p.cloneUrlHttps) ?? '',
            cloneUrlSsh: str(p.cloneUrlSsh) ?? '',
            webUrl: str(p.webUrl) ?? '',
          },
        }
      : {}),
    ...(str(o.remoteUrl) ? { remoteUrl: str(o.remoteUrl) } : {}),
    addedAt: str(o.addedAt) ?? nowIso(),
  };
}

/** Validates one stored workspace; unknown fields are dropped, missing ones defaulted. */
export function sanitizeWorkspace(w: unknown, order: number): Workspace | null {
  if (!w || typeof w !== 'object') return null;
  const o = w as Record<string, unknown>;
  const name = str(o.name);
  const kind = str(o.kind);
  if (!name || !kind || !KINDS.has(kind)) return null;
  const repos = Array.isArray(o.repos)
    ? o.repos.map(sanitizeRepo).filter((r): r is WorkspaceRepo => !!r)
    : [];
  const d = o.directory as Record<string, unknown> | undefined;
  const ws: Workspace = {
    id: str(o.id) ?? randomUUID(),
    kind: kind as Workspace['kind'],
    name,
    order: typeof o.order === 'number' ? o.order : order,
    hidden: o.hidden === true,
    repos,
    createdAt: str(o.createdAt) ?? nowIso(),
    updatedAt: str(o.updatedAt) ?? nowIso(),
  };
  if (str(o.description)) ws.description = str(o.description);
  if (str(o.color)) ws.color = str(o.color);
  if (str(o.icon)) ws.icon = str(o.icon);
  if (str(o.defaultCloneRoot)) ws.defaultCloneRoot = str(o.defaultCloneRoot);
  if (Array.isArray(o.hiddenRepos)) {
    const hidden = [...new Set(o.hiddenRepos.filter((k): k is string => typeof k === 'string' && !!k))];
    if (hidden.length) ws.hiddenRepos = hidden;
  }
  if (d && str(d.root)) {
    ws.directory = {
      root: str(d.root)!,
      depth: clampDepth(d.depth),
      includeNested: d.includeNested === true,
      ignore: Array.isArray(d.ignore) ? d.ignore.filter((g): g is string => typeof g === 'string') : [],
    };
  }
  if (o.cloud && typeof o.cloud === 'object') ws.cloud = o.cloud as Workspace['cloud'];
  return ws;
}

function setHidden(ws: Workspace, keys: string[]): void {
  if (keys.length) ws.hiddenRepos = [...new Set(keys)];
  else delete ws.hiddenRepos;
}

export const clampDepth = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(6, Math.floor(v))) : 2;

/** Identity used to dedupe repos within a workspace: provider repo, else path, else remote. */
function repoKeys(r: NewWorkspaceRepo): string[] {
  const keys: string[] = [];
  if (r.provider) keys.push(`p:${r.provider.integrationKey}/${r.provider.owner}/${r.provider.name}`);
  if (r.localPath) keys.push(`l:${pathKey(r.localPath)}`);
  return keys;
}

/**
 * Per-profile workspace persistence (spec 11 §5.5 WorkspaceStore): `profiles/<id>/workspaces.json`,
 * version 1, atomic writes; a corrupt file is moved aside and the store starts empty.
 */
export class WorkspaceStore {
  private loadedFrom: string | null = null;
  private items: Workspace[] = [];

  constructor(private readonly o: WorkspaceStoreOptions) {}

  get file(): string {
    return path.join(this.o.profileDir(), WORKSPACES_FILE);
  }

  list(): Workspace[] {
    return [...this.load()].sort((a, b) => a.order - b.order);
  }

  get(id: string): Workspace {
    const ws = this.load().find((w) => w.id === id);
    if (!ws) throw new Error('Workspace not found.');
    return ws;
  }

  create(input: CreateWorkspaceInput): Workspace {
    const items = this.load();
    const name = input.name?.trim();
    if (!name) throw new Error('A workspace needs a name.');
    if (!KINDS.has(input.kind)) throw new Error('Invalid workspace kind.');
    const now = nowIso();
    const ws: Workspace = {
      id: randomUUID(),
      kind: input.kind,
      name,
      order: items.reduce((m, w) => Math.max(m, w.order + 1), 0),
      hidden: false,
      repos: [],
      createdAt: now,
      updatedAt: now,
    };
    if (input.description?.trim()) ws.description = input.description.trim();
    if (input.color) ws.color = input.color;
    if (input.icon) ws.icon = input.icon;
    if (input.defaultCloneRoot) ws.defaultCloneRoot = input.defaultCloneRoot;
    if (input.directory) {
      ws.directory = { ...input.directory, depth: clampDepth(input.directory.depth) };
    }
    ws.repos = this.mergeRepos([], input.repos ?? []);
    items.push(ws);
    this.save();
    return ws;
  }

  update(id: string, patch: WorkspacePatch): Workspace {
    const ws = this.get(id);
    if (patch.name !== undefined) {
      if (!patch.name.trim()) throw new Error('A workspace needs a name.');
      ws.name = patch.name.trim();
    }
    for (const k of ['description', 'color', 'icon', 'defaultCloneRoot'] as const) {
      if (k in patch) {
        const v = patch[k]?.trim();
        if (v) ws[k] = v;
        else delete ws[k];
      }
    }
    if (patch.hidden !== undefined) ws.hidden = !!patch.hidden;
    if (patch.directory) ws.directory = { ...patch.directory, depth: clampDepth(patch.directory.depth) };
    ws.updatedAt = nowIso();
    this.save();
    return ws;
  }

  delete(id: string): void {
    const items = this.load();
    const idx = items.findIndex((w) => w.id === id);
    if (idx < 0) return;
    items.splice(idx, 1);
    this.save();
  }

  reorder(ids: string[]): Workspace[] {
    const sorted = this.list();
    const rank = new Map(ids.map((id, i) => [id, i]));
    const ordered = [
      ...sorted.filter((w) => rank.has(w.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!),
      ...sorted.filter((w) => !rank.has(w.id)),
    ];
    ordered.forEach((w, i) => (w.order = i));
    this.save();
    return this.list();
  }

  addRepos(id: string, repos: NewWorkspaceRepo[]): Workspace {
    const ws = this.get(id);
    ws.repos = this.mergeRepos(ws.repos, repos);
    ws.updatedAt = nowIso();
    this.save();
    return ws;
  }

  removeRepos(id: string, repoIds: string[]): Workspace {
    const ws = this.get(id);
    const drop = new Set(repoIds);
    const dropKeys = new Set(ws.repos.filter((r) => drop.has(r.id)).map(hiddenRepoKey));
    ws.repos = ws.repos.filter((r) => !drop.has(r.id));
    setHidden(
      ws,
      (ws.hiddenRepos ?? []).filter((k) => !dropKeys.has(k)),
    );
    ws.updatedAt = nowIso();
    this.save();
    return ws;
  }

  /**
   * Hide repos from the overview, or show them again. Directory-synced workspaces keep the keys of
   * repos that vanish from their folder, so a repo that comes back stays hidden.
   */
  setReposHidden(id: string, repoIds: string[], hidden: boolean): Workspace {
    const ws = this.get(id);
    const wanted = new Set(repoIds);
    const keys = ws.repos.filter((r) => wanted.has(r.id)).map(hiddenRepoKey);
    const current = ws.hiddenRepos ?? [];
    setHidden(ws, hidden ? [...new Set([...current, ...keys])] : current.filter((k) => !keys.includes(k)));
    ws.updatedAt = nowIso();
    this.save();
    return ws;
  }

  /** Locate / clone result: set (or clear) a repo's local path. */
  setRepoPath(id: string, repoId: string, localPath: string | undefined, remoteUrl?: string): WorkspaceRepo {
    const ws = this.get(id);
    const repo = ws.repos.find((r) => r.id === repoId);
    if (!repo) throw new Error('Repository not found in this workspace.');
    const oldKey = hiddenRepoKey(repo);
    if (localPath) repo.localPath = canonicalPath(localPath);
    else delete repo.localPath;
    // A hidden repo stays hidden under its new path.
    if (ws.hiddenRepos?.includes(oldKey)) {
      setHidden(ws, [...ws.hiddenRepos.filter((k) => k !== oldKey), hiddenRepoKey(repo)]);
    }
    if (remoteUrl && !repo.remoteUrl) repo.remoteUrl = remoteUrl;
    ws.updatedAt = nowIso();
    this.save();
    return repo;
  }

  /** Directory sync: replace the repo set, keeping ids of repos whose path is unchanged. */
  syncRepos(
    id: string,
    found: NewWorkspaceRepo[],
  ): { workspace: Workspace; added: string[]; removed: string[] } {
    const ws = this.get(id);
    const foundKeys = new Set(found.map((r) => pathKey(r.localPath!)));
    const kept = ws.repos.filter((r) => r.localPath && foundKeys.has(pathKey(r.localPath)));
    const removed = ws.repos.filter((r) => !kept.includes(r)).map((r) => r.name);
    const merged = this.mergeRepos(kept, found);
    const added = merged.slice(kept.length).map((r) => r.name);
    if (added.length || removed.length) {
      ws.repos = merged;
      ws.updatedAt = nowIso();
      this.save();
    }
    return { workspace: ws, added, removed };
  }

  /** Import whole workspaces (JSON portability) with fresh ids. */
  importWorkspaces(list: Workspace[]): Workspace[] {
    const items = this.load();
    let order = items.reduce((m, w) => Math.max(m, w.order + 1), 0);
    const now = nowIso();
    const created = list.map((w) => {
      const newIds = new Map(w.repos.map((r) => [r.id, randomUUID()]));
      const ws: Workspace = {
        ...w,
        id: randomUUID(),
        order: order++,
        hidden: false,
        repos: w.repos.map((r) => ({ ...r, id: newIds.get(r.id)! })),
        createdAt: now,
        updatedAt: now,
      };
      delete ws.cloud;
      // Repos hidden by id follow their new ids.
      if (w.hiddenRepos)
        setHidden(
          ws,
          w.hiddenRepos.map((k) => newIds.get(k) ?? k),
        );
      return ws;
    });
    items.push(...created);
    this.save();
    return created;
  }

  /**
   * Settings sync (spec 14 §6.2): replace every `local` workspace with `list` (already merged with
   * local paths by the caller); directory and cloud workspaces are untouched.
   */
  replaceLocalWorkspaces(list: Workspace[]): Workspace[] {
    const items = this.load();
    const kept = items.filter((w) => w.kind !== 'local');
    const ids = new Set(kept.map((w) => w.id));
    const incoming: Workspace[] = [];
    list.forEach((w, i) => {
      const ws = sanitizeWorkspace({ ...w, kind: 'local' }, i);
      if (!ws || ids.has(ws.id)) return;
      ids.add(ws.id);
      incoming.push(ws);
    });
    items.splice(0, items.length, ...kept, ...incoming);
    this.save();
    return this.list();
  }

  private mergeRepos(existing: WorkspaceRepo[], incoming: NewWorkspaceRepo[]): WorkspaceRepo[] {
    const out = [...existing];
    const seen = new Set(out.flatMap(repoKeys));
    for (const r of incoming) {
      const keys = repoKeys(r);
      if (!keys.length || keys.some((k) => seen.has(k))) continue;
      keys.forEach((k) => seen.add(k));
      const name =
        r.name?.trim() || r.provider?.name || (r.localPath ? path.basename(r.localPath) : '') || 'repository';
      out.push({
        id: randomUUID(),
        name,
        ...(r.localPath ? { localPath: canonicalPath(r.localPath) } : {}),
        ...(r.provider ? { provider: { ...r.provider } } : {}),
        ...(r.remoteUrl ? { remoteUrl: r.remoteUrl } : {}),
        addedAt: nowIso(),
      });
    }
    return out;
  }

  private load(): Workspace[] {
    const file = this.file;
    if (this.loadedFrom === file) return this.items;
    this.loadedFrom = file;
    this.items = [];
    const r = readJson<WorkspaceFile>(file);
    if (r.kind === 'missing') return this.items;
    const value = r.kind === 'ok' ? r.value : null;
    if (!value || typeof value !== 'object' || value.version !== 1 || !Array.isArray(value.workspaces)) {
      const error = r.kind === 'corrupt' ? r.error : 'Unrecognized workspaces file format.';
      const backup = backupCorrupt(file);
      this.o.onCorrupt?.(backup, error);
      return this.items;
    }
    const ids = new Set<string>();
    value.workspaces.forEach((w, i) => {
      const ws = sanitizeWorkspace(w, i);
      if (!ws || ids.has(ws.id)) return;
      ids.add(ws.id);
      this.items.push(ws);
    });
    return this.items;
  }

  private save(): void {
    const file: WorkspaceFile = { version: 1, workspaces: this.list() };
    writeFileAtomic(this.file, JSON.stringify(file, null, 2));
    this.o.onChange?.(this.list());
  }
}
