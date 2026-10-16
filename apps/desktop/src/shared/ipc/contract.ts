import type { IpcResult } from '@githappens/git/types';

import { ABOUT_INVOKE_CHANNELS, type AboutIpcContract } from './about-contract';
import {
  CLOUD_WORKSPACES_EVENT_CHANNELS,
  CLOUD_WORKSPACES_INVOKE_CHANNELS,
  type CloudWorkspacesEventContract,
  type CloudWorkspacesIpcContract,
} from './cloud-workspaces-contract';
import {
  INSIGHTS_EVENT_CHANNELS,
  INSIGHTS_INVOKE_CHANNELS,
  type InsightsEventContract,
  type InsightsIpcContract,
} from './insights-contract';
import {
  SUGGEST_EVENT_CHANNELS,
  SUGGEST_INVOKE_CHANNELS,
  type SuggestEventContract,
  type SuggestIpcContract,
} from './suggest-contract';
import {
  AI_EVENT_CHANNELS,
  AI_INVOKE_CHANNELS,
  type AiEventContract,
  type AiIpcContract,
} from './ai-contract';
import {
  CLOUD_EVENT_CHANNELS,
  CLOUD_INVOKE_CHANNELS,
  type CloudEventContract,
  type CloudIpcContract,
} from './cloud-contract';
import {
  PATCHES_EVENT_CHANNELS,
  PATCHES_INVOKE_CHANNELS,
  type PatchesEventContract,
  type PatchesIpcContract,
} from './patches-contract';
import {
  BEHAVIOUR_EVENT_CHANNELS,
  BEHAVIOUR_INVOKE_CHANNELS,
  type BehaviourEventContract,
  type BehaviourIpcContract,
} from './behaviour-contract';
import {
  FILES_EVENT_CHANNELS,
  FILES_INVOKE_CHANNELS,
  type FilesEventContract,
  type FilesIpcContract,
} from './files-contract';
import { GRAPH_INVOKE_CHANNELS, type GraphIpcContract } from './graph-contract';
import {
  COMMIT_EVENT_CHANNELS,
  COMMIT_INVOKE_CHANNELS,
  type CommitEventContract,
  type CommitIpcContract,
} from './commit-contract';
import { REMOTES_INVOKE_CHANNELS, type RemotesIpcContract } from './remotes-contract';
import { REPOS2_INVOKE_CHANNELS, type Repos2IpcContract } from './repos2-contract';
import { SYNC_INVOKE_CHANNELS, type SyncIpcContract } from './sync-contract';
import {
  UNDO_EVENT_CHANNELS,
  UNDO_INVOKE_CHANNELS,
  type UndoEventContract,
  type UndoIpcContract,
} from './undo-contract';
import {
  SHELL2_EVENT_CHANNELS,
  SHELL2_INVOKE_CHANNELS,
  type Shell2EventContract,
  type Shell2IpcContract,
} from './shell2-contract';
import { TOOLS_INVOKE_CHANNELS, type ToolsIpcContract } from './tools-contract';
import {
  NETWORK_EVENT_CHANNELS,
  NETWORK_INVOKE_CHANNELS,
  type NetworkEventContract,
  type NetworkIpcContract,
} from './network-contract';
import {
  CONFLICTS_EVENT_CHANNELS,
  CONFLICTS_INVOKE_CHANNELS,
  type ConflictsEventContract,
  type ConflictsIpcContract,
} from './conflicts-contract';
import {
  AGENTS_EVENT_CHANNELS,
  AGENTS_INVOKE_CHANNELS,
  type AgentsEventContract,
  type AgentsIpcContract,
} from './agents-contract';
import type { AppEventContract, AppIpcContract } from './app-contract';
import type { GitEventContract, GitIpcContract } from './git-contract';
import { GITFLOW_INVOKE_CHANNELS, type GitflowIpcContract } from './gitflow-contract';
import {
  PREFS_EVENT_CHANNELS,
  PREFS_INVOKE_CHANNELS,
  type PrefsEventContract,
  type PrefsIpcContract,
} from './prefs-contract';
import {
  INTEGRATIONS_EVENT_CHANNELS,
  INTEGRATIONS_INVOKE_CHANNELS,
  type IntegrationsEventContract,
  type IntegrationsIpcContract,
} from './integrations-contract';
import type { ShellEventContract, ShellIpcContract } from './shell-contract';
import {
  LAUNCHPAD_EVENT_CHANNELS,
  LAUNCHPAD_INVOKE_CHANNELS,
  type LaunchpadEventContract,
  type LaunchpadIpcContract,
} from './launchpad-contract';
import {
  WORKSPACES_EVENT_CHANNELS,
  WORKSPACES_INVOKE_CHANNELS,
  type WorkspacesEventContract,
  type WorkspacesIpcContract,
} from './workspaces-contract';
import {
  UPDATE_EVENT_CHANNELS,
  UPDATE_INVOKE_CHANNELS,
  type UpdateEventContract,
  type UpdateIpcContract,
} from './update-contract';
import {
  TERMINAL_EVENT_CHANNELS,
  TERMINAL_INVOKE_CHANNELS,
  type TerminalEventContract,
  type TerminalIpcContract,
} from './terminal-contract';

/**
 * The single typed IPC contract (spec 00 §3). Preload and main handlers are both
 * type-checked against it. Every invoke returns `IpcResult<res>`.
 */
export interface IpcContract
  extends
    AppIpcContract,
    GitIpcContract,
    ShellIpcContract,
    TerminalIpcContract,
    PrefsIpcContract,
    IntegrationsIpcContract,
    UpdateIpcContract,
    AboutIpcContract,
    AgentsIpcContract,
    GitflowIpcContract,
    WorkspacesIpcContract,
    LaunchpadIpcContract,
    AiIpcContract,
    CloudIpcContract,
    ConflictsIpcContract,
    PatchesIpcContract,
    NetworkIpcContract,
    BehaviourIpcContract,
    ToolsIpcContract,
    GraphIpcContract,
    FilesIpcContract,
    RemotesIpcContract,
    Shell2IpcContract,
    CommitIpcContract,
    SyncIpcContract,
    UndoIpcContract,
    Repos2IpcContract,
    SuggestIpcContract,
    InsightsIpcContract,
    CloudWorkspacesIpcContract {}
export interface EventContract
  extends
    AppEventContract,
    GitEventContract,
    ShellEventContract,
    TerminalEventContract,
    PrefsEventContract,
    IntegrationsEventContract,
    UpdateEventContract,
    AgentsEventContract,
    WorkspacesEventContract,
    LaunchpadEventContract,
    AiEventContract,
    CloudEventContract,
    ConflictsEventContract,
    PatchesEventContract,
    NetworkEventContract,
    BehaviourEventContract,
    FilesEventContract,
    Shell2EventContract,
    CommitEventContract,
    UndoEventContract,
    SuggestEventContract,
    InsightsEventContract,
    CloudWorkspacesEventContract {}

export type InvokeChannel = keyof IpcContract;
export type EventChannel = keyof EventContract;
export type Req<C extends InvokeChannel> = IpcContract[C]['req'];
export type Res<C extends InvokeChannel> = IpcContract[C]['res'];

/** Runtime allowlists used by preload; the type checks below keep them exhaustive. */
export const INVOKE_CHANNELS = [
  'app:getVersionInfo',
  'app:secretStoreStatus',
  'settings:getAll',
  'settings:set',
  'settings:reset',
  'shell:getInitialState',
  'shell:saveTabs',
  'shell:saveLayout',
  'shell:openPath',
  'shell:openExternal',
  'shell:copyText',
  'shell:setTitleBarColors',
  'repos:list',
  'repos:open',
  'repos:pickFolder',
  'repos:removeRecent',
  'repos:setFavorite',
  'repos:clone',
  'repos:cancel',
  'repos:init',
  'git:engine:info',
  'git:engine:setExecutable',
  'git:repo:open',
  'git:repo:close',
  'git:repo:info',
  'git:status',
  'git:log:start',
  'git:log:next',
  'git:log:dispose',
  'git:commit:detail',
  'git:refs',
  'git:revParse',
  'git:diff',
  'git:diff:numstat',
  'git:show:file',
  'git:worktree:readFile',
  'git:stash:list',
  'git:remotes',
  'graph:search',
  'git:checkout:preflight',
  'git:branch:validateName',
  'git:branch:cleanupScan',
  'git:commit:headMessage',
  'git:undo:peek',
  'git:conflict:state',
  'git:conflict:loadFile',
  'git:conflict:predict',
  'git:rebase:todoFor',
  'git:blame',
  'git:worktrees',
  'git:submodules',
  'git:lfs:status',
  'git:isAncestor',
  'git:mergeBase',
  'git:conflicts',
  'git:config:list',
  'git:config:get',
  'git:config:set',
  'git:perf:advice',
  'git:watch:state',
  'git:commit:verify',
  'git:op:run',
  'git:op:cancel',
  'git:lock:remove',
  'git:prompt:answer',
  ...TERMINAL_INVOKE_CHANNELS,
  ...PREFS_INVOKE_CHANNELS,
  ...INTEGRATIONS_INVOKE_CHANNELS,
  ...UPDATE_INVOKE_CHANNELS,
  ...ABOUT_INVOKE_CHANNELS,
  ...AGENTS_INVOKE_CHANNELS,
  ...GITFLOW_INVOKE_CHANNELS,
  ...WORKSPACES_INVOKE_CHANNELS,
  ...LAUNCHPAD_INVOKE_CHANNELS,
  ...AI_INVOKE_CHANNELS,
  ...CLOUD_INVOKE_CHANNELS,
  ...CONFLICTS_INVOKE_CHANNELS,
  ...PATCHES_INVOKE_CHANNELS,
  ...NETWORK_INVOKE_CHANNELS,
  ...BEHAVIOUR_INVOKE_CHANNELS,
  ...TOOLS_INVOKE_CHANNELS,
  ...GRAPH_INVOKE_CHANNELS,
  ...FILES_INVOKE_CHANNELS,
  ...REMOTES_INVOKE_CHANNELS,
  ...SHELL2_INVOKE_CHANNELS,
  ...COMMIT_INVOKE_CHANNELS,
  ...SYNC_INVOKE_CHANNELS,
  ...UNDO_INVOKE_CHANNELS,
  ...REPOS2_INVOKE_CHANNELS,
  ...SUGGEST_INVOKE_CHANNELS,
  ...INSIGHTS_INVOKE_CHANNELS,
  ...CLOUD_WORKSPACES_INVOKE_CHANNELS,
] as const satisfies readonly InvokeChannel[];

export const EVENT_CHANNELS = [
  'settings:changed',
  'shell:toast',
  'git:engine:changed',
  'git:repo:changed',
  'app:openRepoRequest',
  'repos:cloneProgress',
  'git:op:state',
  'git:progress',
  'git:prompt',
  ...TERMINAL_EVENT_CHANNELS,
  ...PREFS_EVENT_CHANNELS,
  ...INTEGRATIONS_EVENT_CHANNELS,
  ...UPDATE_EVENT_CHANNELS,
  ...AGENTS_EVENT_CHANNELS,
  ...WORKSPACES_EVENT_CHANNELS,
  ...LAUNCHPAD_EVENT_CHANNELS,
  ...AI_EVENT_CHANNELS,
  ...CLOUD_EVENT_CHANNELS,
  ...CONFLICTS_EVENT_CHANNELS,
  ...PATCHES_EVENT_CHANNELS,
  ...NETWORK_EVENT_CHANNELS,
  ...BEHAVIOUR_EVENT_CHANNELS,
  ...FILES_EVENT_CHANNELS,
  ...SHELL2_EVENT_CHANNELS,
  ...COMMIT_EVENT_CHANNELS,
  ...UNDO_EVENT_CHANNELS,
  ...SUGGEST_EVENT_CHANNELS,
  ...INSIGHTS_EVENT_CHANNELS,
  ...CLOUD_WORKSPACES_EVENT_CHANNELS,
] as const satisfies readonly EventChannel[];

type Exhaustive<All, Listed> = [Exclude<All, Listed>] extends [never]
  ? true
  : { missing: Exclude<All, Listed> };
const invokeExhaustive: Exhaustive<InvokeChannel, (typeof INVOKE_CHANNELS)[number]> = true;
const eventExhaustive: Exhaustive<EventChannel, (typeof EVENT_CHANNELS)[number]> = true;
void invokeExhaustive;
void eventExhaustive;

const invokeSet: ReadonlySet<string> = new Set(INVOKE_CHANNELS);
const eventSet: ReadonlySet<string> = new Set(EVENT_CHANNELS);
export const isInvokeChannel = (c: string): c is InvokeChannel => invokeSet.has(c);
export const isEventChannel = (c: string): c is EventChannel => eventSet.has(c);

type Unsubscribe = () => void;

type GitInvokeChannel = Extract<InvokeChannel, `git:${string}`>;
type GitEventChannel = Extract<EventChannel, `git:${string}`>;

/** Shape of `window.api` exposed by the preload via contextBridge. */
export interface GitHappensApi {
  invoke<C extends InvokeChannel>(channel: C, req: Req<C>): Promise<IpcResult<Res<C>>>;
  on<E extends EventChannel>(event: E, cb: (payload: EventContract[E]) => void): Unsubscribe;
  /** `window.api.git` namespace (spec 01 §7 step 2 / spec 02 §5.3). */
  git: {
    invoke<C extends GitInvokeChannel>(channel: C, req: Req<C>): Promise<IpcResult<Res<C>>>;
    on<E extends GitEventChannel>(event: E, cb: (payload: EventContract[E]) => void): Unsubscribe;
  };
  platform: NodeJS.Platform;
  /** Absolute path of a dropped File (Electron webUtils); folders dropped onto the window. */
  pathForFile?(file: File): string;
}
