import path from 'node:path';

import type { CloudDeepLink, CloudEventContract } from '../../shared/ipc/cloud-contract';
import type { SecretStore } from '../secrets/secret-store';
import type { SettingsStore } from '../settings/settings-store';
import type { Workspace } from '../../shared/ipc/workspaces-contract';
import { isDirectory } from '../workspaces/util';
import { CloudClient } from './cloud-client';
import { OrgService } from './org-service';
import { ServerTrust, type TrustRequest } from './server-trust';
import {
  integrationsListSource,
  keybindingsSource,
  launchpadSource,
  preferencesSource,
  themesSource,
  workspacesSource,
  type AccountsLike,
  type LaunchpadLike,
} from './sync/adapters';
import { SyncEngine } from './sync/sync-engine';

export { CloudClient } from './cloud-client';
export { CloudError, type CloudHttp } from './cloud-http';
export { installDeepLinks, isDeepLinkArg, parseDeepLink, type DeepLinks } from './deep-links';
export { OrgService } from './org-service';
export { createCloudExtras, type CloudExtras, type CloudExtrasDeps } from './extras';
export { ServerTrust, fingerprintOfDer, fingerprintOfPem, probeTls, type TrustRequest } from './server-trust';
export { SyncEngine } from './sync/sync-engine';

/** What `main/index.ts` passes to `createCloudServices` (spec 14 account, sync and orgs). */
export interface CloudServicesDeps {
  settings: SettingsStore;
  secrets: SecretStore;
  /** `app.getPath('userData')` — custom themes live in `<userData>/themes`. */
  userDataDir: string;
  /** Active profile directory (`userData/profiles/<id>`). */
  profileDir(): string;
  /** Connected integrations (only kind/host/login are synced, never tokens). */
  accounts: AccountsLike;
  workspaces: {
    list(): Workspace[];
    store: { replaceLocalWorkspaces(list: Workspace[]): unknown };
    onDidChange(cb: () => void): () => void;
  };
  launchpad: LaunchpadLike;
  /** `shell.openExternal` (sign-in opens the system browser). */
  openExternal(url: string): void | Promise<unknown>;
  /** Broadcast to all windows: cloud events plus `keybindings:changed` after synced keybindings land. */
  broadcast(event: string, payload: unknown): void;
  /** Subscribe to window focus (pull when ≥ 5 min old), e.g. `app.on('browser-window-focus')`. */
  onWindowFocus?(listener: () => void): () => void;
  appVersion?: string;
  /**
   * Plug the pinned self-signed server certificates into the network layer's verify proc
   * (`connectivity.network.addTrustSource`); returns a remover.
   */
  registerCertificateTrust?(source: (req: TrustRequest) => boolean): () => void;
  /** Defaults to global fetch; Electron's `net.fetch` also works (system proxy). */
  fetch?: typeof fetch;
  log?(message: string): void;
}

export interface CloudServices {
  client: CloudClient;
  sync: SyncEngine;
  orgs: OrgService;
  /** User-pinned certificates of self-signed cloud servers. */
  serverTrust: ServerTrust;
  /** Route a parsed deep link: queued for `cloud:takeDeepLinks` and announced via `cloud:deepLink`. */
  handleDeepLink(link: CloudDeepLink): void;
  takeDeepLinks(kinds?: CloudDeepLink['kind'][]): CloudDeepLink[];
  /** Load the session, refresh `/v1/me` in the background, start sync when enabled. */
  start(): void;
  dispose(): void;
}

const MAX_PENDING_LINKS = 20;

export function createCloudServices(d: CloudServicesDeps): CloudServices {
  const log = (m: string): void => d.log?.(m);
  const emit = <E extends keyof CloudEventContract>(event: E, payload: CloudEventContract[E]): void =>
    d.broadcast(event, payload);

  const client = new CloudClient({
    serverUrl: () => d.settings.get('cloud.serverUrl'),
    profileId: () => d.settings.activeProfile.id,
    profileDir: d.profileDir,
    secrets: d.secrets,
    openExternal: d.openExternal,
    fetch: d.fetch,
    userAgent: d.appVersion ? `GitHappens/${d.appVersion}` : undefined,
    log,
  });

  const sources = [
    preferencesSource(d.settings, log),
    keybindingsSource(d.settings, (saved) => d.broadcast('keybindings:changed', saved)),
    themesSource(path.join(d.userDataDir, 'themes'), log),
    workspacesSource(
      {
        list: () => d.workspaces.list(),
        replaceLocalWorkspaces: (list) => void d.workspaces.store.replaceLocalWorkspaces(list),
        onDidChange: (cb) => d.workspaces.onDidChange(cb),
      },
      isDirectory,
    ),
    launchpadSource(d.launchpad),
    integrationsListSource(d.accounts, { get: () => sync.hints.get(), set: (h) => sync.hints.set(h) }),
  ];
  const sync: SyncEngine = new SyncEngine({
    http: client,
    secrets: d.secrets,
    sources,
    settings: d.settings,
    profileDir: d.profileDir,
    onStatus: (s) => emit('sync:statusChanged', s),
    log,
  });

  const orgs = new OrgService(client, () => client.refreshMe());
  const serverTrust = new ServerTrust(() => path.join(d.userDataDir, 'cloud', 'server-trust.json'));

  const pending: CloudDeepLink[] = [];
  const unsubs: Array<() => void> = [];

  const onSettingChanged = (c: { key: string }): void => {
    if (c.key === 'cloud.serverUrl') void client.serverUrlChanged().catch(() => undefined);
    sync.settingChanged(c.key);
  };
  const onProfileSwitched = (): void => {
    client.start();
    sync.reload();
  };

  return {
    client,
    sync,
    orgs,
    serverTrust,
    handleDeepLink(link) {
      pending.push(link);
      if (pending.length > MAX_PENDING_LINKS) pending.shift();
      emit('cloud:deepLink', link);
    },
    takeDeepLinks(kinds) {
      const out: CloudDeepLink[] = [];
      for (let i = pending.length - 1; i >= 0; i--) {
        if (!kinds || kinds.includes(pending[i]!.kind)) out.unshift(...pending.splice(i, 1));
      }
      return out;
    },
    start() {
      unsubs.push(client.onSessionChange(() => emit('cloud:sessionChanged', client.status())));
      d.settings.on('changed', onSettingChanged);
      d.settings.on('profileSwitched', onProfileSwitched);
      unsubs.push(() => d.settings.off('changed', onSettingChanged));
      unsubs.push(() => d.settings.off('profileSwitched', onProfileSwitched));
      if (d.onWindowFocus) unsubs.push(d.onWindowFocus(() => sync.onFocus()));
      if (d.registerCertificateTrust) unsubs.push(d.registerCertificateTrust((r) => serverTrust.verify(r)));
      client.start();
      sync.start();
    },
    dispose() {
      for (const u of unsubs.splice(0)) u();
      sync.dispose();
      client.cancelSignIn();
    },
  };
}
