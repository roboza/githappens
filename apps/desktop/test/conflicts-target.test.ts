import { describe, expect, it, vi } from 'vitest';

import { createPrBaseLookup } from '../src/main/conflicts/pr-base';
import { resolveTarget, writeTargetConfig } from '../src/main/conflicts/target-resolver';
import { gitPath, useTestRepos } from './ai-test-repo';

const d = gitPath ? describe : describe.skip;

d('target resolution order (spec 14 §6.5)', () => {
  const repos = useTestRepos('conflicts-target');

  it('config → PR base → remote default → heuristics → local heuristics', async () => {
    const r = await repos.make();
    const sha = r.git('rev-parse', 'HEAD').trim();
    r.git('branch', 'develop');
    r.git('checkout', '-q', '-b', 'feature');
    await r.svc.refreshRepoInfo();

    // No remotes: local main.
    expect(await resolveTarget(r.svc, 'feature')).toEqual({ ref: 'main', source: 'heuristic', sha });

    // Remote heuristics on the upstream remote.
    r.git('remote', 'add', 'origin', 'https://github.com/acme/widget.git');
    r.git('update-ref', 'refs/remotes/origin/master', sha);
    expect(await resolveTarget(r.svc, 'feature')).toMatchObject({
      ref: 'origin/master',
      source: 'heuristic',
    });

    // Remote default branch wins over heuristics.
    r.git('update-ref', 'refs/remotes/origin/develop', sha);
    r.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop');
    expect(await resolveTarget(r.svc, 'feature')).toMatchObject({
      ref: 'origin/develop',
      source: 'remote-default',
    });

    // PR base wins over the remote default.
    const prBase = vi.fn(async () => ({ remote: 'origin', branch: 'release' }));
    expect(await resolveTarget(r.svc, 'feature', prBase)).toEqual({
      ref: 'origin/release',
      source: 'pr',
      sha: null,
    });

    // Per-branch config wins over everything.
    await writeTargetConfig(r.svc, 'feature', 'develop');
    expect(await resolveTarget(r.svc, 'feature', prBase)).toEqual({ ref: 'develop', source: 'config', sha });
    await writeTargetConfig(r.svc, 'feature', null);
    expect((await resolveTarget(r.svc, 'feature', prBase))?.source).toBe('pr');
  });

  it('never targets the branch itself and returns null for bare-less unknowns', async () => {
    const r = await repos.make();
    // On main with no remotes and no develop/master: nothing to compare against.
    expect(await resolveTarget(r.svc, 'main')).toBeNull();
    r.git('branch', 'develop');
    expect(await resolveTarget(r.svc, 'main')).toMatchObject({ ref: 'develop' });
    expect(await resolveTarget(r.svc, '')).toBeNull();
  });
});

describe('PR base lookup', () => {
  it('reads the base only for branches with an open PR and caches the list', async () => {
    const src = {
      prIndex: vi.fn(async () => [
        { remote: 'origin', branch: 'feat', pr: { number: 7, title: 't', state: 'open' as const } },
      ]),
      listPullRequests: vi.fn(async () => [
        { number: 7, head: { branch: 'feat' }, base: { branch: 'develop' } },
      ]),
    };
    const lookup = createPrBaseLookup(src as never);
    expect(await lookup('r', 'feat')).toEqual({ remote: 'origin', branch: 'develop' });
    expect(await lookup('r', 'feat')).toEqual({ remote: 'origin', branch: 'develop' });
    expect(await lookup('r', 'other')).toBeNull();
    expect(src.listPullRequests).toHaveBeenCalledTimes(1);
  });
});
