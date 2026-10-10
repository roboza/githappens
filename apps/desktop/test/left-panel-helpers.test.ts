import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { RefInfo } from '@githappens/git/types';
import { afterAll, describe, expect, it } from 'vitest';

import { DEFAULT_REPO_UI, RepoUiStore, sanitizeRepoUi } from '../src/main/repo-ui/repo-ui-store';
import { buildTree } from '../src/renderer/src/lib/format';
import {
  deletableBranches,
  flattenRefTree,
  highlightSegments,
  nextSelection,
  windowRange,
} from '../src/renderer/src/views/left/left-panel-model';
import {
  DEFAULT_LEFT_LAYOUT,
  isSectionOpen,
  isSectionShown,
  MAX_SECTION_HEIGHT,
  MIN_SECTION_HEIGHT,
  sanitizeLeftPanelLayout,
  setSectionHeight,
  setSectionShown,
  toggleCollapsed,
  toggleMaximized,
} from '../src/shared/left-panel/layout';

const ref = (shortName: string, type: RefInfo['type'] = 'local', extra: Partial<RefInfo> = {}): RefInfo => ({
  fullName:
    type === 'local'
      ? `refs/heads/${shortName}`
      : type === 'remote'
        ? `refs/remotes/${shortName}`
        : `refs/tags/${shortName}`,
  shortName,
  type,
  sha: 'a'.repeat(40),
  isHead: false,
  ...extra,
});

describe('filter match highlighting', () => {
  it('splits a label into hit / plain runs', () => {
    expect(highlightSegments('main', [0, 1])).toEqual([
      { text: 'ma', hit: true },
      { text: 'in', hit: false },
    ]);
    expect(highlightSegments('main', null)).toEqual([{ text: 'main', hit: false }]);
    expect(highlightSegments('', [0])).toEqual([]);
  });

  it('shifts indices of the full name onto a tree-leaf label', () => {
    // "feature/login" matched "flog" at f(0) l(8) o(9) g(10); the leaf label is "login"
    expect(highlightSegments('login', [0, 8, 9, 10], 'feature/login')).toEqual([
      { text: 'log', hit: true },
      { text: 'in', hit: false },
    ]);
  });
});

describe('ref tree flattening', () => {
  const refs = [ref('main'), ref('feature/a'), ref('feature/b'), ref('feature/deep/c')];
  const tree = buildTree(refs, (r) => r.shortName);

  it('lists folders first and hides children of collapsed folders', () => {
    const rows = flattenRefTree(tree, { prefix: 'local', collapsed: (k) => k === 'local:feature/deep/' });
    expect(rows.map((r) => (r.kind === 'folder' ? `${r.name}/${r.open ? '-' : '+'}` : r.label))).toEqual([
      'feature/-',
      'deep/+',
      'a',
      'b',
      'main',
    ]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 1, 1, 0]);
  });

  it('auto-expands every folder while filtering', () => {
    const rows = flattenRefTree(tree, { prefix: 'local', collapsed: () => true, forceOpen: true });
    expect(rows.filter((r) => r.kind === 'ref').map((r) => r.key)).toEqual([
      'refs/heads/feature/deep/c',
      'refs/heads/feature/a',
      'refs/heads/feature/b',
      'refs/heads/main',
    ]);
    expect(rows.every((r) => r.kind !== 'folder' || r.open)).toBe(true);
  });
});

describe('virtualization windowing', () => {
  it('renders only the rows in view plus overscan', () => {
    expect(windowRange({ count: 1000, rowHeight: 26, scrollTop: 0, viewport: 260, overscan: 5 })).toEqual({
      start: 0,
      end: 16,
      padTop: 0,
      padBottom: (1000 - 16) * 26,
    });
    const w = windowRange({ count: 1000, rowHeight: 26, scrollTop: 26 * 500, viewport: 260, overscan: 5 });
    expect(w).toMatchObject({ start: 495, end: 516, padTop: 495 * 26 });
    expect(w.padTop + (w.end - w.start) * 26 + w.padBottom).toBe(1000 * 26);
  });

  it('clamps at the end and handles empty lists', () => {
    const w = windowRange({ count: 10, rowHeight: 26, scrollTop: 9999, viewport: 100 });
    expect(w.end).toBe(10);
    expect(w.padBottom).toBe(0);
    expect(windowRange({ count: 0, rowHeight: 26, scrollTop: 0, viewport: 100 })).toEqual({
      start: 0,
      end: 0,
      padTop: 0,
      padBottom: 0,
    });
  });
});

describe('multi-select', () => {
  const order = ['a', 'b', 'c', 'd'];
  it('click / ctrl-click / shift-click', () => {
    expect(nextSelection([], order, 'b', {}, null)).toEqual({ selected: ['b'], anchor: 'b' });
    expect(nextSelection(['b'], order, 'd', { toggle: true }, 'b')).toEqual({
      selected: ['b', 'd'],
      anchor: 'd',
    });
    expect(nextSelection(['b', 'd'], order, 'b', { toggle: true }, 'd')).toEqual({
      selected: ['d'],
      anchor: 'b',
    });
    expect(nextSelection(['b'], order, 'd', { range: true }, 'b').selected).toEqual(['b', 'c', 'd']);
    expect(nextSelection(['b'], order, 'a', { range: true }, 'c').selected).toEqual(['a', 'b', 'c']);
  });

  it('never deletes the checked-out branch', () => {
    const refs = [ref('main', 'local', { isHead: true }), ref('x'), ref('y'), ref('origin/x', 'remote')];
    expect(
      deletableBranches(refs, [
        'refs/heads/main',
        'refs/heads/x',
        'refs/heads/y',
        'refs/remotes/origin/x',
      ]).map((r) => r.shortName),
    ).toEqual(['x', 'y']);
  });
});

describe('section layout state', () => {
  const L = { ...DEFAULT_LEFT_LAYOUT };

  it('collapses, maximizes and restores', () => {
    let l = toggleCollapsed(L, 'tags');
    expect(isSectionOpen(l, 'tags')).toBe(false);
    l = toggleMaximized(l, 'tags');
    expect(l.maximized).toBe('tags');
    expect(isSectionOpen(l, 'tags')).toBe(true);
    expect(isSectionOpen(l, 'local')).toBe(false);
    // expanding another section restores the normal layout
    l = toggleCollapsed(l, 'local', false);
    expect(l.maximized).toBeNull();
    l = toggleMaximized(toggleMaximized(l, 'local'), 'local');
    expect(l.maximized).toBeNull();
    // collapsing the maximized section restores too
    l = toggleCollapsed(toggleMaximized(l, 'remote'), 'remote', true);
    expect(l.maximized).toBeNull();
  });

  it('follows match counts while filtering', () => {
    const l = toggleCollapsed(L, 'local');
    expect(isSectionOpen(l, 'local', { filterActive: true, count: 2 })).toBe(true);
    expect(isSectionOpen(L, 'tags', { filterActive: true, count: 0 })).toBe(false);
  });

  it('hides sections and enables opt-in ones (submodules)', () => {
    expect(isSectionShown(L, 'submodules', { optIn: true })).toBe(false);
    expect(isSectionShown(L, 'submodules', { optIn: true, hasItems: true })).toBe(true);
    let l = setSectionShown(L, 'submodules', true, true);
    expect(isSectionShown(l, 'submodules', { optIn: true })).toBe(true);
    l = setSectionShown(l, 'submodules', false, true);
    expect(isSectionShown(l, 'submodules', { optIn: true, hasItems: false })).toBe(false);
    l = setSectionShown(toggleMaximized(L, 'tags'), 'tags', false);
    expect(isSectionShown(l, 'tags')).toBe(false);
    expect(l.maximized).toBeNull();
    expect(isSectionShown(setSectionShown(l, 'tags', true), 'tags')).toBe(true);
  });

  it('clamps and resets heights', () => {
    expect(setSectionHeight(L, 'local', 10).heights.local).toBe(MIN_SECTION_HEIGHT);
    expect(setSectionHeight(L, 'local', 1e9).heights.local).toBe(MAX_SECTION_HEIGHT);
    expect(setSectionHeight(setSectionHeight(L, 'local', 200), 'local', null).heights).toEqual({});
  });

  it('sanitizes untrusted input', () => {
    expect(sanitizeLeftPanelLayout(null)).toBeUndefined();
    expect(sanitizeLeftPanelLayout([])).toBeUndefined();
    expect(
      sanitizeLeftPanelLayout({
        collapsed: ['tags', 'tags', 7, 'bad id!'],
        hidden: 'x',
        enabled: ['submodules'],
        heights: { local: 123.4, remote: 'big', 'x y': 50, tags: 5 },
        maximized: 'remote',
      }),
    ).toEqual({
      collapsed: ['tags'],
      hidden: [],
      enabled: ['submodules'],
      heights: { local: 123, tags: MIN_SECTION_HEIGHT },
      maximized: 'remote',
    });
  });
});

describe('left panel layout persistence (repoUi)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-left-layout-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('round-trips leftPanel through graph.json and keeps other fields', () => {
    const repo = path.join(dir, 'proj', '.git');
    const store = new RepoUiStore(() => dir);
    expect(store.get(repo)).toEqual(DEFAULT_REPO_UI);
    store.save(repo, { hiddenRefs: ['refs/heads/x'] });
    const s = store.save(repo, {
      leftPanel: {
        collapsed: ['tags'],
        hidden: ['issues'],
        enabled: ['submodules'],
        heights: { local: 240 },
        maximized: null,
      },
    });
    expect(s.hiddenRefs).toEqual(['refs/heads/x']);
    const reopened = new RepoUiStore(() => dir).get(repo);
    expect(reopened.leftPanel).toEqual({
      collapsed: ['tags'],
      hidden: ['issues'],
      enabled: ['submodules'],
      heights: { local: 240 },
      maximized: null,
    });
    expect(reopened.hiddenRefs).toEqual(['refs/heads/x']);
    // returned state is a copy
    reopened.leftPanel!.collapsed.push('local');
    expect(store.get(repo).leftPanel!.collapsed).toEqual(['tags']);
    expect(store.save(repo, { leftPanel: null }).leftPanel).toBeNull();
  });

  it('ignores invalid leftPanel patches', () => {
    expect(sanitizeRepoUi({ leftPanel: 'nope' })).toEqual({});
    expect(sanitizeRepoUi({ leftPanel: null })).toEqual({ leftPanel: null });
  });
});
