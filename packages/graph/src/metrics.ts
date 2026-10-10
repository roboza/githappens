/** Graph geometry (spec 04 §4.3). Nothing in the renderer is hard-coded outside these metrics. */

export type EdgeStyle = 'rounded' | 'bezier';

export interface GraphMetrics {
  compact: boolean;
  rowHeight: number;
  laneWidth: number;
  /** Commit node radius (avatar circle incl. ring in normal mode; plain dot in compact mode). */
  nodeRadius: number;
  /** Avatar diameter inside the node (0 = no avatars). */
  avatarSize: number;
  ringWidth: number;
  mergeDotRadius: number;
  /** Side of the stash box node. */
  stashSize: number;
  strokeWidth: number;
  /** Space left of lane 0. Lane centre = paddingLeft + col * laneWidth + laneWidth / 2. */
  paddingLeft: number;
  /** Width of the overflow fade at the right edge. */
  fadeWidth: number;
  /** Extra hit radius around a node. */
  hitSlop: number;
  edgeStyle: EdgeStyle;
  /** Initials font size (px). */
  fontSize: number;
}

const BASE: Record<'normal' | 'compact', Omit<GraphMetrics, 'edgeStyle'>> = {
  normal: {
    compact: false,
    rowHeight: 28,
    laneWidth: 22,
    nodeRadius: 10,
    avatarSize: 16,
    ringWidth: 2,
    mergeDotRadius: 4,
    stashSize: 14,
    strokeWidth: 2,
    paddingLeft: 6,
    fadeWidth: 12,
    hitSlop: 3,
    fontSize: 8,
  },
  compact: {
    compact: true,
    rowHeight: 22,
    laneWidth: 12,
    nodeRadius: 4,
    avatarSize: 0,
    ringWidth: 1.5,
    mergeDotRadius: 3,
    stashSize: 9,
    strokeWidth: 1.5,
    paddingLeft: 4,
    fadeWidth: 12,
    hitSlop: 3,
    fontSize: 0,
  },
};

/** Metrics preset scaled by the UI zoom factor (spec 13). */
export function createMetrics(
  mode: 'normal' | 'compact' = 'normal',
  options: { zoom?: number; edgeStyle?: EdgeStyle } = {},
): GraphMetrics {
  const z = options.zoom ?? 1;
  const b = BASE[mode];
  const s = (v: number) => v * z;
  return {
    compact: b.compact,
    rowHeight: Math.round(b.rowHeight * z),
    laneWidth: Math.round(b.laneWidth * z),
    nodeRadius: s(b.nodeRadius),
    avatarSize: s(b.avatarSize),
    ringWidth: s(b.ringWidth),
    mergeDotRadius: s(b.mergeDotRadius),
    stashSize: s(b.stashSize),
    strokeWidth: s(b.strokeWidth),
    paddingLeft: s(b.paddingLeft),
    fadeWidth: b.fadeWidth,
    hitSlop: b.hitSlop,
    fontSize: s(b.fontSize),
    edgeStyle: options.edgeStyle ?? 'rounded',
  };
}

export const NORMAL_METRICS: Readonly<GraphMetrics> = Object.freeze(createMetrics('normal'));
export const COMPACT_METRICS: Readonly<GraphMetrics> = Object.freeze(createMetrics('compact'));

/** X of a lane centre (CSS px, before horizontal scroll). */
export function laneX(m: GraphMetrics, column: number): number {
  return m.paddingLeft + column * m.laneWidth + m.laneWidth / 2;
}

/** Absolute (virtual) Y of a row centre. */
export function rowCenterY(m: GraphMetrics, row: number): number {
  return row * m.rowHeight + m.rowHeight / 2;
}

/** Graph column width that fits `maxColumn` (from `model.maxColumnInRange`), clamped (§4.2: min 24, max 400). */
export function graphColumnWidth(m: GraphMetrics, maxColumn: number, min = 24, max = 400): number {
  const w = m.paddingLeft * 2 + Math.max(1, maxColumn + 1) * m.laneWidth;
  return Math.max(min, Math.min(max, Math.ceil(w)));
}
