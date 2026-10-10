import type { GitConfigEntry } from '../settings/git-config';
import type { KeybindingOverride } from '../settings/keybindings';
import type { ResolvedTheme, ThemeListEntry } from '../settings/theme-model';
import type { ProfileMeta } from './app-contract';
import {
  REPO_SETTINGS_EVENT_CHANNELS,
  REPO_SETTINGS_INVOKE_CHANNELS,
  type RepoSettingsEventContract,
  type RepoSettingsIpcContract,
} from './repo-settings-contract';

/**
 * Preferences channels (spec 13 §5.4): profiles, themes, keybindings and the
 * settings-file helpers. Merged into the main `IpcContract` / `EventContract`.
 */

export interface ProfilesListResult {
  profiles: ProfileMeta[];
  activeId: string;
  defaultId: string;
}

export interface CreateProfileRequest {
  name: string;
  authorName?: string;
  authorEmail?: string;
  syncGitConfig?: boolean;
  /** Profile whose settings, keybindings, tabs and repos are copied (never secrets). */
  duplicateFrom?: string;
}

export type ProfileUpdatePatch = Partial<
  Pick<ProfileMeta, 'name' | 'authorName' | 'authorEmail' | 'syncGitConfig' | 'avatarSource'>
>;

// ---- commit signing: GPG + SSH (spec 13 §4.2 Commit Signing, §6 Signing) ----------------------

export interface GpgProgramInfo {
  path: string;
  /** `gpg (GnuPG) 2.4.5` → `2.4.5`. */
  version: string;
}

export interface GpgDetectResult {
  /** Program git should use (`signing.gpgProgram` if it runs, else the first working candidate). */
  program?: string;
  version?: string;
  /** Every candidate that ran (`gpg`, `gpg2` on PATH, Gpg4win / GPG Suite / Git for Windows paths). */
  candidates: GpgProgramInfo[];
}

export interface GpgKey {
  /** Long key id (16 hex) of the primary key. */
  keyId: string;
  fingerprint: string;
  /** `Name <email>` user ids (valid and revoked ones are flagged by gpg; revoked uids are dropped). */
  uids: string[];
  /** ms since epoch. */
  created: number;
  /** ms since epoch; null = never expires. */
  expires: number | null;
  expired: boolean;
  revoked: boolean;
  /** Primary key or a subkey can sign. */
  canSign: boolean;
}

export interface GpgGenerateRequest {
  name: string;
  email: string;
  /** Empty / omitted = no passphrase. Passed on stdin (never argv). */
  passphrase?: string;
  algo?: 'ed25519' | 'rsa4096';
  /** gpg expiry spec: `0` (never), `1y`, `2y` (default). */
  expire?: string;
}

export interface AllowedSignersRequest {
  /** Defaults to the active profile email. */
  email?: string;
  /** `.pub` path, `key::ssh-ed25519 AAAA…` or the raw public key; defaults to `signing.signingKey`. */
  key?: string;
  /** Defaults to `signing.allowedSignersFile`, else `~/.ssh/allowed_signers`. */
  file?: string;
}

export interface AllowedSignersResult {
  file: string;
  line: string;
  /** False when an identical entry was already present. */
  added: boolean;
}

// ---- settings.json editor, export / import (spec 13 §4.2 Advanced) ------------------------------

export interface SettingsJsonDocument {
  path: string;
  text: string;
  /** JSON schema for the whole file (`{ version, values }`), for Monaco validation. */
  schema: Record<string, unknown>;
  readOnly: boolean;
  readOnlyReason?: string;
}

export interface SettingsJsonProblem {
  /** Setting key, when the problem is about one value. */
  key?: string;
  message: string;
}

export interface SettingsStatus {
  /** Settings were written by a newer app version: nothing is written until it is resolved. */
  readOnly: boolean;
  readOnlyReason?: string;
  /** Profile `settings.json` path. */
  file: string;
  /** Format version this build writes. */
  version: number;
}

export interface PrefsImportResult {
  file: string;
  /** Settings applied from the bundle. */
  applied: number;
  /** Keys skipped (unknown or invalid), with reasons. */
  skipped: SettingsJsonProblem[];
  keybindings: number;
  /** Theme files written to the themes folder. */
  themes: string[];
}

export interface PrefsExportResult {
  file: string;
  settings: number;
  keybindings: number;
  themes: number;
  /** Values left out because they looked like credentials (e.g. a proxy URL with a password). */
  omitted: string[];
}

export interface PrefsIpcContract extends RepoSettingsIpcContract {
  'profiles:list': { req: Record<string, never>; res: ProfilesListResult };
  'profiles:create': { req: CreateProfileRequest; res: ProfileMeta };
  'profiles:update': { req: { id: string; patch: ProfileUpdatePatch }; res: ProfileMeta };
  'profiles:delete': { req: { id: string }; res: void };
  /** Switches profile; main emits `profiles:switched` and `settings:changed` for differing keys. */
  'profiles:switch': { req: { id: string }; res: ProfileMeta };
  'profiles:setDefault': { req: { id: string }; res: void };

  'themes:list': { req: Record<string, never>; res: ThemeListEntry[] };
  'themes:get': { req: { id: string }; res: ResolvedTheme };
  'themes:openFolder': { req: Record<string, never>; res: void };
  /** Writes `themes/my-theme[-N].jsonc` from `baseId`'s resolved values and opens it. */
  'themes:createFromCurrent': { req: { baseId: string; name?: string }; res: { id: string; file: string } };
  'themes:reload': { req: Record<string, never>; res: ThemeListEntry[] };

  'keybindings:get': { req: Record<string, never>; res: KeybindingOverride[] };
  'keybindings:set': { req: { overrides: KeybindingOverride[] }; res: KeybindingOverride[] };
  'keybindings:openJson': { req: Record<string, never>; res: void };

  'settings:openJson': { req: Record<string, never>; res: void };
  /** File / folder picker for `path` settings. */
  'prefs:pickPath': {
    req: { kind: 'file' | 'directory'; title?: string; defaultPath?: string };
    res: string | null;
  };
  /**
   * Write the Commit Signing settings to git config (scope from `signing.writeScope`;
   * `repoPath` required for local). Returns the entries written.
   */
  'signing:apply': { req: { repoPath?: string }; res: GitConfigEntry[] };
  /** Create / append an `allowed_signers` entry for SSH signature verification. */
  'signing:allowedSigners': { req: AllowedSignersRequest; res: AllowedSignersResult };

  'gpg:detect': { req: Record<string, never>; res: GpgDetectResult };
  /** Secret keys (`gpg --list-secret-keys --with-colons`). */
  'gpg:listKeys': { req: { program?: string }; res: GpgKey[] };
  /** `gpg --batch --quick-gen-key`; returns the new key. */
  'gpg:generateKey': { req: GpgGenerateRequest; res: GpgKey };
  /** `gpg --armor --export <keyId>`. */
  'gpg:exportPublic': { req: { keyId: string }; res: string };

  /** Read the active profile's settings.json for the in-app editor. */
  'settings:readJson': { req: Record<string, never>; res: SettingsJsonDocument };
  /** Validate and save settings.json text; nothing is written when there are problems. */
  'settings:writeJson': { req: { text: string }; res: { ok: boolean; problems: SettingsJsonProblem[] } };
  'settings:status': { req: Record<string, never>; res: SettingsStatus };
  /** Export settings + keybindings + custom themes (no secrets) to a JSON bundle; null = cancelled. */
  'prefs:export': { req: Record<string, never>; res: PrefsExportResult | null };
  /** Import a bundle written by `prefs:export`; null = cancelled. */
  'prefs:import': { req: { file?: string }; res: PrefsImportResult | null };
}

export interface PrefsEventContract extends RepoSettingsEventContract {
  'profiles:switched': ProfileMeta;
  'profiles:changed': ProfilesListResult;
  'themes:changed': { ids: string[] };
  'keybindings:changed': KeybindingOverride[];
}

export const PREFS_INVOKE_CHANNELS = [
  'profiles:list',
  'profiles:create',
  'profiles:update',
  'profiles:delete',
  'profiles:switch',
  'profiles:setDefault',
  'themes:list',
  'themes:get',
  'themes:openFolder',
  'themes:createFromCurrent',
  'themes:reload',
  'keybindings:get',
  'keybindings:set',
  'keybindings:openJson',
  'settings:openJson',
  'prefs:pickPath',
  'signing:apply',
  'signing:allowedSigners',
  'gpg:detect',
  'gpg:listKeys',
  'gpg:generateKey',
  'gpg:exportPublic',
  'settings:readJson',
  'settings:writeJson',
  'settings:status',
  'prefs:export',
  'prefs:import',
  ...REPO_SETTINGS_INVOKE_CHANNELS,
] as const satisfies readonly (keyof PrefsIpcContract)[];

export const PREFS_EVENT_CHANNELS = [
  'profiles:switched',
  'profiles:changed',
  'themes:changed',
  'keybindings:changed',
  ...REPO_SETTINGS_EVENT_CHANNELS,
] as const satisfies readonly (keyof PrefsEventContract)[];

type Exhaustive<All, Listed> = [Exclude<All, Listed>] extends [never]
  ? true
  : { missing: Exclude<All, Listed> };
const invokeExhaustive: Exhaustive<keyof PrefsIpcContract, (typeof PREFS_INVOKE_CHANNELS)[number]> = true;
const eventExhaustive: Exhaustive<keyof PrefsEventContract, (typeof PREFS_EVENT_CHANNELS)[number]> = true;
void invokeExhaustive;
void eventExhaustive;
