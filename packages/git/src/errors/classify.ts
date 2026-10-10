import { formatCommand, redact } from '../process/redact';
import type { GitErrorCode, SerializedGitError } from '../types';
import { ERROR_RULES } from './rules';

const MESSAGES: Partial<Record<GitErrorCode, string>> = {
  NotARepository: 'This folder is not a Git repository.',
  GitNotFound: 'Git could not be found.',
  GitTooOld: 'The installed Git version is too old.',
  AuthenticationFailed: 'Authentication failed.',
  AuthCancelled: 'Authentication was cancelled.',
  HostKeyVerificationFailed: 'The SSH host key could not be verified.',
  PermissionDenied: 'Permission denied by the remote.',
  RepositoryNotFound: 'The remote repository was not found.',
  NetworkUnreachable: 'Could not reach the remote host.',
  ProxyAuthRequired: 'The proxy requires authentication.',
  SslError: 'An SSL/TLS certificate problem occurred.',
  Timeout: 'The Git command timed out.',
  PushRejectedNonFastForward: 'Push rejected: the remote has commits you do not have locally.',
  PushRejectedStaleLease: 'Push rejected: the remote branch changed since your last fetch.',
  PushRejectedByRemote: 'The remote rejected the push.',
  ProtectedBranch: 'The branch is protected on the remote.',
  NoUpstream: 'The current branch has no upstream branch.',
  UpstreamGone: 'The upstream branch no longer exists.',
  NotFastForwardable: 'The branch cannot be fast-forwarded.',
  MergeConflict: 'Merge completed with conflicts.',
  RebaseConflict: 'Rebase stopped with conflicts.',
  CherryPickConflict: 'Cherry-pick completed with conflicts.',
  RevertConflict: 'Revert completed with conflicts.',
  StashConflict: 'Applying the stash produced conflicts.',
  LocalChangesWouldBeOverwritten: 'Your local changes would be overwritten.',
  UntrackedWouldBeOverwritten: 'Untracked files would be overwritten.',
  DirtyWorktree: 'You have uncommitted changes.',
  NothingToCommit: 'There is nothing to commit.',
  EmptyCommitMessage: 'The commit message is empty.',
  HookFailed: 'A Git hook failed.',
  IndexLocked: 'Another Git process is using this repository (index.lock exists).',
  RefLocked: 'A ref is locked by another Git process.',
  BranchAlreadyExists: 'A branch with that name already exists.',
  BranchNotFullyMerged: 'The branch is not fully merged.',
  BranchCheckedOutInWorktree: 'The branch is checked out in another worktree.',
  InvalidRefName: 'That is not a valid name.',
  TagAlreadyExists: 'A tag with that name already exists.',
  RemoteAlreadyExists: 'A remote with that name already exists.',
  RemoteNotFound: 'That remote does not exist.',
  UnbornBranch: 'The branch has no commits yet.',
  ShallowRepository: 'This operation is not supported on a shallow repository.',
  LfsMissing: 'Git LFS is required but not installed.',
  LfsError: 'A Git LFS error occurred.',
  GpgSigningFailed: 'Signing the commit failed.',
  OutputTooLarge: 'The Git command produced too much output.',
  Cancelled: 'The operation was cancelled.',
};

/** First non-option arg, skipping `-c key=val` and `-C dir` pairs. */
export function subcommandOf(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '-c' || a === '-C') {
      i++;
      continue;
    }
    if (!a.startsWith('-')) return a;
  }
  return undefined;
}

function conflictCode(argv: string[]): GitErrorCode {
  switch (subcommandOf(argv)) {
    case 'rebase':
      return 'RebaseConflict';
    case 'cherry-pick':
      return 'CherryPickConflict';
    case 'revert':
      return 'RevertConflict';
    case 'stash':
      return 'StashConflict';
    default:
      return 'MergeConflict';
  }
}

function lastMeaningfulLine(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const last = lines[lines.length - 1] ?? '';
  return last.replace(/^(fatal|error):\s*/i, '');
}

export interface ClassifyInput {
  /** User args (without the runner's global `-c` args). */
  argv: string[];
  exitCode: number | null;
  stderr: string;
  stdout?: string;
  opId?: string;
}

export function classifyError(i: ClassifyInput): SerializedGitError {
  const sub = subcommandOf(i.argv);
  // commit/merge print some messages ("nothing to commit", "CONFLICT") on stdout.
  const text =
    sub === 'commit' || sub === 'merge' || sub === 'pull' ? `${i.stderr}\n${i.stdout ?? ''}` : i.stderr;
  for (const rule of ERROR_RULES) {
    for (const re of rule.patterns) {
      const m = re.exec(text);
      if (!m) continue;
      const code = rule.code === 'Conflict' ? conflictCode(i.argv) : rule.code;
      const details = rule.extract?.(text, m);
      return build(code, i, details);
    }
  }
  return build('Unknown', i, undefined, lastMeaningfulLine(i.stderr) || `git exited with code ${i.exitCode}`);
}

export function makeError(
  code: GitErrorCode,
  i: Partial<ClassifyInput> & { argv: string[] },
  message?: string,
  details?: SerializedGitError['details'],
): SerializedGitError {
  return build(code, { exitCode: null, stderr: '', ...i }, details, message);
}

function build(
  code: GitErrorCode,
  i: ClassifyInput,
  details: SerializedGitError['details'] | undefined,
  message?: string,
): SerializedGitError {
  const err: SerializedGitError = {
    code,
    message: message ?? MESSAGES[code] ?? 'Git command failed.',
    exitCode: i.exitCode,
    stderr: redact(i.stderr),
    command: formatCommand(i.argv),
  };
  if (details && Object.keys(details).length) err.details = details;
  if (i.opId) err.opId = i.opId;
  return err;
}

/** Error thrown by the runner; carries the serializable payload sent over IPC. */
export class GitError extends Error {
  constructor(readonly serialized: SerializedGitError) {
    super(serialized.message);
    this.name = 'GitError';
  }
  get code(): GitErrorCode {
    return this.serialized.code;
  }
}
