import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  changedSubmodulePaths,
  deleteOrigBackups,
  identityConfigArgs,
  identityOverridden,
  readLocalIdentity,
  resolvedPaths,
} from '../src/ops/behaviour';
import type { CommitReq, GitOperation, PullOutcome } from '../src/ops/types';
import { describeGit, tinyRepo, useHarness } from './ops-harness';

const commitOp = (summary: string): GitOperation =>
  ({
    type: 'commit.create',
    summary,
    description: '',
    coAuthors: [],
    amend: false,
    skipHooks: true,
    allowEmpty: true,
    sign: 'off',
    cleanup: 'strip',
  }) satisfies { type: 'commit.create' } & CommitReq;

describe('identityConfigArgs (spec 13 §6 precedence)', () => {
  it('injects a set profile identity when the repo has none', () => {
    expect(identityConfigArgs({ name: 'Pro File', email: 'p@x.io' }, {})).toEqual([
      '-c',
      'user.name=Pro File',
      '-c',
      'user.email=p@x.io',
    ]);
  });

  it('lets repo-local config win per key', () => {
    expect(identityConfigArgs({ name: 'P', email: 'p@x.io' }, { email: 'local@x.io' })).toEqual([
      '-c',
      'user.name=P',
    ]);
    expect(identityConfigArgs({ name: 'P', email: 'p@x.io' }, { name: 'L', email: 'l@x.io' })).toEqual([]);
  });

  it('never overrides git config with an empty / invalid profile value', () => {
    expect(identityConfigArgs({ name: '', email: '  ' }, {})).toEqual([]);
    expect(identityConfigArgs({ name: 'a\nb', email: 'p@x.io' }, {})).toEqual(['-c', 'user.email=p@x.io']);
    expect(identityConfigArgs(null, {})).toEqual([]);
  });

  it('flags a repo-local identity that differs from the profile', () => {
    expect(identityOverridden({ name: 'P', email: 'p@x.io' }, {})).toBe(false);
    expect(identityOverridden({ name: 'P', email: 'p@x.io' }, { email: 'P@X.io' })).toBe(false);
    expect(identityOverridden({ name: 'P', email: 'p@x.io' }, { email: 'work@corp.io' })).toBe(true);
    expect(identityOverridden({ name: '', email: '' }, { name: 'L' })).toBe(true);
  });

  it('maps resolution ops to their paths', () => {
    expect(resolvedPaths({ type: 'conflict.markResolved', paths: ['a', 'b'] })).toEqual(['a', 'b']);
    expect(resolvedPaths({ type: 'conflict.saveFile', path: 'a', text: '', markResolved: true })).toEqual([
      'a',
    ]);
    expect(resolvedPaths({ type: 'conflict.saveFile', path: 'a', text: '', markResolved: false })).toEqual(
      [],
    );
    expect(resolvedPaths({ type: 'commit.create' })).toEqual([]);
  });
});

describeGit('op behaviour (git)', () => {
  const h = useHarness('behaviour');
  const globalConfig = (): string => path.join(h.root, '.gitconfig-empty');

  it('commits with the profile identity unless repo-local config sets it', async () => {
    const r = await tinyRepo(h);
    r.g('config', '--local', '--unset', 'user.name');
    r.g('config', '--local', '--unset', 'user.email');
    fs.writeFileSync(globalConfig(), '[user]\n\tname = Global Person\n\temail = global@example.com\n');
    const who = (): string => r.g('log', '-1', '--format=%an <%ae>|%cn <%ce>').trim();
    try {
      // no profile identity: global config
      await h.run(r.svc, commitOp('global'));
      expect(who()).toBe('Global Person <global@example.com>|Global Person <global@example.com>');

      // profile identity set: beats global
      const profile = { name: 'Pro File', email: 'pro@example.com' };
      await h.run(r.svc, commitOp('profile'), { identity: () => profile });
      expect(who()).toBe('Pro File <pro@example.com>|Pro File <pro@example.com>');

      // empty profile: global again
      await h.run(r.svc, commitOp('empty'), { identity: () => ({ name: '', email: '' }) });
      expect(who()).toBe('Global Person <global@example.com>|Global Person <global@example.com>');

      // repo-local email wins over the profile (per key)
      r.g('config', '--local', 'user.email', 'local@example.com');
      expect(await readLocalIdentity(r.svc)).toEqual({ email: 'local@example.com' });
      await h.run(r.svc, commitOp('local'), { identity: () => profile });
      expect(who()).toBe('Pro File <local@example.com>|Pro File <local@example.com>');

      // annotated tags get the identity as tagger
      r.g('config', '--local', '--unset', 'user.email');
      await h.run(
        r.svc,
        { type: 'tag.create', name: 'v1', target: r.rev('HEAD'), annotated: { message: 'v1' } },
        { identity: () => profile },
      );
      expect(r.g('for-each-ref', '--format=%(taggername) %(taggeremail)', 'refs/tags/v1').trim()).toBe(
        'Pro File <pro@example.com>',
      );
    } finally {
      fs.writeFileSync(globalConfig(), '');
    }
  });

  it('pull --rebase-merges keeps local merges; without it they are flattened with a warning', async () => {
    const run = async (rebaseMerges: boolean) => {
      const f = h.fixture('remote-pair');
      const g = (...a: string[]) => h.git(f.path, ...a);
      g('switch', '-q', '-c', 'side');
      h.write(path.join(f.path, 'side.txt'), 'side\n');
      g('add', '-A');
      g('commit', '-q', '-m', 'Side');
      g('switch', '-q', 'main');
      g('merge', '-q', '--no-ff', '-m', 'Merge side', 'side');
      const svc = await h.open(f.path);
      const r = await h.run(svc, { type: 'pull', strategy: 'rebase', rebaseMerges });
      expect((r.data as PullOutcome).result).toBe('rebase');
      return { r, merges: g('rev-list', '--merges', '--count', 'origin/main..HEAD').trim() };
    };
    const kept = await run(true);
    expect(kept.merges).toBe('1');
    expect(kept.r.warnings ?? []).toEqual([]);
    const flat = await run(false);
    expect(flat.merges).toBe('0');
    expect(flat.r.warnings?.[0]).toMatch(/1 local merge commit was flattened/);
  });

  it('lists gitlinks changed between commits', async () => {
    const f = h.fixture('submodules');
    const svc = await h.open(f.path);
    const head = h.git(f.path, 'rev-parse', 'HEAD').trim();
    const first = h.git(f.path, 'rev-list', '--max-parents=0', 'HEAD').trim();
    expect(await changedSubmodulePaths(svc, first, head)).toEqual(['lib']);
    expect(await changedSubmodulePaths(svc, null, head)).toEqual(['lib']);
    expect(await changedSubmodulePaths(svc, head, head)).toEqual([]);
    expect(await changedSubmodulePaths(svc, head, first)).toEqual([]);
  });

  it('deletes only untracked .orig backups of resolved files', async () => {
    const r = await tinyRepo(h, { 'a.txt': 'a\n', 'b.txt': 'b\n', 'b.txt.orig': 'tracked backup\n' });
    h.write(path.join(r.dir, 'a.txt.orig'), 'backup\n');
    h.write(path.join(r.dir, 'c.txt.orig'), 'unrelated\n');
    const deleted = await deleteOrigBackups(r.svc, ['a.txt', 'b.txt', 'missing.txt', '../escape']);
    expect(deleted).toEqual(['a.txt.orig']);
    expect(fs.existsSync(path.join(r.dir, 'a.txt.orig'))).toBe(false);
    expect(fs.existsSync(path.join(r.dir, 'b.txt.orig'))).toBe(true);
    expect(fs.existsSync(path.join(r.dir, 'c.txt.orig'))).toBe(true);
  });
});
