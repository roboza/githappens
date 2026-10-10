import fs from 'node:fs';
import path from 'node:path';

import type { Workspace } from '../../shared/ipc/workspaces-contract';
import { DEFAULT_IGNORE, scanForRepos, type ScanResult } from './directory-scan';
import type { WorkspaceStore } from './workspace-store';

/** Above this many folders to watch we only re-scan on demand (status refresh). */
const MAX_WATCHED_DIRS = 200;
const DEBOUNCE_MS = 1000;
/** On-demand rescans (status refresh) are throttled to this. */
const MIN_RESCAN_MS = 10_000;

export interface DirectorySyncOptions {
  store: Pick<WorkspaceStore, 'list' | 'get' | 'syncRepos'>;
  onSynced(workspace: Workspace, added: string[], removed: string[]): void;
  /** fs.watch the root folders (off in tests). */
  watch?: boolean;
  scan?: (ws: Workspace) => Promise<ScanResult>;
}

interface Entry {
  key: string;
  watchers: fs.FSWatcher[];
  timer: ReturnType<typeof setTimeout> | null;
  lastScan: number;
  running: Promise<void> | null;
}

/**
 * Keeps directory-synced workspaces equal to the repos under their root (spec 11 §5.5 DirectorySync).
 * Uses non-recursive `fs.watch` on the root and the non-repo folders above `depth` (bounded; no
 * chokidar), plus throttled re-scans when the workspace status is refreshed.
 */
export class DirectorySync {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly o: DirectorySyncOptions) {}

  /** Reconcile watchers with the current set of directory workspaces. */
  refresh(): void {
    const live = new Map(
      this.o.store
        .list()
        .filter((w) => w.kind === 'directory' && w.directory)
        .map((w) => [w.id, w] as const),
    );
    for (const [id, e] of this.entries) {
      const ws = live.get(id);
      if (!ws || configKey(ws) !== e.key) this.drop(id);
    }
    for (const [id, ws] of live) {
      if (this.entries.has(id)) continue;
      this.entries.set(id, { key: configKey(ws), watchers: [], timer: null, lastScan: 0, running: null });
      if (this.o.watch !== false) void this.sync(id, true);
    }
  }

  /** Re-scan now (or when the last scan is older than the throttle). */
  async sync(id: string, force = false): Promise<void> {
    const e = this.entries.get(id);
    if (!e) return;
    if (e.running) return e.running;
    if (!force && Date.now() - e.lastScan < MIN_RESCAN_MS) return;
    e.running = this.scanAndApply(id, e).finally(() => {
      e.running = null;
    });
    return e.running;
  }

  dispose(): void {
    for (const id of [...this.entries.keys()]) this.drop(id);
  }

  private async scanAndApply(id: string, e: Entry): Promise<void> {
    let ws: Workspace;
    try {
      ws = this.o.store.get(id);
    } catch {
      return;
    }
    const d = ws.directory;
    if (!d) return;
    e.lastScan = Date.now();
    const result = this.o.scan
      ? await this.o.scan(ws)
      : await scanForRepos({
          root: d.root,
          depth: d.depth,
          ignore: d.ignore.length ? d.ignore : DEFAULT_IGNORE,
          includeNested: d.includeNested,
        });
    if (!this.entries.has(id)) return;
    // A vanished root (unplugged drive) must not empty the workspace.
    if (!fs.existsSync(d.root)) return;
    const r = this.o.store.syncRepos(
      id,
      result.paths.map((p) => ({ localPath: p, name: path.basename(p) })),
    );
    if (r.added.length || r.removed.length) this.o.onSynced(r.workspace, r.added, r.removed);
    if (this.o.watch !== false) this.rewatch(id, e, [d.root, ...result.dirs]);
  }

  private rewatch(id: string, e: Entry, dirs: string[]): void {
    for (const w of e.watchers) w.close();
    e.watchers = [];
    const unique = [...new Set(dirs)];
    if (unique.length > MAX_WATCHED_DIRS) return;
    for (const dir of unique) {
      try {
        const w = fs.watch(dir, { persistent: false }, () => this.schedule(id, e));
        w.on('error', () => w.close());
        e.watchers.push(w);
      } catch {
        /* folder vanished or not watchable */
      }
    }
  }

  private schedule(id: string, e: Entry): void {
    if (e.timer) clearTimeout(e.timer);
    e.timer = setTimeout(() => {
      e.timer = null;
      void this.sync(id, true);
    }, DEBOUNCE_MS);
  }

  private drop(id: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    this.entries.delete(id);
    if (e.timer) clearTimeout(e.timer);
    for (const w of e.watchers) w.close();
  }
}

const configKey = (ws: Workspace): string => JSON.stringify(ws.directory ?? null);
