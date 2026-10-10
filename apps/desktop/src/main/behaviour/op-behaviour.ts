import {
  changedSubmodulePaths,
  deleteOrigBackups,
  GitError,
  hasGitmodules,
  resolvedPaths,
  SUBMODULE_UPDATE_OPS,
  type GitOperation,
  type GitService,
  type OpResult,
  type RepoId,
} from '@githappens/git';

import type { SettingKey, SettingValue } from '../../shared/settings/registry';

type Settings = <K extends SettingKey>(key: K) => SettingValue<K>;

export interface OpBehaviourDeps {
  settings: Settings;
  /** Queue a follow-up op in the same repo (RepoManager.runOp). */
  runOp: (repoId: RepoId, op: GitOperation, background?: boolean) => Promise<OpResult>;
  log?: (message: string, err?: unknown) => void;
}

/** State carried from `prepare` to `after` for one op. */
export interface OpBehaviourState {
  headBefore?: string | null;
}

/**
 * Settings-driven op behaviour (Phase 7, spec 13 General/Git, spec 09, spec 05):
 * - `git.pushFollowTags` → `push.followTags`, `git.pullRebaseMerges` → `pull.rebaseMerges`
 * - `general.autoUpdateSubmodules` → `submodule update --init --recursive -- <changed gitlinks>` after
 *   checkout / pull / merge / rebase / reset (spec 09 §6.9)
 * - `checkout.autoPopStash` → pop the stash a "Stash & checkout" created (spec 05 §4.5)
 * - `general.deleteOrigFiles` → delete untracked `<file>.orig` once a conflict is resolved
 * Called by RepoManager.runOp around every op; failures here never fail the user's op.
 */
export class OpBehaviour {
  constructor(private readonly d: OpBehaviourDeps) {}

  async prepare(
    service: GitService,
    op: GitOperation,
  ): Promise<{ op: GitOperation; state: OpBehaviourState }> {
    const s = this.d.settings;
    const state: OpBehaviourState = {};
    let next = op;
    if (op.type === 'push' && op.followTags === undefined && s('git.pushFollowTags')) {
      next = { ...op, followTags: true };
    }
    if (
      op.type === 'pull' &&
      op.strategy === 'rebase' &&
      op.rebaseMerges === undefined &&
      s('git.pullRebaseMerges')
    ) {
      next = { ...op, rebaseMerges: true };
    }
    if (SUBMODULE_UPDATE_OPS.has(op.type) && s('general.autoUpdateSubmodules') && hasGitmodules(service)) {
      state.headBefore = await service.revParse('HEAD').catch(() => null);
    }
    return { op: next, state };
  }

  async after(
    repoId: RepoId,
    service: GitService,
    op: GitOperation,
    result: OpResult,
    state: OpBehaviourState,
  ): Promise<OpResult> {
    let r = result;
    try {
      r = await this.autoPopStash(repoId, service, op, r);
    } catch (e) {
      this.d.log?.('[behaviour] auto-pop stash failed', e);
    }
    try {
      r = await this.updateSubmodules(repoId, service, op, r, state);
    } catch (e) {
      this.d.log?.('[behaviour] submodule update failed', e);
    }
    try {
      await this.deleteOrig(service, op);
    } catch (e) {
      this.d.log?.('[behaviour] .orig clean-up failed', e);
    }
    return r;
  }

  private async autoPopStash(
    repoId: RepoId,
    service: GitService,
    op: GitOperation,
    r: OpResult,
  ): Promise<OpResult> {
    if (op.type !== 'checkout.run' || !this.d.settings('checkout.autoPopStash')) return r;
    const data = r.data as { stashSha?: string } | undefined;
    if (!data?.stashSha) return r;
    const list = await service.stashList();
    const entry = list.find((x) => x.sha === data.stashSha);
    if (!entry) return r;
    try {
      await this.d.runOp(repoId, { type: 'stash.pop', index: entry.index, sha: entry.sha });
      return { ...r, data: { ...data, stashPopped: true } };
    } catch (e) {
      const why = e instanceof GitError ? e.message : String(e);
      return {
        ...r,
        data: { ...data, stashPopped: false },
        warnings: [
          ...(r.warnings ?? []),
          `Your stashed changes could not be re-applied automatically (${why}). They are kept in the stash.`,
        ],
      };
    }
  }

  private async updateSubmodules(
    repoId: RepoId,
    service: GitService,
    op: GitOperation,
    r: OpResult,
    state: OpBehaviourState,
  ): Promise<OpResult> {
    if (state.headBefore === undefined || !SUBMODULE_UPDATE_OPS.has(op.type)) return r;
    if (!this.d.settings('general.autoUpdateSubmodules')) return r;
    const after = await service.revParse('HEAD');
    if (!after || after === state.headBefore) return r;
    const paths = await changedSubmodulePaths(service, state.headBefore ?? null, after);
    if (!paths.length) return r;
    try {
      await this.d.runOp(repoId, { type: 'submodule.update', paths, init: true, recursive: true });
      return { ...r, summary: r.summary ? `${r.summary}; updated submodules` : 'Updated submodules' };
    } catch (e) {
      const why = e instanceof GitError ? e.message : String(e);
      return { ...r, warnings: [...(r.warnings ?? []), `Submodules were not updated: ${why}`] };
    }
  }

  private async deleteOrig(service: GitService, op: GitOperation): Promise<void> {
    if (!this.d.settings('general.deleteOrigFiles')) return;
    const paths = resolvedPaths(op as GitOperation & Record<string, unknown>);
    if (paths.length) await deleteOrigBackups(service, paths);
  }
}
