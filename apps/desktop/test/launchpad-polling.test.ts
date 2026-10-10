import { describe, expect, it } from 'vitest';

import {
  BLUR_PAUSE_MS,
  FOCUS_REFRESH_AGE_MS,
  PollGate,
  shouldRefreshOnFocus,
} from '../src/renderer/src/launchpad/polling';

describe('Launchpad polling gate (spec 11 §6.5)', () => {
  it('pauses only after the window has been blurred for more than 10 minutes', () => {
    const g = new PollGate(true, 0);
    expect(g.paused(0)).toBe(false);
    expect(g.msUntilPause(0)).toBeNull();
    g.blur(1_000);
    g.blur(5_000); // repeated blur keeps the first timestamp
    expect(g.paused(1_000 + BLUR_PAUSE_MS)).toBe(false);
    expect(g.msUntilPause(1_000)).toBe(BLUR_PAUSE_MS + 1);
    expect(g.paused(1_001 + BLUR_PAUSE_MS)).toBe(true);
    expect(g.msUntilPause(2_000 + BLUR_PAUSE_MS)).toBeNull();
    g.focus();
    expect(g.paused(10 * BLUR_PAUSE_MS)).toBe(false);
  });

  it('starts blurred when the window is not focused', () => {
    const g = new PollGate(false, 0);
    expect(g.paused(BLUR_PAUSE_MS + 1)).toBe(true);
  });

  it('refreshes on focus only when data is missing or older than 2 minutes', () => {
    const now = 1_000_000;
    expect(shouldRefreshOnFocus(null, now)).toBe(true);
    expect(shouldRefreshOnFocus(now - 30_000, now)).toBe(false);
    expect(shouldRefreshOnFocus(now - FOCUS_REFRESH_AGE_MS - 1, now)).toBe(true);
  });
});
