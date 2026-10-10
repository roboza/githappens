import { execFile } from 'node:child_process';
import fs from 'node:fs';

import { GitError, makeError } from '../errors/classify';
import { bundledGitEnv, bundledGitExecutable, findPathKey } from '../process/env';
import type { GitExecutionContext } from '../process/runner';
import type { GitExecutableInfo, VersionTuple } from '../types';
import { findOnPath } from './shell-env';
import { atLeast, featureFlags, MIN_SYSTEM_GIT, parseGitVersion, parseLfsVersion } from './version';

/** Setting `git.executable` (spec 13): 'bundled' | 'system' | absolute path to a git binary. */
export type GitExecutablePreference = 'bundled' | 'system' | (string & {});

export interface GitLocatorOptions {
  /** Root of the bundled portable git; undefined if not shipped (e.g. some dev setups). */
  bundledGitDir?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  /** process.env merged with the resolved login-shell env. */
  baseEnv?: NodeJS.ProcessEnv;
  /** Injectable for tests. */
  probe?: (gitPath: string, args: string[], env: NodeJS.ProcessEnv) => Promise<string>;
}

export interface ResolvedGit {
  info: GitExecutableInfo;
  context: GitExecutionContext;
  /** User-facing warnings, e.g. "System git 2.30 is too old; using bundled git". */
  warnings: string[];
}

const defaultProbe = (gitPath: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(gitPath, args, { env, timeout: 10_000, windowsHide: true }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    );
  });

/**
 * Chooses the git executable (spec 02 §6.1 resolution order):
 *  1. user-chosen system git / custom path → validate; fall back to bundled with a warning
 *  2. bundled git (default)
 *  3. system git auto-detected on PATH
 *  otherwise GitNotFound.
 */
export class GitLocator {
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly probe: NonNullable<GitLocatorOptions['probe']>;

  constructor(private readonly o: GitLocatorOptions = {}) {
    this.platform = o.platform ?? process.platform;
    this.arch = o.arch ?? process.arch;
    this.baseEnv = o.baseEnv ?? process.env;
    this.probe = o.probe ?? defaultProbe;
  }

  async resolve(preference: GitExecutablePreference = 'bundled'): Promise<ResolvedGit> {
    const warnings: string[] = [];

    if (preference !== 'bundled') {
      const systemPath =
        preference === 'system' ? findOnPath('git', this.baseEnv, this.platform) : preference;
      if (systemPath) {
        const r = await this.trySystem(systemPath);
        if (r.ok) return { ...r.value, warnings };
        warnings.push(`${r.reason} Using bundled Git instead.`);
      } else {
        warnings.push('System Git was not found on PATH. Using bundled Git instead.');
      }
    }

    const bundled = await this.tryBundled();
    if (bundled.ok) return { ...bundled.value, warnings };
    if (bundled.reason) warnings.push(bundled.reason);

    const onPath = findOnPath('git', this.baseEnv, this.platform);
    if (onPath) {
      const r = await this.trySystem(onPath);
      if (r.ok) return { ...r.value, warnings };
      warnings.push(r.reason);
    }

    throw new GitError(
      makeError('GitNotFound', { argv: ['--version'] }, ['Git could not be found.', ...warnings].join(' ')),
    );
  }

  /** Validate a candidate path without changing the active selection (Preferences "Test"). */
  async inspect(
    gitPath: string,
    kind: 'bundled' | 'system',
    env: NodeJS.ProcessEnv,
  ): Promise<GitExecutableInfo> {
    const out = await this.probe(gitPath, ['--version'], env);
    const parsed = parseGitVersion(out);
    if (!parsed) throw new Error(`Unrecognized git version output: ${out.trim()}`);
    let lfsVersion: string | undefined;
    try {
      lfsVersion = parseLfsVersion(await this.probe(gitPath, ['lfs', 'version'], env));
    } catch {
      lfsVersion = undefined;
    }
    const info: GitExecutableInfo = {
      kind,
      path: gitPath,
      version: parsed.version,
      versionTuple: parsed.tuple,
      features: featureFlags(parsed.tuple, this.platform),
    };
    if (lfsVersion) info.lfsVersion = lfsVersion;
    return info;
  }

  private async trySystem(
    gitPath: string,
  ): Promise<{ ok: true; value: Omit<ResolvedGit, 'warnings'> } | { ok: false; reason: string }> {
    try {
      const info = await this.inspect(gitPath, 'system', this.baseEnv);
      if (!atLeast(info.versionTuple, MIN_SYSTEM_GIT)) {
        return {
          ok: false,
          reason: `System Git ${info.version} is older than the minimum supported ${fmt(MIN_SYSTEM_GIT)}.`,
        };
      }
      return { ok: true, value: { info, context: { gitPath, baseEnv: this.baseEnv, bundled: false } } };
    } catch (e) {
      return { ok: false, reason: `Git at ${gitPath} could not be run (${(e as Error).message}).` };
    }
  }

  private async tryBundled(): Promise<
    { ok: true; value: Omit<ResolvedGit, 'warnings'> } | { ok: false; reason?: string }
  > {
    const dir = this.o.bundledGitDir;
    if (!dir) return { ok: false };
    const layout = { dir, platform: this.platform, arch: this.arch };
    const gitPath = bundledGitExecutable(layout);
    if (!fs.existsSync(gitPath)) return { ok: false, reason: `Bundled Git is missing (${gitPath}).` };
    const extra = bundledGitEnv(layout, this.baseEnv);
    const env: NodeJS.ProcessEnv = { ...this.baseEnv, ...extra };
    // Keep a single PATH key on Windows (Path vs PATH).
    const pathKey = findPathKey(this.baseEnv);
    if (pathKey !== 'PATH' && extra[pathKey]) delete env.PATH;
    try {
      const info = await this.inspect(gitPath, 'bundled', env);
      return { ok: true, value: { info, context: { gitPath, baseEnv: env, bundled: true } } };
    } catch (e) {
      return { ok: false, reason: `Bundled Git could not be run (${(e as Error).message}).` };
    }
  }
}

const fmt = (v: VersionTuple): string => v.join('.');
