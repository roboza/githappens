import fs from 'node:fs';
import path from 'node:path';

import type { GitService } from '../service/git-service';
import type { GitOperationType } from './types';

/**
 * Helpers for settings-driven op behaviour (Phase 7): profile identity injection (spec 13 §6),
 * submodule auto-update (spec 09 §6.9) and `.orig` clean-up (spec 13 General).
 */

// ---- profile identity (spec 13 §6 "Profile git identity sync") ----

export interface CommitIdentity {
  name?: string;
  email?: string;
}

/** Ops that can create commits, tags or stashes, i.e. read `user.name` / `user.email`. */
export const IDENTITY_OPS: ReadonlySet<GitOperationType> = new Set<GitOperationType>([
  'commit.create',
  'commit.rewordHead',
  'checkout.run', // stash strategy
  'tag.create',
  'stash.push',
  'pull',
  'merge.run',
  'merge.continue',
  'rebase.run',
  'rebase.interactive',
  'rebase.continue',
  'rebase.skip',
  'cherryPick.run',
  'revert.run',
  'sequencer.continue',
  'sequencer.skip',
  'ai.compose',
  'gitflow.init',
  'gitflow.start',
  'gitflow.finish',
  'gitflow.continue',
  'patch.apply',
  'pr.checkout',
  'submodule.add',
]);

/** `user.name` / `user.email` set in the repository's own config (`git config --local`). */
export async function readLocalIdentity(service: GitService): Promise<CommitIdentity> {
  const r = await service.runRead(['config', '--local', '-z', '--get-regexp', '^user\\.(name|email)$'], {
    expectedExitCodes: [0, 1],
  });
  const out: CommitIdentity = {};
  if (r.exitCode !== 0) return out;
  for (const rec of r.stdout.split('\0')) {
    const nl = rec.indexOf('\n');
    if (nl < 0) continue;
    const key = rec.slice(0, nl).toLowerCase();
    const value = rec.slice(nl + 1);
    if (key === 'user.name' && value) out.name = value;
    if (key === 'user.email' && value) out.email = value;
  }
  return out;
}

const usable = (v: string | undefined): v is string => !!v && !!v.trim() && !/[\0\r\n]/.test(v);

/**
 * `-c user.name=… -c user.email=…` for a commit-creating op. Precedence (spec 13 §6): repo-local
 * `user.*` wins (nothing injected for that key); otherwise a non-empty profile value overrides the
 * global / system config; an empty profile value leaves git's own config in charge.
 */
export function identityConfigArgs(
  profile: CommitIdentity | null | undefined,
  local: CommitIdentity,
): string[] {
  const args: string[] = [];
  if (!profile) return args;
  if (!local.name && usable(profile.name)) args.push('-c', `user.name=${profile.name.trim()}`);
  if (!local.email && usable(profile.email)) args.push('-c', `user.email=${profile.email.trim()}`);
  return args;
}

/** Whether repo-local identity differs from the profile (composer notice, spec 13 §8). */
export function identityOverridden(
  profile: CommitIdentity | null | undefined,
  local: CommitIdentity,
): boolean {
  if (!local.name && !local.email) return false;
  const differs = (a?: string, b?: string): boolean =>
    !!a && (b ?? '').trim().toLowerCase() !== a.trim().toLowerCase();
  return differs(local.email, profile?.email) || differs(local.name, profile?.name);
}

// ---- submodule auto-update (spec 09 §6.9 "Auto-update after git actions") ----

/** Ops after which submodules are brought up to date when `general.autoUpdateSubmodules` is on. */
export const SUBMODULE_UPDATE_OPS: ReadonlySet<GitOperationType> = new Set<GitOperationType>([
  'checkout.run',
  'pull',
  'merge.run',
  'merge.continue',
  'rebase.run',
  'rebase.continue',
  'reset.run',
  'ff.run',
  'pr.checkout',
]);

/** Gitlinks (mode 160000) that differ between two commits; `from` null = every gitlink in `to`. */
export async function changedSubmodulePaths(
  service: GitService,
  from: string | null,
  to: string,
): Promise<string[]> {
  if (!from) {
    const r = await service.runRead(['ls-tree', '-r', '-z', to], { expectedExitCodes: [0, 128] });
    if (r.exitCode !== 0) return [];
    return r.stdout
      .split('\0')
      .filter((l) => l.startsWith('160000 '))
      .map((l) => l.slice(l.indexOf('\t') + 1));
  }
  if (from === to) return [];
  const r = await service.runRead(['diff', '--raw', '-z', '--no-renames', '--no-ext-diff', from, to, '--'], {
    expectedExitCodes: [0, 128],
  });
  if (r.exitCode !== 0) return [];
  // -z raw: ":<srcmode> <dstmode> <src> <dst> <status>\0<path>\0"
  const parts = r.stdout.split('\0');
  const out: string[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i]!;
    const p = parts[i + 1]!;
    if (!meta.startsWith(':')) break;
    const [srcMode, dstMode] = meta.slice(1).split(' ');
    // a gitlink that was removed needs no update
    if (dstMode === '160000' || (srcMode === '160000' && dstMode !== '000000')) out.push(p);
  }
  return out;
}

/** True when the worktree has a `.gitmodules` file. */
export function hasGitmodules(service: GitService): boolean {
  const root = service.repo.worktreeRoot;
  return !!root && fs.existsSync(path.join(root, '.gitmodules'));
}

// ---- .orig clean-up (spec 13 General "Delete .orig files after merge") ----

/** Ops that mark conflicted paths resolved, with the paths they resolve. */
export function resolvedPaths(op: { type: GitOperationType } & Record<string, unknown>): string[] {
  switch (op.type) {
    case 'conflict.markResolved':
    case 'conflict.take':
      return Array.isArray(op.paths) ? (op.paths as string[]) : [];
    case 'conflict.saveFile':
      return op.markResolved && typeof op.path === 'string' ? [op.path] : [];
    case 'conflict.resolveSpecial':
      return typeof op.path === 'string' ? [op.path] : [];
    default:
      return [];
  }
}

/**
 * Delete untracked `<path>.orig` backups (left by merge tools) of the given repo-relative paths.
 * Tracked `.orig` files are never touched. Returns the deleted repo-relative paths.
 */
export async function deleteOrigBackups(service: GitService, paths: string[]): Promise<string[]> {
  const root = service.repo.worktreeRoot;
  if (!root || !paths.length) return [];
  const candidates = paths
    .map((p) => `${p.replace(/\\/g, '/')}.orig`)
    .filter((rel) => {
      const abs = path.resolve(root, rel);
      const inside = path.relative(root, abs);
      return !inside.startsWith('..') && !path.isAbsolute(inside) && fs.existsSync(abs);
    });
  if (!candidates.length) return [];
  const tracked = await service.runRead(['ls-files', '-z', '--', ...candidates], {
    expectedExitCodes: [0, 1, 128],
    env: { GIT_LITERAL_PATHSPECS: '1' },
  });
  const trackedSet = new Set(tracked.stdout.split('\0').filter(Boolean));
  const deleted: string[] = [];
  for (const rel of candidates) {
    if (trackedSet.has(rel)) continue;
    try {
      await fs.promises.rm(path.resolve(root, rel), { force: true });
      deleted.push(rel);
    } catch {
      /* best effort */
    }
  }
  return deleted;
}
