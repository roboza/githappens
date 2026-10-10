/**
 * About dialog extras (spec 15 §4): the *bundled* git, which may differ from the active executable when
 * the user picked system git or a custom path. `app:getVersionInfo` (app-contract) reports the active one.
 */

export interface BundledGitInfo {
  /** False when no bundled git ships with this build (or it cannot run). */
  available: boolean;
  version?: string;
  path?: string;
  /** Why it is unavailable. */
  error?: string;
}

export interface AboutIpcContract {
  'app:bundledGit': { req: Record<string, never>; res: BundledGitInfo };
}

export const ABOUT_INVOKE_CHANNELS = [
  'app:bundledGit',
] as const satisfies readonly (keyof AboutIpcContract)[];

type Exhaustive<All, Listed> = [Exclude<All, Listed>] extends [never]
  ? true
  : { missing: Exclude<All, Listed> };
const invokeExhaustive: Exhaustive<keyof AboutIpcContract, (typeof ABOUT_INVOKE_CHANNELS)[number]> = true;
void invokeExhaustive;
