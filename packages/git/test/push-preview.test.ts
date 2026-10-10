import fs from 'node:fs';
import path from 'node:path';

import { expect, it } from 'vitest';

import { pushPreview } from '../src/ops/executors';
import type { PushOutcome } from '../src/ops/types';
import { describeGit, useHarness } from './ops-harness';

/** Force push safety (spec 09 §4.3 "Force push confirm", §6.5 step 6) against a real bare remote. */
describeGit('push preview + force-with-lease (remote-pair)', () => {
  const h = useHarness('pushprev');

  const pair = async () => {
    const f = h.fixture('remote-pair');
    const svc = await h.open(f.path);
    return { local: f.path, other: f.facts.other as string, remote: f.facts.remote as string, svc };
  };
  const rev = (cwd: string, r: string) => h.git(cwd, 'rev-parse', r).trim();
  const otherCommit = (other: string, name: string) => {
    h.write(path.join(other, `${name}.txt`), `${name}\n`);
    h.git(other, 'add', '-A');
    h.git(other, 'commit', '-qm', name);
    h.git(other, 'push', '-q', 'origin', 'main');
    return rev(other, 'HEAD');
  };

  it('lists the remote commits a force push would drop, fetching ones not yet local', async () => {
    const p = await pair();
    // a commit the local clone has never fetched
    const fresh = otherCommit(p.other, 'unseen');
    expect(() => h.git(p.local, 'cat-file', '-e', `${fresh}^{commit}`)).toThrow();

    const pv = await pushPreview(p.svc, { localRef: 'main', remote: 'origin', remoteBranch: 'main' });
    expect(pv.remoteSha).toBe(fresh);
    expect(pv.leaseSha).toBe(fresh);
    expect(pv.localSha).toBe(rev(p.local, 'HEAD'));
    expect(pv.isFastForward).toBe(false);
    expect(pv.wouldLose.map((c) => c.subject)).toEqual(['unseen', 'Pushed by someone else']);
    expect(pv.wouldLose[0]!.sha).toBe(fresh);
    expect(pv.truncated).toBe(false);
    // the temporary ref is gone
    expect(h.git(p.local, 'for-each-ref', 'refs/githappens/')).toBe('');

    // force push with exactly the lease the user saw
    const r = await h.run(p.svc, {
      type: 'push',
      localRef: 'main',
      remote: 'origin',
      remoteBranch: 'main',
      force: 'lease',
      expectedRemoteSha: pv.leaseSha,
      forceIfIncludes: true,
    });
    expect((r.data as PushOutcome).refs[0]!.flag).toBe('+');
    expect(h.git(p.remote, 'rev-parse', 'main').trim()).toBe(rev(p.local, 'HEAD'));
  });

  it('fails safely when the remote moved again after the preview', async () => {
    const p = await pair();
    const pv = await pushPreview(p.svc, { localRef: 'main', remote: 'origin', remoteBranch: 'main' });
    expect(pv.wouldLose).toHaveLength(1);
    const moved = otherCommit(p.other, 'raced');
    const err = await h.fail(p.svc, {
      type: 'push',
      localRef: 'main',
      remote: 'origin',
      remoteBranch: 'main',
      force: 'lease',
      expectedRemoteSha: pv.leaseSha,
    });
    expect(err.code).toBe('PushRejectedStaleLease');
    expect(h.git(p.remote, 'rev-parse', 'main').trim()).toBe(moved);
  });

  it('reports a missing remote branch and fast-forward pushes', async () => {
    const p = await pair();
    const none = await pushPreview(p.svc, { localRef: 'main', remote: 'origin', remoteBranch: 'brand-new' });
    expect(none).toMatchObject({ remoteSha: null, wouldLose: [], isFastForward: true, leaseSha: null });

    h.git(p.local, 'reset', '-q', '--hard', 'origin/main');
    h.write(path.join(p.local, 'ff.txt'), 'ff\n');
    h.git(p.local, 'add', '-A');
    h.git(p.local, 'commit', '-qm', 'ff');
    const ff = await pushPreview(p.svc, { localRef: 'main', remote: 'origin', remoteBranch: 'main' });
    expect(ff.isFastForward).toBe(true);
    expect(ff.wouldLose).toEqual([]);
  });

  it('rejects option-looking names', async () => {
    const p = await pair();
    await expect(
      pushPreview(p.svc, { localRef: 'main', remote: '--upload-pack=x', remoteBranch: 'main' }),
    ).rejects.toThrow(/Invalid remote/);
    expect(fs.existsSync(p.local)).toBe(true);
  });
});
