import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  REPO_GITCONFIG_KEYS,
  type GitConfigListResult,
  type RepoGitConfigKey,
} from '../../shared/ipc/repo-settings-contract';
import { isSupportedEncoding } from './repo-settings-store';

/**
 * `git config --local` bridge for Preferences › Repo (spec 13 §5.4 `gitconfig:*`). Only
 * `REPO_GITCONFIG_KEYS` are accepted and every value is validated per key; argv only.
 */

export interface GitRunResult {
  exitCode: number;
  stdout: string;
  stderr?: string;
}
/** Structural subset of the app's `GitProcessRunner.run` (utf8). */
export type RepoGitRun = (o: {
  cwd: string;
  args: string[];
  expectedExitCodes?: number[];
}) => Promise<GitRunResult>;

/** Fallback runner (system `git` on PATH) when main does not inject the app's runner. */
export const execGit: RepoGitRun = (o) =>
  new Promise((resolve, reject) => {
    execFile(
      'git',
      o.args,
      { cwd: o.cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
        if (code !== 0 && !(o.expectedExitCodes ?? [0]).includes(code)) {
          reject(new Error((stderr || err?.message || `git exited with ${code}`).trim()));
          return;
        }
        resolve({ exitCode: code, stdout, stderr });
      },
    );
  });

const KEYS = new Set<string>(REPO_GITCONFIG_KEYS);
export const isRepoGitConfigKey = (k: unknown): k is RepoGitConfigKey => typeof k === 'string' && KEYS.has(k);

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+$/;
const BOOL = new Set(['true', 'false']);

/** Validate (and normalise) a value for `key`; throws with a user-facing message. */
export function validateRepoGitConfigValue(key: RepoGitConfigKey, raw: unknown): string {
  if (typeof raw !== 'string') throw new Error(`"${key}" must be a string.`);
  if (raw.includes('\0')) throw new Error(`"${key}" contains a NUL character.`);
  const multiLine = key === 'githappens.agentSetup';
  const v = multiLine ? raw.replace(/\r\n/g, '\n').replace(/\s+$/, '') : raw.trim();
  if (!multiLine && /[\r\n]/.test(v)) throw new Error(`"${key}" must be a single line.`);
  if (v.length > (multiLine ? 16_384 : 4096)) throw new Error(`"${key}" is too long.`);
  if (!v) throw new Error(`"${key}" cannot be empty — unset it instead.`);
  switch (key) {
    case 'user.name':
      if (/[<>]/.test(v) || v.length > 200) throw new Error('Author name is not valid.');
      return v;
    case 'user.email':
      if (!EMAIL_RE.test(v) || v.length > 254) throw new Error('Author email is not valid.');
      return v;
    case 'commit.gpgsign':
    case 'tag.gpgsign':
    case 'submodule.recurse':
      if (!BOOL.has(v)) throw new Error(`"${key}" must be true or false.`);
      return v;
    case 'gpg.format':
      if (!['openpgp', 'ssh', 'x509'].includes(v))
        throw new Error('Signing format must be openpgp, ssh or x509.');
      return v;
    case 'i18n.commitEncoding':
    case 'i18n.logOutputEncoding':
      if (!/^[A-Za-z0-9._:-]{2,40}$/.test(v) || !isSupportedEncoding(v)) {
        throw new Error(`"${v}" is not a known encoding.`);
      }
      return v;
    case 'user.signingkey':
    case 'core.hooksPath':
    case 'commit.template':
    case 'githappens.agentSetup':
      return v;
  }
}

/** Throws unless `repoPath` is an absolute path to a git working tree / repository. */
export async function assertRepo(run: RepoGitRun, repoPath: unknown): Promise<string> {
  if (typeof repoPath !== 'string' || !repoPath || !path.isAbsolute(repoPath)) {
    throw new Error('A repository path is required.');
  }
  if (!fs.existsSync(repoPath)) throw new Error(`Repository not found: ${repoPath}`);
  await run({ cwd: repoPath, args: ['rev-parse', '--git-dir'] }).catch(() => {
    throw new Error(`Not a git repository: ${repoPath}`);
  });
  return repoPath;
}

/** Parse `git config -z --list` output into key → last value (keys lower-cased by git except subsections). */
export function parseConfigList(stdout: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rec of stdout.split('\0')) {
    if (!rec) continue;
    const nl = rec.indexOf('\n');
    const key = nl < 0 ? rec : rec.slice(0, nl);
    out.set(key.toLowerCase(), nl < 0 ? 'true' : rec.slice(nl + 1));
  }
  return out;
}

export function createRepoGitConfig(run: RepoGitRun) {
  const pick = (m: Map<string, string>): Partial<Record<RepoGitConfigKey, string>> => {
    const r: Partial<Record<RepoGitConfigKey, string>> = {};
    for (const k of REPO_GITCONFIG_KEYS) {
      const v = m.get(k.toLowerCase());
      if (v !== undefined) r[k] = v;
    }
    return r;
  };
  return {
    async get(repoPath: string, key: unknown): Promise<string | null> {
      if (!isRepoGitConfigKey(key)) throw new Error(`Refusing to read git config "${String(key)}".`);
      const cwd = await assertRepo(run, repoPath);
      const r = await run({ cwd, args: ['config', '--local', '--get', key], expectedExitCodes: [0, 1] });
      return r.exitCode === 1 ? null : r.stdout.replace(/\r?\n$/, '');
    },
    async list(repoPath: string): Promise<GitConfigListResult> {
      const cwd = await assertRepo(run, repoPath);
      const [local, effective] = await Promise.all([
        run({ cwd, args: ['config', '--local', '-z', '--list'], expectedExitCodes: [0, 1] }),
        run({ cwd, args: ['config', '-z', '--list'], expectedExitCodes: [0, 1] }),
      ]);
      return {
        local: pick(parseConfigList(local.stdout)),
        effective: pick(parseConfigList(effective.stdout)),
      };
    },
    async set(repoPath: string, key: unknown, value: unknown): Promise<void> {
      if (!isRepoGitConfigKey(key)) throw new Error(`Refusing to write git config "${String(key)}".`);
      const v = validateRepoGitConfigValue(key, value);
      const cwd = await assertRepo(run, repoPath);
      await run({ cwd, args: ['config', '--local', '--replace-all', key, v] });
    },
    async unset(repoPath: string, key: unknown): Promise<void> {
      if (!isRepoGitConfigKey(key)) throw new Error(`Refusing to write git config "${String(key)}".`);
      const cwd = await assertRepo(run, repoPath);
      await run({ cwd, args: ['config', '--local', '--unset-all', key], expectedExitCodes: [0, 5] });
    },
  };
}
