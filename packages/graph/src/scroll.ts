/**
 * Scaled-scroll mapping for very tall graphs (spec 04 §4.13).
 *
 * Chromium caps element heights at ~33.5M px. Above `MAX_SCROLL_HEIGHT` the scroll spacer is fixed at
 * that height and the native `scrollTop` is mapped linearly onto the virtual content offset:
 * `virtualTop = scrollTop × (totalH − viewportH) / (spacerH − viewportH)`.
 */

export const MAX_SCROLL_HEIGHT = 15_000_000;

export interface ScrollMapping {
  /** `rowCount × rowHeight`. */
  totalHeight: number;
  /** Height of the native scroll spacer (≤ the limit). */
  spacerHeight: number;
  /** True when native scroll offsets are scaled. */
  scaled: boolean;
  /** Largest valid virtual top. */
  maxVirtualTop: number;
  /** Native `scrollTop` → virtual content offset. */
  toVirtual(scrollTop: number): number;
  /** Virtual content offset → native `scrollTop`. */
  toScroll(virtualTop: number): number;
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export function createScrollMapping(
  rowCount: number,
  rowHeight: number,
  viewportHeight: number,
  limit = MAX_SCROLL_HEIGHT,
): ScrollMapping {
  const total = Math.max(0, rowCount) * rowHeight;
  const vh = Math.max(0, viewportHeight);
  const maxVirtualTop = Math.max(0, total - vh);
  if (total <= limit) {
    return {
      totalHeight: total,
      spacerHeight: total,
      scaled: false,
      maxVirtualTop,
      toVirtual: (s) => clamp(s, 0, maxVirtualTop),
      toScroll: (v) => clamp(v, 0, maxVirtualTop),
    };
  }
  const maxScroll = Math.max(1, limit - vh);
  const ratio = maxVirtualTop / maxScroll;
  return {
    totalHeight: total,
    spacerHeight: limit,
    scaled: true,
    maxVirtualTop,
    toVirtual: (s) => clamp(s, 0, maxScroll) * ratio,
    toScroll: (v) => clamp(v, 0, maxVirtualTop) / ratio,
  };
}

/**
 * Virtual top that brings `row` into view: `'center'` centres it, `'nearest'` scrolls the minimum
 * distance keeping `margin` rows of context (spec 04 §6.13 auto-scroll keeps a 3-row margin).
 */
export function virtualTopForRow(
  row: number,
  rowHeight: number,
  viewportHeight: number,
  currentVirtualTop: number,
  mode: 'center' | 'nearest' = 'nearest',
  margin = 0,
): number {
  const top = row * rowHeight;
  if (mode === 'center') return Math.max(0, top - viewportHeight / 2 + rowHeight / 2);
  const m = Math.min(margin * rowHeight, Math.max(0, (viewportHeight - rowHeight) / 2));
  if (top - m < currentVirtualTop) return Math.max(0, top - m);
  if (top + rowHeight + m > currentVirtualTop + viewportHeight)
    return Math.max(0, top + rowHeight + m - viewportHeight);
  return currentVirtualTop;
}
