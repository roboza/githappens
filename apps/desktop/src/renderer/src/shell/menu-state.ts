import type { MenuRebuildRequest } from '../../../shared/ipc/shell2-contract';

/**
 * `menu:rebuild` payload from the command registry and resolved keybindings (pure; unit-tested).
 * The first resolved binding of a command is its menu accelerator — user overrides come first in the
 * resolved list, so they win.
 */
export function menuState(
  commands: readonly { id: string }[],
  resolved: readonly { command: string; key: string }[],
  enabled: (id: string) => boolean,
): Pick<MenuRebuildRequest, 'accelerators' | 'enabled'> {
  const accelerators: Record<string, string> = {};
  for (const b of resolved) if (!(b.command in accelerators)) accelerators[b.command] = b.key;
  const en: Record<string, boolean> = {};
  for (const c of commands) en[c.id] = enabled(c.id);
  return { accelerators, enabled: en };
}
