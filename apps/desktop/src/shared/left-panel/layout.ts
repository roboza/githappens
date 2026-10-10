import type { LeftPanelLayout } from '../ipc/graph-contract';

/**
 * Left-panel section layout (spec 01 §4.5): collapsed / hidden / opt-in / heights / maximized, persisted
 * per repo in `repoUi` (`userData/repos/<repoKey>/graph.json`). Pure: shared by main (sanitizing) and
 * the renderer (state transitions).
 */

export type { LeftPanelLayout };

export const DEFAULT_LEFT_LAYOUT: Readonly<LeftPanelLayout> = Object.freeze({
  collapsed: [],
  hidden: [],
  enabled: [],
  heights: {},
  maximized: null,
});

/** Section heights are clamped to this range (px). */
export const MIN_SECTION_HEIGHT = 60;
export const MAX_SECTION_HEIGHT = 4000;
const MAX_IDS = 64;
const ID = /^[a-z][a-z0-9:._-]{0,63}$/i;

function ids(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v)
    if (typeof x === 'string' && ID.test(x) && !out.includes(x) && out.length < MAX_IDS) out.push(x);
  return out;
}

export const clampHeight = (h: number): number =>
  Math.max(MIN_SECTION_HEIGHT, Math.min(MAX_SECTION_HEIGHT, Math.round(h)));

/** Validates untrusted input (renderer patch / hand-edited file). Undefined when not an object. */
export function sanitizeLeftPanelLayout(v: unknown): LeftPanelLayout | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const heights: Record<string, number> = {};
  if (o.heights && typeof o.heights === 'object' && !Array.isArray(o.heights)) {
    for (const [k, h] of Object.entries(o.heights as Record<string, unknown>)) {
      if (ID.test(k) && typeof h === 'number' && Number.isFinite(h) && Object.keys(heights).length < MAX_IDS)
        heights[k] = clampHeight(h);
    }
  }
  return {
    collapsed: ids(o.collapsed),
    hidden: ids(o.hidden),
    enabled: ids(o.enabled),
    heights,
    maximized: typeof o.maximized === 'string' && ID.test(o.maximized) ? o.maximized : null,
  };
}

const toggleIn = (list: string[], id: string, on?: boolean): string[] => {
  const has = list.includes(id);
  const want = on ?? !has;
  if (want === has) return list;
  return want ? [...list, id] : list.filter((x) => x !== id);
};

export function toggleCollapsed(l: LeftPanelLayout, id: string, collapsed?: boolean): LeftPanelLayout {
  // expanding a section while another one is maximized restores the normal layout
  const next = { ...l, collapsed: toggleIn(l.collapsed, id, collapsed) };
  if (l.maximized && l.maximized !== id && !next.collapsed.includes(id)) next.maximized = null;
  // collapsing the maximized section restores the layout too
  if (l.maximized === id && next.collapsed.includes(id)) next.maximized = null;
  return next;
}

/**
 * Show / hide a section from the header menu. `optIn` sections (hidden by default) are tracked in
 * `enabled`; the others in `hidden`.
 */
export function setSectionShown(
  l: LeftPanelLayout,
  id: string,
  shown: boolean,
  optIn = false,
): LeftPanelLayout {
  const next: LeftPanelLayout = optIn
    ? { ...l, enabled: toggleIn(l.enabled, id, shown), hidden: toggleIn(l.hidden, id, false) }
    : { ...l, hidden: toggleIn(l.hidden, id, !shown) };
  if (!shown && next.maximized === id) next.maximized = null;
  return next;
}

/**
 * Whether a section is listed. Opt-in sections appear when enabled, or (unless explicitly hidden) when
 * they have content — so existing submodules stay discoverable.
 */
export function isSectionShown(
  l: LeftPanelLayout,
  id: string,
  opts: { optIn?: boolean; hasItems?: boolean } = {},
): boolean {
  if (l.hidden.includes(id)) return false;
  if (!opts.optIn) return true;
  return l.enabled.includes(id) || !!opts.hasItems;
}

/** Double-click on a header: maximize it (others collapse to headers); again restores. */
export function toggleMaximized(l: LeftPanelLayout, id: string): LeftPanelLayout {
  if (l.maximized === id) return { ...l, maximized: null };
  return { ...l, maximized: id, collapsed: l.collapsed.filter((x) => x !== id) };
}

export function setSectionHeight(l: LeftPanelLayout, id: string, h: number | null): LeftPanelLayout {
  const heights = { ...l.heights };
  if (h === null) delete heights[id];
  else heights[id] = clampHeight(h);
  return { ...l, heights };
}

/**
 * Body open? With a filter active, sections follow their match count (spec 01 §4.5 "sections with zero
 * matches collapse automatically"); with a maximized section, only that one is open.
 */
export function isSectionOpen(
  l: LeftPanelLayout,
  id: string,
  opts: { filterActive?: boolean; count?: number } = {},
): boolean {
  if (l.maximized) return l.maximized === id;
  if (opts.filterActive && opts.count !== undefined) return opts.count > 0;
  return !l.collapsed.includes(id);
}
