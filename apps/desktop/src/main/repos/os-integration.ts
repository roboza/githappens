import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { RepoRecord } from '../../shared/ipc/shell-contract';

/**
 * OS-level repo entry points (spec 03 §7 steps 4, 8, 16): Windows JumpList / macOS recent documents from the
 * registry, macOS `open-file`, and folders dropped onto the window. Electron objects are passed in so this
 * stays testable.
 */

export const MAX_OS_RECENTS = 10;

export interface JumpListTask {
  type: 'task';
  title: string;
  description: string;
  program: string;
  args: string;
  iconPath: string;
  iconIndex: number;
}

/** "Recent repositories" JumpList category: each task relaunches the app with `-p "<path>"`. */
export function jumpListTasks(repos: RepoRecord[], exe: string, extraArgs: string[] = []): JumpListTask[] {
  return repos
    .filter((r) => !r.missing && !/["\r\n]/.test(r.path))
    .slice(0, MAX_OS_RECENTS)
    .map((r) => ({
      type: 'task',
      title: (r.alias ?? r.name).slice(0, 200),
      description: r.path,
      program: exe,
      args: [...extraArgs.map((a) => `"${a}"`), '-p', `"${r.path}"`].join(' '),
      iconPath: exe,
      iconIndex: 0,
    }));
}

/** Most recently opened first, independent of favorites ordering. */
export function byRecency(repos: RepoRecord[]): RepoRecord[] {
  return [...repos].sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0));
}

export interface AppLike {
  setJumpList?(categories: unknown[] | null): unknown;
  addRecentDocument?(p: string): void;
  clearRecentDocuments?(): void;
}

/** Push the registry to the Windows JumpList / macOS Dock recent documents. Errors are swallowed. */
export function createOsRecents(
  app: AppLike,
  o: { platform: NodeJS.Platform; exe: string; extraArgs?: string[] },
): (repos: RepoRecord[]) => void {
  let last = '';
  return (repos) => {
    const list = byRecency(repos)
      .filter((r) => !r.missing)
      .slice(0, MAX_OS_RECENTS);
    const sig = list.map((r) => `${r.path}|${r.alias ?? ''}`).join('\n');
    if (sig === last) return;
    last = sig;
    try {
      if (o.platform === 'win32' && app.setJumpList) {
        const items = jumpListTasks(list, o.exe, o.extraArgs);
        app.setJumpList(items.length ? [{ type: 'custom', name: 'Recent Repositories', items }] : null);
      } else if (o.platform === 'darwin' && app.addRecentDocument) {
        app.clearRecentDocuments?.();
        // Oldest first so the most recent ends up on top.
        for (const r of [...list].reverse()) app.addRecentDocument(r.path);
      }
    } catch {
      /* JumpList can fail when the user disabled recent items */
    }
  };
}

/**
 * A `file://` navigation caused by dropping something on the window → the local folder to open (or null).
 * Files resolve to their directory so dropping e.g. a README opens its repo.
 */
export function droppedPathFromUrl(url: string): string | null {
  if (!/^file:\/\//i.test(url)) return null;
  let p: string;
  try {
    p = fileURLToPath(url);
  } catch {
    return null;
  }
  try {
    const st = fs.statSync(p);
    return st.isDirectory() ? p : path.dirname(p);
  } catch {
    return null;
  }
}

/**
 * Collects macOS `open-file` paths (Dock drop, Finder "Open With", `open -a GitHappens <dir>`). Paths that
 * arrive before the window can take them are queued; call `ready(open)` once the UI is up.
 */
export function createOpenFileQueue(): {
  push(p: string): void;
  ready(open: (p: string) => void): void;
} {
  let pending: string[] = [];
  let sink: ((p: string) => void) | null = null;
  return {
    push(p) {
      if (typeof p !== 'string' || !p) return;
      if (sink) sink(p);
      else pending.push(p);
    },
    ready(open) {
      sink = open;
      const q = pending;
      pending = [];
      for (const p of q) open(p);
    },
  };
}
