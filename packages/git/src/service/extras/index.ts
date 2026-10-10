/** Phase 3 read APIs: blame, worktrees, submodules, Git LFS (spec 02 §6.10–6.11, spec 09 §6.8–6.10). */
export { blameFile, isUncommittedSha, parseBlamePorcelain, type BlameOptions } from './blame';
export { unquoteCPath } from './cquote';
export {
  lfsAvailable,
  lfsStatus,
  parseGitattributesLfs,
  parseLfsLocksJson,
  parseLfsTrackOutput,
  type LfsLock,
  type LfsTracked,
} from './lfs';
export {
  listSubmodules,
  parseGitmodulesConfig,
  parseSubmoduleStatus,
  type DeclaredSubmodule,
  type SubmoduleStatusLine,
} from './submodules';
export { listWorktrees, parseWorktreeList } from './worktrees';
