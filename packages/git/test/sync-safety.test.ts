import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  fetchSummary,
  hookInfo,
  ignoredHookHints,
  parseFetchPorcelain,
  parseFetchStderr,
  parsePrUrlHint,
  parseRemoteMessages,
} from '../src/ops/executors';
import type { FetchOutcome, PullOutcome, PushOutcome } from '../src/ops/types';
import { describeGit, useHarness } from './ops-harness';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const Z = '0'.repeat(40);

describe('fetch result parsing (spec 09 §6.2)', () => {
  it('parses --porcelain output', () => {
    const out = [
      `  ${A} ${B} refs/remotes/origin/main`,
      `+ ${A} ${B} refs/remotes/origin/forced`,
      `* ${Z} ${B} refs/remotes/origin/topic`,
      `- ${A} ${Z} refs/remotes/origin/gone`,
      `= ${A} ${A} refs/remotes/origin/same`,
      'garbage',
    ].join('\n');
    expect(parseFetchPorcelain(out)).toEqual([
      { flag: ' ', ref: 'refs/remotes/origin/main', old: A, new: B },
      { flag: '+', ref: 'refs/remotes/origin/forced', old: A, new: B },
      { flag: '*', ref: 'refs/remotes/origin/topic', new: B },
      { flag: '-', ref: 'refs/remotes/origin/gone', old: A },
      { flag: '=', ref: 'refs/remotes/origin/same', old: A, new: A },
    ]);
  });

  it('parses the stderr summary of older git', () => {
    const err = [
      'remote: Enumerating objects: 5, done.',
      'Receiving objects: 100% (3/3), done.\rReceiving objects: 100% (3/3)',
      'From file:///tmp/remote.git',
      '   1a2b3c4..5d6e7f8  main       -> origin/main',
      ' + 1a2b3c4...9f8e7d6 forced     -> origin/forced  (forced update)',
      ' * [new branch]      topic      -> origin/topic',
      ' - [deleted]         (none)     -> origin/gone',
      ' t [tag update]      v1         -> v1',
      ' * [new tag]         v2         -> v2',
      ' ! [rejected]        v3         -> v3  (would clobber existing tag)',
    ].join('\n');
    const refs = parseFetchStderr(err);
    expect(refs.map((r) => [r.flag, r.ref])).toEqual([
      [' ', 'origin/main'],
      ['+', 'origin/forced'],
      ['*', 'origin/topic'],
      ['-', 'origin/gone'],
      ['t', 'v1'],
      ['*', 'v2'],
      ['!', 'v3'],
    ]);
    expect(refs[0]).toMatchObject({ old: '1a2b3c4', new: '5d6e7f8' });
    expect(refs[1]!.summary).toBe('forced update');
    expect(refs[2]!.summary).toBe('new branch');
  });

  it('summarises for the toast', () => {
    const o: FetchOutcome = {
      remotes: ['origin'],
      updatedRefs: [
        { flag: ' ', ref: 'origin/main' },
        { flag: '*', ref: 'origin/x' },
        { flag: '-', ref: 'origin/y' },
      ],
      pruned: ['origin/y'],
    };
    expect(fetchSummary(o)).toBe('Fetched 3 updates on origin');
    expect(fetchSummary({ remotes: ['origin', 'up'], updatedRefs: [], pruned: [] })).toBe(
      'Fetched 2 remotes — no updates',
    );
  });
});

describe('push output: remote messages and PR URL hints (spec 09 §6.5 step 5)', () => {
  const hint = (stderr: string) => parsePrUrlHint(parseRemoteMessages(stderr));

  it('GitHub', () => {
    const err = [
      'remote: ',
      "remote: Create a pull request for 'feature/x' on GitHub by visiting:",
      'remote:      https://github.com/acme/app/pull/new/feature/x',
      'remote: ',
      'To github.com:acme/app.git',
    ].join('\n');
    expect(parseRemoteMessages(err)).toEqual([
      "Create a pull request for 'feature/x' on GitHub by visiting:",
      'https://github.com/acme/app/pull/new/feature/x',
    ]);
    expect(hint(err)).toBe('https://github.com/acme/app/pull/new/feature/x');
  });

  it('GitLab', () => {
    const err = [
      'remote: ',
      'remote: To create a merge request for feature, visit:',
      'remote:   https://gitlab.com/acme/app/-/merge_requests/new?merge_request%5Bsource_branch%5D=feature',
      'remote: ',
    ].join('\n');
    expect(hint(err)).toBe(
      'https://gitlab.com/acme/app/-/merge_requests/new?merge_request%5Bsource_branch%5D=feature',
    );
  });

  it('Bitbucket', () => {
    const err = [
      'remote: ',
      'remote: Create pull request for feature:',
      'remote:   https://bitbucket.org/acme/app/pull-requests/new?source=feature&t=1',
      'remote: ',
    ].join('\n');
    expect(hint(err)).toBe('https://bitbucket.org/acme/app/pull-requests/new?source=feature&t=1');
  });

  it('Azure DevOps and Gitea', () => {
    expect(
      hint(
        'remote: Create a pull request for feature:\nremote:   https://dev.azure.com/acme/proj/_git/app/pullrequestcreate?sourceRef=feature&targetRef=main\n',
      ),
    ).toBe('https://dev.azure.com/acme/proj/_git/app/pullrequestcreate?sourceRef=feature&targetRef=main');
    expect(
      hint(
        "remote: Create a new pull request for 'feature':\nremote:   https://gitea.example/acme/app/compare/main...feature\n",
      ),
    ).toBe('https://gitea.example/acme/app/compare/main...feature');
  });

  it('ignores progress, ANSI and unrelated URLs', () => {
    const err = 'remote: Counting objects: 3\nremote: \x1b[32mSee https://example.com/docs\x1b[0m\n';
    expect(parseRemoteMessages(err)).toEqual(['See https://example.com/docs']);
    expect(hint(err)).toBeUndefined();
  });

  it('surfaces ignored (non-executable) hooks', () => {
    expect(
      ignoredHookHints(
        "hint: The '.git/hooks/pre-push' hook was ignored because it's not set as executable.\nhint: You can disable this warning",
      ),
    ).toEqual(['The pre-push hook was ignored because it is not executable (chmod +x .git/hooks/pre-push).']);
  });
});

describeGit('sync safety (remote-pair)', () => {
  const h = useHarness('syncsafe');

  const pair = async () => {
    const f = h.fixture('remote-pair');
    const svc = await h.open(f.path);
    return { local: f.path, other: f.facts.other as string, remote: f.facts.remote as string, svc };
  };
  const rev = (cwd: string, r: string) => h.git(cwd, 'rev-parse', r).trim();
  const commitIn = (cwd: string, file: string, content: string, msg: string) => {
    h.write(path.join(cwd, file), content);
    h.git(cwd, 'add', '-A');
    h.git(cwd, 'commit', '-qm', msg);
  };

  describe('fetch', () => {
    it('returns updated refs (new, forced, pruned) and a summary', async () => {
      const p = await pair();
      h.git(p.other, 'push', '-q', 'origin', 'HEAD:refs/heads/topic', 'HEAD~1:refs/heads/doomed');
      let r = await h.run(p.svc, { type: 'fetch', remote: 'origin', prune: true });
      let o = r.data as FetchOutcome;
      expect(o.remotes).toEqual(['origin']);
      const refs = o.updatedRefs.map((u) => [u.flag, u.ref.replace(/^refs\/remotes\//, '')]);
      expect(refs).toEqual(
        expect.arrayContaining([
          ['*', 'origin/topic'],
          ['*', 'origin/doomed'],
        ]),
      );
      expect(r.summary).toBe('Fetched 2 updates on origin');

      h.git(p.other, 'push', '-q', 'origin', '--delete', 'doomed');
      h.git(p.other, 'push', '-q', '-f', 'origin', 'HEAD~1:refs/heads/topic');
      r = await h.run(p.svc, { type: 'fetch', remote: 'origin', prune: true });
      o = r.data as FetchOutcome;
      expect(o.pruned.map((x) => x.replace(/^refs\/remotes\//, ''))).toEqual(['origin/doomed']);
      expect(o.updatedRefs.find((u) => u.ref.endsWith('origin/topic'))?.flag).toBe('+');

      r = await h.run(p.svc, { type: 'fetch', remote: 'all' });
      expect((r.data as FetchOutcome).updatedRefs).toEqual([]);
      expect(r.summary).toBe('Fetched origin — no updates');
    });
  });

  describe('pull', () => {
    /** local == origin/main == "shared.txt: one two three"; `other` then pushes `incoming` on top. */
    const synced = async (incoming: string) => {
      const p = await pair();
      commitIn(p.other, 'shared.txt', 'one\ntwo\nthree\n', 'shared');
      h.git(p.other, 'push', '-q', 'origin', 'HEAD:main');
      h.git(p.local, 'fetch', '-q', 'origin');
      h.git(p.local, 'reset', '-q', '--hard', 'origin/main');
      commitIn(p.other, 'shared.txt', incoming, 'remote edit');
      h.git(p.other, 'push', '-q', 'origin', 'HEAD:main');
      return p;
    };

    it('ff-only divergence explains and carries ahead/behind for Merge / Rebase actions', async () => {
      const p = await pair();
      const err = await h.fail(p.svc, { type: 'pull', strategy: 'ff-only' });
      expect(err.code).toBe('NotFastForwardable');
      expect(err.message).toMatch(/diverged \(1 ahead, 1 behind\)/);
      expect(err.details).toMatchObject({ ahead: 1, behind: 1, upstream: 'origin/main', branch: 'main' });
    });

    it('merge-no-ff always creates a merge commit', async () => {
      const p = await pair();
      h.git(p.local, 'reset', '-q', '--hard', 'origin/main~1');
      const r = await h.run(p.svc, { type: 'pull', strategy: 'merge-no-ff' });
      expect((r.data as PullOutcome).result).toBe('merge');
      expect(h.git(p.local, 'log', '-1', '--format=%P').trim().split(' ')).toHaveLength(2);
    });

    it('Stash & Pull: blocked by local changes, then autostash restores them', async () => {
      const p = await synced('one\ntwo\nthree\nfour\n');
      // a dirty edit far enough from the incoming change to re-apply cleanly
      h.write(path.join(p.local, 'shared.txt'), 'zero\none\ntwo\nthree\n');
      const err = await h.fail(p.svc, { type: 'pull', strategy: 'ff-if-possible' });
      expect(err.code).toBe('LocalChangesWouldBeOverwritten');
      const r = await h.run(p.svc, { type: 'pull', strategy: 'ff-if-possible', autostash: true });
      expect((r.data as PullOutcome).result).toBe('fast-forward');
      expect(h.read(path.join(p.local, 'shared.txt')).replace(/\r\n/g, '\n')).toBe(
        'zero\none\ntwo\nthree\nfour\n',
      );
      expect(h.git(p.local, 'stash', 'list')).toBe('');
    });

    it('Stash & Pull keeps the stash when re-applying it conflicts', async () => {
      const p = await synced('one\ntwo\nthree\nfour\n');
      h.write(path.join(p.local, 'shared.txt'), 'one\ntwo\nthree\nMINE\n');
      const err = await h.fail(p.svc, { type: 'pull', strategy: 'ff-if-possible', autostash: true });
      expect(err.code).toBe('StashConflict');
      expect(err.message).toMatch(/autostashed changes conflicted/);
      expect(h.git(p.local, 'stash', 'list')).toMatch(/stash@\{0\}/);
      expect(rev(p.local, 'HEAD')).toBe(rev(p.local, 'origin/main'));
    });

    it('rebase pull reports flattened local merge commits', async () => {
      const p = await pair();
      h.git(p.local, 'switch', '-q', '-c', 'side');
      commitIn(p.local, 'side.txt', 's\n', 'side');
      h.git(p.local, 'switch', '-q', 'main');
      commitIn(p.local, 'main2.txt', 'm\n', 'main2');
      h.git(p.local, 'merge', '-q', '--no-ff', '--no-edit', 'side');
      const r = await h.run(p.svc, { type: 'pull', strategy: 'rebase' });
      expect((r.data as PullOutcome).flattenedMerges).toBe(1);
      expect(r.warnings?.join('\n')).toMatch(/1 local merge commit was flattened/);
    });
  });

  describe('hooks', () => {
    it('a failing pre-push hook is HookFailed; --no-verify retries; hooksPath is honoured', async () => {
      const p = await pair();
      h.git(p.local, 'pull', '-q', '--no-rebase', '--no-edit', 'origin', 'main');
      const hooks = path.join(p.local, 'my-hooks');
      fs.mkdirSync(hooks, { recursive: true });
      const hook = path.join(hooks, 'pre-push');
      fs.writeFileSync(hook, '#!/bin/sh\necho "lint failed: 3 problems" >&2\nexit 1\n');
      fs.chmodSync(hook, 0o755);
      h.git(p.local, 'config', 'core.hooksPath', 'my-hooks');

      const info = await hookInfo(p.svc, ['pre-push', 'pre-commit']);
      expect(info[0]).toMatchObject({ name: 'pre-push', exists: true, executable: true });
      expect(path.normalize(info[0]!.path).toLowerCase()).toBe(path.normalize(hook).toLowerCase());
      expect(info[1]).toMatchObject({ name: 'pre-commit', exists: false });

      const op = { type: 'push' as const, localRef: 'main', remote: 'origin', remoteBranch: 'main' };
      const err = await h.fail(p.svc, op);
      expect(err.code).toBe('HookFailed');
      expect(err.details?.hook).toBe('pre-push');
      expect(String(err.details?.output)).toMatch(/lint failed: 3 problems/);

      const r = await h.run(p.svc, { ...op, noVerify: true });
      expect((r.data as PushOutcome).refs[0]!.flag).toBe(' ');
      expect(h.git(p.remote, 'rev-parse', 'main').trim()).toBe(rev(p.local, 'HEAD'));
    });
  });
});
