import { describe, expect, it } from 'vitest';

import {
  defaultFinishChoices,
  defaultSupportBase,
  defaultTagName,
  finishError,
  finishOp,
  finishPushOps,
  finishTarget,
  flowKindOf,
  isFinishable,
  flowName,
  groupFlowBranches,
  initialSettings,
  pickRemote,
  validateFlowName,
  validateSettings,
  DEFAULT_GITFLOW_SETTINGS,
} from '../src/renderer/src/views/gitflow/helpers';

const cfg = {
  ...DEFAULT_GITFLOW_SETTINGS,
  production: 'master',
  versionTag: 'v',
  initialized: true,
};

describe('git flow renderer helpers', () => {
  it('groups branches by prefix and strips the prefix', () => {
    expect(
      groupFlowBranches(
        ['feature/b', 'feature/a', 'release/1.0', 'hotfix/x', 'bugfix/y', 'support/1.x', 'main', 'feature/'],
        cfg,
      ),
    ).toEqual({
      feature: ['feature/a', 'feature/b'],
      bugfix: ['bugfix/y'],
      release: ['release/1.0'],
      hotfix: ['hotfix/x'],
      support: ['support/1.x'],
    });
    expect(flowKindOf('hotfix/1', cfg)).toBe('hotfix');
    expect(flowKindOf('bugfix/1', cfg)).toBe('bugfix');
    expect(flowKindOf('other/1', cfg)).toBeNull();
    expect(isFinishable('support')).toBe(false);
    expect(isFinishable('bugfix')).toBe(true);
    expect(flowName('feature/login', 'feature/')).toBe('login');
  });

  it('prefills the tag name from the version tag prefix', () => {
    expect(defaultTagName(cfg, '1.2')).toBe('v1.2');
    expect(defaultFinishChoices(cfg, 'release', '1.2')).toMatchObject({
      tagName: 'v1.2',
      deleteBranch: true,
    });
    expect(defaultFinishChoices(cfg, 'feature', 'x').tagName).toBe('');
  });

  it('validates names, settings and the finish form', () => {
    expect(validateFlowName('ok/name')).toBeNull();
    for (const bad of ['', '-x', 'a b', 'a..b', 'x.lock', 'a~1', 'end/'])
      expect(validateFlowName(bad)).not.toBeNull();
    expect(validateSettings(DEFAULT_GITFLOW_SETTINGS)).toEqual({});
    expect(validateSettings({ ...DEFAULT_GITFLOW_SETTINGS, develop: 'main' }).develop).toMatch(/differ/);
    expect(validateSettings({ ...DEFAULT_GITFLOW_SETTINGS, feature: '' }).feature).toBeTruthy();
    const c = defaultFinishChoices(cfg, 'release', '1.2');
    expect(finishError('release', c)).toMatch(/message/);
    expect(finishError('release', { ...c, tagMessage: 'Notes' })).toBeNull();
    expect(finishError('feature', defaultFinishChoices(cfg, 'feature', 'x'))).toBeNull();
  });

  it('builds the finish op and the follow-up pushes', () => {
    expect(finishOp('feature', 'x', { ...defaultFinishChoices(cfg, 'feature', 'x'), rebase: true })).toEqual({
      type: 'gitflow.finish',
      kind: 'feature',
      name: 'x',
      deleteBranch: true,
      rebase: true,
    });
    expect(
      finishOp('hotfix', '1.0.1', { ...defaultFinishChoices(cfg, 'hotfix', '1.0.1'), tagMessage: 'm' }),
    ).toEqual({
      type: 'gitflow.finish',
      kind: 'hotfix',
      name: '1.0.1',
      deleteBranch: true,
      tag: { name: 'v1.0.1', message: 'm' },
    });
    expect(finishPushOps(cfg, 'feature', '', 'origin')).toEqual([
      { type: 'push', localRef: 'develop', remote: 'origin', remoteBranch: 'develop' },
    ]);
    expect(finishPushOps(cfg, 'release', 'v1', 'up').map((o) => o.type)).toEqual([
      'push',
      'push',
      'push.tags',
    ]);
    expect(finishPushOps(cfg, 'bugfix', '', 'origin')).toEqual([
      { type: 'push', localRef: 'develop', remote: 'origin', remoteBranch: 'develop' },
    ]);
    expect(finishOp('bugfix', 'b', defaultFinishChoices(cfg, 'bugfix', 'b'))).toEqual({
      type: 'gitflow.finish',
      kind: 'bugfix',
      name: 'b',
      deleteBranch: true,
      rebase: false,
    });
  });

  it('sends a hotfix into the single open release branch (AVH) and defaults the support base', () => {
    expect(finishTarget(cfg, 'hotfix', ['release/2.0'])).toBe('release/2.0');
    expect(finishTarget(cfg, 'hotfix', ['release/2.0', 'release/2.1'])).toBe('develop');
    expect(finishTarget(cfg, 'release', ['release/2.0'])).toBe('develop');
    const pushes = finishPushOps(cfg, 'hotfix', 'v1.0.1', 'origin', 'release/2.0');
    expect(pushes[1]).toMatchObject({ localRef: 'release/2.0' });
    expect(defaultSupportBase([])).toBe('');
    expect(
      defaultSupportBase([
        { shortName: 'v1.0', creatorDate: 1 },
        { shortName: 'v1.1', creatorDate: 3 },
        { shortName: 'v0.9', creatorDate: 2 },
      ]),
    ).toBe('v1.1');
  });

  it('picks defaults for the init dialog and the remote', () => {
    expect(initialSettings(null, ['dev', 'master']).production).toBe('master');
    expect(initialSettings(cfg, []).production).toBe('master');
    expect(pickRemote(['upstream', 'origin'])).toBe('origin');
    expect(pickRemote(['upstream'])).toBe('upstream');
    expect(pickRemote([])).toBeNull();
  });
});

describe('gitflow:get handler', () => {
  it('reads config + branches through the repo service', async () => {
    const { createGitflowHandlers } = await import('../src/main/ipc/gitflow-handlers');
    const calls: string[][] = [];
    const service = {
      repo: { gitDir: '/nonexistent/.git' },
      runRead: async (args: string[]) => {
        calls.push(args);
        if (args[0] === 'config')
          return { exitCode: 0, stdout: 'gitflow.branch.master\nmain\0gitflow.branch.develop\ndevelop\0' };
        return { exitCode: 0, stdout: 'main\ndevelop\nfeature/a\nrelease/1\n' };
      },
    };
    const h = createGitflowHandlers({ get: () => service as never });
    const res = await h['gitflow:get']({ repoId: 'r1' }, { senderId: 1 });
    expect(res.config).toMatchObject({ production: 'main', develop: 'develop', feature: 'feature/' });
    expect(res.branches).toEqual({
      feature: ['feature/a'],
      bugfix: [],
      release: ['release/1'],
      hotfix: [],
      support: [],
    });
    expect(res.pendingFinish).toBeNull();
    expect(calls[0]!.slice(0, 2)).toEqual(['config', '--local']);
  });
});
