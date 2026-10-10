import path from 'node:path';

import type { GitExecutablePreference, RefreshScope, RepoId } from '@githappens/git';
import { screen, type BrowserWindow, type BrowserWindowConstructorOptions } from 'electron';

import type { Shell2EventContract } from '../../shared/ipc/shell2-contract';
import { FilesFinder } from '../finder/files-finder';
import { createShell2Handlers, windowState, type Shell2Handlers } from '../ipc/shell2-handlers';
import { MenuController } from '../menu/menu-controller';
import type { GitEngine } from '../services/git-engine';
import type { RepoManager } from '../services/repo-manager';
import type { RepoRegistry } from '../services/repo-registry';
import { placeWindow, trackWindow, WindowStateStore } from './window-state';

export interface ShellCompletionOptions {
  userDataDir: string;
  appName: string;
  devTools: boolean;
  repos: RepoManager;
  engine: GitEngine;
  /** `settings.get('git.executable')`. */
  gitPreference(): GitExecutablePreference;
  registry(): RepoRegistry;
  mainWindow(): BrowserWindow | undefined;
  send<E extends keyof Shell2EventContract>(event: E, payload: Shell2EventContract[E]): void;
  saveDialog(o: { title: string; defaultName: string }): Promise<string | null>;
}

/**
 * Main-process wiring for the shell completion (spec 01 §4.11–4.13, spec 12 §6.8): native menu, window
 * state persistence / restore, the file finder cache and the `shell2` IPC handlers. `main/index.ts`
 * creates one of these in `bootstrap`, spreads `handlers` into `registerIpcHandlers`, merges
 * `windowOptions()` into the `BrowserWindow` options and calls `attach(win)` right after creating it.
 */
export function createShellCompletion(o: ShellCompletionOptions) {
  const store = new WindowStateStore(path.join(o.userDataDir, 'windowState.json'));
  const finder = new FilesFinder({
    read: async (repoId, args) =>
      String((await o.repos.get(repoId).runRead(args, { maxBuffer: 1024 * 1024 * 1024 })).stdout),
  });
  const menu = new MenuController({
    appName: o.appName,
    platform: process.platform,
    devTools: o.devTools,
    invoke: (e) => o.send('menu:invoke', e),
    window: o.mainWindow,
  });
  let pending: ReturnType<typeof placeWindow> | null = null;

  const handlers: Shell2Handlers = createShell2Handlers({
    window: o.mainWindow,
    menu,
    registry: o.registry,
    finder,
    repos: { get: (id) => o.repos.get(id) },
    saveDialog: o.saveDialog,
    reloadEnv: () => o.engine.init(o.gitPreference()),
    gitVersion: () => {
      try {
        return o.engine.info.versionTuple;
      } catch {
        return undefined;
      }
    },
  });

  return {
    handlers,
    menu,
    finder,
    /** Install the application menu (call once after `app` is ready). */
    installMenu: (): void => menu.install(),
    /** RepoManager `onChanged` hook: invalidates the file finder cache. */
    onRepoChanged: (repoId: RepoId, scopes: readonly RefreshScope[]): void =>
      finder.onRepoChanged(repoId, scopes),
    /** Restored bounds for `new BrowserWindow(...)` (kept on a connected display, else centered). */
    windowOptions: (): Pick<BrowserWindowConstructorOptions, 'x' | 'y' | 'width' | 'height'> => {
      pending = placeWindow(store.load(), screen.getAllDisplays(), screen.getPrimaryDisplay());
      return { ...pending.bounds };
    },
    /** Re-apply maximized / fullscreen and start persisting this window's state. */
    attach: (win: BrowserWindow): void => {
      const p = pending;
      pending = null;
      win.once('ready-to-show', () => {
        if (p?.maximized) win.maximize();
        if (p?.fullscreen) win.setFullScreen(true);
      });
      trackWindow(win, {
        save: (s) => store.save(s),
        displayFor: (b) => screen.getDisplayMatching(b).id,
        onState: () => o.send('window:state', windowState(win)),
      });
    },
  };
}
