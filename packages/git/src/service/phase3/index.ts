/**
 * Phase 3 reads: in-progress operation / conflict state, conflict file contents, conflict prediction,
 * interactive-rebase todo, ancestry and the external merge tool (specs 05 and 08).
 */
export { conflictState, countMarkerBlocks, resolvedPendingPaths } from './state';
export { loadConflictFile } from './load';
export { isAncestor, predictConflicts, rebaseTodoFor } from './history';
export {
  openExternalMergeTool,
  openExternalMergeToolArgv,
  splitCommandTemplate,
  substituteVars,
  type ExternalMergeOptions,
  type ExternalMergeResult,
  type MergeToolVars,
} from './external';
