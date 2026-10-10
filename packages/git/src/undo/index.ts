export { UndoJournal, type UndoJournalOptions } from './journal';
export { createUndoOps, type UndoRunOutcome } from './ops';
export { PIN_NAMESPACE } from './git';
export { planFor, barrierFor } from './plan';
export type {
  JournalEntry,
  JournalKind,
  RepoSnapshot,
  SnapshotHead,
  SnapshotScope,
  StashListEntry,
} from './types';
