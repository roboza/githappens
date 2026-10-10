import { expect, it } from 'vitest';

import { describeGit, useHarness } from './ops-harness';

describeGit('pr.checkout (spec 10 §6.3)', () => {
  const h = useHarness('prco');

  it('checks out a fork PR through the provider refspec', async () => {
    const f = h.fixture('remote-pair');
    const remote = f.facts.remote as string;
    const local = f.path;
    // Simulate a fork PR: a commit only reachable from refs/pull/7/head on the remote.
    const other = f.facts.other as string;
    h.git(other, 'checkout', '-q', '-b', 'fork-work');
    h.write(`${other}/fork.txt`, 'from fork\n');
    h.git(other, 'add', '.');
    h.git(other, '-c', 'user.name=F', '-c', 'user.email=f@x', 'commit', '-q', '-m', 'Fork change');
    const prSha = h.git(other, 'rev-parse', 'HEAD').trim();
    h.git(other, 'push', '-q', remote, 'HEAD:refs/pull/7/head');

    const svc = await h.open(local);
    const r = await h.run(svc, {
      type: 'pr.checkout',
      remote: 'origin',
      number: 7,
      headBranch: 'fork-work',
      sameRepo: false,
      refspec: 'refs/pull/{n}/head',
      localBranch: 'pr/7',
      checkout: true,
    });
    expect((r.data as { branch: string }).branch).toBe('pr/7');
    expect(h.git(local, 'rev-parse', 'HEAD').trim()).toBe(prSha);
    expect(h.git(local, 'symbolic-ref', '--short', 'HEAD').trim()).toBe('pr/7');

    // Running again is a no-op fast-forward (branch exists, same commit).
    await h.run(svc, {
      type: 'pr.checkout',
      remote: 'origin',
      number: 7,
      headBranch: 'fork-work',
      sameRepo: false,
      refspec: 'refs/pull/{n}/head',
      localBranch: 'pr/7',
      checkout: false,
    });
    expect(h.git(local, 'rev-parse', 'pr/7').trim()).toBe(prSha);
  });

  it('checks out a same-repo PR as a tracking branch', async () => {
    const f = h.fixture('remote-pair');
    const other = f.facts.other as string;
    h.git(other, 'checkout', '-q', '-b', 'feature/pr');
    h.write(`${other}/pr.txt`, 'pr\n');
    h.git(other, 'add', '.');
    h.git(other, '-c', 'user.name=F', '-c', 'user.email=f@x', 'commit', '-q', '-m', 'PR change');
    h.git(other, 'push', '-q', 'origin', 'feature/pr');

    const svc = await h.open(f.path);
    await h.run(svc, {
      type: 'pr.checkout',
      remote: 'origin',
      number: 3,
      headBranch: 'feature/pr',
      sameRepo: true,
      refspec: 'refs/pull/{n}/head',
      localBranch: 'feature/pr',
      checkout: true,
    });
    expect(h.git(f.path, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}').trim()).toBe(
      'origin/feature/pr',
    );
    expect(h.read(`${f.path}/pr.txt`)).toBe('pr\n');
  });
});
