import fs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';

import type { ProgressEvent } from '../../../types';

export interface LfsProgressLine {
  direction: string;
  current: number;
  total: number;
  bytes: number;
  bytesTotal: number;
  name: string;
}

/** One `GIT_LFS_PROGRESS` line: `<direction> <n>/<m> <bytesSoFar>/<bytesTotal> <name>` (spec 09 §6.8). */
export function parseLfsProgressLine(line: string): LfsProgressLine | null {
  const m = /^(\S+) (\d+)\/(\d+) (\d+)\/(\d+) (.*)$/.exec(line.replace(/\r$/, ''));
  if (!m) return null;
  return {
    direction: m[1]!,
    current: Number(m[2]),
    total: Number(m[3]),
    bytes: Number(m[4]),
    bytesTotal: Number(m[5]),
    name: m[6]!,
  };
}

const POLL_MS = 200;

/**
 * Run `fn` with `GIT_LFS_PROGRESS` pointing at a temp file that is tailed into `progress` events.
 * Overall progress is file-count based and never decreases.
 */
export async function withLfsProgress<T>(
  progress: (p: ProgressEvent) => void,
  fn: (env: Record<string, string>) => Promise<T>,
): Promise<T> {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'kl-lfs-'));
  const file = nodePath.join(dir, 'progress');
  fs.writeFileSync(file, '');
  let offset = 0;
  let partial = '';
  let overall = 0;
  const drain = (): void => {
    let buf: Buffer;
    try {
      buf = fs.readFileSync(file);
    } catch {
      return;
    }
    if (buf.length <= offset) return;
    const text = partial + buf.subarray(offset).toString('utf8');
    offset = buf.length;
    const parts = text.split('\n');
    partial = parts.pop() ?? '';
    for (const l of parts) {
      const p = parseLfsProgressLine(l);
      if (!p) continue;
      const fileFrac = p.bytesTotal > 0 ? p.bytes / p.bytesTotal : 1;
      const o = p.total > 0 ? Math.min(1, (p.current - 1 + fileFrac) / p.total) : null;
      if (o !== null) overall = Math.max(overall, o);
      progress({
        phase: p.direction,
        percent: p.bytesTotal > 0 ? Math.round(fileFrac * 100) : null,
        current: p.current,
        total: p.total,
        overall: o === null ? null : overall,
        text: l.trim(),
      });
    }
  };
  const timer = setInterval(drain, POLL_MS);
  try {
    return await fn({ GIT_LFS_PROGRESS: file });
  } finally {
    clearInterval(timer);
    drain();
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* best effort */
    }
  }
}
