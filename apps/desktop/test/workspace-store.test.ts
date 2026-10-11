import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Workspace } from '../src/shared/ipc/workspaces-contract';
import { WorkspaceStore } from '../src/main/workspaces/workspace-store';

describe('WorkspaceStore (spec 11 §7 step 2)', () => {
  let dir: string;
  let profile: string;
  let changes: Workspace[][];
  let corrupt: Array<[string, string]>;

  const make = () =>
    new WorkspaceStore({
      profileDir: () => profile,
      onChange: (l) => changes.push(l),
      onCorrupt: (b, e) => corrupt.push([b, e]),
    });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-ws-store-'));
    profile = path.join(dir, 'profiles', 'default');
    changes = [];
    corrupt = [];
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('creates, updates, persists and deletes', () => {
    const s = make();
    expect(s.list()).toEqual([]);
    const a = s.create({ kind: 'local', name: '  Payments ', description: 'api + web', color: '#f00' });
    expect(a.name).toBe('Payments');
    expect(a.order).toBe(0);
    const b = s.create({ kind: 'local', name: 'Infra' });
    expect(b.order).toBe(1);
    s.update(a.id, { name: 'Pay', description: '', hidden: true });
    expect(changes.length).toBe(3);

    const file = JSON.parse(fs.readFileSync(path.join(profile, 'workspaces.json'), 'utf8'));
    expect(file.version).toBe(1);
    expect(file.workspaces).toHaveLength(2);

    const reloaded = make().list();
    expect(reloaded.map((w) => w.name)).toEqual(['Pay', 'Infra']);
    expect(reloaded[0]!.hidden).toBe(true);
    expect(reloaded[0]!.description).toBeUndefined();

    s.delete(a.id);
    expect(
      make()
        .list()
        .map((w) => w.name),
    ).toEqual(['Infra']);
  });

  it('rejects empty names', () => {
    const s = make();
    expect(() => s.create({ kind: 'local', name: '  ' })).toThrow(/name/);
    const w = s.create({ kind: 'local', name: 'x' });
    expect(() => s.update(w.id, { name: '' })).toThrow(/name/);
  });

  it('reorders (unlisted ids keep their order at the end)', () => {
    const s = make();
    const [a, b, c] = ['a', 'b', 'c'].map((n) => s.create({ kind: 'local', name: n }));
    expect(s.reorder([c!.id, a!.id]).map((w) => w.name)).toEqual(['c', 'a', 'b']);
    expect(
      make()
        .list()
        .map((w) => w.name),
    ).toEqual(['c', 'a', 'b']);
    void b;
  });

  it('adds repos without duplicates and removes them', () => {
    const s = make();
    const w = s.create({ kind: 'local', name: 'w', repos: [{ localPath: path.join(dir, 'one') }] });
    const provider = {
      integrationKey: 'github:github.com:1',
      owner: 'acme',
      name: 'api',
      cloneUrlHttps: 'https://github.com/acme/api.git',
      cloneUrlSsh: 'git@github.com:acme/api.git',
      webUrl: 'https://github.com/acme/api',
    };
    const after = s.addRepos(w.id, [
      { localPath: path.join(dir, 'one') },
      { localPath: path.join(dir, 'two'), name: 'Two' },
      { provider },
      { provider: { ...provider } },
    ]);
    expect(after.repos.map((r) => r.name)).toEqual(['one', 'Two', 'api']);
    const removed = s.removeRepos(w.id, [after.repos[0]!.id]);
    expect(removed.repos.map((r) => r.name)).toEqual(['Two', 'api']);
    const located = s.setRepoPath(w.id, removed.repos[1]!.id, path.join(dir, 'api'), 'https://x/acme/api');
    expect(path.resolve(located.localPath)).toBe(path.resolve(path.join(dir, 'api')));
    expect(located.remoteUrl).toBe('https://x/acme/api');
  });

  it('syncs directory repos keeping ids of unchanged paths', () => {
    const s = make();
    const w = s.create({
      kind: 'directory',
      name: 'd',
      directory: { root: dir, depth: 2, includeNested: false, ignore: [] },
      repos: [{ localPath: path.join(dir, 'a') }, { localPath: path.join(dir, 'b') }],
    });
    const idA = w.repos[0]!.id;
    const r = s.syncRepos(w.id, [{ localPath: path.join(dir, 'a') }, { localPath: path.join(dir, 'c') }]);
    expect(r.added).toEqual(['c']);
    expect(r.removed).toEqual(['b']);
    expect(r.workspace.repos.map((x) => x.name)).toEqual(['a', 'c']);
    expect(r.workspace.repos[0]!.id).toBe(idA);
  });

  it('recovers from a corrupt file by backing it up and starting empty', () => {
    fs.mkdirSync(profile, { recursive: true });
    const file = path.join(profile, 'workspaces.json');
    fs.writeFileSync(file, '{"version": 1, "workspaces": [');
    const s = make();
    expect(s.list()).toEqual([]);
    expect(corrupt).toHaveLength(1);
    expect(fs.existsSync(corrupt[0]![0])).toBe(true);
    expect(corrupt[0]![0]).toMatch(/workspaces\.json\.bak/);
    expect(fs.existsSync(file)).toBe(false);
    s.create({ kind: 'local', name: 'fresh' });
    expect(
      make()
        .list()
        .map((w) => w.name),
    ).toEqual(['fresh']);
  });

  it('treats an unknown version as corrupt and drops invalid entries', () => {
    fs.mkdirSync(profile, { recursive: true });
    const file = path.join(profile, 'workspaces.json');
    fs.writeFileSync(file, JSON.stringify({ version: 7, workspaces: [] }));
    expect(make().list()).toEqual([]);
    expect(corrupt).toHaveLength(1);

    corrupt = [];
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        workspaces: [
          { id: 'x', kind: 'local', name: 'ok', repos: [{ name: 'r' }, { bad: true }] },
          { id: 'y', kind: 'nope', name: 'bad kind' },
          { id: 'x', kind: 'local', name: 'duplicate id' },
        ],
      }),
    );
    const list = make().list();
    expect(corrupt).toEqual([]);
    expect(list.map((w) => w.name)).toEqual(['ok']);
    expect(list[0]!.repos.map((r) => r.name)).toEqual(['r']);
  });

  it('reloads when the profile changes', () => {
    const s = make();
    s.create({ kind: 'local', name: 'p1' });
    profile = path.join(dir, 'profiles', 'other');
    expect(s.list()).toEqual([]);
    s.create({ kind: 'local', name: 'p2' });
    profile = path.join(dir, 'profiles', 'default');
    expect(s.list().map((w) => w.name)).toEqual(['p1']);
  });

  it('imports workspaces with fresh ids', () => {
    const s = make();
    const w = s.create({ kind: 'local', name: 'w', repos: [{ localPath: path.join(dir, 'a') }] });
    const [copy] = s.importWorkspaces([w]);
    expect(copy!.id).not.toBe(w.id);
    expect(copy!.repos[0]!.id).not.toBe(w.repos[0]!.id);
    expect(s.list()).toHaveLength(2);
  });
});
