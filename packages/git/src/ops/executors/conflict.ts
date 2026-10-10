import fs from 'node:fs';
import path from 'node:path';

import { stagesOf, worktreePath } from '../../service/phase3/load';
import { hasConflictMarkers, rawBlob } from '../../service/phase3/shared';
import { readUnmerged } from '../../service/phase3/state';
import type { GitService } from '../../service/git-service';
import type { OpContext } from '../queue';
import type { GitOperation, OpResult, SpecialResolution } from '../types';
import { define, fail, git, plural, read, unmergedPaths, withConflictFiles } from './util';

/** Literal pathspecs: conflict paths are file names, never patterns. */
const LITERAL = { GIT_LITERAL_PATHSPECS: '1' };

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

function checkPaths(service: GitService, paths: string[]): void {
  if (!paths.length) throw fail('Unknown', 'No files selected.');
  for (const p of paths) worktreePath(service, p);
}

function onDisk(service: GitService, rel: string): boolean {
  try {
    fs.lstatSync(worktreePath(service, rel));
    return true;
  } catch {
    return false;
  }
}

/** `git add` paths present on disk, `git rm --cached` the rest (spec 08 §6.6 "Mark resolved"). */
async function stageResolution(ctx: OpContext, paths: string[]): Promise<void> {
  const add = paths.filter((p) => onDisk(ctx.service, p));
  const rm = paths.filter((p) => !add.includes(p));
  if (add.length) await git(ctx, ['add', '--', ...add], { env: LITERAL });
  if (rm.length) await git(ctx, ['rm', '-q', '--cached', '--ignore-unmatch', '--', ...rm], { env: LITERAL });
}

/** `update-index --chmod=±x` (spec 08 §6.6 "mode change"); the path must already be staged. */
async function chmod(ctx: OpContext, rel: string, executable: boolean): Promise<void> {
  await git(ctx, ['update-index', `--chmod=${executable ? '+' : '-'}x`, '--', rel], { env: LITERAL });
  if (process.platform !== 'win32') {
    try {
      const abs = worktreePath(ctx.service, rel);
      const mode = fs.statSync(abs).mode;
      fs.chmodSync(abs, executable ? mode | 0o111 : mode & ~0o111);
    } catch {
      /* the index is what counts */
    }
  }
}

const detectEol = (text: string): '\n' | '\r\n' | null => {
  const nl = text.indexOf('\n');
  if (nl < 0) return null;
  return nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
};

/** Save the merge tool output (spec 08 §4.5): keep the file's EOL style, optionally `git add`. */
async function saveFile(
  ctx: OpContext,
  rel: string,
  text: string,
  markResolved: boolean,
  executable?: boolean,
): Promise<Omit<OpResult<{ hasMarkers: boolean }>, 'opId'>> {
  const abs = worktreePath(ctx.service, rel);
  let eol: '\n' | '\r\n' | null = null;
  try {
    eol = detectEol(fs.readFileSync(abs, 'utf8'));
  } catch {
    /* new / deleted file */
  }
  if (!eol) {
    // fall back to "ours" (spec 08 §6.3 "EOL: detect from ours")
    const st = await stagesOf(ctx.service, rel);
    const sha = st.ours?.sha ?? st.theirs?.sha;
    if (sha) {
      const r = await ctx.service.runRead(['cat-file', '-p', sha], { expectedExitCodes: [0, 128] });
      if (r.exitCode === 0) eol = detectEol(r.stdout);
    }
  }
  const normalized = text.replace(/\r?\n/g, eol ?? (detectEol(text) || '\n'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, normalized, 'utf8');
  const hasMarkers = hasConflictMarkers(normalized);
  if (markResolved) {
    await stageResolution(ctx, [rel]);
    if (executable !== undefined) await chmod(ctx, rel, executable);
  }
  return {
    summary: markResolved ? `Saved and marked ${rel} resolved` : `Saved ${rel}`,
    ...(hasMarkers ? { warnings: [`${rel} still contains conflict markers.`] } : {}),
    data: { hasMarkers },
  };
}

/** Stage a gitlink at `sha` (spec 08 §6.6 "submodule to chosen sha"); replaces the unmerged entries. */
async function stageGitlink(ctx: OpContext, rel: string, sha: string): Promise<void> {
  if (!SHA.test(sha)) throw fail('Unknown', `"${sha}" is not a full commit id.`);
  await git(ctx, ['update-index', '--cacheinfo', `160000,${sha},${rel}`], { env: LITERAL });
}

/**
 * Take a whole side (spec 08 §6.6): `checkout --ours|--theirs` + add; a side that deleted the file → rm.
 * `base` writes stage 1 (read by object id, never through a shell redirect). Submodules stage the gitlink of
 * that side (`update-index --cacheinfo`), since `checkout --ours` can't handle gitlinks.
 */
async function take(
  ctx: OpContext,
  paths: string[],
  side: 'ours' | 'theirs' | 'base',
): Promise<Omit<OpResult, 'opId'>> {
  const svc = ctx.service;
  checkPaths(svc, paths);
  const unmerged = new Map((await readUnmerged(svc)).map((e) => [e.path, e]));
  const checkout: string[] = [];
  const remove: string[] = [];
  const gitlinks: { path: string; sha: string }[] = [];
  const blobs: { path: string; sha: string; mode: string }[] = [];
  for (const p of paths) {
    const e = unmerged.get(p);
    if (!e) continue; // already resolved
    const st = e.stages[side];
    if (!st) remove.push(p);
    else if (st.mode === '160000') gitlinks.push({ path: p, sha: st.sha });
    else if (side === 'base') blobs.push({ path: p, sha: st.sha, mode: st.mode });
    else checkout.push(p);
  }
  if (!checkout.length && !remove.length && !gitlinks.length && !blobs.length)
    throw fail('Unknown', 'None of the selected files has conflicts.');
  if (checkout.length) {
    await git(ctx, ['checkout', `--${side}`, '--', ...checkout], { env: LITERAL });
    await git(ctx, ['add', '--', ...checkout], { env: LITERAL });
  }
  const links = blobs.some((b) => b.mode === '120000') ? await coreSymlinks(svc) : false;
  for (const b of blobs) {
    const abs = worktreePath(svc, b.path);
    const data = await rawBlob(svc, b.sha);
    fs.rmSync(abs, { force: true });
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (b.mode === '120000') writeLink(abs, data.toString('utf8'), links);
    else fs.writeFileSync(abs, data);
    await git(ctx, ['update-index', '--cacheinfo', `${b.mode},${b.sha},${b.path}`], { env: LITERAL });
  }
  for (const g of gitlinks) await stageGitlink(ctx, g.path, g.sha);
  if (remove.length) await git(ctx, ['rm', '-q', '--ignore-unmatch', '--', ...remove], { env: LITERAL });
  const label = side === 'ours' ? 'current' : side === 'theirs' ? 'incoming' : 'base';
  return {
    summary: `Took ${label} version of ${paths.length === 1 ? paths[0] : plural(paths.length, 'file')}`,
  };
}

/** Write a symlink, or a plain file with the target when symlinks aren't available (core.symlinks=false). */
function writeLink(abs: string, target: string, symlinks: boolean): void {
  if (symlinks) {
    try {
      fs.symlinkSync(target, abs);
      return;
    } catch {
      /* no symlink rights (Windows without developer mode) */
    }
  }
  fs.writeFileSync(abs, target, 'utf8');
}

async function coreSymlinks(service: GitService): Promise<boolean> {
  const r = await read(service, ['config', '--type=bool', '--get', 'core.symlinks'], {
    expectedExitCodes: [0, 1],
  });
  return r.exitCode === 0 ? r.stdout.trim() === 'true' : process.platform !== 'win32';
}

async function keepPath(ctx: OpContext, rel: string): Promise<void> {
  const svc = ctx.service;
  if (!onDisk(svc, rel)) {
    // the side that kept the file wasn't written to the worktree: restore it from its stage
    const st = await stagesOf(svc, rel);
    const side = st.theirs ? 'theirs' : st.ours ? 'ours' : null;
    if (!side) throw fail('Unknown', `No version of ${rel} is left to keep.`);
    if (st[side]!.mode === '160000') {
      await stageGitlink(ctx, rel, st[side]!.sha);
      return;
    }
    await git(ctx, ['checkout', `--${side}`, '--', rel], { env: LITERAL });
  }
  await git(ctx, ['add', '--', rel], { env: LITERAL });
}

async function deletePath(ctx: OpContext, rel: string): Promise<void> {
  await git(ctx, ['rm', '-q', '--ignore-unmatch', '--', rel], { env: LITERAL });
  if (onDisk(ctx.service, rel)) fs.rmSync(worktreePath(ctx.service, rel), { force: true, recursive: true });
}

/**
 * Special conflict resolutions (spec 08 §4.6, §6.6): keep / delete (DU/UD/AU/UA/DD), a whole side, a submodule
 * commit, a symlink target, the executable bit, or a rename/rename group.
 */
async function resolveSpecial(
  ctx: OpContext,
  rel: string,
  action: SpecialResolution,
): Promise<Omit<OpResult, 'opId'>> {
  const svc = ctx.service;
  checkPaths(svc, [rel]);
  if (action === 'delete') {
    await deletePath(ctx, rel);
    return { summary: `Deleted ${rel}` };
  }
  if (action === 'keep') {
    await keepPath(ctx, rel);
    return { summary: `Kept ${rel}` };
  }
  if (action === 'take-ours' || action === 'take-theirs')
    return take(ctx, [rel], action === 'take-ours' ? 'ours' : 'theirs');
  if ('submoduleSha' in action) {
    const sha = action.submoduleSha.trim().toLowerCase();
    await stageGitlink(ctx, rel, sha);
    return { summary: `Set submodule ${rel} to ${sha.slice(0, 7)}` };
  }
  if ('symlinkTarget' in action) {
    const target = action.symlinkTarget;
    if (!target || /[\0\r\n]/.test(target)) throw fail('Unknown', 'Invalid symbolic link target.');
    const h = await git(ctx, ['hash-object', '-w', '--stdin'], { stdin: target });
    const sha = h.stdout.trim();
    const abs = worktreePath(svc, rel);
    fs.rmSync(abs, { force: true });
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    writeLink(abs, target, await coreSymlinks(svc));
    await git(ctx, ['update-index', '--cacheinfo', `120000,${sha},${rel}`], { env: LITERAL });
    return { summary: `Set ${rel} → ${target}` };
  }
  if ('executable' in action) {
    await stageResolution(ctx, [rel]);
    await chmod(ctx, rel, action.executable);
    return { summary: `Resolved ${rel} as ${action.executable ? 'executable' : 'not executable'}` };
  }
  if ('rename' in action) {
    const { keep, remove } = action.rename;
    const all = [...keep, ...remove];
    checkPaths(svc, all);
    if (!keep.length && !remove.length) throw fail('Unknown', 'Nothing to resolve.');
    const unmerged = new Set((await readUnmerged(svc)).map((e) => e.path));
    for (const p of keep) {
      if (unmerged.has(p)) await keepPath(ctx, p);
    }
    for (const p of remove) await deletePath(ctx, p);
    return {
      summary: keep.length
        ? `Kept ${keep.join(', ')}${remove.length ? `; removed ${plural(remove.length, 'path')}` : ''}`
        : `Removed ${plural(remove.length, 'path')}`,
    };
  }
  throw fail('Unknown', 'Unknown resolution.');
}

async function markResolved(ctx: OpContext, paths: string[]): Promise<Omit<OpResult, 'opId'>> {
  checkPaths(ctx.service, paths);
  await stageResolution(ctx, paths);
  return { summary: `Marked ${paths.length === 1 ? paths[0] : plural(paths.length, 'file')} resolved` };
}

/** Re-create the conflict from the resolve-undo info (spec 08 §6.6: `git checkout -m`). */
async function markUnresolved(ctx: OpContext, paths: string[]): Promise<Omit<OpResult, 'opId'>> {
  checkPaths(ctx.service, paths);
  try {
    await git(ctx, ['checkout', '-m', '--', ...paths], { env: LITERAL });
  } catch (e) {
    // gitlinks (and paths whose blobs are gone) can't be re-merged into the worktree: restore the
    // unmerged index entries from HEAD / MERGE_HEAD only (`update-index` takes no `--`)
    const r = await git(ctx, ['update-index', '--unresolve', ...paths.map((p) => `./${p}`)], {
      env: LITERAL,
      expectedExitCodes: [0, 1, 128],
    });
    const back = await unmergedPaths(ctx.service);
    if (r.exitCode !== 0 || !paths.some((p) => back.includes(p))) throw e;
  }
  return { summary: `Marked ${paths.length === 1 ? paths[0] : plural(paths.length, 'file')} unresolved` };
}

/** git's built-in mergetool names are plain words; anything else could smuggle `-c` keys. */
const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * Strategy A (spec 08 §6.8): let `git mergetool` drive the tool non-interactively. stdin is closed, so any
 * "Was the merge successful?" style prompt reads EOF and git leaves the file unmerged.
 */
async function mergetool(
  ctx: OpContext,
  op: Extract<GitOperation, { type: 'conflict.mergetool' }>,
): Promise<Omit<OpResult<{ exitCode: number; resolved: boolean }>, 'opId'>> {
  checkPaths(ctx.service, [op.path]);
  if (op.tool !== undefined && !TOOL_NAME.test(op.tool))
    throw fail('Unknown', `Invalid merge tool "${op.tool}".`);
  if (op.toolPath !== undefined && /[\0\r\n]/.test(op.toolPath))
    throw fail('Unknown', 'Invalid merge tool path.');
  const cfg = ['-c', `mergetool.keepBackup=${op.keepBackup ? 'true' : 'false'}`];
  if (op.tool && op.toolPath) cfg.push('-c', `mergetool.${op.tool}.path=${op.toolPath}`);
  if (op.tool && op.trustExitCode !== undefined) {
    cfg.push('-c', `mergetool.${op.tool}.trustExitCode=${op.trustExitCode ? 'true' : 'false'}`);
  }
  const r = await git(
    ctx,
    [...cfg, 'mergetool', '--no-prompt', ...(op.tool ? [`--tool=${op.tool}`] : []), '--', op.path],
    { env: LITERAL, expectedExitCodes: [0, 1, 2, 255] },
  );
  const resolved = !(await unmergedPaths(ctx.service)).includes(op.path);
  if (
    !resolved &&
    /not available|Unknown merge tool|no merge\.tool|is not a valid/i.test(r.stderr + r.stdout)
  ) {
    const tail = (r.stderr || r.stdout).trim().split('\n').slice(-2).join(' ');
    throw fail('Unknown', tail || 'git mergetool failed.');
  }
  return {
    summary: resolved ? `Resolved ${op.path} with the merge tool` : `${op.path} is still unresolved`,
    data: { exitCode: r.exitCode, resolved },
  };
}

/** Stash apply/pop "Reset conflicted changes" (spec 08 §6.7): `git reset --merge`; the stash itself is kept. */
async function resetMerge(ctx: OpContext): Promise<Omit<OpResult, 'opId'>> {
  await git(ctx, ['reset', '--merge']);
  await ctx.service.refreshRepoInfo();
  return { summary: 'Reset the conflicted changes' };
}

/** `git am --continue|--skip|--abort` (spec 08 §6.7), never opening an editor. */
async function am(ctx: OpContext, verb: 'continue' | 'skip' | 'abort'): Promise<Omit<OpResult, 'opId'>> {
  if (verb === 'continue') {
    const unmerged = await unmergedPaths(ctx.service);
    if (unmerged.length)
      throw fail('Unknown', `Resolve ${plural(unmerged.length, 'conflicted file')} before continuing.`, {
        files: unmerged,
      });
  }
  try {
    await git(ctx, ['am', `--${verb}`], { env: { GIT_EDITOR: 'true' } });
  } catch (e) {
    await ctx.service.refreshRepoInfo();
    return withConflictFiles(ctx.service, e, 'MergeConflict');
  }
  const still = (await ctx.service.refreshRepoInfo()).state === 'applying-mailbox';
  return {
    summary:
      verb === 'abort'
        ? 'Patch application aborted'
        : still
          ? `Patch ${verb === 'skip' ? 'skipped' : 'applied'}; more patches are pending`
          : 'All patches applied',
  };
}

const TOUCHES: ('status' | 'conflicts' | 'repoState')[] = ['status', 'conflicts', 'repoState'];

const SIDE_LABEL = { ours: 'current', theirs: 'incoming', base: 'base' } as const;

function specialLabel(op: Extract<GitOperation, { type: 'conflict.resolveSpecial' }>): string {
  const a = op.action;
  if (a === 'keep') return `Keep ${op.path}`;
  if (a === 'delete') return `Delete ${op.path}`;
  if (a === 'take-ours') return `Take current for ${op.path}`;
  if (a === 'take-theirs') return `Take incoming for ${op.path}`;
  if ('submoduleSha' in a) return `Set submodule ${op.path} to ${a.submoduleSha.slice(0, 7)}`;
  if ('symlinkTarget' in a) return `Set link target of ${op.path}`;
  if ('executable' in a) return `Resolve mode of ${op.path}`;
  return `Resolve rename of ${op.path}`;
}

export const conflictOps = {
  'conflict.saveFile': define(
    'conflict.saveFile',
    { label: (op) => `Save ${op.path}`, touches: TOUCHES },
    (ctx, op) => saveFile(ctx, op.path, op.text, op.markResolved, op.executable),
  ),
  'conflict.take': define(
    'conflict.take',
    {
      label: (op) =>
        `Take ${SIDE_LABEL[op.side]} for ${op.paths.length === 1 ? op.paths[0] : plural(op.paths.length, 'file')}`,
      touches: TOUCHES,
    },
    (ctx, op) => take(ctx, op.paths, op.side),
  ),
  'conflict.resolveSpecial': define(
    'conflict.resolveSpecial',
    { label: specialLabel, touches: TOUCHES },
    (ctx, op) => resolveSpecial(ctx, op.path, op.action),
  ),
  'conflict.markResolved': define(
    'conflict.markResolved',
    {
      label: (op) => `Mark ${op.paths.length === 1 ? op.paths[0] : plural(op.paths.length, 'file')} resolved`,
      touches: TOUCHES,
      // journaled as 'mark-resolved' (spec 05 §11): undo re-creates the conflict stages
      undoable: true,
    },
    (ctx, op) => markResolved(ctx, op.paths),
  ),
  'conflict.markUnresolved': define(
    'conflict.markUnresolved',
    {
      label: (op) =>
        `Mark ${op.paths.length === 1 ? op.paths[0] : plural(op.paths.length, 'file')} unresolved`,
      touches: TOUCHES,
    },
    (ctx, op) => markUnresolved(ctx, op.paths),
  ),
  'conflict.mergetool': define(
    'conflict.mergetool',
    {
      label: (op) => `Resolve ${op.path} in ${op.tool ?? 'the git merge tool'}`,
      touches: TOUCHES,
      cancellable: true,
    },
    (ctx, op) => mergetool(ctx, op),
  ),
  'conflict.resetMerge': define(
    'conflict.resetMerge',
    { label: () => 'Reset conflicted changes', touches: [...TOUCHES, 'stash'] },
    (ctx) => resetMerge(ctx),
  ),
  'am.continue': define(
    'am.continue',
    { label: () => 'Continue applying patches', touches: [...TOUCHES, 'refs', 'graph'] },
    (ctx) => am(ctx, 'continue'),
  ),
  'am.skip': define('am.skip', { label: () => 'Skip patch', touches: [...TOUCHES, 'refs', 'graph'] }, (ctx) =>
    am(ctx, 'skip'),
  ),
  'am.abort': define(
    'am.abort',
    { label: () => 'Abort applying patches', touches: [...TOUCHES, 'refs', 'graph'] },
    (ctx) => am(ctx, 'abort'),
  ),
};
