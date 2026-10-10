import fs from 'node:fs';
import path from 'node:path';

import type { GitOperation, GitProcessRunner, RepoId } from '@githappens/git';

import type { ToastSpec } from '../../shared/ipc/app-contract';
import type {
  BranchMatrix,
  BranchTrack,
  BulkOpRequest,
  CreateWorkspaceInput,
  NewWorkspaceRepo,
  RepoStatusSummary,
  Workspace,
  WorkspaceFile,
  WorkspacePatch,
  WorkspaceRepo,
  WorkspaceRepoDetails,
  WorkspacesEventContract,
} from '../../shared/ipc/workspaces-contract';
import { BulkRunner, type CloneJob } from './bulk-runner';
import {
  codeWorkspaceName,
  DEFAULT_IGNORE,
  parseCodeWorkspace,
  scanDirectory,
  scanForRepos,
} from './directory-scan';
import { DirectorySync } from './directory-sync';
import { WorkspaceStatus } from './workspace-status';
import { clampDepth, sanitizeWorkspace, WorkspaceStore } from './workspace-store';
import { isDirectory, mapLimit, normalizeRemoteUrl, pathKey } from './util';

export interface FileFilter {
  name: string;
  extensions: string[];
}

/** App services the workspace layer needs; wired in main/index.ts. */
export interface WorkspaceServiceDeps {
  /** Active profile dir (`userData/profiles/<id>`); `workspaces.json` lives there. */
  profileDir(): string;
  /** The app-wide git runner (GitEngine.runner). */
  runner(): GitProcessRunner;
  /** RepoManager.open → repo id (ref-counted; paired with closeRepo). */
  openRepo(path: string): Promise<RepoId>;
  closeRepo(id: RepoId): Promise<void>;
  /** RepoManager.runOp; should cancel the op when `signal` aborts. */
  runOp(id: RepoId, op: GitOperation, signal: AbortSignal): Promise<unknown>;
  /** cloneRepo with credentials/askpass; reports progress, honors `signal`. */
  clone(job: CloneJob): Promise<{ path: string }>;
  /** Settings: `workspaces.bulkConcurrency` / `workspaces.scanDepth`. */
  bulkConcurrency(): number;
  scanDepth(): number;
  emit<E extends keyof WorkspacesEventContract>(event: E, payload: WorkspacesEventContract[E]): void;
  toast?(t: ToastSpec): void;
  /** Native open / save dialogs (for import/export without a path). */
  pickFile?(o: { title: string; filters: FileFilter[] }): Promise<string | null>;
  pickSavePath?(o: { title: string; defaultPath: string; filters: FileFilter[] }): Promise<string | null>;
  /** fs.watch directory-synced roots (default true). */
  watchDirectories?: boolean;
}

const JSON_FILTER: FileFilter[] = [{ name: 'Workspace JSON', extensions: ['json'] }];

/** Facade over store, status, scan, directory sync and bulk runner used by the IPC handlers. */
export class WorkspaceService {
  readonly store: WorkspaceStore;
  readonly status: WorkspaceStatus;
  readonly bulk: BulkRunner;
  readonly sync: DirectorySync;
  private listeners = new Set<() => void>();

  constructor(private readonly d: WorkspaceServiceDeps) {
    this.store = new WorkspaceStore({
      profileDir: d.profileDir,
      onChange: (workspaces) => {
        d.emit('workspace:changed', { workspaces });
        this.sync?.refresh();
        for (const l of [...this.listeners]) l();
      },
      onCorrupt: (backup) =>
        d.toast?.({
          kind: 'warning',
          title: 'Workspaces file was unreadable',
          body: `It was backed up to ${backup} and workspaces were reset.`,
        }),
    });
    this.status = new WorkspaceStatus(d.runner);
    this.sync = new DirectorySync({
      store: this.store,
      watch: d.watchDirectories !== false,
      onSynced: (ws, added, removed) => {
        d.emit('workspace:changed', {
          workspaces: this.store.list(),
          sync: { workspaceId: ws.id, added, removed },
        });
        const parts = [
          added.length ? `added ${added.join(', ')}` : '',
          removed.length ? `removed ${removed.join(', ')}` : '',
        ].filter(Boolean);
        d.toast?.({ kind: 'info', title: `Workspace “${ws.name}” synced`, body: parts.join('; ') });
      },
    });
    this.bulk = new BulkRunner({
      workspace: (id) => this.store.get(id),
      setRepoPath: (wsId, repoId, p, url) => void this.store.setRepoPath(wsId, repoId, p, url),
      status: this.status,
      openRepo: d.openRepo,
      closeRepo: d.closeRepo,
      runOp: d.runOp,
      clone: d.clone,
      headSha: (p) => this.git(p, ['rev-parse', '--verify', '-q', 'HEAD']).then((s) => s || null),
      countCommits: (p, from, to) =>
        this.git(p, ['rev-list', '--count', `${from}..${to}`, '--']).then((s) => Number(s) || 0),
      concurrency: d.bulkConcurrency,
      emit: (p) => d.emit('workspace:bulkProgress', p),
    });
  }

  /** Start watching directory-synced workspaces of the active profile. */
  start(): void {
    this.sync.refresh();
  }

  dispose(): void {
    this.sync.dispose();
    this.bulk.cancelAll();
  }

  list(): Workspace[] {
    this.sync.refresh();
    return this.store.list();
  }

  /** Called after any workspace change was saved (settings sync). */
  onDidChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async create(input: CreateWorkspaceInput): Promise<Workspace> {
    if (input.kind === 'directory') {
      const d = input.directory;
      if (!d?.root || !isDirectory(d.root)) throw new Error('Choose an existing folder to sync with.');
      const directory = {
        root: path.resolve(d.root),
        depth: clampDepth(d.depth ?? this.d.scanDepth()),
        includeNested: !!d.includeNested,
        ignore: d.ignore?.length ? d.ignore : DEFAULT_IGNORE,
      };
      const scan = await scanForRepos(directory);
      const ws = this.store.create({
        ...input,
        directory,
        repos: scan.paths.map((p) => ({ localPath: p, name: path.basename(p) })),
      });
      if (scan.truncated) {
        this.d.toast?.({
          kind: 'warning',
          title: 'Directory scan capped',
          body: `Only the first ${scan.paths.length} repositories under ${directory.root} were added.`,
        });
      }
      return ws;
    }
    const repos = await this.resolveNewRepos(input.repos ?? []);
    return this.store.create({ ...input, repos });
  }

  update(id: string, patch: WorkspacePatch): Workspace {
    return this.store.update(id, patch);
  }

  delete(id: string): void {
    this.store.delete(id);
  }

  async addRepos(id: string, repos: NewWorkspaceRepo[]): Promise<Workspace> {
    this.store.get(id);
    return this.store.addRepos(id, await this.resolveNewRepos(repos));
  }

  scan(o: { root: string; depth?: number; ignore?: string[]; includeNested?: boolean }) {
    if (!o.root || !isDirectory(o.root)) throw new Error('Folder not found.');
    return scanDirectory(
      {
        root: o.root,
        depth: clampDepth(o.depth ?? this.d.scanDepth()),
        ignore: o.ignore ?? DEFAULT_IGNORE,
        includeNested: !!o.includeNested,
      },
      (p) => this.status.remotes(p),
    );
  }

  async importCodeWorkspace(
    filePath?: string,
  ): Promise<{ workspace: Workspace; skipped: Array<{ folder: string; reason: string }> } | null> {
    const file =
      filePath ??
      (await this.pick({
        title: 'Import VS Code workspace',
        filters: [{ name: 'VS Code workspace', extensions: ['code-workspace'] }],
      }));
    if (!file) return null;
    const folders = parseCodeWorkspace(fs.readFileSync(file, 'utf8'), file);
    const found = await mapLimit(folders, 6, async (f): Promise<NewWorkspaceRepo | string> => {
      if (!f.path) return 'Remote folder';
      if (!isDirectory(f.path)) return 'Folder not found';
      const loc = await this.status.locate(f.path);
      if (!loc) return 'Not in a git repository';
      return { localPath: loc.toplevel, name: f.name ?? path.basename(loc.toplevel) };
    });
    const skipped = found.flatMap((r, i) =>
      typeof r === 'string' ? [{ folder: folders[i]!.label, reason: r }] : [],
    );
    const repos = await this.withRemoteUrls(
      found.filter((r): r is NewWorkspaceRepo => typeof r !== 'string'),
    );
    const workspace = this.store.create({ kind: 'local', name: codeWorkspaceName(file), repos });
    return { workspace, skipped };
  }

  async exportJson(workspaceId: string, filePath?: string): Promise<{ path: string } | null> {
    const ws = this.store.get(workspaceId);
    const file =
      filePath ??
      (this.d.pickSavePath
        ? await this.d.pickSavePath({
            title: 'Export workspace',
            defaultPath: `${ws.name.replace(/[\\/:*?"<>|]/g, '-')}.workspace.json`,
            filters: JSON_FILTER,
          })
        : null);
    if (!file) return null;
    const out: WorkspaceFile = { version: 1, workspaces: [ws] };
    fs.writeFileSync(file, JSON.stringify(out, null, 2));
    return { path: file };
  }

  async importJson(filePath?: string): Promise<Workspace[] | null> {
    const file = filePath ?? (await this.pick({ title: 'Import workspace', filters: JSON_FILTER }));
    if (!file) return null;
    let data: unknown;
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      throw new Error(`Could not read ${path.basename(file)}: ${(e as Error).message}`, { cause: e });
    }
    const raw =
      data && typeof data === 'object' && Array.isArray((data as WorkspaceFile).workspaces)
        ? (data as WorkspaceFile).workspaces
        : [data];
    const list = raw.map((w, i) => sanitizeWorkspace(w, i)).filter((w): w is Workspace => !!w);
    if (!list.length) throw new Error('No workspaces found in that file.');
    // Paths from another machine are only kept when they exist here.
    for (const ws of list) {
      for (const r of ws.repos) if (r.localPath && !isDirectory(r.localPath)) delete r.localPath;
    }
    return this.store.importWorkspaces(list);
  }

  async statusOf(workspaceId: string, force = false): Promise<RepoStatusSummary[]> {
    let ws = this.store.get(workspaceId);
    if (ws.kind === 'directory') {
      await this.sync.sync(ws.id, force);
      ws = this.store.get(workspaceId);
    }
    const summaries = await this.status.forRepos(ws.repos, force);
    this.d.emit('workspace:statusUpdated', { workspaceId, summaries });
    return summaries;
  }

  async locate(
    workspaceId: string,
    repoId: string,
    p: string,
    force = false,
  ): Promise<{ repo?: WorkspaceRepo; mismatch?: { expected: string; actual: string[] } }> {
    const ws = this.store.get(workspaceId);
    const repo = ws.repos.find((r) => r.id === repoId);
    if (!repo) throw new Error('Repository not found in this workspace.');
    if (!isDirectory(p)) throw new Error('Folder not found.');
    const loc = await this.status.locate(p);
    if (!loc) throw new Error('That folder is not a git repository.');
    const remotes = await this.status.remotes(loc.toplevel).catch(() => []);
    const expected = repo.provider?.cloneUrlHttps || repo.remoteUrl;
    if (expected && !force) {
      const want = new Set(
        [repo.provider?.cloneUrlHttps, repo.provider?.cloneUrlSsh, repo.remoteUrl]
          .filter((u): u is string => !!u)
          .map(normalizeRemoteUrl),
      );
      if (!remotes.some((r) => want.has(normalizeRemoteUrl(r.url)))) {
        return { mismatch: { expected, actual: remotes.map((r) => r.url) } };
      }
    }
    const origin = remotes.find((r) => r.name === 'origin')?.url ?? remotes[0]?.url;
    this.status.invalidate(loc.toplevel);
    return { repo: this.store.setRepoPath(workspaceId, repoId, loc.toplevel, origin) };
  }

  startBulk(req: BulkOpRequest): { bulkId: string } {
    const { bulkId, done } = this.bulk.start(req);
    void done.catch(() => undefined);
    return { bulkId };
  }

  openAll(workspaceId: string, repoIds?: string[]): { paths: string[]; missing: string[] } {
    const ws = this.store.get(workspaceId);
    const wanted = repoIds ? new Set(repoIds) : null;
    const paths: string[] = [];
    const missing: string[] = [];
    for (const r of ws.repos) {
      if (wanted && !wanted.has(r.id)) continue;
      if (r.localPath && isDirectory(r.localPath)) paths.push(r.localPath);
      else missing.push(r.name);
    }
    return { paths, missing };
  }

  async branches(workspaceId: string): Promise<BranchMatrix> {
    const ws = this.store.get(workspaceId);
    const local = ws.repos.filter((r) => r.localPath && isDirectory(r.localPath));
    const per = await mapLimit(local, 6, (r) => this.status.branches(r.localPath!).catch(() => []));
    const byName = new Map<string, Record<string, BranchTrack | null>>();
    per.forEach((branches, i) => {
      for (const b of branches) {
        const cells = byName.get(b.name) ?? {};
        cells[local[i]!.id] = {
          ...(b.upstream ? { upstream: b.upstream } : {}),
          ahead: b.ahead,
          behind: b.behind,
          gone: b.gone,
        };
        byName.set(b.name, cells);
      }
    });
    const rows = [...byName]
      .filter(([, cells]) => Object.keys(cells).length >= 2)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([branch, cells]) => ({
        branch,
        cells: Object.fromEntries(local.map((r) => [r.id, cells[r.id] ?? null])),
      }));
    return { repos: local.map((r) => ({ repoId: r.id, name: r.name })), rows };
  }

  async repoDetails(workspaceId: string, repoId: string): Promise<WorkspaceRepoDetails> {
    const repo = this.store.get(workspaceId).repos.find((r) => r.id === repoId);
    if (!repo?.localPath || !isDirectory(repo.localPath)) return { branches: [], commits: [] };
    return this.status.details(repo.localPath);
  }

  /** Validate local paths (→ repo toplevel) and record their origin URL. */
  private async resolveNewRepos(repos: NewWorkspaceRepo[]): Promise<NewWorkspaceRepo[]> {
    const out = await mapLimit(repos, 6, async (r) => {
      if (!r.localPath) {
        if (!r.provider && !r.remoteUrl) throw new Error('A repository needs a local path or a remote.');
        return r;
      }
      if (!isDirectory(r.localPath)) throw new Error(`Folder not found: ${r.localPath}`);
      const loc = await this.status.locate(r.localPath);
      if (!loc) throw new Error(`Not a git repository: ${r.localPath}`);
      return { ...r, localPath: loc.toplevel };
    });
    const seen = new Set<string>();
    const unique = out.filter((r) => {
      if (!r.localPath) return true;
      const k = pathKey(r.localPath);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return this.withRemoteUrls(unique);
  }

  private withRemoteUrls(repos: NewWorkspaceRepo[]): Promise<NewWorkspaceRepo[]> {
    return mapLimit(repos, 6, async (r) => {
      if (!r.localPath || r.remoteUrl) return r;
      const remotes = await this.status.remotes(r.localPath).catch(() => []);
      const url = remotes.find((x) => x.name === 'origin')?.url ?? remotes[0]?.url;
      return url ? { ...r, remoteUrl: url } : r;
    });
  }

  private async pick(o: { title: string; filters: FileFilter[] }): Promise<string | null> {
    if (!this.d.pickFile) throw new Error('No file was given.');
    return this.d.pickFile(o);
  }

  private async git(cwd: string, args: string[]): Promise<string> {
    const r = await this.d.runner().run({ cwd, args, readOnly: true, expectedExitCodes: [0, 1] });
    return r.stdout.trim();
  }
}
