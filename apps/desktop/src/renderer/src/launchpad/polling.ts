import { useEffect, useState } from 'react';

/**
 * Launchpad refresh policy pieces that depend on window attention (spec 11 §6.5):
 * - "Window blurred > 10 min → pause; refresh on focus if data older than 2 min"
 * - "Offline → no requests; banner 'Offline — showing data from …'"
 *
 * `PollGate` is DOM-free (unit-tested); the hooks wire it to window focus / online events.
 */

export const BLUR_PAUSE_MS = 10 * 60_000;
export const FOCUS_REFRESH_AGE_MS = 2 * 60_000;

export class PollGate {
  private blurredAt: number | null = null;

  constructor(focused = true, now = Date.now()) {
    if (!focused) this.blurredAt = now;
  }

  blur(now: number): void {
    this.blurredAt ??= now;
  }

  focus(): void {
    this.blurredAt = null;
  }

  /** Polling stops once the window has been blurred for more than 10 minutes. */
  paused(now: number): boolean {
    return this.blurredAt !== null && now - this.blurredAt > BLUR_PAUSE_MS;
  }

  /** Milliseconds until a blurred window crosses the pause threshold (null when focused / paused). */
  msUntilPause(now: number): number | null {
    if (this.blurredAt === null) return null;
    const left = this.blurredAt + BLUR_PAUSE_MS - now;
    return left > 0 ? left + 1 : null;
  }
}

/** On focus: refetch when the snapshot is missing or older than 2 minutes. */
export const shouldRefreshOnFocus = (fetchedAt: number | null | undefined, now: number): boolean =>
  !fetchedAt || now - fetchedAt > FOCUS_REFRESH_AGE_MS;

const docFocused = (): boolean => (typeof document === 'undefined' ? true : document.hasFocus());

/**
 * `paused` = window blurred for > 10 min. `onFocus` runs when the window regains focus.
 * Shared timer per hook instance; cheap.
 */
export function useAttentionPause(onFocus?: () => void): boolean {
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    const gate = new PollGate(docFocused());
    let timer: ReturnType<typeof setTimeout> | null = null;
    const arm = (): void => {
      if (timer) clearTimeout(timer);
      timer = null;
      const left = gate.msUntilPause(Date.now());
      if (left !== null) timer = setTimeout(() => setPaused(gate.paused(Date.now())), left);
    };
    const blur = (): void => {
      gate.blur(Date.now());
      arm();
    };
    const focus = (): void => {
      gate.focus();
      arm();
      setPaused(false);
      onFocus?.();
    };
    arm();
    window.addEventListener('blur', blur);
    window.addEventListener('focus', focus);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener('blur', blur);
      window.removeEventListener('focus', focus);
    };
  }, [onFocus]);
  return paused;
}

/** `navigator.onLine`, kept in sync with the `online` / `offline` events. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  useEffect(() => {
    const up = (): void => setOnline(true);
    const down = (): void => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);
  return online;
}
