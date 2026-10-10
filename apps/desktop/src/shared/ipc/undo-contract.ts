import type { RepoId, Sha } from '@githappens/git/types';

/**
 * Undo history + branching read channels (spec 05 §5 "IPC channels": `undo:list`, `undo:changed`, plus the
 * Phase 8 helpers the branching UI needs). Every mutation is still a `git:op:run` variant.
 */

export interface UndoListItem {
  id: string;
  kind: string;
  label: string;
  ts: number;
  /** `done` = on the undo stack, `undone` = on the redo stack. */
  status: 'done' | 'undone';
  /** False for barriers (push / fetch / pull): undo stops there. */
  undoable: boolean;
}

/** Previous position of HEAD's branch, offered by Undo when the journal has nothing (spec 05 §4.7). */
export interface UndoReflogFallback {
  /** `main@{1}` or `HEAD@{1}` (detached). */
  selector: string;
  sha: Sha;
  /** Reflog subject of the move being reverted ("commit: Fix bug"). */
  subject: string;
  current: Sha;
}

/** Payload of `undo:changed` (spec 05 §5): pushed whenever a repo's undo/redo stacks change. */
export interface UndoChangedEvent {
  repoId: RepoId;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel?: string;
  redoLabel?: string;
  /** "Cannot undo past Push". */
  blockedBy?: string;
}

export interface UndoIpcContract {
  /** Newest first; `limit` defaults to 20 (History popover). */
  'undo:list': { req: { repoId: RepoId; limit?: number }; res: UndoListItem[] };
  'undo:reflog': { req: { repoId: RepoId }; res: UndoReflogFallback | null };
  /** Drop-matrix inputs (spec 05 §4.4): shared history + shallow clone. */
  'branching:relation': {
    req: { repoId: RepoId; a: string; b: string };
    res: { mergeBase: boolean; shallow: boolean };
  };
  /** Commits only reachable from a detached HEAD (spec 05 §8). */
  'branching:orphans': { req: { repoId: RepoId }; res: { count: number; sha: Sha | null } };
  /** `.git/SQUASH_MSG` after `merge --squash`, comment lines stripped (spec 05 §6.5). */
  'branching:squashMsg': { req: { repoId: RepoId }; res: string | null };
  /** `format-patch` of several commits (topological order) into a user-chosen file. */
  'branching:savePatch': {
    req: { repoId: RepoId; shas: Sha[] };
    res: { saved: boolean; path?: string };
  };
}

export interface UndoEventContract {
  'undo:changed': UndoChangedEvent;
}

export const UNDO_INVOKE_CHANNELS = [
  'undo:list',
  'undo:reflog',
  'branching:relation',
  'branching:orphans',
  'branching:squashMsg',
  'branching:savePatch',
] as const satisfies readonly (keyof UndoIpcContract)[];

export const UNDO_EVENT_CHANNELS = ['undo:changed'] as const satisfies readonly (keyof UndoEventContract)[];

type Exhaustive<All, Listed> = [Exclude<All, Listed>] extends [never]
  ? true
  : { missing: Exclude<All, Listed> };
const undoInvokeExhaustive: Exhaustive<keyof UndoIpcContract, (typeof UNDO_INVOKE_CHANNELS)[number]> = true;
const undoEventExhaustive: Exhaustive<keyof UndoEventContract, (typeof UNDO_EVENT_CHANNELS)[number]> = true;
void undoInvokeExhaustive;
void undoEventExhaustive;
