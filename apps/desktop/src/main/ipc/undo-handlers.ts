import fs from 'node:fs';

import {
  detachedOrphans,
  reflogFallback,
  refRelation,
  squashMessage,
  topoSort,
  type GitService,
  type RepoId,
  type UndoJournal,
  type UndoPeek,
} from '@githappens/git';

import type { UndoChangedEvent, UndoIpcContract, UndoListItem } from '../../shared/ipc/undo-contract';
import type { HandlerContext } from './registry';

export type UndoHandlers = {
  [C in keyof UndoIpcContract]: (
    req: UndoIpcContract[C]['req'],
    ctx: HandlerContext,
  ) => UndoIpcContract[C]['res'] | Promise<UndoIpcContract[C]['res']>;
};

export interface UndoHandlerDeps {
  repos: { get(repoId: RepoId): GitService; journal(repoId: RepoId): UndoJournal };
  /** Native save dialog (patch files); resolves null when cancelled. */
  saveDialog(o: { title: string; defaultName: string }): Promise<string | null>;
}

const MAX_LIST = 200;

function rev(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v || v.startsWith('-') || /[\0\r\n]/.test(v))
    throw new Error(`Invalid ${name}`);
  return v;
}

/** `undo:changed` payload from the journal's peek (spec 05 §5). */
export function undoChangedEvent(repoId: RepoId, peek: UndoPeek): UndoChangedEvent {
  return {
    repoId,
    canUndo: !!peek.undo,
    canRedo: !!peek.redo,
    ...(peek.undo ? { undoLabel: peek.undo.label } : {}),
    ...(peek.redo ? { redoLabel: peek.redo.label } : {}),
    ...(peek.blockedBy ? { blockedBy: peek.blockedBy } : {}),
  };
}

/** Undo history + branching read channels (spec 05 §4.7, §5; Phase 8). */
export function createUndoHandlers(deps: UndoHandlerDeps): UndoHandlers {
  const svc = (id: RepoId): GitService => deps.repos.get(id);
  return {
    'undo:list': ({ repoId, limit }) => {
      const n = typeof limit === 'number' && limit > 0 ? Math.min(limit, MAX_LIST) : 20;
      return deps.repos
        .journal(repoId)
        .list()
        .filter((e) => e.status === 'done' || e.status === 'undone')
        .slice(0, n)
        .map((e): UndoListItem => ({
          id: e.id,
          kind: e.kind,
          label: e.label,
          ts: e.ts,
          status: e.status as 'done' | 'undone',
          undoable: e.undoable,
        }));
    },
    'undo:reflog': ({ repoId }) => reflogFallback(svc(repoId)),
    'branching:relation': ({ repoId, a, b }) => refRelation(svc(repoId), rev(a, 'a'), rev(b, 'b')),
    'branching:orphans': ({ repoId }) => detachedOrphans(svc(repoId)),
    'branching:squashMsg': ({ repoId }) => squashMessage(svc(repoId)),
    'branching:savePatch': async ({ repoId, shas }) => {
      if (!Array.isArray(shas) || !shas.length) throw new Error('Invalid shas');
      const s = svc(repoId);
      const order = await topoSort(
        s,
        shas.map((x) => rev(x, 'sha')),
      );
      // one mbox with every commit, oldest first (`git am` applies it in order)
      let text = '';
      for (const sha of order) {
        const r = await s.runRead(['format-patch', '-1', '--stdout', '--binary', sha, '--']);
        text += r.stdout;
      }
      const target = await deps.saveDialog({
        title: 'Save patch',
        defaultName: `${order.length}-commits-${order[0]!.slice(0, 7)}.patch`,
      });
      if (!target) return { saved: false };
      await fs.promises.writeFile(target, text, 'utf8');
      return { saved: true, path: target };
    },
  };
}
