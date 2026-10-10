import type { DiffSpec, RepoId } from '@githappens/git/types';

/**
 * External tools / "Open in…" IPC (spec 12 §4.10 / §6.10, spec 07 §6.9, spec 08 §4.8 / §6.8, spec 13 External
 * Tools). Every launch is an argv array spawned without a shell; paths never become command strings.
 */

export type ToolKind = 'editor' | 'terminal' | 'diff' | 'merge';

/** One known tool and where it was found on this machine. */
export interface DetectedTool {
  /** The settings enum value (`vscode`, `windows-terminal`, `kdiff3`…). */
  id: string;
  label: string;
  /** Resolved executable (or app bundle on macOS); null when not found. */
  path: string | null;
  /** How it was found. */
  source: 'path' | 'install' | 'builtin' | null;
}

export interface DetectedTools {
  platform: NodeJS.Platform;
  editors: DetectedTool[];
  terminals: DetectedTool[];
  /** Diff and merge tools share one list (`TOOL_PRESETS`). */
  diffTools: DetectedTool[];
  /** Epoch ms of the scan; results are cached until `refresh`. */
  scannedAt: number;
}

/**
 * A path argument: absolute, or repo-relative when `repoId` is given (main resolves it inside the working tree
 * and refuses anything that escapes it).
 */
export interface ToolPathRef {
  path: string;
  repoId?: RepoId;
}

/** What a launch did, for toasts ("Opened in VS Code"). */
export interface LaunchResult {
  /** Human name of what was started ("VS Code", "default program", "file manager"). */
  launched: string;
}

/**
 * External diff of one file (spec 07 §6.9). Revisions follow the center diff view: `''` = the file does not
 * exist on that side, `'WORKTREE'` = the working-tree file, `'INDEX'` = stage 0, else any git revision.
 */
export interface ExternalDiffRequest {
  repoId: RepoId;
  path: string;
  /** Old-side path for renames. */
  oldPath?: string;
  oldRev: string;
  newRev: string;
  /** The diff the user is looking at; lets "Git config default" pick `--cached` / commit ranges exactly. */
  spec?: DiffSpec;
}

export interface MergeToolRequest {
  repoId: RepoId;
  path: string;
  /** Caller-chosen id so `tools:mergeTool:cancel` can stop waiting. */
  waitId?: string;
}

export interface MergeToolResult {
  /** `tool` = Strategy B (our temp files), `git` = Strategy A (`git mergetool`). */
  strategy: 'tool' | 'git';
  /** Tool name for messages. */
  tool: string;
  exitCode: number | null;
  /** The worktree file changed while the tool ran. */
  changed: boolean;
  hasMarkers: boolean;
  /** The file was marked resolved (staged) through the op queue. */
  resolved: boolean;
  /** The user stopped waiting; nothing was marked. */
  cancelled: boolean;
  /** `<file>.orig` kept by `tools.mergeToolKeepBackup`. */
  backupPath?: string;
}

export interface ToolsIpcContract {
  'tools:detect': { req: { refresh?: boolean }; res: DetectedTools };
  /** Preferences "Test" button: launch the configured tool on throwaway temp files (spec 13 §7 step 13). */
  'tools:test': { req: { kind: ToolKind }; res: LaunchResult };
  'open:editor': { req: ToolPathRef & { line?: number }; res: LaunchResult };
  'open:terminal': { req: { cwd: string; repoId?: RepoId }; res: LaunchResult };
  /** Reveal a file in its folder, or open a folder (`shell.showItemInFolder` / `shell.openPath`). */
  'open:fileManager': { req: ToolPathRef; res: LaunchResult };
  /** Open with the OS default application (`shell.openPath`). */
  'open:default': { req: ToolPathRef; res: LaunchResult };
  /** Absolute path of a repo file (for "Copy full path"). */
  'tools:resolvePath': { req: { repoId: RepoId; path: string }; res: { path: string } };
  'tools:openDiff': { req: ExternalDiffRequest; res: LaunchResult & { via: 'tool' | 'git-difftool' } };
  /** Resolves when the tool exits (or the wait is cancelled). */
  'tools:mergeTool': { req: MergeToolRequest; res: MergeToolResult };
  'tools:mergeTool:cancel': { req: { waitId: string }; res: void };
}

export const TOOLS_INVOKE_CHANNELS = [
  'tools:detect',
  'tools:test',
  'open:editor',
  'open:terminal',
  'open:fileManager',
  'open:default',
  'tools:resolvePath',
  'tools:openDiff',
  'tools:mergeTool',
  'tools:mergeTool:cancel',
] as const satisfies readonly (keyof ToolsIpcContract)[];

type Exhaustive<All, Listed> = [Exclude<All, Listed>] extends [never]
  ? true
  : { missing: Exclude<All, Listed> };
const toolsExhaustive: Exhaustive<keyof ToolsIpcContract, (typeof TOOLS_INVOKE_CHANNELS)[number]> = true;
void toolsExhaustive;
