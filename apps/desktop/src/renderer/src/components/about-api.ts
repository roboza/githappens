import type { IpcResult } from '@githappens/git/types';

import type { AboutIpcContract, BundledGitInfo } from '../../../shared/ipc/about-contract';

type LooseInvoke = (channel: string, req: unknown) => Promise<IpcResult<unknown>>;

/**
 * `app:bundledGit`, typed against about-contract whether or not that contract has been merged into the
 * main allowlist yet. Resolves `null` when the channel isn't wired (the About card then falls back to the
 * active executable when it is the bundled one).
 */
export async function fetchBundledGit(): Promise<BundledGitInfo | null> {
  try {
    const channel: keyof AboutIpcContract = 'app:bundledGit';
    const r = await (window.api.invoke as unknown as LooseInvoke)(channel, {});
    return r.ok ? (r.data as BundledGitInfo) : null;
  } catch {
    return null;
  }
}
