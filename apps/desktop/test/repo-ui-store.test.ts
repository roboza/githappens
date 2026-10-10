import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createGraphHandlers } from '../src/main/ipc/graph-handlers';
import { DEFAULT_REPO_UI, repoKey, RepoUiStore, sanitizeRepoUi } from '../src/main/repo-ui/repo-ui-store';
import { GRAPH_INVOKE_CHANNELS } from '../src/shared/ipc/graph-contract';

describe('per-repo graph UI state (repoUi:get / repoUi:save)', () => {
  let dir: string;
  beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-repoui-'))));
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('derives a stable, readable key per repository', () => {
    expect(repoKey('C:\\Repos\\App\\.git', 'win32')).toBe(repoKey('c:\\repos\\app\\.git\\', 'win32'));
    expect(repoKey('/home/me/App/.git', 'linux')).not.toBe(repoKey('/home/me/app/.git', 'linux'));
    expect(repoKey('/home/me/App/.git', 'linux')).toMatch(/^[0-9a-f]{16}-App$/);
  });

  it('defaults, merges patches, persists to userData/repos/<key>/graph.json and survives a restart', () => {
    const store = new RepoUiStore(() => dir);
    const repo = path.join(dir, 'work', 'proj', '.git');
    expect(store.get(repo)).toEqual(DEFAULT_REPO_UI);
    store.save(repo, { hiddenRefs: ['refs/heads/old', 'refs/remotes/upstream/*'] });
    const s = store.save(repo, {
      soloRefs: ['refs/heads/feature'],
      columns: {
        order: ['graph', 'refs', 'message'],
        widths: { refs: 200, graph: 5 },
        visible: { sha: true },
      },
    });
    expect(s.hiddenRefs).toEqual(['refs/heads/old', 'refs/remotes/upstream/*']);
    expect(s.columns!.order).toEqual(['graph', 'refs', 'message', 'author', 'date', 'sha']);
    expect(s.columns!.widths).toEqual({ refs: 200, graph: 24 });
    expect(s.columns!.visible).toEqual({ sha: true, message: true });

    const file = store.fileFor(repo);
    expect(file.startsWith(path.join(dir, repoKey(repo)))).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).version).toBe(1);
    const reopened = new RepoUiStore(() => dir).get(repo);
    expect(reopened).toEqual(s);
    // other repositories are independent
    expect(new RepoUiStore(() => dir).get(path.join(dir, 'other', '.git'))).toEqual(DEFAULT_REPO_UI);
  });

  it('sanitizes untrusted input and tolerates a corrupt file', () => {
    expect(
      sanitizeRepoUi({
        hiddenRefs: ['ok', 'ok', 3, '', 'bad\nname', 'x'.repeat(2000)],
        soloRefs: 'nope',
        columns: { order: ['evil', 'sha'], widths: { sha: 'wide' }, visible: { message: false } },
        extra: 1,
      }),
    ).toEqual({
      hiddenRefs: ['ok'],
      columns: {
        order: ['sha', 'refs', 'graph', 'message', 'author', 'date'],
        widths: {},
        visible: { message: true },
      },
    });
    const store = new RepoUiStore(() => dir);
    const repo = path.join(dir, 'r', '.git');
    fs.mkdirSync(path.dirname(store.fileFor(repo)), { recursive: true });
    fs.writeFileSync(store.fileFor(repo), '{nope');
    expect(store.get(repo)).toEqual(DEFAULT_REPO_UI);
  });

  it('handlers resolve the repo, check the commit-graph on first get, and cover every channel', () => {
    const store = new RepoUiStore(() => dir);
    const opened: string[] = [];
    const h = createGraphHandlers({
      avatars: { resolve: (r) => r.items.map(() => null) },
      repoUi: store,
      repo: (id) => ({ cwd: `/w/${id}`, commonDir: path.join(dir, id, '.git') }),
      commitGraph: { onRepoOpened: (r) => opened.push(r.cwd) },
    });
    expect(Object.keys(h).sort()).toEqual([...GRAPH_INVOKE_CHANNELS].sort());
    const ctx = { senderId: 1 };
    void h['repoUi:save']({ repoId: 'a', patch: { pinnedRefs: ['refs/heads/main'] } }, ctx);
    expect(h['repoUi:get']({ repoId: 'a' }, ctx)).toMatchObject({ pinnedRefs: ['refs/heads/main'] });
    expect(h['repoUi:get']({ repoId: 'b' }, ctx)).toEqual(DEFAULT_REPO_UI);
    expect(opened).toEqual(['/w/a', '/w/b']);
    expect(h['avatar:resolve']({ items: [{ email: 'a@b.c' }] }, ctx)).toEqual([null]);
  });
});
