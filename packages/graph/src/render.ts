/**
 * Canvas 2D renderer for the graph column (spec 04 §4.6, §6.11, §6.12).
 *
 * The canvas covers only the viewport. Each call draws the visible rows plus one row above and below
 * (for edges) relative to the first drawn row, so coordinates stay small even in scaled-scroll mode.
 */
import { laneX, rowCenterY, type GraphMetrics } from './metrics';
import type { GraphModel } from './model';
import { EdgeFlag, EdgeKind, NodeKind, type GraphCommitInput, type Sha } from './types';

/** The subset of `CanvasRenderingContext2D` the renderer uses (also satisfied by OffscreenCanvas contexts). */
export type GraphCanvasContext = Pick<
  CanvasRenderingContext2D,
  | 'save'
  | 'restore'
  | 'setTransform'
  | 'clearRect'
  | 'beginPath'
  | 'closePath'
  | 'moveTo'
  | 'lineTo'
  | 'arcTo'
  | 'arc'
  | 'bezierCurveTo'
  | 'rect'
  | 'stroke'
  | 'fill'
  | 'clip'
  | 'fillRect'
  | 'drawImage'
  | 'fillText'
  | 'setLineDash'
  | 'createLinearGradient'
  | 'strokeStyle'
  | 'fillStyle'
  | 'lineWidth'
  | 'lineCap'
  | 'lineJoin'
  | 'globalAlpha'
  | 'font'
  | 'textAlign'
  | 'textBaseline'
>;

export interface GraphNodeColors {
  /** Graph background: node fill behind avatars, WIP fill, overflow-fade target. */
  background: string;
  /** Selection ring (theme accent). */
  accent: string;
  /** WIP node stroke; defaults to the lane color. */
  wip?: string;
  /** Conflict row stroke. */
  conflict: string;
  stash: string;
  stashBorder: string;
  hover: string;
  initialsText: string;
  /** Fully transparent color used as gradient end. */
  transparent: string;
}

export const DEFAULT_NODE_COLORS: Readonly<GraphNodeColors> = Object.freeze({
  background: '#1e1f22',
  accent: '#4c9aff',
  conflict: '#e5534b',
  stash: '#8b8f98',
  stashBorder: '#5c6068',
  hover: 'rgba(255,255,255,0.55)',
  initialsText: '#ffffff',
  transparent: 'rgba(0,0,0,0)',
});

export interface DrawGraphOptions {
  /** Virtual scroll offset (CSS px) of the viewport top. In scaled-scroll mode pass the virtual top. */
  scrollTop: number;
  /** Viewport size in CSS px (the canvas backing store is width*dpr × height*dpr). */
  width: number;
  height: number;
  dpr?: number;
  /** Horizontal pan of the graph column (CSS px). */
  scrollX?: number;
  metrics: GraphMetrics;
  /** Lane palette; color index i uses `colors[i % colors.length]`. */
  colors: readonly string[];
  nodeColors?: Partial<GraphNodeColors>;
  /** Selected row keys (shas, `'WIP'`). */
  selected?: ReadonlySet<Sha>;
  /** Ancestry highlight (`model.reachable(tip)` or a row set). Rows/edges outside draw at 30% alpha. */
  highlight?: ReadonlySet<number> | Uint8Array | null;
  /** Rows dimmed regardless of highlight (search filter mode, "dim merges"). */
  dimmed?: ReadonlySet<number> | ((row: number) => boolean) | null;
  /** Defaults to `model.headSha`. */
  headSha?: Sha | null;
  hoverRow?: number | null;
  /** Ready avatar bitmap for a commit row (draw initials until it is ready). */
  avatars?: (sha: Sha, row: number) => CanvasImageSource | null | undefined;
  initials?: (sha: Sha, row: number) => { text: string; color: string } | null | undefined;
  /** Clear the canvas first (default true). */
  clear?: boolean;
}

export interface DrawGraphResult {
  firstRow: number;
  lastRow: number;
  edgeCount: number;
  nodeCount: number;
  /** Lanes (in the drawn rows) whose centre is right of the visible width — "N more lanes". */
  hiddenLanes: number;
}

const DIM_ALPHA = 0.3;
const State = { Dim: 0, Normal: 1, High: 2 } as const;
type State = (typeof State)[keyof typeof State];

/** Rows drawn for a viewport: visible rows ± 1 (§6.11 step 1). `lastRow < firstRow` when empty. */
export function visibleRowRange(
  rowCount: number,
  metrics: GraphMetrics,
  scrollTop: number,
  height: number,
): { firstRow: number; lastRow: number } {
  if (rowCount <= 0 || height <= 0) return { firstRow: 0, lastRow: -1 };
  const h = metrics.rowHeight;
  const firstRow = Math.min(rowCount - 1, Math.max(0, Math.floor(scrollTop / h) - 1));
  const lastRow = Math.min(rowCount - 1, Math.max(firstRow, Math.ceil((scrollTop + height) / h)));
  return { firstRow, lastRow };
}

export function drawGraph<C extends GraphCommitInput>(
  ctx: GraphCanvasContext,
  model: GraphModel<C>,
  o: DrawGraphOptions,
): DrawGraphResult {
  const m = o.metrics;
  const dpr = o.dpr ?? 1;
  const sx = o.scrollX ?? 0;
  const nc: GraphNodeColors = { ...DEFAULT_NODE_COLORS, ...o.nodeColors };
  const rowH = m.rowHeight;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (o.clear !== false) ctx.clearRect(0, 0, o.width * dpr, o.height * dpr);
  const { firstRow, lastRow } = visibleRowRange(model.rowCount, m, o.scrollTop, o.height);
  const result: DrawGraphResult = { firstRow, lastRow, edgeCount: 0, nodeCount: 0, hiddenLanes: 0 };
  if (lastRow < firstRow) return result;

  ctx.setTransform(dpr, 0, 0, dpr, -sx * dpr, (firstRow * rowH - o.scrollTop) * dpr);
  const swDev = Math.round(m.strokeWidth * dpr);
  const half = swDev % 2 === 1 ? 0.5 : 0;
  const xOf = (c: number) => (Math.round(laneX(m, c) * dpr) + half) / dpr;
  const yOf = (row: number) => (row - firstRow) * rowH + rowH / 2;
  const palette = o.colors.length ? o.colors : ['#888888'];
  const laneColor = (i: number) => palette[i % palette.length]!;

  const hl = o.highlight ?? null;
  const inHl =
    hl === null ? null : hl instanceof Uint8Array ? (r: number) => hl[r] === 1 : (r: number) => hl.has(r);
  const dimSrc = o.dimmed ?? null;
  const isDim = dimSrc === null ? null : typeof dimSrc === 'function' ? dimSrc : (r: number) => dimSrc.has(r);
  const stateOf = (row: number): State => {
    if (isDim?.(row)) return State.Dim;
    if (inHl) return inHl(row) ? State.High : State.Dim;
    return State.Normal;
  };

  // ---- edges: bucket by (state, color, dashed, fade) → one stroke per bucket
  interface Bucket {
    state: State;
    color: number;
    dashed: boolean;
    fade: boolean;
    segs: number[];
  }
  const buckets = new Map<number, Bucket>();
  model.forEachEdge(firstRow, lastRow, (gap, from, to, kf, color, owner) => {
    const state = stateOf(owner);
    const dashed = (kf & EdgeFlag.Dashed) !== 0;
    const fade = (kf & EdgeFlag.Fade) !== 0;
    // fade edges only occur in the open gap below the last row, so one gradient per bucket suffices
    const key = ((color * 3 + state) * 2 + +dashed) * 2 + +fade;
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { state, color, dashed, fade, segs: [] }));
    b.segs.push(gap, from, to, kf & 7);
    result.edgeCount++;
  });

  ctx.lineWidth = m.strokeWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const R = Math.min(m.laneWidth, rowH) / 2;
  const ordered = [...buckets.values()].sort((a, b) => a.state - b.state);
  for (const b of ordered) {
    ctx.globalAlpha = b.state === State.Dim ? DIM_ALPHA : 1;
    ctx.setLineDash(b.dashed ? [m.strokeWidth * 2, m.strokeWidth * 1.5] : []);
    if (b.fade) {
      const g = b.segs[0]!;
      const grad = ctx.createLinearGradient(0, yOf(g), 0, yOf(g + 1));
      grad.addColorStop(0, laneColor(b.color));
      grad.addColorStop(1, nc.transparent);
      ctx.strokeStyle = grad;
    } else {
      ctx.strokeStyle = laneColor(b.color);
    }
    ctx.beginPath();
    const s = b.segs;
    for (let i = 0; i < s.length; i += 4) {
      const gap = s[i]!;
      const x1 = xOf(s[i + 1]!);
      const x2 = xOf(s[i + 2]!);
      const kind = s[i + 3]!;
      const y1 = yOf(gap);
      const y2 = yOf(gap + 1);
      if (kind === EdgeKind.Pass || x1 === x2) {
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
      } else if (m.edgeStyle === 'bezier') {
        ctx.moveTo(x1, y1);
        ctx.bezierCurveTo(x1, y1 + 0.8 * rowH, x2, y2 - 0.8 * rowH, x2, y2);
      } else if (kind === EdgeKind.MergeOut) {
        const dir = x2 > x1 ? 1 : -1;
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2 - dir * R, y1);
        ctx.arcTo(x2, y1, x2, y1 + R, R);
        ctx.lineTo(x2, y2);
      } else {
        const dir = x2 > x1 ? 1 : -1;
        ctx.moveTo(x1, y1);
        ctx.lineTo(x1, y2 - R);
        ctx.arcTo(x1, y2, x1 + dir * R, y2, R);
        ctx.lineTo(x2, y2);
      }
    }
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // ---- nodes
  const headSha = o.headSha === undefined ? model.headSha : o.headSha;
  const TAU = Math.PI * 2;
  const circle = (x: number, y: number, r: number) => {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
  };
  for (let row = firstRow; row <= lastRow; row++) {
    const sha = model.shaAt(row)!;
    const kind = model.nodeKindAt(row);
    const x = xOf(model.columnAt(row));
    const y = yOf(row);
    const color = laneColor(model.colorAt(row));
    ctx.globalAlpha = stateOf(row) === State.Dim ? DIM_ALPHA : 1;
    result.nodeCount++;
    let outer = m.nodeRadius;

    if (kind === NodeKind.Wip || kind === NodeKind.Conflict) {
      const r = m.compact ? m.nodeRadius + 1 : m.nodeRadius - m.ringWidth / 2;
      circle(x, y, r);
      ctx.fillStyle = nc.background;
      ctx.fill();
      ctx.setLineDash([m.ringWidth * 1.5, m.ringWidth]);
      ctx.lineWidth = m.ringWidth;
      ctx.strokeStyle = kind === NodeKind.Conflict ? nc.conflict : (nc.wip ?? color);
      ctx.stroke();
      ctx.setLineDash([]);
      outer = r + m.ringWidth / 2;
    } else if (kind === NodeKind.Stash) {
      const sz = m.stashSize;
      ctx.beginPath();
      ctx.rect(x - sz / 2, y - sz / 2, sz, sz);
      ctx.fillStyle = nc.stash;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = nc.stashBorder;
      ctx.stroke();
      // lid line of the "box" icon
      ctx.beginPath();
      ctx.moveTo(x - sz / 2, y - sz / 6);
      ctx.lineTo(x + sz / 2, y - sz / 6);
      ctx.stroke();
      outer = (sz / 2) * Math.SQRT2;
    } else if (kind === NodeKind.Merge || m.compact) {
      const r = kind === NodeKind.Merge ? m.mergeDotRadius : m.nodeRadius;
      circle(x, y, r);
      ctx.fillStyle = color;
      ctx.fill();
      outer = r;
    } else {
      const inner = m.nodeRadius - m.ringWidth;
      const img = o.avatars?.(sha, row);
      const ini = img ? null : o.initials?.(sha, row);
      circle(x, y, m.nodeRadius);
      ctx.fillStyle = ini ? ini.color : nc.background;
      ctx.fill();
      if (img) {
        ctx.save();
        circle(x, y, inner);
        ctx.clip();
        ctx.drawImage(img, x - inner, y - inner, inner * 2, inner * 2);
        ctx.restore();
      } else if (ini && m.fontSize > 0) {
        ctx.fillStyle = nc.initialsText;
        ctx.font = `600 ${m.fontSize}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(ini.text, x, y + 0.5);
      }
      circle(x, y, m.nodeRadius - m.ringWidth / 2);
      ctx.lineWidth = m.ringWidth;
      ctx.strokeStyle = color;
      ctx.stroke();
    }

    if (headSha && sha === headSha) {
      outer += m.compact ? 2 : 2.5;
      circle(x, y, outer);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = color;
      ctx.stroke();
    }
    if (o.selected?.has(sha)) {
      circle(x, y, outer + 2.5);
      ctx.lineWidth = 2;
      ctx.strokeStyle = nc.accent;
      ctx.stroke();
    } else if (o.hoverRow === row) {
      circle(x, y, outer + 2.5);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = nc.hover;
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;

  // ---- overflow fade (§4.6)
  const maxCol = model.maxColumnInRange(firstRow, lastRow);
  const right = sx + o.width;
  for (let c = maxCol; c >= 0 && laneX(m, c) > right; c--) result.hiddenLanes++;
  if (maxCol >= 0 && laneX(m, maxCol) + m.laneWidth / 2 > right) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const fw = Math.min(m.fadeWidth, o.width);
    const grad = ctx.createLinearGradient(o.width - fw, 0, o.width, 0);
    grad.addColorStop(0, nc.transparent);
    grad.addColorStop(1, nc.background);
    ctx.fillStyle = grad;
    ctx.fillRect(o.width - fw, 0, fw, o.height);
  }
  return result;
}

/** Row under a viewport-relative y (CSS px), or -1. */
export function rowAtY(rowCount: number, metrics: GraphMetrics, y: number, scrollTop = 0): number {
  const row = Math.floor((scrollTop + y) / metrics.rowHeight);
  return row >= 0 && row < rowCount ? row : -1;
}

export interface NodeHit {
  row: number;
  sha: Sha;
  kind: NodeKind;
}

/**
 * Node hit test (§6.12). `x`, `y` are canvas-local CSS px; pass the viewport's `scrollTop` / `scrollX`
 * (omit them to use absolute content coordinates). Hits within `nodeRadius + hitSlop` of the node centre.
 */
export function hitTestNode<C extends GraphCommitInput>(
  model: GraphModel<C>,
  metrics: GraphMetrics,
  x: number,
  y: number,
  view: { scrollTop?: number; scrollX?: number } = {},
): NodeHit | null {
  const vy = (view.scrollTop ?? 0) + y;
  const row = rowAtY(model.rowCount, metrics, vy);
  if (row < 0) return null;
  const dx = x + (view.scrollX ?? 0) - laneX(metrics, model.columnAt(row));
  const dy = vy - rowCenterY(metrics, row);
  const r = metrics.nodeRadius + metrics.hitSlop;
  if (dx * dx + dy * dy > r * r) return null;
  return { row, sha: model.shaAt(row)!, kind: model.nodeKindAt(row) };
}
