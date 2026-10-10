import fs from 'node:fs';

import { bundledGitEnv, bundledGitExecutable, GitLocator } from '@githappens/git';

import type { AboutIpcContract, BundledGitInfo } from '../../shared/ipc/about-contract';
import type { HandlerContext } from './registry';

export type AboutHandlers = {
  [C in keyof AboutIpcContract]: (
    req: AboutIpcContract[C]['req'],
    ctx: HandlerContext,
  ) => AboutIpcContract[C]['res'] | Promise<AboutIpcContract[C]['res']>;
};

export interface AboutHandlerDeps {
  /** Same value the GitEngine gets (`bundledGitDir()` in main/index.ts). */
  bundledGitDir: string | undefined;
  platform?: NodeJS.Platform;
  arch?: string;
  baseEnv?: NodeJS.ProcessEnv;
  /** Injectable for tests (defaults to GitLocator's execFile probe). */
  probe?: (gitPath: string, args: string[], env: NodeJS.ProcessEnv) => Promise<string>;
}

/** Probe the bundled git once (it cannot change while the app runs). */
export async function inspectBundledGit(d: AboutHandlerDeps): Promise<BundledGitInfo> {
  if (!d.bundledGitDir) return { available: false, error: 'This build does not include a bundled Git.' };
  const platform = d.platform ?? process.platform;
  const layout = { dir: d.bundledGitDir, platform, arch: d.arch ?? process.arch };
  const exe = bundledGitExecutable(layout);
  if (!fs.existsSync(exe)) return { available: false, path: exe, error: `Bundled Git is missing (${exe}).` };
  const base = d.baseEnv ?? process.env;
  const locator = new GitLocator({ platform, arch: layout.arch, baseEnv: base, probe: d.probe });
  try {
    const info = await locator.inspect(exe, 'bundled', { ...base, ...bundledGitEnv(layout, base) });
    return { available: true, version: info.version, path: exe };
  } catch (e) {
    return { available: false, path: exe, error: (e as Error).message };
  }
}

/** About dialog IPC (spec 15 §4). */
export function createAboutHandlers(d: AboutHandlerDeps): AboutHandlers {
  let cached: Promise<BundledGitInfo> | null = null;
  return {
    'app:bundledGit': () => (cached ??= inspectBundledGit(d)),
  };
}
