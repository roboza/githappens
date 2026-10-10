import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureDates } from '../src/renderer/src/lib/format';
import { createDateSnapshot, RelativeClock, type ClockEnv } from '../src/renderer/src/lib/relative-clock';

/** Shared minute clock for relative dates (graph rows, blame, history, commit detail, Launchpad). */

const T0 = Date.parse('2026-10-10T12:00:30Z');

let visible: boolean;
let visListeners: Set<() => void>;

function env(): ClockEnv {
  return {
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    visible: () => visible,
    onVisibilityChange: (fn) => {
      visListeners.add(fn);
      return () => visListeners.delete(fn);
    },
  };
}
const setVisible = (v: boolean): void => {
  visible = v;
  for (const l of [...visListeners]) l();
};

/**
 * What `useSyncExternalStore` does for one row: render with `getSnapshot()`, and on every store
 * notification re-render only when the snapshot differs (Object.is).
 */
function mountRow(
  clock: RelativeClock,
  unixSeconds: number | undefined,
  format: 'relative' | 'iso' = 'relative',
) {
  const getSnapshot = createDateSnapshot(unixSeconds, format, clock);
  const row = { text: getSnapshot(), renders: 1, unsubscribe: () => undefined as unknown };
  row.unsubscribe = clock.subscribe(() => {
    const next = getSnapshot();
    if (!Object.is(next, row.text)) {
      row.text = next;
      row.renders++;
    }
  });
  return row;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  visible = true;
  visListeners = new Set();
  configureDates({ locale: 'en-US' });
});
afterEach(() => {
  vi.useRealTimers();
  configureDates({});
});

const sec = (ms: number): number => Math.floor(ms / 1000);

describe('RelativeClock', () => {
  it('does not tick without subscribers', () => {
    const clock = new RelativeClock(env());
    expect(clock.ticking).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ticks on minute boundaries while subscribed, stops when the last one leaves', () => {
    const clock = new RelativeClock(env());
    const seen: number[] = [];
    const off = clock.subscribe(() => seen.push(clock.now()));
    expect(clock.ticking).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(29_900); // 12:00:59.9 → not yet
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(200); // just past 12:01:00
    expect(seen).toHaveLength(1);
    expect(seen[0]! % 60_000).toBeLessThan(1000); // aligned to the boundary
    vi.advanceTimersByTime(60_000);
    expect(seen).toHaveLength(2);
    off();
    expect(clock.ticking).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5 * 60_000);
    expect(seen).toHaveLength(2);
  });

  it('now() is the last tick while ticking (stable within a minute)', () => {
    const clock = new RelativeClock(env());
    const off = clock.subscribe(() => undefined);
    const a = clock.now();
    vi.advanceTimersByTime(20_000);
    expect(clock.now()).toBe(a);
    off();
    expect(clock.now()).toBe(Date.now());
  });

  it('now() without ticking moves in whole seconds (stable getSnapshot)', () => {
    const clock = new RelativeClock(env());
    const a = clock.now();
    vi.advanceTimersByTime(400);
    expect(clock.now()).toBe(a);
    vi.advanceTimersByTime(700);
    expect(clock.now()).toBe(Date.now());
  });

  it('pauses while the window is hidden and catches up when visible again', () => {
    const clock = new RelativeClock(env());
    let n = 0;
    clock.subscribe(() => n++);
    setVisible(false);
    expect(clock.ticking).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10 * 60_000);
    expect(n).toBe(0);
    setVisible(true);
    expect(n).toBe(1); // immediate catch-up
    expect(clock.ticking).toBe(true);
    expect(clock.now()).toBe(Date.now());
  });

  it('subscribing while hidden does not start the timer', () => {
    visible = false;
    const clock = new RelativeClock(env());
    clock.subscribe(() => undefined);
    expect(clock.ticking).toBe(false);
    setVisible(true);
    expect(clock.ticking).toBe(true);
  });

  it('bump() re-checks subscribers (locale change)', () => {
    const clock = new RelativeClock(env());
    const row = mountRow(clock, sec(T0) - 3 * 3600);
    expect(row.text).toBe('3 hours ago');
    configureDates({ locale: 'de-DE' });
    clock.bump();
    expect(row.text).toBe('vor 3 Stunden');
    expect(row.renders).toBe(2);
  });
});

describe('row re-render only when its relative text changes', () => {
  it('recent commits update per minute, old ones not at all', () => {
    const clock = new RelativeClock(env());
    const recent = mountRow(clock, sec(T0) - 5 * 60); // 5 minutes ago
    const old = mountRow(clock, sec(T0) - 400 * 86_400); // last year
    expect(recent.text).toBe('5 minutes ago');
    expect(old.text).toBe('last year');
    vi.advanceTimersByTime(60_000);
    expect(recent.text).toBe('6 minutes ago');
    vi.advanceTimersByTime(10 * 60_000);
    expect(recent.text).toBe('16 minutes ago');
    expect(recent.renders).toBe(12);
    expect(old.renders).toBe(1);
  });

  it('hour-old commits re-render only when the hour count changes', () => {
    const clock = new RelativeClock(env());
    const row = mountRow(clock, sec(T0) - 2 * 3600); // 2 hours ago
    vi.advanceTimersByTime(29 * 60_000);
    expect(row.text).toBe('2 hours ago');
    expect(row.renders).toBe(1);
    vi.advanceTimersByTime(2 * 60_000); // 2.5 h rounds to 3
    expect(row.text).toBe('3 hours ago');
    expect(row.renders).toBe(2);
  });

  it('fixed formats never subscribe-update and rows without a date stay empty', () => {
    const clock = new RelativeClock(env());
    const iso = createDateSnapshot(sec(T0), 'iso', clock);
    expect(iso()).toBe('2026-10-10 12:00:30');
    const none = createDateSnapshot(undefined, 'relative', clock);
    expect(none()).toBe('');
  });

  it('getSnapshot is stable between ticks (no recompute, same string)', () => {
    const clock = new RelativeClock(env());
    clock.subscribe(() => undefined);
    const snap = createDateSnapshot(sec(T0) - 90, 'relative', clock);
    const a = snap();
    vi.advanceTimersByTime(10_000);
    expect(snap()).toBe(a);
  });

  it('a hidden window does no work; text is current again on return', () => {
    const clock = new RelativeClock(env());
    const row = mountRow(clock, sec(T0) - 60);
    setVisible(false);
    vi.advanceTimersByTime(30 * 60_000);
    expect(row.renders).toBe(1);
    setVisible(true);
    expect(row.text).toBe('31 minutes ago');
    expect(row.renders).toBe(2);
  });
});
