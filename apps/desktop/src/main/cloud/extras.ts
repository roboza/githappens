import path from 'node:path';

import type { ConnectedIntegration } from '@githappens/providers';

import type { CloudWorkspacesEventContract } from '../../shared/ipc/cloud-workspaces-contract';
import type { InsightsEventContract } from '../../shared/ipc/insights-contract';
import type { SuggestEventContract } from '../../shared/ipc/suggest-contract';
import type { SettingKey, SettingValue } from '../../shared/settings/registry';
import type { CloudHttp } from './cloud-http';
import { InsightsService } from './insights';
import type { PatchService } from './patches/patch-service';
import { SuggestService, type SuggestServiceDeps } from './suggest';
import type { LaunchpadLike } from './sync/adapters';
import { CloudWorkspaceService, LaunchpadStateSync, type CloudWorkspaceHost } from './workspaces';

type ExtrasEvents = SuggestEventContract & InsightsEventContract & CloudWorkspacesEventContract;

/** What `main/index.ts` passes to {@link createCloudExtras} (spec 14 Code Suggest, Insights, cloud workspaces). */
export interface CloudExtrasDeps {
  cloud: CloudHttp;
  patches: PatchService;
  /** RepoManager: get / list / runOp plus open / close by path (suggest worktrees). */
  repos: SuggestServiceDeps['repos'];
  /** IntegrationService (provider per account key, resolved remotes, connected accounts). */
  integrations: SuggestServiceDeps['integrations'] & { list(): ConnectedIntegration[] };
  /** WorkspaceService (spec 11). */
  workspaces: CloudWorkspaceHost;
  launchpad: LaunchpadLike;
  settings: {
    get<K extends SettingKey>(key: K): SettingValue<K>;
    on(event: 'changed', listener: (c: { key: string }) => void): unknown;
    off(event: 'changed', listener: (c: { key: string }) => void): unknown;
  };
  /** Known local repositories with remote URLs (locate clones when opening a shared workspace). */
  knownRepos?(): Promise<Array<{ path: string; remotes: string[] }>>;
  /** Read-only git in a directory (Insights tag deployments). */
  runGit(cwd: string, args: string[]): Promise<string>;
  userDataDir: string;
  profileDir(): string;
  broadcast<E extends keyof ExtrasEvents>(event: E, payload: ExtrasEvents[E]): void;
  log?(message: string): void;
}

export interface CloudExtras {
  suggest: SuggestService;
  insights: InsightsService;
  workspaces: CloudWorkspaceService;
  launchpadState: LaunchpadStateSync;
  start(): void;
  dispose(): void;
}

export function createCloudExtras(d: CloudExtrasDeps): CloudExtras {
  const suggest = new SuggestService({
    cloud: d.cloud,
    patches: d.patches,
    repos: d.repos,
    integrations: d.integrations,
    userDataDir: () => d.userDataDir,
    onChanged: (e) => d.broadcast('suggest:changed', e),
    ...(d.log ? { log: d.log } : {}),
  });
  const insights = new InsightsService({
    workspaces: d.workspaces,
    integrations: d.integrations,
    runGit: d.runGit,
    cacheDir: () => path.join(d.userDataDir, 'cache', 'insights'),
    defaultDeploy: () => {
      const kind = d.settings.get('insights.deploySignal');
      if (kind === 'tags') return { kind, pattern: d.settings.get('insights.deployTagPattern') || '*' };
      if (kind === 'github-deployments')
        return { kind, environment: d.settings.get('insights.deployEnvironment') || 'production' };
      return { kind: 'none' };
    },
    emit: (event, payload) => d.broadcast(event, payload),
    ...(d.log ? { log: d.log } : {}),
  });
  const workspaces = new CloudWorkspaceService({
    cloud: d.cloud,
    workspaces: d.workspaces,
    integrations: () => d.integrations.list().map((i) => ({ key: i.key, kind: i.kind, host: i.host })),
    ...(d.knownRepos ? { knownRepos: d.knownRepos } : {}),
    profileDir: d.profileDir,
    onChanged: (e) => d.broadcast('cloudWorkspace:changed', e),
  });
  const launchpadState = new LaunchpadStateSync({
    cloud: d.cloud,
    launchpad: d.launchpad,
    enabled: () => d.settings.get('cloud.launchpadState'),
    e2eCovers: () => d.settings.get('sync.enabled') && d.settings.get('sync.launchpad'),
    profileDir: d.profileDir,
    onStatus: (s) => d.broadcast('launchpadState:statusChanged', s),
  });
  const onSetting = (c: { key: string }): void => {
    if (c.key === 'cloud.launchpadState' || c.key === 'sync.enabled' || c.key === 'sync.launchpad')
      launchpadState.refresh();
  };
  let unsubSession: (() => void) | null = null;
  return {
    suggest,
    insights,
    workspaces,
    launchpadState,
    start() {
      d.settings.on('changed', onSetting);
      unsubSession = d.cloud.onSessionChange(() => {
        launchpadState.refresh();
        d.broadcast('cloudWorkspace:changed', { reason: 'session' });
      });
      launchpadState.start();
    },
    dispose() {
      d.settings.off('changed', onSetting);
      unsubSession?.();
      launchpadState.dispose();
    },
  };
}
