import os from 'node:os';
import path from 'node:path';

import type { GitProcessRunner } from '@githappens/git';

import type { SafeDirectoryInfo } from '../../shared/ipc/repos2-contract';

/**
 * Dubious ownership (CVE-2022-24765, spec 03 §6/§8): git refuses repos owned by another user unless they
 * are listed in `safe.directory`. We only ever add one exact path to the *global* config, after explicit
 * consent, and show the exact command first.
 */

/** True when git's stderr is the "detected dubious ownership" refusal. */
export const isDubiousOwnership = (stderr: string): boolean => /dubious ownership/i.test(stderr);

/**
 * The value to trust: git prints `git config --global --add safe.directory <value>` in its hint (it knows
 * the exact spelling it compares against, e.g. `%(prefix)///server/share` for UNC paths); fall back to the
 * absolute path with forward slashes.
 */
export function safeDirectoryFor(repoPath: string, stderr = ''): SafeDirectoryInfo {
  const m = /safe\.directory\s+(.+?)\s*$/m.exec(stderr);
  let value = m?.[1]
    ?.trim()
    .replace(/^'(.*)'$/, '$1')
    .replace(/^"(.*)"$/, '$1');
  if (!value || value === '*' || /[\0\r\n]/.test(value)) value = path.resolve(repoPath).replace(/\\/g, '/');
  return { path: value, command: `git config --global --add safe.directory ${quoteForDisplay(value)}` };
}

function quoteForDisplay(v: string): string {
  return /^[\w@%+=:,./-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`;
}

/** Validate a value before writing it: one absolute path, never the `*` wildcard. */
export function assertSafeDirectoryValue(value: string): void {
  const plain = value.replace(/^%\(prefix\)\//, '');
  if (
    !value ||
    value.trim() === '*' ||
    value.startsWith('-') ||
    /[\0\r\n]/.test(value) ||
    !(path.isAbsolute(plain) || /^[a-zA-Z]:\//.test(plain) || plain.startsWith('//'))
  ) {
    throw new Error('Refusing to trust this path: it must be one absolute repository path.');
  }
}

/** `git config --global --add safe.directory <value>` (skipped when already listed). */
export async function addSafeDirectory(runner: GitProcessRunner, value: string): Promise<void> {
  assertSafeDirectoryValue(value);
  const cwd = os.homedir();
  const existing = await runner.run({
    cwd,
    args: ['config', '--global', '--get-all', 'safe.directory'],
    readOnly: true,
    expectedExitCodes: [0, 1],
  });
  const norm = (s: string): string =>
    (process.platform === 'linux' ? s : s.toLowerCase()).replace(/\/+$/, '');
  if (
    String(existing.stdout)
      .split(/\r?\n/)
      .some((l) => l && norm(l.trim()) === norm(value))
  )
    return;
  await runner.run({ cwd, args: ['config', '--global', '--add', 'safe.directory', value] });
}
