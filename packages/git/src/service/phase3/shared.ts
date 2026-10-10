import fs from 'node:fs';

import { GitError, makeError } from '../../errors/classify';
import { normalizeGitPath } from '../../parsers/revparse';
import type { GitProcessRunner } from '../../process/runner';
import type { SerializedGitError, Sha } from '../../types';
import type { GitService } from '../git-service';

/** Phase 3 helpers shared by the conflict reads (spec 08) and the history-rewrite executors (spec 05). */

export const short = (sha: string | null | undefined): string => (sha ? sha.slice(0, 7) : '');

/** Absolute paths for `git rev-parse --git-path <name>` (worktree-aware, spec 08 §8 "Worktrees"). */
export async function gitPaths<N extends string>(
  service: GitService,
  names: readonly N[],
): Promise<Record<N, string>> {
  const r = await service.runRead([
    'rev-parse',
    '--path-format=absolute',
    ...names.flatMap((n) => ['--git-path', n]),
  ]);
  const lines = r.stdout.split(/\r?\n/).filter(Boolean);
  const out = {} as Record<N, string>;
  names.forEach((n, i) => {
    out[n] = normalizeGitPath(lines[i] ?? '');
  });
  return out;
}

export function readText(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

export function exists(p: string): boolean {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Largest stage blob loaded as text for the merge tool (bigger files get Take A/B only). */
export const MAX_TEXT_BYTES = 16 * 1024 * 1024;

/** Raw bytes of an object (binary safe; `BlobReader` decodes to utf8/base64). */
export async function rawBlob(service: GitService, sha: Sha, maxBuffer = 64 * 1024 * 1024): Promise<Buffer> {
  const runner = service['runner'] as GitProcessRunner;
  const r = await runner.run({
    cwd: service.cwd,
    args: ['cat-file', 'blob', sha],
    readOnly: true,
    encoding: 'buffer',
    maxBuffer,
  });
  return r.stdout as Buffer;
}

/** `sha → subject` for a few commits (one process). */
export async function subjects(service: GitService, shas: Sha[]): Promise<Map<Sha, string>> {
  const out = new Map<Sha, string>();
  const list = [...new Set(shas.filter(Boolean))];
  if (!list.length) return out;
  const r = await service.runRead(['show', '-s', '--no-walk=unsorted', '--format=%H%x00%s', ...list, '--'], {
    expectedExitCodes: [0, 128],
  });
  for (const line of r.stdout.split(/\r?\n/)) {
    const i = line.indexOf('\0');
    if (i > 0) out.set(line.slice(0, i), line.slice(i + 1));
  }
  return out;
}

/** Full commit messages (`%B`) for a few commits. */
export async function messages(service: GitService, shas: Sha[]): Promise<Map<Sha, string>> {
  const out = new Map<Sha, string>();
  const list = [...new Set(shas.filter(Boolean))];
  if (!list.length) return out;
  const r = await service.runRead([
    'show',
    '-s',
    '--no-walk=unsorted',
    '--format=%H%x00%B%x1e',
    ...list,
    '--',
  ]);
  for (const rec of r.stdout.split('\x1e')) {
    const t = rec.replace(/^\r?\n/, '');
    const i = t.indexOf('\0');
    if (i > 0) out.set(t.slice(0, i), t.slice(i + 1));
  }
  return out;
}

/** Human name for a commit: a local/remote branch pointing at it, else `name-rev`, else the short sha. */
export async function refLabel(service: GitService, sha: Sha): Promise<string> {
  const pointing = await service.runRead(
    ['for-each-ref', '--points-at', sha, '--format=%(refname:short)', 'refs/heads', 'refs/remotes'],
    { expectedExitCodes: [0, 128, 129] },
  );
  const first = pointing.stdout.split(/\r?\n/).find((l) => l && !l.endsWith('/HEAD'));
  if (first) return first;
  const nr = await service.runRead(
    ['name-rev', '--name-only', '--no-undefined', '--refs=refs/heads/*', '--refs=refs/remotes/*', sha],
    { expectedExitCodes: [0, 128] },
  );
  const name = nr.exitCode === 0 ? nr.stdout.trim().replace(/^remotes\//, '') : '';
  return name || short(sha);
}

/** Resolve revs to full shas (null when missing). */
export async function resolveAll(service: GitService, revs: string[]): Promise<(Sha | null)[]> {
  return Promise.all(revs.map((r) => service.revParse(r)));
}

export function gitFail(message: string, details?: SerializedGitError['details']): GitError {
  return new GitError(makeError('Unknown', { argv: [] }, message, details));
}

export const MARKER_LINE = /^(<{7}|={7}|>{7})( |$)/m;

export function hasConflictMarkers(text: string): boolean {
  return MARKER_LINE.test(text);
}
