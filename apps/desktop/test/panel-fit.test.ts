import { describe, expect, it } from 'vitest';

import { CENTER_MIN, fitPanels, LEFT_MIN, RIGHT_MIN, SPLITTER_W } from '../src/renderer/src/shell/panel-fit';

const base = { left: 260, leftCollapsed: false, right: 380, rightCollapsed: false };
const center = (w: number, f: ReturnType<typeof fitPanels>): number =>
  w - (f.leftHidden ? 0 : f.left + SPLITTER_W) - (f.rightHidden ? 0 : f.right + SPLITTER_W);

describe('fitPanels (spec 01 §4.6 narrow windows)', () => {
  it('keeps stored widths when they fit', () => {
    const f = fitPanels({ ...base, width: 1400 });
    expect(f).toMatchObject({ left: 260, right: 380, leftHidden: false, rightHidden: false });
    expect(f.rightMax).toBeGreaterThanOrEqual(380);
  });

  it('shrinks the left panel, then the right one, so the center keeps its minimum (1024 wide)', () => {
    const f = fitPanels({ ...base, width: 1024 });
    expect(f.left).toBe(LEFT_MIN);
    expect(f.right).toBeLessThan(380);
    expect(f.right).toBeGreaterThanOrEqual(RIGHT_MIN);
    expect(center(1024, f)).toBe(CENTER_MIN);
  });

  it('clamps persisted widths that cannot fit at the 900 px minimum window', () => {
    const f = fitPanels({ ...base, left: 520, right: 1200, width: 900 });
    expect(f).toMatchObject({ left: LEFT_MIN, right: RIGHT_MIN, leftHidden: false, rightHidden: false });
    expect(center(900, f)).toBeGreaterThan(400);
    expect(f.leftMax).toBe(LEFT_MIN);
    expect(f.rightMax).toBe(RIGHT_MIN);
  });

  it('hides the left panel, then the right, when even minimums would crush the center', () => {
    expect(fitPanels({ ...base, width: 700 })).toMatchObject({ leftHidden: true, rightHidden: false });
    expect(fitPanels({ ...base, width: 500 })).toMatchObject({ leftHidden: true, rightHidden: true });
  });

  it('respects user collapse and ignores unmeasured width', () => {
    const f = fitPanels({ ...base, leftCollapsed: true, width: 1024 });
    expect(f.leftHidden).toBe(true);
    expect(f.right).toBe(380);
    expect(fitPanels({ ...base, width: 0 })).toMatchObject({ left: 260, right: 380 });
  });
});
