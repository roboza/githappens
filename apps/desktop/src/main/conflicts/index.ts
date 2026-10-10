import type { RefreshScope, RepoId } from '@githappens/git';

import type { ConflictsEventContract } from '../../shared/ipc/conflicts-contract';
import type { CloudHttp } from '../cloud/cloud-http';
import { TeamService } from '../cloud/team/team-service';
import { ConflictService, type RepoAccess, type SettingsLike } from './conflict-service';
import { createPrBaseLookup, type PrSource } from './pr-base';

export { ConflictService } from './conflict-service';
export { TeamService } from '../cloud/team/team-service';

/** Everything main/index.ts passes in (spec 14 §6.5 Conflict Prevention + team footprints). */
export interface ConflictsDeps {
  /** RepoManager (`get`, `list`). */
  repos: RepoAccess;
  /** IntegrationService (`prIndex`, `listPullRequests`) for PR-base targets. */
  integrations: PrSource;
  /** GitHappens Cloud client; only used when footprints are active. */
  cloud: CloudHttp;
  /** SettingsStore (`conflicts.detectTarget`, `conflicts.includeWip`, `team.footprints`). */
  settings: SettingsLike;
  /** Broadcast to every window (`conflicts:updated`). */
  emit<E extends keyof ConflictsEventContract>(event: E, payload: ConflictsEventContract[E]): void;
  log?: (msg: string, err?: unknown) => void;
}

export interface ConflictServices {
  conflicts: ConflictService;
  team: TeamService;
  /** Forward every `RepoManager` `onChanged(repoId, scopes, reason)` here. */
  onRepoChanged(repoId: RepoId, scopes: RefreshScope[], reason: string): void;
  /** Call when a repo is closed (drops timers and cached state). */
  onRepoClosed(repoId: RepoId): void;
  dispose(): void;
}

export function createConflictServices(deps: ConflictsDeps): ConflictServices {
  const prBase = createPrBaseLookup(deps.integrations);
  let conflicts: ConflictService | null = null;
  const team = new TeamService({
    repos: deps.repos,
    cloud: deps.cloud,
    footprintsEnabled: () => deps.settings.get('team.footprints'),
    targetFor: (repoId, branch) => conflicts!.branchTarget(repoId, branch),
    onOverlapsChanged: (repoId) => void conflicts?.refreshOverlaps(repoId).catch(() => undefined),
    log: deps.log,
  });
  conflicts = new ConflictService({
    repos: deps.repos,
    settings: deps.settings,
    emit: deps.emit,
    prBase,
    team,
    log: deps.log,
  });
  team.start();
  const svc = conflicts;
  return {
    conflicts: svc,
    team,
    onRepoChanged: (repoId, scopes, reason) => {
      try {
        team.onRepoChanged(repoId, scopes);
        svc.onRepoChanged(repoId, scopes, reason);
      } catch (e) {
        deps.log?.('[conflicts] change handler failed', e);
      }
    },
    onRepoClosed: (repoId) => {
      svc.forget(repoId);
      team.forget(repoId);
    },
    dispose: () => {
      svc.dispose();
      team.dispose();
    },
  };
}
