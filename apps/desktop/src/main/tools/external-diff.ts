import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { ExternalDiffRequest } from '../../shared/ipc/tools-contract';
import { toolError } from './launch';

/**
 * External diff (spec 07 §6.9): both sides become real files for the tool. Blob sides are written read-only to
 * `<tmp>/githappens/<random>/{old,new}/<basename>`; a `WORKTREE` side is the working-tree file itself, so edits
 * made in the tool land in the repository.
 */

export interface DiffSides {
  oldFile: string;
  newFile: string;
  /** The temp directory created for this diff (cleaned by `cleanupDiffTemp`). */
  dir: string;
}

export interface MaterializeDeps {
  /** Bytes of `path` at `rev` (`:0` = index); null when the object does not exist. */
  readBlob(rev: string, path: string): Promise<Buffer | null>;
  /** Absolute working-tree path of a repo-relative file (validated by the caller). */
  worktreeFile(rel: string): string;
  /** Root for temp dirs, normally `os.tmpdir()`. */
  tmpRoot: string;
}

export const TEMP_DIR_NAME = 'githappens';

export async function materializeDiff(req: ExternalDiffRequest, d: MaterializeDeps): Promise<DiffSides> {
  const dir = path.join(d.tmpRoot, TEMP_DIR_NAME, randomUUID().slice(0, 12));
  const side = async (which: 'old' | 'new', rev: string, rel: string): Promise<string> => {
    if (rev === 'WORKTREE') {
      const abs = d.worktreeFile(rel);
      if (fs.existsSync(abs)) return abs;
      rev = '';
    }
    let buf: Buffer | null = null;
    if (rev) {
      buf = await d.readBlob(rev === 'INDEX' ? ':0' : rev, rel);
      if (!buf && which === 'new' && rev !== ':0') throw toolError(`${rel} does not exist at ${rev}.`);
    }
    const out = path.join(dir, which, path.basename(rel) || 'file');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, buf ?? Buffer.alloc(0));
    try {
      fs.chmodSync(out, 0o444);
    } catch {
      /* best effort */
    }
    return out;
  };
  const oldFile = await side('old', req.oldRev, req.oldPath ?? req.path);
  const newFile = await side('new', req.newRev, req.path);
  return { oldFile, newFile, dir };
}

/** Remove diff temp dirs older than `maxAgeMs` (tools are detached, so we cannot delete right after launch). */
export function cleanupDiffTemp(tmpRoot: string, maxAgeMs: number, now = Date.now()): number {
  const root = path.join(tmpRoot, TEMP_DIR_NAME);
  let removed = 0;
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return 0;
  }
  for (const n of names) {
    const p = path.join(root, n);
    try {
      if (now - fs.statSync(p).mtimeMs < maxAgeMs) continue;
      const chmodAll = (q: string): void => {
        for (const c of fs.readdirSync(q, { withFileTypes: true })) {
          const cp = path.join(q, c.name);
          if (c.isDirectory()) chmodAll(cp);
          else fs.chmodSync(cp, 0o644);
        }
      };
      chmodAll(p);
      fs.rmSync(p, { recursive: true, force: true });
      removed++;
    } catch {
      /* in use / already gone */
    }
  }
  return removed;
}

const isCommitish = (rev: string): boolean => !!rev && rev !== 'WORKTREE' && rev !== 'INDEX';

/**
 * `git difftool --no-prompt …` arguments for "Git config default" (spec 07 §6.9). git materializes the sides and
 * picks `diff.tool`; the path always follows `--` and is passed as its own argv entry.
 */
export function gitDifftoolArgs(req: ExternalDiffRequest): string[] {
  const s0 = req.spec;
  const revs = [req.oldRev, req.newRev];
  if (s0?.kind === 'commit') revs.push(s0.sha);
  if (s0?.kind === 'range') revs.push(s0.from, s0.to);
  if (revs.some((r) => r.startsWith('-') || /[\0\r\n]/.test(r))) throw toolError('Invalid revision.');
  const base = ['difftool', '--no-prompt'];
  const paths = req.oldPath && req.oldPath !== req.path ? [req.oldPath, req.path] : [req.path];
  const tail = ['--', ...paths];
  const s = req.spec;
  if (s?.kind === 'workdir') return [...base, ...tail];
  if (s?.kind === 'staged') return [...base, '--cached', ...tail];
  if (s?.kind === 'commit') {
    const parent = `${s.sha}^${s.parentIndex ? s.parentIndex + 1 : ''}`;
    return [...base, parent, s.sha, ...tail];
  }
  if (s?.kind === 'range')
    return [...base, s.threeDot ? `${s.from}...${s.to}` : s.from, ...(s.threeDot ? [] : [s.to]), ...tail];
  if (s?.kind === 'untracked')
    throw toolError('git difftool cannot compare an untracked file; stage it first.');
  // No spec: derive from the revisions the diff view shows.
  const { oldRev, newRev } = req;
  if (oldRev === 'INDEX' && newRev === 'WORKTREE') return [...base, ...tail];
  if (oldRev === 'HEAD' && newRev === 'INDEX') return [...base, '--cached', ...tail];
  if (!oldRev && newRev === 'WORKTREE') {
    throw toolError('git difftool cannot compare an untracked file; stage it first.');
  }
  if (isCommitish(oldRev) && newRev === 'WORKTREE') return [...base, oldRev, ...tail];
  if (isCommitish(oldRev) && newRev === 'INDEX') return [...base, '--cached', oldRev, ...tail];
  if (isCommitish(oldRev) && isCommitish(newRev)) return [...base, oldRev, newRev, ...tail];
  if (!oldRev && isCommitish(newRev)) return [...base, `${newRev}^!`, ...tail];
  throw toolError('This change cannot be opened with git difftool; pick a diff tool in Preferences.');
}
