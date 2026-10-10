import type { OpRegistry } from '../queue';
import { branchOps } from './branch';
import { checkoutOps } from './checkout';
import { commitOps } from './commit';
import { composeOps } from './compose';
import { conflictOps } from './conflict';
import { fileOps } from './file';
import { gitflowOps } from './gitflow';
import { prOps } from './pr';
import { mergeOps } from './merge';
import { patchApplyOps } from './patch-apply';
import { rebaseOps } from './rebase';
import { revertHunkOps } from './revert-hunk';
import { remoteOps } from './remote';
import { resetOps } from './reset';
import { sequencerOps } from './sequencer';
import { stagingOps } from './staging';
import { stashOps } from './stash';
import { syncOps } from './sync';
import { tagOps } from './tag';
import { squashOps } from './squash';
import { stashExtrasOps } from './stash-extras';
import { resetBranchOps } from './reset-branch';
import { remoteBranchOps } from './remote-branch';
import { sparseOps } from './sparse';
import { configOps } from './config';
import { maintenanceOps } from './maintenance';

export { validateBranchName } from './branch';
export { checkoutPreflight, type CheckoutOutcome } from './checkout';
export {
  buildCommitMessage,
  headMessage,
  HOOK_OUTPUT_PHASE,
  GITHAPPENS_TEMPLATE,
  readCommitTemplate,
  splitMessage,
} from './commit';
export {
  composeHash,
  composePatch,
  composeUnits,
  readComposeDiff,
  type ComposeDiff,
  type ComposeOutcome,
  type ComposeUnit,
} from './compose';
export {
  allChangesSelected,
  buildHunks,
  buildLinePatch,
  buildNewFilePatch,
  discardInContent,
  patchHeader,
  selectHunk,
  selectLines,
  type LinePatch,
  type PatchMode,
} from './patch';
export { type GitflowFinishOutcome, type GitflowStartOutcome } from './gitflow';
export { type MergeOutcome } from './merge';
export { buildTodo, type RebaseOutcome } from './rebase';
export { type SequencerOutcome } from './sequencer';
export {
  fetchSummary,
  hookInfo,
  ignoredHookHints,
  KNOWN_HOOKS,
  parseFetchPorcelain,
  parseFetchStderr,
  parsePorcelainPush,
  parsePrUrlHint,
  parseRemoteMessages,
  pushPreview,
  type HookInfo,
  type PushPreview,
  type PushPreviewOptions,
  type PushPreviewRequest,
} from './sync';
export { STALE_DIFF_MESSAGE } from './util';
export { commitGraphWriteArgs, removeCommitGraphLeftovers } from './maintenance';
export { checkIgnored, parseEolWarnings, type EolWarning } from './staging';
export { buildRevertPatch } from './revert-hunk';
export { planSquash, type SquashOutcome, type SquashPlan } from './squash';
/** Topological order of a commit selection (multi-commit patch / cherry-pick order, spec 05 §6.9). */
export { topoSort } from '../../service/phase3/history';
export { renamedStashSubject } from './stash-extras';
export { sparseState, type SparseState } from './sparse';
export {
  detachedOrphans,
  reflogFallback,
  refRelation,
  squashMessage,
  type ReflogFallback,
  type RefRelation,
} from './reset-branch';

/**
 * Executors for every GitOperation variant except `undo.run` / `redo.run` (provided by the undo
 * journal). Specs 05, 06 and 09.
 */
export function createOpRegistry(): OpRegistry {
  return {
    ...stagingOps,
    ...commitOps,
    ...branchOps,
    ...checkoutOps,
    ...tagOps,
    ...stashOps,
    ...syncOps,
    ...remoteOps,
    // Phase 3: history rewriting + conflict resolution (specs 05, 08)
    ...mergeOps,
    ...rebaseOps,
    ...sequencerOps,
    ...resetOps,
    ...conflictOps,
    ...fileOps,
    // Phase 7: diff viewer revert hunk (spec 07 §6.6)
    ...revertHunkOps,
    // Phase 4: pull requests (spec 10 §6.3)
    ...prOps,
    // Phase 5: AI Commit Composer (spec 12 §6.6)
    ...composeOps,
    // Phase 5: Git Flow (spec 05 §6.12, spec 12 §6.9)
    ...gitflowOps,
    // Phase 6: Cloud Patches (spec 14 §6.3)
    ...patchApplyOps,
    // Phase 8: branching & operations gaps (spec 05)
    ...squashOps,
    ...stashExtrasOps,
    ...resetBranchOps,
    ...remoteBranchOps,
    // Phase 9: sparse checkout management (spec 03)
    ...sparseOps,
    // Phase 10: queued config writes (spec 02 §6.11)
    ...configOps,
    // Phase 11: cancellable background commit-graph write (spec 02 §6.15.1)
    ...maintenanceOps,
  };
}
