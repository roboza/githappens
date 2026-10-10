import type { OpDefinition } from '../ops/queue';
import type { OperationMeta } from '../ops/types';
import type { UndoJournal } from './journal';

export interface UndoRunOutcome {
  entryId: string;
  kind: string;
  label: string;
}

const meta = (label: (j: UndoJournal) => string, journal: UndoJournal): OperationMeta => ({
  label: () => label(journal),
  mutating: true,
  network: false,
  cancellable: false,
  touches: ['refs', 'graph', 'status', 'stash'],
  // undo/redo never create journal entries themselves
  undoable: false,
  exclusive: 'repo',
});

/** `undo.run` / `redo.run` executors bound to one repo's journal (spec 05 §5 IPC `undo:run` / `redo:run`). */
export function createUndoOps(journal: UndoJournal): {
  'undo.run': OpDefinition<'undo.run'>;
  'redo.run': OpDefinition<'redo.run'>;
} {
  return {
    'undo.run': {
      meta: meta((j) => {
        const u = j.peek().undo;
        return u ? `Undo ${u.label}` : 'Undo';
      }, journal),
      execute: async () => {
        const e = await journal.undo();
        const data: UndoRunOutcome = { entryId: e.id, kind: e.kind, label: e.label };
        return { summary: `Undid ${e.label}`, data };
      },
    },
    'redo.run': {
      meta: meta((j) => {
        const r = j.peek().redo;
        return r ? `Redo ${r.label}` : 'Redo';
      }, journal),
      execute: async () => {
        const e = await journal.redo();
        const data: UndoRunOutcome = { entryId: e.id, kind: e.kind, label: e.label };
        return { summary: `Redid ${e.label}`, data };
      },
    },
  };
}
