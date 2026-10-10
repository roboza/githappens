import fs from 'node:fs';
import path from 'node:path';

import { expect, it } from 'vitest';

import type { GitOperation } from '../src/ops/types';
import {
  finishStatePath,
  GITFLOW_DEFAULTS,
  gitflowConfig,
  gitflowStatus,
  secondaryTarget,
} from '../src/service/gitflow';
import { UndoJournal } from '../src/undo';
import { describeGit, tinyRepo, useHarness, type TinyRepo } from './ops-harness';

const INIT: GitOperation = { type: 'gitflow.init', ...GITFLOW_DEFAULTS };

describeGit(
  'Git Flow gaps: bugfix, support, reset, hotfix into release (spec 12 §6.9, spec 05 §6.12)',
  () => {
    const h = useHarness('gitflow9');

    async function setup(initialized = true) {
      const r = await tinyRepo(h, { 'README.md': 'base\n', 'f.txt': 'base\n' });
      const journal = new UndoJournal({ service: r.svc });
      const run = (op: GitOperation) => h.run(r.svc, op, { journal });
      if (initialized) await run(INIT);
      return { r, journal, run, failOp: (op: GitOperation) => h.fail(r.svc, op, { journal }) };
    }

    const head = (r: TinyRepo): string => r.g('symbolic-ref', '--short', 'HEAD').trim();
    const exists = (r: TinyRepo, ref: string): boolean => {
      try {
        r.g('rev-parse', '-q', '--verify', ref);
        return true;
      } catch {
        return false;
      }
    };
    const parents = (r: TinyRepo, rev: string): string[] =>
      r.g('rev-list', '--parents', '-n', '1', rev).trim().split(/\s+/).slice(1);

    it('starts a bugfix from develop and finishes it into develop (rebase + delete), one undo', async () => {
      const { r, run, journal } = await setup();
      r.g('switch', '-q', 'develop');
      r.commit('D0', { 'd0.txt': 'd0\n' });
      r.g('switch', '-q', 'main');
      const start = await run({ type: 'gitflow.start', kind: 'bugfix', name: 'crash' });
      expect(start.summary).toBe('Started bugfix bugfix/crash');
      expect(head(r)).toBe('bugfix/crash');
      expect(r.rev('bugfix/crash')).toBe(r.rev('develop'));
      expect((await gitflowStatus(r.svc)).branches.bugfix).toEqual(['bugfix/crash']);

      const old = r.commit('B1', { 'b.txt': 'b\n' });
      r.g('switch', '-q', 'develop');
      const dev = r.commit('D1', { 'd.txt': 'd\n' });
      r.g('switch', '-q', 'bugfix/crash');
      const res = await run({
        type: 'gitflow.finish',
        kind: 'bugfix',
        name: 'crash',
        rebase: true,
        deleteBranch: true,
      });
      expect(res.summary).toBe('Finished bugfix bugfix/crash');
      const [p1, p2] = parents(r, 'develop');
      expect(p1).toBe(dev);
      expect(p2).not.toBe(old);
      expect(parents(r, p2!)).toEqual([dev]);
      expect(exists(r, 'refs/heads/bugfix/crash')).toBe(false);
      expect(head(r)).toBe('develop');
      expect(journal.peek().undo).toMatchObject({ kind: 'gitflow-finish', label: 'Finish bugfix crash' });

      await journal.undo();
      expect(r.rev('develop')).toBe(dev);
      expect(r.rev('bugfix/crash')).toBe(old);
    });

    it('starts a support branch from a tag; support needs a base and cannot be finished', async () => {
      const { r, run } = await setup();
      const v1 = r.rev('main');
      r.g('tag', '-a', '-m', 'one', 'v1.0', 'main');
      r.g('switch', '-q', 'main');
      r.commit('After 1.0', { 'm.txt': 'm\n' });

      const noBase = await h.fail(r.svc, { type: 'gitflow.start', kind: 'support', name: '1.x' });
      expect(noBase.details?.hint).toBe('gitflow.supportBase');
      const badBase = await h.fail(r.svc, {
        type: 'gitflow.start',
        kind: 'support',
        name: '1.x',
        base: 'nope',
      });
      expect(badBase.message).toMatch(/Unknown revision/);

      const res = await run({ type: 'gitflow.start', kind: 'support', name: '1.x', base: 'v1.0' });
      expect(res.summary).toBe('Started support branch support/1.x');
      expect(head(r)).toBe('support/1.x');
      expect(r.rev('support/1.x')).toBe(v1);
      // no upstream tracking of the tag
      expect(r.g('config', '--local', '--list')).not.toMatch(/branch\.support\/1\.x\./);
      expect((await gitflowStatus(r.svc)).branches.support).toEqual(['support/1.x']);

      const fin = await h.fail(r.svc, {
        type: 'gitflow.finish',
        kind: 'support',
        name: '1.x',
        deleteBranch: true,
      } as unknown as GitOperation);
      expect(fin.details?.hint).toBe('gitflow.supportFinish');
      expect(exists(r, 'refs/heads/support/1.x')).toBe(true);
    }, 120_000);

    it('a hotfix finish merges into the open release branch instead of develop (AVH); one undo', async () => {
      const { r, run, journal } = await setup();
      await run({ type: 'gitflow.start', kind: 'release', name: '1.1' });
      const rel = r.commit('Release work', { VERSION: '1.1\n' });
      await run({ type: 'gitflow.start', kind: 'hotfix', name: '1.0.1' });
      const fix = r.commit('Fix', { 'README.md': 'fixed\n' });
      const before = { main: r.rev('main'), develop: r.rev('develop'), rel };
      const res = await run({
        type: 'gitflow.finish',
        kind: 'hotfix',
        name: '1.0.1',
        deleteBranch: true,
        tag: { name: 'v1.0.1', message: 'Hotfix' },
      });
      expect(res.summary).toBe('Finished hotfix hotfix/1.0.1 (tagged v1.0.1, merged into release/1.1)');
      expect(res.data).toMatchObject({ mergedInto: 'release/1.1', tag: 'v1.0.1' });
      expect(parents(r, 'main')).toEqual([before.main, fix]);
      expect(parents(r, 'release/1.1')).toEqual([rel, fix]);
      expect(r.rev('develop')).toBe(before.develop); // develop untouched
      expect(r.rev('v1.0.1^{commit}')).toBe(r.rev('main'));
      expect(head(r)).toBe('release/1.1');
      expect(exists(r, 'refs/heads/hotfix/1.0.1')).toBe(false);

      await journal.undo();
      expect(r.rev('main')).toBe(before.main);
      expect(r.rev('release/1.1')).toBe(rel);
      expect(r.rev('hotfix/1.0.1')).toBe(fix);
      expect(exists(r, 'refs/tags/v1.0.1')).toBe(false);
      expect(head(r)).toBe('hotfix/1.0.1');
    }, 120_000);

    it('a hotfix-into-release conflict pauses, continues and aborts with the release ref', async () => {
      const { r, run, journal, failOp } = await setup();
      await run({ type: 'gitflow.start', kind: 'release', name: '2.0' });
      const rel = r.commit('Release change', { 'f.txt': 'release\n' });
      await run({ type: 'gitflow.start', kind: 'hotfix', name: '1.0.2' });
      r.commit('Hotfix change', { 'f.txt': 'hotfix\n' });
      const before = { main: r.rev('main'), develop: r.rev('develop'), rel };
      const finishOp: GitOperation = {
        type: 'gitflow.finish',
        kind: 'hotfix',
        name: '1.0.2',
        deleteBranch: true,
        tag: { name: 'v1.0.2', message: 'Two' },
      };
      let err = await failOp(finishOp);
      expect(err.code).toBe('MergeConflict');
      expect((await gitflowStatus(r.svc)).pendingFinish).toMatchObject({
        kind: 'hotfix',
        step: 'merge hotfix/1.0.2 into release/2.0',
        remaining: ['delete hotfix/1.0.2'],
      });

      // abort rolls back main + tag and leaves release/develop as they were
      await run({ type: 'gitflow.abort' });
      expect(r.rev('main')).toBe(before.main);
      expect(r.rev('release/2.0')).toBe(rel);
      expect(exists(r, 'refs/tags/v1.0.2')).toBe(false);
      expect(fs.existsSync(finishStatePath(r.svc))).toBe(false);

      // again, then continue
      err = await failOp(finishOp);
      expect(err.code).toBe('MergeConflict');
      h.write(path.join(r.dir, 'f.txt'), 'resolved\n');
      r.g('add', 'f.txt');
      const res = await run({ type: 'gitflow.continue' });
      expect(res.summary).toMatch(/merged into release\/2\.0/);
      expect(head(r)).toBe('release/2.0');
      expect(parents(r, 'release/2.0')[0]).toBe(rel);
      expect(r.rev('develop')).toBe(before.develop);
      expect(exists(r, 'refs/heads/hotfix/1.0.2')).toBe(false);

      await journal.undo();
      expect(r.rev('main')).toBe(before.main);
      expect(r.rev('release/2.0')).toBe(rel);
      expect(exists(r, 'refs/tags/v1.0.2')).toBe(false);
    }, 120_000);

    it('a hotfix finish goes into develop when there is no single release branch', async () => {
      const { r, run } = await setup();
      await run({ type: 'gitflow.start', kind: 'release', name: '1.1' });
      await run({ type: 'gitflow.start', kind: 'release', name: '1.2' });
      await run({ type: 'gitflow.start', kind: 'hotfix', name: '1.0.1' });
      const fix = r.commit('Fix', { 'README.md': 'fixed\n' });
      const rel = r.rev('release/1.1');
      const res = await run({
        type: 'gitflow.finish',
        kind: 'hotfix',
        name: '1.0.1',
        deleteBranch: false,
        tag: { name: 'v1.0.1', message: 'Hotfix' },
      });
      expect(res.summary).toBe('Finished hotfix hotfix/1.0.1 (tagged v1.0.1)');
      expect(parents(r, 'develop')[1]).toBe(fix);
      expect(r.rev('release/1.1')).toBe(rel);
      expect(secondaryTarget({ develop: 'dev' }, 'hotfix', ['release/a'])).toBe('release/a');
      expect(secondaryTarget({ develop: 'dev' }, 'hotfix', [])).toBe('dev');
      expect(secondaryTarget({ develop: 'dev' }, 'release', ['release/a'])).toBe('dev');
    }, 120_000);

    it('gitflow.reset removes every gitflow.* key and tolerates missing sections', async () => {
      const { r, run } = await setup();
      r.g('config', '--local', 'gitflow.feature.finish.rebase', 'true');
      r.g('config', '--local', 'gitflow.origin', 'origin');
      r.g('config', '--local', 'user.keep', 'yes');
      expect(await gitflowConfig(r.svc)).not.toBeNull();

      const res = await run({ type: 'gitflow.reset' });
      expect(res.summary).toBe('Removed the Git Flow configuration');
      expect(await gitflowConfig(r.svc)).toBeNull();
      expect(r.g('config', '--local', '--list')).not.toMatch(/gitflow/i);
      expect(r.g('config', '--local', 'user.keep').trim()).toBe('yes');
      expect(exists(r, 'refs/heads/develop')).toBe(true); // branches are kept

      // nothing left: still succeeds
      expect((await run({ type: 'gitflow.reset' })).summary).toBe('Git Flow was not configured');

      // refused while a finish is paused
      await run(INIT);
      await run({ type: 'gitflow.start', kind: 'feature', name: 'c' });
      r.commit('F', { 'f.txt': 'feature\n' });
      r.g('switch', '-q', 'develop');
      r.commit('D', { 'f.txt': 'develop\n' });
      const conflict = await h.fail(r.svc, {
        type: 'gitflow.finish',
        kind: 'feature',
        name: 'c',
        deleteBranch: true,
      });
      expect(conflict.code).toBe('MergeConflict');
      const refused = await h.fail(r.svc, { type: 'gitflow.reset' });
      expect(refused.details?.hint).toBe('gitflow.pending');
      expect(await gitflowConfig(r.svc)).not.toBeNull();
    }, 120_000);
  },
);
