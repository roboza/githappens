import type { ArgKind } from './types';

/**
 * Palette prefix modes (spec 01 §4.8, inferred design): `>` commands (default), `@` branches,
 * `#` files, `:` commit search. Picking an item in a prefix mode runs `commandId` with the item id.
 */
export interface PrefixMode {
  prefix: '@' | '#' | ':';
  kind: ArgKind;
  commandId: string;
  label: string;
  placeholder: string;
}

const modes: Record<PrefixMode['prefix'], PrefixMode> = {
  '@': {
    prefix: '@',
    kind: 'branch',
    commandId: 'branch.checkout',
    label: 'Branches',
    placeholder: 'Checkout branch…',
  },
  '#': { prefix: '#', kind: 'file', commandId: 'file.open', label: 'Files', placeholder: 'Open file…' },
  ':': {
    prefix: ':',
    kind: 'commitQuery',
    commandId: 'history.searchCommits',
    label: 'Commits',
    placeholder: 'Search commits by message, sha or author…',
  },
};

/** Change which command a prefix mode runs (e.g. `setPrefixCommand(':', 'graph.selectCommit')`). */
export function setPrefixCommand(prefix: PrefixMode['prefix'], commandId: string): void {
  modes[prefix] = { ...modes[prefix], commandId };
}

export function getPrefixModes(): PrefixMode[] {
  return Object.values(modes);
}

/** Split a palette query into its prefix mode (null = commands) and the remaining search text. */
export function parsePrefix(query: string): { mode: PrefixMode | null; rest: string } {
  const c = query[0];
  if (c === '>') return { mode: null, rest: query.slice(1).trimStart() };
  if (c === '@' || c === '#' || c === ':') return { mode: modes[c], rest: query.slice(1).trimStart() };
  return { mode: null, rest: query };
}
