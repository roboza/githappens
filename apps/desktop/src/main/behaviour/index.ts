import fs from 'node:fs';
import path from 'node:path';

import type { CommitIdentity, GitService, OpStateEvent, RepoId } from '@githappens/git';

import type { ProfileMeta, SettingsChange, ToastSpec } from '../../shared/ipc/app-contract';
import type { BehaviourEventContract } from '../../shared/ipc/behaviour-contract';
import type { SettingKey, SettingValue } from '../../shared/settings/registry';
import { createBehaviourHandlers, type BehaviourHandlers } from '../ipc/behaviour-handlers';
import { createOutputHandlers, type OutputHandlers } from '../ipc/output-handlers';
import { DesktopNotifier } from '../notify/desktop-notifier';
import { FileLogger } from '../output/file-logger';
import { OutputLog, samePath } from '../output/output-log';
import { AutoFetchScheduler } from '../services/auto-fetch';
import type { RepoManager } from '../services/repo-manager';
import { OpBehaviour } from './op-behaviour';

export { OpBehaviour } from './op-behaviour';

export interface BehaviourSettings {
  get<K extends SettingKey>(key: K): SettingValue<K>;
  readonly activeProfile: ProfileMeta;
}

export interface BehaviourServicesDeps {
  settings: BehaviourSettings;
  /** Lazy: the GitEngine (which needs `onCommand`) is built before the RepoManager. */
  repos: () => RepoManager | null;
  userDataDir: string;
  broadcast: <E extends keyof BehaviourEventContract>(event: E, payload: BehaviourEventContract[E]) => void;
  toast: (t: ToastSpec) => void;
  /** Electron `net.isOnline()`. */
  isOnline: () => boolean;
  /** Any app window focused. */
  isFocused: () => boolean;
  /** `new Notification({ title, body }).show()`; false when `Notification.isSupported()` is false. */
  showNotification: (n: { title: string; body?: string; onClick?: () => void }) => boolean;
  focusWindow?: () => void;
  /** `shell.openPath(dir)`. */
  openPath: (dir: string) => Promise<unknown> | void;
}

/**
 * Phase 7 behaviour services, composed for `main/index.ts`: git output log + extended file log,
 * desktop notifications, the auto-fetch scheduler, settings-driven op behaviour and profile identity.
 */
export function createBehaviourServices(d: BehaviourServicesDeps) {
  const logsDir = path.join(d.userDataDir, 'logs');
  const fileLogger = new FileLogger({
    dir: logsDir,
    enabled: () => d.settings.get('general.extendedLogging'),
  });
  const untapConsole = fileLogger.tapConsole();

  const cwdCache = new Map<string, RepoId | null>();
  const repoIdFor = (cwd: string): RepoId | null => {
    if (cwdCache.has(cwd)) return cwdCache.get(cwd)!;
    const svc = d
      .repos()
      ?.list()
      .find((s) => samePath(s.cwd, cwd));
    const id = svc?.repo.id ?? null;
    if (id) cwdCache.set(cwd, id);
    return id;
  };
  const outputLog = new OutputLog({
    repoIdFor,
    onAppend: (repoId, entry) => {
      fileLogger.command(entry);
      if (repoId) d.broadcast('git:output:append', { repoId, entry });
    },
  });

  const notifier = new DesktopNotifier({
    enabled: () => d.settings.get('notifications.desktop'),
    isFocused: d.isFocused,
    show: d.showNotification,
    focusWindow: d.focusWindow,
    repoName: (id) => {
      try {
        const info = d.repos()?.get(id).repo;
        const p = info?.worktreeRoot ?? info?.gitDir;
        return p ? path.basename(p.replace(/[\\/]\.git$/, '')) : undefined;
      } catch {
        return undefined;
      }
    },
  });

  const repo = (id: RepoId): GitService => {
    const r = d.repos();
    if (!r) throw new Error('Repositories are not ready yet.');
    return r.get(id);
  };

  const autoFetch = new AutoFetchScheduler({
    settings: () => ({
      intervalMin: d.settings.get('general.autoFetchInterval'),
      prune: d.settings.get('general.autoPrune'),
    }),
    fetch: (id, prune) =>
      d.repos()!.runOp(id, { type: 'fetch', remote: 'all', prune, background: true }, true),
    hasRemotes: async (id) => (await repo(id).remotes()).length > 0,
    isBare: (id) => {
      try {
        return repo(id).repo.isBare;
      } catch {
        return true;
      }
    },
    isBusy: (id) => d.repos()?.isBusy(id) ?? false,
    isOnline: d.isOnline,
    emit: (st) => d.broadcast('sync:autoFetch:state', st),
    onFailure: (id, err, paused) => {
      fileLogger.log('warn', 'auto-fetch', `${id}: ${err.code} ${err.message}${paused ? ' (paused)' : ''}`);
      if (!d.settings.get('notifications.autoFetchErrors')) return;
      d.toast({
        id: `autofetch-error:${id}`,
        kind: 'warning',
        title: paused ? 'Auto-fetch paused: authentication required' : 'Auto-fetch failed',
        body: err.message,
      });
    },
  });

  const opBehaviour = new OpBehaviour({
    settings: (k) => d.settings.get(k),
    runOp: (id, op, background) => d.repos()!.runOp(id, op, background),
    log: (m, e) => fileLogger.log('warn', 'behaviour', `${m} ${e instanceof Error ? e.message : (e ?? '')}`),
  });

  const identity = (): CommitIdentity | null => {
    const p = d.settings.activeProfile;
    return p ? { name: p.authorName, email: p.authorEmail } : null;
  };

  const handlers: BehaviourHandlers & OutputHandlers = {
    ...createOutputHandlers(outputLog),
    ...createBehaviourHandlers({
      repos: { get: repo },
      autoFetch: {
        state: (id) => autoFetch.state(id),
        resume: (id) => autoFetch.resume(id),
        // the focused tab also drives watcher suspension of background repos (spec 02 §6.14)
        setActive: (id) => {
          autoFetch.setActive(id);
          d.repos()?.setActiveRepo(id);
        },
      },
      notifier,
      profile: () => d.settings.activeProfile,
      openLogsFolder: async () => {
        fs.mkdirSync(logsDir, { recursive: true });
        await d.openPath(logsDir);
      },
    }),
  };

  return {
    outputLog,
    fileLogger,
    notifier,
    /** OS attention hooks shared with other notifiers (Launchpad PR events). */
    os: {
      isOnline: d.isOnline,
      isFocused: d.isFocused,
      showNotification: d.showNotification,
      focusWindow: d.focusWindow,
    },
    autoFetch,
    opBehaviour,
    handlers,
    logsDir,
    /** `new GitEngine({ onCommand })`. */
    onCommand: outputLog.onCommand,
    /** Spread into `new RepoManager({ ... })` (and drop its built-in `autoFetch` option). */
    repoManagerOptions: {
      identity,
      behaviour: opBehaviour,
      // post-cancel / post-crash lock cleanup is logged to the output log (spec 02 §6.2 step 4)
      onLocksRemoved: (id: RepoId, opId: string, paths: string[]) => {
        let cwd: string;
        try {
          cwd = repo(id).cwd;
        } catch {
          return;
        }
        outputLog.append({
          id: `locks-${opId}`,
          opId,
          argv: ['(githappens: remove lock files left by the cancelled operation)'],
          cwd,
          startedAt: Date.now(),
          durationMs: 0,
          exitCode: 0,
          stdoutPreview: paths.map((p) => `removed ${p}`).join('\n'),
          stderr: '',
        });
        fileLogger.log('info', 'locks', `${id}: removed ${paths.join(', ')}`);
      },
      onOpened: (id: RepoId) => {
        cwdCache.clear();
        autoFetch.add(id);
      },
      onClosed: (id: RepoId) => {
        cwdCache.clear();
        autoFetch.remove(id);
        outputLog.forget(id);
      },
    },
    /** Call from the RepoManager `onOpState` hook. */
    onOpState: (repoId: RepoId, e: OpStateEvent): void => {
      const background = e.type === 'fetch' && autoFetch.isRunning(repoId);
      autoFetch.onOpState(repoId, e);
      // background maintenance (commit-graph write) is shown in the status bar only, never notified
      if (e.type !== 'maintenance.commitGraph') {
        notifier.onOpState(repoId, e, {
          background,
          notifyBackgroundFailure: d.settings.get('notifications.autoFetchErrors'),
        });
      }
      if (e.state === 'failed' && e.error) {
        fileLogger.log('warn', 'op', `${e.label} failed: ${e.error.code} ${e.error.message}`);
      }
    },
    /** Call from `settings.on('changed')`. */
    onSettingChanged: (change: SettingsChange): void => {
      if (change.key === 'general.autoFetchInterval' || change.key === 'general.autoPrune') {
        autoFetch.reschedule();
      }
    },
    dispose: (): void => {
      autoFetch.dispose();
      untapConsole();
    },
  };
}

export type BehaviourServices = ReturnType<typeof createBehaviourServices>;
