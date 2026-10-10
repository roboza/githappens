import type { FetchOutcome, GitOperation, PullStrategy } from '@githappens/git/ops';
import type { GitErrorCode, SerializedGitError } from '@githappens/git/types';

/** Pure helpers behind the sync safety UX (spec 09 §4.3, §6.2, §6.4, §6.5, §6.12). DOM-free for tests. */

const short = (s?: string): string => (s ? s.slice(0, 7) : '');
const shortRef = (r: string): string => r.replace(/^refs\/(?:remotes|heads|tags)\//, '');

const FLAG_TEXT: Record<string, string> = {
  ' ': 'updated',
  '+': 'forced update',
  '-': 'deleted',
  t: 'tag updated',
  '*': 'new',
  '!': 'rejected',
};

/** "Fetched 3 updates on origin" + one line per updated ref (spec 09 §6.2 toast with details). */
export function fetchToast(o: FetchOutcome, max = 8): { title: string; body?: string } {
  const where = o.remotes.length === 1 ? o.remotes[0]! : `${o.remotes.length} remotes`;
  const refs = o.updatedRefs.filter((u) => u.flag !== '=');
  if (!refs.length) return { title: `Fetched ${where} — no updates` };
  const lines = refs.slice(0, max).map((u) => {
    const range = u.old && u.new ? ` ${short(u.old)}..${short(u.new)}` : u.new ? ` ${short(u.new)}` : '';
    return `${shortRef(u.ref)} — ${FLAG_TEXT[u.flag] ?? u.summary ?? u.flag}${range}`;
  });
  if (refs.length > max) lines.push(`…and ${refs.length - max} more`);
  return {
    title: `Fetched ${refs.length} update${refs.length === 1 ? '' : 's'} on ${where}`,
    body: lines.join('\n'),
  };
}

/** How a failed pull can be recovered (spec 09 §6.4 step 5 "Stash & Pull", step 4 ff-only actions). */
export function pullRecovery(code: GitErrorCode): 'stash' | 'diverged' | null {
  if (code === 'LocalChangesWouldBeOverwritten' || code === 'DirtyWorktree') return 'stash';
  if (code === 'NotFastForwardable') return 'diverged';
  return null;
}

/** The pull op re-run for a recovery choice. */
export function pullRetryOp(
  op: Extract<GitOperation, { type: 'pull' }>,
  choice: 'stash' | 'merge' | 'rebase',
): Extract<GitOperation, { type: 'pull' }> {
  if (choice === 'stash') return { ...op, autostash: true };
  const strategy: PullStrategy = choice === 'merge' ? 'ff-if-possible' : 'rebase';
  return { ...op, strategy };
}

export interface HookFailure {
  hook: string;
  output: string;
  /** "Retry without hooks" is offered (commit / push, spec 09 §6.12). */
  canSkip: boolean;
}

/** `HookFailed` details → what the hook output modal shows. */
export function hookFailure(err: SerializedGitError, op?: GitOperation): HookFailure | null {
  if (err.code !== 'HookFailed') return null;
  const hook = typeof err.details?.hook === 'string' ? err.details.hook : 'hook';
  const output =
    (typeof err.details?.output === 'string' && err.details.output) || err.stderr || err.message || '';
  return { hook, output: stripAnsi(output), canSkip: !!op && withoutHooks(op) !== null };
}

export const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

/** The same op with hooks skipped (`--no-verify`), or null when the op can't skip hooks. */
export function withoutHooks(op: GitOperation): GitOperation | null {
  switch (op.type) {
    case 'push':
    case 'push.tags':
    case 'push.delete':
      return { ...op, noVerify: true };
    case 'commit.create':
      return { ...op, skipHooks: true };
    default:
      return null;
  }
}

/** Remote of a push op (for the PR action). */
export function pushRemote(op: GitOperation): string | null {
  return op.type === 'push' ? op.remote || null : null;
}

/**
 * "Create pull request" after a push (spec 09 §6.5 step 5): the in-app dialog when the remote is linked to a
 * connected integration, else the URL the remote printed.
 */
export function prAction(
  prUrlHint: string | undefined,
  remote: string | null,
  linked: { remote: string; integrationKey?: string }[],
): { kind: 'in-app' } | { kind: 'url'; url: string } | null {
  if (!prUrlHint) return null;
  if (remote && linked.some((r) => r.remote === remote && r.integrationKey)) return { kind: 'in-app' };
  if (!/^https?:\/\//i.test(prUrlHint)) return null;
  return { kind: 'url', url: prUrlHint };
}

/** Confirm text for a force push (spec 09 §4.3 "Force push confirm"). */
export function forcePushMessage(target: string, lost: number, truncated: boolean): string {
  if (!lost) return `${target} has no commits you don't have. The push will not drop anything.`;
  const n = `${lost}${truncated ? '+' : ''} commit${lost === 1 && !truncated ? '' : 's'}`;
  return `${target} has ${n} you don't have. Force pushing will overwrite ${lost === 1 && !truncated ? 'it' : 'them'}.`;
}
