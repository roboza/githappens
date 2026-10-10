import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseOpenPathArgs } from '../src/main/services/cli-args';
import { pathKey, RepoRegistry } from '../src/main/services/repo-registry';
import { ShellStateStore } from '../src/main/services/shell-state';
import { DEFAULT_LAYOUT } from '../src/shared/ipc/shell-contract';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-shell-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const rec = (p: string) => ({ path: p, name: path.basename(p), isBare: false });

describe('RepoRegistry', () => {
  it('records opens most-recent-first and persists', () => {
    const a = path.join(dir, 'a');
    const b = path.join(dir, 'b');
    fs.mkdirSync(a);
    const r = new RepoRegistry(path.join(dir, 'repos.json'));
    r.touch(rec(a), 1);
    r.touch(rec(b), 2);
    r.touch(rec(a), 3);
    const list = new RepoRegistry(path.join(dir, 'repos.json')).list();
    expect(list.map((x) => x.name)).toEqual(['a', 'b']);
    expect(list.find((x) => x.name === 'b')?.missing).toBe(true);
    expect(list.find((x) => x.name === 'a')?.missing).toBe(false);
  });

  it('keeps favorites first and preserves them on re-open', () => {
    const r = new RepoRegistry(path.join(dir, 'repos.json'));
    r.touch(rec(path.join(dir, 'old')), 1);
    r.touch(rec(path.join(dir, 'new')), 2);
    r.setFavorite(path.join(dir, 'old'), true);
    r.touch(rec(path.join(dir, 'old')), 3);
    r.touch(rec(path.join(dir, 'newest')), 4);
    const list = r.list();
    expect(list[0]).toMatchObject({ name: 'old', favorite: true });
  });

  it('removes entries', () => {
    const r = new RepoRegistry(path.join(dir, 'repos.json'));
    r.touch(rec(path.join(dir, 'x')));
    r.remove(path.join(dir, 'x'));
    expect(r.list()).toEqual([]);
  });

  it('compares paths case-insensitively on win32/darwin', () => {
    expect(pathKey('C:\\Repo\\A\\', 'win32')).toBe(pathKey('c:/repo/a', 'win32'));
  });
});

describe('ShellStateStore', () => {
  it('returns defaults, then round-trips tabs and layout', () => {
    const s = new ShellStateStore(dir);
    expect(s.tabs()).toEqual({ tabs: [], activeTabId: null });
    expect(s.layout()).toEqual(DEFAULT_LAYOUT);
    s.saveTabs({ tabs: [{ id: 't1', kind: 'repo', repoPath: '/r' }], activeTabId: 't1' });
    s.saveLayout({ ...DEFAULT_LAYOUT, leftPanelWidth: 300 });
    const t = new ShellStateStore(dir);
    expect(t.tabs().activeTabId).toBe('t1');
    expect(t.layout().leftPanelWidth).toBe(300);
  });

  it('repairs a dangling active tab id', () => {
    fs.writeFileSync(
      path.join(dir, 'tabs.json'),
      JSON.stringify({ tabs: [{ id: 'a', kind: 'newTab' }], activeTabId: 'gone' }),
    );
    expect(new ShellStateStore(dir).tabs().activeTabId).toBe('a');
  });
});

describe('parseOpenPathArgs', () => {
  const cwd = path.resolve('/work');
  it('handles -p / --path / --path= in dev and packaged builds', () => {
    expect(parseOpenPathArgs(['electron', '.', '-p', 'repo'], false, cwd)).toEqual([
      path.resolve(cwd, 'repo'),
    ]);
    expect(parseOpenPathArgs(['app.exe', '--path=/x/y'], true, cwd)).toEqual([path.resolve('/x/y')]);
    expect(parseOpenPathArgs(['app.exe', '--path', 'z'], true, cwd)).toEqual([path.resolve(cwd, 'z')]);
  });

  it('accepts positional paths only when packaged', () => {
    expect(parseOpenPathArgs(['app.exe', '.'], true, cwd)).toEqual([cwd]);
    expect(parseOpenPathArgs(['electron', '.', 'repo'], false, cwd)).toEqual([]);
    expect(parseOpenPathArgs(['app.exe', '--inspect'], true, cwd)).toEqual([]);
  });
});
