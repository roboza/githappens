import type { GitErrorCode } from '../types';

/**
 * Ordered stderr → error-code rules (spec 02 §6.12). First match wins.
 * `extract` pulls structured details out of the match / full text.
 */
export interface ErrorRule {
  code: GitErrorCode | 'Conflict'; // 'Conflict' is resolved to a specific code from the subcommand
  patterns: RegExp[];
  extract?: (text: string, m: RegExpExecArray) => Record<string, string | number | string[]>;
}

/** Indented file lines that follow e.g. "would be overwritten by checkout:". */
function indentedFilesAfter(text: string, idx: number): string[] {
  const lines = text.slice(idx).split(/\r?\n/).slice(1);
  const files: string[] = [];
  for (const l of lines) {
    if (/^\s+\S/.test(l)) files.push(l.trim());
    else if (files.length || l.trim()) break;
  }
  return files;
}

export const ERROR_RULES: ErrorRule[] = [
  { code: 'NotARepository', patterns: [/not a git repository/i] },
  { code: 'HostKeyVerificationFailed', patterns: [/Host key verification failed/i] },
  {
    code: 'ProtectedBranch',
    patterns: [
      /protected branch hook declined/i,
      /GH006: Protected branch/i,
      /not allowed to push code to protected branches/i,
    ],
  },
  {
    code: 'PermissionDenied',
    patterns: [
      /Permission denied \(publickey/i,
      /ERROR: Permission to .* denied/i,
      /The requested URL returned error: 403/i,
    ],
  },
  {
    code: 'AuthenticationFailed',
    patterns: [
      /Authentication failed for/i,
      /could not read Username/i,
      /could not read Password/i,
      /HTTP Basic: Access denied/i,
      /Invalid username or (password|token)/i,
    ],
  },
  {
    code: 'RepositoryNotFound',
    patterns: [
      /Repository not found/i,
      /repository '.*' not found/i,
      /does not appear to be a git repository/i,
    ],
  },
  { code: 'ProxyAuthRequired', patterns: [/407 Proxy Authentication Required/i] },
  {
    code: 'SslError',
    patterns: [/SSL certificate problem/i, /server certificate verification failed/i, /schannel:/i],
  },
  {
    code: 'NetworkUnreachable',
    patterns: [
      /Could not resolve host/i,
      /Failed to connect to/i,
      /Connection timed out/i,
      /Connection refused/i,
      /Network is unreachable/i,
      /ssh: connect to host .* port \d+:/i,
    ],
  },
  { code: 'PushRejectedStaleLease', patterns: [/\(stale info\)/i] },
  {
    code: 'PushRejectedNonFastForward',
    patterns: [/\(non-fast-forward\)/i, /\(fetch first\)/i, /Updates were rejected because the tip/i],
  },
  { code: 'ShallowRepository', patterns: [/shallow update not allowed/i, /does not support shallow/i] },
  { code: 'PushRejectedByRemote', patterns: [/! \[remote rejected\]/i] },
  {
    code: 'NoUpstream',
    patterns: [/has no upstream branch/i, /There is no tracking information for the current branch/i],
  },
  {
    code: 'UpstreamGone',
    patterns: [/your configuration specifies to merge with the ref [\s\S]*?but no such ref was fetched/i],
  },
  { code: 'NotFastForwardable', patterns: [/Not possible to fast-forward/i] },
  { code: 'StashConflict', patterns: [/Conflicts in index/i] },
  {
    code: 'LocalChangesWouldBeOverwritten',
    patterns: [/Your local changes to the following files would be overwritten/i],
    extract: (t, m) => ({ files: indentedFilesAfter(t, m.index) }),
  },
  {
    code: 'UntrackedWouldBeOverwritten',
    patterns: [/untracked working tree files would be (?:overwritten|removed)/i],
    extract: (t, m) => ({ files: indentedFilesAfter(t, m.index) }),
  },
  {
    code: 'Conflict',
    patterns: [
      /CONFLICT \(/,
      /Automatic merge failed/i,
      /could not apply/i,
      /after resolving the conflicts/i,
    ],
  },
  {
    code: 'DirtyWorktree',
    patterns: [
      /cannot (?:pull|rebase) with rebase: You have unstaged changes/i,
      /Please commit or stash them/i,
    ],
  },
  { code: 'NothingToCommit', patterns: [/nothing to commit/i, /no changes added to commit/i] },
  { code: 'EmptyCommitMessage', patterns: [/Aborting commit due to empty commit message/i] },
  { code: 'HookFailed', patterns: [/hook .* (?:failed|declined)/i] },
  {
    code: 'IndexLocked',
    patterns: [/Unable to create '(.+index\.lock)': File exists/i],
    extract: (_t, m) => ({ lockPath: m[1]! }),
  },
  {
    code: 'RefLocked',
    patterns: [/cannot lock ref '(.+?)'/i, /Unable to create '(.+\.lock)'/i],
    extract: (_t, m) => ({ ref: m[1]! }),
  },
  {
    code: 'BranchAlreadyExists',
    patterns: [/A branch named '(.+)' already exists/i],
    extract: (_t, m) => ({ branch: m[1]! }),
  },
  { code: 'BranchNotFullyMerged', patterns: [/is not fully merged/i] },
  {
    code: 'BranchCheckedOutInWorktree',
    patterns: [/is already (?:checked out|used by worktree) at '(.+)'/i, /used by worktree at '(.+)'/i],
    extract: (_t, m) => ({ worktreePath: m[1]! }),
  },
  { code: 'InvalidRefName', patterns: [/is not a valid branch name/i, /not a valid ref name/i] },
  {
    code: 'TagAlreadyExists',
    patterns: [/tag '(.+)' already exists/i],
    extract: (_t, m) => ({ tag: m[1]! }),
  },
  {
    code: 'RemoteAlreadyExists',
    patterns: [/remote (.+) already exists/i],
    extract: (_t, m) => ({ remote: m[1]! }),
  },
  { code: 'RemoteNotFound', patterns: [/No such remote/i] },
  { code: 'UnbornBranch', patterns: [/does not have any commits yet/i] },
  {
    code: 'LfsMissing',
    patterns: [
      /git-lfs: command not found/i,
      /'lfs' is not a git command/i,
      /configured for Git LFS but 'git-lfs' was not found/i,
    ],
  },
  { code: 'LfsError', patterns: [/batch response:/i, /^LFS:/im] },
  { code: 'GpgSigningFailed', patterns: [/gpg failed to sign the data/i, /error: cannot run gpg/i] },
];
