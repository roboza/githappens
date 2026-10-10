import { useMemo, useSyncExternalStore } from 'react';

import type { SettingValue } from '../../../shared/settings/registry';
import { formatDate } from './format';

type DateFormat = SettingValue<'ui.dateFormat'>;

/** Minimal timer / visibility surface (injectable for tests). */
export interface ClockEnv {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** False while the window is hidden (minimized / other virtual desktop). */
  visible(): boolean;
  /** Subscribe to visibility changes; returns an unsubscribe. */
  onVisibilityChange(fn: () => void): () => void;
}

const MINUTE = 60_000;

function domEnv(): ClockEnv {
  const doc = typeof document === 'undefined' ? null : document;
  return {
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    visible: () => !doc || doc.visibilityState !== 'hidden',
    onVisibilityChange: (fn) => {
      if (!doc) return () => undefined;
      doc.addEventListener('visibilitychange', fn);
      return () => doc.removeEventListener('visibilitychange', fn);
    },
  };
}

/**
 * Shared clock for relative dates ("5 minutes ago"). Memoized rows (graph, blame, history) never
 * re-render on their own, so their relative dates would go stale; instead of a timer per row, one
 * timer ticks on minute boundaries — only while something subscribed (relative dates on screen) and
 * the window is visible — and subscribers re-check their text. Between ticks `now()` is the last tick
 * time, so every row formats against the same instant and nothing changes mid-scroll.
 */
export class RelativeClock {
  private readonly listeners = new Set<() => void>();
  private timer: unknown = null;
  private nowMs: number;
  private unwatchVisibility: (() => void) | null = null;

  constructor(private readonly env: ClockEnv = domEnv()) {
    this.nowMs = env.now();
  }

  /**
   * Epoch ms to format against: the last tick while ticking, else the real time (moved in whole
   * seconds, so back-to-back `getSnapshot` calls agree).
   */
  now = (): number => {
    if (this.timer === null) {
      const t = this.env.now();
      if (t - this.nowMs >= 1000 || t < this.nowMs) this.nowMs = t;
    }
    return this.nowMs;
  };

  /** `useSyncExternalStore` subscribe (stable). */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) {
      this.unwatchVisibility = this.env.onVisibilityChange(this.onVisibility);
      this.start();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.stop();
        this.unwatchVisibility?.();
        this.unwatchVisibility = null;
      }
    };
  };

  /** Whether the minute timer is armed (tests / diagnostics). */
  get ticking(): boolean {
    return this.timer !== null;
  }

  get subscribers(): number {
    return this.listeners.size;
  }

  /** Re-check every subscriber now (e.g. after the date locale changed). */
  bump(): void {
    if (this.timer !== null) this.nowMs = this.env.now();
    this.generation++;
    this.emit();
  }

  /** Changes on `bump()` (formatting changed even if the time didn't). */
  generation = 0;

  private emit(): void {
    for (const l of [...this.listeners]) l();
  }

  private start(): void {
    if (this.timer !== null || !this.listeners.size || !this.env.visible()) return;
    this.nowMs = this.env.now();
    this.arm();
  }

  private arm(): void {
    const t = this.env.now();
    // Just past the next minute boundary (relative texts round to whole minutes or coarser).
    const delay = MINUTE - (t % MINUTE) + 20;
    this.timer = this.env.setTimeout(this.tick, delay);
  }

  private stop(): void {
    if (this.timer !== null) this.env.clearTimeout(this.timer);
    this.timer = null;
  }

  private readonly tick = (): void => {
    this.timer = null;
    if (!this.listeners.size || !this.env.visible()) return;
    this.nowMs = this.env.now();
    this.arm();
    this.emit();
  };

  private readonly onVisibility = (): void => {
    if (!this.env.visible()) {
      this.stop();
      return;
    }
    if (this.timer === null && this.listeners.size) {
      this.start();
      this.emit(); // catch up on whatever went stale while hidden
    }
  };
}

export const relativeClock = new RelativeClock();

const noSubscribe = (): (() => void) => () => undefined;

/**
 * `getSnapshot` for one date: the formatted text against `clock.now()`, recomputed only when the
 * clock moved (or was bumped). Strings compare by value, so subscribers whose text didn't change
 * don't re-render.
 */
export function createDateSnapshot(
  unixSeconds: number | undefined,
  format: DateFormat,
  clock: RelativeClock = relativeClock,
): () => string {
  const relative = format === 'relative';
  let at = Number.NaN;
  let gen = -1;
  let text = '';
  return (): string => {
    if (unixSeconds === undefined) return '';
    const now = relative ? clock.now() : 0;
    if (now !== at || gen !== clock.generation) {
      at = now;
      gen = clock.generation;
      text = formatDate(unixSeconds, format, relative ? now : undefined);
    }
    return text;
  };
}

/**
 * `formatDate(unixSeconds, format)` that stays current: with the relative format the component
 * subscribes to the shared clock and re-renders only when its own text changes (React compares the
 * snapshot strings), so a list of 50 dates re-renders the one or two rows whose text moved.
 */
export function useFormattedDate(
  unixSeconds: number | undefined,
  format: DateFormat = 'relative',
  clock: RelativeClock = relativeClock,
): string {
  // Subscription depends on the format only, so pooled rows switching between a commit and the WIP
  // row (no date) don't resubscribe while scrolling.
  const relative = format === 'relative';
  const getSnapshot = useMemo(
    () => createDateSnapshot(unixSeconds, format, clock),
    [unixSeconds, format, clock],
  );
  return useSyncExternalStore(relative ? clock.subscribe : noSubscribe, getSnapshot);
}

/** Minute-granular "now" for components that format several dates themselves (Launchpad rows). */
export function useClockNow(clock: RelativeClock = relativeClock): number {
  return useSyncExternalStore(clock.subscribe, clock.now);
}
