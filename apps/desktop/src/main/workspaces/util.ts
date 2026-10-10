import fs from 'node:fs';

import { canonicalKey } from '../services/canonical-path';

/** Run `fn` over `items` with at most `limit` in flight; results keep input order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

/**
 * Dedupe key for a path: native realpath (Windows 8.3 short names expanded; a missing path is resolved
 * through its nearest existing ancestor), case-folded on win32/darwin (spec 11 §8).
 */
export function pathKey(p: string, platform: NodeJS.Platform = process.platform): string {
  return canonicalKey(p, platform);
}

/**
 * Comparable identity of a remote URL: `https://user@host/owner/repo.git`, `git@host:owner/repo`
 * and `ssh://git@host:22/owner/repo` all become `host/owner/repo`.
 */
export function normalizeRemoteUrl(url: string): string {
  let u = url.trim();
  const scp = /^[^@/\s]+@([^:/\s]+):(?!\/)(.+)$/.exec(u);
  if (scp) u = `${scp[1]}/${scp[2]}`;
  else {
    u = u.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
    u = u.replace(/^[^@/]*@/, '');
    u = u.replace(/^([^/:]+):\d+\//, '$1/');
  }
  return u
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .toLowerCase();
}

export const nowIso = (): string => new Date().toISOString();

export function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
