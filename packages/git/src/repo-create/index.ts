import fs from 'node:fs';
import path from 'node:path';

import { GitError, makeError } from '../errors/classify';
import { withLfsProgress } from '../ops/executors/extras/lfs-progress';
import type { GitProcessRunner } from '../process/runner';
import type { ProgressEvent } from '../types';
import { attributesUseLfs, normalizeSparsePaths, parseCustomCloneFlags, sparseUsesCone } from './options';

export * from './options';

/** Clone / init (spec 03 §6). Run outside any repo, so they take the runner instead of a GitService. */

export interface CloneRepoRequest {
  url: string;
  parentDir: string;
  folderName: string;
  bare?: boolean;
  depth?: number;
  /** `--shallow-since=<date>` (YYYY-MM-DD or any git date). */
  shallowSince?: string;
  branch?: string;
  /** With `branch`: only that branch (default true for backwards compatibility). */
  singleBranch?: boolean;
  recurseSubmodules?: boolean;
  /** Allowlisted extra flags (spec 03 §6, `parseCustomCloneFlags`). */
  customFlags?: string;
  /** Sparse checkout: cone (or non-cone when globbed) patterns applied right after the clone. */
  sparse?: { paths: string[]; blobless?: boolean };
  /** Blobless partial clone without sparse (`--filter=blob:none`). */
  blobless?: boolean;
  /** `-c core.longpaths=true` (Windows `core.longpaths` preference, spec 03 §8). */
  longPaths?: boolean;
  /** Run `git lfs pull` when the checkout uses LFS (default true). */
  lfsPull?: boolean;
}

export interface CloneRepoOptions {
  signal?: AbortSignal;
  progress?: (p: ProgressEvent) => void;
  /** Credential env (askpass shim + token, spec 02 §6.3). */
  env?: Record<string, string>;
  opId?: string;
}

export interface CloneRepoResult {
  path: string;
  /** `pulled`: LFS objects downloaded; `unavailable`: the repo uses LFS but git-lfs is missing. */
  lfs?: 'pulled' | 'unavailable' | 'failed';
  sparse?: boolean;
  warnings?: string[];
}

const invalid = (message: string): GitError => new GitError(makeError('Unknown', { argv: [] }, message));

function assertFolderName(name: string): void {
  if (!name.trim() || name === '.' || name === '..' || /[\\/\0\r\n]/.test(name)) {
    throw invalid(`"${name}" is not a valid folder name.`);
  }
}

function isEmptyDir(p: string): boolean {
  try {
    return fs.readdirSync(p).length === 0;
  } catch {
    return false;
  }
}

async function removeDir(p: string): Promise<void> {
  // Windows can hold handles of a just-killed git briefly
  for (let i = 0; i < 10; i++) {
    try {
      await fs.promises.rm(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

/** The `git clone` argv for a request (pure; exported for tests). Throws on invalid input. */
export function buildCloneArgs(req: CloneRepoRequest, target: string): string[] {
  if (!req.url.trim() || req.url.startsWith('-') || /[\0\r\n]/.test(req.url))
    throw invalid('Invalid repository URL.');
  if (req.branch !== undefined && (!req.branch || req.branch.startsWith('-')))
    throw invalid('Invalid branch name.');
  if (req.shallowSince !== undefined && (!req.shallowSince.trim() || /^-|[\0\r\n]/.test(req.shallowSince)))
    throw invalid('Invalid shallow-since date.');
  let custom: string[];
  try {
    custom = parseCustomCloneFlags(req.customFlags);
  } catch (e) {
    throw invalid((e as Error).message);
  }
  const args = req.longPaths ? ['-c', 'core.longpaths=true', 'clone', '--progress'] : ['clone', '--progress'];
  if (req.bare) args.push('--bare');
  if (req.depth !== undefined && req.depth > 0) args.push(`--depth=${Math.floor(req.depth)}`);
  if (req.shallowSince) args.push(`--shallow-since=${req.shallowSince.trim()}`);
  if (req.branch) {
    args.push('--branch', req.branch);
    if (req.singleBranch !== false) args.push('--single-branch');
  }
  if (req.recurseSubmodules) args.push('--recurse-submodules');
  const sparse = req.sparse && !req.bare ? normalizeSparsePaths(req.sparse.paths) : [];
  if ((req.blobless || req.sparse?.blobless) && !custom.some((f) => f.startsWith('--filter=')))
    args.push('--filter=blob:none');
  if (sparse.length) args.push('--sparse');
  args.push(...custom);
  args.push('--', req.url.trim(), target);
  return args;
}

async function hasLfsAttributes(dir: string): Promise<boolean> {
  try {
    return attributesUseLfs(await fs.promises.readFile(path.join(dir, '.gitattributes'), 'utf8'));
  } catch {
    return false;
  }
}

export async function lfsInstalled(runner: GitProcessRunner, cwd: string): Promise<boolean> {
  try {
    const r = await runner.run({
      cwd,
      args: ['lfs', 'version'],
      readOnly: true,
      expectedExitCodes: [0, 1, 2, 128, 129],
    });
    return r.exitCode === 0 && /git-lfs\//i.test(`${String(r.stdout)}${r.stderr}`);
  } catch {
    return false;
  }
}

export async function cloneRepo(
  runner: GitProcessRunner,
  req: CloneRepoRequest,
  o: CloneRepoOptions = {},
): Promise<CloneRepoResult> {
  assertFolderName(req.folderName);
  const parent = path.resolve(req.parentDir);
  const target = path.join(parent, req.folderName);
  const args = buildCloneArgs(req, target);
  const existed = fs.existsSync(target);
  if (existed && !isEmptyDir(target)) {
    throw invalid(`The folder "${target}" already exists and is not empty.`);
  }
  await fs.promises.mkdir(parent, { recursive: true });

  const result: CloneRepoResult = { path: target };
  const warnings: string[] = [];
  try {
    await runner.run({
      cwd: parent,
      args,
      env: o.env,
      signal: o.signal,
      progress: o.progress,
      progressKind: 'clone',
      opId: o.opId,
    });
    const sparse = req.sparse && !req.bare ? normalizeSparsePaths(req.sparse.paths) : [];
    if (sparse.length) {
      o.progress?.({
        phase: 'Sparse checkout',
        percent: null,
        overall: null,
        text: 'Applying sparse checkout…',
      });
      const cone = sparseUsesCone(sparse);
      await runner.run({
        cwd: target,
        args: ['sparse-checkout', 'set', cone ? '--cone' : '--no-cone', '--', ...sparse],
        env: o.env,
        signal: o.signal,
        opId: o.opId,
      });
      result.sparse = true;
    }
  } catch (e) {
    if (!existed) await removeDir(target);
    throw e;
  }

  // LFS (spec 03 §6): `git lfs pull` when the checkout routes files through the LFS filter. A failure here
  // keeps the clone (the user can pull LFS objects later) and is reported as a warning.
  if (!req.bare && req.lfsPull !== false && (await hasLfsAttributes(target))) {
    if (!(await lfsInstalled(runner, target))) {
      result.lfs = 'unavailable';
      warnings.push(
        'This repository uses Git LFS, but git-lfs is not installed. LFS files were not downloaded.',
      );
    } else {
      try {
        o.progress?.({ phase: 'LFS', percent: null, overall: null, text: 'Downloading LFS objects…' });
        await withLfsProgress(
          (p) => o.progress?.({ ...p, phase: `LFS ${p.phase}` }),
          (env) =>
            runner.run({
              cwd: target,
              args: ['lfs', 'pull'],
              env: { ...o.env, ...env },
              signal: o.signal,
              opId: o.opId,
            }),
        );
        result.lfs = 'pulled';
      } catch (e) {
        if (e instanceof GitError && e.code === 'Cancelled') throw e;
        result.lfs = 'failed';
        warnings.push(`git lfs pull failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  if (warnings.length) result.warnings = warnings;
  return result;
}

export interface InitRepoRequest {
  parentDir: string;
  name: string;
  defaultBranch: string;
  /** `.gitignore` text (already concatenated from templates). */
  gitignore?: string;
  /** Rendered LICENSE text. */
  license?: string;
  readme?: boolean;
  initialCommit?: boolean;
  /** `git init --bare` (no files, no commit). */
  bare?: boolean;
  author?: { name: string; email: string };
}

export async function initRepo(runner: GitProcessRunner, req: InitRepoRequest): Promise<{ path: string }> {
  assertFolderName(req.name);
  const target = path.join(path.resolve(req.parentDir), req.name);
  await fs.promises.mkdir(target, { recursive: true });
  const run = (args: string[], extra: { stdin?: string; env?: Record<string, string> } = {}) =>
    runner.run({ cwd: target, args, ...extra });

  const check = await runner.run({
    cwd: target,
    args: ['check-ref-format', '--branch', req.defaultBranch],
    readOnly: true,
    expectedExitCodes: [0, 1, 128],
  });
  if (!req.defaultBranch || req.defaultBranch.startsWith('-') || check.exitCode !== 0) {
    throw new GitError(
      makeError('InvalidRefName', { argv: [] }, `"${req.defaultBranch}" is not a valid branch name.`),
    );
  }
  if (req.bare) {
    await run(['init', '-q', '--bare', `--initial-branch=${req.defaultBranch}`]);
    return { path: target };
  }
  await run(['init', '-q', `--initial-branch=${req.defaultBranch}`]);

  const created: string[] = [];
  if (req.gitignore !== undefined && req.gitignore.trim()) {
    const file = path.join(target, '.gitignore');
    const text = req.gitignore.endsWith('\n') ? req.gitignore : `${req.gitignore}\n`;
    if (fs.existsSync(file)) {
      const existing = await fs.promises.readFile(file, 'utf8');
      if (!existing.includes(text.trim())) {
        await fs.promises.appendFile(file, `${existing.endsWith('\n') || !existing ? '' : '\n'}${text}`);
      }
    } else await fs.promises.writeFile(file, text);
    created.push('.gitignore');
  }
  if (req.license !== undefined && req.license.trim()) {
    const file = path.join(target, 'LICENSE');
    // Never overwrite an existing LICENSE (init in an existing folder, spec 03 §6).
    if (!fs.existsSync(file))
      await fs.promises.writeFile(file, req.license.endsWith('\n') ? req.license : `${req.license}\n`);
    created.push('LICENSE');
  }
  if (req.readme) {
    const file = path.join(target, 'README.md');
    if (!fs.existsSync(file)) await fs.promises.writeFile(file, `# ${req.name}\n`);
    created.push('README.md');
  }
  if (req.initialCommit) {
    if (created.length) await run(['add', '--', ...created]);
    const env: Record<string, string> = {};
    if (req.author) {
      env.GIT_AUTHOR_NAME = req.author.name;
      env.GIT_AUTHOR_EMAIL = req.author.email;
      env.GIT_COMMITTER_NAME = req.author.name;
      env.GIT_COMMITTER_EMAIL = req.author.email;
    }
    await run(['commit', '-q', '--allow-empty', '-F', '-'], { stdin: 'Initial commit\n', env });
  }
  return { path: target };
}

/**
 * Remote init (spec 03 §6 "Init (remote)"): add `origin` and push the default branch with upstream.
 * The local repo is kept when the push fails (the caller shows a retry).
 */
export async function publishToRemote(
  runner: GitProcessRunner,
  repoPath: string,
  req: { url: string; branch: string; remote?: string },
  o: CloneRepoOptions = {},
): Promise<void> {
  const remote = req.remote ?? 'origin';
  if (!req.url.trim() || req.url.startsWith('-') || /[\0\r\n]/.test(req.url))
    throw invalid('Invalid repository URL.');
  if (!req.branch || req.branch.startsWith('-')) throw invalid('Invalid branch name.');
  const existing = await runner.run({
    cwd: repoPath,
    args: ['remote', 'get-url', remote],
    readOnly: true,
    expectedExitCodes: [0, 2, 128],
  });
  if (existing.exitCode === 0)
    await runner.run({ cwd: repoPath, args: ['remote', 'set-url', remote, req.url] });
  else await runner.run({ cwd: repoPath, args: ['remote', 'add', remote, req.url] });
  await runner.run({
    cwd: repoPath,
    args: ['push', '--progress', '-u', remote, `refs/heads/${req.branch}:refs/heads/${req.branch}`],
    env: o.env,
    signal: o.signal,
    progress: o.progress,
    progressKind: 'push',
    opId: o.opId,
  });
}
