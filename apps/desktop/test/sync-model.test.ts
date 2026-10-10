import type { GitOperation } from '@githappens/git/ops';
import type { SerializedGitError } from '@githappens/git/types';
import { describe, expect, it } from 'vitest';

import {
  fetchToast,
  forcePushMessage,
  hookFailure,
  prAction,
  pullRecovery,
  pullRetryOp,
  stripAnsi,
  withoutHooks,
} from '../src/renderer/src/views/sync/sync-model';
import { SYNC_INVOKE_CHANNELS } from '../src/shared/ipc/sync-contract';

const err = (over: Partial<SerializedGitError>): SerializedGitError =>
  ({
    code: 'Unknown',
    message: 'failed',
    command: 'git push',
    stderr: '',
    ...over,
  }) as SerializedGitError;

describe('fetch result toast (spec 09 §6.2)', () => {
  it('summarises updated refs per remote with details', () => {
    const t = fetchToast({
      remotes: ['origin'],
      updatedRefs: [
        { flag: ' ', ref: 'refs/remotes/origin/main', old: 'a'.repeat(40), new: 'b'.repeat(40) },
        { flag: '*', ref: 'refs/remotes/origin/topic', new: 'c'.repeat(40) },
        { flag: '-', ref: 'refs/remotes/origin/gone', old: 'd'.repeat(40) },
      ],
      pruned: ['refs/remotes/origin/gone'],
    });
    expect(t.title).toBe('Fetched 3 updates on origin');
    expect(t.body!.split('\n')).toEqual([
      'origin/main — updated aaaaaaa..bbbbbbb',
      'origin/topic — new ccccccc',
      'origin/gone — deleted',
    ]);
  });

  it('says when nothing changed and truncates long lists', () => {
    expect(fetchToast({ remotes: ['origin', 'up'], updatedRefs: [], pruned: [] })).toEqual({
      title: 'Fetched 2 remotes — no updates',
    });
    const many = Array.from({ length: 12 }, (_, i) => ({ flag: '*', ref: `origin/b${i}` }));
    const t = fetchToast({ remotes: ['origin'], updatedRefs: many, pruned: [] }, 8);
    expect(t.body!.split('\n')).toHaveLength(9);
    expect(t.body).toMatch(/…and 4 more$/);
  });
});

describe('pull recovery (spec 09 §6.4)', () => {
  const op: Extract<GitOperation, { type: 'pull' }> = { type: 'pull', strategy: 'ff-only' };
  it('maps errors to Stash & Pull / Merge-Rebase', () => {
    expect(pullRecovery('LocalChangesWouldBeOverwritten')).toBe('stash');
    expect(pullRecovery('DirtyWorktree')).toBe('stash');
    expect(pullRecovery('NotFastForwardable')).toBe('diverged');
    expect(pullRecovery('AuthenticationFailed')).toBeNull();
  });
  it('builds the retry op', () => {
    expect(pullRetryOp(op, 'stash')).toEqual({ type: 'pull', strategy: 'ff-only', autostash: true });
    expect(pullRetryOp(op, 'merge').strategy).toBe('ff-if-possible');
    expect(pullRetryOp(op, 'rebase').strategy).toBe('rebase');
  });
});

describe('hook output modal helpers (spec 09 §6.12)', () => {
  const push: GitOperation = { type: 'push', localRef: 'main', remote: 'origin', remoteBranch: 'main' };
  it('extracts hook name and output, offers Retry without hooks for push/commit only', () => {
    const f = hookFailure(
      err({ code: 'HookFailed', details: { hook: 'pre-push', output: '\x1b[31mlint failed\x1b[0m' } }),
      push,
    );
    expect(f).toEqual({ hook: 'pre-push', output: 'lint failed', canSkip: true });
    expect(hookFailure(err({ code: 'HookFailed', stderr: 'boom' }), { type: 'merge.abort' })).toEqual({
      hook: 'hook',
      output: 'boom',
      canSkip: false,
    });
    expect(hookFailure(err({ code: 'PushRejectedNonFastForward' }), push)).toBeNull();
  });
  it('retry-without-hooks variants', () => {
    expect(withoutHooks(push)).toMatchObject({ type: 'push', noVerify: true });
    expect(withoutHooks({ type: 'push.tags', remote: 'o', tags: 'all' })).toMatchObject({ noVerify: true });
    const commit = withoutHooks({
      type: 'commit.create',
      summary: 's',
      description: '',
      coAuthors: [],
      amend: false,
      skipHooks: false,
      allowEmpty: false,
      sign: 'config',
      cleanup: 'strip',
    });
    expect(commit).toMatchObject({ skipHooks: true });
    expect(withoutHooks({ type: 'fetch', remote: 'all' })).toBeNull();
    expect(stripAnsi('\x1b[1;32mok\x1b[0m')).toBe('ok');
  });
});

describe('PR link after push (spec 09 §6.5 step 5)', () => {
  const url = 'https://github.com/acme/app/pull/new/feature';
  it('prefers the in-app dialog for linked remotes', () => {
    expect(prAction(url, 'origin', [{ remote: 'origin', integrationKey: 'github:me' }])).toEqual({
      kind: 'in-app',
    });
    expect(prAction(url, 'origin', [{ remote: 'origin' }])).toEqual({ kind: 'url', url });
    expect(prAction(url, 'fork', [{ remote: 'origin', integrationKey: 'k' }])).toEqual({ kind: 'url', url });
    expect(prAction(undefined, 'origin', [])).toBeNull();
    expect(prAction('javascript:alert(1)', null, [])).toBeNull();
  });
});

describe('force push confirm text (spec 09 §4.3)', () => {
  it('counts the commits that would be lost', () => {
    expect(forcePushMessage('origin/main', 1, false)).toBe(
      "origin/main has 1 commit you don't have. Force pushing will overwrite it.",
    );
    expect(forcePushMessage('origin/main', 100, true)).toMatch(/has 100\+ commits/);
    expect(forcePushMessage('origin/main', 0, false)).toMatch(/will not drop anything/);
  });
});

describe('sync contract', () => {
  it('lists every channel', () => {
    expect([...SYNC_INVOKE_CHANNELS].sort()).toEqual(['git:push:preview', 'sync:hooks']);
  });
});
