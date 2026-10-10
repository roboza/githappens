import type { PrFilter } from '@githappens/providers/types';

import type { SavedPrFilter } from '../../../shared/ipc/integrations-contract';

/**
 * PR list filters (spec 10 §4.5): built-in presets, state filters ("Recently merged" / "Closed") and
 * user-defined saved filters. Pure helpers — no React, no IPC — so they are unit-testable.
 *
 * A selection is encoded as a string id: `preset:<preset>`, `state:<merged|closed>` or `custom:<id>`.
 */

export type PrPresetId = NonNullable<PrFilter['preset']>;
export type PrStateFilter = NonNullable<PrFilter['state']>;

export interface BuiltinPrFilter {
  id: string;
  label: string;
  group: 'Presets' | 'State';
  filter: PrFilter;
}

export const BUILTIN_PR_FILTERS: BuiltinPrFilter[] = [
  { id: 'preset:mine', label: 'Mine', group: 'Presets', filter: { preset: 'mine', state: 'open' } },
  {
    id: 'preset:review-requested',
    label: 'Review requested',
    group: 'Presets',
    filter: { preset: 'review-requested', state: 'open' },
  },
  {
    id: 'preset:assigned',
    label: 'Assigned',
    group: 'Presets',
    filter: { preset: 'assigned', state: 'open' },
  },
  { id: 'preset:all', label: 'All open', group: 'Presets', filter: { preset: 'all', state: 'open' } },
  {
    id: 'state:merged',
    label: 'Recently merged',
    group: 'State',
    filter: { preset: 'all', state: 'merged' },
  },
  { id: 'state:closed', label: 'Closed', group: 'State', filter: { preset: 'all', state: 'closed' } },
];

export const DEFAULT_PR_SELECTION = 'preset:mine';

export const presetSelection = (preset: PrPresetId): string => `preset:${preset}`;
export const customSelection = (id: string): string => `custom:${id}`;

export type ParsedSelection =
  | { kind: 'preset'; preset: PrPresetId }
  | { kind: 'state'; state: 'merged' | 'closed' }
  | { kind: 'custom'; id: string };

const PRESETS = new Set<string>(['mine', 'review-requested', 'assigned', 'all']);

/** Parse a selection id; null when malformed. */
export function parseSelection(sel: string | null | undefined): ParsedSelection | null {
  if (!sel) return null;
  const i = sel.indexOf(':');
  if (i < 0) return null;
  const kind = sel.slice(0, i);
  const rest = sel.slice(i + 1);
  if (kind === 'preset' && PRESETS.has(rest)) return { kind: 'preset', preset: rest as PrPresetId };
  if (kind === 'state' && (rest === 'merged' || rest === 'closed')) return { kind: 'state', state: rest };
  if (kind === 'custom' && rest) return { kind: 'custom', id: rest };
  return null;
}

/**
 * The effective selection: the stored one when it still resolves (a deleted custom filter falls back),
 * else the remembered preset.
 */
export function effectiveSelection(
  stored: string | null | undefined,
  preset: PrPresetId,
  saved: readonly SavedPrFilter[],
): string {
  const p = parseSelection(stored);
  if (p?.kind === 'state') return stored!;
  if (p?.kind === 'custom' && saved.some((f) => f.id === p.id)) return stored!;
  return presetSelection(preset);
}

/** The `PrFilter` sent to `pr:list` for a selection; null when it does not resolve. */
export function resolvePrFilter(sel: string, saved: readonly SavedPrFilter[]): PrFilter | null {
  const builtin = BUILTIN_PR_FILTERS.find((b) => b.id === sel);
  if (builtin) return builtin.filter;
  const p = parseSelection(sel);
  if (p?.kind !== 'custom') return null;
  const f = saved.find((x) => x.id === p.id);
  if (!f) return null;
  // Custom filters span all PRs (not just "mine") unless the query narrows them down.
  return { preset: f.filter.preset ?? 'all', state: f.filter.state ?? 'open', ...stripEmpty(f.filter) };
}

/** Button / dropdown label of a selection. */
export function selectionLabel(sel: string, saved: readonly SavedPrFilter[]): string {
  const builtin = BUILTIN_PR_FILTERS.find((b) => b.id === sel);
  if (builtin) return builtin.label;
  const p = parseSelection(sel);
  if (p?.kind === 'custom') return saved.find((f) => f.id === p.id)?.name ?? 'Custom filter';
  return 'Filter';
}

const STATE_WORD: Record<PrStateFilter, string> = {
  open: 'open',
  merged: 'recently merged',
  closed: 'closed',
  all: '',
};

/** Empty-list text for a resolved filter. */
export function emptyListText(filter: PrFilter | null): string {
  const word = STATE_WORD[filter?.state ?? 'open'];
  if (filter?.query || filter?.author) return 'No pull requests match this filter';
  return word ? `No ${word} pull requests` : 'No pull requests';
}

/** One-line summary of a saved filter (dropdown detail / manage list). */
export function describeFilter(f: PrFilter): string {
  const parts: string[] = [];
  if (f.query?.trim()) parts.push(f.query.trim());
  if (f.author?.trim()) parts.push(`author: ${f.author.trim()}`);
  if (f.state && f.state !== 'open') parts.push(`state: ${f.state}`);
  else if (!f.query?.trim()) parts.push('state: open');
  return parts.join(' · ');
}

/** Collapse whitespace of a GitHub-style search query. */
export const normalizeQuery = (q: string): string => q.replace(/\s+/g, ' ').trim();

function stripEmpty(f: PrFilter): PrFilter {
  const out: PrFilter = {};
  if (f.preset) out.preset = f.preset;
  if (f.state) out.state = f.state;
  if (f.query && normalizeQuery(f.query)) out.query = normalizeQuery(f.query);
  if (f.author && f.author.trim()) out.author = f.author.trim();
  if (f.head && f.head.trim()) out.head = f.head.trim();
  return out;
}

export interface FilterDraft {
  name: string;
  query?: string;
  author?: string;
  state?: PrStateFilter;
}

/** Build the stored `PrFilter` from the dialog fields (empty fields dropped). */
export function draftToFilter(d: FilterDraft): PrFilter {
  return stripEmpty({ preset: 'all', state: d.state ?? 'open', query: d.query, author: d.author });
}

export const MAX_FILTER_NAME = 60;
export const MAX_FILTER_QUERY = 256;

/** Validate a filter draft; returns an error message or null. `editingId` skips its own name. */
export function validateFilterDraft(
  d: FilterDraft,
  saved: readonly SavedPrFilter[],
  editingId?: string,
): string | null {
  const name = d.name.trim();
  if (!name) return 'Enter a name.';
  if (name.length > MAX_FILTER_NAME) return `Use at most ${MAX_FILTER_NAME} characters for the name.`;
  const lower = name.toLowerCase();
  if (saved.some((f) => f.id !== editingId && f.name.trim().toLowerCase() === lower))
    return `A filter named “${name}” already exists.`;
  if (BUILTIN_PR_FILTERS.some((b) => b.label.toLowerCase() === lower))
    return `“${name}” is a built-in filter name.`;
  const query = normalizeQuery(d.query ?? '');
  if (query.length > MAX_FILTER_QUERY) return `Use at most ${MAX_FILTER_QUERY} characters for the query.`;
  if (/(^|\s)repo:/i.test(query)) return 'The repository is added automatically; remove “repo:”.';
  if (!query && !d.author?.trim() && (d.state ?? 'open') === 'open')
    return 'Add a query, an author or a state other than open.';
  return null;
}

/** A new unique filter id (`f-<time36>[-n]`). */
export function newFilterId(saved: readonly SavedPrFilter[], now = Date.now()): string {
  const base = `f-${now.toString(36)}`;
  const taken = new Set(saved.map((f) => f.id));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/** Insert or replace (by id) a filter, keeping order. */
export function upsertFilter(saved: readonly SavedPrFilter[], f: SavedPrFilter): SavedPrFilter[] {
  const i = saved.findIndex((x) => x.id === f.id);
  if (i < 0) return [...saved, f];
  const out = saved.slice();
  out[i] = f;
  return out;
}

export const removeFilter = (saved: readonly SavedPrFilter[], id: string): SavedPrFilter[] =>
  saved.filter((f) => f.id !== id);

/** Draft fields of an existing filter (manage dialog edit). */
export function filterToDraft(f: SavedPrFilter): FilterDraft {
  return {
    name: f.name,
    query: f.filter.query ?? '',
    author: f.filter.author ?? '',
    state: f.filter.state ?? 'open',
  };
}
