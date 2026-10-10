import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseJsonc, type ParseError } from 'jsonc-parser';

import type { ScannedRepo } from '../../shared/ipc/workspaces-contract';
import { canonicalPath } from '../services/canonical-path';
import { mapLimit, pathKey } from './util';

/** Spec 11 §8: directory-synced roots with 1,000+ repos are capped. */
export const SCAN_CAP = 500;
export const DEFAULT_IGNORE = ['node_modules', '.git/modules'];

export interface ScanOptions {
  root: string;
  depth: number;
  ignore?: string[];
  /** Descend into repos to find nested repos / submodules. */
  includeNested?: boolean;
  cap?: number;
}

export interface ScanResult {
  /** Repo roots (absolute), in walk order. */
  paths: string[];
  truncated: boolean;
  /** Non-repo folders visited above `depth` (what a directory watcher needs to watch). */
  dirs: string[];
}

/** Minimal glob → RegExp: `**` any path, `*` within a segment, `?` one char. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  const g = glob.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === '*' && g[i + 1] === '*') {
      re += '.*';
      i++;
      if (g[i + 1] === '/') i++;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

/** A folder is ignored when a glob matches its relative path (from the scan root) or any tail of it. */
export function makeIgnore(globs: string[]): (rel: string) => boolean {
  const res = globs.filter((g) => g.trim()).map(globToRegExp);
  return (rel) => {
    const parts = rel.replace(/\\/g, '/').split('/');
    for (let i = 0; i < parts.length; i++) {
      const tail = parts.slice(i).join('/');
      if (res.some((re) => re.test(tail))) return true;
    }
    return false;
  };
}

/**
 * Breadth-first walk with `fs.opendir` (spec 11 §6.2). A folder containing `.git` (dir, or file for
 * worktrees/submodules) is a repo; repos are not descended into unless `includeNested`. Symlinked
 * folders are followed once (realpath tracking breaks loops).
 */
export async function scanForRepos(o: ScanOptions): Promise<ScanResult> {
  // Canonical root (8.3 short names expanded) so found repos match registry / workspace paths.
  const root = canonicalPath(o.root);
  const cap = o.cap ?? SCAN_CAP;
  const ignored = makeIgnore(o.ignore ?? DEFAULT_IGNORE);
  const seen = new Set<string>();
  const paths: string[] = [];
  const dirs: string[] = [];
  let queue: string[] = [root];
  for (let level = 0; queue.length && level <= o.depth; level++) {
    const next: string[] = [];
    for (const dir of queue) {
      const key = pathKey(dir);
      if (seen.has(key)) continue;
      seen.add(key);
      let handle: fs.Dir;
      try {
        handle = await fs.promises.opendir(dir);
      } catch {
        continue; // permission denied, vanished, …
      }
      let isRepo = false;
      const children: string[] = [];
      for await (const ent of handle) {
        if (ent.name === '.git') {
          isRepo = true;
          continue;
        }
        const child = path.join(dir, ent.name);
        let isDir = ent.isDirectory();
        if (ent.isSymbolicLink()) {
          try {
            isDir = (await fs.promises.stat(child)).isDirectory();
          } catch {
            isDir = false;
          }
        }
        if (isDir && !ignored(path.relative(root, child))) children.push(child);
      }
      if (isRepo) {
        paths.push(dir);
        if (paths.length >= cap) return { paths, truncated: true, dirs };
        if (!o.includeNested) continue;
      } else if (level < o.depth) dirs.push(dir);
      if (level < o.depth) next.push(...children.sort((a, b) => a.localeCompare(b)));
    }
    queue = next;
  }
  return { paths, truncated: false, dirs };
}

export type RemotesOf = (repoPath: string) => Promise<Array<{ name: string; url: string }>>;

/** Scan + remotes per repo (≤ 6 git processes at once). */
export async function scanDirectory(
  o: ScanOptions,
  remotesOf: RemotesOf,
): Promise<{ repos: ScannedRepo[]; truncated: boolean }> {
  const r = await scanForRepos(o);
  const repos = await mapLimit(r.paths, 6, async (p) => ({
    path: p,
    name: path.basename(p),
    remotes: await remotesOf(p).catch(() => []),
  }));
  return { repos, truncated: r.truncated };
}

export interface CodeWorkspaceFolder {
  /** Absolute folder path, or null when it is not a local folder. */
  path: string | null;
  label: string;
  name?: string;
}

/**
 * `.code-workspace` folders (JSONC: comments + trailing commas). `path` is relative to the file's
 * directory; `uri` entries are kept only for `file://` (remote URIs are skipped by the caller).
 */
export function parseCodeWorkspace(text: string, filePath: string): CodeWorkspaceFolder[] {
  const errors: ParseError[] = [];
  const doc = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false }) as unknown;
  if (!doc || typeof doc !== 'object' || !Array.isArray((doc as { folders?: unknown }).folders)) {
    throw new Error('Not a VS Code workspace file (no "folders" list).');
  }
  const base = path.dirname(filePath);
  const out: CodeWorkspaceFolder[] = [];
  for (const f of (doc as { folders: unknown[] }).folders) {
    if (!f || typeof f !== 'object') continue;
    const o = f as { path?: unknown; uri?: unknown; name?: unknown };
    const name = typeof o.name === 'string' && o.name ? o.name : undefined;
    if (typeof o.path === 'string') {
      out.push({ path: path.resolve(base, o.path), label: o.path, ...(name ? { name } : {}) });
    } else if (typeof o.uri === 'string') {
      let p: string | null = null;
      if (o.uri.startsWith('file:')) {
        try {
          p = fileURLToPath(o.uri);
        } catch {
          p = null;
        }
      }
      out.push({ path: p, label: o.uri, ...(name ? { name } : {}) });
    }
  }
  return out;
}

export const codeWorkspaceName = (filePath: string): string =>
  path.basename(filePath).replace(/\.code-workspace$/i, '');
