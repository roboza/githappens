import { classifyError, GitError, makeError } from '../../errors/classify';
import type { GitRunOptions, GitRunResult } from '../../process/runner';
import type { ProgressKind } from '../../progress/progress';
import type { GitService } from '../../service/git-service';
import type { GitErrorCode, RefreshScope, SerializedGitError } from '../../types';
import type { GitOperation, GitOperationType, OperationMeta } from '../types';
import type { OpContext, OpDefinition, OpExecutor } from '../queue';

export type RunOpts = Omit<Partial<GitRunOptions>, 'cwd' | 'args' | 'readOnly' | 'encoding'> & {
  /** Network command: merge `ctx.credentialEnv()` and parse progress into `ctx.progress`. */
  network?: ProgressKind;
};

/** Run a mutating git command for an op (signal, opId, credentials and progress wired in). */
export function git(ctx: OpContext, args: string[], o: RunOpts = {}): Promise<GitRunResult<string>> {
  const { network, env, ...rest } = o;
  const creds = network ? (ctx.credentialEnv?.() ?? {}) : {};
  const argv = ctx.identityArgs?.length ? [...ctx.identityArgs, ...args] : args;
  return ctx.service.runWrite(argv, {
    signal: ctx.signal,
    opId: ctx.opId,
    priority: ctx.background ? 'background' : 'interactive',
    ...(network ? { progress: ctx.progress, progressKind: network } : {}),
    ...rest,
    env: { ...creds, ...env },
  });
}

/** Read helper for executors (GIT_OPTIONAL_LOCKS=0). */
export function read(
  service: GitService,
  args: string[],
  o: Omit<Partial<GitRunOptions>, 'cwd' | 'args' | 'readOnly' | 'encoding'> = {},
): Promise<GitRunResult<string>> {
  return service.runRead(args, o);
}

export function fail(
  code: GitErrorCode,
  message?: string,
  details?: SerializedGitError['details'],
  argv: string[] = [],
): GitError {
  return new GitError(makeError(code, { argv }, message, details));
}

export const STALE_DIFF_MESSAGE = 'The file changed; refresh and try again.';
export const staleDiff = (): GitError => fail('Unknown', STALE_DIFF_MESSAGE);

/** Reject option-looking or control-char values before they reach argv (spec 02 §6.1). */
export function assertSafeName(value: string, what = 'name'): void {
  if (!value || value.startsWith('-') || /[\0\r\n]/.test(value)) {
    throw fail('InvalidRefName', `Invalid ${what}: "${value}".`);
  }
}

/** Unmerged paths after a conflicted merge/rebase/stash apply. */
export async function unmergedPaths(service: GitService): Promise<string[]> {
  const r = await read(service, ['diff', '--name-only', '-z', '--diff-filter=U'], {
    expectedExitCodes: [0, 1, 128],
  });
  return r.exitCode === 0 ? r.stdout.split('\0').filter(Boolean) : [];
}

const CONFLICT_CODES: GitErrorCode[] = [
  'MergeConflict',
  'RebaseConflict',
  'CherryPickConflict',
  'RevertConflict',
  'StashConflict',
];

/**
 * Re-throw a failed integrate step: conflicts become the classified conflict code with
 * `details.files` (spec 02 §5.2); anything else is rethrown unchanged.
 */
export async function withConflictFiles(
  service: GitService,
  e: unknown,
  fallbackCode: GitErrorCode,
): Promise<never> {
  const files = await unmergedPaths(service).catch(() => [] as string[]);
  if (e instanceof GitError) {
    if (CONFLICT_CODES.includes(e.code) || files.length) {
      const code = CONFLICT_CODES.includes(e.code) ? e.code : fallbackCode;
      const s = e.serialized;
      throw new GitError({
        ...s,
        code,
        message: code === s.code ? s.message : makeError(code, { argv: [] }).message,
        details: { ...s.details, files },
      });
    }
    throw e;
  }
  if (files.length) throw fail(fallbackCode, undefined, { files });
  throw e;
}

/** Build a GitError from a finished (non-throwing) run, classifying stderr (+ stdout). */
export function classified(argv: string[], r: GitRunResult<string>, opId?: string): GitError {
  return new GitError(
    classifyError({ argv, exitCode: r.exitCode, stderr: r.stderr, stdout: r.stdout, opId }),
  );
}

/** Split `origin/feature/x` into remote + branch using the configured remotes (longest prefix wins). */
export async function splitRemoteRef(
  service: GitService,
  upstream: string,
): Promise<{ remote: string; branch: string } | null> {
  const names = (await service.remotes()).map((r) => r.name).sort((a, b) => b.length - a.length);
  const short = upstream.replace(/^refs\/remotes\//, '');
  for (const n of names) {
    if (short.startsWith(`${n}/`) && short.length > n.length + 1)
      return { remote: n, branch: short.slice(n.length + 1) };
  }
  return null;
}

export function isUnbornHead(service: GitService): Promise<boolean> {
  return service.revParse('HEAD').then((s) => s === null);
}

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

// ---- definition helper ----

interface MetaInput {
  label: (op: never) => string;
  touches: RefreshScope[];
  network?: boolean;
  undoable?: boolean;
  cancellable?: boolean;
}

export function define<T extends GitOperationType>(
  _type: T,
  m: MetaInput & { label: (op: Extract<GitOperation, { type: T }>) => string },
  execute: OpExecutor<T>,
): OpDefinition<T> {
  const meta: OperationMeta = {
    label: m.label as (op: GitOperation) => string,
    mutating: true,
    network: !!m.network,
    cancellable: m.cancellable ?? !!m.network,
    touches: m.touches,
    undoable: !!m.undoable,
    exclusive: 'repo',
  };
  return { meta, execute };
}
