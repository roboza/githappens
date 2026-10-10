import os from 'node:os';

import { GitError, makeError } from '../errors/classify';
import type { GitProcessRunner } from '../process/runner';
import { redact, SECRET_CONFIG_KEY } from '../process/redact';
import type { ConfigEntry, ConfigScope } from '../types';
import type { GitService } from './git-service';

/**
 * Config reads and writes (spec 02 §6.11 "Config list", §5.3 `git:config:*`, §11 gitflow config).
 *
 * Reads run in the read pool (`--no-optional-locks`); writes go through the OperationQueue
 * (`config.set` op) because they take `config.lock`. Keys are validated before they reach argv, and
 * credential-like values are masked unless the caller explicitly asks for the raw value of one key.
 */

/** `section[.subsection].name`: section/name alphanumeric + `-` (name starts with a letter). */
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9.-]*?(\.[^\0\n]*)?\.[A-Za-z][A-Za-z0-9-]*$/;

export function isValidConfigKey(key: string): boolean {
  if (!key || key.length > 1024 || key.startsWith('-') || /[\0\n\r]/.test(key)) return false;
  return KEY_RE.test(key);
}

export function assertConfigKey(key: string): void {
  if (!isValidConfigKey(key)) {
    throw new GitError(makeError('Unknown', { argv: ['config'] }, `Invalid config key: "${key}".`));
  }
}

/** A `--get-regexp` pattern: no NUL/newlines, not option-like. */
export function assertConfigPattern(pattern: string): void {
  if (!pattern || pattern.startsWith('-') || /[\0\n\r]/.test(pattern) || pattern.length > 1024) {
    throw new GitError(makeError('Unknown', { argv: ['config'] }, `Invalid config pattern: "${pattern}".`));
  }
}

export function isSecretConfigKey(key: string): boolean {
  return SECRET_CONFIG_KEY.test(key);
}

export const REDACTED_VALUE = '***';

/** Mask secret values and credentials embedded in URLs (`https://user:***@host`). */
export function redactConfigValue(key: string, value: string): { value: string; redacted: boolean } {
  if (isSecretConfigKey(key)) return { value: REDACTED_VALUE, redacted: true };
  const r = redact(value);
  return r === value ? { value, redacted: false } : { value: r, redacted: true };
}

const SCOPES = new Set<ConfigScope>(['system', 'global', 'local', 'worktree', 'command']);

/**
 * Parse `git config --list -z --show-origin --show-scope` (or `--get-regexp` with the same flags):
 * `scope\0origin\0key\nvalue\0` per entry. A key without a value (`[section] flag`) has no `\n`.
 */
export function parseConfigList(text: string): ConfigEntry[] {
  const tokens = text.split('\0');
  const out: ConfigEntry[] = [];
  for (let i = 0; i + 2 < tokens.length; i += 3) {
    const scope = tokens[i]!;
    const origin = tokens[i + 1]!;
    const kv = tokens[i + 2]!;
    if (!SCOPES.has(scope as ConfigScope)) {
      // stray token (should not happen): resync on the next known scope name
      i -= 2;
      continue;
    }
    const nl = kv.indexOf('\n');
    const key = nl < 0 ? kv : kv.slice(0, nl);
    const value = nl < 0 ? '' : kv.slice(nl + 1);
    if (!key) continue;
    out.push({ scope: scope as ConfigScope, origin, key, value });
  }
  return out;
}

export interface ConfigTarget {
  runner: GitProcessRunner;
  /** Repository working directory, or null for repo-less (global/system) access. */
  cwd: string | null;
}

export function configTarget(runner: GitProcessRunner, svc?: GitService | null): ConfigTarget {
  return { runner, cwd: svc ? svc.cwd : null };
}

function scopeFlag(scope: ConfigScope | undefined, repo: boolean): string[] {
  if (!scope) return [];
  if (scope === 'command') {
    throw new GitError(
      makeError('Unknown', { argv: ['config'] }, 'The "command" scope cannot be read alone.'),
    );
  }
  if ((scope === 'local' || scope === 'worktree') && !repo) {
    throw new GitError(
      makeError('NotARepository', { argv: ['config'] }, `The ${scope} config needs an open repository.`),
    );
  }
  return [`--${scope}`];
}

export interface ConfigListOptions {
  scope?: ConfigScope;
  /** `--get-regexp` pattern, e.g. `^gitflow\.` (spec 02 §11). */
  pattern?: string;
  /** Return secret values unmasked (never used over IPC). */
  unmasked?: boolean;
}

/** `git:config:list` (spec 02 §5.3). Without a repo only system/global entries are returned. */
export async function configList(t: ConfigTarget, o: ConfigListOptions = {}): Promise<ConfigEntry[]> {
  const repo = t.cwd !== null;
  const args = ['config', '-z', '--show-origin', '--show-scope', ...scopeFlag(o.scope, repo)];
  if (o.pattern !== undefined) {
    assertConfigPattern(o.pattern);
    args.push('--get-regexp', o.pattern);
  } else args.push('--list');
  const r = await t.runner.run({
    cwd: t.cwd ?? os.homedir(),
    args,
    readOnly: true,
    // exit 1: no match (--get-regexp) / missing file for the requested scope
    expectedExitCodes: [0, 1],
    env: repo ? undefined : { GIT_DIR: nonRepoGitDir() },
  });
  if (r.exitCode !== 0) return [];
  let entries = parseConfigList(String(r.stdout));
  if (!repo) entries = entries.filter((e) => e.scope !== 'local' && e.scope !== 'worktree');
  if (o.unmasked) return entries;
  return entries.map((e) => {
    const m = redactConfigValue(e.key, e.value);
    return m.redacted ? { ...e, value: m.value, redacted: true } : e;
  });
}

export interface ConfigGetOptions {
  scope?: ConfigScope;
  unmasked?: boolean;
}

/** `git:config:get`: last value of a key, or null when unset. Secret values are masked. */
export async function configGet(
  t: ConfigTarget,
  key: string,
  o: ConfigGetOptions = {},
): Promise<string | null> {
  assertConfigKey(key);
  const repo = t.cwd !== null;
  const r = await t.runner.run({
    cwd: t.cwd ?? os.homedir(),
    args: ['config', ...scopeFlag(o.scope, repo), '--get', key],
    readOnly: true,
    expectedExitCodes: [0, 1],
    env: repo ? undefined : { GIT_DIR: nonRepoGitDir() },
  });
  if (r.exitCode !== 0) return null;
  const value = String(r.stdout).replace(/\r?\n$/, '');
  return o.unmasked ? value : redactConfigValue(key, value).value;
}

export type ConfigWriteScope = 'global' | 'local' | 'worktree';

/** argv for a write (`value === null` → `--unset-all`, exit 5 = already unset). */
export function configSetArgs(key: string, value: string | null, scope: ConfigWriteScope): string[] {
  assertConfigKey(key);
  if (value !== null && /\0/.test(value)) {
    throw new GitError(makeError('Unknown', { argv: ['config'] }, 'Config values cannot contain NUL bytes.'));
  }
  if (!['global', 'local', 'worktree'].includes(scope)) {
    throw new GitError(makeError('Unknown', { argv: ['config'] }, `Invalid config scope: "${scope}".`));
  }
  return value === null
    ? ['config', `--${scope}`, '--unset-all', '--', key]
    : ['config', `--${scope}`, '--', key, value];
}

let globalWrites: Promise<unknown> = Promise.resolve();

/**
 * Serialize writes to the global config app-wide (several repo queues may write `~/.gitconfig`, and
 * `git config --global` without a repo runs outside any queue).
 */
export function withGlobalConfigLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = globalWrites.then(fn, fn);
  globalWrites = run.catch(() => undefined);
  return run;
}

/** Repo-less global write (`git:config:set` without a repoId). */
export async function configSetGlobal(
  runner: GitProcessRunner,
  key: string,
  value: string | null,
): Promise<void> {
  const args = configSetArgs(key, value, 'global');
  await withGlobalConfigLock(() =>
    runner.run({
      cwd: os.homedir(),
      args,
      expectedExitCodes: value === null ? [0, 5] : [0],
      env: { GIT_DIR: nonRepoGitDir() },
    }),
  );
}

/** A GIT_DIR that is never a repository, so repo-less config commands can't pick up a local config. */
function nonRepoGitDir(): string {
  return `${os.tmpdir()}/githappens-no-repo-${process.pid}`;
}
