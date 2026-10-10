import type { ItemUserState, SnoozeState } from './types';

/** Snooze menu entries (spec 11 §4.2). */
export type SnoozePreset = '1h' | '4h' | 'tomorrow' | 'next-week' | 'until-updated' | 'indefinite';

export const SNOOZE_PRESETS: Array<{ id: SnoozePreset; label: string }> = [
  { id: '1h', label: '1 hour' },
  { id: '4h', label: '4 hours' },
  { id: 'tomorrow', label: 'Tomorrow (09:00)' },
  { id: 'next-week', label: 'Next week (Mon 09:00)' },
  { id: 'until-updated', label: 'Until updated' },
  { id: 'indefinite', label: 'Indefinitely' },
];

const HOUR = 3_600_000;

/** Local 09:00 on the day after `now`. */
export function tomorrowAt9(now: number): number {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.getTime();
}

/** Local 09:00 on the next Monday strictly after today (a Monday snoozes a full week). */
export function nextMondayAt9(now: number): number {
  const d = new Date(now);
  const days = (8 - d.getDay()) % 7 || 7;
  d.setDate(d.getDate() + days);
  d.setHours(9, 0, 0, 0);
  return d.getTime();
}

/** Build the persisted snooze for a preset. `until-updated` needs the item's current `updatedAt`. */
export function snoozeFor(preset: SnoozePreset, now: number, itemUpdatedAt?: string): SnoozeState {
  const snoozedAt = new Date(now).toISOString();
  const at = (ms: number): SnoozeState => ({ until: new Date(ms).toISOString(), snoozedAt });
  switch (preset) {
    case '1h':
      return at(now + HOUR);
    case '4h':
      return at(now + 4 * HOUR);
    case 'tomorrow':
      return at(tomorrowAt9(now));
    case 'next-week':
      return at(nextMondayAt9(now));
    case 'until-updated':
      return { untilUpdatedAfter: itemUpdatedAt ?? snoozedAt, snoozedAt };
    case 'indefinite':
      return { indefinite: true, snoozedAt };
  }
}

const time = (iso: string | undefined): number => (iso ? Date.parse(iso) : NaN);

/**
 * Whether a snooze still hides the item (spec 11 §5.3 rule 0'): expired `until` or an item updated
 * after `untilUpdatedAfter` (any update, including the viewer's own — §8) ends it.
 */
export function isSnoozeActive(
  s: SnoozeState | undefined,
  itemUpdatedAt: string | undefined,
  now: number,
): boolean {
  if (!s) return false;
  if (s.untilUpdatedAfter) {
    const updated = time(itemUpdatedAt);
    if (!Number.isNaN(updated) && updated > time(s.untilUpdatedAfter)) return false;
  }
  if (s.until) {
    const until = time(s.until);
    if (Number.isNaN(until) || now >= until) return false;
  }
  return !!(s.indefinite || s.until || s.untilUpdatedAfter);
}

/** Earliest future `until` among the states (for the main-process expiry timer), or null. */
export function nextSnoozeExpiry(states: Iterable<ItemUserState>, now: number): number | null {
  let best: number | null = null;
  for (const st of states) {
    const until = time(st.snooze?.until);
    if (!Number.isNaN(until) && until > now && (best === null || until < best)) best = until;
  }
  return best;
}

/** Human description of a snooze, e.g. "until Mon 09:00" / "until updated" / "indefinitely". */
export function describeSnooze(s: SnoozeState, now: number): string {
  if (s.indefinite) return 'indefinitely';
  if (s.untilUpdatedAfter && !s.until) return 'until updated';
  const until = time(s.until);
  if (Number.isNaN(until)) return 'snoozed';
  const d = new Date(until);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const sameDay = new Date(now).toDateString() === d.toDateString();
  if (sameDay) return `until ${hh}:${mm}`;
  const day = d.toLocaleDateString('en-US', { weekday: 'short' });
  return `until ${day} ${hh}:${mm}`;
}
