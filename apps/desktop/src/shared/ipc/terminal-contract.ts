/** Integrated terminal contract (spec 12 §4.2). Ptys live in main; xterm.js renders in the renderer. */

export type TerminalId = string;

export interface TerminalCreateRequest {
  /** Working directory (repo / worktree root). Falls back to the home dir if it does not exist. */
  cwd: string;
  cols: number;
  rows: number;
  /** Shell executable; omitted → the OS default (pwsh/powershell on Windows, $SHELL elsewhere). */
  shell?: string;
  /** Shell arguments; omitted → the default args for the chosen shell. */
  args?: string[];
  /** Repo / worktree root exported as `GITHAPPENS_REPO` (defaults to `cwd`). */
  repoPath?: string;
  /**
   * Inject the OSC 7 / OSC 133 shell-integration snippet (bash, zsh, PowerShell with default args;
   * spec 12 §6.1). Other shells start unmodified.
   */
  shellIntegration?: boolean;
}

/** A shell offered by the terminal's shell picker (`terminal:listShells`, spec 12 `pty:listShells`). */
export interface TerminalShell {
  /** Stable id, e.g. `pwsh`, `git-bash`, `wsl:Ubuntu`, `/bin/zsh`. */
  id: string;
  /** Display name, e.g. `PowerShell 7`, `WSL: Ubuntu`. */
  name: string;
  /** Executable. */
  path: string;
  /** Extra args (WSL distro, Git Bash login); omitted → the shell's default args. */
  args?: string[];
}

/** Data for the git autocomplete popup that only main can read (spec 12 §4.3 / §6.2). */
export interface TerminalCompletionContext {
  /** `git config --get-regexp ^alias\.` of the repo (shell aliases `!…` included). */
  aliases: { name: string; expansion: string }[];
  /** Why autocomplete is suppressed (a conflicting completion tool was detected), else null. */
  conflict: string | null;
}

export interface TerminalInfo {
  id: TerminalId;
  /** Process id (may be 0 on Windows until ConPTY has started; `terminal:list` reports the live value). */
  pid: number;
  /** Shell executable that was spawned. */
  shell: string;
  /** Short display name, e.g. `pwsh`, `bash`. */
  shellName: string;
  cwd: string;
  /** Tab label for command terminals (agent sessions), e.g. `claude — feature-x`. */
  label?: string;
  /** Command launched directly (agent sessions) instead of an interactive shell. */
  command?: string;
  /** The shell-integration snippet was injected (OSC 7 / 133 expected). */
  shellIntegration?: boolean;
  /** Last cwd reported by the shell via OSC 7 (`terminal:list`). */
  currentCwd?: string;
}

/** Reply to `terminal:attach`: the session plus recent output to replay into a fresh xterm. */
export interface TerminalAttachResult {
  info: TerminalInfo;
  /** Recent output (bounded, oldest trimmed) recorded while no view was attached. */
  backlog: string;
}

export interface TerminalIpcContract {
  'terminal:create': { req: TerminalCreateRequest; res: TerminalInfo };
  'terminal:write': { req: { id: TerminalId; data: string }; res: void };
  'terminal:resize': { req: { id: TerminalId; cols: number; rows: number }; res: void };
  'terminal:kill': { req: { id: TerminalId }; res: void };
  /** Flow control: the renderer reports how many chars of `terminal:data` xterm has processed. */
  'terminal:ack': { req: { id: TerminalId; chars: number }; res: void };
  /** Terminals owned by the calling window. */
  'terminal:list': { req: Record<string, never>; res: TerminalInfo[] };
  /**
   * Bind a view to a pty started elsewhere (e.g. `agents:start`), or re-bind after the view was
   * unmounted. Output is streamed via `terminal:data` from now on; `backlog` replays the history.
   */
  'terminal:attach': { req: { id: TerminalId; cols: number; rows: number }; res: TerminalAttachResult };
  /** The view went away but the pty keeps running; output is recorded for the next attach. */
  'terminal:detach': { req: { id: TerminalId }; res: void };
  /** Shells installed on this machine (incl. WSL distros on Windows) for the shell picker. */
  'terminal:listShells': { req: Record<string, never>; res: TerminalShell[] };
  /** Git aliases of the repo at `cwd` + completion-conflict detection, for the autocomplete popup. */
  'terminal:completionContext': { req: { cwd: string }; res: TerminalCompletionContext };
}

export interface TerminalEventContract {
  /** Batched pty output (coalesced ~16 ms). Sent only to the owning window. */
  'terminal:data': { id: TerminalId; data: string };
  'terminal:exit': { id: TerminalId; exitCode: number; signal?: number };
}

export const TERMINAL_INVOKE_CHANNELS = [
  'terminal:create',
  'terminal:write',
  'terminal:resize',
  'terminal:kill',
  'terminal:ack',
  'terminal:list',
  'terminal:attach',
  'terminal:detach',
  'terminal:listShells',
  'terminal:completionContext',
] as const satisfies readonly (keyof TerminalIpcContract)[];

export const TERMINAL_EVENT_CHANNELS = [
  'terminal:data',
  'terminal:exit',
] as const satisfies readonly (keyof TerminalEventContract)[];

type Exhaustive<All, Listed> = [Exclude<All, Listed>] extends [never]
  ? true
  : { missing: Exclude<All, Listed> };
const invokeExhaustive: Exhaustive<keyof TerminalIpcContract, (typeof TERMINAL_INVOKE_CHANNELS)[number]> =
  true;
const eventExhaustive: Exhaustive<keyof TerminalEventContract, (typeof TERMINAL_EVENT_CHANNELS)[number]> =
  true;
void invokeExhaustive;
void eventExhaustive;
