import { rankFiles } from './finder-score';

/**
 * File finder scorer for large repositories (spec 12 §6.8: lists > 20k files are matched off the UI
 * thread). Protocol: `{type:'load', key, files}` once per list version, then
 * `{type:'query', id, key, query, mru, limit}` → `{id, paths}` (or `{id, stale:true}` if `key` is not
 * the loaded list).
 */

type InMsg =
  | { type: 'load'; key: string; files: string[] }
  | { type: 'query'; id: number; key: string; query: string; mru: string[]; limit: number };

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<InMsg>) => void) | null;
  postMessage(m: unknown): void;
};

let loaded: { key: string; files: string[] } | null = null;

ctx.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'load') {
    loaded = { key: m.key, files: m.files };
    return;
  }
  if (!loaded || loaded.key !== m.key) {
    ctx.postMessage({ id: m.id, stale: true });
    return;
  }
  const paths = rankFiles(loaded.files, m.query, m.mru, m.limit).map((r) => r.path);
  ctx.postMessage({ id: m.id, paths });
};
