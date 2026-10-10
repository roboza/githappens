import path from 'node:path';

import type { RepoId } from '@githappens/git/types';

import { AvatarService, type FetchLike } from '../avatars/avatar-service';
import { createGraphHandlers, type GraphHandlers } from '../ipc/graph-handlers';
import { CommitGraphMaintainer, type MaintainedRepo } from './commit-graph-maintenance';
import { RepoUiStore } from './repo-ui-store';

export { CommitGraphMaintainer } from './commit-graph-maintenance';
export { RepoUiStore } from './repo-ui-store';

export interface GraphServicesDeps {
  userDataDir: string;
  /** `settings.get` for `ui.useGravatar` / `graph.maintainCommitGraph`. */
  setting: (key: 'ui.useGravatar' | 'graph.maintainCommitGraph') => boolean;
  /** Subscribe to settings changes; returns an unsubscribe function. */
  onSettingChanged?: (cb: (key: string) => void) => () => void;
  /** Open repo by id → its RepoInfo-like paths. */
  repoInfo: (repoId: RepoId) => { worktreeRoot: string | null; gitDir: string; commonDir: string };
  /** git at background priority in `cwd` → stdout. */
  runGit: (cwd: string, args: string[]) => Promise<string>;
  /**
   * Runs a background op through the repository's queue (`RepoManager.runOp(id, op, true)`): the
   * commit-graph write becomes a cancellable `maintenance.commitGraph` op (spec 02 §6.15.1).
   */
  runBackgroundOp?: (repoId: RepoId, op: { type: 'maintenance.commitGraph' }) => Promise<unknown>;
  /** Connected integrations (`IntegrationService.list()`), for provider avatar lookups. */
  providerHosts?: () => Array<{ kind: string; host: string }>;
  fetch?: FetchLike;
  log?: (message: string, err?: unknown) => void;
}

/** Everything spec 04's graph needs in main: avatars, per-repo UI state, commit-graph maintenance. */
export function createGraphServices(d: GraphServicesDeps): {
  avatars: AvatarService;
  repoUi: RepoUiStore;
  commitGraph: CommitGraphMaintainer;
  handlers: GraphHandlers;
  /** Feed every `git:op:state` event (refreshes the commit-graph after fetch / pull / rebase …). */
  onOpState: (repoId: RepoId, e: { type: string; state: string }) => void;
  dispose: () => void;
} {
  const avatars = new AvatarService({
    dir: path.join(d.userDataDir, 'avatars'),
    fetch: d.fetch ?? ((url, init) => fetch(url, { ...init, redirect: 'follow' })),
    useGravatar: () => d.setting('ui.useGravatar'),
    providerHosts: d.providerHosts,
    log: d.log,
  });
  const repoUi = new RepoUiStore(() => path.join(d.userDataDir, 'repos'), d.log);
  const commitGraph = new CommitGraphMaintainer({
    enabled: () => d.setting('graph.maintainCommitGraph'),
    run: d.runGit,
    write: d.runBackgroundOp
      ? async (r) => {
          await d.runBackgroundOp!(r.repoId!, { type: 'maintenance.commitGraph' });
        }
      : undefined,
    log: d.log,
  });
  const repo = (repoId: RepoId): MaintainedRepo => {
    const info = d.repoInfo(repoId);
    return { cwd: info.worktreeRoot ?? info.gitDir, commonDir: info.commonDir, repoId };
  };
  const unsubscribe = d.onSettingChanged?.((key) => {
    if (key === 'ui.useGravatar') avatars.invalidateMisses();
  });
  return {
    avatars,
    repoUi,
    commitGraph,
    handlers: createGraphHandlers({ avatars, repoUi, repo, commitGraph, runGit: d.runGit }),
    onOpState: (repoId, e) => {
      try {
        commitGraph.onOpState(repo(repoId), e);
      } catch {
        /* repo closed meanwhile */
      }
    },
    dispose: () => {
      unsubscribe?.();
      avatars.dispose();
    },
  };
}
