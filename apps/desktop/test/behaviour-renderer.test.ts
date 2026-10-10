import type { CommandLogEntry } from '@githappens/git/types';
import { describe, expect, it } from 'vitest';

import { configureDates, dateOptionsFrom, formatDate, fullDate } from '../src/renderer/src/lib/format';
import { describeAutoFetch } from '../src/renderer/src/notifications/auto-fetch-state';
import {
  addToast,
  lastError,
  MAX_HISTORY,
  unreadCount,
  visibleToasts,
  type ToastModel,
} from '../src/renderer/src/notifications/toast-model';
import { filterEntries, formatCommandLine, subcommand } from '../src/renderer/src/views/activity/format';

describe('toast model (spec 01 §4.10)', () => {
  let n = 0;
  const id = (): string => `t${++n}`;
  const empty = (): ToastModel => ({ toasts: [], history: [] });

  it('coalesces identical toasts into one with a counter', () => {
    let m = empty();
    const a = addToast(m, { kind: 'error', title: 'Fetch failed', body: 'offline' }, id, 1);
    m = a.model;
    const b = addToast(m, { kind: 'error', title: 'Fetch failed', body: 'offline' }, id, 2);
    m = b.model;
    expect(b.coalesced).toBe(true);
    expect(b.id).toBe(a.id);
    expect(m.toasts).toHaveLength(1);
    expect(m.toasts[0]!.count).toBe(2);
    expect(m.history).toHaveLength(1);
    expect(m.history[0]!.count).toBe(2);
    const c = addToast(m, { kind: 'error', title: 'Fetch failed', body: 'other' }, id, 3);
    expect(c.coalesced).toBe(false);
    expect(c.model.toasts).toHaveLength(2);
  });

  it('coalesces by explicit key and replaces by explicit id', () => {
    let m = addToast(empty(), { kind: 'warning', title: 'A', key: 'k' }, id, 1).model;
    m = addToast(m, { kind: 'warning', title: 'A (again)', key: 'k' }, id, 2).model;
    expect(m.toasts).toHaveLength(1);
    expect(m.toasts[0]).toMatchObject({ title: 'A (again)', count: 2 });
    m = addToast(m, { id: 'fixed', kind: 'progress', title: 'Cloning 10%' }, id, 3).model;
    m = addToast(m, { id: 'fixed', kind: 'success', title: 'Cloned' }, id, 4).model;
    expect(m.toasts.filter((t) => t.id === 'fixed')).toEqual([
      expect.objectContaining({ title: 'Cloned', count: 1 }),
    ]);
    // progress toasts are not recorded in the notification center
    expect(m.history.map((h) => h.title)).toEqual(['Cloned', 'A (again)']);
  });

  it('keeps at most 2 actions, 4 visible toasts and bounded history', () => {
    let m = empty();
    const run = (): void => undefined;
    m = addToast(
      m,
      {
        kind: 'error',
        title: 'x',
        actions: [
          { label: '1', run },
          { label: '2', run },
          { label: '3', run },
        ],
      },
      id,
      0,
    ).model;
    expect(m.toasts[0]!.actions).toHaveLength(2);
    for (let i = 0; i < MAX_HISTORY + 10; i++) m = addToast(m, { kind: 'info', title: `n${i}` }, id, i).model;
    expect(visibleToasts(m.toasts)).toHaveLength(4);
    expect(visibleToasts(m.toasts).at(-1)!.title).toBe(`n${MAX_HISTORY + 9}`);
    expect(m.history).toHaveLength(MAX_HISTORY);
    expect(unreadCount(m.history)).toBe(MAX_HISTORY);
  });

  it('reports the newest recent error for the status bar', () => {
    let m = addToast(empty(), { kind: 'error', title: 'old' }, id, 0).model;
    m = addToast(m, { kind: 'info', title: 'info' }, id, 1000).model;
    m = addToast(m, { kind: 'error', title: 'new' }, id, 2000).model;
    expect(lastError(m.history, 3000)!.title).toBe('new');
    expect(lastError(m.history, 2000 + 31 * 60_000)).toBeNull();
  });
});

describe('date formatting (ui.dateLocale / ui.hour12)', () => {
  const ts = Date.UTC(2024, 0, 15, 15, 5, 0) / 1000;

  it('resolves locale and clock options', () => {
    expect(dateOptionsFrom('system', 'locale')).toEqual({});
    expect(dateOptionsFrom('de-DE', '24')).toEqual({ locale: 'de-DE', hour12: false });
    expect(dateOptionsFrom('en-US', '12')).toEqual({ locale: 'en-US', hour12: true });
    expect(dateOptionsFrom('not a locale!!', 'locale')).toEqual({});
  });

  it('formats with the configured locale and clock', () => {
    const en12 = formatDate(ts, 'long', Date.now(), { locale: 'en-US', hour12: true });
    const en24 = formatDate(ts, 'long', Date.now(), { locale: 'en-US', hour12: false });
    expect(en12).toMatch(/January/);
    expect(en12).toMatch(/AM|PM/);
    expect(en24).not.toMatch(/AM|PM/);
    expect(formatDate(ts, 'long', Date.now(), { locale: 'de-DE' })).toMatch(/Januar/);
    expect(formatDate(ts, 'iso', Date.now(), { locale: 'de-DE' })).toBe('2024-01-15 15:05:00');
    expect(fullDate(ts, { locale: 'fr-FR' })).toMatch(/janvier/);
  });

  it('relative dates use the configured locale', () => {
    const now = (ts + 3 * 24 * 3600) * 1000;
    configureDates({ locale: 'de-DE' });
    try {
      expect(formatDate(ts, 'relative', now)).toBe('vor 3 Tagen');
    } finally {
      configureDates({});
    }
    expect(formatDate(ts, 'relative', now, { locale: 'en-US' })).toBe('3 days ago');
  });
});

describe('activity log helpers', () => {
  const e = (over: Partial<CommandLogEntry>): CommandLogEntry => ({
    id: Math.random().toString(),
    argv: ['status'],
    cwd: '/r',
    startedAt: 0,
    durationMs: 1,
    exitCode: 0,
    stdoutPreview: '',
    stderr: '',
    ...over,
  });

  it('formats and filters commands', () => {
    expect(formatCommandLine(['commit', '-m', 'two words'])).toBe('git commit -m "two words"');
    expect(subcommand(['-c', 'user.name=x', 'commit', '-m', 'x'])).toBe('commit');
    const list = [e({ argv: ['status'] }), e({ argv: ['push'], opId: 'o', exitCode: 1, stderr: 'rejected' })];
    expect(filterEntries(list, 'all')).toHaveLength(2);
    expect(filterEntries(list, 'ops')).toHaveLength(1);
    expect(filterEntries(list, 'failed')[0]!.argv).toEqual(['push']);
    expect(filterEntries(list, 'all', 'REJECTED')).toHaveLength(1);
  });

  it('describes auto-fetch state for the Pull button tooltip', () => {
    const base = {
      repoId: 'r' as never,
      enabled: true,
      lastFetchAt: 1_000,
      nextFetchAt: 61_000,
      paused: false,
      failures: 0,
      running: false,
    };
    expect(describeAutoFetch(base, 31_000)).toBe('Next auto-fetch in 30s · last fetched 30s ago');
    expect(describeAutoFetch({ ...base, paused: true, nextFetchAt: null }, 31_000)).toMatch(
      /^Auto-fetch paused/,
    );
    expect(describeAutoFetch({ ...base, enabled: false })).toBe('Auto-fetch is off');
  });
});
