import fs from 'node:fs';
import path from 'node:path';

import { resolveWorktreePath, sha1Hex, writeFileAtomic, type AtomicWriteOptions } from '@githappens/git';

import type { WorktreeFileRead, WorktreeWriteResult } from '../../shared/ipc/files-contract';

/** Editor file limit (spec 07 §4.14): bigger files open read-only elsewhere or externally. */
export const DEFAULT_EDITOR_MAX_BYTES = 50 * 1024 * 1024;

/**
 * Resolve a worktree path for IO: relative, inside the root, not under `.git/`, and — after following
 * symlinked parent directories — still inside the (real) root.
 */
export function safeWorktreePath(root: string | null, rel: string): string {
  if (!root) throw new Error('Bare repositories have no working tree.');
  const abs = resolveWorktreePath(root, rel);
  let dir = path.dirname(abs);
  while (!fs.existsSync(dir)) dir = path.dirname(dir);
  const realRoot = fs.realpathSync.native(root);
  const relReal = path.relative(realRoot, fs.realpathSync.native(dir));
  if (relReal.startsWith('..') || path.isAbsolute(relReal))
    throw new Error('Path is outside the working tree.');
  return abs;
}

export async function readWorktreeBytes(
  root: string | null,
  rel: string,
  maxBytes = DEFAULT_EDITOR_MAX_BYTES,
): Promise<WorktreeFileRead> {
  const abs = safeWorktreePath(root, rel);
  let st: fs.Stats;
  try {
    st = await fs.promises.lstat(abs);
  } catch {
    return { exists: false, bytes: null, size: 0, mtimeMs: 0, hash: null };
  }
  if (st.isSymbolicLink()) {
    const target = Buffer.from(await fs.promises.readlink(abs), 'utf8');
    return {
      exists: true,
      bytes: target,
      size: target.length,
      mtimeMs: st.mtimeMs,
      hash: sha1Hex(target),
      symlink: true,
    };
  }
  if (!st.isFile()) return { exists: false, bytes: null, size: 0, mtimeMs: 0, hash: null };
  if (st.size > maxBytes)
    return { exists: true, bytes: null, size: st.size, mtimeMs: st.mtimeMs, hash: null, tooLarge: true };
  const buf = await fs.promises.readFile(abs);
  return { exists: true, bytes: buf, size: buf.length, mtimeMs: st.mtimeMs, hash: sha1Hex(buf) };
}

async function currentHash(abs: string): Promise<string | null> {
  try {
    return sha1Hex(await fs.promises.readFile(abs));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/**
 * Editor save (spec 07 §6.10): compare the disk bytes with `expectedHash` (undefined = overwrite without
 * checking, null = the file must not exist), then write atomically preserving mode.
 */
export async function writeWorktreeBytes(
  root: string | null,
  rel: string,
  bytes: Uint8Array,
  expectedHash?: string | null,
  o?: AtomicWriteOptions,
): Promise<WorktreeWriteResult> {
  const abs = safeWorktreePath(root, rel);
  if (expectedHash !== undefined) {
    const now = await currentHash(abs);
    if (now !== expectedHash) return { ok: false, conflict: true, hash: now };
  }
  try {
    if ((await fs.promises.stat(abs)).isDirectory()) throw new Error(`"${rel}" is a directory.`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  await writeFileAtomic(abs, bytes, o);
  const st = await fs.promises.stat(abs);
  return { ok: true, hash: sha1Hex(bytes), mtimeMs: st.mtimeMs };
}

/** "New file…" (spec 07 §4.11): create an empty file; refuses to overwrite. */
export async function createWorktreeFile(root: string | null, rel: string): Promise<void> {
  if (/[/\\]$/.test(rel)) throw new Error('Enter a file name, not a folder.');
  const abs = safeWorktreePath(root, rel);
  await fs.promises.mkdir(path.dirname(abs), { recursive: true });
  try {
    await (await fs.promises.open(abs, 'wx')).close();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`"${rel}" already exists.`, { cause: e });
    }
    throw e;
  }
}
