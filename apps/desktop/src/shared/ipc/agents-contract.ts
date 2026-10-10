import type { TerminalId } from './terminal-contract';

/**
 * Agent Sessions view (spec 12 §4.12). Sessions are integrated
 * terminals whose foreground process is a known coding agent, plus (best effort, read-only)
 * agents started outside the app whose process cwd lies under one of the requested worktrees.
 */

export type AgentKind = 'claude' | 'codex' | 'copilot' | 'gemini' | 'custom';

/** `running`: output in the last 2 s; `waiting`: prompt-like last line and quiet for > 10 s. */
export type AgentStatus = 'running' | 'waiting' | 'idle' | 'exited';

export interface AgentSession {
  /** Stable key: the pty id, or `ext-<pid>` for external sessions. */
  id: string;
  /** Integrated terminal running the agent (absent for external sessions). */
  ptyId?: TerminalId;
  /** Agent process id when known. */
  pid?: number;
  kind: AgentKind;
  /** e.g. `claude — feature-x`. */
  label: string;
  /** Detected / launched executable name, e.g. `claude`, `node`. */
  command: string;
  status: AgentStatus;
  /** ms since epoch (session or detection start). */
  startedAt: number;
  /** ms since epoch of the last pty output (absent for external sessions). */
  lastOutputAt?: number;
  /** Working directory the pty / process was started in. */
  cwd: string;
  /** The requested worktree path containing `cwd` (longest match), or null. */
  worktreePath: string | null;
  /** True when the agent was started by our "New agent session" (a dedicated agent tab). */
  launched?: boolean;
  /** Found outside the app by process cwd; read-only (no focus / stop). */
  external?: boolean;
  exitCode?: number;
}

export interface AgentStartRequest {
  /** Worktree folder to run the agent in. */
  cwd: string;
  /** Defaults to the `tools.agentCommand` setting. */
  command?: string;
  /** Defaults to `tools.agentArgs` when `command` is omitted. */
  args?: string[];
  cols?: number;
  rows?: number;
  /**
   * Repo agent setup commands (`githappens.agentSetup`): `auto` (default) runs them once per
   * worktree, `force` runs them again, `skip` never. They are typed visibly into the agent tab's
   * shell before the agent command.
   */
  setup?: 'auto' | 'force' | 'skip';
}

export interface AgentStartResult {
  ptyId: TerminalId;
  label: string;
  /** Setup commands being typed into the session's shell before the agent (absent: none ran). */
  setupCommands?: string[];
}

export interface AgentsIpcContract {
  /** Sessions of the calling window (+ external ones when `external`), mapped onto `worktreePaths`. */
  'agents:list': { req: { worktreePaths: string[]; external?: boolean }; res: AgentSession[] };
  /**
   * Starts the agent in a new pty owned by the calling window. The pty records output until a
   * terminal view binds to it with `terminal:attach`.
   */
  'agents:start': { req: AgentStartRequest; res: AgentStartResult };
  /** Sends Ctrl+C; `force` kills the process. On an exited session it dismisses the record. */
  'agents:stop': { req: { ptyId: TerminalId; force?: boolean }; res: void };
  /** The repo's agent setup commands (`git config --get-all githappens.agentSetup`). */
  'agents:setup:get': { req: { repoPath: string }; res: string[] };
  /** Replaces them (`--local`, one value per command; empty lines dropped). Returns the saved list. */
  'agents:setup:set': { req: { repoPath: string; commands: string[] }; res: string[] };
}

export interface AgentsEventContract {
  /** Something in the session list changed (start / exit / status / detection); re-list. */
  'agents:changed': { reason: 'started' | 'exited' | 'stopped' | 'status' };
}

export const AGENTS_INVOKE_CHANNELS = [
  'agents:list',
  'agents:start',
  'agents:stop',
  'agents:setup:get',
  'agents:setup:set',
] as const satisfies readonly (keyof AgentsIpcContract)[];

export const AGENTS_EVENT_CHANNELS = [
  'agents:changed',
] as const satisfies readonly (keyof AgentsEventContract)[];

type Exhaustive<All, Listed> = [Exclude<All, Listed>] extends [never]
  ? true
  : { missing: Exclude<All, Listed> };
const invokeExhaustive: Exhaustive<keyof AgentsIpcContract, (typeof AGENTS_INVOKE_CHANNELS)[number]> = true;
const eventExhaustive: Exhaustive<keyof AgentsEventContract, (typeof AGENTS_EVENT_CHANNELS)[number]> = true;
void invokeExhaustive;
void eventExhaustive;
