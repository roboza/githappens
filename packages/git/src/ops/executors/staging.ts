import fs from 'node:fs';
import path from 'node:path';

import type { GitService } from '../../service/git-service';
import { batchPathspec, pathBytes, withPathspec } from '../../service/pathspec';
import type { FileDiff, StatusEntry } from '../../types';
import { diffHash, STAGING_DIFF_OPTIONS } from '../diff-hash';
import { parseCheckIgnore, pathOfAnchoredPattern } from '../ignore-pattern';
import { isRawPathKey, opPath, rawPathKey, shownPath } from '../raw-path';
import type { OpContext } from '../queue';
import type { LineRef, OpResult } from '../types';
import { allChangesSelected, buildLinePatch, discardInContent, selectHunk, selectLines } from './patch';
import { define, fail, git, isUnbornHead, plural, read, staleDiff } from './util';

type Result = Promise<Omit<OpResult, 'opId'>>;

// ---- file-level (spec 06 §6.2) ----

/** Line-ending conversion warning git prints while staging (spec 06 §4.8). */
export interface EolWarning {
  path: string;
  kind: 'lf-to-crlf' | 'crlf-to-lf';
}

/**
 * Parse git's EOL conversion warnings from `git add` stderr. Both forms are recognised:
 * "warning: in the working copy of 'p', LF will be replaced by CRLF the next time Git touches it" (2.37+)
 * and "warning: LF will be replaced by CRLF in p." (older).
 */
export function parseEolWarnings(stderr: string): EolWarning[] {
  const out: EolWarning[] = [];
  const seen = new Set<string>();
  for (const line of stderr.split(/\r?\n/)) {
    let m = /in the working copy of '(.+)', (LF|CRLF) will be replaced by (CRLF|LF)/.exec(line);
    let file: string | undefined;
    let from: string | undefined;
    if (m) [, file, from] = m;
    else {
      m = /(LF|CRLF) will be replaced by (CRLF|LF) in (.+?)\.?$/.exec(line);
      if (m) [, from, , file] = m;
    }
    if (!file || !from || seen.has(file)) continue;
    seen.add(file);
    out.push({ path: file, kind: from === 'LF' ? 'lf-to-crlf' : 'crlf-to-lf' });
  }
  return out;
}

const eolData = (stderr: string): { data?: { eolWarnings: EolWarning[] } } => {
  const w = parseEolWarnings(stderr);
  return w.length ? { data: { eolWarnings: w } } : {};
};

async function stagePaths(ctx: OpContext, paths: string[]): Result {
  if (!paths.length) return {};
  const ps = withPathspec(['add', '-A'], paths);
  const r = await git(ctx, ps.args, { stdin: ps.stdin, env: ps.env });
  return { summary: `Staged ${plural(paths.length, 'file')}`, ...eolData(r.stderr) };
}

async function unstagePaths(ctx: OpContext, paths: string[]): Result {
  if (!paths.length) return {};
  const ps = (await isUnbornHead(ctx.service))
    ? withPathspec(['rm', '-r', '--cached', '-q', '--ignore-unmatch'], paths)
    : withPathspec(['restore', '--staged'], paths);
  await git(ctx, ps.args, { stdin: ps.stdin, env: ps.env });
  return { summary: `Unstaged ${plural(paths.length, 'file')}` };
}

async function stageAll(ctx: OpContext): Result {
  const r = await git(ctx, ['add', '-A']);
  return { summary: 'Staged all changes', ...eolData(r.stderr) };
}

async function unstageAll(ctx: OpContext): Result {
  if (await isUnbornHead(ctx.service)) {
    await git(ctx, ['rm', '-r', '--cached', '-q', '--ignore-unmatch', '--', '.']);
  } else {
    await git(ctx, ['reset', '-q']);
  }
  return { summary: 'Unstaged all changes' };
}

const under = (p: string, prefix: string): boolean =>
  p === prefix || p.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`);

function entryPaths(e: StatusEntry): string[] {
  return e.kind === 'renamed' ? [e.path, e.origPath] : [e.path];
}

/** What ops pass for an entry's paths: raw keys for names that are not valid UTF-8 (spec 02 §8). */
function entryKeys(e: StatusEntry): string[] {
  const main = opPath(e);
  if (e.kind !== 'renamed') return [main];
  return [main, e.origRawPath ? rawPathKey(e.origRawPath) : e.origPath];
}

async function discardPaths(ctx: OpContext, paths: string[] | null, includeUntracked: boolean): Result {
  const svc = ctx.service;
  const status = await svc.status({ untracked: includeUntracked ? 'all' : 'no' });
  const req = paths?.map((p) => (isRawPathKey(p) ? p : p.replace(/\\/g, '/')));
  const plain = req?.filter((r) => !isRawPathKey(r)) ?? [];
  // a raw key names its entry exactly; plain paths (files or folders) match by the shown name
  const wanted = (e: StatusEntry): boolean =>
    !req ||
    entryKeys(e).some((k) => req.includes(k)) ||
    entryPaths(e).some((p) => plain.some((r) => under(p, r)));
  const tracked = new Set<string>();
  const untracked: string[] = [];
  for (const e of status.entries) {
    if (e.kind === 'ignored' || !wanted(e)) continue;
    if (e.kind === 'untracked') untracked.push(opPath(e));
    else for (const p of entryKeys(e)) tracked.add(p);
  }
  const unborn = await isUnbornHead(svc);
  if (!req) {
    if (unborn) await git(ctx, ['rm', '-r', '-f', '-q', '--ignore-unmatch', '--', '.']);
    else await git(ctx, ['reset', '--hard', '-q']);
  } else if (tracked.size) {
    const ps = unborn
      ? withPathspec(['rm', '-r', '-f', '-q', '--ignore-unmatch'], [...tracked])
      : withPathspec(['restore', '--source=HEAD', '--staged', '--worktree'], [...tracked]);
    await git(ctx, ps.args, { stdin: ps.stdin, env: ps.env });
  }
  if (includeUntracked && !req) {
    await git(ctx, ['clean', '-f', '-d', '-q']);
  } else if (includeUntracked && untracked.length) {
    // names that are not valid UTF-8 can't go through argv exactly (a `:(glob)` pathspec could also match
    // a sibling that differs only in those bytes): untracked files are removed by their bytes instead
    const root = svc.repo.worktreeRoot;
    const raw = root ? untracked.filter(isRawPathKey) : [];
    for (const k of raw) {
      await fs.promises.rm(Buffer.concat([Buffer.from(`${root}/`), pathBytes(k)]), { force: true });
    }
    const plainUntracked = untracked.filter((p) => !raw.includes(p));
    if (plainUntracked.length) {
      for (const b of batchPathspec(['clean', '-f', '-d', '-q'], plainUntracked))
        await git(ctx, b.args, { env: b.env });
    }
  }
  const n = req ? tracked.size + (includeUntracked ? untracked.length : 0) : status.entries.length;
  return { summary: `Discarded changes in ${plural(n, 'file')}` };
}

// ---- ignore (spec 06 §6.7) ----

/** `git check-ignore -v --no-index` for a path; null when it is not ignored. */
export async function checkIgnored(
  service: GitService,
  p: string,
): Promise<{ source: string; line: number; pattern: string } | null> {
  const r = await read(service, ['check-ignore', '-v', '--no-index', '--', p], {
    expectedExitCodes: [0, 1, 128],
  });
  if (r.exitCode !== 0) return null;
  const hit = parseCheckIgnore(r.stdout.split(/\r?\n/)[0] ?? '');
  if (!hit || hit.pattern.startsWith('!')) return null;
  return { source: hit.source, line: hit.line, pattern: hit.pattern };
}

async function alreadyIgnored(
  service: GitService,
  pattern: string,
): Promise<{ source: string; line: number; pattern: string } | null> {
  const p = pathOfAnchoredPattern(pattern);
  return p ? checkIgnored(service, p) : null;
}

async function ignore(ctx: OpContext, pattern: string, stopTracking?: string[]): Result {
  const root = ctx.service.repo.worktreeRoot;
  if (!root) throw fail('Unknown', 'This operation needs a working tree (bare repository).');
  const pat = pattern.replace(/[\r\n]+/g, '');
  if (!pat.trim()) throw fail('Unknown', 'The ignore pattern is empty.');
  const file = path.join(root, '.gitignore');
  let text = '';
  try {
    text = await fs.promises.readFile(file, 'utf8');
  } catch {
    /* created below */
  }
  const warnings: string[] = [];
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const existing = text.split(/\r?\n/);
  const already = existing.includes(pat) ? null : await alreadyIgnored(ctx.service, pat);
  if (existing.includes(pat)) warnings.push(`"${pat}" is already in .gitignore.`);
  else if (already) {
    warnings.push(`Already ignored by ${already.source}:${already.line} (${already.pattern}).`);
  } else {
    const sep = text && !text.endsWith('\n') ? eol : '';
    await fs.promises.writeFile(file, `${text}${sep}${pat}${eol}`, 'utf8');
  }
  if (stopTracking?.length) {
    const ps = withPathspec(['rm', '-r', '--cached', '-q', '--ignore-unmatch'], stopTracking);
    await git(ctx, ps.args, { stdin: ps.stdin, env: ps.env });
  }
  return {
    summary: already ? `Already ignored: ${pat}` : `Ignored ${pat}`,
    ...(warnings.length ? { warnings } : {}),
    ...(already ? { data: { alreadyIgnored: already } } : {}),
  };
}

// ---- hunk / line staging (spec 06 §6.4–6.6) ----

const matches = (f: FileDiff, p: string): boolean => f.newPath === p || f.oldPath === p;

async function isUntracked(svc: GitService, p: string): Promise<boolean> {
  const r = await read(svc, ['ls-files', '-z', '--others', '--exclude-standard', '--', p], {
    env: { GIT_LITERAL_PATHSPECS: '1' },
  });
  return r.stdout.split('\0').includes(p);
}

/** Recompute the diff the UI showed (spec 06 §5 `diffHash`) and refuse when it changed. */
async function currentDiff(
  svc: GitService,
  p: string,
  side: 'unstaged' | 'staged',
  expectedHash: string,
): Promise<{ file: FileDiff; untracked: boolean }> {
  const filePath = p.replace(/\\/g, '/');
  let file: FileDiff | undefined;
  let untracked = false;
  if (side === 'staged') {
    file = (await svc.diff({ kind: 'staged', paths: [filePath] }, STAGING_DIFF_OPTIONS)).find((f) =>
      matches(f, filePath),
    );
  } else {
    file = (await svc.diff({ kind: 'workdir', paths: [filePath] }, STAGING_DIFF_OPTIONS)).find((f) =>
      matches(f, filePath),
    );
    if (!file && (await isUntracked(svc, filePath))) {
      untracked = true;
      file = (await svc.diff({ kind: 'untracked', path: filePath }, STAGING_DIFF_OPTIONS))[0];
    }
  }
  if (!file || diffHash(file) !== expectedHash) throw staleDiff();
  if (file.binary || file.tooLarge || file.submodule || file.lfsPointer) {
    throw fail(
      'Unknown',
      'Hunk and line staging is not available for this file; stage the whole file instead.',
    );
  }
  return { file, untracked };
}

const lineSel = (file: FileDiff, lines: LineRef[]): Set<string> => {
  const s = selectLines(file, lines);
  if (!s) throw staleDiff();
  return s;
};
const hunkSel = (file: FileDiff, hunkIndex: number): Set<string> => {
  if (!file.hunks[hunkIndex]) throw staleDiff();
  return selectHunk(file, hunkIndex);
};

async function applyCached(ctx: OpContext, patch: string, reverse: boolean): Promise<void> {
  if (!patch) return;
  const args = ['apply', '--cached', '--whitespace=nowarn', '--recount', ...(reverse ? ['-R'] : []), '-'];
  await git(ctx, args, { stdin: Buffer.from(patch, 'utf8') });
}

async function fileModeOf(ctx: OpContext, p: string): Promise<string> {
  if (process.platform === 'win32' || !ctx.service.repo.worktreeRoot) return '100644';
  try {
    const st = await fs.promises.stat(path.join(ctx.service.repo.worktreeRoot, p));
    return st.mode & 0o111 ? '100755' : '100644';
  } catch {
    return '100644';
  }
}

async function stageSelection(
  ctx: OpContext,
  p: string,
  hash: string,
  pick: (f: FileDiff) => Set<string>,
): Result {
  const { file, untracked } = await currentDiff(ctx.service, p, 'unstaged', hash);
  const sel = pick(file);
  if (!sel.size) return {};
  const all = allChangesSelected(file, sel);
  if (untracked && all) await git(ctx, ['add', '--', p]);
  else if (file.status === 'D' && all) await git(ctx, ['rm', '--cached', '-q', '--', p]);
  else {
    const lp = buildLinePatch(file, sel, 'stage', {
      ...(untracked ? { path: p, fileMode: await fileModeOf(ctx, p) } : {}),
    });
    if (lp) await applyCached(ctx, lp.patch, lp.reverse);
  }
  return { summary: `Staged changes in ${p}` };
}

async function unstageSelection(
  ctx: OpContext,
  p: string,
  hash: string,
  pick: (f: FileDiff) => Set<string>,
): Result {
  const { file } = await currentDiff(ctx.service, p, 'staged', hash);
  const sel = pick(file);
  if (!sel.size) return {};
  const lp = buildLinePatch(file, sel, 'unstage', { path: file.newPath ?? file.oldPath ?? p });
  if (lp) await applyCached(ctx, lp.patch, lp.reverse);
  return { summary: `Unstaged changes in ${p}` };
}

/** In-memory discard against the worktree file (CRLF-safe, spec 06 §6.6). */
async function discardSelection(
  ctx: OpContext,
  p: string,
  hash: string,
  pick: (f: FileDiff) => Set<string>,
): Result {
  const root = ctx.service.repo.worktreeRoot;
  if (!root) throw fail('Unknown', 'This operation needs a working tree (bare repository).');
  const { file } = await currentDiff(ctx.service, p, 'unstaged', hash);
  const sel = pick(file);
  if (!sel.size) return {};
  const abs = path.join(root, file.newPath ?? p);
  let content: Buffer = Buffer.alloc(0);
  let mode: number | undefined;
  try {
    content = await fs.promises.readFile(abs);
    mode = (await fs.promises.stat(abs)).mode;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    mode = file.oldMode === '100755' ? 0o755 : 0o644;
  }
  const next = discardInContent(content, file, sel);
  await fs.promises.mkdir(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.githappens-${process.pid}-${Date.now()}.tmp`;
  await fs.promises.writeFile(tmp, next, { mode });
  try {
    await fs.promises.rename(tmp, abs);
  } catch (e) {
    await fs.promises.rm(tmp, { force: true });
    throw e;
  }
  return { summary: `Discarded changes in ${p}` };
}

// ---- definitions ----

const STATUS: ['status'] = ['status'];

export const stagingOps = {
  'wip.stage': define(
    'wip.stage',
    {
      label: (op) =>
        `Stage ${op.paths.length === 1 ? shownPath(op.paths[0]!) : plural(op.paths.length, 'file')}`,
      touches: STATUS,
    },
    (ctx, op) => stagePaths(ctx, op.paths),
  ),
  'wip.unstage': define(
    'wip.unstage',
    {
      label: (op) =>
        `Unstage ${op.paths.length === 1 ? shownPath(op.paths[0]!) : plural(op.paths.length, 'file')}`,
      touches: STATUS,
    },
    (ctx, op) => unstagePaths(ctx, op.paths),
  ),
  'wip.stageAll': define('wip.stageAll', { label: () => 'Stage all changes', touches: STATUS }, (ctx) =>
    stageAll(ctx),
  ),
  'wip.unstageAll': define('wip.unstageAll', { label: () => 'Unstage all changes', touches: STATUS }, (ctx) =>
    unstageAll(ctx),
  ),
  'wip.stageHunk': define(
    'wip.stageHunk',
    { label: (op) => `Stage hunk in ${op.path}`, touches: STATUS },
    (ctx, op) => stageSelection(ctx, op.path, op.diffHash, (f) => hunkSel(f, op.hunkIndex)),
  ),
  'wip.unstageHunk': define(
    'wip.unstageHunk',
    { label: (op) => `Unstage hunk in ${op.path}`, touches: STATUS },
    (ctx, op) => unstageSelection(ctx, op.path, op.diffHash, (f) => hunkSel(f, op.hunkIndex)),
  ),
  'wip.discardHunk': define(
    'wip.discardHunk',
    { label: (op) => `Discard hunk in ${op.path}`, touches: STATUS, undoable: true },
    (ctx, op) => discardSelection(ctx, op.path, op.diffHash, (f) => hunkSel(f, op.hunkIndex)),
  ),
  'wip.stageLines': define(
    'wip.stageLines',
    { label: (op) => `Stage ${plural(op.lines.length, 'line')} in ${op.path}`, touches: STATUS },
    (ctx, op) => stageSelection(ctx, op.path, op.diffHash, (f) => lineSel(f, op.lines)),
  ),
  'wip.unstageLines': define(
    'wip.unstageLines',
    { label: (op) => `Unstage ${plural(op.lines.length, 'line')} in ${op.path}`, touches: STATUS },
    (ctx, op) => unstageSelection(ctx, op.path, op.diffHash, (f) => lineSel(f, op.lines)),
  ),
  'wip.discardLines': define(
    'wip.discardLines',
    {
      label: (op) => `Discard ${plural(op.lines.length, 'line')} in ${op.path}`,
      touches: STATUS,
      undoable: true,
    },
    (ctx, op) => discardSelection(ctx, op.path, op.diffHash, (f) => lineSel(f, op.lines)),
  ),
  'wip.discard': define(
    'wip.discard',
    {
      label: (op) =>
        `Discard changes in ${op.paths.length === 1 ? shownPath(op.paths[0]!) : plural(op.paths.length, 'file')}`,
      touches: STATUS,
      undoable: true,
    },
    (ctx, op) => discardPaths(ctx, op.paths, op.includeUntracked),
  ),
  'wip.discardAll': define(
    'wip.discardAll',
    { label: () => 'Discard all changes', touches: STATUS, undoable: true },
    (ctx, op) => discardPaths(ctx, null, op.includeUntracked),
  ),
  'wip.ignore': define('wip.ignore', { label: (op) => `Ignore ${op.pattern}`, touches: STATUS }, (ctx, op) =>
    ignore(ctx, op.pattern, op.stopTracking),
  ),
  /**
   * A status allowed to take index.lock (the app's own status runs with GIT_OPTIONAL_LOCKS=0): writes
   * the fsmonitor token and the untracked cache into the index (spec 02 §6.15.2). Background only.
   */
  'index.refresh': define(
    'index.refresh',
    { label: () => 'Refresh index caches', touches: STATUS },
    async (ctx) => {
      await git(ctx, [
        'status',
        '--porcelain=v2',
        '-z',
        '--untracked-files=normal',
        '--ignore-submodules=none',
      ]);
      return {};
    },
  ),
};
