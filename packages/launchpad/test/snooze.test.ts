import { describe, expect, it } from 'vitest';

import {
  describeSnooze,
  isSnoozeActive,
  nextMondayAt9,
  nextSnoozeExpiry,
  snoozeFor,
  tomorrowAt9,
  type SnoozePreset,
} from '../src/snooze';
import type { SnoozeState } from '../src/types';

// Local-time anchors so the tests hold in every time zone.
const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const WED = local(2026, 10, 7, 15, 30); // Wednesday
const MON = local(2026, 10, 5, 8, 0); // Monday
const SUN = local(2026, 10, 11, 22, 0); // Sunday

describe('snooze presets', () => {
  const cases: Array<[SnoozePreset, number, number | null]> = [
    ['1h', WED, WED + 3_600_000],
    ['4h', WED, WED + 4 * 3_600_000],
    ['tomorrow', WED, local(2026, 10, 8, 9)],
    ['tomorrow', local(2026, 10, 31, 23, 0), local(2026, 11, 1, 9)],
    ['next-week', WED, local(2026, 10, 12, 9)],
    ['next-week', MON, local(2026, 10, 12, 9)],
    ['next-week', SUN, local(2026, 10, 12, 9)],
  ];
  it.each(cases)('%s from %s', (preset, now, expected) => {
    expect(Date.parse(snoozeFor(preset, now).until!)).toBe(expected);
  });

  it('until-updated records the item version', () => {
    expect(snoozeFor('until-updated', WED, '2026-10-01T00:00:00Z')).toMatchObject({
      untilUpdatedAfter: '2026-10-01T00:00:00Z',
    });
  });
  it('indefinite has no deadline', () => {
    const s = snoozeFor('indefinite', WED);
    expect(s.indefinite).toBe(true);
    expect(s.until).toBeUndefined();
  });
  it('helpers agree with presets', () => {
    expect(tomorrowAt9(WED)).toBe(local(2026, 10, 8, 9));
    expect(nextMondayAt9(WED)).toBe(local(2026, 10, 12, 9));
  });
});

describe('isSnoozeActive', () => {
  const at = '2026-10-01T00:00:00.000Z';
  const now = Date.parse('2026-10-09T12:00:00Z');
  const cases: Array<[string, SnoozeState | undefined, string, boolean]> = [
    ['no snooze', undefined, at, false],
    ['future until', { until: '2026-10-09T13:00:00Z', snoozedAt: at }, at, true],
    ['past until', { until: '2026-10-09T11:00:00Z', snoozedAt: at }, at, false],
    ['until exactly now', { until: '2026-10-09T12:00:00Z', snoozedAt: at }, at, false],
    ['indefinite', { indefinite: true, snoozedAt: at }, at, true],
    ['until-updated, unchanged', { untilUpdatedAfter: at, snoozedAt: at }, at, true],
    ['until-updated, older item', { untilUpdatedAfter: at, snoozedAt: at }, '2026-09-01T00:00:00Z', true],
    ['until-updated, updated', { untilUpdatedAfter: at, snoozedAt: at }, '2026-10-02T00:00:00Z', false],
    [
      'indefinite but updated (until-updated cancels)',
      { indefinite: true, untilUpdatedAfter: at, snoozedAt: at },
      '2026-10-02T00:00:00Z',
      false,
    ],
    ['empty snooze object', { snoozedAt: at }, at, false],
  ];
  it.each(cases)('%s', (_n, s, updatedAt, expected) => {
    expect(isSnoozeActive(s, updatedAt, now)).toBe(expected);
  });
});

describe('nextSnoozeExpiry', () => {
  it('returns the nearest future until', () => {
    const now = Date.parse('2026-10-09T12:00:00Z');
    const s = (until?: string) => ({ uid: until ?? 'x', snooze: { until, snoozedAt: '' } });
    expect(
      nextSnoozeExpiry(
        [s('2026-10-09T15:00:00Z'), s('2026-10-09T13:00:00Z'), s('2026-10-09T11:00:00Z'), s()],
        now,
      ),
    ).toBe(Date.parse('2026-10-09T13:00:00Z'));
    expect(nextSnoozeExpiry([s('2026-10-09T11:00:00Z')], now)).toBeNull();
  });

  it('describes snoozes', () => {
    expect(describeSnooze({ indefinite: true, snoozedAt: '' }, WED)).toBe('indefinitely');
    expect(describeSnooze({ untilUpdatedAfter: 'x', snoozedAt: '' }, WED)).toBe('until updated');
    expect(describeSnooze(snoozeFor('1h', WED), WED)).toBe('until 16:30');
    expect(describeSnooze(snoozeFor('next-week', WED), WED)).toBe('until Mon 09:00');
  });
});
