import path from 'node:path';

import type { RepoState } from '../types';

/**
 * Parsers for `git rev-parse` repo discovery (spec 02 §6.8, implementation step 4).
 */

/** Discovery args (one value per line, in this order). `--show-toplevel` runs separately (fails in bare repos). */
export const DISCOVERY_ARGS = [
  'rev-parse',
  '--is-bare-repository',
  '--is-shallow-repository',
  '--show-object-format',
  '--path-format=absolute',
  '--absolute-git-dir',
  '--git-common-dir',
];

export interface Discovery {
  isBare: boolean;
  isShallow: boolean;
  objectFormat: 'sha1' | 'sha256';
  gitDir: string;
  commonDir: string;
}

/** Git prints `C:/x/y` on Windows; normalize to the platform form. */
export function normalizeGitPath(p: string): string {
  return path.resolve(p.trim());
}

export function parseDiscovery(stdout: string): Discovery {
  const [bare, shallow, format, gitDir, commonDir] = stdout.split(/\r?\n/);
  return {
    isBare: bare?.trim() === 'true',
    isShallow: shallow?.trim() === 'true',
    objectFormat: format?.trim() === 'sha256' ? 'sha256' : 'sha1',
    gitDir: normalizeGitPath(gitDir ?? ''),
    commonDir: normalizeGitPath(commonDir ?? gitDir ?? ''),
  };
}

/** `git rev-parse -q --verify <rev>` stdout → sha (or null when empty). */
export function parseRevParse(stdout: string): string | null {
  const s = stdout.trim().split(/\r?\n/)[0]?.trim();
  return s && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(s) ? s : null;
}

/** Repo-state files resolved with `rev-parse --git-path` (works in linked worktrees, spec 02 §11). */
export const STATE_FILES = [
  'rebase-merge',
  'rebase-merge/interactive',
  'rebase-apply',
  'rebase-apply/applying',
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'BISECT_LOG',
] as const;
export type StateFile = (typeof STATE_FILES)[number];

export function repoStateFrom(exists: (f: StateFile) => boolean): RepoState {
  if (exists('rebase-merge')) return exists('rebase-merge/interactive') ? 'rebasing-interactive' : 'rebasing';
  if (exists('rebase-apply')) return exists('rebase-apply/applying') ? 'applying-mailbox' : 'rebasing';
  if (exists('MERGE_HEAD')) return 'merging';
  if (exists('CHERRY_PICK_HEAD')) return 'cherry-picking';
  if (exists('REVERT_HEAD')) return 'reverting';
  if (exists('BISECT_LOG')) return 'bisecting';
  return 'clean';
}
