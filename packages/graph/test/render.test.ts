import { describe, expect, it } from 'vitest';

import {
  COMPACT_METRICS,
  NORMAL_METRICS,
  createMetrics,
  drawGraph,
  graphColumnWidth,
  hitTestNode,
  laneX,
  rowAtY,
  rowCenterY,
  visibleRowRange,
  type GraphCanvasContext,
} from '../src';
import { build, c, randomHistory } from './helpers';

interface Call {
  name: string;
  args: unknown[];
  state: Record<string, unknown>;
}

/** Minimal CanvasRenderingContext2D recorder: records every method call with the current style state. */
function fakeCtx() {
  const calls: Call[] = [];
  const state: Record<string, unknown> = {};
  const ctx = new Proxy(state, {
    get(_t, prop: string) {
      if (prop in state) return state[prop];
      return (...args: unknown[]) => {
        calls.push({ name: prop, args, state: { ...state } });
        if (prop === 'createLinearGradient') return { addColorStop: () => {} };
        return undefined;
      };
    },
    set(_t, prop: string, value) {
      state[prop] = value;
      return true;
    },
  });
  return {
    ctx: ctx as unknown as GraphCanvasContext,
    calls,
    count: (n: string) => calls.filter((x) => x.name === n).length,
  };
}

const colors = ['#f00', '#0f0', '#00f', '#ff0'];

function chain(n: number) {
  return Array.from({ length: n }, (_, i) => c(`c${i}`, i < n - 1 ? [`c${i + 1}`] : []));
}

describe('metrics', () => {
  it('presets follow §4.3 and scale with zoom', () => {
    expect(NORMAL_METRICS).toMatchObject({
      rowHeight: 28,
      laneWidth: 22,
      nodeRadius: 10,
      avatarSize: 16,
      mergeDotRadius: 4,
    });
    expect(COMPACT_METRICS).toMatchObject({
      rowHeight: 22,
      laneWidth: 12,
      nodeRadius: 4,
      avatarSize: 0,
      mergeDotRadius: 3,
    });
    const z = createMetrics('normal', { zoom: 1.5, edgeStyle: 'bezier' });
    expect(z.rowHeight).toBe(42);
    expect(z.edgeStyle).toBe('bezier');
    expect(graphColumnWidth(NORMAL_METRICS, 2)).toBe(6 * 2 + 3 * 22);
    expect(graphColumnWidth(NORMAL_METRICS, 100)).toBe(400);
    expect(graphColumnWidth(NORMAL_METRICS, -1)).toBe(34);
  });
});

describe('drawGraph', () => {
  it('touches only visible rows ± 1', () => {
    const m = build(chain(10_000));
    const { ctx, count, calls } = fakeCtx();
    const scrollTop = 5000 * 28 + 7;
    const res = drawGraph(ctx, m, {
      scrollTop,
      width: 200,
      height: 280,
      dpr: 2,
      metrics: NORMAL_METRICS,
      colors,
    });
    expect(res.firstRow).toBe(4999);
    expect(res.lastRow).toBe(5011);
    expect(res.nodeCount).toBe(13);
    expect(res.edgeCount).toBe(13);
    expect(count('arc')).toBe(13 * 2); // fill + ring per commit node
    expect(count('stroke')).toBe(1 + 13); // one bucket for all edges + rings
    // coordinates are relative to the first drawn row (small numbers even deep in history)
    for (const call of calls.filter((x) => x.name === 'moveTo' || x.name === 'lineTo')) {
      expect(Math.abs(call.args[1] as number)).toBeLessThan(28 * 20);
    }
    const tf = calls.filter((x) => x.name === 'setTransform');
    expect(tf[1]!.args).toEqual([2, 0, 0, 2, -0, (4999 * 28 - scrollTop) * 2]);
    expect(calls[1]).toMatchObject({ name: 'clearRect', args: [0, 0, 400, 560] });
  });

  it('draws nothing (but clears) for an empty model', () => {
    const { ctx, count } = fakeCtx();
    const res = drawGraph(ctx, build([]), {
      scrollTop: 0,
      width: 100,
      height: 100,
      metrics: NORMAL_METRICS,
      colors,
    });
    expect(res.lastRow).toBe(-1);
    expect(count('clearRect')).toBe(1);
    expect(count('stroke')).toBe(0);
  });

  it('renders every node kind and edge shape without throwing (normal, compact, bezier)', () => {
    const m = build([c('h', ['m'], 50), c('m', ['a', 'b'], 40), c('b', ['a'], 30), c('a', ['gone'], 20)], {
      headSha: 'h',
      wip: true,
      stashes: [{ sha: 'S', parents: ['a', 'i'], time: 25 }],
    });
    const img = {} as CanvasImageSource;
    for (const metrics of [
      NORMAL_METRICS,
      COMPACT_METRICS,
      createMetrics('normal', { edgeStyle: 'bezier' }),
    ]) {
      const { ctx, count } = fakeCtx();
      drawGraph(ctx, m, {
        scrollTop: 0,
        width: 300,
        height: 400,
        metrics,
        colors,
        selected: new Set(['m']),
        hoverRow: 2,
        avatars: (sha) => (sha === 'h' ? img : null),
        initials: () => ({ text: 'AB', color: '#123' }),
      });
      if (metrics.edgeStyle === 'bezier') expect(count('bezierCurveTo')).toBeGreaterThan(0);
      else expect(count('arcTo')).toBeGreaterThan(0);
      expect(count('rect')).toBe(1); // stash box
      expect(count('createLinearGradient')).toBe(1); // fading edge into the unloaded parent
      if (!metrics.compact) {
        expect(count('drawImage')).toBe(1);
        expect(count('fillText')).toBe(2); // b and a use initials; h has an avatar; m is a merge dot
      }
    }
  });

  it('dims rows and edges outside the highlight set to 30% alpha', () => {
    const m = build([c('x', ['p']), c('y', ['p']), c('p')]);
    const { ctx, calls } = fakeCtx();
    drawGraph(ctx, m, {
      scrollTop: 0,
      width: 200,
      height: 200,
      metrics: COMPACT_METRICS,
      colors,
      highlight: m.reachable('y'),
    });
    const fills = calls.filter((x) => x.name === 'fill').map((x) => x.state.globalAlpha);
    expect(fills).toEqual([0.3, 1, 1]);
    const strokes = calls.filter((x) => x.name === 'stroke').map((x) => x.state.globalAlpha);
    expect(strokes[0]).toBe(0.3); // dimmed bucket first, highlighted last
    expect(strokes.at(-1)).toBe(1);
    const dimSet = fakeCtx();
    drawGraph(dimSet.ctx, m, {
      scrollTop: 0,
      width: 200,
      height: 200,
      metrics: COMPACT_METRICS,
      colors,
      dimmed: new Set([2]),
    });
    expect(dimSet.calls.filter((x) => x.name === 'fill').map((x) => x.state.globalAlpha)).toEqual([
      1, 1, 0.3,
    ]);
  });

  it('draws an overflow fade and reports hidden lanes when lanes exceed the width', () => {
    const commits = [...Array.from({ length: 20 }, (_, i) => c(`t${i}`, ['base'])), c('base')];
    const m = build(commits);
    const { ctx, count } = fakeCtx();
    const res = drawGraph(ctx, m, { scrollTop: 0, width: 100, height: 600, metrics: NORMAL_METRICS, colors });
    expect(res.hiddenLanes).toBe(20 - 4);
    expect(count('fillRect')).toBe(1);
    const wide = fakeCtx();
    expect(
      drawGraph(wide.ctx, m, { scrollTop: 0, width: 1000, height: 600, metrics: NORMAL_METRICS, colors })
        .hiddenLanes,
    ).toBe(0);
    expect(wide.count('fillRect')).toBe(0);
  });

  it('never throws on random graphs and random viewports', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const { commits, options } = randomHistory(seed, 60);
      const m = build(commits, options);
      const { ctx } = fakeCtx();
      const top = (seed * 37) % (60 * 28);
      const res = drawGraph(ctx, m, {
        scrollTop: top,
        width: 120,
        height: 300,
        dpr: 1.25,
        metrics: NORMAL_METRICS,
        colors,
      });
      const range = visibleRowRange(m.rowCount, NORMAL_METRICS, top, 300);
      expect([res.firstRow, res.lastRow]).toEqual([range.firstRow, range.lastRow]);
    }
  });
});

describe('hit testing', () => {
  const m = build([c('a', ['m']), c('b', ['m']), c('m')]);

  it('hits nodes within nodeRadius + slop, in absolute or scrolled coordinates', () => {
    const x = laneX(NORMAL_METRICS, 1);
    const y = rowCenterY(NORMAL_METRICS, 1);
    expect(hitTestNode(m, NORMAL_METRICS, x + 12, y)).toMatchObject({ row: 1, sha: 'b' });
    expect(hitTestNode(m, NORMAL_METRICS, x + 14, y)).toBeNull();
    expect(hitTestNode(m, NORMAL_METRICS, x, y - 28 + 5, { scrollTop: 28 })).toMatchObject({ row: 1 });
    expect(hitTestNode(m, NORMAL_METRICS, x - 20, y, { scrollX: 20 })).toMatchObject({ row: 1 });
    expect(hitTestNode(m, NORMAL_METRICS, laneX(NORMAL_METRICS, 0), y)).toBeNull(); // empty lane on that row
    expect(hitTestNode(m, NORMAL_METRICS, 5, 10_000)).toBeNull();
  });

  it('rowAtY', () => {
    expect(rowAtY(3, NORMAL_METRICS, 27)).toBe(0);
    expect(rowAtY(3, NORMAL_METRICS, 28)).toBe(1);
    expect(rowAtY(3, NORMAL_METRICS, 5, 56)).toBe(2);
    expect(rowAtY(3, NORMAL_METRICS, 90)).toBe(-1);
  });
});
