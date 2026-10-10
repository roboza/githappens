/**
 * Side-panel fitting for narrow windows (spec 01 §4.5/§4.6). The stored (persisted) panel widths are
 * what the user chose; this computes the widths actually rendered for the current workspace width so the
 * center (graph / diff) always keeps a usable width and is never overlapped by a side panel:
 *
 * 1. Panels shrink toward their minimums (left first, then right) until the center has `CENTER_MIN`.
 * 2. If even both minimums leave the center under `CENTER_HARD_MIN` (only reachable with a high zoom
 *    factor, since the window's minimum is 900 px), the left panel and then the right panel are hidden
 *    for as long as the window stays that narrow. Nothing is persisted, so widening restores them.
 */

export const LEFT_MIN = 180;
export const LEFT_MAX = 520;
export const RIGHT_MIN = 280;
/** The right panel never takes more than this share of the workspace (spec 01 §4.6). */
export const RIGHT_MAX_RATIO = 0.6;
/** Center width the panels shrink to preserve. */
export const CENTER_MIN = 480;
/** Below this, side panels are hidden rather than squeezing the center further. */
export const CENTER_HARD_MIN = 320;
/** Net width of each splitter (5 px with −2 px margins on both sides). */
export const SPLITTER_W = 1;

export interface PanelInput {
  /** Width of the workspace row (left + center + right), in CSS px. 0 = not measured yet. */
  width: number;
  left: number;
  leftCollapsed: boolean;
  right: number;
  rightCollapsed: boolean;
}

export interface PanelFit {
  left: number;
  /** Not rendered: collapsed by the user, or hidden because the window is too narrow. */
  leftHidden: boolean;
  right: number;
  rightHidden: boolean;
  /** Splitter maximums for the current width (never below the panel minimum). */
  leftMax: number;
  rightMax: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

export function fitPanels(p: PanelInput): PanelFit {
  let leftHidden = p.leftCollapsed;
  let rightHidden = p.rightCollapsed;
  let left = clamp(Math.round(p.left), LEFT_MIN, LEFT_MAX);
  let right = Math.max(RIGHT_MIN, Math.round(p.right));
  const w = p.width;
  if (w <= 0) return { left, leftHidden, right, rightHidden, leftMax: LEFT_MAX, rightMax: right };

  const rightCap = Math.max(RIGHT_MIN, Math.floor(w * RIGHT_MAX_RATIO));
  right = Math.min(right, rightCap);

  const sides = (): number => (leftHidden ? 0 : left + SPLITTER_W) + (rightHidden ? 0 : right + SPLITTER_W);

  // Too narrow for both minimums plus a usable center: hide the left panel, then the right one.
  const minSides = (): number =>
    (leftHidden ? 0 : LEFT_MIN + SPLITTER_W) + (rightHidden ? 0 : RIGHT_MIN + SPLITTER_W);
  if (!leftHidden && w - minSides() < CENTER_HARD_MIN) leftHidden = true;
  if (!rightHidden && w - minSides() < CENTER_HARD_MIN) rightHidden = true;

  let over = sides() + CENTER_MIN - w;
  if (over > 0 && !leftHidden) {
    const take = Math.min(over, left - LEFT_MIN);
    left -= take;
    over -= take;
  }
  if (over > 0 && !rightHidden) {
    const take = Math.min(over, right - RIGHT_MIN);
    right -= take;
  }

  const otherFor = (hidden: boolean, size: number): number => (hidden ? 0 : size + SPLITTER_W);
  const leftMax = clamp(w - otherFor(rightHidden, right) - SPLITTER_W - CENTER_MIN, LEFT_MIN, LEFT_MAX);
  const rightMax = clamp(
    w - otherFor(leftHidden, left) - SPLITTER_W - CENTER_MIN,
    RIGHT_MIN,
    Math.max(RIGHT_MIN, rightCap),
  );
  return { left, leftHidden, right, rightHidden, leftMax, rightMax };
}
