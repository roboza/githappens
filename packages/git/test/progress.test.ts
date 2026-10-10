import { describe, expect, it, vi } from 'vitest';

import { parseProgressLine, ProgressParser, throttle } from '../src';

// Recorded (abridged) stderr of `git clone --progress`, including \r rewrites.
const CLONE_STDERR = [
  "Cloning into 'repo'...\n",
  'remote: Enumerating objects: 1520, done.\n',
  'remote: Counting objects:  50% (10/20)\rremote: Counting objects: 100% (20/20), done.\n',
  'remote: Compressing objects: 100% (15/15), done.\n',
  'Receiving objects:   0% (0/1520)\rReceiving objects:  40% (608/1520), 1.2 MiB | 2.0 MiB/s\r',
  'Receiving objects: 100% (1520/1520), 3.1 MiB | 2.4 MiB/s, done.\n',
  'Resolving deltas:  50% (300/600)\rResolving deltas: 100% (600/600), done.\n',
  'Updating files:  50% (40/80)\rUpdating files: 100% (80/80), done.\n',
];

describe('parseProgressLine', () => {
  it('parses determinate lines', () => {
    expect(parseProgressLine('Receiving objects:  40% (608/1520), 1.2 MiB')).toEqual({
      phase: 'Receiving objects',
      percent: 40,
      current: 608,
      total: 1520,
    });
  });

  it('parses remote-prefixed and indeterminate lines', () => {
    expect(parseProgressLine('remote: Counting objects: 1234')).toEqual({
      phase: 'Counting objects',
      percent: null,
      current: 1234,
    });
  });

  it('ignores non-progress lines', () => {
    expect(parseProgressLine("Cloning into 'repo'...")).toBeNull();
  });
});

describe('ProgressParser', () => {
  it('produces monotonically non-decreasing overall progress for a clone', () => {
    const p = new ProgressParser('clone');
    const events = CLONE_STDERR.flatMap((c) => p.push(c)).concat(p.end());
    const overall = events.map((e) => e.overall ?? 0);
    for (let i = 1; i < overall.length; i++) expect(overall[i]!).toBeGreaterThanOrEqual(overall[i - 1]!);
    expect(overall[overall.length - 1]).toBeCloseTo(1, 5);
    expect(p.otherLines).toContain("Cloning into 'repo'...");
  });

  it('handles lines split across chunks', () => {
    const p = new ProgressParser('fetch');
    expect(p.push('Receiving obj')).toEqual([]);
    const evs = p.push('ects:  50% (5/10)\r');
    expect(evs[0]?.percent).toBe(50);
    expect(evs[0]?.overall).toBeCloseTo(0.1 + 0.35);
  });

  it('weights push phases', () => {
    const p = new ProgressParser('push');
    const [e] = p.push('Writing objects: 100% (3/3), 300 bytes | 300.00 KiB/s, done.\n');
    expect(e?.overall).toBeCloseTo(1);
  });
});

describe('throttle', () => {
  it('emits leading + trailing values at most once per interval', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const t = throttle(fn, 100);
    t.call(1);
    t.call(2);
    t.call(3);
    expect(fn.mock.calls).toEqual([[1]]);
    vi.advanceTimersByTime(100);
    expect(fn.mock.calls).toEqual([[1], [3]]);
    t.call(4);
    t.flush();
    expect(fn.mock.calls).toEqual([[1], [3], [4]]);
    vi.useRealTimers();
  });
});
