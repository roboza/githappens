import fs from 'node:fs';
import path from 'node:path';

import { GitError, GitService, type GitProcessRunner } from '@githappens/git';

import type { CloneTargetInfo, ValidateRepoResult } from '../../shared/ipc/repos2-contract';
import { isDubiousOwnership, safeDirectoryFor } from './safe-directory';

type Features = NonNullable<Parameters<typeof GitService.open>[2]>['features'];

/**
 * Validate a folder without adding it to recents (spec 03 `repos:validate`): resolves subfolders to the
 * toplevel, detects bare repos / worktrees, and classifies notARepo / unsafeDirectory / permission.
 */
export async function validateRepoPath(
  runner: GitProcessRunner,
  p: string,
  features?: Features,
  /** Shared, never-disposed service provider (RepoManager.borrow: reused by the open that follows). */
  borrow?: (abs: string) => Promise<GitService>,
): Promise<ValidateRepoResult> {
  let abs = path.resolve(p);
  if (!fs.existsSync(abs))
    return { ok: false, reason: 'notFound', path: abs, message: 'The folder does not exist.' };
  // A dropped / passed file opens the repository containing it.
  if (!fs.statSync(abs).isDirectory()) abs = path.dirname(abs);
  let service: GitService;
  try {
    service = borrow ? await borrow(abs) : await GitService.open(runner, abs, { features });
  } catch (e) {
    if (e instanceof GitError) {
      const stderr = `${e.serialized.stderr}\n${e.message}`;
      if (isDubiousOwnership(stderr)) {
        return {
          ok: false,
          reason: 'unsafeDirectory',
          path: abs,
          message: 'Git refuses to open this repository because it is owned by another user.',
          safeDirectory: safeDirectoryFor(abs, e.serialized.stderr),
        };
      }
      if (e.code === 'NotARepository') {
        return { ok: false, reason: 'notARepo', path: abs, message: 'This folder is not a Git repository.' };
      }
    }
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      return { ok: false, reason: 'permission', path: abs, message: 'Permission denied.' };
    }
    throw e;
  }
  try {
    const info = service.repo;
    const remotes = await service.remotes().catch(() => []);
    const remote = remotes.find((r) => r.name === 'origin') ?? remotes[0];
    const root = info.worktreeRoot ?? info.gitDir;
    return {
      ok: true,
      repo: {
        path: root,
        name: path.basename(root.replace(/[\\/]\.git$/, '')),
        isBare: info.isBare,
        commonDir: info.isLinkedWorktree ? info.commonDir : undefined,
        remoteUrl: remote?.fetchUrl,
        lastBranch: info.head.kind === 'branch' ? info.head.name : undefined,
        favorite: false,
        groupIds: [],
      },
    };
  } finally {
    if (!borrow) service.dispose();
  }
}

/** Nearest enclosing folder holding a `.git` entry (nested-repo warning). */
export function enclosingRepo(start: string): string | undefined {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

/** Full-path preview for the clone / init dialogs (spec 03 §4.3: red + disabled when non-empty). */
export function inspectTarget(parentDir: string, folderName: string): CloneTargetInfo {
  if (typeof parentDir !== 'string' || !parentDir.trim()) throw new Error('Choose a folder first.');
  if (
    typeof folderName !== 'string' ||
    !folderName.trim() ||
    /[\\/\0\r\n]/.test(folderName) ||
    /^\.\.?$/.test(folderName)
  )
    throw new Error('Invalid folder name.');
  const target = path.join(path.resolve(parentDir), folderName);
  let exists = false;
  let empty = false;
  try {
    const st = fs.statSync(target);
    exists = true;
    empty = st.isDirectory() && fs.readdirSync(target).length === 0;
  } catch {
    /* does not exist */
  }
  const insideRepo = enclosingRepo(parentDir);
  return { path: target, exists, empty, ...(insideRepo ? { insideRepo } : {}) };
}
