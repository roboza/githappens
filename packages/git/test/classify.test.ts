import { describe, expect, it } from 'vitest';

import { classifyError, subcommandOf, type GitErrorCode } from '../src';

/** One captured stderr sample per rule (spec 02 §9: every code has a fixture). */
const SAMPLES: Array<[GitErrorCode, string[], string]> = [
  ['NotARepository', ['status'], 'fatal: not a git repository (or any of the parent directories): .git'],
  ['AuthenticationFailed', ['fetch'], "fatal: Authentication failed for 'https://github.com/a/b.git/'"],
  [
    'AuthenticationFailed',
    ['fetch'],
    "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
  ],
  ['AuthenticationFailed', ['push'], 'remote: HTTP Basic: Access denied\nfatal: Authentication failed'],
  [
    'HostKeyVerificationFailed',
    ['fetch'],
    'Host key verification failed.\nfatal: Could not read from remote repository.',
  ],
  ['PermissionDenied', ['fetch'], 'git@github.com: Permission denied (publickey).'],
  ['PermissionDenied', ['push'], 'ERROR: Permission to a/b.git denied to bob.'],
  [
    'RepositoryNotFound',
    ['clone', 'x'],
    "remote: Repository not found.\nfatal: repository 'https://x/' not found",
  ],
  ['RepositoryNotFound', ['fetch', 'nope'], "fatal: 'nope' does not appear to be a git repository"],
  ['NetworkUnreachable', ['fetch'], "fatal: unable to access 'https://x/': Could not resolve host: x"],
  ['NetworkUnreachable', ['fetch'], 'ssh: connect to host github.com port 22: Connection timed out'],
  [
    'ProxyAuthRequired',
    ['fetch'],
    'fatal: unable to access: Received HTTP code 407 Proxy Authentication Required',
  ],
  ['SslError', ['fetch'], 'fatal: unable to access: SSL certificate problem: self signed certificate'],
  [
    'PushRejectedNonFastForward',
    ['push'],
    ' ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs',
  ],
  ['PushRejectedNonFastForward', ['push'], ' ! [rejected]        main -> main (non-fast-forward)'],
  [
    'PushRejectedStaleLease',
    ['push', '--force-with-lease'],
    ' ! [rejected]        main -> main (stale info)',
  ],
  ['ProtectedBranch', ['push'], 'remote: error: GH006: Protected branch update failed for refs/heads/main.'],
  ['PushRejectedByRemote', ['push'], ' ! [remote rejected] main -> main (pre-receive hook declined)'],
  ['NoUpstream', ['push'], 'fatal: The current branch feature has no upstream branch.'],
  ['NoUpstream', ['pull'], 'There is no tracking information for the current branch.'],
  [
    'UpstreamGone',
    ['pull'],
    "Your configuration specifies to merge with the ref 'refs/heads/x'\nfrom the remote, but no such ref was fetched.",
  ],
  ['NotFastForwardable', ['merge', '--ff-only', 'x'], 'fatal: Not possible to fast-forward, aborting.'],
  [
    'MergeConflict',
    ['merge', 'feature'],
    'CONFLICT (content): Merge conflict in a.txt\nAutomatic merge failed; fix conflicts and then commit the result.',
  ],
  [
    'RebaseConflict',
    ['rebase', 'main'],
    'error: could not apply 1234567... msg\nCONFLICT (content): Merge conflict in a.txt',
  ],
  [
    'CherryPickConflict',
    ['cherry-pick', 'abc'],
    'error: could not apply abc... msg\nhint: after resolving the conflicts',
  ],
  [
    'RevertConflict',
    ['revert', 'abc'],
    'error: could not revert abc... msg\nCONFLICT (content): Merge conflict in a.txt',
  ],
  ['StashConflict', ['stash', 'pop'], 'CONFLICT (content): Merge conflict in a.txt'],
  ['StashConflict', ['stash', 'apply'], 'error: Conflicts in index. Try without --index.'],
  [
    'LocalChangesWouldBeOverwritten',
    ['checkout', 'x'],
    'error: Your local changes to the following files would be overwritten by checkout:\n\ta.txt\n\tdir/b.txt\nPlease commit your changes or stash them before you switch branches.\nAborting',
  ],
  [
    'UntrackedWouldBeOverwritten',
    ['checkout', 'x'],
    'error: The following untracked working tree files would be overwritten by checkout:\n\tnew.txt\nAborting',
  ],
  ['DirtyWorktree', ['pull', '--rebase'], 'error: cannot pull with rebase: You have unstaged changes.'],
  ['NothingToCommit', ['commit', '-m', 'x'], ''],
  ['EmptyCommitMessage', ['commit'], 'Aborting commit due to empty commit message.'],
  ['HookFailed', ['push'], 'error: hook pre-push declined'],
  [
    'IndexLocked',
    ['add', '.'],
    "fatal: Unable to create '/r/.git/index.lock': File exists.\n\nAnother git process seems to be running",
  ],
  ['RefLocked', ['fetch'], "error: cannot lock ref 'refs/remotes/origin/main': is at abc but expected def"],
  ['BranchAlreadyExists', ['branch', 'x'], "fatal: A branch named 'x' already exists."],
  ['BranchNotFullyMerged', ['branch', '-d', 'x'], "error: The branch 'x' is not fully merged."],
  ['BranchCheckedOutInWorktree', ['checkout', 'x'], "fatal: 'x' is already checked out at '/w/x'"],
  [
    'BranchCheckedOutInWorktree',
    ['branch', '-D', 'x'],
    "error: cannot delete branch 'x' used by worktree at '/w/x'",
  ],
  ['InvalidRefName', ['branch', 'a..b'], "fatal: 'a..b' is not a valid branch name"],
  ['TagAlreadyExists', ['tag', 'v1'], "fatal: tag 'v1' already exists"],
  ['RemoteAlreadyExists', ['remote', 'add', 'origin', 'x'], 'error: remote origin already exists.'],
  ['RemoteNotFound', ['remote', 'remove', 'x'], "error: No such remote: 'x'"],
  ['UnbornBranch', ['log'], "fatal: your current branch 'main' does not have any commits yet"],
  ['ShallowRepository', ['push'], ' ! [remote rejected] main -> main (shallow update not allowed)'],
  ['LfsMissing', ['lfs', 'pull'], "git: 'lfs' is not a git command. See 'git --help'."],
  ['LfsError', ['push'], 'batch response: Repository or object not found'],
  [
    'GpgSigningFailed',
    ['commit', '-S'],
    'error: gpg failed to sign the data\nfatal: failed to write commit object',
  ],
];

describe('classifyError', () => {
  it.each(SAMPLES)('%s ← git %s', (code, argv, stderr) => {
    const stdout =
      code === 'NothingToCommit' ? 'On branch main\nnothing to commit, working tree clean\n' : '';
    expect(classifyError({ argv, exitCode: 1, stderr, stdout }).code).toBe(code);
  });

  it('every rule code has at least one sample', async () => {
    const { ERROR_RULES } = await import('../src');
    const covered = new Set(SAMPLES.map(([c]) => c));
    for (const r of ERROR_RULES) {
      if (r.code === 'Conflict') continue;
      expect(covered, `missing sample for ${r.code}`).toContain(r.code);
    }
  });

  it('extracts details', () => {
    const files = SAMPLES.find(([c]) => c === 'LocalChangesWouldBeOverwritten')!;
    expect(classifyError({ argv: files[1], exitCode: 1, stderr: files[2] }).details).toEqual({
      files: ['a.txt', 'dir/b.txt'],
    });
    const lock = SAMPLES.find(([c]) => c === 'IndexLocked')!;
    expect(classifyError({ argv: lock[1], exitCode: 128, stderr: lock[2] }).details).toEqual({
      lockPath: '/r/.git/index.lock',
    });
  });

  it('falls back to Unknown with the last stderr line, prefix stripped', () => {
    const e = classifyError({
      argv: ['frob'],
      exitCode: 1,
      stderr: 'warning: x\nfatal: something odd happened\n',
    });
    expect(e.code).toBe('Unknown');
    expect(e.message).toBe('something odd happened');
  });

  it('redacts credentials in stderr and command', () => {
    const e = classifyError({
      argv: ['fetch', 'https://u:pw@h/r'],
      exitCode: 128,
      stderr: "fatal: Authentication failed for 'https://u:pw@h/r/'",
    });
    expect(e.stderr).not.toContain('pw');
    expect(e.command).toBe('git fetch https://u:***@h/r');
  });

  it('finds the subcommand past -c/-C pairs', () => {
    expect(subcommandOf(['-c', 'a=b', '-C', '/x', '--no-pager', 'rebase', 'main'])).toBe('rebase');
  });
});
