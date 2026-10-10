import fs from 'node:fs';
import path from 'node:path';

import type { GitService } from '../../service/git-service';
import { opPaths, type OpPaths } from '../../service/phase3/state';
import type { GitErrorCode, RepoInfo } from '../../types';
import type { OpContext } from '../queue';
import { fail, unmergedPaths } from './util';

/** Helpers shared by the Phase 3 history-rewriting executors (spec 05 §6.5–§6.9, spec 08 §6.7). */

const STATE_NAMES: Record<RepoInfo['state'], string> = {
  clean: '',
  merging: 'merge',
  rebasing: 'rebase',
  'rebasing-interactive': 'rebase',
  'applying-mailbox': 'patch application (git am)',
  'cherry-picking': 'cherry-pick',
  reverting: 'revert',
  bisecting: 'bisect',
};

/** Refuse to start while another operation is in progress (spec 08 §6.1 state files). */
export async function requireIdle(ctx: OpContext, what: string): Promise<RepoInfo> {
  const svc = ctx.service;
  if (svc.repo.isBare) throw fail('Unknown', `Cannot ${what} in a bare repository.`);
  const info = await svc.refreshRepoInfo();
  if (info.state !== 'clean' && info.state !== 'bisecting') {
    throw fail('Unknown', `Finish or abort the ${STATE_NAMES[info.state]} in progress before you ${what}.`, {
      state: info.state,
    });
  }
  const p = await opPaths(svc);
  if (fs.existsSync(path.join(p.sequencer, 'todo'))) {
    throw fail('Unknown', `Finish or abort the cherry-pick/revert in progress before you ${what}.`, {
      state: 'sequencer',
    });
  }
  const files = await unmergedPaths(svc);
  if (files.length) {
    throw fail('Unknown', `Resolve the conflicted files before you ${what}.`, { files });
  }
  if (!info.head.sha) throw fail('UnbornBranch');
  return info;
}

/** Continue is only allowed once `git ls-files -u` is empty (spec 08 §6.7). */
export async function requireResolved(service: GitService, code: GitErrorCode): Promise<void> {
  const files = await unmergedPaths(service);
  if (files.length) throw fail(code, 'Resolve all conflicts before continuing.', { files });
}

/** Write `message` into the given state files (MERGE_MSG, rebase-merge/message…) that exist. */
export function overwriteMessage(message: string, files: string[]): void {
  const text = message.endsWith('\n') ? message : `${message}\n`;
  for (const f of files) {
    if (fs.existsSync(f)) fs.writeFileSync(f, text, 'utf8');
  }
}

/**
 * An editor command for git that copies `src` over the file git asks to edit. Git runs editors through
 * its `sh` (bundled with Git for Windows / MinGit) as `<cmd> "$@"`, so `cp '<src>'` becomes
 * `cp '<src>' <file>`. Forward slashes keep MSYS happy on Windows.
 */
export function copyEditor(src: string): string {
  const p = src.replace(/\\/g, '/').replace(/'/g, `'\\''`);
  return `cp '${p}'`;
}

/** Shell-quoted path for `exec` lines in a rebase todo (run by git's sh). */
export function shQuote(p: string): string {
  return `'${p.replace(/\\/g, '/').replace(/'/g, `'\\''`)}'`;
}

/** Per-gitdir scratch dir for files that must outlive one op (interactive rebase messages). */
export function scratchDir(service: GitService, name: string): string {
  const dir = path.join(service.repo.gitDir, 'githappens', name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Drop interactive-rebase scratch files once no rebase is in progress any more. */
export async function cleanupRebaseScratch(service: GitService): Promise<void> {
  const info = await service.refreshRepoInfo();
  if (info.state === 'rebasing' || info.state === 'rebasing-interactive') return;
  fs.rmSync(path.join(service.repo.gitDir, 'githappens', 'rebase-i'), { recursive: true, force: true });
}

export { opPaths, type OpPaths };
