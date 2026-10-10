import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { APP_DIR_NAME } from '../../app-names';
import { GitError, makeError } from '../../errors/classify';
import { normalizeGitPath } from '../../parsers/revparse';
import type { GitService } from '../../service/git-service';
import type { OpContext } from '../queue';
import type { CommitOutcome, CommitReq, OpResult } from '../types';
import { define, fail, git, read } from './util';

/** `git:progress` phase carrying raw hook output chunks of `commit.create` (spec 06 §4.6). */
export const HOOK_OUTPUT_PHASE = 'hook-output';

/** `summary` + blank line + `description` (spec 06 §6.8). Trailers are added separately. */
export function buildCommitMessage(summary: string, description: string): string {
  const s = summary.trim();
  const d = description.replace(/\s+$/, '');
  return d.trim() ? `${s}\n\n${d}\n` : `${s}\n`;
}

/** Split a commit message into summary (first paragraph line) and description. */
export function splitMessage(message: string): { summary: string; description: string } {
  const text = message.replace(/\r\n/g, '\n').replace(/\s+$/, '');
  const nl = text.indexOf('\n');
  if (nl < 0) return { summary: text.trim(), description: '' };
  return { summary: text.slice(0, nl).trim(), description: text.slice(nl + 1).replace(/^\n+/, '') };
}

/** HEAD's message for amend / reword (spec 06 `commit:headMessage`). Empty on an unborn branch. */
export async function headMessage(service: GitService): Promise<{ summary: string; description: string }> {
  const r = await read(service, ['log', '-1', '--format=%B', 'HEAD', '--'], { expectedExitCodes: [0, 128] });
  if (r.exitCode !== 0) return { summary: '', description: '' };
  return splitMessage(r.stdout);
}

async function withTrailers(
  ctx: OpContext,
  message: string,
  coAuthors: CommitReq['coAuthors'],
): Promise<string> {
  const valid = coAuthors.filter((c) => c.name.trim() && c.email.trim());
  if (!valid.length) return message;
  const args = ['interpret-trailers', '--if-exists', 'addIfDifferent'];
  for (const c of valid) {
    const name = c.name.replace(/[<>\r\n]/g, '').trim();
    const email = c.email.replace(/[<>\r\n\s]/g, '');
    args.push('--trailer', `Co-authored-by: ${name} <${email}>`);
  }
  const r = await read(ctx.service, args, { stdin: message });
  return r.stdout;
}

async function hookPath(service: GitService, name: string): Promise<string | null> {
  const r = await read(service, ['rev-parse', '--path-format=absolute', '--git-path', `hooks/${name}`], {
    expectedExitCodes: [0, 128],
  });
  const p = r.exitCode === 0 ? normalizeGitPath(r.stdout) : '';
  if (!p) return null;
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return null;
    if (process.platform !== 'win32' && !(st.mode & 0o111)) return null;
    return p;
  } catch {
    return null;
  }
}

const NOT_HOOK: GitError['code'][] = [
  'NothingToCommit',
  'EmptyCommitMessage',
  'GpgSigningFailed',
  'IndexLocked',
  'Cancelled',
  'UnbornBranch',
  'MergeConflict',
];

/**
 * spec 09 §6.12: a commit failing while a pre-commit / commit-msg hook exists and HEAD did not move is
 * reported as HookFailed with the hook's output in `details.output`.
 */
async function classifyCommitFailure(
  ctx: OpContext,
  e: unknown,
  o: { skipHooks: boolean; headBefore: string | null; startedAt: number },
): Promise<never> {
  if (!(e instanceof GitError) || o.skipHooks || NOT_HOOK.includes(e.code)) throw e;
  const svc = ctx.service;
  const [pre, msg] = await Promise.all([hookPath(svc, 'pre-commit'), hookPath(svc, 'commit-msg')]);
  if (!pre && !msg) throw e;
  if ((await svc.revParse('HEAD')) !== o.headBefore) throw e;
  let hook = pre && msg ? 'pre-commit/commit-msg' : pre ? 'pre-commit' : 'commit-msg';
  if (pre && msg) {
    const editMsg = await read(svc, ['rev-parse', '--path-format=absolute', '--git-path', 'COMMIT_EDITMSG']);
    try {
      hook =
        fs.statSync(normalizeGitPath(editMsg.stdout)).mtimeMs >= o.startedAt - 1000
          ? 'commit-msg'
          : 'pre-commit';
    } catch {
      hook = 'pre-commit';
    }
  }
  const s = e.serialized;
  throw new GitError({
    ...makeError('HookFailed', { argv: ['commit'], exitCode: s.exitCode, stderr: s.stderr, opId: ctx.opId }),
    command: s.command,
    message: `The ${hook} hook failed.`,
    details: { hook, output: s.stderr.trim(), ...(s.exitCode !== null ? { exitCode: s.exitCode } : {}) },
  });
}

async function runCommit(
  ctx: OpContext,
  message: string,
  flags: string[],
  o: { skipHooks: boolean; author?: { name: string; email: string } },
): Promise<CommitOutcome> {
  const svc = ctx.service;
  const headBefore = await svc.revParse('HEAD');
  const args = ['commit', '-q', '-F', '-', ...flags];
  if (o.skipHooks) args.push('--no-verify');
  if (o.author) {
    const name = o.author.name.replace(/[<>\r\n]/g, '').trim();
    const email = o.author.email.replace(/[<>\r\n\s]/g, '');
    args.push(`--author=${name} <${email}>`);
  }
  const startedAt = Date.now();
  // hooks print to stderr (git redirects hook stdout there): stream it to the composer's drawer
  const onStderr = o.skipHooks
    ? undefined
    : (chunk: string): void =>
        ctx.progress({ phase: HOOK_OUTPUT_PHASE, percent: null, overall: null, text: chunk });
  let stderr: string;
  try {
    ({ stderr } = await git(ctx, args, {
      stdin: Buffer.from(message, 'utf8'),
      ...(onStderr ? { onStderr } : {}),
    }));
  } catch (e) {
    return classifyCommitFailure(ctx, e, { skipHooks: o.skipHooks, headBefore, startedAt });
  }
  const sha = await svc.revParse('HEAD');
  if (!sha) throw fail('Unknown', 'The commit did not produce a HEAD commit.');
  await svc.refreshRepoInfo();
  const hookOutput = stderr.trim();
  return { sha, ...(hookOutput ? { hookOutput } : {}) };
}

async function createCommit(ctx: OpContext, req: CommitReq): Promise<Omit<OpResult<CommitOutcome>, 'opId'>> {
  if (!req.summary.trim()) {
    throw new GitError(makeError('EmptyCommitMessage', { argv: ['commit'] }, 'The commit summary is empty.'));
  }
  if (req.amend && !(await ctx.service.revParse('HEAD'))) {
    throw fail('UnbornBranch', 'There is no commit to amend yet.');
  }
  const message = await withTrailers(ctx, buildCommitMessage(req.summary, req.description), req.coAuthors);
  const flags = [`--cleanup=${req.cleanup}`];
  if (req.amend) flags.push('--amend');
  if (req.allowEmpty) flags.push('--allow-empty');
  if (req.sign === 'force') flags.push('-S');
  else if (req.sign === 'off') flags.push('--no-gpg-sign');
  const data = await runCommit(ctx, message, flags, { skipHooks: req.skipHooks, author: req.author });
  return { summary: `${req.amend ? 'Amended' : 'Committed'} ${data.sha.slice(0, 7)}`, data };
}

async function rewordHead(
  ctx: OpContext,
  summary: string,
  description: string,
): Promise<Omit<OpResult<CommitOutcome>, 'opId'>> {
  if (!summary.trim()) {
    throw new GitError(makeError('EmptyCommitMessage', { argv: ['commit'] }, 'The commit summary is empty.'));
  }
  if (!(await ctx.service.revParse('HEAD'))) throw fail('UnbornBranch', 'There is no commit to reword yet.');
  const data = await runCommit(
    ctx,
    buildCommitMessage(summary, description),
    ['--amend', '--only', '--allow-empty', '--cleanup=whitespace'],
    { skipHooks: false },
  );
  return { summary: `Updated message of ${data.sha.slice(0, 7)}`, data };
}

// ---- templates (spec 06 §6.9) ----

/** Repo-local fallback template written by "Save as template". */
export const GITHAPPENS_TEMPLATE = path.join(APP_DIR_NAME, 'commit-template.txt');

function expandTemplatePath(p: string, root: string | null): string {
  let out = p.trim();
  if (out === '~' || out.startsWith('~/') || out.startsWith('~\\')) {
    out = path.join(os.homedir(), out.slice(1));
  }
  return path.isAbsolute(out) || !root ? out : path.join(root, out);
}

async function configTemplate(
  service: GitService,
  scope?: 'local' | 'global',
): Promise<{ path: string; scope: 'repo' | 'global' } | null> {
  const args = ['config', ...(scope ? [`--${scope}`] : []), '--show-scope', '--get', 'commit.template'];
  const r = await read(service, args, { expectedExitCodes: [0, 1] });
  if (r.exitCode !== 0) return null;
  const line = r.stdout.trim().split(/\r?\n/)[0] ?? '';
  const tab = line.indexOf('\t');
  const where = tab >= 0 ? line.slice(0, tab) : 'local';
  const value = tab >= 0 ? line.slice(tab + 1) : line;
  if (!value.trim()) return null;
  return {
    path: expandTemplatePath(value, service.repo.worktreeRoot),
    scope: where === 'local' || where === 'worktree' ? 'repo' : 'global',
  };
}

/** The commit template: `commit.template` (repo, then global), else `.git/githappens/commit-template.txt`. */
export async function readCommitTemplate(
  service: GitService,
): Promise<{ path?: string; text?: string; scope?: 'repo' | 'global' | 'githappens' }> {
  const cfg = await configTemplate(service);
  const candidates: { path: string; scope: 'repo' | 'global' | 'githappens' }[] = [];
  if (cfg) candidates.push(cfg);
  candidates.push({ path: path.join(service.repo.gitDir, GITHAPPENS_TEMPLATE), scope: 'githappens' });
  for (const c of candidates) {
    try {
      const text = await fs.promises.readFile(c.path, 'utf8');
      return { path: c.path, text: text.replace(/\r\n/g, '\n'), scope: c.scope };
    } catch {
      /* missing or unreadable: try the next one */
    }
  }
  return cfg ? { path: cfg.path, scope: cfg.scope } : {};
}

async function saveTemplate(
  ctx: OpContext,
  scope: 'repo' | 'global',
  text: string,
): Promise<Omit<OpResult, 'opId'>> {
  const svc = ctx.service;
  const existing = await configTemplate(svc, scope === 'repo' ? 'local' : 'global');
  let file = existing?.path;
  if (!file) {
    file =
      scope === 'repo'
        ? path.join(svc.repo.gitDir, GITHAPPENS_TEMPLATE)
        : path.join(os.homedir(), '.githappens-commit-template.txt');
    await git(ctx, ['config', scope === 'repo' ? '--local' : '--global', 'commit.template', file]);
  }
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const body = text.replace(/\r\n/g, '\n');
  await fs.promises.writeFile(file, body.endsWith('\n') || !body ? body : `${body}\n`, 'utf8');
  return {
    summary: `Saved commit template (${scope === 'repo' ? 'repository' : 'global'})`,
    data: { path: file },
  };
}

const COMMIT_TOUCHES: ['status', 'refs', 'graph', 'repoState'] = ['status', 'refs', 'graph', 'repoState'];

export const commitOps = {
  'commit.create': define(
    'commit.create',
    {
      label: (op) => (op.amend ? 'Amend commit' : 'Commit'),
      touches: COMMIT_TOUCHES,
      undoable: true,
      cancellable: true,
    },
    (ctx, op) => createCommit(ctx, op),
  ),
  'commit.rewordHead': define(
    'commit.rewordHead',
    { label: () => 'Update commit message', touches: COMMIT_TOUCHES, undoable: true },
    (ctx, op) => rewordHead(ctx, op.summary, op.description),
  ),
  'commit.saveTemplate': define(
    'commit.saveTemplate',
    { label: () => 'Save commit template', touches: ['status'] },
    (ctx, op) => saveTemplate(ctx, op.scope, op.text),
  ),
};
