import fs from 'node:fs';
import path from 'node:path';

import { findSecrets } from '../src/main/settings/secret-patterns';

/**
 * userData secret scan (spec 13 §9 "No secret ever written to plain JSON"): walks a userData folder
 * and reports every known credential pattern, plus literal occurrences of secrets the test planted
 * (tokens / API keys / passphrases entered during an e2e run). Used by unit tests and the Phase 10
 * e2e run: `expect(scanUserDataForSecrets(userData, { known: [token] })).toEqual([])`.
 *
 * Skipped: the encrypted SecretStore fallback (`secrets.bin`), binary files, files > `maxBytes`, and
 * Chromium's own caches (they hold network responses, not our writes).
 */

export interface SecretHit {
  /** Path relative to the scanned folder, `/`-separated. */
  file: string;
  line: number;
  pattern: string;
  /** Masked match (safe to print). */
  excerpt: string;
}

export interface ScanOptions {
  /** Literal secrets that must not appear anywhere (min 6 chars). */
  known?: readonly string[];
  /** Extra relative paths / folder names to skip. */
  ignore?: (relPath: string) => boolean;
  maxBytes?: number;
}

const SKIP_DIRS = new Set([
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'GrShaderCache',
  'ShaderCache',
  'Service Worker',
  'blob_storage',
  'Crashpad',
  'node_modules',
]);
const SKIP_FILES = new Set(['secrets.bin', 'Cookies', 'Cookies-journal']);

const isBinary = (b: Buffer): boolean => b.subarray(0, 8000).includes(0);

export function scanUserDataForSecrets(dir: string, o: ScanOptions = {}): SecretHit[] {
  const hits: SecretHit[] = [];
  const max = o.maxBytes ?? 10 * 1024 * 1024;
  const walk = (abs: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(abs, e.name);
      const rel = path.relative(dir, p).split(path.sep).join('/');
      if (o.ignore?.(rel)) continue;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(p);
        continue;
      }
      if (!e.isFile() || SKIP_FILES.has(e.name)) continue;
      let buf: Buffer;
      try {
        if (fs.statSync(p).size > max) continue;
        buf = fs.readFileSync(p);
      } catch {
        continue;
      }
      if (isBinary(buf)) continue;
      const text = buf.toString('utf8');
      for (const m of findSecrets(text, o.known ?? [])) {
        hits.push({
          file: rel,
          line: text.slice(0, m.index).split('\n').length,
          pattern: m.id,
          excerpt: m.excerpt,
        });
      }
    }
  };
  walk(dir);
  return hits;
}
