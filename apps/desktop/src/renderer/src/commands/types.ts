import type { ComponentType } from 'react';

/** Command / palette data model (spec 01 §5). Kept DOM-free so it can be unit-tested in node. */

export type FocusZone =
  | 'graph'
  | 'leftPanel'
  | 'rightPanel'
  | 'wipFiles'
  | 'textInput'
  | 'editor'
  | 'terminal'
  | 'palette'
  | 'modal';

export interface CommandContext {
  activeRepo?: string;
  hasRemotes: boolean;
  hasWip: boolean;
  hasStashes: boolean;
  isDetached: boolean;
  lfsEnabled: boolean;
  gitflowEnabled: boolean;
  focus: FocusZone;
}

export type CommandCategory =
  | 'Repo'
  | 'Settings'
  | 'View'
  | 'History'
  | 'Core'
  | 'File'
  | 'Stash'
  | 'Branch'
  | 'Checkout'
  | 'Patch'
  | 'Logs'
  | 'Worktree';

export type ArgKind =
  | 'file'
  | 'branch'
  | 'remoteBranch'
  | 'tag'
  | 'stash'
  | 'profile'
  | 'repo'
  | 'theme'
  | 'commitQuery'
  | 'text'
  | 'worktree'
  | 'workspace';

/** Platform-specific accelerator labels shown as hints, e.g. `{ win: 'Ctrl+B', mac: 'Cmd+B' }`. */
export interface KeybindingHint {
  win: string;
  mac: string;
}

export type CommandIcon = ComponentType<{ size?: number; className?: string }>;

export interface CommandDef {
  id: string;
  title: string;
  category: CommandCategory;
  arg?: { kind: ArgKind; placeholder?: string };
  /** Enablement; disabled commands are listed greyed out and cannot run. */
  when?: (ctx: CommandContext) => boolean;
  /** Optional explanation shown for a disabled command. */
  whenReason?: (ctx: CommandContext) => string | undefined;
  run: (ctx: CommandContext, arg?: string) => Promise<void> | void;
  keybinding?: KeybindingHint;
  icon?: CommandIcon;
  /** Extra search terms (matched with a small penalty when the title does not match). */
  keywords?: string[];
}
