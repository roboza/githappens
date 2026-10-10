import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** sha1 hex of file bytes: the in-app editor's `expectedHash` (spec 07 §6.10). */
export const sha1Hex = (bytes: Uint8Array): string => createHash('sha1').update(bytes).digest('hex');

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface AtomicWriteOptions {
  /** Retries of the final rename on Windows AV/indexer locks (default 3). */
  retries?: number;
  /** First backoff in ms, doubled per attempt (default 50). */
  backoffMs?: number;
  /** Test seam. */
  rename?: (from: string, to: string) => Promise<void>;
}

/**
 * Atomic file write (spec 07 §6.10): write `<file>.tmp-<rand>` in the same directory, fsync, then rename over
 * the target. The existing file's mode is preserved and symlinks are followed (the link target is written).
 * The rename is retried on EPERM/EBUSY (antivirus locks on Windows) with exponential backoff.
 */
export async function writeFileAtomic(
  file: string,
  bytes: Uint8Array,
  o: AtomicWriteOptions = {},
): Promise<void> {
  let target = file;
  try {
    target = await fs.promises.realpath(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  let mode: number | undefined;
  try {
    mode = (await fs.promises.stat(target)).mode & 0o7777;
  } catch {
    /* new file: default mode */
  }
  const dir = path.dirname(target);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(target)}.tmp-${randomBytes(6).toString('hex')}`);
  const fh = await fs.promises.open(tmp, 'wx', mode ?? 0o666);
  try {
    await fh.writeFile(bytes);
    await fh.sync();
  } finally {
    await fh.close();
  }
  if (mode !== undefined) await fs.promises.chmod(tmp, mode).catch(() => undefined);
  const rename = o.rename ?? ((a: string, b: string) => fs.promises.rename(a, b));
  const retries = o.retries ?? 3;
  let delay = o.backoffMs ?? 50;
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, target);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (attempt < retries && RETRY_CODES.has(code)) {
        await sleep(delay);
        delay *= 2;
        continue;
      }
      await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
      throw e;
    }
  }
}
