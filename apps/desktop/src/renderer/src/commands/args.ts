import type { ArgKind } from './types';

/**
 * Argument providers for two-stage commands and palette prefix modes (spec 01 §4.8).
 * A provider returns candidates for the current query; the palette fuzzy-ranks them unless the
 * provider is registered with `filter: 'none'` (e.g. server-side commit search).
 * Kinds without a provider (and always `text`) accept free text committed with Enter.
 */

/** Icon hint rendered by the palette (mapped to a lucide icon there). */
export type ArgIconName =
  | 'branch'
  | 'branchHead'
  | 'remoteBranch'
  | 'tag'
  | 'stash'
  | 'repo'
  | 'file'
  | 'folder'
  | 'theme'
  | 'commit'
  | 'profile'
  | 'worktree'
  | 'text';

export interface ArgItem {
  /** Value passed to `CommandDef.run` as `arg`. */
  id: string;
  label: string;
  detail?: string;
  icon?: ArgIconName;
}

export type ArgProvider = (query: string) => Promise<ArgItem[]> | ArgItem[];

export interface ArgProviderOptions {
  /** 'fuzzy' (default; 'none' for commitQuery): how the palette filters returned items by the query. */
  filter?: 'fuzzy' | 'none';
  /** Debounce before calling the provider while typing (default 0, 150 for commitQuery). */
  debounceMs?: number;
  /** Also offer the raw query as a free-text choice (default true for `text`/`commitQuery`). */
  allowFreeText?: boolean;
}

export interface RegisteredArgProvider {
  provider: ArgProvider;
  filter: 'fuzzy' | 'none';
  debounceMs: number;
  allowFreeText: boolean;
}

const providers = new Map<ArgKind, RegisteredArgProvider[]>();

export const DEFAULT_ARG_ICON: Record<ArgKind, ArgIconName> = {
  file: 'file',
  branch: 'branch',
  remoteBranch: 'remoteBranch',
  tag: 'tag',
  stash: 'stash',
  profile: 'profile',
  repo: 'repo',
  theme: 'theme',
  commitQuery: 'commit',
  text: 'text',
  worktree: 'worktree',
  workspace: 'folder',
};

/** Register (or shadow) the provider for `kind`; returns a disposer restoring the previous one. */
export function registerArgProvider(
  kind: ArgKind,
  provider: ArgProvider,
  opts: ArgProviderOptions = {},
): () => void {
  const isQuery = kind === 'commitQuery';
  const entry: RegisteredArgProvider = {
    provider,
    filter: opts.filter ?? (isQuery ? 'none' : 'fuzzy'),
    debounceMs: opts.debounceMs ?? (isQuery ? 150 : 0),
    allowFreeText: opts.allowFreeText ?? (kind === 'text' || isQuery),
  };
  providers.set(kind, [...(providers.get(kind) ?? []), entry]);
  return () => {
    const list = (providers.get(kind) ?? []).filter((e) => e !== entry);
    if (list.length) providers.set(kind, list);
    else providers.delete(kind);
  };
}

export function getArgProvider(kind: ArgKind): RegisteredArgProvider | undefined {
  const list = providers.get(kind);
  return list?.[list.length - 1];
}

/** Whether Enter may commit the typed text for this kind (no provider, `text`, or opted in). */
export function acceptsFreeText(kind: ArgKind): boolean {
  const p = getArgProvider(kind);
  return !p || p.allowFreeText;
}

/** Call the provider for `kind` safely; resolves to [] when none is registered or it throws. */
export async function fetchArgItems(kind: ArgKind, query: string): Promise<ArgItem[]> {
  const p = getArgProvider(kind);
  if (!p) return [];
  try {
    return await p.provider(query);
  } catch (err) {
    console.error(`[commands] arg provider '${kind}' failed`, err);
    return [];
  }
}
