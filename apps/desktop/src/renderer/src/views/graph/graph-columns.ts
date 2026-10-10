import type { GraphColumnId, GraphColumnLayout } from '../../../../shared/ipc/graph-contract';

/**
 * Graph column layout (spec 04 §4.2): order, widths and visibility, saved per repository
 * (`repoUi:save`). `graph` without a stored width autosizes to the lanes in view; `message` is the flex
 * column and always visible.
 */

export interface ColumnSpec {
  title: string;
  /** Default width (0 = auto for `graph`, flex for `message`). */
  width: number;
  min: number;
  visible: boolean;
}

export const COLUMN_SPECS: Record<GraphColumnId, ColumnSpec> = {
  refs: { title: 'Branch / Tag', width: 170, min: 80, visible: true },
  graph: { title: 'Graph', width: 0, min: 24, visible: true },
  message: { title: 'Commit message', width: 0, min: 120, visible: true },
  author: { title: 'Author', width: 140, min: 80, visible: true },
  date: { title: 'Date / Time', width: 120, min: 90, visible: true },
  sha: { title: 'SHA', width: 80, min: 60, visible: false },
};

export const DEFAULT_ORDER: GraphColumnId[] = ['refs', 'graph', 'message', 'author', 'date', 'sha'];

export const DEFAULT_LAYOUT: GraphColumnLayout = { order: [...DEFAULT_ORDER], widths: {}, visible: {} };

export interface ResolvedColumn {
  id: GraphColumnId;
  /** Stored width, or 0 for auto (graph) / flex (message). */
  width: number;
  visible: boolean;
}

/** Global pre-Phase-7 visibility (localStorage `graph:columns`) used as the default for new repos. */
export function legacyLayout(): GraphColumnLayout | null {
  try {
    const raw = globalThis.localStorage?.getItem('graph:columns');
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<Record<'author' | 'date' | 'sha', boolean>>;
    return { order: [...DEFAULT_ORDER], widths: {}, visible: { author: v.author, date: v.date, sha: v.sha } };
  } catch {
    return null;
  }
}

export function resolveColumns(layout: GraphColumnLayout | null | undefined): ResolvedColumn[] {
  const l = layout ?? DEFAULT_LAYOUT;
  const order: GraphColumnId[] = [];
  for (const id of l.order ?? []) if (COLUMN_SPECS[id] && !order.includes(id)) order.push(id);
  for (const id of DEFAULT_ORDER) if (!order.includes(id)) order.push(id);
  return order.map((id) => {
    const spec = COLUMN_SPECS[id];
    const w = l.widths?.[id];
    return {
      id,
      width: typeof w === 'number' && id !== 'message' ? Math.max(spec.min, w) : spec.width,
      visible: id === 'message' ? true : (l.visible?.[id] ?? spec.visible),
    };
  });
}

const base = (l: GraphColumnLayout | null | undefined): GraphColumnLayout => ({
  order: resolveColumns(l).map((c) => c.id),
  widths: { ...l?.widths },
  visible: { ...l?.visible },
});

/** Moves `id` before `before` (null = to the end). */
export function moveColumn(
  l: GraphColumnLayout | null | undefined,
  id: GraphColumnId,
  before: GraphColumnId | null,
): GraphColumnLayout {
  const b = base(l);
  const order = b.order.filter((x) => x !== id);
  const at = before === null ? order.length : order.indexOf(before);
  order.splice(at < 0 ? order.length : at, 0, id);
  return { ...b, order };
}

export function resizeColumn(
  l: GraphColumnLayout | null | undefined,
  id: GraphColumnId,
  width: number | null,
): GraphColumnLayout {
  const b = base(l);
  const widths = { ...b.widths };
  if (width === null || id === 'message') delete widths[id];
  else widths[id] = Math.max(COLUMN_SPECS[id].min, Math.min(2000, Math.round(width)));
  return { ...b, widths };
}

export function toggleColumn(l: GraphColumnLayout | null | undefined, id: GraphColumnId): GraphColumnLayout {
  if (id === 'message') return base(l);
  const b = base(l);
  const cur = resolveColumns(b).find((c) => c.id === id)!.visible;
  return { ...b, visible: { ...b.visible, [id]: !cur } };
}

/** Optional columns dropped (in this order) when even their minimum widths do not fit. */
const DROP_ORDER: readonly GraphColumnId[] = ['sha', 'date', 'author'];

/**
 * Pixel widths of the visible columns for a container width: fixed columns keep their width, `graph`
 * uses `graphAuto` unless resized, and `message` takes the rest (at least its minimum).
 *
 * When the container is too narrow (small window, wide side panels), the fixed columns other than
 * `graph` shrink proportionally toward their minimums, then SHA / Date / Author are left out, so the
 * columns never extend past the container. This is render-time only; the saved layout is unchanged.
 */
export function columnWidths(
  cols: readonly ResolvedColumn[],
  containerWidth: number,
  graphAuto: number,
): Array<{ id: GraphColumnId; width: number; left: number }> {
  let visible = cols.filter((c) => c.visible);
  const fixed = (c: ResolvedColumn): number =>
    c.id === 'graph' ? (c.width > 0 ? c.width : graphAuto) : c.id === 'message' ? 0 : c.width;
  const widths = new Map(visible.map((c) => [c.id, fixed(c)] as const));
  const msgMin = COLUMN_SPECS.message.min;
  const used = (): number => visible.reduce((s, c) => s + widths.get(c.id)!, 0);

  // 0 = not measured yet: lay out at full size rather than dropping columns for one frame.
  if (containerWidth > 0 && used() + msgMin > containerWidth) {
    const over = used() + msgMin - containerWidth;
    const shrinkable = visible.filter((c) => c.id !== 'graph' && c.id !== 'message');
    const slack = shrinkable.reduce((s, c) => s + widths.get(c.id)! - COLUMN_SPECS[c.id].min, 0);
    if (slack > 0) {
      const ratio = Math.min(1, over / slack);
      for (const c of shrinkable) {
        const w = widths.get(c.id)!;
        widths.set(
          c.id,
          Math.max(COLUMN_SPECS[c.id].min, Math.floor(w - (w - COLUMN_SPECS[c.id].min) * ratio)),
        );
      }
    }
    for (const id of DROP_ORDER) {
      if (used() + msgMin <= containerWidth) break;
      visible = visible.filter((c) => c.id !== id);
    }
  }

  const msg = Math.max(msgMin, containerWidth - used());
  let left = 0;
  return visible.map((c) => {
    const width = c.id === 'message' ? msg : widths.get(c.id)!;
    const out = { id: c.id, width, left };
    left += width;
    return out;
  });
}
