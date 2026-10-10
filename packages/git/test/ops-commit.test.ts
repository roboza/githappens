import fs from 'node:fs';
import path from 'node:path';

import { beforeAll, expect, it } from 'vitest';

import { headMessage } from '../src/ops/executors';
import type { CommitOutcome, CommitReq, GitOperation } from '../src/ops/types';
import type { GitService } from '../src/service/git-service';
import { describeGit, useHarness } from './ops-harness';

const req = (over: Partial<CommitReq> = {}): GitOperation => ({
  type: 'commit.create',
  summary: 'Summary',
  description: '',
  coAuthors: [],
  amend: false,
  skipHooks: false,
  allowEmpty: false,
  sign: 'off',
  cleanup: 'strip',
  ...over,
});

describeGit('commit executors', () => {
  const h = useHarness('commit');
  let dir: string;
  let svc: GitService;
  const abs = (p: string) => path.join(dir, p);
  const head = () => h.git(dir, 'rev-parse', 'HEAD').trim();
  const body = (rev = 'HEAD') => h.git(dir, 'log', '-1', '--format=%B', rev);

  beforeAll(async () => {
    dir = h.fixture('linear', { count: 2 }).path;
    svc = await h.open(dir);
  });

  it('commits staged changes with summary, description and co-author trailers', async () => {
    h.write(abs('c.txt'), 'c\n');
    h.git(dir, 'add', 'c.txt');
    const r = await h.run(
      svc,
      req({
        summary: '  Add c  ',
        description: 'Longer text\n\nsecond paragraph',
        coAuthors: [
          { name: 'Bob Example', email: 'bob@example.com' },
          { name: 'Bob Example', email: 'bob@example.com' },
        ],
      }),
    );
    const data = r.data as CommitOutcome;
    expect(data.sha).toBe(head());
    expect(body()).toBe(
      'Add c\n\nLonger text\n\nsecond paragraph\n\nCo-authored-by: Bob Example <bob@example.com>\n\n',
    );
    expect(await headMessage(svc)).toEqual({
      summary: 'Add c',
      description: 'Longer text\n\nsecond paragraph\n\nCo-authored-by: Bob Example <bob@example.com>',
    });
    expect(h.git(dir, 'status', '--porcelain')).toBe('');
  });

  it('amends HEAD and rewords HEAD without committing staged changes', async () => {
    const parent = h.git(dir, 'rev-parse', 'HEAD~1').trim();
    await h.run(svc, req({ summary: 'Amended', amend: true, allowEmpty: true }));
    expect(body().trim()).toBe('Amended');
    expect(h.git(dir, 'rev-parse', 'HEAD~1').trim()).toBe(parent);

    h.write(abs('staged.txt'), 's\n');
    h.git(dir, 'add', 'staged.txt');
    await h.run(svc, { type: 'commit.rewordHead', summary: 'Reworded', description: 'why' });
    expect(body()).toBe('Reworded\n\nwhy\n\n');
    expect(h.git(dir, 'rev-parse', 'HEAD~1').trim()).toBe(parent);
    expect(h.git(dir, 'status', '--porcelain')).toMatch(/^A {2}staged\.txt/m);
    h.git(dir, 'reset', '-q', 'staged.txt');
    fs.rmSync(abs('staged.txt'));
  });

  it('creates empty commits only when allowed, and rejects an empty summary', async () => {
    expect((await h.fail(svc, req({ summary: 'nothing' }))).code).toBe('NothingToCommit');
    const before = head();
    await h.run(svc, req({ summary: 'empty', allowEmpty: true }));
    expect(h.git(dir, 'rev-parse', 'HEAD~1').trim()).toBe(before);
    expect((await h.fail(svc, req({ summary: '   ', allowEmpty: true }))).code).toBe('EmptyCommitMessage');
  });

  it('runs hooks: HookFailed with output, skipHooks bypasses them', async () => {
    const hook = path.join(dir, '.git', 'hooks', 'pre-commit');
    h.write(hook, '#!/bin/sh\necho "lint failed: trailing spaces" >&2\nexit 1\n');
    fs.chmodSync(hook, 0o755);
    try {
      h.write(abs('h.txt'), 'h\n');
      h.git(dir, 'add', 'h.txt');
      const before = head();
      const err = await h.fail(svc, req({ summary: 'With hook' }));
      expect(err.code).toBe('HookFailed');
      expect(err.details?.hook).toBe('pre-commit');
      expect(String(err.details?.output)).toContain('lint failed: trailing spaces');
      expect(head()).toBe(before);

      const r = await h.run(svc, req({ summary: 'Skip hooks', skipHooks: true }));
      expect((r.data as CommitOutcome).sha).toBe(head());
      expect(body().trim()).toBe('Skip hooks');
    } finally {
      fs.rmSync(hook);
    }
  });

  it('makes the initial commit on an unborn branch', async () => {
    const empty = await h.open(h.fixture('empty').path);
    const d = empty.repo.worktreeRoot!;
    h.write(path.join(d, 'first.txt'), '1\n');
    await h.run(empty, { type: 'wip.stageAll' });
    expect((await h.fail(empty, req({ summary: 'x', amend: true }))).code).toBe('UnbornBranch');
    const r = await h.run(empty, req({ summary: 'First' }));
    expect((r.data as CommitOutcome).sha).toBe(h.git(d, 'rev-parse', 'HEAD').trim());
    expect(h.git(d, 'rev-list', '--count', 'HEAD').trim()).toBe('1');
    expect(empty.repo.head.sha).toBe((r.data as CommitOutcome).sha);
  });
});
