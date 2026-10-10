/**
 * Repo-specific settings (spec 13 §4.2 "Repo: <name>" group, §5.2 `RepoSettings`).
 *
 * Two stores back the repo sections:
 *  - `repoSettings:*` — our per-profile, per-repo JSON (`profiles/<id>/repo-settings/<sha1(realpath)>.json`)
 *    for values git has no key for (display encoding, issue tracker mapping).
 *  - `gitconfig:*` — the repository's own `.git/config` (`git config --local`), limited to
 *    `REPO_GITCONFIG_KEYS` and validated in main.
 *
 * These channels are merged into `PrefsIpcContract` / `PrefsEventContract` (prefs-contract.ts), so the
 * main contract and preload allowlist pick them up without further wiring.
 */

/** Which connected tracker (and project / board) this repository's issues come from. */
export interface RepoIssueTracker {
  /** Integration key from `integrations:list` (e.g. `github:github.com`, `jira:acme.atlassian.net`). */
  integrationKey: string;
  /** Provider kind for display when the integration is gone (`github`, `gitlab`, `jira`, `trello`, `linear`…). */
  kind: string;
  /** Project / repo / board scope inside that tracker (`owner/repo`, Jira project key, board id…). */
  projectKey?: string;
}

export interface RepoSettings {
  /**
   * WHATWG Encoding Standard label used to display files that are not valid UTF-8
   * (`TextDecoder` label, e.g. `windows-1252`, `shift_jis`). `utf-8` = default behaviour.
   */
  encoding: string;
  /** Issue tracker for this repo; `null` = automatic (the remote's provider, if connected). */
  issueTracker: RepoIssueTracker | null;
}

export const DEFAULT_REPO_SETTINGS: RepoSettings = { encoding: 'utf-8', issueTracker: null };

/**
 * Display encodings offered in Preferences › Repo › Encoding. Every value is a `TextDecoder`
 * label supported by Chromium and Node (full ICU).
 */
export const DISPLAY_ENCODINGS: readonly { label: string; title: string }[] = [
  { label: 'utf-8', title: 'UTF-8 (default)' },
  { label: 'utf-16le', title: 'UTF-16 LE' },
  { label: 'utf-16be', title: 'UTF-16 BE' },
  { label: 'windows-1252', title: 'Western (Windows-1252)' },
  { label: 'iso-8859-1', title: 'Western (ISO-8859-1)' },
  { label: 'iso-8859-15', title: 'Western (ISO-8859-15)' },
  { label: 'windows-1250', title: 'Central European (Windows-1250)' },
  { label: 'iso-8859-2', title: 'Central European (ISO-8859-2)' },
  { label: 'windows-1251', title: 'Cyrillic (Windows-1251)' },
  { label: 'koi8-r', title: 'Cyrillic (KOI8-R)' },
  { label: 'windows-1253', title: 'Greek (Windows-1253)' },
  { label: 'windows-1254', title: 'Turkish (Windows-1254)' },
  { label: 'windows-1255', title: 'Hebrew (Windows-1255)' },
  { label: 'windows-1256', title: 'Arabic (Windows-1256)' },
  { label: 'windows-1257', title: 'Baltic (Windows-1257)' },
  { label: 'windows-1258', title: 'Vietnamese (Windows-1258)' },
  { label: 'windows-874', title: 'Thai (Windows-874)' },
  { label: 'shift_jis', title: 'Japanese (Shift_JIS)' },
  { label: 'euc-jp', title: 'Japanese (EUC-JP)' },
  { label: 'iso-2022-jp', title: 'Japanese (ISO-2022-JP)' },
  { label: 'gb18030', title: 'Chinese Simplified (GB18030)' },
  { label: 'gbk', title: 'Chinese Simplified (GBK)' },
  { label: 'big5', title: 'Chinese Traditional (Big5)' },
  { label: 'euc-kr', title: 'Korean (EUC-KR)' },
];

/**
 * Git config keys the repo sections may read / write with `--local` (defense in depth for IPC).
 * `githappens.agentSetup` holds the agent worktree setup commands (spec 12, written by the agents
 * feature; edited in Preferences › Repo › Agents).
 */
export const REPO_GITCONFIG_KEYS = [
  'user.name',
  'user.email',
  'user.signingkey',
  'commit.gpgsign',
  'tag.gpgsign',
  'gpg.format',
  'core.hooksPath',
  'commit.template',
  'i18n.commitEncoding',
  'i18n.logOutputEncoding',
  'submodule.recurse',
  'githappens.agentSetup',
] as const;
export type RepoGitConfigKey = (typeof REPO_GITCONFIG_KEYS)[number];

export interface GitConfigListResult {
  /** Values set in this repository's `.git/config`. */
  local: Partial<Record<RepoGitConfigKey, string>>;
  /** Effective values (system → global → local, last wins), for "inherited" hints. */
  effective: Partial<Record<RepoGitConfigKey, string>>;
}

export interface RepoSettingsIpcContract {
  'repoSettings:get': { req: { repoPath: string }; res: RepoSettings };
  /** Shallow patch; `issueTracker: null` clears the mapping. Returns the stored settings. */
  'repoSettings:set': { req: { repoPath: string; patch: Partial<RepoSettings> }; res: RepoSettings };
  /** `git config --local --get <key>` (null when unset). */
  'gitconfig:get': { req: { repoPath: string; key: RepoGitConfigKey }; res: string | null };
  /** All `REPO_GITCONFIG_KEYS`, local and effective. */
  'gitconfig:list': { req: { repoPath: string }; res: GitConfigListResult };
  /** `git config --local --replace-all <key> <value>` after key-specific validation. */
  'gitconfig:set': { req: { repoPath: string; key: RepoGitConfigKey; value: string }; res: void };
  /** `git config --local --unset-all <key>` (missing key is not an error). */
  'gitconfig:unset': { req: { repoPath: string; key: RepoGitConfigKey }; res: void };
}

export interface RepoSettingsEventContract {
  /** Broadcast after `repoSettings:set` (e.g. the issue UI re-reads its tracker mapping). */
  'repoSettings:changed': { repoPath: string; settings: RepoSettings };
}

export const REPO_SETTINGS_INVOKE_CHANNELS = [
  'repoSettings:get',
  'repoSettings:set',
  'gitconfig:get',
  'gitconfig:list',
  'gitconfig:set',
  'gitconfig:unset',
] as const satisfies readonly (keyof RepoSettingsIpcContract)[];

export const REPO_SETTINGS_EVENT_CHANNELS = [
  'repoSettings:changed',
] as const satisfies readonly (keyof RepoSettingsEventContract)[];
