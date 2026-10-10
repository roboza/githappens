import type { GitExecutableInfo, RepoId } from '@githappens/git/types';

/**
 * App shell completion channels (spec 01 §4.11–4.13, §5; spec 12 §4.8 / §6.8): native application
 * menu, window state / fullscreen, repo aliases, the fuzzy file finder's file list and a few palette
 * helpers. Merged into the main `IpcContract` / `EventContract`.
 */

// ---- window ----------------------------------------------------------------------------------------

export interface WindowStateInfo {
  fullscreen: boolean;
  maximized: boolean;
  focused: boolean;
}

// ---- application menu ------------------------------------------------------------------------------

export interface MenuRecentRepo {
  path: string;
  label: string;
}

export interface MenuProfile {
  id: string;
  name: string;
  active: boolean;
}

/**
 * Everything the menu builder needs from the renderer (the command registry and keybinding service live
 * there). Sent debounced whenever bindings, registered commands, the active context, recents or
 * profiles change.
 */
export interface MenuRebuildRequest {
  /** Primary normalized chord per command (`ctrl+shift+s`, `meta+alt+1`), as resolved for this platform. */
  accelerators: Record<string, string>;
  /** Registered commands and whether they are enabled in the current context; absent = not registered. */
  enabled: Record<string, boolean>;
  /** Most recent first (File › Open Recent shows up to 10). */
  recent: MenuRecentRepo[];
  profiles: MenuProfile[];
}

/** A menu click forwarded to the renderer's command registry (spec 01 `menu:invoke`). */
export interface MenuInvokeEvent {
  commandId: string;
  arg?: string;
  /**
   * Edit › Undo / Redo: when a text field has focus the renderer runs the native text edit instead of
   * the git command (spec 01 §4.11).
   */
  textEdit?: 'undo' | 'redo';
}

// ---- maintenance / patches -------------------------------------------------------------------------

export interface MaintenanceResult {
  /** Commands that ran, e.g. `git maintenance run --task=gc`. */
  steps: string[];
}

export interface Shell2IpcContract {
  'window:getState': { req: Record<string, never>; res: WindowStateInfo };
  'window:toggleFullscreen': { req: Record<string, never>; res: boolean };
  'window:setFullscreen': { req: { on: boolean }; res: boolean };
  'window:minimize': { req: Record<string, never>; res: void };
  /** Toggles maximize / restore; resolves with the new maximized state. */
  'window:maximize': { req: Record<string, never>; res: boolean };
  'window:close': { req: Record<string, never>; res: void };
  'menu:rebuild': { req: MenuRebuildRequest; res: void };
  /** Pop the application menu up (Win/Linux hamburger / lone Alt), at window coordinates. */
  'menu:popup': { req: { x?: number; y?: number }; res: void };
  /** Set (or with `null` remove) the alias of a recent repository (spec 01 §4.2, spec 03). */
  'repos:setAlias': { req: { path: string; alias: string | null }; res: void };
  /**
   * Tracked + untracked-not-ignored files (`git ls-files -co --exclude-standard -z`), repo-relative with
   * forward slashes. Cached per repo; the watcher invalidates it (spec 12 §6.8).
   */
  'files:list': { req: { repoId: RepoId; refresh?: boolean }; res: string[] };
  /** Delete a worktree file (palette `file.delete`; the renderer confirms first). */
  'files:delete': { req: { repoId: RepoId; path: string }; res: void };
  /** Save `git diff HEAD --binary` to a file chosen in a save dialog (palette `patch.createFromWip`). */
  'wip:savePatch': { req: { repoId: RepoId }; res: { saved: boolean; path?: string } };
  /** `git maintenance run --task=gc` (git ≥ 2.29, else `git gc --auto`) + commit-graph write (spec 01 §6). */
  'repo:maintenance': { req: { repoId: RepoId }; res: MaintenanceResult };
  /** Re-resolve the login-shell environment and re-detect git (spec 02 "Reload shell environment"). */
  'shell:reloadEnv': { req: Record<string, never>; res: GitExecutableInfo };
}

export interface Shell2EventContract {
  'menu:invoke': MenuInvokeEvent;
  'window:state': WindowStateInfo;
}

export const SHELL2_INVOKE_CHANNELS = [
  'window:getState',
  'window:toggleFullscreen',
  'window:setFullscreen',
  'window:minimize',
  'window:maximize',
  'window:close',
  'menu:rebuild',
  'menu:popup',
  'repos:setAlias',
  'files:list',
  'files:delete',
  'wip:savePatch',
  'repo:maintenance',
  'shell:reloadEnv',
] as const satisfies readonly (keyof Shell2IpcContract)[];

export const SHELL2_EVENT_CHANNELS = [
  'menu:invoke',
  'window:state',
] as const satisfies readonly (keyof Shell2EventContract)[];

type Exhaustive<All, Listed> = [Exclude<All, Listed>] extends [never]
  ? true
  : { missing: Exclude<All, Listed> };
const invokeExhaustive: Exhaustive<keyof Shell2IpcContract, (typeof SHELL2_INVOKE_CHANNELS)[number]> = true;
const eventExhaustive: Exhaustive<keyof Shell2EventContract, (typeof SHELL2_EVENT_CHANNELS)[number]> = true;
void invokeExhaustive;
void eventExhaustive;
