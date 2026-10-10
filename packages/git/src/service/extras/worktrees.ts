import fs from 'node:fs';
import nodePath from 'node:path';

import type { WorktreeInfo } from '../../types';
import type { GitService } from '../git-service';

const caseInsensitiveFs = (): boolean => process.platform === 'win32' || process.platform === 'darwin';

/** Native, realpath'd (when it exists) form of a path printed by git (`C:/x/y` on Windows). */
export function nativePath(p: string): string {
  const resolved = nodePath.resolve(p);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

/** Compare filesystem paths (case-insensitive on win32/darwin). */
export function samePath(a: string, b: string): boolean {
  const na = nodePath.resolve(a);
  const nb = nodePath.resolve(b);
  return caseInsensitiveFs() ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

/**
 * Parse `git worktree list --porcelain` tokens (spec 02 §6.11). Pass the `-z` output split on NUL, or
 * the newline format split on `\n`: records are separated by an empty token. The first record is the
 * main worktree. `isCurrent` is left false (see `listWorktrees`); paths are returned as printed.
 */
export function parseWorktreeList(tokens: string[]): WorktreeInfo[] {
  const out: WorktreeInfo[] = [];
  let cur: WorktreeInfo | null = null;
  const flush = (): void => {
    if (cur) out.push(cur);
    cur = null;
  };
  for (const raw of tokens) {
    const tok = raw.replace(/\r$/, '');
    if (tok === '') {
      flush();
      continue;
    }
    const sp = tok.indexOf(' ');
    const key = sp < 0 ? tok : tok.slice(0, sp);
    const value = sp < 0 ? '' : tok.slice(sp + 1);
    if (key === 'worktree') {
      flush();
      cur = {
        path: value,
        head: null,
        detached: false,
        bare: false,
        isMain: out.length === 0,
        isCurrent: false,
      };
      continue;
    }
    if (!cur) continue;
    const w: WorktreeInfo = cur;
    switch (key) {
      case 'HEAD':
        w.head = /^0+$/.test(value) ? null : value;
        break;
      case 'branch':
        w.branch = value;
        break;
      case 'detached':
        w.detached = true;
        break;
      case 'bare':
        w.bare = true;
        break;
      case 'locked':
        w.locked = value || true;
        break;
      case 'prunable':
        w.prunable = value || true;
        break;
      default:
        break;
    }
  }
  flush();
  return out;
}

/** All worktrees of this repo (spec 02 §6.11, spec 09 §6.10). Paths are native and realpath'd. */
export async function listWorktrees(service: GitService): Promise<WorktreeInfo[]> {
  let r = await service.runRead(['worktree', 'list', '--porcelain', '-z'], { expectedExitCodes: [0, 129] });
  let tokens: string[];
  if (r.exitCode === 0) tokens = r.stdout.split('\0');
  else {
    // git < 2.36: no -z (a path containing a newline is unsupported)
    r = await service.runRead(['worktree', 'list', '--porcelain']);
    tokens = r.stdout.split('\n');
  }
  const current = service.repo.worktreeRoot;
  return parseWorktreeList(tokens).map((w) => {
    const p = nativePath(w.path);
    return { ...w, path: p, isCurrent: current !== null && !w.bare && samePath(p, current) };
  });
}
