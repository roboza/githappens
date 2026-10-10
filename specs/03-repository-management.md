# 03 — Repository Management

> Covers: opening, cloning (URL and hosting-provider browse), initializing (local and on a remote provider, with .gitignore/license templates), the Repository Management view, New Tab / welcome screen, recent repos, favorites, repo groups, tab persistence, CLI launch (`githappens <path>`, `-p`), bare repos, shallow & sparse clone.
> Depends on: 01 (tabs, palette), 02 (GitService, OperationQueue, progress), 09 (auth/credentials/SSH), 10 (provider clients), 11 (workspaces), 13 (settings: default branch, clone dir, profiles).

---

## 1. Purpose

Getting a repository into the app is the first thing every user does. GitHappens makes this frictionless: one view lists everything you have open, starred, or recently used; Clone lets you browse your GitHub/GitLab/Bitbucket/Azure repositories instead of copying URLs; Init scaffolds a repo with README, .gitignore and LICENSE and can even create the remote. Repos open as tabs that are remembered between sessions and per profile.

## 2. Reference behavior

- **Entry points**: Repository Management (folder icon at top-left of the tab bar; Cmd+O on mac, Alt+O on Win/Linux per docs), the **New Tab** page (`+` / Ctrl/Cmd+T), **File** menu (Open, Clone, Init), Command Palette (`Repo Management: Open/Clone/Init`, `Open Repo` Ctrl/Cmd+Shift+O), and the command line.
- **Repository Management view**: top action bar with **Browse/Open**, **Clone**, **Init**; below, a list of repositories grouped into **Open** (currently open tabs), **Favorites** (starred), **Recently opened** (added 10.1), plus **Workspaces**. Columns: repo name, remote, branch — resizable and widths persist (12.0). Group headers draggable to reorder; group color changeable via the group's ⋯ menu; default group colors set in UI Customization. Row actions: star (favorite), open in VS Code/IDE, view details (a side panel rendering the README.md), open/close repo tab. A search box filters (New Tab search focus Ctrl/Cmd+Alt+F, 12.4).
- **Favorites**: star icon toggles; favorites shown at top; **Swap to favorite repo #1–9** with Ctrl+Alt+1..9 (Win/Linux), Cmd+1..9 (mac).
- **Open**: pick a folder that is already a git repo (shallow clones open normally). Non-repo folder → prompt to initialize (inferred).
- **Clone**: tabs for **Clone with URL** and per-provider (**GitHub.com, GitHub Enterprise, GitLab.com, GitLab Self-Managed, Bitbucket.org, Bitbucket Data Center, Azure DevOps**). Fields: *Where to clone to* (parent directory, browse), *URL*, *Full path* preview (parent + derived folder name, editable). Provider tab lists the account's repos (searchable, owner/org grouping) after connecting the integration. Clone progress shown; repo opens automatically on completion. Options: **Shallow clone** (branch, depth, since-date, custom flags) and **Sparse checkout** (paths, one per line; optional blobless clone). After clone of LFS repos, `git lfs pull` runs automatically; submodules initialized (inferred: "clone submodules recursively" checkbox).
- **Init**: tabs **Local Only** and per-provider (GitHub, GitLab, Bitbucket, Azure). Local: *Name*, *Initialize in* (parent dir), *Full path*, *.gitignore template* (dropdown with GitHub's templates), *License* (dropdown), *Default branch name* (from Preferences > General; default `main`). Creates `.git`, a `README.md`, optional `.gitignore`/`LICENSE`, makes an initial commit (inferred), then opens it. Provider tab: account, name, description, access (public/private), "Clone after init" with local path; creates the remote repo through the API and clones it.
- **CLI**: `githappens .` or `githappens /path` opens that repo; legacy `githappens -p /path` / `--path` is still accepted. Since Desktop 10/11, the separate `gk` CLI can also launch Desktop (out of scope).
- **Tabs persistence**: Preferences > General "Remember tabs" keeps open tabs between sessions; tabs are stored per profile.
- **Sparse checkout management** for existing repos: Preferences (repo) > Sparse Checkout: Enable/Disable/Reapply; toolbar "Sparse" button when active.
- **Bare repos**: the app can open bare repositories (graph only, no WIP); inferred limited support.

## 3. User stories

1. As a user I want to open a local repository folder and have it appear as a tab.
2. As a user I want to clone by URL with progress and cancel.
3. As a GitHub/GitLab/Bitbucket/Azure user I want to browse and search my remote repos and clone with one click.
4. As a user I want to create a new repo with README, .gitignore template and license, locally or also on my provider.
5. As a user I want a single view of open, favorite, and recent repos, filterable, with quick actions.
6. As a user I want to star repos and jump to them via Ctrl+Alt+1..9.
7. As a user I want my tabs restored when I relaunch (per profile).
8. As a terminal user I want `githappens .` to open the current repo in the running app.
9. As a monorepo user I want shallow and sparse clones.
10. As a user I want a friendly welcome screen on first launch with Open/Clone/Init.

## 4. UI specification

### 4.1 Component tree

```
<RepoManagementView>                     (rendered in a 'repoManagement' or 'newTab' tab, spec 01)
 ├─ <RmHeader>
 │   ├─ <RmSearch/>                      (filters all groups; Ctrl/Cmd+Alt+F focus)
 │   └─ <RmActions> [Browse/Open] [Clone] [Init] [New Workspace]
 ├─ <RmBody>  (split: list | details)
 │   ├─ <RepoGroupList>  (drag-reorderable groups)
 │   │   ├─ <RepoGroup id="open"/>       Open tabs
 │   │   ├─ <RepoGroup id="favorites"/>
 │   │   ├─ <RepoGroup id="recent"/>     Recently opened (max N = 50)
 │   │   ├─ <RepoGroup id="workspace:{id}"/>*   (spec 11)
 │   │   └─ <RepoGroup id="custom:{id}"/>*      user groups (inferred)
 │   │        └─ <RepoRow> ★ · name · remote(owner/repo) · branch · [Open in IDE] [Details] [Open/Close tab] [⋯]
 │   └─ <RepoDetailsPane> path, remotes, current branch, last opened, size (lazy), README render (markdown, sanitized)
 ├─ <OpenRepoDialog/>   (native folder picker + validation)
 ├─ <CloneDialog>
 │   ├─ <CloneSourceTabs> URL | GitHub | GitHub Enterprise | GitLab | GitLab SM | Bitbucket | Bitbucket DC | Azure DevOps
 │   ├─ <CloneUrlForm> url, parentDir, folderName, fullPathPreview
 │   ├─ <ProviderRepoBrowser> account picker, org/owner filter, search, virtualized list (name, visibility, stars, updated)
 │   ├─ <CloneAdvanced> [ ] Shallow (branch, depth, since date, custom flags)  [ ] Sparse (paths textarea, [ ] blobless)
 │   │                  [x] Recurse submodules  [x] Open after clone
 │   └─ <CloneProgress> phases (Counting/Compressing/Receiving/Resolving/Checking out/LFS), %, speed, Cancel
 ├─ <InitDialog>
 │   ├─ <InitTargetTabs> Local only | GitHub | GitLab | Bitbucket | Azure DevOps
 │   ├─ <InitLocalForm> name, parentDir, fullPathPreview, defaultBranch, gitignoreTemplate (searchable), license (searchable),
 │   │                  [x] Create README.md, [x] Make initial commit, [ ] Bare
 │   └─ <InitRemoteForm> account, owner/namespace, name, description, visibility, [x] clone after init → InitLocalForm path
 └─ <WelcomeView> (first run / no tabs): hero, Open/Clone/Init cards, recent list, "Connect integration" CTA, profile setup reminder
```

### 4.2 States
- **Empty** (no recents/favorites): illustration + three big buttons.
- **Loading** provider repo list: skeleton rows; paginated infinite scroll.
- **Error**: provider not connected → "Connect GitHub" button (opens Preferences > Integrations, spec 10/13); auth expired → reconnect.
- **Missing repo** in recents: row greyed with "Not found" badge and actions *Locate…*, *Remove from list*.

### 4.3 Interactions
- Double-click row or Enter = open (activate tab if already open).
- Star toggles favorite; favorites order is drag-reorderable; first 9 get shortcut badges `Ctrl+Alt+1..9`.
- Row context menu: Open, Open in new tab (duplicate/worktree), Open in file manager, Open in terminal, Open in {IDE}, Copy path, Add to/Remove from favorites, Add to workspace ▸, Remove from recents, Rename alias.
- Group ⋯ menu: Change color (palette of 8), Collapse, Rename (custom groups), Delete group (custom).
- Drag a folder from the OS onto the window (anywhere) → open repo (inferred, common UX).
- Clone URL field: paste auto-detects provider and derives folder name (`repo` from `.../repo.git`); `parentDir` defaults to `general.defaultCloneDirectory` (spec 13), else last used.
- Full path preview red if target exists and non-empty → Clone disabled with message.
- Keyboard: Esc closes dialogs; Ctrl/Cmd+Enter submits.

### 4.4 Shortcuts
| Action | Win/Linux | mac |
|---|---|---|
| Repo Management | Alt+O | Cmd+O |
| Open repo via palette | Ctrl+Shift+O | Cmd+Shift+O |
| New tab | Ctrl+T | Cmd+T |
| Favorite repo 1–9 | Ctrl+Alt+1..9 | Cmd+Option+1..9 (see 01 §4.9) |
| Focus RM search | Ctrl+Alt+F | Cmd+Option+F |

## 5. Data model & IPC

```ts
// shared/repos.ts
export interface RepoRecord {
  path: string;               // normalized absolute path (realpath, forward slashes internally, case-preserving)
  name: string;               // folder name
  alias?: string;
  isBare: boolean;
  commonDir?: string;         // for worktrees
  remoteUrl?: string;         // primary remote (origin or first)
  provider?: ProviderId;      // derived from remoteUrl
  lastOpenedAt?: number;
  lastBranch?: string;
  favorite: boolean;
  favoriteOrder?: number;
  groupIds: string[];
  missing?: boolean;
}
export type ProviderId = ProviderKind;   // spec 10 §5.1: 'github'|'gitlab'|'bitbucket'|'bitbucket-dc'|'azure-devops' (GHE / GitLab SM distinguished by host)

export interface RepoGroup { id: string; kind: 'open'|'favorites'|'recent'|'workspace'|'custom'; name: string;
  color?: string; collapsed: boolean; order: number; }

export interface RepoRegistryFile {      // userData/profiles/<profileId>/repos.json
  version: 1; repos: RepoRecord[]; groups: RepoGroup[]; columnWidths: { name: number; remote: number; branch: number };
}

export interface CloneRequest {
  url: string; parentDir: string; folderName: string;
  provider?: ProviderId; accountId?: string;     // for credential injection
  shallow?: { branch?: string; depth?: number; sinceDate?: string; customFlags?: string };
  sparse?: { paths: string[]; blobless: boolean };
  recurseSubmodules: boolean; openAfter: boolean; bare?: boolean;
}
export interface CloneProgress { opId: string; phase: 'counting'|'compressing'|'receiving'|'resolving'|'checkout'|'submodules'|'lfs'|'done';
  percent?: number; transferred?: string; speed?: string; message?: string; }

export interface InitRequest {
  parentDir: string; name: string; defaultBranch: string;
  gitignoreTemplates: string[];  // may combine several
  license?: { spdxId: string; author: string; year: number };
  createReadme: boolean; initialCommit: boolean; bare: boolean;
  remote?: { provider: ProviderId; accountId: string; owner: string; name: string; description?: string;
             visibility: 'public'|'private'|'internal' };
}

export interface ProviderRepoSummary { id: string; fullName: string; owner: string; name: string; description?: string;
  private: boolean; fork: boolean; defaultBranch: string; cloneUrlHttps: string; cloneUrlSsh: string; updatedAt: string; stars?: number; }

export interface OpenRepoResult { ok: true; repo: RepoRecord } | { ok: false; reason: 'notFound'|'notARepo'|'permission'|'unsafeDirectory'; path: string };
```

**IPC channels**

| Channel | Payload → Result |
|---|---|
| `repos:list` | → `RepoRegistryFile` |
| `repos:validate` | `{path}` → `OpenRepoResult` (does not add) |
| `repos:open` | `{path, newTab?: boolean}` → `OpenRepoResult` (adds to recents; calls spec 02 `git:repo:open`, which creates the `GitService`/`RepoWatcher`/`OperationQueue` and returns `RepoInfo` with the `RepoId` used by every `git:*` channel) |
| `repos:close` | `{path}` → void (disposes watcher/queue if no other tab uses it) |
| `repos:setFavorite` | `{path, favorite, order?}` |
| `repos:reorderFavorites` | `{paths: string[]}` |
| `repos:removeRecent` | `{path}` |
| `repos:setAlias` | `{path, alias?}` |
| `repos:groups:save` | `{groups: RepoGroup[]}` |
| `repos:details` | `{path}` → `{remotes, branch, readmeMarkdown?, sizeBytes?}` |
| `repos:pickFolder` | → `string \| null` (`dialog.showOpenDialog({properties:['openDirectory','createDirectory']})`) |
| `repos:clone` | `CloneRequest` → `{opId}`; events `repos:cloneProgress` (evt) `CloneProgress`, completion via `git:op:state` (spec 02) |
| `repos:cancel` | `{opId}` |
| `repos:init` | `InitRequest` → `OpenRepoResult` |
| `templates:gitignore:list` | → `string[]` (bundled) |
| `templates:gitignore:get` | `{names: string[]}` → `string` (concatenated with `### name ###` headers) |
| `templates:license:list` | → `{spdxId, name}[]` |
| `templates:license:render` | `{spdxId, author, year}` → string |
| `providers:repos:list` | `{provider, accountId, query?, owner?, page}` → `{items: ProviderRepoSummary[], nextPage?}` (spec 10) |
| `providers:repos:create` | `{provider, accountId, owner, name, description, visibility}` → `ProviderRepoSummary` |
| `app:openRepoRequest` (evt) | `{path}` from CLI/second-instance/drop |

**Storage**: `userData/profiles/<profileId>/repos.json` (registry), `userData/profiles/<profileId>/tabs.json` (spec 01 `TabsState`), `userData/profiles/<profileId>/repo-ui/<sha1(path)>.json` (per-repo UI state). Bundled templates under `resources/templates/gitignore/*.gitignore` (from github/gitignore, CC0) and `resources/templates/licenses/*.txt` (SPDX/choosealicense data, MIT-licensed) with `{{year}}`, `{{fullname}}` placeholders.

## 6. Git implementation

**Validate/open**
```
git -C <path> rev-parse --is-inside-work-tree --is-bare-repository --show-toplevel --git-dir --git-common-dir
```
- Exit ≠0 → `notARepo` (offer Init). Output `true` for bare → `isBare`. Normalize to `--show-toplevel` (user may pick a subfolder; open the toplevel).
- stderr contains `detected dubious ownership` → `unsafeDirectory`: dialog offering `git config --global --add safe.directory <path>` (requires explicit consent).
- Primary remote: `git -C <path> remote -v` → prefer `origin`, else first fetch URL.
- Current branch: `git symbolic-ref --quiet --short HEAD` (fallback `rev-parse --short HEAD`).

**Clone**
```
git clone --progress [--recurse-submodules] [--depth <n>] [--shallow-since=<date>] [--branch <b> --single-branch]
          [--filter=blob:none] [--sparse] [--no-checkout] [--bare] [<custom flags>] -- <url> <fullPath>
```
- Progress parsed from stderr lines (`\r`-separated): regex `^(Counting|Compressing|Receiving|Resolving) objects:\s+(\d+)%` and `Updating files:\s+(\d+)%`; Receiving line also contains `| 12.34 MiB | 3.21 MiB/s`.
- Sparse: after `git clone --filter=blob:none --sparse <url> <path>` (blobless optional; `--sparse` initializes cone mode with root files only) run `git -C <path> sparse-checkout set --cone -- <paths...>` (non-cone if any path contains glob characters: `sparse-checkout set --no-cone`).
- Shallow custom flags parsed with a shell-words tokenizer; reject flags `--upload-pack`, `-u`, `--config core.sshCommand` etc. (security: no arbitrary command execution) — allowlist: `--depth, --shallow-since, --shallow-exclude, --single-branch, --no-single-branch, --no-tags, --filter, --origin, --jobs, --reference, --dissociate`.
- LFS: if `.gitattributes` contains `filter=lfs` and `git lfs version` succeeds → `git -C <path> lfs pull` (progress phase `lfs`).
- Credentials: HTTPS via our askpass helper (`GIT_ASKPASS`, spec 09) using provider token when cloning from provider tab; SSH via `GIT_SSH_COMMAND` from SSH prefs (spec 13).
- Env: the spec 02 §6.1 per-invocation policy (`GIT_TERMINAL_PROMPT=0`, English `LC_MESSAGES`, UTF-8 locale kept for paths).
- Cancel: kill process tree, then delete the partially created target directory **only if it did not exist before clone** and we created it.

**Init (local)**
```
git init [--bare] --initial-branch=<defaultBranch> <fullPath>      (always available: minimum git is 2.36)
write README.md ("# <name>\n"), .gitignore (template concat), LICENSE (rendered)
git -C <path> add README.md .gitignore LICENSE
git -C <path> commit -m "Initial commit"                            (respects signing prefs, spec 06)
```
- If folder exists & is non-empty but not a repo: allowed ("reinitialize"/init in existing folder); do not overwrite existing README/.gitignore/LICENSE — append to .gitignore with a confirmation (inferred).
- If folder already a repo: `git init` re-init is harmless; warn "Already a repository — open instead?".

**Init (remote)**: call provider API to create repo (spec 10: GitHub `POST /user/repos` or `/orgs/{org}/repos`, GitLab `POST /projects`, Bitbucket `POST /repositories/{workspace}/{slug}`, Azure `POST {org}/{project}/_apis/git/repositories`), passing `auto_init` false; then local init as above, `git remote add origin <cloneUrl>`, `git push -u origin <defaultBranch>`. Alternatively when user chose "clone after init" with provider auto-init: create with README server-side and clone (inferred variant).

**Bare repo**: `git clone --bare` and opening bare repos supported; WIP/staging disabled; graph uses `git --git-dir=<path> log`.

**Repo details**: README → first of `README.md|README|readme.md` via `git show HEAD:<file>` for bare, file read otherwise; size via `git count-objects -vH` (lazy).

## 7. Step-by-step implementation plan

1. **RepoRegistry service (main)**: load/save `repos.json` per profile with atomic writes (write temp + rename), schema version + migration. Unit tests for add/recents ordering (MRU, cap 50), favorites, groups.
2. **Path normalization util**: `realpath`, case-insensitive compare on Windows/macOS (default APFS), strip trailing separators, convert `\\?\` long paths. Tests with unicode NFC/NFD (macOS returns NFD).
3. **`repos:validate` / `repos:open`**: rev-parse probe, dubious-ownership handling, register recents, emit `app:openRepoRequest` handling in renderer → creates/activates tab (spec 01).
4. **Single-instance + CLI**: `app.requestSingleInstanceLock()`; parse argv in first instance and in `second-instance` event: accept `<path>`, `.`, `-p <path>`, `--path <path>`, `--path=<path>`; resolve relative to the second instance's `workingDirectory`. macOS: `open-file` event and dock drop. Install shell command (spec 15 §6.4): Windows installer adds `githappens.cmd` to PATH; mac Help → "Install command line tool" symlinks `/usr/local/bin/githappens`. Tests: argv parser unit tests.
5. **Tab persistence**: save `tabs.json` on change (debounced); on startup if `general.rememberTabs` restore tabs whose paths validate; missing → tab in missing state.
6. **RepoManagementView UI** with groups, search (fuzzy on name/path/remote), favorites star, drag reorder (dnd-kit), group colors, column resize persistence, details pane (README rendered with `markdown-it` + DOMPurify, links open externally).
7. **WelcomeView** for first run (no tabs) reusing RM components.
8. **Open dialog** + drag-and-drop folders onto window.
9. **Clone service**: argument builder (pure, unit-tested), progress parser (unit-tested with captured stderr fixtures), cancel/cleanup, LFS pull, sparse setup; register in OperationQueue as a global (non-repo) op.
10. **CloneDialog URL tab**: URL parsing (https, ssh `git@host:owner/repo.git`, `ssh://`, `file://`, local path) → derive folder name; provider detection by host.
11. **Provider browse tab**: list connected accounts (spec 10); TanStack Query infinite list keyed `['providerRepos', provider, accountId, query, owner]`; selecting fills URL (HTTPS or SSH based on `ssh.preferSshForProviders` setting, inferred).
12. **Templates**: build script vendors github/gitignore and SPDX license texts into `resources/templates`, generating an index JSON.
13. **Init service** local path + InitDialog local tab.
14. **Init remote**: provider create API + push; error rollback (if push fails, keep local repo, show toast with retry).
15. **Favorites shortcuts** Ctrl+Alt+1..9 registered in command registry (spec 01).
16. **Recent repos in menus**: File → Open Recent, Windows JumpList (`app.setJumpList`) and macOS `app.addRecentDocument`.
17. **Sparse checkout management** (repo prefs page + toolbar Sparse button): `sparse-checkout list|set|disable|reapply`.
18. **E2E**: clone local bare fixture via `file://`, init with templates, reopen app → tabs restored, CLI second-instance opens tab.

## 8. Edge cases

- Target directory exists and non-empty → block clone; exists and empty → allowed.
- Clone URL with embedded credentials (`https://user:token@host`) → strip before saving to recents/remote display; warn user (inferred).
- Clone into a path inside another repo → allowed but warn (nested repo; suggest submodule).
- Network failure / auth failure mid-clone → error toast with stderr, cleanup partial dir, "Retry" action pre-fills dialog.
- Very large clones: progress throttled to 10 Hz; allow minimize; OS notification on completion.
- Windows paths > 260 chars → set `core.longpaths=true` per-clone via `-c core.longpaths=true` when the Windows `core.longpaths` setting (spec 13 General) is enabled.
- Unicode/space-containing paths: always pass args array (no shell); NFC normalize for comparisons.
- Opening a subdirectory → resolve to toplevel; opening `.git` dir itself → resolve to parent worktree.
- Opening a worktree → `commonDir` differs; tab grouped with main repo (spec 01); opening same worktree twice focuses tab.
- Bare repo → no WIP/staging; Repo Management shows "bare" badge.
- Submodule folder opened directly → it's a repo; works standalone (`.git` is a file pointing to `gitdir:`).
- Empty repo (just `git init`) → graph empty with only WIP; branch name from unborn HEAD.
- Dubious ownership (CVE-2022-24765 safe.directory) → explicit consent dialog.
- Recents pointing to removed USB/network drive → mark missing lazily (async `fs.stat` with 2 s timeout) instead of blocking UI.
- Provider token expired during browse → 401 → reconnect prompt.
- `githappens -p` with nonexistent path → toast "Path not found" and show Repo Management.
- Two profiles: recents/favorites/tabs are per-profile; switching profile swaps all (spec 13).
- Git older than the supported minimum (2.36, spec 00) is rejected by spec 02, so `--initial-branch` and `sparse-checkout` are always available; no fallback path is needed.

## 9. Acceptance criteria

- [ ] Open a repo via button, drag-drop, palette, menu, and CLI (`app .`, `app /p`, `app -p /p`, `--path=/p`) — existing instance receives it and focuses/creates the tab.
- [ ] Clone by URL (HTTPS/SSH/file) with live progress, cancel, cleanup, auto-open.
- [ ] Clone from GitHub/GitLab/Bitbucket/Azure tab lists, searches and paginates the user's repos once integration connected.
- [ ] Shallow (depth/since/branch/custom allowlisted flags) and sparse (paths, blobless) clones produce the expected repo state (`git rev-parse --is-shallow-repository`, `git sparse-checkout list`).
- [ ] Init creates repo with chosen default branch, README, combined .gitignore templates, rendered LICENSE, initial commit; remote init creates provider repo and pushes.
- [ ] Repository Management shows Open/Favorites/Recent/Workspace groups, search, star toggle, group reorder & color, resizable persisted columns, README details pane.
- [ ] Favorites 1–9 switch with keyboard.
- [ ] Tabs restored on restart per profile when Remember Tabs is on; missing repos handled gracefully.
- [ ] Bare repos and worktrees open correctly.
- [ ] Dubious-ownership repos prompt before modifying global config.

## 10. Out of scope / later

- Workspaces (multi-repo groups with bulk clone/fetch) — spec 11.
- Cloud-synced favorites/recents across machines — spec 14.
- `gk` standalone CLI integration.
- Clone of Perforce/SVN repos.
- Repo size analytics / "Perform Repo Maintenance" scheduling beyond the palette command.
