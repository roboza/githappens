import { expect, it } from 'vitest';

import { branchCleanupScan, parsePatchIds } from '../src/service/branch-cleanup';
import { describeGit, tinyRepo, useHarness } from './ops-harness';

describeGit('branch cleanup scan (spec 05 §6.13)', () => {
  const h = useHarness('cleanup');

  it('classifies merged, squash-merged, rebase-merged and upstream-gone branches', async () => {
    const r = await tinyRepo(h);
    const { g } = r;
    g('branch', '-M', 'main');
    g('remote', 'add', 'origin', 'https://example.invalid/repo.git');
    const track = (b: string): void => {
      g('config', `branch.${b}.remote`, 'origin');
      g('config', `branch.${b}.merge`, `refs/heads/${b}`);
    };

    // ff: fast-forward merged, remote branch deleted
    g('switch', '-q', '-c', 'ff');
    r.commit('ff work', { 'ff.txt': 'ff\n' });
    track('ff');
    // squashy: two commits squash-merged into main
    g('switch', '-q', '-c', 'squashy', 'main');
    r.commit('s1', { 's1.txt': 'one\n' });
    r.commit('s2', { 's2.txt': 'two\n' });
    track('squashy');
    // rebased: its commit cherry-picked onto main
    g('switch', '-q', '-c', 'rebased', 'main');
    const rebasedSha = r.commit('rebased work', { 'r.txt': 'r\n' });
    // abandoned: PR closed without merging (upstream gone)
    g('switch', '-q', '-c', 'abandoned', 'main');
    r.commit('abandoned work', { 'x.txt': 'x\n' });
    track('abandoned');
    // active: unmerged, remote branch still there
    g('switch', '-q', '-c', 'active', 'main');
    r.commit('active work', { 'y.txt': 'y\n' });
    track('active');
    g('update-ref', 'refs/remotes/origin/active', 'active');

    g('switch', '-q', 'main');
    g('merge', '-q', '--ff-only', 'ff');
    g('merge', '-q', '--squash', 'squashy');
    g('commit', '-q', '-m', 'Squashed PR');
    g('cherry-pick', rebasedSha);
    g('branch', 'fresh'); // just created at the base tip
    g('branch', 'develop', 'abandoned'); // protected by name
    g('update-ref', 'refs/remotes/origin/main', 'main');
    g('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');

    const scan = await branchCleanupScan(r.svc);
    expect(scan.base).toBe('origin/main');
    expect(scan.baseSha).toBe(r.rev('main'));
    const byName = Object.fromEntries(scan.candidates.map((c) => [c.name, c]));
    expect(Object.keys(byName).sort()).toEqual(['abandoned', 'ff', 'rebased', 'squashy']);
    expect(byName.ff).toMatchObject({ reason: 'merged', upstreamGone: true, aheadOfBase: 0 });
    expect(byName.squashy).toMatchObject({ reason: 'squash-merged', aheadOfBase: 2 });
    expect(byName.rebased).toMatchObject({ reason: 'rebase-merged', aheadOfBase: 1 });
    expect(byName.abandoned).toMatchObject({
      reason: 'upstream-gone',
      upstream: 'origin/abandoned',
      upstreamGone: true,
      aheadOfBase: 1,
      subject: 'abandoned work',
    });
    expect(scan.protectedBranches.sort()).toEqual(['develop', 'main']);
  });

  it('skips a branch whose tip moved since the scan', async () => {
    const r = await tinyRepo(h);
    const { g } = r;
    g('branch', 'a');
    g('branch', 'b');
    const stale = r.rev('a');
    g('switch', '-q', 'b');
    r.commit('moved', { 'b.txt': 'b\n' });
    g('switch', '-q', '-');
    const res = await h.run(r.svc, {
      type: 'branch.delete',
      branches: [
        { name: 'a', expectedSha: stale },
        { name: 'b', expectedSha: stale },
      ],
      force: true,
    });
    expect(res.warnings).toEqual(['Skipped b: it changed since the scan.']);
    expect(g('branch', '--list', 'a', 'b').trim()).toBe('b');
  });

  it('reports no base when there is no default branch', async () => {
    const r = await tinyRepo(h);
    r.g('branch', '-M', 'trunk-ish');
    const scan = await branchCleanupScan(r.svc);
    expect(scan).toMatchObject({ base: null, candidates: [] });
  });

  it('parses patch-id output', () => {
    expect(parsePatchIds('abc123 0000\ndef456 1111\n\n')).toEqual(['abc123', 'def456']);
  });
});
