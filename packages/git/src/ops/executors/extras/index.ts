import type { OpRegistry } from '../../queue';
import { lfsOps } from './lfs';
import { submoduleOps } from './submodule';
import { worktreeOps } from './worktree';

export { parseLfsProgressLine, withLfsProgress, type LfsProgressLine } from './lfs-progress';
export { parsePruneOutput } from './worktree';

/** Executors for submodule.*, worktree.* and lfs.* operations (spec 09 §6.8–6.10). */
export function createExtrasRegistry(): OpRegistry {
  return { ...submoduleOps, ...worktreeOps, ...lfsOps };
}
