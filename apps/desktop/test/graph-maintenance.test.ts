import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CommitGraphMaintainer,
  hasCommitGraph,
  COUNT_ARGS,
  WRITE_ARGS,
} from '../src/main/repo-ui/commit-graph-maintenance';

let gitOk = true;
try {
  execFileSync('git', ['--version'], { windowsHide: true });
} catch {
  gitOk = false;
}

describe('commit-graph maintenance (graph.maintainCommitGraph)', () => {
  it('writes once on open for large repos, skips small ones, refreshes after ops (throttled)', async () => {
    const calls: string[][] = [];
    let count = 50_000;
    let exists = false;
    let now = 0;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-cg-'));
    const commonDir = path.join(dir, '.git');
    fs.mkdirSync(path.join(commonDir, 'objects', 'info'), { recursive: true });
    const m = new CommitGraphMaintainer({
      enabled: () => true,
      now: () => now,
      run: async (_cwd, args) => {
        calls.push(args);
        if (args[0] === 'rev-list') return `${count}\n`;
        exists = true;
        fs.writeFileSync(path.join(commonDir, 'objects', 'info', 'commit-graph'), '');
        return '';
      },
    });
    const repo = { cwd: dir, commonDir };
    m.onRepoOpened(repo);
    m.onRepoOpened(repo); // once per session
    await m.idle();
    expect(calls).toEqual([COUNT_ARGS, WRITE_ARGS]);
    expect(exists).toBe(true);

    // existing file: reopening does nothing; a fetch refreshes, a second fetch within 10 min does not
    calls.length = 0;
    m.onOpState(repo, { type: 'fetch', state: 'succeeded' });
    await m.idle();
    expect(calls).toEqual([]); // last write was just now
    now += 11 * 60_000;
    m.onOpState(repo, { type: 'fetch', state: 'failed' });
    m.onOpState(repo, { type: 'commit.create', state: 'succeeded' });
    await m.idle();
    expect(calls).toEqual([]);
    m.onOpState(repo, { type: 'pull', state: 'succeeded' });
    await m.idle();
    expect(calls).toEqual([WRITE_ARGS]);

    // small repo without a commit-graph: counted, not written
    calls.length = 0;
    count = 10;
    const small = { cwd: dir, commonDir: path.join(dir, 'small', '.git') };
    m.onRepoOpened(small);
    await m.idle();
    expect(calls).toEqual([COUNT_ARGS]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes through the repo op queue when given `write`; a cancelled write is not retried at once', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-cg-op-'));
    const commonDir = path.join(dir, '.git');
    fs.mkdirSync(path.join(commonDir, 'objects', 'info'), { recursive: true });
    let now = 0;
    const runs: string[][] = [];
    const writes: string[] = [];
    let cancel = true;
    const m = new CommitGraphMaintainer({
      enabled: () => true,
      now: () => now,
      run: async (_cwd, args) => (runs.push(args), '50000\n'),
      write: async (repo) => {
        writes.push(repo.repoId!);
        if (cancel) throw Object.assign(new Error('Cancelled'), { code: 'Cancelled' });
      },
    });
    const repo = { cwd: dir, commonDir, repoId: 'r1' };
    m.onRepoOpened(repo);
    await m.idle();
    expect(runs).toEqual([COUNT_ARGS]); // the count is a plain read; the write is the queued op
    expect(writes).toEqual(['r1']);
    expect(m.writes).toBe(0);
    // the user cancelled it: the next fetch does not start it again right away …
    m.onOpState(repo, { type: 'fetch', state: 'succeeded' });
    await m.idle();
    expect(writes).toEqual(['r1']);
    // … but later it does
    now += 11 * 60_000;
    cancel = false;
    m.onOpState(repo, { type: 'fetch', state: 'succeeded' });
    await m.idle();
    expect(writes).toEqual(['r1', 'r1']);
    expect(m.writes).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does nothing when the setting is off', async () => {
    const calls: string[][] = [];
    const m = new CommitGraphMaintainer({ enabled: () => false, run: async (_c, a) => (calls.push(a), '') });
    m.onRepoOpened({ cwd: '.', commonDir: 'x' });
    m.onOpState({ cwd: '.', commonDir: 'x' }, { type: 'fetch', state: 'succeeded' });
    await m.idle();
    expect(calls).toEqual([]);
  });

  describe.skipIf(!gitOk)('with real git', () => {
    let dir: string;
    beforeAll(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-cg-real-'));
      const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, windowsHide: true });
      git('init', '-q', '-b', 'main');
      git('-c', 'user.name=a', '-c', 'user.email=a@b.c', 'commit', '-q', '--allow-empty', '-m', 'one');
    });
    afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('detects and writes objects/info/commit-graph', async () => {
      const commonDir = path.join(dir, '.git');
      expect(hasCommitGraph(commonDir)).toBe(false);
      const m = new CommitGraphMaintainer({
        enabled: () => true,
        threshold: 1,
        run: async (cwd, args) => execFileSync('git', args, { cwd, windowsHide: true }).toString('utf8'),
      });
      m.onRepoOpened({ cwd: dir, commonDir });
      await m.idle();
      expect(hasCommitGraph(commonDir)).toBe(true);
      expect(m.writes).toBe(1);
    });
  });
});
