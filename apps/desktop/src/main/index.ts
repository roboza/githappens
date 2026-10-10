import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import watcher from '@parcel/watcher';
import { autoUpdater } from 'electron-updater';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  net,
  Notification,
  powerMonitor,
  protocol,
  safeStorage,
  session,
  shell,
  webContents,
} from 'electron';

import {
  cloneRepo,
  createExtrasRegistry,
  createOpRegistry,
  createUndoOps,
  GitError,
  makeError,
} from '@githappens/git';

import { AccountStore } from './integrations/account-store';
import { IntegrationService } from './integrations/integration-service';
import { oauthConfigFromEnv } from './integrations/oauth-config';
import { OAuthManager } from './integrations/oauth-manager';
import { LaunchpadService } from './launchpad/launchpad-service';
import { createProviderFactory } from './integrations/provider-factory';
import { AiService } from './ai/ai-service';
import { AVATAR_SCHEME_PRIVILEGES, handleAvatarProtocol } from './avatars/protocol';
import { BlameStreams } from './files/blame-streams';
import { REVISION_SCHEME_PRIVILEGES, registerRevisionProtocol } from './files/revision-protocol';
import { createBehaviourServices } from './behaviour';
import { createCloudServices, installDeepLinks, isDeepLinkArg } from './cloud';
import { createCloudExtras } from './cloud/extras';
import { createPatchKeyStore, PatchService, repoIdentityFromRemotes } from './cloud/patches';
import { createCommitServices, hookOutputEvent } from './commit';
import { createConflictServices } from './conflicts';
import { createAgentsHandlers } from './ipc/agents-handlers';
import { createAiHandlers } from './ipc/ai-handlers';
import { createCloudHandlers } from './ipc/cloud-handlers';
import { createConflictsHandlers } from './ipc/conflicts-handlers';
import { createFilesHandlers } from './ipc/files-handlers';
import { createNetworkHandlers } from './ipc/network-handlers';
import { createShellCompletion } from './window/shell-completion';
import { windowSizeOverride } from './window/window-state';
import { createRemotesHandlers } from './ipc/remotes-handlers';
import { CliInstaller } from './cli/install';
import { createRepos2Handlers, devAppArgs } from './ipc/repos2-handlers';
import { createOpenFileQueue, createOsRecents, droppedPathFromUrl } from './repos/os-integration';
import { TemplateStore, templatesDir } from './repos/templates';
import { createSyncHandlers } from './ipc/sync-handlers';
import { createUndoHandlers, undoChangedEvent } from './ipc/undo-handlers';
import { createGraphServices } from './repo-ui';
import { createToolsHandlers } from './ipc/tools-handlers';
import { nodeToolEnv } from './tools/env';
import { ToolsService } from './tools/tools-service';
import { createConnectivityServices } from './network';
import { createPatchesHandlers } from './ipc/patches-handlers';
import { createGitflowHandlers } from './ipc/gitflow-handlers';
import { createCloudWorkspacesHandlers } from './ipc/cloud-workspaces-handlers';
import { createInsightsHandlers } from './ipc/insights-handlers';
import { createSuggestHandlers } from './ipc/suggest-handlers';
import { createHandlers } from './ipc/handlers';
import { createLaunchpadHandlers } from './ipc/launchpad-handlers';
import { createWorkspacesHandlers } from './ipc/workspaces-handlers';
import { createIntegrationsHandlers } from './ipc/integrations-handlers';
import { createUpdateHandlers } from './ipc/update-handlers';
import { createAboutHandlers } from './ipc/about-handlers';
import { createPrefsHandlers } from './ipc/prefs-handlers';
import { createBroadcaster, registerIpcHandlers } from './ipc/registry';
import { EncryptedFileSecretStore, safeStorageEncryptor } from './secrets/secret-store';
import { canonicalPath } from './services/canonical-path';
import { parseOpenPathArgs } from './services/cli-args';
import { CredentialService } from './services/credentials';
import { PtyService, webContentsOwnerHooks, withBundledGitOnPath } from './services/pty-service';
import { GitEngine } from './services/git-engine';
import { RepoManager } from './services/repo-manager';
import { onRegistryChanged, RepoRegistry } from './services/repo-registry';
import {
  applyUpdateFeedOverride,
  defaultChangelogPath,
  updateFeedOverride,
  UpdaterService,
} from './services/updater';
import type { WatcherBackend } from './services/repo-watcher';
import { ShellStateStore } from './services/shell-state';
import { WorkspaceService } from './workspaces/workspace-service';
import { pathKey as workspacePathKey } from './workspaces/util';
import { createGitConfigWriter } from './settings/git-config-writer';
import { SettingsStore } from './settings/settings-store';

const isDev = !app.isPackaged && !!process.env.ELECTRON_RENDERER_URL;

// Isolated profile directory for tests and side-by-side dev instances.
if (process.env.GITHAPPENS_USER_DATA_DIR) app.setPath('userData', process.env.GITHAPPENS_USER_DATA_DIR);

// Custom schemes must be registered once, before `ready` (avatars: spec 10; revisions: spec 07).
protocol.registerSchemesAsPrivileged([AVATAR_SCHEME_PRIVILEGES, REVISION_SCHEME_PRIVILEGES]);

/** Bundled portable git: `resources/git` when packaged, dugite's download in development (spec 15 §6.2). */
function bundledGitDir(): string | undefined {
  if (app.isPackaged) return path.join(process.resourcesPath, 'git');
  try {
    return path.join(path.dirname(require.resolve('dugite/package.json')), 'git');
  } catch {
    return undefined;
  }
}

/** First-run identity for the Default profile (spec 13 §7 step 5). Best effort, system git only. */
function globalGitIdentity(): { name?: string; email?: string } {
  const read = (key: string): string | undefined => {
    try {
      return (
        execFileSync('git', ['config', '--global', '--get', key], {
          encoding: 'utf8',
          windowsHide: true,
        }).trim() || undefined
      );
    } catch {
      return undefined;
    }
  };
  return { name: read('user.name'), email: read('user.email') };
}

function isTrustedSender(url: string | undefined): boolean {
  if (!url) return false;
  if (isDev) return url.startsWith(process.env.ELECTRON_RENDERER_URL!);
  return url.startsWith('file://');
}

const broadcast = createBroadcaster(() => webContents.getAllWebContents());
const toast = (kind: 'warning' | 'error' | 'info', title: string, body?: string): void =>
  broadcast('shell:toast', { kind, title, body });

const TITLE_BAR_HEIGHT = 36;

let engine: GitEngine | null = null;
let repoManager: RepoManager | null = null;
let workspaceService: WorkspaceService | null = null;
let launchpadService: LaunchpadService | null = null;
let aiService: AiService | null = null;
/** macOS `open-file` paths received before the window can take them (spec 03). */
const openFiles = createOpenFileQueue();
/** Window state, native menu, file finder, tab aliases (spec 01). */
let shellCompletion: ReturnType<typeof createShellCompletion> | null = null;
let blameStreams: BlameStreams | null = null;
let graphServices: ReturnType<typeof createGraphServices> | null = null;
let behaviourServices: ReturnType<typeof createBehaviourServices> | null = null;
let connectivityServices: ReturnType<typeof createConnectivityServices> | null = null;
let cloudServices: ReturnType<typeof createCloudServices> | null = null;
let cloudExtras: ReturnType<typeof createCloudExtras> | null = null;
let conflictServices: ReturnType<typeof createConflictServices> | null = null;
/** `githappens://` links (spec 14 §6.1); installed before `ready` so macOS open-url at launch is caught. */
let deepLinks: ReturnType<typeof installDeepLinks> | null = null;
const notDeepLink = (args: string[]): string[] => args.filter((a) => !isDeepLinkArg(a));
let credentialService: CredentialService | null = null;
let ptyService: PtyService | null = null;
/** Current `ui.zoom` (spec 13), applied to every window. */
let zoomFactor = (): number => 1;
/** In-flight clones by opId, for `repos:cancel`. */
const clones = new Map<string, AbortController>();
/** Paths requested on the command line before the window finished loading. */
let pendingOpen: string[] = [];

function mainWindow(): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows()[0];
}

/** Window icon (Windows/Linux): packaged Windows uses the exe icon; Linux ships resources/icon.png. */
function windowIcon(): string | undefined {
  if (process.platform === 'darwin') return undefined;
  const file = app.isPackaged
    ? path.join(process.resourcesPath, 'icon.png')
    : path.join(app.getAppPath(), 'build', 'icon.png');
  return fs.existsSync(file) ? file : undefined;
}

function createWindow(): BrowserWindow {
  const mac = process.platform === 'darwin';
  const icon = windowIcon();
  // e2e/dev: a fixed initial size (GITHAPPENS_WINDOW_SIZE=1024x768) instead of the restored bounds.
  const sizeOverride = windowSizeOverride(process.env.GITHAPPENS_WINDOW_SIZE);
  const bounds = shellCompletion?.windowOptions() ?? { width: 1400, height: 880 };
  const win = new BrowserWindow({
    ...(sizeOverride ?? bounds),
    minWidth: 900,
    minHeight: 560,
    show: false,
    title: 'GitHappens',
    ...(icon ? { icon } : {}),
    backgroundColor: '#16191d',
    autoHideMenuBar: true,
    // Repo tabs live in the title bar (spec 01 §4.1); native window controls are kept.
    titleBarStyle: mac ? 'hiddenInset' : 'hidden',
    ...(mac
      ? { trafficLightPosition: { x: 12, y: 11 } }
      : { titleBarOverlay: { color: '#1d2126', symbolColor: '#d0d4d9', height: TITLE_BAR_HEIGHT } }),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  shellCompletion?.attach(win);

  win.once('ready-to-show', () => win.show());
  const senderId = win.webContents.id;
  // In-flight AI requests stream to this window only; stop them when it goes away.
  win.on('closed', () => aiService?.cancelAll(senderId));
  win.webContents.on('did-finish-load', () => win.webContents.setZoomFactor(zoomFactor()));
  win.webContents.on('did-finish-load', () => {
    for (const p of pendingOpen) broadcast('app:openRepoRequest', { path: p });
    pendingOpen = [];
    openFiles.ready((p) => broadcast('app:openRepoRequest', { path: canonicalPath(p) }));
  });

  // No in-app navigation or popups; http(s) links open in the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (isTrustedSender(url)) return;
    e.preventDefault();
    // A folder dropped onto the window navigates to file://… — open it as a repo instead (spec 03).
    const dropped = droppedPathFromUrl(url);
    if (dropped) broadcast('app:openRepoRequest', { path: canonicalPath(dropped) });
  });

  if (isDev) void win.loadURL(process.env.ELECTRON_RENDERER_URL!);
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'));
  return win;
}

async function bootstrap(): Promise<void> {
  const userData = app.getPath('userData');

  const settings = new SettingsStore({
    dir: userData,
    onWarning: (m) => toast('warning', 'Settings', m),
    defaultIdentity: globalGitIdentity,
  });
  settings.load();
  zoomFactor = () => settings.get('ui.zoom');
  // Op behaviour settings, auto-fetch, desktop notifications and the git output log (spec 01/02/09/13).
  const behaviour = createBehaviourServices({
    settings,
    repos: () => repoManager,
    userDataDir: userData,
    broadcast: (e, p) => broadcast(e, p as never),
    toast: (t) => broadcast('shell:toast', t),
    isOnline: () => net.isOnline(),
    isFocused: () => BrowserWindow.getAllWindows().some((w) => w.isFocused()),
    showNotification: ({ title, body, onClick }) => {
      if (!Notification.isSupported()) return false;
      const n = new Notification({ title, body });
      if (onClick) n.on('click', onClick);
      n.show();
      return true;
    },
    focusWindow: () => {
      const w = mainWindow();
      if (w) {
        if (w.isMinimized()) w.restore();
        w.focus();
      }
    },
    openPath: (dir) => shell.openPath(dir),
  });
  behaviourServices = behaviour;
  // Auto-update (spec 15 §7); a no-op in unpackaged builds unless the env-only test feed override is set.
  const feedOverride = updateFeedOverride(process.env, app.isPackaged, path.join(userData, 'update-test'));
  if (feedOverride) applyUpdateFeedOverride(autoUpdater, feedOverride);
  const updater = new UpdaterService({
    updater: autoUpdater,
    currentVersion: app.getVersion(),
    isPackaged: app.isPackaged || feedOverride !== null,
    installOnQuit: feedOverride === null,
    startupDelayMs: feedOverride?.startupDelayMs,
    getChannel: () => settings.get('updates.channel'),
    getAutoDownload: () => settings.get('updates.autoDownload'),
    onStatus: (st) => broadcast('update:status', st),
    changelogPath: defaultChangelogPath(app.isPackaged, process.resourcesPath, app.getAppPath()),
    stateFile: path.join(userData, 'update-state.json'),
    log: (m, e) => console.warn('[updater]', m, e ?? ''),
  });
  settings.on('changed', (change) => {
    broadcast('settings:changed', change);
    if (change.key.startsWith('updates.')) updater.refreshSettings();
    if (change.key === 'ui.zoom') {
      for (const w of BrowserWindow.getAllWindows()) w.webContents.setZoomFactor(change.value as number);
    }
    behaviour.onSettingChanged(change);
  });
  const profileDir = (): string => path.join(userData, 'profiles', settings.activeProfile.id);

  const secrets = new EncryptedFileSecretStore(
    path.join(userData, 'secrets.bin'),
    safeStorageEncryptor(safeStorage),
  );

  const gitEngine = new GitEngine({
    bundledGitDir: bundledGitDir(),
    onChanged: (info) => broadcast('git:engine:changed', info),
    onWarning: (m) => toast('warning', 'Git', m),
    onCommand: behaviour.onCommand,
  });
  engine = gitEngine;

  // Created after the repo manager; connected accounts answer git HTTPS prompts (spec 10 §4).
  let integrations: IntegrationService | null = null;
  const credentials = new CredentialService({
    shimsDir: path.join(userData, 'askpass'),
    nodeExecutable: process.execPath,
    secrets,
    profileId: () => settings.activeProfile.id,
    showPrompt: (p) => {
      broadcast('git:prompt', p);
      const win = mainWindow();
      if (win && !win.isFocused()) win.flashFrame(true);
    },
    integrationLogin: (host) => integrations?.gitLogin(host) ?? null,
    integrationAccounts: () =>
      (integrations?.list() ?? [])
        .filter((a) => ['github', 'gitlab', 'bitbucket', 'bitbucket-dc', 'azure-devops'].includes(a.kind))
        .map((a) => ({ host: a.host, login: a.login })),
    onIntegrationAuthFailed: (host) => {
      for (const a of integrations?.list() ?? []) {
        if (a.host === host) {
          broadcast('auth:reauthRequired', { integrationKey: a.key, reason: 'git rejected the saved token' });
        }
      }
    },
    log: (m) => console.warn('[askpass]', m),
  });
  credentialService = credentials;
  await credentials.start().catch((e: unknown) => {
    console.error('[askpass] could not start; credential prompts are unavailable:', e);
  });

  // SSH / proxy / certificates for every git spawn and the app's own HTTP (spec 09/13).
  const connectivity = createConnectivityServices({
    settings,
    secrets,
    bundledGitDir: bundledGitDir(),
    session: session.defaultSession,
    netFetch: net.fetch.bind(net) as typeof fetch,
    askpass: { env: (id) => credentials.envFor(id, false), release: (id) => credentials.finish(id) },
    log: (m) => console.warn('[network]', m),
  });
  connectivityServices = connectivity;
  gitEngine.runner.setInvocationExtras(connectivity.gitInvocation);
  app.on('login', (event, _wc, _details, authInfo, callback) => {
    const login = connectivity.network.proxyLogin(authInfo);
    if (login) {
      event.preventDefault();
      callback(login.username, login.password);
    }
  });

  // Integrated terminals; output goes only to the window that created them (spec 12).
  const ptys = new PtyService({
    ...webContentsOwnerHooks((id) => webContents.fromId(id)),
    // `git` in the integrated terminal works on machines without a system git (spec 15 §6.2).
    env: withBundledGitOnPath(process.env, bundledGitDir()),
    defaultShell: () => {
      const shellPath = settings.get('terminal.shell');
      const args = settings.get('terminal.shellArgs');
      return { shell: shellPath || undefined, args: args.length ? args : undefined };
    },
  });
  ptyService = ptys;

  const repos = new RepoManager({
    registry: (journal) => ({ ...createOpRegistry(), ...createExtrasRegistry(), ...createUndoOps(journal) }),
    journalDir: path.join(userData, 'undo'),
    onOpState: (repoId, e) => {
      broadcast('git:op:state', { ...e, repoId });
      behaviour.onOpState(repoId, e);
      graphServices?.onOpState(repoId, e);
    },
    onOpProgress: (repoId, opId, p) => {
      broadcast('git:progress', { repoId, opId, ...p });
      const hook = hookOutputEvent(repoId, opId, p);
      if (hook) broadcast('commit:hookOutput', hook);
    },
    onUndoChanged: (repoId, peek) => broadcast('undo:changed', undoChangedEvent(repoId, peek)),
    credentialEnv: (opId, background) => credentials.envFor(opId, background),
    onOpFinished: (opId, code) => credentials.finish(opId, code),
    mapError: (opId, err) =>
      err.code === 'AuthenticationFailed' && credentials.wasCancelled(opId)
        ? new GitError(makeError('AuthCancelled', { argv: [], opId }, 'Authentication was cancelled.'))
        : err,
    ...behaviour.repoManagerOptions,
    runner: () => gitEngine.runner,
    features: () => {
      try {
        return gitEngine.info.features;
      } catch {
        return undefined;
      }
    },
    watcherBackend: watcher as unknown as WatcherBackend,
    onChanged: (repoId, scopes, reason) => {
      broadcast('git:repo:changed', { repoId, scopes, reason });
      conflictServices?.onRepoChanged(repoId, scopes, reason);
      shellCompletion?.onRepoChanged(repoId, scopes);
    },
    onWatchError: (_id, err) =>
      toast(
        'warning',
        'File watching unavailable',
        `${err.message}. Falling back to polling every 5 seconds.`,
      ),
  });
  repoManager = repos;

  let registry: { dir: string; store: RepoRegistry } | null = null;
  const repoRegistry = (): RepoRegistry => {
    const dir = profileDir();
    if (registry?.dir !== dir) registry = { dir, store: new RepoRegistry(path.join(dir, 'repos.json')) };
    return registry.store;
  };

  const shellDone = createShellCompletion({
    userDataDir: userData,
    appName: app.getName(),
    devTools: isDev,
    repos,
    engine: gitEngine,
    gitPreference: () => settings.get('git.executable'),
    registry: repoRegistry,
    mainWindow,
    send: (e, p) => broadcast(e, p as never),
    saveDialog: async ({ title, defaultName }) => {
      const win = mainWindow();
      const o = {
        title,
        defaultPath: defaultName,
        filters: [{ name: 'Patch', extensions: ['patch', 'diff'] }],
      };
      const r = win ? await dialog.showSaveDialog(win, o) : await dialog.showSaveDialog(o);
      return r.canceled || !r.filePath ? null : r.filePath;
    },
  });
  shellCompletion = shellDone;
  shellDone.installMenu();

  // Commit composer: drafts per repo+branch, templates, co-author suggestions (spec 06).
  const commitServices = createCommitServices({ userDataDir: profileDir, repos });

  // Windows JumpList / macOS recent documents follow the recent-repos list.
  const osRecents = createOsRecents(app, {
    platform: process.platform,
    exe: process.execPath,
    extraArgs: devAppArgs(app.isPackaged, app.getAppPath()),
  });
  onRegistryChanged(osRecents);
  osRecents(repoRegistry().list());

  /** Clone with askpass credentials (spec 03 clone, spec 11 bulk clone). */
  const runClone = async (
    args: Parameters<typeof cloneRepo>[1],
    opId: string,
    signal: AbortSignal,
    progress: (p: { phase: string; percent: number | null; overall: number | null; text: string }) => void,
  ): Promise<{ path: string }> => {
    try {
      return await cloneRepo(gitEngine.runner, args, {
        opId,
        signal,
        env: credentials.envFor(opId, false),
        progress,
      });
    } catch (e) {
      const code = e instanceof GitError ? e.code : undefined;
      credentials.finish(opId, code);
      if (code === 'AuthenticationFailed' && credentials.wasCancelled(opId)) {
        throw new GitError(makeError('AuthCancelled', { argv: [] }, 'Authentication was cancelled.'));
      }
      throw e;
    } finally {
      credentials.finish(opId);
    }
  };

  // Workspaces (spec 11 §5.5): per-profile store, cross-repo status, folder sync, bulk ops.
  const workspaces = new WorkspaceService({
    profileDir,
    runner: () => gitEngine.runner,
    openRepo: (p) => repos.open(p).then((info) => info.id),
    closeRepo: (id) => repos.close(id),
    runOp: (id, op, signal) => repos.runOp(id, op, false, signal),
    clone: (job) =>
      runClone(
        { url: job.url, parentDir: job.parentDir, folderName: job.folderName },
        randomUUID(),
        job.signal,
        (p) => job.onProgress(p.overall, p.phase || p.text),
      ),
    bulkConcurrency: () => settings.get('workspaces.bulkConcurrency'),
    scanDepth: () => settings.get('workspaces.scanDepth'),
    emit: (event, payload) => broadcast(event, payload as never),
    toast: (t) => broadcast('shell:toast', t),
    pickFile: async ({ title, filters }) => {
      const win = mainWindow();
      const opts = { title, filters, properties: ['openFile' as const] };
      const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
      return r.canceled ? null : (r.filePaths[0] ?? null);
    },
    pickSavePath: async ({ title, defaultPath, filters }) => {
      const win = mainWindow();
      const opts = { title, defaultPath, filters };
      const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
      return r.canceled ? null : (r.filePath ?? null);
    },
  });
  workspaces.start();
  workspaceService = workspaces;

  const accounts = new AccountStore(profileDir, () => settings.activeProfile.id, secrets);
  const oauthConfig = oauthConfigFromEnv();
  const providerFactory = createProviderFactory({
    oauth: oauthConfig,
    onRateLimit: (integrationKey, r) => broadcast('provider:rateLimit', { integrationKey, ...r }),
    onCredentialRefreshed: (key, cred) => accounts.updateCredential(key, cred),
    onReauthRequired: (integrationKey, reason) =>
      broadcast('auth:reauthRequired', { integrationKey, reason }),
  });
  const integrationService = new IntegrationService(accounts, providerFactory, repos, {
    changed: (list) => broadcast('auth:changed', { integrations: list }),
    prIndex: (repoId, entries) => broadcast('pr:indexUpdated', { repoId, entries }),
  });
  integrations = integrationService;
  // Launchpad (spec 11 §6.4): PRs/issues of every connected account + local WIP, classified.
  const remotesOf = (p: string): Promise<string[]> =>
    workspaces.status
      .remotes(p)
      .then((rs) => rs.map((r) => r.url))
      .catch(() => []);
  const wipPaths = (): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    const add = (p?: string): void => {
      const k = p && workspacePathKey(p);
      if (p && k && !seen.has(k)) {
        seen.add(k);
        out.push(p);
      }
    };
    for (const r of repoRegistry().list().slice(0, 30)) if (!r.isBare) add(r.path);
    for (const w of workspaces.list()) for (const r of w.repos) add(r.localPath);
    for (const svc of repos.list()) add(svc.repo.worktreeRoot ?? undefined);
    return out;
  };
  /** Known local clones with a remote (Launchpad PR -> repo matching, shared workspaces). */
  const knownRepos = async (): Promise<Array<{ path: string; remotes: string[] }>> =>
    repoRegistry()
      .list()
      .filter((r) => !r.isBare && r.remoteUrl)
      .map((r) => ({ path: r.path, remotes: [r.remoteUrl!] }));
  const launchpad = new LaunchpadService({
    integrations: integrationService,
    openRepos: () =>
      Promise.all(
        repos.list().map(async (svc) => {
          const info = svc.repo;
          const p = info.worktreeRoot ?? info.gitDir;
          return {
            path: p,
            branch: info.head.kind === 'branch' ? info.head.name : undefined,
            remotes: await remotesOf(p),
          };
        }),
      ),
    wips: async () => {
      const paths = wipPaths();
      const rows = await Promise.all(
        paths.map(async (p) => {
          const st = await workspaces.status.forPath(p).catch(() => null);
          if (!st?.isRepo) return null;
          return {
            path: p,
            name: path.basename(p),
            branch: st.head?.branch,
            ...st.wip,
            remotes: await remotesOf(p),
          };
        }),
      );
      return rows.filter((r) => r !== null);
    },
    workspaceRepos: async (id) => {
      const ws = workspaces.list().find((w) => w.id === id);
      if (!ws) return null;
      return ws.repos.map((r) => ({
        id: r.id,
        localPath: r.localPath,
        integrationKey: r.provider?.integrationKey,
        owner: r.provider?.owner,
        name: r.provider?.name,
        remotes: r.remoteUrl ? [r.remoteUrl] : undefined,
      }));
    },
    knownRepos,
    profileDir,
    profileId: () => settings.activeProfile.id,
    cacheDir: () => path.join(userData, 'cache'),
    emit: (event, payload) => broadcast(event, payload as never),
    prNotifications: {
      enabled: () => settings.get('notifications.prEvents'),
      desktopEnabled: () => settings.get('notifications.desktop'),
      refreshMinutes: () => settings.get('launchpad.refreshMinutes'),
      ...behaviour.os,
    },
  });
  launchpad.start();
  // Workspace repos feed the WIP list: a new / edited workspace must not leave a cached empty list.
  workspaces.onDidChange(() => launchpad.invalidateLocal(true));
  launchpadService = launchpad;
  powerMonitor.on('resume', () => launchpad.onResume());
  powerMonitor.on('suspend', () => launchpad.onSuspend());
  powerMonitor.on('lock-screen', () => launchpad.setScreenLocked(true));
  powerMonitor.on('unlock-screen', () => launchpad.setScreenLocked(false));

  // AI (spec 12 §6.3): BYO key in the SecretStore; streams go back to the requesting window.
  const ai = new AiService({
    settings: (key) => settings.get(key),
    secrets,
    profileId: () => settings.activeProfile.id,
    git: (repoId) => repos.get(repoId),
    emit: (event, senderId) => {
      const wc = senderId === undefined ? null : webContents.fromId(senderId);
      if (wc && !wc.isDestroyed()) wc.send('ai:event', event);
      else if (senderId === undefined) broadcast('ai:event', event);
    },
  });
  aiService = ai;

  // GitHappens Cloud (spec 14): sign-in, encrypted sync, orgs. Inert until cloud.serverUrl is set.
  const cloud = createCloudServices({
    settings,
    secrets,
    userDataDir: userData,
    profileDir,
    accounts,
    workspaces,
    launchpad,
    openExternal: (url) => shell.openExternal(url),
    broadcast: (e, p) => broadcast(e as never, p as never),
    onWindowFocus: (l) => {
      app.on('browser-window-focus', l);
      return () => app.off('browser-window-focus', l);
    },
    appVersion: app.getVersion(),
    registerCertificateTrust: (src) => connectivity.network.addTrustSource(src),
    log: (m) => console.warn('[cloud]', m),
  });
  cloud.start();
  cloudServices = cloud;
  deepLinks?.setHandler((link) => {
    cloud.handleDeepLink(link);
    const win = mainWindow();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  // Cloud Patches (spec 14 §6.3): share WIP / commits / stashes by link, apply through the op queue.
  const patches = new PatchService({
    cloud: cloud.client,
    repos: { get: (id) => repos.get(id), list: () => repos.list(), runOp: (id, op) => repos.runOp(id, op) },
    resolveRepoIdentity: async (id) => repoIdentityFromRemotes(await integrationService.resolveRemotes(id)),
    appVersion: app.getVersion(),
    cacheDir: () => path.join(userData, 'cloud'),
    onChanged: (e) => broadcast('patch:changed', e),
    keyStore: createPatchKeyStore({
      secrets,
      profileId: () => settings.activeProfile.id,
      serverUrl: () => cloud.client.serverUrl(),
    }),
  });

  // Cloud extras (spec 14): suggest changes, workspace insights, cloud workspaces, Launchpad state sync.
  const extras = createCloudExtras({
    cloud: cloud.client,
    patches,
    repos: {
      get: (id) => repos.get(id),
      list: () => repos.list(),
      runOp: (id, op) => repos.runOp(id, op),
      open: (p) => repos.open(p).then((i) => i.id),
      close: (id) => repos.close(id),
    },
    integrations: integrationService,
    workspaces: {
      list: () => workspaces.list(),
      create: (i) => workspaces.create(i),
      addRepos: (id, r) => workspaces.addRepos(id, r),
      startBulk: (r) => workspaces.startBulk(r),
      onDidChange: (cb) => workspaces.onDidChange(cb),
    },
    launchpad,
    settings,
    knownRepos,
    runGit: (cwd, args) =>
      gitEngine.runner
        .run({ cwd, args, priority: 'background', timeoutMs: 60_000, encoding: 'utf8' })
        .then((r) => String(r.stdout)),
    userDataDir: userData,
    profileDir,
    broadcast: (e, p) => broadcast(e as never, p as never),
    log: (m) => console.warn('[cloud]', m),
  });
  extras.start();
  cloudExtras = extras;

  // External editor / terminal / diff & merge tools (spec 12 §6.10, spec 07/08).
  const tools = new ToolsService({
    env: nodeToolEnv(),
    settings,
    repos: { get: (id) => repos.get(id), runOp: (id, op, bg, signal) => repos.runOp(id, op, bg, signal) },
    shell: { openPath: (p) => shell.openPath(p), showItemInFolder: (p) => shell.showItemInFolder(p) },
    tmpRoot: os.tmpdir(),
    log: (m, e) => console.warn(m, e ?? ''),
  });

  // Conflict prevention + team footprints (spec 14 §6.5).
  // Graph: per-repo hide/solo/pins + columns, commit-graph maintenance, avatars (spec 04 / spec 10).
  const graph = createGraphServices({
    userDataDir: userData,
    setting: (key) => settings.get(key),
    onSettingChanged: (cb) => {
      const l = (c: { key: string }): void => cb(c.key);
      settings.on('changed', l);
      return () => settings.off('changed', l);
    },
    repoInfo: (id) => repos.get(id).repo,
    runGit: async (cwd, args) =>
      String(
        (
          await gitEngine.runner.run({
            cwd,
            args,
            priority: 'background',
            timeoutMs: 30 * 60_000,
            encoding: 'utf8',
          })
        ).stdout,
      ),
    runBackgroundOp: (id, op) => repos.runOp(id, op, true),
    providerHosts: () => integrationService.list().map((i) => ({ kind: i.kind, host: i.host })),
    fetch: (url, init) => net.fetch(url, init),
    log: (m, e) => console.warn('[graph]', m, e ?? ''),
  });
  graphServices = graph;
  handleAvatarProtocol(protocol, graph.avatars);
  // githappens-rev:// serves blobs at a revision / index / worktree for image + LFS diffs (spec 07).
  registerRevisionProtocol(protocol, { service: (id) => repos.get(id) });
  const blame = new BlameStreams((e, p) => broadcast(e, p as never));
  blameStreams = blame;

  const conflictSvc = createConflictServices({
    repos,
    integrations: integrationService,
    cloud: cloud.client,
    settings,
    emit: (e, p) => broadcast(e, p as never),
    log: (m, e) => console.warn(m, e ?? ''),
  });
  conflictServices = conflictSvc;

  const oauth = new OAuthManager({
    service: integrationService,
    authInfo: (kind, host) => providerFactory.authInfo(kind, host),
    config: oauthConfig,
    openExternal: (url) => shell.openExternal(url),
    progress: (p) => broadcast('auth:oauthProgress', p),
  });

  let shellState: { dir: string; store: ShellStateStore } | null = null;

  const gitConfig = createGitConfigWriter(() => gitEngine.runner.run.bind(gitEngine.runner), os.homedir());
  const prefsHandlers = createPrefsHandlers({
    settings,
    userDataDir: userData,
    secrets,
    broadcast: (event, payload) => broadcast(event, payload as never),
    setGlobalIdentity: gitConfig.setGlobalIdentity,
    writeGitConfig: gitConfig.writeGitConfig,
    runGit: gitConfig.runGit,
    pickSavePath: async ({ title, defaultName }) => {
      const win = mainWindow();
      const o = {
        title,
        defaultPath: defaultName,
        filters: [{ name: 'Settings bundle', extensions: ['json'] }],
      };
      const r = win ? await dialog.showSaveDialog(win, o) : await dialog.showSaveDialog(o);
      return r.canceled || !r.filePath ? null : r.filePath;
    },
    openPath: (p) => shell.openPath(p),
    pickPath: async ({ kind, title, defaultPath }) => {
      const win = mainWindow();
      const opts = {
        title,
        defaultPath,
        properties: [kind === 'file' ? ('openFile' as const) : ('openDirectory' as const)],
      };
      const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
      return r.canceled ? null : (r.filePaths[0] ?? null);
    },
    log: (m) => console.warn('[prefs]', m),
  });

  registerIpcHandlers(
    ipcMain,
    {
      ...prefsHandlers,
      ...createIntegrationsHandlers(integrationService, oauth),
      ...createUpdateHandlers(updater),
      ...createAboutHandlers({ bundledGitDir: bundledGitDir() }),
      ...createAgentsHandlers({ ptys, settings, broadcast: (e, p) => broadcast(e, p) }),
      ...createGitflowHandlers(repos),
      ...createSuggestHandlers(extras.suggest),
      ...createInsightsHandlers(extras.insights),
      ...createCloudWorkspacesHandlers(extras),
      ...createUndoHandlers({
        repos,
        saveDialog: async ({ title, defaultName }) => {
          const win = mainWindow();
          const o = {
            title,
            defaultPath: defaultName,
            filters: [{ name: 'Patch', extensions: ['patch', 'diff'] }],
          };
          const r = win ? await dialog.showSaveDialog(win, o) : await dialog.showSaveDialog(o);
          return r.canceled || !r.filePath ? null : r.filePath;
        },
      }),
      ...createWorkspacesHandlers(workspaces),
      ...createLaunchpadHandlers(launchpad),
      ...createAiHandlers(ai),
      ...createCloudHandlers(cloud),
      ...createConflictsHandlers(conflictSvc),
      ...behaviour.handlers,
      ...graph.handlers,
      ...shellDone.handlers,
      ...commitServices.handlers,
      ...createRepos2Handlers({
        runner: () => gitEngine.runner,
        features: () => gitEngine.info.features,
        registry: repoRegistry,
        repos,
        templates: new TemplateStore(
          templatesDir({
            isPackaged: app.isPackaged,
            resourcesPath: process.resourcesPath,
            appPath: app.getAppPath(),
          }),
        ),
        integrations: integrationService,
        credentials,
        progress: (p) => broadcast('repos:cloneProgress', p),
        cli: new CliInstaller({
          platform: process.platform,
          exe: process.execPath,
          appArgs: devAppArgs(app.isPackaged, app.getAppPath()),
          userDataDir: userData,
          homeDir: os.homedir(),
        }),
      }),
      ...createSyncHandlers({
        repos,
        credentials: {
          envFor: (id, bg) => credentials.envFor(id, bg),
          finish: (id, code) => credentials.finish(id, code),
        },
      }),
      ...createRemotesHandlers(repos),
      ...createFilesHandlers({
        repos,
        blame,
        saveDialog: async ({ title, defaultName }) => {
          const win = mainWindow();
          const o = {
            title,
            defaultPath: defaultName,
            filters: [{ name: 'Patch', extensions: ['patch', 'diff'] }],
          };
          const r = win ? await dialog.showSaveDialog(win, o) : await dialog.showSaveDialog(o);
          return r.canceled || !r.filePath ? null : r.filePath;
        },
      }),
      ...createToolsHandlers(tools),
      ...createNetworkHandlers({ ssh: connectivity.ssh, network: connectivity.network, credentials }),
      ...createPatchesHandlers(patches),
      ...createHandlers({
        settings,
        secrets,
        engine: gitEngine,
        repos,
        registry: repoRegistry,
        shellState: () => {
          const dir = profileDir();
          if (shellState?.dir !== dir)
            shellState = { dir, store: new ShellStateStore(dir, () => settings.get('general.rememberTabs')) };
          return shellState.store;
        },
        shell: {
          pickFolder: async () => {
            const win = mainWindow();
            const opts = { properties: ['openDirectory' as const] };
            const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
            // Canonical (8.3 short names expanded) so it dedupes against registry / scan paths.
            const picked = r.canceled ? undefined : r.filePaths[0];
            return picked ? canonicalPath(picked) : null;
          },
          openPath: (p) => shell.showItemInFolder(p),
          openExternal: (url) => void shell.openExternal(url),
          copyText: (text) => clipboard.writeText(text),
          setTitleBarColors: (background, foreground) => {
            const win = mainWindow();
            if (win && process.platform !== 'darwin') {
              win.setTitleBarOverlay({
                color: background,
                symbolColor: foreground,
                height: TITLE_BAR_HEIGHT,
              });
            }
          },
        },
        prompts: credentials,
        ptys,
        creator: {
          clone: async (req) => {
            const controller = new AbortController();
            clones.set(req.opId, controller);
            try {
              return await runClone(
                {
                  url: req.url,
                  parentDir: req.parentDir,
                  folderName: req.folderName,
                  depth: req.depth,
                  branch: req.branch,
                  recurseSubmodules: req.recurseSubmodules,
                },
                req.opId,
                controller.signal,
                (p) =>
                  broadcast('repos:cloneProgress', {
                    opId: req.opId,
                    phase: p.phase,
                    percent: p.percent,
                    overall: p.overall,
                    text: p.text,
                  }),
              );
            } finally {
              clones.delete(req.opId);
            }
          },
          cancel: (opId) => clones.get(opId)?.abort(),
        },
        versions: {
          app: app.getVersion(),
          electron: process.versions.electron,
          chrome: process.versions.chrome,
          node: process.versions.node,
        },
      }),
    },
    isTrustedSender,
  );

  // Resolve git before showing UI so the first render has engine info; failures surface in the UI.
  await gitEngine.init(settings.get('git.executable')).catch((e: unknown) => {
    console.error('[git] no usable git executable:', e);
  });

  pendingOpen = parseOpenPathArgs(notDeepLink(process.argv), app.isPackaged, process.cwd());
  createWindow();
  updater.start();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  deepLinks = installDeepLinks({ app, log: (m) => console.warn('[deep-link]', m) });
  app.on('open-file', (e, p) => {
    e.preventDefault();
    openFiles.push(p);
  });
  // `githappens -p <path>` while running opens the repo in the existing window (spec 03).
  app.on('second-instance', (_e, argv, cwd) => {
    const win = mainWindow();
    deepLinks?.handleArgv(argv);
    for (const p of parseOpenPathArgs(notDeepLink(argv), app.isPackaged, cwd))
      broadcast('app:openRepoRequest', { path: p });
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app
    .whenReady()
    .then(bootstrap)
    .catch((e: unknown) => {
      console.error('Fatal startup error', e);
      app.exit(1);
    });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    workspaceService?.dispose();
    blameStreams?.cancelAll();
    graphServices?.dispose();
    behaviourServices?.dispose();
    connectivityServices?.dispose();
    launchpadService?.dispose();
    cloudExtras?.dispose();
    cloudServices?.dispose();
    conflictServices?.dispose();
    void repoManager?.disposeAll();
    void credentialService?.close();
    ptyService?.dispose();
    engine?.dispose();
  });
}
