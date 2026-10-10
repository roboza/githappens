import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ConflictFileContents, ConflictStage } from '../../types';
import { isBinary } from '../blob-reader';
import type { GitService } from '../git-service';
import { gitFail, MAX_TEXT_BYTES, rawBlob } from './shared';
import { mergeAttrs } from './state';

type Side = 'base' | 'ours' | 'theirs';

/** Index stages of one path from `git ls-files -u` (`<mode> <oid> <stage>\t<path>`). */
export async function stagesOf(
  service: GitService,
  file: string,
): Promise<Partial<Record<Side, ConflictStage>>> {
  const r = await service.runRead(['ls-files', '-u', '-z', '--', file], {
    env: { GIT_LITERAL_PATHSPECS: '1' },
  });
  const out: Partial<Record<Side, ConflictStage>> = {};
  for (const rec of r.stdout.split('\0')) {
    const m = /^(\d+) ([0-9a-f]+) ([123])\t(.*)$/s.exec(rec);
    if (!m || m[4] !== file) continue;
    const side: Side = m[3] === '1' ? 'base' : m[3] === '2' ? 'ours' : 'theirs';
    out[side] = { mode: m[1]!, sha: m[2]! };
  }
  return out;
}

/** Absolute worktree path for a repo-relative path; refuses anything that escapes the worktree. */
export function worktreePath(service: GitService, rel: string): string {
  const root = service.repo.worktreeRoot;
  if (!root) throw gitFail('This repository has no working tree.');
  if (!rel || /[\0]/.test(rel) || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) {
    throw gitFail(`Invalid path: "${rel}".`);
  }
  const abs = path.resolve(root, rel);
  const relBack = path.relative(root, abs);
  if (!relBack || relBack.startsWith('..') || path.isAbsolute(relBack)) {
    throw gitFail(`Path is outside the working tree: "${rel}".`);
  }
  const first = relBack.split(/[\\/]/)[0]!.toLowerCase();
  if (first === '.git') throw gitFail(`Refusing to touch the .git directory: "${rel}".`);
  return abs;
}

function detectEol(...texts: (string | null)[]): '\n' | '\r\n' {
  for (const t of texts) {
    if (t === null) continue;
    const nl = t.indexOf('\n');
    if (nl < 0) continue;
    return nl > 0 && t[nl - 1] === '\r' ? '\r\n' : '\n';
  }
  return '\n';
}

/** Marker size for `merge-file`: 1 + the longest marker-like run at a line start, when ≥ 7 (spec 08 §6.4). */
export function markerSizeFor(...texts: (string | null)[]): number {
  let longest = 0;
  const re = /^([<=>|])\1*/gm;
  for (const t of texts) {
    if (!t) continue;
    for (const m of t.matchAll(re)) longest = Math.max(longest, m[0].length);
  }
  return longest >= 7 ? Math.min(32, longest + 1) : 7;
}

/**
 * `conflict:loadFile` (spec 08 §6.3, §6.4): the three stages, the working file and a fresh
 * `git merge-file -p --diff3` merge of them. Binary (by content or attributes), oversized and submodule
 * conflicts come back with `binary: true`, empty text for the sides that exist and no merge.
 */
export async function loadConflictFile(service: GitService, file: string): Promise<ConflictFileContents> {
  const abs = worktreePath(service, file);
  const stages = await stagesOf(service, file);
  const attrs = (await mergeAttrs(service, [file])).get(file) ?? { binary: false };

  const bufs: Record<Side, Buffer | null> = { base: null, ours: null, theirs: null };
  let binary = attrs.binary;
  for (const side of ['base', 'ours', 'theirs'] as const) {
    const st = stages[side];
    if (!st) continue;
    if (st.mode === '160000') {
      bufs[side] = Buffer.from(`Subproject commit ${st.sha}\n`);
      binary = true;
      continue;
    }
    const buf = await rawBlob(service, st.sha, MAX_TEXT_BYTES).catch(() => null);
    if (!buf || isBinary(buf)) binary = true;
    bufs[side] = buf ?? Buffer.alloc(0);
  }
  let workingBuf: Buffer | null = null;
  try {
    const st = fs.statSync(abs);
    if (st.isFile()) {
      if (st.size > MAX_TEXT_BYTES) binary = true;
      else workingBuf = fs.readFileSync(abs);
    }
  } catch {
    /* deleted in the worktree (e.g. modify/delete) */
  }
  if (workingBuf && isBinary(workingBuf)) binary = true;

  const text = (b: Buffer | null): string | null => (b === null ? null : binary ? '' : b.toString('utf8'));
  const base = text(bufs.base);
  const ours = text(bufs.ours);
  const theirs = text(bufs.theirs);
  const working = workingBuf === null ? null : binary ? '' : workingBuf.toString('utf8');
  const eol = detectEol(ours, theirs, base, working);

  let mergedDiff3: string | null = null;
  if (!binary && bufs.ours && bufs.theirs) {
    if (attrs.driver)
      mergedDiff3 = working; // custom merge driver: keep its result as is
    else mergedDiff3 = await mergeFile(service, bufs, markerSizeFor(base, ours, theirs));
  }
  return {
    path: file,
    base,
    ours,
    theirs,
    working,
    mergedDiff3,
    binary,
    eol,
    ...(attrs.driver ? { mergeDriver: attrs.driver } : {}),
    ...(attrs.binary ? { attrBinary: true } : {}),
  };
}

async function mergeFile(
  service: GitService,
  bufs: Record<Side, Buffer | null>,
  markerSize: number,
): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-merge-'));
  const id = randomUUID().slice(0, 8);
  const p = (n: string): string => path.join(dir, `${n}-${id}`);
  try {
    fs.writeFileSync(p('ours'), bufs.ours ?? Buffer.alloc(0));
    fs.writeFileSync(p('base'), bufs.base ?? Buffer.alloc(0));
    fs.writeFileSync(p('theirs'), bufs.theirs ?? Buffer.alloc(0));
    const args = ['merge-file', '-p', '--diff3'];
    if (markerSize !== 7) args.push(`--marker-size=${markerSize}`);
    args.push('-L', 'A', '-L', 'base', '-L', 'B', p('ours'), p('base'), p('theirs'));
    // exit code = number of conflicts (0..127); ≥ 128 (or negative) = error
    const r = await service.runRead(args, {
      expectedExitCodes: Array.from({ length: 128 }, (_, i) => i),
    });
    return r.stdout;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
