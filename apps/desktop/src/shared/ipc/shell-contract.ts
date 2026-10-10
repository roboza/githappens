/** App shell + repository registry contract (specs 01 §5, 03 §5). */

export type TabKind = 'repo' | 'newTab' | 'launchpad' | 'workspace' | 'repoManagement';

export interface TabDescriptor {
  id: string;
  kind: TabKind;
  repoPath?: string;
  alias?: string;
  worktreeOf?: string;
  workspaceId?: string;
}

export interface TabsState {
  tabs: TabDescriptor[];
  activeTabId: string | null;
}

export interface LayoutState {
  leftPanelWidth: number;
  leftPanelCollapsed: boolean;
  rightPanelWidth: number;
  rightPanelCollapsed: boolean;
  terminalHeight: number;
  terminalOpen: boolean;
}

export const DEFAULT_LAYOUT: LayoutState = {
  leftPanelWidth: 260,
  leftPanelCollapsed: false,
  rightPanelWidth: 380,
  rightPanelCollapsed: false,
  terminalHeight: 240,
  terminalOpen: false,
};

export interface RepoRecord {
  path: string;
  name: string;
  alias?: string;
  isBare: boolean;
  commonDir?: string;
  remoteUrl?: string;
  lastOpenedAt?: number;
  lastBranch?: string;
  favorite: boolean;
  favoriteOrder?: number;
  groupIds: string[];
  missing?: boolean;
}

export type OpenRepoResult =
  | { ok: true; repo: RepoRecord }
  | {
      ok: false;
      reason: 'notFound' | 'notARepo' | 'permission' | 'unsafeDirectory';
      path: string;
      message: string;
    };

export interface CloneRequest {
  url: string;
  parentDir: string;
  folderName: string;
  depth?: number;
  branch?: string;
  recurseSubmodules?: boolean;
}

export interface InitRequest {
  parentDir: string;
  name: string;
  defaultBranch: string;
  gitignore?: string;
  readme: boolean;
  initialCommit: boolean;
}

export interface ShellIpcContract {
  'shell:getInitialState': { req: Record<string, never>; res: { tabs: TabsState; layout: LayoutState } };
  'shell:saveTabs': { req: TabsState; res: void };
  'shell:saveLayout': { req: LayoutState; res: void };
  'shell:openPath': { req: { path: string }; res: void };
  'shell:openExternal': { req: { url: string }; res: void };
  'shell:copyText': { req: { text: string }; res: void };
  /** Keep the native window-controls overlay (Win/Linux) in step with the theme. */
  'shell:setTitleBarColors': { req: { background: string; foreground: string }; res: void };
  'repos:list': { req: Record<string, never>; res: RepoRecord[] };
  'repos:open': { req: { path: string }; res: OpenRepoResult };
  'repos:pickFolder': { req: Record<string, never>; res: string | null };
  'repos:removeRecent': { req: { path: string }; res: void };
  'repos:setFavorite': { req: { path: string; favorite: boolean }; res: void };
  /** Clone with progress on `repos:cloneProgress`; resolves with the new repo path (spec 03). */
  'repos:clone': { req: CloneRequest & { opId: string }; res: { path: string } };
  'repos:cancel': { req: { opId: string }; res: void };
  'repos:init': { req: InitRequest; res: { path: string } };
}

export interface ShellEventContract {
  'app:openRepoRequest': { path: string };
  'repos:cloneProgress': {
    opId: string;
    phase: string;
    percent: number | null;
    overall: number | null;
    text: string;
  };
}
