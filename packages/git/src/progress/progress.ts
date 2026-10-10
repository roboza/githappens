import type { ProgressEvent } from '../types';

/**
 * Parses git `--progress` stderr into structured events (spec 02 §6.4).
 * Git rewrites lines with `\r`, so input is split on both `\r` and `\n`.
 */

export type ProgressKind = 'clone' | 'fetch' | 'push' | 'checkout' | 'generic';

interface Bucket {
  match: RegExp;
  weight: number;
}

const REMOTE_PREP = /^(?:remote: )?(?:Enumerating|Counting|Compressing) objects/i;

const WEIGHTS: Record<ProgressKind, Bucket[]> = {
  clone: [
    { match: REMOTE_PREP, weight: 0.1 },
    { match: /^Receiving objects/i, weight: 0.5 },
    { match: /^Resolving deltas/i, weight: 0.2 },
    { match: /^(?:Checking out|Updating) files/i, weight: 0.2 },
  ],
  fetch: [
    { match: REMOTE_PREP, weight: 0.1 },
    { match: /^Receiving objects/i, weight: 0.7 },
    { match: /^Resolving deltas/i, weight: 0.2 },
  ],
  push: [
    { match: /^(?:Enumerating|Counting|Compressing) objects/i, weight: 0.3 },
    { match: /^Writing objects/i, weight: 0.7 },
  ],
  checkout: [{ match: /^(?:Checking out|Updating) files/i, weight: 1 }],
  generic: [],
};

const DETERMINATE = /^(?:remote: )?([A-Za-z ]+):\s+(\d{1,3})% \((\d+)\/(\d+)\)/;
const INDETERMINATE = /^(?:remote: )?([A-Za-z ]+):\s+(\d+)(?!\d*%)/;

export function parseProgressLine(
  line: string,
): Pick<ProgressEvent, 'phase' | 'percent' | 'current' | 'total'> | null {
  const d = DETERMINATE.exec(line);
  if (d) {
    return {
      phase: d[1]!.trim(),
      percent: Number(d[2]),
      current: Number(d[3]),
      total: Number(d[4]),
    };
  }
  const i = INDETERMINATE.exec(line);
  if (i) return { phase: i[1]!.trim(), percent: null, current: Number(i[2]) };
  return null;
}

export class ProgressParser {
  private overall: number | null = null;
  private partial = '';
  /** Non-progress stderr lines, kept for error classification and the output log. */
  readonly otherLines: string[] = [];

  constructor(private readonly kind: ProgressKind = 'generic') {}

  /** Feed a stderr chunk; returns parsed progress events in order. */
  push(chunk: string): ProgressEvent[] {
    const text = this.partial + chunk;
    const parts = text.split(/[\r\n]/);
    this.partial = parts.pop() ?? '';
    const events: ProgressEvent[] = [];
    for (const raw of parts) {
      const line = raw.trimEnd();
      if (!line) continue;
      const ev = this.parse(line);
      if (ev) events.push(ev);
      else this.otherLines.push(line);
    }
    return events;
  }

  /** Flush any trailing partial line (call on process close). */
  end(): ProgressEvent[] {
    if (!this.partial) return [];
    const rest = this.partial;
    this.partial = '';
    return this.push(`${rest}\n`);
  }

  private parse(line: string): ProgressEvent | null {
    const p = parseProgressLine(line);
    if (!p) return null;
    const buckets = WEIGHTS[this.kind];
    let offset = 0;
    for (const b of buckets) {
      if (b.match.test(line)) {
        if (p.percent !== null) {
          const candidate = offset + (b.weight * p.percent) / 100;
          this.overall = Math.min(1, Math.max(this.overall ?? 0, candidate));
        }
        break;
      }
      offset += b.weight;
    }
    return { ...p, overall: this.overall, text: line };
  }
}

/** Leading+trailing throttle: emits at most one event per `intervalMs` (spec: ≤ 10/s per op). */
export function throttle<T>(
  fn: (v: T) => void,
  intervalMs = 100,
): { call: (v: T) => void; flush: () => void } {
  let last = 0;
  let pending: { v: T } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fire = (): void => {
    timer = null;
    if (!pending) return;
    last = Date.now();
    const { v } = pending;
    pending = null;
    fn(v);
  };
  return {
    call(v: T) {
      pending = { v };
      const wait = intervalMs - (Date.now() - last);
      if (wait <= 0) fire();
      else if (!timer) timer = setTimeout(fire, wait);
    },
    flush() {
      if (timer) clearTimeout(timer);
      fire();
    },
  };
}
