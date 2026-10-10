import { create } from 'zustand';

import { recordMru } from './mru';
import type { CommandContext, CommandDef } from './types';

/**
 * Command registry (spec 01 §5 `useCommandRegistry`). Feature modules call `registerCommands` and keep the
 * returned disposer; the palette, menus and shortcuts all dispatch through `runCommand`.
 * Later registrations of the same id shadow earlier ones until they are unregistered.
 */

interface RegistryState {
  /** Every registration in order (may contain duplicate ids). */
  entries: CommandDef[];
  /** Effective commands: one per id, last registration wins, in first-registration order. */
  commands: CommandDef[];
}

function dedupe(entries: CommandDef[]): CommandDef[] {
  const byId = new Map<string, CommandDef>();
  // Map.set on an existing key keeps its original position, so order is by first registration.
  for (const e of entries) byId.set(e.id, e);
  return [...byId.values()];
}

export const useCommandRegistry = create<RegistryState>(() => ({ entries: [], commands: [] }));

export function registerCommands(defs: CommandDef[]): () => void {
  const added = [...defs];
  useCommandRegistry.setState((s) => {
    const entries = [...s.entries, ...added];
    return { entries, commands: dedupe(entries) };
  });
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    useCommandRegistry.setState((s) => {
      const entries = s.entries.filter((e) => !added.includes(e));
      return { entries, commands: dedupe(entries) };
    });
  };
}

/** React hook: the effective command list (re-renders on register/unregister). */
export function useCommands(): CommandDef[] {
  return useCommandRegistry((s) => s.commands);
}

export function getCommands(): CommandDef[] {
  return useCommandRegistry.getState().commands;
}

export function getCommand(id: string): CommandDef | undefined {
  return useCommandRegistry.getState().commands.find((c) => c.id === id);
}

// ---- context ---------------------------------------------------------------------------------------------

export const DEFAULT_CONTEXT: CommandContext = {
  hasRemotes: false,
  hasWip: false,
  hasStashes: false,
  isDetached: false,
  lfsEnabled: false,
  gitflowEnabled: false,
  focus: 'graph',
};

let contextProvider: () => CommandContext = () => DEFAULT_CONTEXT;

/** Install the function that snapshots app state into a `CommandContext` (called on every evaluation). */
export function setContextProvider(fn: () => CommandContext): void {
  contextProvider = fn;
}

export function getContext(): CommandContext {
  try {
    return contextProvider();
  } catch (err) {
    console.error('[commands] context provider failed', err);
    return DEFAULT_CONTEXT;
  }
}

// ---- enablement ------------------------------------------------------------------------------------------

export function isCommandEnabled(cmd: CommandDef, ctx: CommandContext = getContext()): boolean {
  try {
    return cmd.when ? cmd.when(ctx) : true;
  } catch {
    return false;
  }
}

/** Why a command is disabled (undefined when enabled or no reason is given). */
export function disabledReason(cmd: CommandDef, ctx: CommandContext = getContext()): string | undefined {
  if (isCommandEnabled(cmd, ctx)) return undefined;
  try {
    return cmd.whenReason?.(ctx);
  } catch {
    return undefined;
  }
}

// ---- execution -------------------------------------------------------------------------------------------

let argRequestHandler: ((cmd: CommandDef) => void) | undefined;

/**
 * Called when `runCommand` is invoked without an argument for a command that declares one
 * (e.g. from a shortcut). The command palette installs a handler that opens its argument picker.
 */
export function setArgRequestHandler(fn: ((cmd: CommandDef) => void) | undefined): void {
  argRequestHandler = fn;
}

export type RunResult = 'ran' | 'notFound' | 'disabled' | 'needsArg';

/**
 * Run a command by id. Resolves to what happened; rejects if the command's `run` throws.
 * Successful runs are recorded in the palette MRU list.
 */
export async function runCommand(id: string, arg?: string): Promise<RunResult> {
  const cmd = getCommand(id);
  if (!cmd) {
    console.warn(`[commands] unknown command: ${id}`);
    return 'notFound';
  }
  const ctx = getContext();
  if (!isCommandEnabled(cmd, ctx)) return 'disabled';
  if (cmd.arg && arg === undefined) {
    argRequestHandler?.(cmd);
    return 'needsArg';
  }
  recordMru(cmd.id);
  await cmd.run(ctx, arg);
  return 'ran';
}
