import fs from 'node:fs';
import path from 'node:path';

const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * Write via temp file + rename so a crash never leaves a half-written file.
 * Retries briefly on Windows antivirus/indexer locks (spec 15 §10).
 */
export function writeFileAtomic(file: string, data: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, data);
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (!RETRYABLE.has(code) || attempt >= 5) {
        fs.rmSync(tmp, { force: true });
        throw e;
      }
      const until = Date.now() + 20 * (attempt + 1);
      while (Date.now() < until) {
        /* short synchronous backoff; settings writes are tiny and rare */
      }
    }
  }
}

export type ReadJsonResult<T> =
  { kind: 'missing' } | { kind: 'ok'; value: T } | { kind: 'corrupt'; error: string };

export function readJson<T = unknown>(file: string): ReadJsonResult<T> {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'corrupt', error: (e as Error).message };
  }
  try {
    return { kind: 'ok', value: JSON.parse(text) as T };
  } catch (e) {
    return { kind: 'corrupt', error: (e as Error).message };
  }
}

/** Move a corrupt file aside as `<file>.bak-<ts>` and return the backup path. */
export function backupCorrupt(file: string): string {
  const bak = `${file}.bak-${Date.now()}`;
  try {
    fs.renameSync(file, bak);
  } catch {
    fs.copyFileSync(file, bak);
  }
  return bak;
}
