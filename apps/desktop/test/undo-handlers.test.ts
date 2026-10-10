import fs from 'node:fs';
import path from 'node:path';

import { createOpRegistry, OperationQueue, UndoJournal, type GitOperation } from '@githappens/git';
import { describe, expect, it } from 'vitest';

import { createUndoHandlers, undoChangedEvent } from '../src/main/ipc/undo-handlers';
import { UNDO_EVENT_CHANNELS, UNDO_INVOKE_CHANNELS } from '../src/shared/ipc/undo-contract';
import { gitPath, useTestRepos, type TestRepo } from './ai-test-repo';

const d = gitPath ? describe : describe.skip;
const ctx = {} as never;

describe('undo contract', () => {
  it('lists every channel', () => {
    expect([...UNDO_INVOKE_CHANNELS].sort()).toEqual(
      [
        'undo:list',
        'undo:reflog',
        'branching:relation',
        'branching:orphans',
        'branching:squashMsg',
        'branching:savePatch',
      ].sort(),
    );
    expect(UNDO_EVENT_CHANNELS).toEqual(['undo:changed']);
  });

  it('maps a journal peek to the undo:changed payload', () => {
    expect(
      undoChangedEvent('r1', {
        undo: { id: 'a', label: 'Commit x', kind: 'commit', ts: 1 },
        blockedBy: undefined,
      }),
    ).toEqual({ repoId: 'r1', canUndo: true, canRedo: false, undoLabel: 'Commit x' });
    expect(undoChangedEvent('r1', { blockedBy: 'Cannot undo past Push' })).toEqual({
      repoId: 'r1',
      canUndo: false,
      canRedo: false,
      blockedBy: 'Cannot undo past Push',
    });
  });
});

d('undo / branching handlers (real git)', () => {
  const repos = useTestRepos('undoh');

  async function setup(): Promise<{
    r: TestRepo;
    journal: UndoJournal;
    run: (op: GitOperation) => Promise<unknown>;
    h: ReturnType<typeof createUndoHandlers>;
    saved: string[];
    changes: unknown[];
  }> {
    const r = await repos.make({ 'a.txt': 'a\n' });
    const changes: unknown[] = [];
    const journal = new UndoJournal({
      service: r.svc,
      onChange: (p) => changes.push(undoChangedEvent('x', p)),
    });
    const registry = createOpRegistry();
    const run = (op: GitOperation) => new OperationQueue(r.svc, registry, { journal }).enqueue(op).done;
    const saved: string[] = [];
    const h = createUndoHandlers({
      repos: { get: () => r.svc, journal: () => journal },
      saveDialog: async ({ defaultName }) => {
        const p = path.join(r.dir, '..', `${path.basename(r.dir)}-${defaultName}`);
        saved.push(p);
        return p;
      },
    });
    return { r, journal, run, h, saved, changes };
  }

  it('undo:list returns newest first with status, and undo:changed fires on every change', async () => {
    const { r, journal, run, h, changes } = await setup();
    await run({ type: 'branch.create', name: 'one', startPoint: 'HEAD', checkout: false });
    await run({ type: 'tag.create', name: 'v1', target: r.git('rev-parse', 'HEAD').trim() });
    await journal.undo();
    const list = await h['undo:list']({ repoId: 'x', limit: 5 }, ctx);
    expect(list.map((e) => [e.kind, e.status])).toEqual([
      ['tag-create', 'undone'],
      ['branch-create', 'done'],
    ]);
    expect(list.every((e) => e.undoable)).toBe(true);
    expect(changes.length).toBeGreaterThanOrEqual(3);
    expect(changes.at(-1)).toMatchObject({ canUndo: true, canRedo: true, redoLabel: 'Create tag v1' });
  });

  it('undo:reflog offers the previous branch position; branching:relation / orphans / squashMsg', async () => {
    const { r, h } = await setup();
    expect(await h['undo:reflog']({ repoId: 'x' }, ctx)).toBeNull();
    const first = r.git('rev-parse', 'HEAD').trim();
    r.write('b.txt', 'b\n');
    r.git('add', '-A');
    r.git('commit', '-q', '-m', 'Second');
    expect(await h['undo:reflog']({ repoId: 'x' }, ctx)).toMatchObject({ selector: 'main@{1}', sha: first });

    r.git('switch', '-q', '--orphan', 'island');
    r.write('i.txt', 'i\n');
    r.git('add', '-A');
    r.git('commit', '-q', '-m', 'Island');
    r.git('switch', '-q', 'main');
    expect(await h['branching:relation']({ repoId: 'x', a: 'main', b: 'island' }, ctx)).toEqual({
      mergeBase: false,
      shallow: false,
    });
    await expect(
      Promise.resolve().then(() => h['branching:relation']({ repoId: 'x', a: '--all', b: 'main' }, ctx)),
    ).rejects.toThrow(/Invalid/);
    expect(await h['branching:orphans']({ repoId: 'x' }, ctx)).toEqual({ count: 0, sha: null });

    expect(await h['branching:squashMsg']({ repoId: 'x' }, ctx)).toBeNull();
    r.git('merge', '-q', '--squash', '--allow-unrelated-histories', 'island');
    expect(await h['branching:squashMsg']({ repoId: 'x' }, ctx)).toMatch(/Island/);
  });

  it('branching:savePatch writes one mbox, oldest first', async () => {
    const { r, h, saved } = await setup();
    const shas: string[] = [];
    for (const n of ['one', 'two']) {
      r.write(`${n}.txt`, `${n}\n`);
      r.git('add', '-A');
      r.git('commit', '-q', '-m', `Add ${n}`);
      shas.push(r.git('rev-parse', 'HEAD').trim());
    }
    const res = await h['branching:savePatch']({ repoId: 'x', shas: [...shas].reverse() }, ctx);
    expect(res.saved).toBe(true);
    const text = fs.readFileSync(saved[0]!, 'utf8');
    expect(text.indexOf('Subject: [PATCH] Add one')).toBeGreaterThan(-1);
    expect(text.indexOf('Add one')).toBeLessThan(text.indexOf('Add two'));
  });
});
