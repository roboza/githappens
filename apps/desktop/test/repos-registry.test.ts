import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { onRegistryChanged, RepoRegistry, sanitizeGroups } from '../src/main/services/repo-registry';
import { DEFAULT_COLUMN_WIDTHS } from '../src/shared/ipc/repos2-contract';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-repos-reg-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const rec = (p: string) => ({ path: p, name: path.basename(p), isBare: false });

describe('RepoRegistry groups / reorder / columns', () => {
  it('starts with the built-in groups and default widths', () => {
    const r = new RepoRegistry(path.join(dir, 'repos.json'));
    const s = r.state();
    expect(s.groups.map((g) => g.id)).toEqual(['open', 'favorites', 'recent']);
    expect(s.columnWidths).toEqual(DEFAULT_COLUMN_WIDTHS);
  });

  it('saves custom groups with colour, order and membership; deleting drops memberships', () => {
    const file = path.join(dir, 'repos.json');
    const r = new RepoRegistry(file);
    const a = path.join(dir, 'a');
    r.touch(rec(a), 1);
    r.saveGroups([
      { id: 'custom:work', kind: 'custom', name: ' Work ', color: 'teal', collapsed: false, order: 0 },
      { id: 'recent', kind: 'recent', name: 'ignored', collapsed: true, order: 1 },
      { id: 'evil/../x', kind: 'custom', name: 'bad', collapsed: false, order: 2 },
      { id: 'custom:c2', kind: 'custom', name: 'X', color: 'url(javascript:1)', collapsed: false, order: 3 },
    ]);
    r.assignGroup(a, 'custom:work', true);
    const s = new RepoRegistry(file).state();
    expect(s.groups.map((g) => g.id)).toEqual(['open', 'favorites', 'custom:work', 'recent', 'custom:c2']);
    const work = s.groups.find((g) => g.id === 'custom:work')!;
    expect(work).toMatchObject({ name: 'Work', color: 'teal', kind: 'custom' });
    expect(s.groups.find((g) => g.id === 'recent')).toMatchObject({
      name: 'Recently opened',
      collapsed: true,
    });
    expect(s.groups.find((g) => g.id === 'custom:c2')!.color).toBeUndefined();
    expect(s.repos[0]!.groupIds).toEqual(['custom:work']);
    expect(() => r.assignGroup(a, 'recent', true)).toThrow();

    r.saveGroups(s.groups.filter((g) => g.id !== 'custom:work'));
    expect(new RepoRegistry(file).state().repos[0]!.groupIds).toEqual([]);
  });

  it('reorders favorites and persists column widths (clamped)', () => {
    const file = path.join(dir, 'repos.json');
    const r = new RepoRegistry(file);
    const [a, b, c] = ['a', 'b', 'c'].map((n) => path.join(dir, n));
    for (const [i, p] of [a, b, c].entries()) {
      fs.mkdirSync(p!);
      r.touch(rec(p!), i);
      r.setFavorite(p!, true);
    }
    r.reorderFavorites([c!, a!]);
    expect(
      new RepoRegistry(file)
        .list()
        .filter((x) => x.favorite)
        .map((x) => x.name),
    ).toEqual(['c', 'a', 'b']);

    r.setColumnWidths({ name: 10, remote: 5000, branch: 200 });
    expect(new RepoRegistry(file).state().columnWidths).toEqual({ name: 80, remote: 1200, branch: 200 });
  });

  it('notifies listeners on change', () => {
    const r = new RepoRegistry(path.join(dir, 'repos.json'));
    const seen: number[] = [];
    const off = onRegistryChanged((list) => seen.push(list.length));
    r.touch(rec(path.join(dir, 'x')));
    off();
    r.touch(rec(path.join(dir, 'y')));
    expect(seen).toEqual([1]);
  });

  it('sanitizeGroups re-adds missing built-ins', () => {
    expect(sanitizeGroups(null).map((g) => g.order)).toEqual([0, 1, 2]);
  });
});
