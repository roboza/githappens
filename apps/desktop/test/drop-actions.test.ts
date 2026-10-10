import { describe, expect, it } from 'vitest';

import {
  computeDropActions,
  type DragSource,
  type DropContext,
  type DropTarget,
} from '../src/renderer/src/actions/drop-actions';

const ctx = (over: Partial<DropContext> = {}): DropContext => ({
  head: 'main',
  headSha: 'h',
  inProgress: null,
  targetIsAncestorOfSource: false,
  headIsAncestorOfSource: false,
  ...over,
});
const ids = (s: DragSource, t: DropTarget, c = ctx()): string[] =>
  computeDropActions(s, t, c).map((a) => a.id);

const main: DragSource & DropTarget = { kind: 'local', name: 'main', sha: 'h' };
const feat: DragSource & DropTarget = { kind: 'local', name: 'feature', sha: 'f' };
const other: DropTarget = { kind: 'local', name: 'other', sha: 'o' };
const originFeat: DragSource & DropTarget = { kind: 'remote', name: 'origin/feature', sha: 'rf' };
const tag: DragSource & DropTarget = { kind: 'tag', name: 'v1', sha: 't' };

describe('computeDropActions (spec 05 §4.4)', () => {
  it('HEAD onto a local branch: merge, rebase, irebase, resets (+ ff when possible)', () => {
    expect(ids(main, feat)).toEqual([
      'merge',
      'merge-options',
      'rebase',
      'irebase',
      'reset-soft',
      'reset-mixed',
      'reset-hard',
    ]);
    expect(ids(main, feat, ctx({ targetIsAncestorOfSource: true }))).toContain('ff');
    const merge = computeDropActions(main, feat, ctx())[0]!;
    expect(merge.label).toBe('Merge feature into main');
    expect(merge.action).toEqual({ type: 'merge', source: 'feature' });
  });

  it('HEAD onto its remote: push is offered, force when not a fast-forward', () => {
    expect(ids(main, originFeat, ctx({ targetIsAncestorOfSource: true }))).toEqual([
      'merge',
      'merge-options',
      'rebase',
      'irebase',
      'push',
    ]);
    const force = computeDropActions(main, originFeat, ctx()).find((a) => a.id === 'push-force')!;
    expect(force.danger).toBe(true);
    expect(force.action).toEqual({
      type: 'push',
      local: 'main',
      remote: 'origin',
      remoteBranch: 'feature',
      force: true,
    });
  });

  it('a branch dropped on HEAD operates on HEAD', () => {
    expect(ids(feat, main)).toEqual([
      'merge',
      'merge-options',
      'rebase',
      'irebase',
      'reset-soft',
      'reset-mixed',
      'reset-hard',
    ]);
    expect(ids(feat, main, ctx({ headIsAncestorOfSource: true }))).toContain('ff');
    expect(computeDropActions(feat, main, ctx())[2]!.label).toBe('Rebase main onto feature');
    expect(ids(originFeat, main)).toContain('merge');
  });

  it('non-HEAD local onto non-HEAD local: only fast-forward when possible', () => {
    expect(ids(feat, other, ctx({ targetIsAncestorOfSource: true }))).toEqual(['ff']);
    expect(ids(feat, other)).toEqual(['none']);
  });

  it('local onto a remote node pushes; tag onto a remote node pushes the tag', () => {
    expect(ids(feat, { kind: 'remoteNode', remote: 'origin' })).toEqual(['push-new']);
    expect(ids(tag, { kind: 'remoteNode', remote: 'origin' })).toEqual(['push-tag']);
  });

  it('tags and commits dropped on HEAD', () => {
    expect(ids(tag, main)).toEqual([
      'merge',
      'merge-options',
      'rebase',
      'reset-soft',
      'reset-mixed',
      'reset-hard',
    ]);
    expect(ids({ kind: 'commit', sha: 'c' }, main)).toEqual([
      'cherry-pick',
      'rebase',
      'reset-soft',
      'reset-mixed',
      'reset-hard',
    ]);
  });

  it('stash dropped on HEAD applies or pops', () => {
    expect(ids({ kind: 'stash', sha: 's', index: 0, message: 'm' }, main)).toEqual([
      'stash-apply',
      'stash-pop',
    ]);
  });

  it('HEAD dropped on a commit row: rebase onto or reset to it', () => {
    expect(ids(main, { kind: 'commit', sha: 'c' })).toEqual([
      'rebase',
      'reset-soft',
      'reset-mixed',
      'reset-hard',
    ]);
  });

  it('same commit means nothing to do', () => {
    expect(ids(feat, { kind: 'local', name: 'x', sha: 'f' })).toEqual(['none']);
  });

  it('an in-progress operation disables everything but abort', () => {
    const r = computeDropActions(feat, main, ctx({ inProgress: 'rebase' }));
    expect(r.filter((a) => !a.disabled).map((a) => a.id)).toEqual(['abort']);
  });

  it('every merge has a "…" variant that asks for the merge mode (Phase 8)', () => {
    const r = computeDropActions(feat, main, ctx());
    const opt = r.find((a) => a.id === 'merge-options')!;
    expect(opt.label).toBe('Merge feature into main…');
    expect(opt.action).toEqual({ type: 'merge', source: 'feature', mode: 'ask' });
  });

  it('disables rebase with "No common ancestor" / "History is shallow" (spec 05 §4.4, §8)', () => {
    const none = computeDropActions(feat, main, ctx({ noCommonAncestor: true }));
    for (const id of ['rebase', 'irebase']) {
      const a = none.find((x) => x.id === id)!;
      expect(a.disabled, id).toBe(true);
      expect(a.title, id).toBe('No common ancestor');
    }
    expect(none.find((x) => x.id === 'merge')!.disabled).toBeFalsy();
    const shallow = computeDropActions(main, feat, ctx({ noCommonAncestor: true, shallow: true }));
    expect(shallow.find((x) => x.id === 'rebase')!.title).toBe('History is shallow');
    expect(shallow.find((x) => x.id === 'irebase')!.disabled).toBe(true);
    // shared history: nothing disabled
    const ok = computeDropActions(main, feat, ctx({ noCommonAncestor: false, shallow: true }));
    expect(ok.every((a) => !a.disabled)).toBe(true);
    // commit rows onto HEAD: "Rebase H onto commit" is gated too
    const commit = computeDropActions({ kind: 'commit', sha: 'c' }, main, ctx({ noCommonAncestor: true }));
    expect(commit.find((x) => x.id === 'rebase')!.disabled).toBe(true);
    expect(commit.find((x) => x.id === 'cherry-pick')!.disabled).toBeFalsy();
  });

  it('detached HEAD: drops on branches offer only non-HEAD actions', () => {
    expect(ids(feat, other, ctx({ head: null, targetIsAncestorOfSource: true }))).toEqual(['ff']);
  });
});
