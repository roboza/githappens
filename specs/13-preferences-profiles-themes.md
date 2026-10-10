# 13 — Preferences, Profiles, Themes & Keybindings

> Covers: the Preferences view and every section (app-wide, per-profile, per-repo), multiple profiles (git identity + integrations + tabs + settings per profile), SSH, commit signing (GPG & SSH), editor, in-app terminal, external tools, notifications, UI customization, built-in and custom themes (JSONC), experimental flags, repo-specific settings (encoding, gitflow, hooks, LFS, commit template, issues, sparse checkout, submodules), keybinding customization, settings schema, storage & migration.
> Depends on: 00, 01 (shell, command registry, keybinding dispatcher), 02 (GitService), 09 (SSH/credentials), 10 (integrations), 12 (terminal, AI).

---

## 1. Purpose

GitHappens is opinionated but heavily configurable: users juggle work and personal identities, signing keys, SSH keys, editors, fonts and themes. Preferences must be discoverable (one view with a sectioned sidebar and search), safe (secrets in keychain, git config edits explicit), scoped correctly (app vs. profile vs. repo), and instantly applied (no restart for themes, fonts, zoom). Profiles let one person cleanly separate identities and integrations.

## 2. Reference behavior

- **Opening**: gear icon top-right, Ctrl/Cmd+, (inferred), palette "Settings". Preferences replaces the main area with a left nav of sections and a content pane; repo-specific sections appear in a separate group headed by the current repo name.
- **Scopes**: most settings are stored per **profile**; a few are app-wide; **repo-specific** sections apply to the open repo only.
- **General**: Auto-Fetch interval 0–60 min (0 = off); Auto-Prune; Automatic conflict detection with target branch; Keep submodules up to date; Default branch name (default `main`); Delete `.orig` files after merge; Show all commits in graph; Initial commits in graph (min 500); Lazy load commits; Remember tabs; Longpaths and AutoCRLF (Windows, write global `.gitconfig`); Extended logging; Forget all credentials; Share WIP with team (Team View).
- **Profiles**: profile name, author name, email; "Keep my .gitconfig updated with my profile info"; avatar from connected provider else Gravatar of email; create via profile menu → Manage Profiles (new profile duplicates current tabs); switch via avatar menu or palette; there is no limit on the number of profiles.
- **SSH**: Use local SSH agent (Windows: Pageant and the OpenSSH agent), SSH private key path, public key path, Generate new key, copy public key. Provider-specific SSH keys and "Generate SSH key and add to {provider}" exist in Integrations. `~/.ssh/config` host aliases are honored when using system ssh.
- **Integrations**: GitHub, GitHub Enterprise, GitLab, GitLab Self-Managed, Bitbucket, Bitbucket DC, Azure DevOps, Jira Cloud/DC, Trello, GitHub Issues, GitLab Issues, Linear (newer, inferred). Per integration: connect/disconnect, account info, per-provider SSH key generation. (Details spec 10.)
- **AI**: provider/model selection, bring-your-own API keys, commit message & PR description generation, usage (spec 12).
- **External Tools**: external merge tool, external diff tool, external editor (VS Code, Atom, Sublime, IntelliJ family, custom path; mac must point to the binary inside the .app), default terminal + custom terminal command (e.g. `pwsh -WorkingDirectory %d`), coding agent command/args, agent status plugins (spec 12).
- **Notifications**: enable desktop notifications; marketing/help notifications (only disable-able on paid plans upstream — we allow freely).
- **UI Customization**: theme (with Sync with OS), notification location, date/time locale and format, author initials vs avatars, graph metadata/columns, commit highlighting on hover, hide Launchpad in status bar, show Agents view toggle, group worktree tabs, toolbar labels, default repo group colors, Left Panel density (inferred).
- **Themes**: built-in Light and Dark (plus legacy variants / high contrast — inferred). Custom themes (8.2+) were JSONC files in `~/.githappens/themes/`, created by copying a shipped `*.jsonc-default`, renamed `.jsonc`, with unique `meta.name` and `meta.scheme` `light|dark`; edits hot-reload; invalid files fall back to the default dark theme; values may use CSS functions (`calc`, `hsl[a]`, `rgb[a]`, `min`, `max`, `var`) and LESS color functions (`darken`, `lighten`, `fade`, `saturate`, `desaturate`, `mix`); 8.3.1 added terminal colors. Custom themes were disabled in 11.8 during a UI modernization — **we keep them**.
- **Commit Signing**: GPG program path (auto-detect/browse), signing key dropdown (lists secret keys), Generate new GPG key (name/email from profile, optional passphrase), Sign commits by default, Sign tags by default, Copy public key. **SSH signing**: GPG format = `ssh`, signing key = `.pub` file, allowed signers file.
- **Editor**: font family, font size, tab size, EOL character display, syntax highlighting, line numbers, word wrap (applies to diff/file viewer).
- **In-app Terminal**: font family, size, line height, cursor style/blink, autocomplete (suggestions), default shell on Windows.
- **Experimental**: Git binary executor (vs NodeGit), AI commit messages preview. (We are git-CLI only; Experimental holds our own flags.)
- **Repo-specific**: Encoding, Gitflow, Git Hooks (custom hooks path), LFS (initialize, track patterns, LFS pull), Commit (template / commit settings), Issues (issue tracker for this repo), Team View, Submodules (keep up to date), Sparse Checkout, Agents (setup commands for worktree sessions).
- **Keyboard shortcuts**: a shortcuts list (Ctrl/Cmd+/), plus rebinding as our improvement.

## 3. User stories

1. As a user I want one Preferences view with search so I can find any setting quickly.
2. As a freelancer I want work and personal profiles with different name/email, integrations, SSH keys and open tabs, switchable in two clicks.
3. As a user I want my global `.gitconfig` user.name/email kept in sync with my active profile (opt-in).
4. As a security-minded user I want commits signed with GPG or SSH by default.
5. As a user I want to choose my SSH key or use my system agent.
6. As a user I want to pick dark/light or follow the OS, and create my own theme file that hot-reloads.
7. As a user I want to set editor and terminal fonts, tab size, word wrap.
8. As a user I want per-repo settings: gitflow prefixes, hooks path, LFS, encoding, commit template.
9. As a power user I want to rebind any shortcut and export my settings as JSON.
10. As a user I want auto-fetch every N minutes and auto-prune.

## 4. UI specification

### 4.1 Component tree

```
<PreferencesView>                         (opens as overlay page in active window; Esc/× returns)
 ├─ <PrefsSidebar>
 │   ├─ <PrefsSearch/>                    (filters sections and individual settings by title/keywords)
 │   ├─ group "Profile: <name>" ... 
 │   │   General · Profiles · SSH · Integrations · AI · External Tools · Notifications · UI Customization
 │   │   Themes · Commit Signing · Editor · In-App Terminal · Keyboard Shortcuts · Experimental · Advanced/Settings JSON
 │   └─ group "Repo: <repoName>" (only if a repo tab is active)
 │       Repo General · Encoding · Gitflow · Git Hooks · LFS · Commit · Issues · Submodules · Sparse Checkout · Agents
 └─ <PrefsContent>
     └─ <SettingRow>*  (label, description, control, scope badge [App|Profile|Repo|Git config], reset-to-default ↺)
          controls: Toggle · NumberInput(min,max,step,unit) · Select · Combobox · TextInput · PathPicker(file|dir)
                    · ColorSwatchSelect · FontPicker · KeyChordRecorder · Button · DangerButton
```

Every change applies immediately (debounced 300 ms persist). Settings that write to git config show a "writes to ~/.gitconfig" / ".git/config" badge and a confirmation the first time.

### 4.2 Section details (fields → setting key → default)

**General** (profile)
| Field | Key | Type / default |
|---|---|---|
| Auto-fetch interval (minutes, 0=off) | `general.autoFetchInterval` | int 0–60, 1 |
| Auto-prune on fetch | `general.autoPrune` | bool, true |
| Automatic conflict detection vs target branch | `general.conflictDetection` | bool, false (spec 14) |
| Keep submodules up to date | `general.autoUpdateSubmodules` | bool, true |
| Default branch name for new repos | `general.defaultBranchName` | string `main` (validated by `git check-ref-format --branch`) |
| Default clone directory (inferred) | `general.defaultCloneDirectory` | path, `~/Documents/GitHub`-style or home |
| Delete .orig files after merge | `general.deleteOrigFiles` | bool, true |
| Show all commits in graph | `general.showAllCommits` | bool, false |
| Initial commits loaded | `general.initialCommitCount` | int ≥500, 2000 |
| Lazy-load commits on scroll | `general.lazyLoadCommits` | bool, true |
| Remember tabs | `general.rememberTabs` | bool, true |
| Stash includes untracked (inferred) | `general.stashIncludeUntracked` | bool, true |
| Default pull mode | `git.pullMode` | `PullStrategy` (spec 09): `ff-if-possible`\|`ff-only`\|`rebase`\|`merge-no-ff`, `ff-if-possible` |
| Preserve merges on pull rebase | `git.pullRebaseMerges` | bool, false (spec 09 §6.4) |
| Push tags with branches (`--follow-tags`) | `git.pushFollowTags` | bool, false (spec 09 §4.4) |
| Use Git credential helpers | `git.useCredentialHelpers` | bool, true (spec 09 §6.6) |
| Autostash on checkout | `checkout.autostash` | `ask`\|`always`\|`never`, `ask` (spec 05 §4.5) |
| Pop autostash after checkout | `checkout.autoPopStash` | bool, false (spec 05 §4.5) |
| Graph commit order | `graph.order` | `date`\|`topo`, `date` (spec 04 §6.2) |
| Maintain commit-graph file | `graph.maintainCommitGraph` | bool, true (spec 02 §6.15.1) |
| Reuse layout on refresh (advanced) | `graph.convergenceReuse` | bool, true (spec 04 §6.10) |
| Windows: core.longpaths | git global `core.longpaths` | bool (writes global) |
| Windows: core.autocrlf | git global `core.autocrlf` | `true`\|`input`\|`false` |
| Extended logging | `general.extendedLogging` | bool, false |
| Forget all credentials | action `cred:forgetAll` (spec 09) | DangerButton |
| Update channel (app scope) | `app.updateChannel` | `stable`\|`preview`, `stable` (spec 15) |
| Automatically download updates (app scope) | `app.autoDownloadUpdates` | bool, true (spec 15) |

**Profiles** — list of profiles with active marker; selected profile form: Profile name, Author name, Author email, "Keep global .gitconfig updated" (`profile.syncGitConfig`), avatar preview (provider avatar or Gravatar `https://www.gravatar.com/avatar/<md5(lowercase email)>?d=identicon` — fetched only if `ui.useGravatar` true), buttons: Add profile, Duplicate, Delete (not allowed for last/active), Set as default on startup.

**SSH** (profile)
| Field | Key |
|---|---|
| Use local SSH agent | `ssh.useLocalAgent` (bool, false). Win: OpenSSH agent pipe `\\.\pipe\openssh-ssh-agent` or Pageant |
| SSH private key | `ssh.privateKeyPath` |
| SSH public key | `ssh.publicKeyPath` (auto-filled as `<private>.pub`) |
| Generate new key | action: type ed25519 (default)/rsa-4096, comment = profile email, passphrase optional → `ssh-keygen -t ed25519 -C <email> -f <path> -N <pass>` |
| Copy public key | action |
| Honor ~/.ssh/config | `ssh.useSshConfig` (bool, true) |
| Use system ssh binary | `ssh.executable` (`bundled`\|`system`\|path) |
| Prefer SSH URLs when cloning from providers (inferred) | `ssh.preferSshForProviders` |
| Windows agent | `ssh.windowsAgent` (`openssh`\|`pageant`, `openssh`; spec 09) |

**Network** (profile; spec 09 §4.4, §6.11)
| Field | Key | Type / default |
|---|---|---|
| Proxy mode | `network.proxyMode` | `system`\|`manual`\|`none`, `system` |
| Manual proxy URL | `network.proxyUrl` | string `http://host:port` |
| No-proxy list | `network.noProxy` | string[] |
| Proxy credentials | action → SecretStore `<profileId>/proxy/<host>` | — |
| Use OS certificate store (Windows) | `network.useOsCertStore` | bool, false (`http.sslBackend=schannel`) |
| Custom CA bundle | `network.caBundlePath` | path (git `http.sslCAInfo` + provider HTTP trust, specs 09/10) |

**Integrations** — cards per provider (spec 10): Connect (OAuth/PAT), account, disconnect, "Generate SSH key and add to <provider>", per-provider SSH key override (`integrations.<integrationKey>.sshKeyPath`). Secrets in SecretStore as `<profileId>/integration/<integrationKey>` (§5.1).

**AI** (profile) — keys mirror spec 12 `AiSettings`: `ai.enabled` (bool, true), `ai.provider` (`anthropic`\|`openai`\|`azure-openai`\|`gemini`\|`openai-compatible`, `anthropic`), `ai.model` (`claude-sonnet-5-5`), `ai.baseUrl`, `ai.effort` (per feature), `ai.maxDiffChars` (120000), `ai.excludeGlobs`, `ai.instructions`, `ai.commitStyle` (`free`\|`conventional`\|`gitmoji`), `ai.language`. The API key is a secret stored as `<profileId>/ai/<provider>`, never in settings JSON.

**External Tools** (profile)
| Field | Key | Options |
|---|---|---|
| External merge tool | `tools.mergeTool` | none, Kaleidoscope, Beyond Compare, P4Merge, KDiff3, Meld, VS Code, IntelliJ, FileMerge, Araxis, WinMerge(diff), custom |
| External diff tool | `tools.diffTool` | same list |
| Custom tool command | `tools.customMergeCmd` / `tools.customDiffCmd` | tokens `$BASE $LOCAL $REMOTE $MERGED` |
| Trust merge tool exit code | `tools.mergeToolTrustExitCode` | bool, false (spec 08 §6.8) |
| Keep merge tool `.orig` backups | `tools.mergeToolKeepBackup` | bool, false (spec 08 §6.8) |
| Use external merge tool by default | `tools.useExternalMergeToolByDefault` | bool, false (spec 08 §4.8) |
| External editor | `tools.editor` | VS Code, VS Code Insiders, Cursor, Sublime, Atom, IntelliJ/WebStorm/…, Zed, custom path |
| Default terminal | `tools.terminal` | OS default, Windows Terminal, PowerShell, cmd, Git Bash, Terminal.app, iTerm2, gnome-terminal, konsole, custom |
| Custom terminal command | `tools.terminalCommand` | template with `%d` (dir) |
| Coding agent command/args | `tools.agentCommand` / `tools.agentArgs` | (spec 12) |

**Notifications** (profile): `notifications.desktop` (bool true), `notifications.marketing` (bool true), `notifications.autoFetchErrors` (bool false — suppress repeated background errors, inferred), `notifications.prEvents` (bool true).

**UI Customization** (profile)
| Field | Key | Default |
|---|---|---|
| Theme | `ui.theme` | `system` (→ `builtin:dark`/`builtin:light`) |
| Sync theme with OS | `ui.themeFollowOs` | true; with `ui.themeLight`, `ui.themeDark` pairs |
| Notification location | `ui.notificationLocation` | `bottom-left` |
| Date locale | `ui.dateLocale` | `system` (BCP-47) |
| Date format | `ui.dateFormat` | `relative`\|`short`\|`long`\|`iso`\|custom (dayjs tokens, e.g. `YYYY-MM-DD HH:mm`) |
| 24-hour time | `ui.hour12` | per locale |
| Author display in graph | `ui.authorDisplay` | `avatar`\|`initials` |
| Use Gravatar | `ui.useGravatar` | true |
| Graph columns default | `ui.graphColumns` | Branch/Tag, Graph, Message (+Author/Date/SHA optional) |
| Highlight related commits on hover | `ui.graphHoverHighlight` | true |
| Graph row density | `ui.graphRowHeight` | `normal`(28px)\|`compact`(22px) (inferred) |
| Graph edge style | `ui.graphEdgeStyle` | `rounded`\|`bezier`, `rounded` (spec 04 §4.5) |
| Show toolbar labels | `ui.toolbarLabels` | false |
| Hide Launchpad in status bar | `ui.hideLaunchpadStatus` | false |
| Show Agents toggle in left panel | `ui.showAgentsToggle` | false |
| Group worktree tabs | `ui.groupWorktreeTabs` | true |
| Default repo group colors | `ui.repoGroupColors` | palette |
| UI font size / zoom | `ui.zoom` | 1.0 |
| Reduce motion | `ui.reduceMotion` | follows OS |

**Themes** — gallery of built-in + custom themes with preview swatches; buttons: *Open themes folder*, *Create theme from current* (copies default template into `themes/my-theme.jsonc`), *Reload*. Shows parse errors per file (line/col).

**Commit Signing** (profile + git config)
| Field | Key / git config |
|---|---|
| Signing format | `signing.format` → git `gpg.format` = `openpgp`\|`ssh`\|`x509` |
| GPG program | `signing.gpgProgram` → `gpg.program` (auto-detect `gpg`, `gpg2`, Gpg4win, GPG Suite paths) |
| Signing key (GPG) | dropdown from `gpg --list-secret-keys --keyid-format=long --with-colons` → `user.signingkey` |
| Signing key (SSH) | `.pub` path or `key::ssh-ed25519 AAAA…` → `user.signingkey` |
| Allowed signers file | `gpg.ssh.allowedSignersFile` (for verification display) |
| Sign commits by default | `commit.gpgsign` |
| Sign tags by default | `tag.gpgsign` |
| Generate GPG key | action: `gpg --batch --gen-key` with parameter file (ed25519/cv25519 or RSA 4096, name/email from profile, passphrase) |
| Copy public key | `gpg --armor --export <keyid>` / read .pub |
| Scope | where to write: global (`--global`) or this repo (`--local`) radio |

**Editor** (profile): `editor.fontFamily` ("Menlo, Consolas, 'DejaVu Sans Mono', monospace"), `editor.fontSize` (12), `editor.tabSize` (4), `editor.showEol` (false), `editor.renderWhitespace` (`none|boundary|all`), `editor.syntaxHighlighting` (true), `editor.lineNumbers` (true), `editor.wordWrap` (false), `diff.defaultView` (`hunk|inline|split`), `diff.whitespace` (`none|eol|amount|all`, `none`; spec 07 §4.5), `diff.ignoreBlankLines` (false), `diff.contextLines` (3), `diff.renameLimit` (1000). Mapped to Monaco options (spec 07).

**In-App Terminal** (profile): `terminal.fontFamily`, `terminal.fontSize` (13), `terminal.lineHeight` (1.2), `terminal.cursorStyle` (`block|bar|underline`), `terminal.cursorBlink` (true), `terminal.autocomplete` (true; git command suggestions, spec 12), `terminal.shell` (Windows: `pwsh|powershell|cmd|gitbash|wsl`; posix: `$SHELL`), `terminal.shellArgs`, `terminal.scrollback` (5000), `terminal.dimWhenUnfocused` (true), `terminal.shellIntegration` (true; spec 12 §6.1).

**Keyboard Shortcuts** — table of all commands (from registry, spec 01 §4.9): Command, Category, Keybinding(s), When-context, Source (default/user). Actions: click to record new chord (`KeyChordRecorder`), add secondary binding, remove, reset; conflict warning listing the other command; search by command or by pressing keys ("Record keys" search mode); Export/Import `keybindings.json`.

**Experimental** (app): `experimental.flags: Record<string, boolean>` (e.g. `graphWebGL`, `fsmonitor` = use `core.fsmonitor`, `aiCompose`) with "requires restart" badges.

**Advanced / Settings JSON**: "Open settings.json" (opens in internal Monaco with JSON schema validation), Export settings (zip of profile without secrets), Import settings, Reset all to defaults, Open logs folder.

**Repo-specific sections** (stored in `.git/config` where git-native, otherwise in our per-repo store)
| Section | Field | Storage |
|---|---|---|
| Repo General | Alias, Auto-fetch override (inherit/off/N), Default remote | repo store |
| Encoding | Default text encoding for viewing files (`UTF-8` default; list from iconv-lite: UTF-16LE/BE, Windows-125x, ISO-8859-x, Shift_JIS, GB18030, EUC-KR…); "Use `.gitattributes` `working-tree-encoding` when present" | repo store; `i18n.commitEncoding`/`i18n.logOutputEncoding` optional git config |
| Gitflow | Initialize/Reset; Production branch (`main`), Development branch (`develop`), Feature prefix (`feature/`), Release prefix (`release/`), Hotfix prefix (`hotfix/`), Bugfix (`bugfix/`), Support (`support/`), Version tag prefix (``) | git config `gitflow.branch.master`, `gitflow.branch.develop`, `gitflow.prefix.feature|release|hotfix|bugfix|support|versiontag` (git-flow AVH compatible) |
| Git Hooks | Hooks path (default `.git/hooks`), Browse, Reset; list of present hooks with exec-bit status and "make executable" (posix) | git config `core.hooksPath` (local) |
| LFS | Initialize LFS (`git lfs install --local` + create `.gitattributes`), Tracked patterns list (add/remove → `git lfs track/untrack`), Fetch/Pull LFS objects, Prune (danger), LFS URL override (`lfs.url`) | `.gitattributes`, git config |
| Commit | Commit message template (path, `commit.template`), default co-authors (inferred), "Skip hooks" default (false), Max summary length warning (72), Signing override (inherit/on/off) | git config + repo store |
| Issues | Issue tracker for this repo (none/GitHub/GitLab/Jira project/Trello board) | repo store (spec 10) |
| Submodules | Keep up to date (inherit/on/off), `submodule.recurse` | repo store + git config |
| Sparse Checkout | Enable/Disable/Reapply, paths editor | `git sparse-checkout` |
| Agents | Setup commands run on new worktree session (multi-line) | repo store (spec 12) |
| Remotes (inferred) | link to remote management (spec 09) | — |

### 4.3 Profile switcher UI
- Avatar button (top-right, spec 01) → menu: list of profiles (avatar, name, email, check on active), "Manage Profiles…", "Preferences", "Sign in/Account".
- Switching: confirm if any op is running; save current tabs; load target profile's settings → re-theme, reload tabs, reset provider query caches, rebuild menu accelerators, update `git config --global user.*` if that profile has sync on.
- Palette: `profile.switch` with profile arg.

## 5. Data model & IPC

### 5.1 Storage layout (`app.getPath('userData')`)
```
app.json                         # AppSettings (app scope): activeProfileId, defaultProfileId, updateChannel, experimental, windowState
profiles/
  index.json                     # ProfileMeta[]
  <profileId>/
    settings.json                # ProfileSettings (sparse: only non-default values)
    keybindings.json             # KeybindingOverride[]
    tabs.json                    # spec 01
    repos.json                   # spec 03
    repo-settings/<sha1(realpath)>.json   # RepoSettings (non-git-native)
    repo-ui/<sha1>.json          # spec 01 RepoUiState
themes/
  *.jsonc                        # user themes (shared across profiles)
  dark.jsonc-default, light.jsonc-default   # regenerated templates on each start
logs/
```
Secrets (tokens, AI keys, SSH/GPG passphrases if user opts to save) → keychain via `keytar` or `safeStorage`-encrypted `secrets.bin`; never in JSON.

**SecretStore naming (binding for specs 09, 10, 12, 14):** one keytar service `GitHappens`, with account `<profileId>/<kind>/<key>`, where kind and key are `integration/<integrationKey>`, `git/<username>@<host>`, `proxy/<host>`, `ssh-passphrase/<fingerprint>`, `gpg-passphrase/<keyId>`, `ai/<provider>` or `cloud/<serverUrl>/<userId>`. The `safeStorage` fallback file uses the same account strings as keys. Deleting a profile deletes `<profileId>/*`.

### 5.2 Types
```ts
export type SettingScope = 'app' | 'profile' | 'repo' | 'gitGlobal' | 'gitLocal';

export interface ProfileMeta { id: string; name: string; authorName: string; authorEmail: string;
  syncGitConfig: boolean; avatarSource: 'provider'|'gravatar'|'initials'; createdAt: number; }

export interface ProfileSettings {
  general: { autoFetchInterval: number; autoPrune: boolean; conflictDetection: boolean; autoUpdateSubmodules: boolean;
    defaultBranchName: string; defaultCloneDirectory?: string; deleteOrigFiles: boolean; showAllCommits: boolean;
    initialCommitCount: number; lazyLoadCommits: boolean; rememberTabs: boolean; stashIncludeUntracked: boolean;
    extendedLogging: boolean; };
  git: { pullMode: PullStrategy /* spec 09 */; pullRebaseMerges: boolean; pushFollowTags: boolean; useCredentialHelpers: boolean;
    executable: 'bundled'|'system'|string };
  checkout: { autostash: 'ask'|'always'|'never'; autoPopStash: boolean };
  graph: { order: 'date'|'topo'; maintainCommitGraph: boolean; convergenceReuse: boolean };
  network: { proxyMode: 'system'|'manual'|'none'; proxyUrl?: string; noProxy: string[]; useOsCertStore: boolean; caBundlePath?: string };
  ssh: { useLocalAgent: boolean; privateKeyPath?: string; publicKeyPath?: string; useSshConfig: boolean;
    executable: 'bundled'|'system'|string; preferSshForProviders: boolean; windowsAgent: 'openssh'|'pageant' };
  tools: { mergeTool: string; diffTool: string; customMergeCmd?: string; customDiffCmd?: string; editor: string;
    editorPath?: string; terminal: string; terminalCommand?: string; agentCommand?: string; agentArgs?: string;
    mergeToolTrustExitCode: boolean; mergeToolKeepBackup: boolean; useExternalMergeToolByDefault: boolean };
  notifications: { desktop: boolean; marketing: boolean; autoFetchErrors: boolean; prEvents: boolean };
  ui: { theme: string; themeFollowOs: boolean; themeLight: string; themeDark: string;
    notificationLocation: 'bottom-left'|'bottom-right'|'top-left'|'top-right'; dateLocale: string;
    dateFormat: 'relative'|'short'|'long'|'iso'|{ custom: string }; hour12?: boolean;
    authorDisplay: 'avatar'|'initials'; useGravatar: boolean; graphColumns: GraphColumnConfig[];
    graphHoverHighlight: boolean; graphRowHeight: 'normal'|'compact'; graphEdgeStyle: 'rounded'|'bezier'; toolbarLabels: boolean;
    hideLaunchpadStatus: boolean; showAgentsToggle: boolean; groupWorktreeTabs: boolean;
    repoGroupColors: string[]; zoom: number; reduceMotion: 'os'|boolean };
  signing: { format: 'openpgp'|'ssh'|'x509'; gpgProgram?: string; signingKey?: string; allowedSignersFile?: string;
    signCommits: boolean; signTags: boolean; writeScope: 'global'|'local' };
  editor: { fontFamily: string; fontSize: number; tabSize: number; showEol: boolean;
    renderWhitespace: 'none'|'boundary'|'all'; syntaxHighlighting: boolean; lineNumbers: boolean; wordWrap: boolean };
  diff: { defaultView: 'hunk'|'inline'|'split'; whitespace: 'none'|'eol'|'amount'|'all'; ignoreBlankLines: boolean; contextLines: number; renameLimit: number };
  terminal: { fontFamily: string; fontSize: number; lineHeight: number; cursorStyle: 'block'|'bar'|'underline';
    cursorBlink: boolean; autocomplete: boolean; shell?: string; shellArgs?: string[]; scrollback: number; dimWhenUnfocused: boolean; shellIntegration: boolean };
  ai: Omit<AiSettings, 'consentGivenFor'>;                       // spec 12 §5; API keys in SecretStore
  layout: LayoutState;                                           // spec 01
}

export interface RepoSettings { alias?: string; autoFetch?: 'inherit'|'off'|number; defaultRemote?: string;
  encoding: string; useWorkingTreeEncoding: boolean; issueTracker?: { kind: string; projectKey?: string };
  autoUpdateSubmodules?: 'inherit'|boolean; commitSkipHooksDefault: boolean; summaryMaxLength: number;
  signingOverride?: 'inherit'|boolean; agentSetupCommands?: string; }

export interface GitflowConfig { production: string; develop: string; feature: string; release: string; hotfix: string;
  bugfix: string; support: string; versionTag: string; initialized: boolean; }

export interface KeybindingOverride { command: string; key: string /* e.g. "ctrl+shift+k" or "" to unbind */;
  when?: string; mac?: string; }

export interface SettingDescriptor { key: string; scope: SettingScope; section: string; title: string; description: string;
  type: 'boolean'|'number'|'string'|'enum'|'path'|'color'|'font'|'object'; default: unknown; enum?: unknown[];
  min?: number; max?: number; keywords?: string[]; requiresRestart?: boolean; platforms?: NodeJS.Platform[]; }
```
A single `settingsRegistry: SettingDescriptor[]` drives the UI, search, validation (Zod schema generated from it) and the JSON Schema for `settings.json` (`$schema: "githappens://schemas/settings.json"`, registered with Monaco).

### 5.3 Theme file format (JSONC)
```jsonc
{
  "meta": { "name": "My Ocean", "scheme": "dark", "extends": "builtin:dark" },   // extends: our addition
  "themeValues": {
    "root": {                       // global tokens → CSS variables --kl-<key>
      "red": "#d9534f", "orange": "#f0ad4e", "yellow": "#f8e45c", "green": "#5cb85c", "teal": "#2ec4b6",
      "blue": "#4a90e2", "ultramarine": "#3f51b5", "purple": "#9b59b6", "pink": "#e84393", "bronze": "#cd7f32", "grey": "#8a8f98",
      "graph-color-1": "var(--blue)", "...": "graph-color-1 .. graph-color-10 lane colors",
      "app__bg0": "#1b1f24", "panel__bg0": "#20252c", "panel__bg1": "lighten(#20252c, 4%)", "panel-border": "fade(#ffffff, 8%)",
      "section-border": "...", "input__bg": "...", "input--disabled__bg": "...", "link-color": "var(--blue)",
      "text-selected": "#ffffff", "text-normal": "fade(#ffffff, 80%)", "text-secondary": "fade(#ffffff, 60%)", "text-disabled": "fade(#ffffff, 40%)",
      "text-accent": "var(--teal)", "text-inverse": "#000", "btn-text": "...", "btn-text-hover": "...",
      "default-border": "...", "selected-row": "...", "hover-row": "...", "danger-row": "...",
      "wip-status": "...", "filtered-highlight": "...", "drop-target": "...",
      "added": "var(--green)", "modified": "var(--orange)", "deleted": "var(--red)", "renamed": "var(--blue)",
      "diff-added__bg": "fade(var(--green), 20%)", "diff-deleted__bg": "fade(var(--red), 20%)",
      "scroll-thumb-border": "...", "scroll-thumb-bg": "...", "shadow": "..."
    },
    "toolbar": { "toolbar__bg0": "...", "toolbar__bg1": "...", "text-normal": "...", "btn-text": "..." },
    "tabsbar": { "tabsbar__bg": "...", "tab--active__bg": "...", "text-normal": "...", "text-selected": "..." },
    "terminal": { "background": "...", "foreground": "...", "cursor": "...", "selection": "...",
                  "black": "...", "red": "...", "...": "16 ANSI colors (xterm ITheme keys)" },
    "editor": { "monacoBase": "vs-dark", "rules": [], "colors": { "editor.background": "..." } }   // our addition
  }
}
```
Key names in `root/toolbar/tabsbar/terminal` mirror a legacy theme template structure (inferred from community themes; exact upstream token list not verified). Scoped groups (`toolbar`, `tabsbar`) override root tokens inside those regions (CSS variables re-declared on `.toolbar`, `.tabsbar`).

Value evaluation: parse with `jsonc-parser`; each string value evaluated by a small expression evaluator supporting `var(--x)` (resolved against the theme's own tokens, with cycle detection), CSS functions passed through (`calc`, `rgb[a]`, `hsl[a]`, `min`, `max`), LESS functions `darken/lighten/fade/saturate/desaturate/mix/mixLess` computed with `culori` (since CSS can't do them). Output: `Record<string,string>` → injected as a `<style id="theme">:root{--kl-…}</style>`.

### 5.4 IPC channels

**Mapping to the spec 02 contract.** `gitconfig:get/set/unset` are thin wrappers over spec 02 `git:config:get` / `git:config:set` (writes are queued). `gitflow:*` reads use `git:config:list { pattern: '^gitflow\.' }`. `lfs:*` delegate to spec 09 (`git:lfs:status` and the `lfs.*` `GitOperation` variants). `ssh:*` key and credential actions are spec 09 channels. Only settings, profiles, themes and keybindings channels are owned here.

| Channel | Payload → Result |
|---|---|
| `settings:getAll` | → `{ app: AppSettings; profile: ProfileSettings; registry: SettingDescriptor[] }` |
| `settings:set` | `{ key, value, scope }` → `{ ok, error? }` (validated in main) |
| `settings:reset` | `{ key? }` (all if omitted) |
| `settings:changed` (evt) | `{ key, value, scope }` broadcast to all windows |
| `settings:openJson` / `settings:export` / `settings:import` | path pickers; import validates & merges |
| `repoSettings:get` / `repoSettings:set` | `{repoPath}` / `{repoPath, patch}` |
| `gitconfig:get` | `{ key, scope: 'global'|'local', repoPath? }` → string \| null |
| `gitconfig:set` / `gitconfig:unset` | `{ key, value, scope, repoPath? }` |
| `profiles:list` | → `{ profiles: ProfileMeta[]; activeId }` |
| `profiles:create` | `{ name, authorName, authorEmail, duplicateFrom?: string }` → `ProfileMeta` |
| `profiles:update` / `profiles:delete` | `{ id, patch }` / `{ id }` |
| `profiles:switch` | `{ id }` → void; emits `profiles:switched` (evt) then renderer reloads state |
| `themes:list` | → `{ id, name, scheme, source: 'builtin'|'user', file?, error? }[]` |
| `themes:get` | `{ id }` → `{ tokens: Record<string,string>; terminal: ITheme; monaco: IStandaloneThemeData; scheme }` |
| `themes:changed` (evt) | file watcher on themes dir → `{ id }` |
| `themes:openFolder` / `themes:createFromCurrent` | |
| `os:nativeThemeChanged` (evt) | `{ shouldUseDarkColors }` from `nativeTheme.on('updated')` |
| `keybindings:get` / `keybindings:set` | `KeybindingOverride[]` |
| `ssh:key:generate` (spec 09) | `{ profileId, type, comment, passphrase?, path? }` → `{ privateKeyPath, publicKeyPath, publicKey, fingerprint }` |
| `ssh:testConnection` | `{ host }` → `{ ok, output }` (`ssh -T git@host`) |
| `gpg:detect` | → `{ program?: string; version?: string }` |
| `gpg:listKeys` | → `{ keyId, uids, created, expires, fingerprint }[]` |
| `gpg:generateKey` | `{ name, email, passphrase?, algo }` → keyId |
| `gpg:exportPublic` | `{ keyId }` → armored string |
| `gitflow:get` / `gitflow:init` / `gitflow:reset` | repoPath, `GitflowConfig` |
| `hooks:list` | `{repoPath}` → `{ name, path, executable }[]` |
| `lfs:status` / `lfs:init` / `lfs:track` / `lfs:untrack` | |
| `cred:forgetAll` (spec 09) | `{ profileId }` → clears SecretStore `<profileId>/git/*` entries owned by the app |
| `tools:detect` | → detected editors/merge tools/terminals with paths |

## 6. Git implementation

- **Profile git identity sync** (on switch / edit when `syncGitConfig`):
  `git config --global user.name "<authorName>"` ; `git config --global user.email "<authorEmail>"`.
  Without sync, commits made by the app pass identity per command: `git -c user.name=… -c user.email=… commit …` (spec 06) so profile identity wins without touching global config. Repo-local `user.*` (if set) overrides profile — show banner "This repo overrides your identity" (read `git config --local --get user.email`).
- **Auto-fetch**: the scheduler is spec 09 §6.2 (interval, skip rules, background-tab throttle, auth pause, backoff). This spec only supplies `general.autoFetchInterval`, `general.autoPrune` and the `RepoSettings.autoFetch` override, plus the app-wide cap of 3 concurrent auto-fetches (§8).
- **Windows globals**: `git config --global core.longpaths true|false`, `git config --global core.autocrlf <v>`.
- **Default branch**: used as `git init --initial-branch=<name>`; optionally offer to write `git config --global init.defaultBranch <name>` (checkbox, inferred).
- **Signing**:
  - GPG: `git config [--global|--local] gpg.format openpgp`, `user.signingkey <KEYID>`, `gpg.program <path>`, `commit.gpgsign true`, `tag.gpgsign true`.
  - SSH: `gpg.format ssh`, `user.signingkey <path-to.pub>`, `gpg.ssh.allowedSignersFile <path>`; allowed signers line format `<email> namespaces="git" <pubkey contents>` — offer "Create allowed_signers" action writing `~/.ssh/allowed_signers`.
  - Key listing: `gpg --list-secret-keys --keyid-format=long --with-colons` (parse `sec`, `fpr`, `uid` records).
  - Key generation: `gpg --batch --pinentry-mode loopback --passphrase-fd 0 --quick-gen-key "<name> <email>" ed25519 sign 2y` (fallback `rsa4096`).
  - Passphrase prompts at commit time: rely on gpg-agent/pinentry; for SSH signing with passphrase, rely on ssh-agent; surface stderr `error: gpg failed to sign the data` with remediation tips.
- **SSH**: `GIT_SSH_COMMAND` is built by spec 09 §6.7 (`ssh -i "<privateKey>" -o IdentitiesOnly=yes`, plus `-F none` only when `ssh.useSshConfig` is false). Unknown host keys always go to the host-key prompt; we never pass `StrictHostKeyChecking=accept-new`. Agent mode and Pageant are as in spec 09.
- **Key generation**: delegated to spec 09 `ssh:key:generate` (`ssh-keygen` under node-pty so the passphrase never appears in argv, then permissions fixed). The comment defaults to the profile email.
- **Gitflow**: read `git config --local --get-regexp '^gitflow\.'`; init writes `gitflow.branch.master`, `gitflow.branch.develop`, `gitflow.prefix.*`; create develop if missing `git branch develop <production>`. Reset = `git config --local --remove-section gitflow.branch` and `gitflow.prefix`.
- **Hooks**: `git config --local core.hooksPath <path>` / `--unset`; list via `fs.readdir` excluding `*.sample`; make executable `fs.chmod(0o755)`.
- **LFS**: `git lfs install --local`, `git lfs track "<pattern>"`, `git lfs untrack "<pattern>"`, `git lfs ls-files`, `git lfs pull`, `git lfs prune` (confirm).
- **Commit template**: `git config --local commit.template <path>`; read file to prefill composer (spec 06).
- **Encoding**: decode blobs in main with `iconv-lite` per repo setting or `.gitattributes` `working-tree-encoding` (`git check-attr working-tree-encoding -- <path>`).
- **Credentials forget**: remove our keychain entries; for git credential helper entries we stored via `git credential reject` with protocol/host for each known host.
- **Tool detection**: check known install paths + `PATH` lookup (`where`/`which`) for `code`, `cursor`, `subl`, `idea`, `bcompare`, `p4merge`, `kdiff3`, `meld`, `ksdiff`; launch merge via configured command with tokens.

## 7. Step-by-step implementation plan

1. **Settings registry** (`shared/settings/registry.ts`) listing every `SettingDescriptor` from §4.2; generate Zod schema + JSON Schema at build time. Unit test: defaults validate.
2. **SettingsStore (main)**: load `app.json` and active profile `settings.json`, deep-merge with defaults, sparse write (only diffs), atomic writes, `settings:changed` broadcast. Schema `version` field + migrations array. Tests for corrupt file → backup as `settings.json.bak-<ts>` and fall back to defaults with toast.
3. **Renderer `useSettings` store** (Zustand) hydrated via `settings:getAll`, subscribed to `settings:changed`; `useSetting(key)` hook.
4. **PreferencesView shell**: sidebar sections from registry, generic `SettingRow` rendering by type, search over title/description/keywords, scope badges, reset buttons.
5. **ProfileStore**: create (UUID), duplicate (copies settings, keybindings, tabs, repos; not secrets unless user chooses), delete (move to `profiles/.trash`, then remove), switch flow (§4.3). First-run migration creates "Default" profile from `git config --global user.name/email`.
6. **Git config bridge** (`gitconfig:*`), with confirmation UX for global writes; identity sync on profile switch.
7. **Theme engine**: built-in themes as TS token maps; JSONC loader + expression evaluator + `var()` resolver + LESS color functions (unit tests for each function); CSS variable injection; Monaco theme + xterm theme derivation; `nativeTheme` follow-OS; chokidar watch on `themes/` with 150 ms debounce; error reporting with line/col; fallback to `builtin:dark` on invalid.
8. **Template emission**: on startup write `dark.jsonc-default` / `light.jsonc-default` with commented token documentation; "Create theme from current".
9. **Keybinding service**: defaults from command registry + `keybindings.json` overrides; resolver by platform & `when` (focus zones); conflict detection; `KeyChordRecorder` component; menu accelerators rebuilt (spec 01 `menu:rebuild`). Tests: override/unbind/conflict.
10. **SSH section**: path pickers, key generation, copy pubkey, test connection; wire into GitService env builder (spec 09).
11. **Commit signing section**: gpg detect/list/generate/export; SSH signing with allowed signers helper; scope radio; write git config.
12. **Editor & Terminal sections**: map to Monaco/xterm live options (spec 07/12).
13. **External tools**: detection, custom command templates, "Test" button that launches tool on two temp files.
14. **Notifications & UI customization**: wire to ToastHost, date formatting util (`dayjs` + locale + relative), avatar/initials renderer.
15. **Repo-specific sections**: RepoSettings store, gitflow, hooks, LFS, commit template, encoding, sparse, issues placeholder.
16. **Settings JSON editor**: Monaco with JSON schema validation; on save → validate → apply.
17. **Export/Import** (zip via `yazl`/`yauzl`, excludes secrets), Reset all.
18. **E2E**: switch profile changes identity used in a commit (`git log -1 --format=%ae`), theme hot reload, rebinding a shortcut works and appears in menu, GPG signing produces `%G?` = `G` with a fixture key.

## 8. Edge cases

- Corrupt `settings.json` / theme JSONC → backup & defaults / skip theme with error, never crash.
- Concurrent edit of `settings.json` externally → file watcher reloads; in-app edits after external edit merge by key (last write wins).
- Deleting the active profile → disallowed; deleting last profile → disallowed.
- Profile with empty name/email (seen upstream 12.4.1) → startup falls back to a valid profile and shows a fix prompt.
- Global `.gitconfig` uses `[include]`/`includeIf` → reading effective values must use `git config --show-origin`; writes go to `--global` file only; warn if the value is overridden by an included file.
- Repo-local `user.email` differs from profile → banner, no silent override.
- GPG not installed / key expired / pinentry needs TTY → descriptive errors; signing disabled until fixed.
- SSH signing with git < 2.34 → disable `ssh` format option.
- Windows OpenSSH agent service stopped → detect `ENOENT` on pipe, suggest enabling service.
- Fonts not installed → fallback stack; FontPicker lists system fonts via `queryLocalFonts` (if permitted) or a curated list.
- Keybinding conflicts with OS shortcuts (Cmd+Tab, Cmd+Q, Alt+F4) → reserved list cannot be bound.
- Theme `var()` cycles → error for that key, use builtin fallback value.
- Theme scheme mismatch (light theme with dark editor) → scheme drives Monaco base & native title bar.
- Auto-fetch on 50 open repos → global concurrency limit 3 fetches; jitter start times.
- `defaultBranchName` invalid (`main..x`) → validation error via `git check-ref-format --branch`.
- Hooks path relative → resolve relative to worktree root (git semantics).
- Settings from a newer app version (higher schema version) → open read-only with warning, don't downgrade-write.

## 9. Acceptance criteria

- [ ] Preferences view lists all sections in §4.2 with working controls, search, scope badges, and reset.
- [ ] Changes apply live (theme, fonts, zoom, toasts location) and persist across restarts.
- [ ] Profiles: create/duplicate/edit/delete/switch; each profile has independent identity, settings, keybindings, tabs, repos list, integrations; global gitconfig sync optional and correct.
- [ ] SSH: key path or local agent used for git network ops; key generation and copy work.
- [ ] Commit signing GPG and SSH configurable; signed commits verify (`git log --show-signature`).
- [ ] Built-in light/dark + follow-OS; custom JSONC themes load from themes folder, hot-reload, report errors, support `var()` and LESS color functions; terminal and Monaco colors follow theme.
- [ ] Keybindings: every command rebindable/unbindable, conflicts flagged, menu accelerators updated, export/import works.
- [ ] Repo-specific: gitflow config read/written to `.git/config`, hooks path, LFS init/track, commit template, encoding applied to file views.
- [ ] Auto-fetch runs at the configured interval with prune per setting.
- [ ] `settings.json` editable in-app with schema validation; corrupt files recovered gracefully.
- [ ] No secret ever written to plain JSON (grep test on userData after e2e run).

## 10. Out of scope / later

- Cloud sync of settings/profiles across machines and organization-enforced settings (spec 14).
- Organization settings (members, teams, licenses).
- Theme marketplace / sharing.
- x509 (gpgsm) signing UI beyond selecting the format.
- Per-profile separate `.gitconfig` files via `includeIf` generation (possible later improvement).

## 11. Cross-spec dependencies

Every setting another spec reads must exist in `settingsRegistry` (§5.2) with the key below. Consumers read settings through `useSetting(key)` (renderer) or `SettingsStore.get(key)` (main) and react to `settings:changed`.

- **Graph (spec 04):** `ui.graphColumns` (default columns; per-repo layout in spec 01 `RepoUiState.graphColumns`), `ui.graphRowHeight` (compact mode), `ui.graphEdgeStyle` (`rounded`/`bezier`, which becomes `LayoutOptions.edgeStyle`), `ui.authorDisplay` + `ui.useGravatar` (avatars vs initials, no network when initials), `ui.graphHoverHighlight`, `general.initialCommitCount` / `general.lazyLoadCommits` / `general.showAllCommits` (spec 02 paging), `graph.order`, `graph.maintainCommitGraph`, `graph.convergenceReuse`.
- **Diff and merge (specs 07, 08):** `diff.defaultView` (Hunk/Inline/Split), `diff.whitespace`, `diff.ignoreBlankLines`, `diff.contextLines`, `diff.renameLimit`, `editor.wordWrap`; external tools `tools.diffTool`, `tools.mergeTool`, `tools.customDiffCmd`, `tools.customMergeCmd`, `tools.mergeToolTrustExitCode`, `tools.mergeToolKeepBackup`, `tools.useExternalMergeToolByDefault`; `general.deleteOrigFiles` (spec 05 §11).
- **Operations and sync (specs 05, 09):** `checkout.autostash`, `checkout.autoPopStash`, `git.pullMode` (`PullStrategy`), `git.pullRebaseMerges`, `git.pushFollowTags`, `git.useCredentialHelpers`, `general.autoFetchInterval`, `general.autoPrune`, repo Git Hooks (`core.hooksPath` via git config), repo LFS section (spec 09 ops), `general.autoUpdateSubmodules` + repo `RepoSettings.autoUpdateSubmodules` ("Keep submodules up to date"), and per profile `ssh.*` (key paths, agent, `windowsAgent`, `useSshConfig`), `network.*` (proxy mode/URL/no-proxy, `useOsCertStore`, `caBundlePath`) and `integrations.<integrationKey>.sshKeyPath`. Switching profile changes SSH/proxy/CA for the next git command; running ops keep their env (spec 09 §6.7).
- **AI (spec 12):** `ai.enabled`, `ai.provider`, `ai.model`, `ai.baseUrl`, `ai.effort`, `ai.maxDiffChars`, `ai.excludeGlobs`, `ai.instructions`, `ai.commitStyle`, `ai.language`; the API key in SecretStore `<profileId>/ai/<provider>`, set from the AI page through main only.
- **Terminal, Git Flow and external apps (spec 12):** `terminal.*` (font, size, line height, cursor, `autocomplete`, `shell`, `shellArgs`, `scrollback`, `shellIntegration`), repo Gitflow section (`GitflowConfig`, git config `gitflow.*`), `tools.editor` / `tools.editorPath`, `tools.terminal` / `tools.terminalCommand`, `tools.agentCommand` / `tools.agentArgs`, `ui.showAgentsToggle`, repo `RepoSettings.agentSetupCommands`.
- **Updates (spec 15):** `app.updateChannel` (`stable`/`preview`) and `app.autoDownloadUpdates` back Preferences › General › Updates.
- **Secrets:** the SecretStore naming in §5.1 is binding for specs 09 (git/proxy/SSH passphrases), 10 (integrations), 12 (AI keys) and 14 (cloud session).
