import fs from 'node:fs';
import path from 'node:path';

import { expect, it } from 'vitest';

import { GitError } from '../src/errors/classify';
import { parseLsFilesUnmerged } from '../src/parsers/ls-files';
import { parseStatusV2 } from '../src/parsers/status';
import { redactArgv } from '../src/process/redact';
import {
  configGet,
  configList,
  configSetGlobal,
  configTarget,
  isValidConfigKey,
  parseConfigList,
  redactConfigValue,
} from '../src/service/config';
import { listConflicts, mergeBase } from '../src/service/file-views';
import { GitService } from '../src/service/git-service';
import { countCommitsUpTo, perfAdvice } from '../src/service/huge-repo';
import { isRawPathKey, pathBytes, rawPathKey, withPathspec } from '../src/service/pathspec';
import { isAncestor } from '../src/service/phase3/history';
import { describeGit, gitAtLeast, tinyRepo, useHarness } from './ops-harness';

/**
 * Phase 10 spec-02 gaps: config + merge-base channels (§7 step 11), conflicts list, huge-repo helpers
 * (§6.15), and the §8 edge cases (raw-byte paths, `-` paths, sha256, submodule opened as a repo).
 */

describeGit('config channels (spec 02 §6.11, §5.3)', () => {
  const h = useHarness('cfg');

  it('parses --list -z --show-origin --show-scope output (golden)', () => {
    const raw =
      'system\0file:/etc/gitconfig\0core.autocrlf\ntrue\0' +
      'global\0file:/home/u/.gitconfig\0user.name\nAna B\0' +
      'local\0file:.git/config\0core.bare\nfalse\0' +
      'local\0file:.git/config\0alias.lg\nlog --graph\n--oneline\0' +
      'local\0file:.git/config\0flag.only\0' +
      'command\0command line:\0color.ui\nfalse\0';
    expect(parseConfigList(raw)).toEqual([
      { scope: 'system', origin: 'file:/etc/gitconfig', key: 'core.autocrlf', value: 'true' },
      { scope: 'global', origin: 'file:/home/u/.gitconfig', key: 'user.name', value: 'Ana B' },
      { scope: 'local', origin: 'file:.git/config', key: 'core.bare', value: 'false' },
      { scope: 'local', origin: 'file:.git/config', key: 'alias.lg', value: 'log --graph\n--oneline' },
      { scope: 'local', origin: 'file:.git/config', key: 'flag.only', value: '' },
      { scope: 'command', origin: 'command line:', key: 'color.ui', value: 'false' },
    ]);
  });

  it('validates keys and masks credential-like values', () => {
    for (const k of ['user.name', 'remote.my.origin.url', 'branch.feat/x y.merge', 'gitflow.prefix.feature'])
      expect(isValidConfigKey(k), k).toBe(true);
    for (const k of ['', '-c', 'nodot', 'user.', '.name', 'a.b\nc.d', 'user.1name', 'a\0b.c'])
      expect(isValidConfigKey(k), JSON.stringify(k)).toBe(false);
    expect(redactConfigValue('http.https://h/.extraheader', 'AUTHORIZATION: basic xyz')).toEqual({
      value: '***',
      redacted: true,
    });
    expect(redactConfigValue('sendemail.smtppass', 'hunter2').value).toBe('***');
    expect(redactConfigValue('remote.origin.url', 'https://ana:tok3n@host/r.git')).toEqual({
      value: 'https://ana:***@host/r.git',
      redacted: true,
    });
    expect(redactConfigValue('user.name', 'Ana')).toEqual({ value: 'Ana', redacted: false });
    // the output log never shows a secret value written through `git config`
    expect(redactArgv(['config', '--local', '--', 'github.token', 'ghp_secret'])).toEqual([
      'config',
      '--local',
      '--',
      'github.token',
      '***',
    ]);
  });

  it('lists, gets and sets (queued) local config; global without a repo', async () => {
    const r = await tinyRepo(h);
    const t = configTarget(h.runner, r.svc);
    await h.run(r.svc, { type: 'config.set', key: 'gitflow.branch.master', value: 'main', scope: 'local' });
    await h.run(r.svc, {
      type: 'config.set',
      key: 'gitflow.prefix.feature',
      value: '-dash/',
      scope: 'local',
    });
    await h.run(r.svc, { type: 'config.set', key: 'kl.token', value: 's3cret', scope: 'local' });
    await h.run(r.svc, {
      type: 'config.set',
      key: 'remote.origin.url',
      value: 'https://ana:pw@example.com/r.git',
      scope: 'local',
    });

    const flow = await configList(t, { pattern: '^gitflow\\.', scope: 'local' });
    expect(flow.map((e) => [e.key, e.value])).toEqual([
      ['gitflow.branch.master', 'main'],
      ['gitflow.prefix.feature', '-dash/'],
    ]);
    expect(flow.every((e) => e.scope === 'local' && e.origin.startsWith('file:'))).toBe(true);

    const all = await configList(t);
    expect(all.find((e) => e.key === 'kl.token')).toMatchObject({ value: '***', redacted: true });
    expect(all.find((e) => e.key === 'remote.origin.url')?.value).toBe('https://ana:***@example.com/r.git');
    expect(await configGet(t, 'kl.token')).toBe('***');
    expect(await configGet(t, 'kl.token', { unmasked: true })).toBe('s3cret');
    expect(await configGet(t, 'gitflow.prefix.feature', { scope: 'local' })).toBe('-dash/');
    expect(await configGet(t, 'no.such')).toBeNull();
    expect(await configList(t, { pattern: '^nomatch\\.' })).toEqual([]);

    // unset twice: the second is a no-op (exit 5)
    await h.run(r.svc, { type: 'config.set', key: 'gitflow.branch.master', value: null, scope: 'local' });
    await h.run(r.svc, { type: 'config.set', key: 'gitflow.branch.master', value: null, scope: 'local' });
    expect(await configGet(t, 'gitflow.branch.master')).toBeNull();

    // invalid keys never reach git
    const bad = await h.fail(r.svc, { type: 'config.set', key: '--global', value: 'x', scope: 'local' });
    expect(bad.message).toMatch(/Invalid config key/);
    await expect(configGet(t, '-c')).rejects.toBeInstanceOf(GitError);
    await expect(configList(t, { pattern: '--file=/etc/passwd' })).rejects.toBeInstanceOf(GitError);

    // repo-less: global only, local scope refused
    const none = configTarget(h.runner, null);
    await configSetGlobal(h.runner, 'kl.phase', '10');
    expect(await configGet(none, 'kl.phase', { scope: 'global' })).toBe('10');
    const globals = await configList(none);
    expect(globals.some((e) => e.key === 'kl.phase' && e.scope === 'global')).toBe(true);
    expect(globals.some((e) => e.scope === 'local')).toBe(false);
    await expect(configList(none, { scope: 'local' })).rejects.toThrow(/needs an open repository/);
    await configSetGlobal(h.runner, 'kl.phase', null);
    expect(await configGet(none, 'kl.phase')).toBeNull();
  });
});

describeGit('never blocks on a terminal prompt (spec 02 §9)', () => {
  const h = useHarness('noprompt');

  it('a credential prompt fails fast with stdin closed and GIT_TERMINAL_PROMPT=0', async () => {
    const r = await tinyRepo(h);
    const t0 = Date.now();
    // no helper configured: git would ask the terminal for a username
    const err = await h.runner
      .run({
        cwd: r.dir,
        args: ['credential', 'fill'],
        stdin: 'protocol=https\nhost=example.invalid\n\n',
        timeoutMs: 20_000,
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).serialized.stderr).toMatch(/terminal prompts disabled|could not read Username/i);
    expect((err as GitError).code).toBe('AuthenticationFailed');
    expect(Date.now() - t0).toBeLessThan(15_000);

    // with nothing on stdin at all (closed immediately), commands needing input end instead of hanging
    const st = await h.runner.run({ cwd: r.dir, args: ['hash-object', '--stdin'] });
    expect(String(st.stdout).trim()).toMatch(/^[0-9a-f]{40}$/);
  });
});

describeGit('merge-base / is-ancestor / conflicts (spec 02 §6.8, §6.11)', () => {
  const h = useHarness('mb');

  it('merge-base default, none (unrelated) and fork-point; is-ancestor', async () => {
    const r = await tinyRepo(h);
    const base = r.rev('HEAD');
    r.g('switch', '-q', '-c', 'feature');
    const feat = r.commit('feat', { 'f.txt': 'f\n' });
    r.g('switch', '-q', 'main');
    r.commit('main', { 'm.txt': 'm\n' });
    r.g('switch', '-q', '--orphan', 'island');
    const island = r.commit('island', { 'i.txt': 'i\n' });
    r.g('switch', '-q', 'main');

    expect(await mergeBase(r.svc, 'main', 'feature')).toBe(base);
    expect(await mergeBase(r.svc, 'main', island)).toBeNull();
    expect(await mergeBase(r.svc, 'main', 'feature', 'fork-point')).toBe(base);
    await expect(mergeBase(r.svc, '--all', 'main')).rejects.toBeInstanceOf(GitError);

    expect(await isAncestor(r.svc, base, feat)).toBe(true);
    expect(await isAncestor(r.svc, feat, 'main')).toBe(false);
    await expect(isAncestor(r.svc, 'no-such-rev', 'main')).rejects.toBeInstanceOf(GitError);
  });

  it('lists unmerged paths with their stages (ls-files -u golden + real conflict)', async () => {
    const z = '0'.repeat(40);
    const a = 'a'.repeat(40);
    const b = 'b'.repeat(40);
    expect(
      parseLsFilesUnmerged(
        [
          `100644 ${z} 1\tdir/x y.txt`,
          `100644 ${a} 2\tdir/x y.txt`,
          `100755 ${b} 3\tdir/x y.txt`,
          `100644 ${a} 2\tonly-ours`,
          '',
        ].join('\0'),
      ),
    ).toEqual([
      {
        path: 'dir/x y.txt',
        stages: {
          base: { mode: '100644', sha: z },
          ours: { mode: '100644', sha: a },
          theirs: { mode: '100755', sha: b },
        },
      },
      { path: 'only-ours', stages: { ours: { mode: '100644', sha: a } } },
    ]);

    const f = h.fixture('conflict-in-progress');
    const svc = await h.open(f.path);
    const files = await listConflicts(svc);
    expect(files.length).toBeGreaterThan(0);
    for (const c of files) expect(c.stages.ours ?? c.stages.theirs).toBeDefined();
  });
});

describeGit('huge-repo helpers (spec 02 §6.15)', () => {
  const h = useHarness('huge');

  it('uses --date-order for topo requests until a commit-graph exists (§6.15.4)', async () => {
    const r = await tinyRepo(h);
    for (let i = 0; i < 4; i++) r.commit(`c${i}`, { [`f${i}.txt`]: `${i}\n` });
    expect(await countCommitsUpTo(r.svc, 3)).toBe(3);
    const svc = await GitService.open(h.runner, r.dir, { commitGraphThreshold: 3 });
    try {
      expect(await svc.topoOrderStreams()).toBe(false);
      const c = svc.log({ revs: 'all', order: 'topo' });
      expect((await c.next(100)).commits).toHaveLength(5);
      c.dispose();
      h.git(r.dir, 'commit-graph', 'write', '--reachable');
      expect(await svc.topoOrderStreams()).toBe(true);
    } finally {
      svc.dispose();
    }
    // small repos keep --topo-order
    expect(await r.svc.topoOrderStreams()).toBe(true);
  });

  it('offers fsmonitor + untracked cache above the tracked-file threshold (§6.15.2)', async () => {
    const r = await tinyRepo(h, { 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' });
    const features = { builtinFsmonitor: true } as never;
    const small = await perfAdvice(r.svc, { features, platform: 'win32' });
    expect(small).toMatchObject({
      trackedFiles: 3,
      large: false,
      offer: { fsmonitor: false, untrackedCache: false },
    });
    const big = await perfAdvice(r.svc, { features, platform: 'win32', threshold: 2 });
    expect(big).toMatchObject({
      large: true,
      fsmonitor: { supported: true, mode: 'off' },
      offer: { fsmonitor: true, untrackedCache: true },
    });
    expect((await perfAdvice(r.svc, { features, platform: 'linux', threshold: 2 })).offer.fsmonitor).toBe(
      false,
    );

    // a user's own fsmonitor hook is reported as such and never offered over; status still works
    const hook = path.join(r.dir, '.git', 'fsmonitor-hook.sh');
    fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    r.g('config', 'core.fsmonitor', hook.replace(/\\/g, '/'));
    r.g('config', 'core.untrackedCache', 'true');
    const hooked = await perfAdvice(r.svc, { features, platform: 'win32', threshold: 2 });
    expect(hooked).toMatchObject({ fsmonitor: { mode: 'hook' }, untrackedCache: true });
    expect(hooked.offer).toEqual({ fsmonitor: false, untrackedCache: false });
    fs.writeFileSync(path.join(r.dir, 'new.txt'), 'n\n');
    const st = await r.svc.status();
    expect(st.entries.some((e) => e.path === 'new.txt' && e.kind === 'untracked')).toBe(true);
  });

  it('computes upstream track only for local branches (§6.15.5)', async () => {
    const f = h.fixture('remote-pair');
    const svc = await h.open(f.path);
    const refs = await svc.refs();
    expect(refs.filter((x) => x.type === 'local').some((x) => x.upstream)).toBe(true);
    expect(refs.filter((x) => x.type !== 'local').every((x) => !x.upstream || x.upstream.ahead === 0)).toBe(
      true,
    );
  });

  it('computes ahead/behind lazily with many tracking branches, then matches git (§6.15.5)', async () => {
    const f = h.fixture('branches-5k', { branches: 12, commits: 20, tags: 2 });
    // one branch whose upstream is gone
    h.git(f.path, 'update-ref', '-d', 'refs/remotes/origin/feature/b00005');
    const truth = new Map(
      h
        .git(f.path, 'for-each-ref', '--format=%(refname)|%(upstream:track,nobracket)', 'refs/heads')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((l) => l.split('|') as [string, string]),
    );
    const expected = (r: {
      fullName: string;
      upstream?: { ahead: number; behind: number; gone: boolean };
    }) => {
      const t = truth.get(r.fullName) ?? '';
      return {
        ahead: Number(/ahead (\d+)/.exec(t)?.[1] ?? 0),
        behind: Number(/behind (\d+)/.exec(t)?.[1] ?? 0),
        gone: t === 'gone',
      };
    };
    const tracked = (refs: Awaited<ReturnType<GitService['refs']>>) =>
      refs.filter((r) => r.type === 'local' && r.upstream);

    const svc = await GitService.open(h.runner, f.path, { trackSyncLimit: 4, trackPriorityCount: 3 });
    try {
      const updated = new Promise<void>((resolve) => svc.onTrackUpdated(resolve));
      const first = tracked(await svc.refs());
      expect(first.length).toBeGreaterThan(4);
      const done = first.filter((r) => !r.upstream!.trackPending);
      // HEAD's branch (if tracking) + the 3 most recent are computed; the gone one needs no count
      expect(done.length).toBeGreaterThanOrEqual(3);
      expect(done.length).toBeLessThan(first.length);
      for (const r of done) expect(r.upstream, r.fullName).toMatchObject(expected(r));
      expect(first.find((r) => r.fullName === 'refs/heads/feature/b00005')?.upstream?.gone).toBe(true);

      await updated;
      const second = tracked(await svc.refs());
      expect(second.every((r) => !r.upstream!.trackPending)).toBe(true);
      for (const r of second) expect(r.upstream, r.fullName).toMatchObject(expected(r));
    } finally {
      svc.dispose();
    }

    // few tracking branches: one for-each-ref with %(upstream:track), identical results
    const small = await GitService.open(h.runner, f.path);
    try {
      for (const pass of [1, 2]) {
        const refs = tracked(await small.refs());
        for (const r of refs) expect(r.upstream, `${pass} ${r.fullName}`).toMatchObject(expected(r));
        expect(refs.some((r) => r.upstream!.trackPending)).toBe(false);
      }
    } finally {
      small.dispose();
    }
  });

  it('fetches a single file patch lazily (§6.15.6)', async () => {
    const r = await tinyRepo(h);
    const sha = r.commit('two files', { 'one.txt': '1\n', 'two.txt': '2\n' });
    const files = await r.svc.diff({ kind: 'commit', sha, paths: ['two.txt'] });
    expect(files.map((f) => f.newPath)).toEqual(['two.txt']);
  });
});

describeGit('edge cases (spec 02 §8)', () => {
  const h = useHarness('edge');

  it('keeps raw bytes of non-UTF-8 paths (parser) and passes them via pathspec stdin', () => {
    const bad = Buffer.from([0x66, 0xff, 0xfe, 0x2e, 0x74]); // "f\xff\xfe.t"
    const out = Buffer.concat([
      Buffer.from('# branch.oid (initial)\0# branch.head main\0? '),
      bad,
      Buffer.from('\0? ok.txt\0'),
    ]);
    const st = parseStatusV2(out);
    expect(st.entries).toHaveLength(2);
    expect(st.entries[0]!.path).toContain('�');
    expect(Buffer.from(st.entries[0]!.rawPath!, 'base64')).toEqual(bad);
    expect(st.entries[1]).toEqual({ kind: 'untracked', path: 'ok.txt' });

    const key = rawPathKey(st.entries[0]!.rawPath!);
    expect(isRawPathKey(key)).toBe(true);
    expect(pathBytes(key)).toEqual(bad);
    const ps = withPathspec(['add'], [key, 'ok.txt']);
    expect(ps.args).toEqual(['add', '--pathspec-from-file=-', '--pathspec-file-nul']);
    expect(ps.stdin).toEqual(Buffer.concat([bad, Buffer.from([0]), Buffer.from('ok.txt\0')]));
  });

  it.runIf(process.platform === 'linux')('stages a real non-UTF-8 file name by its raw bytes', async () => {
    const r = await tinyRepo(h);
    const name = Buffer.from([0x6c, 0x61, 0x74, 0x69, 0x6e, 0xe9, 0x2e, 0x74, 0x78, 0x74]); // latin1 "laté.txt"
    fs.writeFileSync(Buffer.concat([Buffer.from(r.dir + '/'), name]), 'x\n');
    const st = await r.svc.status();
    const e = st.entries.find((x) => x.rawPath)!;
    expect(Buffer.from(e.rawPath!, 'base64')).toEqual(name);
    await h.run(r.svc, { type: 'wip.stage', paths: [rawPathKey(e.rawPath!)] });
    const after = await r.svc.status();
    expect(after.entries.find((x) => x.rawPath)).toMatchObject({ kind: 'ordinary', index: 'A' });
  });

  it.runIf(process.platform !== 'win32')('handles newlines in paths (-z everywhere)', async () => {
    const r = await tinyRepo(h);
    h.write(path.join(r.dir, 'line\nbreak.txt'), 'x\n');
    const st = await r.svc.status();
    expect(st.entries.map((e) => e.path)).toContain('line\nbreak.txt');
    await h.run(r.svc, { type: 'wip.stage', paths: ['line\nbreak.txt'] });
    const staged = await r.svc.numstat({ kind: 'staged' });
    expect(staged.map((f) => f.path)).toEqual(['line\nbreak.txt']);
  });

  it('paths starting with "-" are passed after -- (stage, unstage, diff, show, discard)', async () => {
    const r = await tinyRepo(h, { '-n.txt': 'one\n', '--force': 'f\n' });
    h.write(path.join(r.dir, '-n.txt'), 'two\n');
    h.write(path.join(r.dir, '--force'), 'g\n');
    const diff = await r.svc.diff({ kind: 'workdir', paths: ['-n.txt'] });
    expect(diff.map((d) => d.newPath)).toEqual(['-n.txt']);
    await h.run(r.svc, { type: 'wip.stage', paths: ['-n.txt', '--force'] });
    expect((await r.svc.numstat({ kind: 'staged' })).map((f) => f.path).sort()).toEqual([
      '--force',
      '-n.txt',
    ]);
    await h.run(r.svc, { type: 'wip.unstage', paths: ['--force'] });
    expect((await r.svc.numstat({ kind: 'staged' })).map((f) => f.path)).toEqual(['-n.txt']);
    expect((await r.svc.showFile('HEAD', '-n.txt')).content).toBe('one\n');
    await h.run(r.svc, { type: 'wip.discard', paths: ['--force'], includeUntracked: false });
    expect(r.file('--force')).toBe('f\n');
  });

  it.runIf(gitAtLeast(2, 29))('opens and reads a sha256 repository', async () => {
    const dir = path.join(h.root, 'sha256');
    fs.mkdirSync(dir);
    h.git(dir, 'init', '-q', '--object-format=sha256', '-b', 'main');
    const svc = await h.open(dir);
    expect(svc.repo.objectFormat).toBe('sha256');
    expect(svc.repo.head).toEqual({ kind: 'branch', name: 'main', sha: null });
    h.write(path.join(dir, 'a.txt'), 'a\n');
    h.git(dir, 'add', 'a.txt');
    // unborn HEAD: the staged diff runs against the sha256 empty tree
    const staged = await svc.diff({ kind: 'staged' });
    expect(staged.map((f) => f.newPath)).toEqual(['a.txt']);
    h.git(dir, '-c', 'user.name=T', '-c', 'user.email=t@e.x', 'commit', '-q', '-m', 'one');
    await svc.refreshRepoInfo();
    expect(svc.repo.head.kind === 'branch' && svc.repo.head.sha).toMatch(/^[0-9a-f]{64}$/);
    const page = await svc.log({ revs: 'all', order: 'topo' }).next(10);
    expect(page.commits).toHaveLength(1);
    expect(page.commits[0]!.sha).toHaveLength(64);
    const detail = await svc.commitDetail(page.commits[0]!.sha);
    expect(detail.files.map((f) => f.path)).toEqual(['a.txt']);
    const refs = await svc.refs();
    expect(refs.find((x) => x.shortName === 'main')?.sha).toHaveLength(64);
  });

  it('opens a submodule as its own repository (.git file → modules/ git dir)', async () => {
    const f = h.fixture('submodules');
    const sub = path.join(f.path, 'lib');
    expect(fs.statSync(path.join(sub, '.git')).isFile()).toBe(true);
    const svc = await h.open(sub);
    expect(svc.repo.worktreeRoot).toBe(fs.realpathSync.native(sub));
    expect(svc.repo.gitDir.replace(/\\/g, '/')).toMatch(/\.git\/modules\/lib$/);
    expect(svc.repo.isLinkedWorktree).toBe(false);
    expect((await svc.status()).entries).toEqual([]);
    expect((await svc.log({ revs: 'all', order: 'topo' }).next(10)).commits.length).toBeGreaterThan(0);
  });

  it('detached HEAD and unborn branch', async () => {
    const r = await tinyRepo(h);
    const sha = r.commit('second', { 'b.txt': 'b\n' });
    r.g('switch', '-q', '--detach', 'HEAD~1');
    expect((await r.svc.refreshRepoInfo()).head).toEqual({ kind: 'detached', sha: r.rev('HEAD') });
    const st = await r.svc.status();
    expect(st.branch.head).toBeNull();
    expect(sha).not.toBe(r.rev('HEAD'));

    const empty = await h.open(h.fixture('empty').path);
    expect(empty.repo.head).toMatchObject({ kind: 'branch', sha: null });
    expect((await empty.status()).branch.oid).toBeNull();
    const page = await empty.log({ revs: 'all', order: 'topo' }).next(10);
    expect(page).toMatchObject({ commits: [], done: true });
  });

  it('reports the status of another linked worktree (spec 02 §11)', async () => {
    const f = h.fixture('worktrees');
    const svc = await h.open(f.path);
    const wt = (f.facts as { worktrees: string[] }).worktrees[0]!;
    h.write(path.join(wt, 'wt-only.txt'), 'x\n');
    const st = await svc.worktreeStatus(wt);
    expect(st.entries.some((e) => e.path === 'wt-only.txt')).toBe(true);
    expect(st.branch.head).toBe('feature');
    await expect(svc.worktreeStatus(h.root)).rejects.toThrow(/Not a worktree/);
  });
});
