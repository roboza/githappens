# 09 — Remotes & Sync (Remotes, Fetch/Pull/Push, Auth, SSH, LFS, Submodules, Worktrees, Proxy, Hooks)

> Builds on `02-git-engine.md`: all commands go through `GitService` / `OperationQueue`, all errors use the `GitErrorCode` taxonomy, all prompts use the askpass bridge (§02-6.3), and all progress uses `git:progress`. Operations are added as variants of the `GitOperation` union (§02-5.5). Integration tokens and provider APIs come from spec 10. Profile-scoped settings come from spec 13.

---

## 1. Purpose

Sync is where Git GUIs earn trust. Users need to see at a glance how their branches relate to the server (ahead/behind), sync in one click with predictable semantics, and authenticate without fighting credential prompts. GitHappens wraps remotes, fetch/pull/push, HTTPS/SSH auth, LFS, submodules, and worktrees in left-panel sections and toolbar buttons. This spec covers all of that, plus hooks, which most commonly surface during commit and push.

## 2. Reference behavior

**Remotes**
- The Left Panel has a **REMOTE** section listing each remote, with its remote branches nested beneath (folders for `/` in names). Hovering the header shows a **+** button that opens **Add Remote**.
- The Add Remote dialog has a **URL** tab (name + pull URL + optional push URL) and provider tabs (GitHub, GitLab, Bitbucket, plus Azure when connected). Provider tabs list **forks** of the current repo, and picking one fills name and URL. Provider dropdowns only show forks; any other remote uses the URL tab.
- For shallow clones, Add Remote offers depth, since-date, and custom fetch flag options so the new remote's fetch matches the clone's constraints.
- Remote context menu (inferred from UI): Fetch, Edit remote (name/URLs), Remove remote, Copy remote URL, Hide/Show, Solo, Open on provider.
- Remote avatars (provider owner avatar) appear next to the remote name when an integration is connected (inferred).

**Fetch / Pull / Push**
- Toolbar has **Pull** (with dropdown) and **Push** buttons. The Pull dropdown includes **Fetch All** and the pull strategy choices:
  - **Fast-forward if possible**: fast-forward when possible, otherwise merge.
  - **Fast-forward only**: if a fast-forward is impossible, nothing happens.
  - **Rebase**: replay local commits on top of the fetched upstream.
  - The chosen option becomes the default (the dropdown remembers it).
- **Auto-fetch** runs every 1 minute by default. Preferences > General sets the interval from 0 to 60 minutes, and 0 disables it. **Auto-Prune** removes stale remote-tracking refs during fetch.
- After a fetch, the Left Panel shows **ahead/behind counts** next to local branches with an upstream (↑n ↓m).
- **Push**: if the branch has no remote counterpart, the app asks which remote and branch name to push to, then sets the upstream. A branch can be dragged onto a remote branch in the graph or left panel to push to it.
- If a push is rejected as non-fast-forward, the app offers **Force Push** with a warning (inferred: implemented as a lease-protected force).
- **Set upstream** is available from the branch context menu ("Set Upstream").
- Non-checked-out branches can be fast-forwarded to their upstream from the context menu (inferred, "Fast-forward" item).

**Auth & SSH**
- Preferences > SSH: browse to an existing private/public key **or generate** a new pair. **Use local SSH agent** checkbox. On Windows only Pageant is supported as the agent. `.ssh/config` host aliases are not supported.
- Integrations can **generate an SSH key and add it to the provider** in one click (GitHub, GitLab, Bitbucket, Azure). Per-provider keys override the default key unless the local agent is used.
- Multiple accounts on one provider require multiple **profiles**. Each profile has its own integrations and keys.
- HTTPS uses username/password or token. Preferences > General has **Forget All Credentials**.
- Proxy: Windows uses system proxy auth prompts. macOS/Linux prompt inside the app. Linux can be launched with `--proxy-server=host:port`.

**Git LFS**
- Requires git ≥ 2.39.3 and git-lfs ≥ 3.0 on PATH. The LFS section disappears when they are not found.
- **Initialize LFS** from Preferences > LFS, the new-repo dialog ("Initialize with LFS"), or menu > LFS > Initialize.
- Track patterns via Preferences > LFS, right-click a WIP file > **LFS > Track file pattern** (e.g. `*.psd`), or by editing `.gitattributes`. New patterns only affect files added afterwards.
- The toolbar shows an **LFS** menu (pull, prune, …) for LFS repos. LFS pull runs automatically after clone and after submodule init.
- Tracked files show an **LFS** tag in the commit panel. Diffs show pointer metadata (oid, size, URL).
- Our lock/unlock support for LFS file locking is an **extension** (inferred optional).

**Submodules**
- **Submodules** left-panel section is hidden by default. Users enable it via right-click on any section header.
- **+** → Add submodule (URL + path). This updates `.gitmodules` and records the gitlink.
- After cloning a parent with submodules, the app prompts to initialize them. Uninitialized ones can be initialized from the context menu.
- Context menu: Open, Update, Edit, Delete. **Update** brings the submodule to the commit it should be at.
- To change the pointer: open the submodule (as a nested view), check out another commit, then exit back to the parent. The app prompts to commit the new pointer.
- Status indicators: **out of sync** (pointer changed), **not initialized**, **added but not committed**.
- **Keep submodules up to date** preference (global in General, per-repo in Submodules) auto-updates after git actions.

**Worktrees**
- Branch context menu **Create worktree**. New worktrees inherit hidden/soloed refs and collapsed folders.
- Left-panel **Worktrees** section: **Open this worktree** (current tab), **Open worktree in a new tab**, **Lock/Unlock**, **Remove this worktree**, **Remove worktree and delete branch**. Folder name is shown under the branch when they differ. Hover shows the full path. Search matches folder or branch.
- The graph shows a **WIP node per worktree** with pending changes, and you can open the worktree from it.

**Hooks**
- Hooks run from `.git/hooks`, a per-repo custom path (Preferences > Git Hooks), or global `core.hooksPath`. Any non-zero exit blocks the action and shows an error notification. Hooks must be executable on macOS/Linux (exit 126 otherwise). A "skip hooks" option exists for commits.
- `pre-push` runs for push branch, push tag, delete remote branch, and delete remote tag.
- macOS GUI apps don't inherit shell env, so hooks relying on shell vars can fail. Our shell-env resolution (§02-6.1) fixes this.

## 3. User stories

1. As a user, I want to add a remote by picking a teammate's fork from a list, so that I don't have to copy URLs.
2. As a user, I want the app to auto-fetch quietly and show ↑/↓ counts, so that I know when I'm behind without fetching manually.
3. As a user, I want one Pull button whose behavior (ff-if-possible / ff-only / rebase) I choose once.
4. As a user pushing a new branch, I want to be asked once for remote + name and have tracking set automatically.
5. As a user whose push was rejected, I want a safe force push that won't clobber commits I haven't seen.
6. As a user, I want HTTPS auth to just work using my connected GitHub/GitLab account, and SSH to use my agent or a key the app generated and uploaded.
7. As a game developer, I want LFS init/track/pull/lock from the UI and pointer info in diffs.
8. As a user of submodules, I want to see which are out of sync, update them, and open one as its own tab.
9. As a user running parallel work or coding agents, I want to create, open, lock, and remove worktrees from the left panel, and see each worktree's WIP in the graph.
10. As a corporate user, I want proxy settings honored by git and by provider APIs.
11. As a user with husky hooks, I want to see the hook's output when it fails, and optionally skip hooks.

## 4. UI specification

### 4.1 Left panel sections (spec 01 owns the container)
- **REMOTE**: header with count and **+** (Add Remote). Each remote row shows provider icon/avatar, name, and a hover **⟳** (fetch this remote). Child tree lists remote branches (folders by `/`). `refs/remotes/<r>/HEAD` is hidden. Gone upstreams are not listed here.
  - Row context menu: Fetch `<remote>`, Edit remote…, Copy URL, Open on `<provider>`, Hide, Solo, Remove remote….
  - Remote branch context menu: Checkout (creates tracking local), Pull (fast-forward) into current, Create branch here, Delete `<r>/<b>` (pushes delete), Copy name, Open PR (spec 10).
- **LOCAL** branch rows (spec 05 owns the section): right-aligned **↑n ↓m** badges when ahead/behind is non-zero. A cloud icon means the upstream is set. The badge is a **struck cloud** when the upstream is gone (`[gone]`).
- **SUBMODULES** (hidden by default; enable via header context menu): rows with name, short sha, and state icon (● in sync, ↻ out of sync, ○ not initialized, + added-uncommitted, ⚠ conflict). Menu: Open, Open in new tab, Initialize, Update, Update to latest remote, Edit URL…, Copy path, Delete….
- **WORKTREES**: rows with branch name (or `detached @ abc123`), folder name subtitle when it differs, 🔒 if locked, ⚠ if prunable, and a "current" marker. Menu: Open this worktree, Open worktree in a new tab, Reveal in file manager, Open in terminal, Lock/Unlock…, Remove this worktree…, Remove worktree and delete branch…, Prune stale worktrees (header menu).

### 4.2 Toolbar
- **Pull ▾**: button runs the default strategy. The dropdown has: Fetch All, Fast-forward if possible, Fast-forward only, Rebase, "Set as default" radio. The button shows a ↓n badge for the current branch (inferred).
- **Push**: shows a ↑n badge (inferred). Disabled with tooltip when HEAD is detached.
- **LFS ▾** (only when the repo uses LFS): Pull, Fetch, Push all, Prune…, Locks…, Track pattern…, Untrack….
- Progress bar and Cancel come from spec 02 §4.

### 4.3 Dialogs
- **Add/Edit Remote**: tabs `URL | GitHub | GitLab | Bitbucket | Azure DevOps` (only connected providers enabled, others show "Connect…"). The URL tab has fields Name (required, valid refname component), Pull URL (required), Push URL (optional, "same as pull" default). Shallow-repo extras: Depth (number), Since date, Custom fetch flags (text, validated against an allowlist). Provider tabs have a search box and a fork list (owner avatar, `owner/repo`, HTTPS/SSH toggle following the Preferences protocol default). Picking one fills Name with the owner login. Buttons: **Add Remote** / **Save**. After adding, the remote is fetched automatically (inferred).
- **Push target prompt** (no upstream): "Push `feature/x` to:" Remote dropdown (default `origin` or the only remote) + branch name text (default local name) + checkbox "Set as upstream" (checked, inferred), with **Submit** / **Cancel**.
- **Force push confirm**: "`origin/main` has commits you don't have. Force pushing will overwrite them." Shows the remote commits that would be lost (list from `git log <local>..<remote>`), with **Force Push** (danger) / **Cancel** / **Pull instead**.
- **Credential prompt**: host, username (prefilled), password/token, "Remember" checkbox, link "Connect <Provider> integration instead".
- **SSH passphrase prompt**: key path, passphrase, "Remember in system keychain".
- **Host key prompt**: "The authenticity of host `github.com` can't be established. ED25519 fingerprint SHA256:…" → **Trust & Continue** / **Cancel**. Known GitHub/GitLab/Bitbucket fingerprints are shown with a "verified" badge (we ship the published fingerprints).
- **Add Submodule**: URL, Path (relative, inside repo), optional Branch, "Initialize & update recursively" (checked).
- **Create Worktree**: Branch (existing, or new name + start point), Path (default `<repoParent>/<repoName>.worktrees/<branchSlug>`, inferred; editable with folder picker), "Open after create": current tab / new tab / don't open.
- **Remove Worktree**: shows a dirty-files warning when status is not clean → "Force remove (discard changes)" checkbox. For the "and delete branch" variant, warns when the branch is not merged and offers force delete.
- **Hook output**: when a hook fails, an error toast "pre-commit hook failed (exit 1)" with **View output**. This opens a modal with monospaced, ANSI-colored output (strip or render ANSI via `ansi-to-html`) and buttons **Retry**, **Retry without hooks** (commit/push only), **Close**.

### 4.4 Preferences (owned by spec 13; fields defined here)
- **General**: Auto-fetch interval (0–60 min, default 1), Auto-prune (default on, inferred), Keep submodules up to date, Default pull strategy, Forget all credentials, Push: "Push tags with branches (`--follow-tags`)" (default off).
- **SSH** (per profile): Use local SSH agent, Private key path, Public key path, Generate new key…, Copy public key. Per-integration keys under each integration.
- **Network/Proxy**: Proxy mode (System / Manual / None), Manual URL `http://host:port`, No-proxy list, Proxy auth (stored in keychain), "Use OS certificate store" (Windows: `http.sslBackend=schannel`; macOS: secure-transport n/a, inferred), Custom CA bundle path.
- **Repo-specific**: LFS (initialize, patterns list with add/remove), Git Hooks (custom hooks path), Submodules (keep up to date override).

## 5. Data model & IPC

```ts
// ---- operations (added to GitOperation union, spec 02 §5.5) ----
export type SyncOperation =
  | { type: 'remote.add'; name: string; fetchUrl: string; pushUrl?: string; fetchAfter?: boolean; shallow?: { depth?: number; since?: string; extraArgs?: string[] } }
  | { type: 'remote.edit'; name: string; newName?: string; fetchUrl?: string; pushUrl?: string | null }
  | { type: 'remote.remove'; name: string }
  | { type: 'fetch'; remote: string | 'all'; prune?: boolean; background?: boolean; refspecs?: string[] }
  | { type: 'pull'; strategy: PullStrategy; remote?: string; branch?: string; autostash?: boolean }
  | { type: 'fastForwardBranch'; localBranch: string; upstream: string }      // non-checked-out
  | { type: 'push'; localRef: string; remote: string; remoteBranch: string; setUpstream?: boolean; force?: 'lease' | 'none'; expectedRemoteSha?: Sha | null; followTags?: boolean; noVerify?: boolean }
  | { type: 'push.tags'; remote: string; tags: string[] | 'all'; noVerify?: boolean }
  | { type: 'push.delete'; remote: string; refs: string[] }               // remote branch or tag
  | { type: 'branch.setUpstream'; localBranch: string; upstream: string | null }
  | { type: 'lfs.install' } | { type: 'lfs.track'; patterns: string[] } | { type: 'lfs.untrack'; patterns: string[] }
  | { type: 'lfs.pull'; remote?: string; include?: string[] } | { type: 'lfs.fetch'; all?: boolean }
  | { type: 'lfs.push'; remote: string; all?: boolean } | { type: 'lfs.prune'; dryRun?: boolean }
  | { type: 'lfs.lock'; path: string } | { type: 'lfs.unlock'; path: string; force?: boolean }
  | { type: 'submodule.add'; url: string; path: string; branch?: string; recursive?: boolean }
  | { type: 'submodule.update'; paths?: string[]; init?: boolean; recursive?: boolean; remote?: boolean }
  | { type: 'submodule.setUrl'; path: string; url: string }
  | { type: 'submodule.remove'; path: string }
  | { type: 'worktree.add'; path: string; branch?: string; newBranch?: string; startPoint?: string; detach?: boolean }
  | { type: 'worktree.remove'; path: string; force?: boolean; deleteBranch?: 'no' | 'safe' | 'force' }
  | { type: 'worktree.lock'; path: string; reason?: string } | { type: 'worktree.unlock'; path: string }
  | { type: 'worktree.prune' };

export type PullStrategy = 'ff-if-possible' | 'ff-only' | 'rebase' | 'merge-no-ff';  // last one inferred extra

export interface PushResult {
  updates: Array<{ flag: ' ' | '+' | '-' | '*' | '!' | '='; from: string; to: string; summary: string; reason?: string }>;
  remoteMessages: string[];            // "remote: Create a pull request for 'x' on GitHub by visiting: ..."
  prUrlHint?: string;                  // parsed from remote messages
}
export interface FetchResult { remotes: string[]; updatedRefs: Array<{ flag: string; ref: string; old?: Sha; new?: Sha }>; pruned: string[]; }

// ---- credentials ----
export interface CredentialContext { repoId?: RepoId; remoteUrl?: string; profileId: string; nonInteractive?: boolean; }
export interface StoredCredential { host: string; username: string; /* secret only in keychain */ source: 'prompt' | 'integration'; }

export interface SshSettings {          // per profile (spec 13)
  useLocalAgent: boolean;
  privateKeyPath?: string; publicKeyPath?: string;
  windowsAgent?: 'openssh' | 'pageant';     // 'pageant' parity, 'openssh' our extension
  providerKeys?: Partial<Record<ProviderId, { privateKeyPath: string; publicKeyPath: string }>>;
}
export interface ProxySettings { mode: 'system' | 'manual' | 'none'; url?: string; noProxy?: string[]; useOsCertStore?: boolean; caBundlePath?: string; }

export interface LfsStatus {
  available: boolean; version?: string;
  repoUsesLfs: boolean; installed: boolean;   // hooks installed (.git/hooks/pre-push contains git-lfs)
  patterns: Array<{ pattern: string; file: string; lockable: boolean }>;
  lockingSupported?: boolean;
}
export interface LfsLock { id: string; path: string; owner: string; lockedAt: string; ours: boolean; }
export interface LfsFileInfo { path: string; oid: string; size?: number; downloaded: boolean; }
```

**IPC channels** (read channels are added to `GitIpcContract`, writes go via `git:op:run`):

| Channel | Request | Response |
|---|---|---|
| `git:remotes` (spec 02) | `{repoId}` | `RemoteInfo[]` |
| `git:remote:forks` | `{repoId, provider: ProviderId}` | `Array<{owner, name, cloneUrlHttps, cloneUrlSsh, avatarUrl}>` (delegates to ProviderService, spec 10) |
| `git:aheadBehind` | `{repoId, pairs: Array<[string,string]>}` | `Array<{ahead, behind}>` |
| `git:push:preview` | `{repoId, localRef, remote, remoteBranch}` | `{remoteSha: Sha\|null, wouldLose: CommitSummary[], isFastForward: boolean}` |
| `git:lfs:status` | `{repoId}` | `LfsStatus` |
| `git:lfs:files` | `{repoId, ref?}` | `LfsFileInfo[]` |
| `git:lfs:locks` | `{repoId}` | `LfsLock[]` |
| `ssh:settings:get` / `ssh:settings:set` | `{profileId}` / `{profileId, settings}` | `SshSettings` |
| `ssh:key:generate` | `{profileId, type: 'ed25519'\|'rsa-4096', comment, passphrase?, path?}` | `{privateKeyPath, publicKeyPath, publicKey, fingerprint}` |
| `ssh:key:addToProvider` | `{profileId, provider, publicKey, title}` | `{ok: true}` (spec 10 implements the API) |
| `ssh:key:publicKey` | `{path}` | `{publicKey, fingerprint}` |
| `cred:forgetAll` | `{profileId}` | `void` |
| `cred:list` | `{profileId}` | `StoredCredential[]` |
| `proxy:settings:get` / `proxy:settings:set` | … | `ProxySettings` |
| (settings) | spec 13 `settings:set` for `general.autoFetchInterval` / `general.autoPrune` | the scheduler subscribes to `settings:changed` |
| Events: `sync:autoFetch:state` | `{repoId, lastFetchAt, nextFetchAt, lastError?}` | |

## 6. Git implementation

### 6.1 Remotes
- **Add**: `git remote add -- <name> <url>`. Then, if a push URL is given: `git remote set-url --push -- <name> <pushUrl>`. Then, if `fetchAfter` (default true): queue `fetch` for that remote.
  - Shallow repo (`isShallow`): fetch with `--depth=<n>` / `--shallow-since=<date>` / allowed extra flags (`--no-tags`, `--single-branch`, `--filter=<spec>`).
- **Edit**: rename first, `git remote rename -- <old> <new>`, which rewrites refspecs and moves remote-tracking refs and branch upstream config. Then `git remote set-url -- <name> <url>`. Push URL: `git remote set-url --push -- <name> <url>`, or remove with `git config --unset-all remote.<name>.pushurl`.
- **Remove**: `git remote remove -- <name>`. This deletes remote-tracking refs and unsets upstream config of branches tracking it. Confirm first, listing affected tracking branches (from refs with `upstream` under `refs/remotes/<name>/`).
- **Name validation**: `git check-ref-format "refs/remotes/<name>/x"` exit 0, no `/`-leading, not already used.
- **URL normalization** for provider detection (spec 10): parse `https://host/owner/repo(.git)`, `ssh://git@host[:port]/owner/repo`, `git@host:owner/repo.git`. Azure: `https://dev.azure.com/org/project/_git/repo`, `git@ssh.dev.azure.com:v3/org/project/repo`.
- **Fork list**: ProviderService `listForks(owner, repo)` on the parent (if the current origin is itself a fork, include the parent too, inferred). Exclude forks already added (match by normalized URL).

### 6.2 Fetch
- Manual "Fetch All": `git fetch --all --progress [--prune]`. This uses `fetch.prune`/`remote.<r>.prune` if set. Our Auto-Prune setting passes `--prune` explicitly. Do **not** use `--prune-tags`, which deletes local tags.
- Single remote: `git fetch --progress [--prune] -- <remote>`.
- Parse updated refs with `--porcelain` (git ≥ 2.41; lines `<flag> <old> <new> <ref>`). Otherwise parse the stderr summary lines (` + abc..def  main -> origin/main (forced update)`, ` * [new branch] x -> origin/x`, ` - [deleted] (none) -> origin/y`). The result drives "N new commits on origin/main" toasts (inferred: auto-fetch is silent, so we toast only on manual fetch).
- After fetch: refresh scopes `refs`, `graph` (watcher also fires via FETCH_HEAD/refs).
- **Auto-fetch scheduler** (main process, per open repo):
  1. Interval from settings (minutes, 0 = off). The timer starts when the repo opens. The first auto-fetch runs 10 s after open (inferred).
  2. Skip a tick when the repo has a running/queued mutating op, the app is offline (`net.isOnline()`), or the repo has no remotes.
  3. Background tabs fetch at `max(interval, 5 min)` (our throttling, inferred).
  4. Runs `fetch --all` with `background: true` → `nonInteractive` credentials. On `AuthenticationFailed`/`HostKeyVerificationFailed`/`PermissionDenied`, auto-fetch **pauses** for that repo and shows a non-modal warning badge on the Pull button ("Auto-fetch paused: authentication required"). A successful manual fetch resumes it.
  5. Network errors back off exponentially (1, 2, 4… up to 30 min) and reset on success.
  6. Emit `sync:autoFetch:state`.

### 6.3 Ahead/behind & tracking
- Source: `%(upstream:track,nobracket)` in refs (spec 02 §6.7). Parse `ahead (\d+)` and `behind (\d+)`; `gone` → `upstream.gone = true`.
- Arbitrary pairs (e.g. against a push target that isn't the upstream): `git rev-list --left-right --count <a>...<b>` → `"<ahead>\t<behind>"`.
- Push-target vs upstream: the upstream is both pull and push target, but if `remote.pushDefault`/`branch.<b>.pushRemote` is set, use `git rev-parse --abbrev-ref <b>@{push}` for push counts (inferred extension).
- **Set upstream**: `git branch --set-upstream-to=<remote>/<branch> -- <local>`. Unset: `git branch --unset-upstream -- <local>`. If the remote-tracking ref doesn't exist yet (branch never pushed), set config directly: `git config branch.<b>.remote <r>` and `git config branch.<b>.merge refs/heads/<rb>`.
- Checkout of a remote branch (spec 05) creates a tracking local: `git checkout -b <name> --track <remote>/<branch>` (or `git switch -c … --track`).

### 6.4 Pull
Pull is implemented as **fetch + integrate**, not `git pull`. This gives one progress stream, our own error handling, and no dependence on the user's `pull.rebase`/`pull.ff` config (which the explicit Pull dropdown overrides).

1. Preconditions: on a branch (not detached → `DetachedHead`), with an upstream (else `NoUpstream` → offer Set Upstream). Not in merge/rebase state.
2. `git fetch --progress [--prune] -- <upstreamRemote>`. Fetching only that remote matches "pull fetches then updates" (inferred: it may fetch all).
3. Compute `ahead/behind` of `HEAD` vs `@{upstream}`. If behind = 0, report "Already up to date" and stop.
4. Integrate according to strategy:
   - **ff-if-possible**: `git merge --ff --no-edit @{upstream}`. With `GIT_MERGE_AUTOEDIT=no`, the merge commit message is git's default "Merge branch 'main' of <url>"-style. We use `-m "Merge remote-tracking branch '<r>/<b>'"` for consistency.
   - **ff-only**: `git merge --ff-only @{upstream}`. On `NotFastForwardable` → toast "Can't fast-forward: branches have diverged" with actions **Merge** / **Rebase** (inferred; we explain why rather than doing nothing).
   - **rebase**: `git rebase [--autostash] @{upstream}`. With `--rebase-merges` if the setting "Preserve merges on pull rebase" is on (default off).
   - **merge-no-ff** (extension): `git merge --no-ff --no-edit @{upstream}`.
5. **Dirty worktree**: before integrating, check status. If changes overlap incoming files, git fails with `LocalChangesWouldBeOverwritten`. On that error, offer **Stash & Pull**: `git stash push --include-untracked -m "GitHappens autostash before pull"`, pull, then `git stash pop`. Stash pop conflicts → `StashConflict` → conflict UI (spec 08) and the stash is kept. For rebase, `--autostash` does this natively. Default: try without stash first (inferred behavior: surface an error offering to stash).
6. Conflicts → `MergeConflict`/`RebaseConflict` → spec 08 takes over. The op result marks "completed with conflicts" (not a failure toast).
7. If submodules exist and "Keep submodules up to date" is on: `git submodule update --init --recursive --progress`.
8. If the repo uses LFS: smudge happens during checkout via the filter, so nothing extra is needed. If `GIT_LFS_SKIP_SMUDGE` is set by the user, run `git lfs pull`.
9. Undo journal: record the pre-pull HEAD sha (spec 05). Refresh scopes: status, refs, graph, repoState.

**Fast-forward a non-checked-out branch**: `git fetch . -- refs/remotes/<r>/<b>:refs/heads/<local>`. This only succeeds when fast-forward, refuses non-ff (no `+`), and refuses if the branch is checked out in any worktree (`BranchCheckedOutInWorktree` → offer to open that worktree).

### 6.5 Push
1. Resolve the target. If `branch.<b>.remote/merge` is set, use it. Otherwise show the **push target prompt** (§4.3). If there is exactly one remote, still prompt for a name.
2. **Preview** (`git:push:preview`): `git ls-remote --exit-code -- <remote> refs/heads/<rb>` is network, so skip it for speed. Use the local remote-tracking sha `refs/remotes/<r>/<rb>` (may be stale) and `merge-base --is-ancestor <remoteSha> <local>` to predict fast-forward. The real verdict comes from push.
3. Command:
   ```
   git push --progress --porcelain [--set-upstream] [--follow-tags] [--no-verify] \
       [--force-with-lease=refs/heads/<rb>:<expectedSha>] [--force-if-includes] \
       -- <remote> refs/heads/<local>:refs/heads/<rb>
   ```
   - Always use explicit full refspecs to avoid `push.default` surprises.
   - New remote branch: `expectedSha` is omitted. Use `--force-with-lease=refs/heads/<rb>:` (empty = must not exist) only when forcing.
   - `--force-if-includes` only when `features.forceIfIncludes`.
4. Parse `--porcelain` stdout: `To <url>` line, then per ref `<flag>\t<from>:<to>\t<summary>` where the summary may end with ` (<reason>)`, then `Done`. Flags: ` ` ff, `+` forced, `-` deleted, `*` new, `!` rejected, `=` up to date. Exit code is 1 if any ref is rejected. Classify rejection reason: `non-fast-forward`/`fetch first` → `PushRejectedNonFastForward`; `stale info` → `PushRejectedStaleLease`; `remote rejected` + text → `ProtectedBranch`/`PushRejectedByRemote`.
5. Parse `remote:` stderr lines into `remoteMessages`. Extract the first `https?://\S+/(pull|merge_requests|pull-requests)/new\S*` or `/compare/` URL into `prUrlHint`. The UI toast shows **Create pull request** (spec 10).
6. On `PushRejectedNonFastForward`: toast with **Pull** (default strategy) and **Force push…**. Force push opens the confirm (§4.3), using `git log --format=… <local>..refs/remotes/<r>/<rb>` (after a fetch of that remote, so the lease is fresh and the user sees what they overwrite). Then push with `--force-with-lease=refs/heads/<rb>:<thatFetchedSha>`.
7. Upstream gets set via `--set-upstream` when the prompt checkbox was on.
8. **Push tags**: single `git push --porcelain -- <remote> refs/tags/<t>`. All: `git push --porcelain --tags -- <remote>`. **Delete remote branch/tag**: `git push --porcelain --delete -- <remote> refs/heads/<b>` (or refs/tags). These trigger `pre-push`.
9. LFS: the `pre-push` hook installed by git-lfs uploads objects automatically. Progress lines from git-lfs ("Uploading LFS objects: 50% (1/2), 10 MB | 2 MB/s") are parsed with an extra progress regex `^Uploading LFS objects:\s+(\d+)% \((\d+)\/(\d+)\)`.
10. Refresh scopes: refs, graph.

### 6.6 Credentials & HTTPS auth
Resolution chain inside the askpass bridge (spec 02 §6.3), for a `Username`/`Password` prompt on URL `https://[user@]host/...`:
1. **Integration token**: if the profile has a connected provider whose host matches (github.com / GHE host, gitlab.com / self-hosted, bitbucket.org, dev.azure.com / `*.visualstudio.com`), answer with:
   - GitHub: username `x-access-token`, password = OAuth token
   - GitLab: `oauth2` / token
   - Bitbucket Cloud: `x-token-auth` / OAuth access token
   - Bitbucket Data Center: the account's `{username}` / HTTP access token
   - Azure DevOps: any non-empty username / token (OAuth or PAT)
   The table is shared with spec 10 §6.1 and lives in one function, `gitHttpCredentialFor(integration)` in `/packages/providers`.
   If the URL already contains a username that differs from the integration's account, skip to step 2 (inferred).
2. **Stored credential** in the keychain via SecretStore (spec 13 §5.1 naming: account `<profileId>/git/<username>@<host>`). The username index is kept in `credentials.json` (no secrets).
3. **Interactive prompt** (`git:prompt` username, then password), unless `nonInteractive` (exit 1 → `AuthenticationFailed`). If "Remember" is checked, the credential is saved only after the op succeeds. The bridge stores it pending, keyed by op token, and commits it on success. On `AuthenticationFailed` after a stored or integration credential was used, delete the stored one (not the integration token) and retry once with a prompt (manual ops only).

Notes:
- The user's own `credential.helper` (e.g. Git Credential Manager, osxkeychain) runs **before** askpass, as normal git behavior. Preference **"Use Git credential helpers"** (default on). When off, add `-c credential.helper=` to network commands so only our chain is used (inferred toggle).
- **Forget all credentials**: delete all SecretStore `<profileId>/git/*` entries for the profile and clear `credentials.json`. We do not touch the user's own credential helpers (documented in the UI text).
- Never put credentials in remote URLs. If a remote URL already contains `user:pass@`, warn in the Edit Remote dialog.

### 6.7 SSH
- **Command construction** (set via `GIT_SSH_COMMAND` per invocation; overrides `core.sshCommand` only when the app manages keys):
  - Using an app-managed key: `ssh -i "<key>" -o IdentitiesOnly=yes`. We keep the user's `~/.ssh/config` (we never pass `-F /dev/null`). This makes host aliases work with the system ssh.
  - Key selection: provider-specific key (by remote host) → profile default key → (none) agent/default identities.
  - **Use local SSH agent**: do not set `-i`, and don't set `GIT_SSH_COMMAND` at all. Then:
    - macOS/Linux: ensure `SSH_AUTH_SOCK` from the resolved shell env (§02-6.1).
    - Windows OpenSSH agent: use `C:\Windows\System32\OpenSSH\ssh.exe` via `GIT_SSH_COMMAND` (the bundled MSYS ssh can't talk to the Windows agent's named pipe). Pageant: `GIT_SSH=<bundled plink.exe>` + `GIT_SSH_VARIANT=plink`, or OpenSSH ≥ 8.x with `IdentityAgent` pointing at Pageant's named pipe (inferred; validate during implementation).
  - Passphrase prompts arrive at askpass (`SSH_ASKPASS` + `SSH_ASKPASS_REQUIRE=force`). Remembered passphrases are stored in SecretStore as `<profileId>/ssh-passphrase/<keyFingerprint>`.
  - Host key prompts → `hostkey` dialog. Answer `yes` appends to `~/.ssh/known_hosts` (ssh does this). `nonInteractive` ops answer `no` → `HostKeyVerificationFailed` → pause auto-fetch.
- **Generate key** (`ssh:key:generate`):
  1. Default path `<userData>/ssh/<profileId>/id_ed25519` (inferred; app-generated keys live in the app's own data dir). The user may pick `~/.ssh/…`.
  2. Run `ssh-keygen -t ed25519 -C "<comment>" -f "<path>" -N ""` (bundled `usr/bin/ssh-keygen` on Windows). For a passphrase, run ssh-keygen under `node-pty` and answer its prompts, so the passphrase never appears in argv. RSA: `-t rsa -b 4096`.
  3. Set file permissions: POSIX `chmod 600` private / `644` public. Windows: `icacls <path> /inheritance:r /grant:r "%USERNAME%:F"` (OpenSSH rejects broadly-readable keys).
  4. Read the `.pub` and fingerprint via `ssh-keygen -lf <pub>` → return.
- **Add to provider**: `ssh:key:addToProvider` → ProviderService (spec 10). GitHub `POST /user/keys` (needs `write:public_key` scope), GitLab `POST /user/keys`, Bitbucket `POST /2.0/users/{uuid}/ssh-keys`, Azure DevOps: no public API → open `https://dev.azure.com/<org>/_usersSettings/keys` with the key copied to the clipboard. Title: `GitHappens (<hostname>)`.
- **Per-profile**: `SshSettings` is stored inside the profile (spec 13). Switching profile changes which key is used for subsequent commands. Running ops keep their env.

### 6.8 Git LFS
- **Detection**: `git lfs version` → `git-lfs/3.6.0 (...)`. Minimum 3.0. Bundled git ships git-lfs. With system git, the user's git-lfs must be on PATH.
- **Repo uses LFS** if any of: `.gitattributes` (root or nested, via `git ls-files -z -- '*.gitattributes' ':(glob)**/.gitattributes'`) contains `filter=lfs`; `<gitDir>/lfs` exists; or `lfs.url` config is set.
- **Installed** (hooks present): `.git/hooks/pre-push` exists and contains `git lfs`, or `git config --get filter.lfs.process` is set.
- **Initialize**: `git lfs install --local` (sets filter config + installs hooks into the repo). New repo dialog ("Initialize with LFS") runs it after `git init`. If hooks already exist (husky), git-lfs refuses to overwrite: detect `Hook already exists` → show instructions, and offer `git lfs update --manual` output in the output log.
- **Patterns**: list by parsing `git lfs track` (no args) output: a heading, then lines `    <pattern> (<file>)`, plus `[lockable]` markers. Alternatively parse `.gitattributes` directly (both implemented; the parser is canonical, and track output is a fallback).
  - Track: `git lfs track -- "<pattern>"` (add `--lockable` option). Untrack: `git lfs untrack -- "<pattern>"`. These modify `.gitattributes` → status refresh. The UI suggests staging `.gitattributes`.
  - After tracking, existing matching files remain regular blobs. Offer **"Convert existing files"**: `git rm --cached -- <files>` + `git add -- <files>` (re-add through filter) for files in the current tree matching the pattern (from `git ls-files -z -- <pattern>`). History migration (`git lfs migrate`) is out of scope.
- **Pull/Fetch/Push/Prune**:
  - `git lfs pull [<remote>] [--include=…]`
  - `git lfs fetch [--all] [<remote>]`
  - `git lfs push --all <remote>` (or `git lfs push <remote> <ref>`)
  - `git lfs prune [--dry-run] [--verbose]`. Prune requires a confirm dialog ("destructive").
  - Progress: env `GIT_LFS_PROGRESS=<tmpfile>`, tailed. Lines: `<direction> <n>/<m> <bytesSoFar>/<bytesTotal> <name>`.
- **After clone / submodule init**: run `git lfs pull` automatically if the repo uses LFS and smudge was skipped. We clone with `GIT_LFS_SKIP_SMUDGE=1` to get a single progress phase, then `git lfs pull` with its own progress (inferred: "LFS pull runs automatically after cloning").
- **Locks** (extension): `git lfs locks --json` → `[{id, path, owner:{name}, locked_at}]`. Determine `ours` via `git lfs locks --verify --json` (`ours`/`theirs` arrays). Lock: `git lfs lock --json -- <path>`. Unlock: `git lfs unlock --json [--force] -- <path>`. Locks require server support. A 404/501 → `lockingSupported=false`, and the Locks UI is hidden. Lockable patterns make files read-only until locked (git-lfs behavior). The staging panel shows 🔒 on files locked by others (inferred UI).
- **Pointer display** (in diff/file views, spec 07): a blob is a pointer if size < 1024 bytes and it matches
  `^version https://git-lfs\.github\.com/spec/v1\n(?:.*\n)*?oid sha256:([0-9a-f]{64})\nsize (\d+)\n?`.
  Show an "LFS" badge, oid, human size, and "Downloaded" status (`<commonDir>/lfs/objects/<oid[0:2]>/<oid[2:4]>/<oid>` exists). The diff shows the old/new pointer metadata rather than binary content. Image previews use the smudged object if present.
- **LFS files list**: `git lfs ls-files -l [--json]` (`--json` in git-lfs ≥ 3.2) → path, oid, and `*` (downloaded) vs `-` (pointer only) markers in text mode.
- **Errors**: `LfsMissing` → banner "This repository uses Git LFS but git-lfs was not found" + link to the git-executable preference. `LfsError` → output log.

### 6.9 Submodules
- **List**: spec 02 §6.11 (`.gitmodules` + `git submodule status --recursive` + `ls-tree`). State mapping: `-` → uninitialized; `+` → out-of-sync; `U` → conflict; ` ` → in-sync. "Added but not committed" = entry present in the index/`.gitmodules` but not in HEAD (porcelain v2 status shows `A` with `S...` sub field, plus `.gitmodules` modified). Inner dirty state comes from porcelain v2 `S<c><m><u>`.
- **Add**: `git submodule add [-b <branch>] -- <url> <path>`. Then, if recursive: `git submodule update --init --recursive --progress -- <path>`. Credentials go through askpass (the submodule clone is a network op). Leaves `.gitmodules` + gitlink staged. The UI prompts to commit (inferred).
- **Init/Update**: `git submodule update --init [--recursive] --progress [--] [<paths>]` → checks out the recorded commit (detached). **Update to latest remote**: `git submodule update --remote [--merge|--rebase] -- <path>`, which changes the gitlink in the parent's worktree → status shows the submodule modified.
- **Auto-update after git actions** (setting): after checkout, pull, merge, rebase, and reset, if any gitlink changed between old and new HEAD (`git diff --name-only -z --submodule=short <old> <new>` filtered by mode 160000 via `git diff --raw`), run `git submodule update --init --recursive -- <changed paths>`.
- **Edit URL**: `git config -f .gitmodules submodule.<name>.url <url>`, then `git submodule sync --recursive -- <path>`. Stage `.gitmodules`.
- **Delete**: confirm, then:
  1. `git submodule deinit -f -- <path>`
  2. `git rm -f -- <path>`
  3. Remove `<commonDir>/modules/<name>` (fs.rm recursive, guarded to that dir)
  4. Changes are staged. Prompt to commit.
- **Open**: opens `<worktree>/<path>` as a repo tab (spec 03). Opening in the current tab pushes a breadcrumb "parent › submodule" with a **Back to parent** button (inferred open/exit flow). When returning to the parent, if the submodule's HEAD differs from the recorded gitlink, show a banner "Submodule `x` pointer changed (abc → def). Stage & commit?" → stages the path (`git add -- <path>`) and focuses the commit composer.
- Fetching a parent does not fetch submodules unless `fetch.recurseSubmodules` is set. Leave it to git config.

### 6.10 Worktrees
- **List**: spec 02 §6.11. Mark `isCurrent` where the path equals this tab's worktree root. Folder name = `basename(path)`.
- **Create**:
  - Existing branch: `git worktree add -- <path> <branch>`
  - New branch: `git worktree add -b <new> -- <path> <startPoint>`
  - Detached: `git worktree add --detach -- <path> <commit>`
  - Errors: `BranchCheckedOutInWorktree` (branch in use) → offer "Create new branch from it" instead. Path exists and is not empty → validation error before running.
  - After creation, copy view settings (hidden/solo refs, collapsed folders) from the source repo's per-repo UI state into the new worktree's state (spec 03/04 storage). Then open per the dialog choice.
  - Worktree setup: if the source uses LFS, git-lfs smudges on checkout. Submodules are not initialized automatically in new worktrees, so prompt as with clone.
- **Open**: switch the current tab's repo path to the worktree (same commonDir → reuse caches), or open a new tab.
- **Lock/Unlock**: `git worktree lock [--reason <r>] -- <path>`, `git worktree unlock -- <path>`.
- **Remove**:
  1. Check `git -C <path> status --porcelain=v2 -z` (read) for changes.
  2. `git worktree remove [--force] -- <path>`. Use `--force` twice if locked and the user confirmed.
  3. "And delete branch": then `git branch -d -- <branch>`. On `BranchNotFullyMerged`, ask, then `-D`. Undo journal records the branch tip.
  - Removing the worktree the current tab is showing: switch that tab to the main worktree first.
- **Prune**: `git worktree prune -v` (lists pruned entries, shown in a toast).
- **WIP nodes per worktree** (graph, spec 04): for each non-current, non-bare worktree, run a lightweight `git -C <path> --no-optional-locks status --porcelain=v2 -z --untracked-files=normal` on refs/worktree change and every 30 s while visible. Cap at 20 worktrees (inferred perf limit). A node appears above that worktree's HEAD commit with a changed-file count. Hover action "Open worktree".
- Checkout of a branch checked out in another worktree is blocked by git. Our pre-check uses `RefInfo.worktreePath` to disable the action with a tooltip "Checked out in worktree <folder>", plus an "Open worktree" action.

### 6.11 Proxy
- **System mode**: for each network op, resolve the proxy for the remote URL using Electron `session.defaultSession.resolveProxy(url)` → `PROXY host:port` / `DIRECT`. Convert to `http://host:port` and pass via env `HTTPS_PROXY`/`HTTP_PROXY` (only when git's own `http.proxy` config is unset; the user's git config wins).
- **Manual mode**: env `HTTPS_PROXY=HTTP_PROXY=<url>`, `NO_PROXY=<list>`.
- **None**: pass `-c http.proxy=` and clear the proxy env vars.
- **Proxy auth**: on `ProxyAuthRequired`, prompt for credentials (macOS/Linux, inferred same on Windows since git doesn't use the system prompt). Store them in SecretStore (`<profileId>/proxy/<host>`) and inject into the env URL (`http://user:pass@host:port`, percent-encoded). Never into argv or logs (redacted).
- **Certificates**: Windows "Use OS certificate store" → `-c http.sslBackend=schannel`. Custom CA → `-c http.sslCAInfo=<path>`. These apply to git only. Provider API calls use Electron's net stack, which uses the OS store and Chromium proxy settings (spec 10).
- **SSH through proxy**: not app-managed. The user's `~/.ssh/config` `ProxyCommand` works because we don't override `-F`.
- Electron's own networking honors `--proxy-server` (and we call `session.setProxy` from the manual settings so provider APIs, avatars, and the updater match).

### 6.12 Hooks
- Git executes hooks itself. Our job is to (a) give them a usable environment, (b) capture and show their output, (c) classify failures, and (d) support skipping and custom paths.
- **Environment**: the resolved shell env (PATH with node/nvm/homebrew) is merged into every git invocation (§02-6.1). On Windows, hooks run through the bundled git's `sh.exe`.
- **Custom hooks path** (repo preference): `git config --local core.hooksPath <path>`. Clearing it uses `--unset`. Global `core.hooksPath` is shown read-only with its origin (from `config --show-origin`).
- **Hook discovery** (for classification and UI hints): `git rev-parse --git-path hooks/<name>`, which honors `core.hooksPath`. A hook exists if the file exists and (POSIX) is executable. If the file exists but is not executable on POSIX, show a warning in the repo hooks preference "pre-commit is not executable (chmod +x)". Git silently ignores it but logs a hint (`hint: The '...' hook was ignored because it's not set as executable`), which we surface.
- **Output capture**: hook stdout/stderr flow into git's stderr/stdout. The op's full combined output is kept in the CommandLogEntry (spec 02). The output modal shows it. For commit, stdout includes the commit summary on success, which we ignore.
- **Failure classification** (`HookFailed`):
  - `commit`: exit ≠ 0, a pre-commit or commit-msg hook exists, and stderr doesn't match NothingToCommit/EmptyCommitMessage/Gpg/IndexLocked → `HookFailed { hook: 'pre-commit' | 'commit-msg' }`. Disambiguate by running order: if `.git/COMMIT_EDITMSG` was not rewritten during the op, the failing hook was pre-commit (inferred heuristic). Otherwise report "pre-commit/commit-msg hook".
  - `push`: stderr contains `error: failed to push some refs` **and** no porcelain ref lines were printed (the hook runs before any ref is sent) **and** a pre-push hook exists → `HookFailed { hook: 'pre-push' }`.
  - Merge/rebase/checkout hooks (post-*) don't block. Their output is only logged.
- **Skip hooks**: commit composer checkbox "Skip hooks" → `--no-verify` (spec 06). Push: "Retry without hooks" in the failure modal → `push --no-verify` (our extension). Note that `--no-verify` on push also skips the git-lfs pre-push upload, so warn when the repo uses LFS.
- **Long-running hooks**: status text "Running pre-commit hook…" while the commit op runs over 1 s (inferred). The Cancel button kills the process tree (spec 02 §6.2).

## 7. Step-by-step implementation plan

1. **Remote ops**: add/edit/remove/rename builders + `SyncOperation` variants + Left Panel REMOTE section wiring. Test on fixture with `file://` remotes.
2. **Add Remote dialog**: URL tab, validation, and shallow options. Provider fork tabs behind the spec 10 `listForks` interface (mock in tests).
3. **Fetch op**: progress, porcelain/stderr summary parser, prune flag, refresh. Test: fixture with a new branch, deleted branch, and forced update on the remote.
4. **Auto-fetch scheduler**: interval settings, skip rules, background throttle, auth pause, backoff, state events. Test with a fake clock.
5. **Ahead/behind**: badges in the LOCAL section and toolbar. `git:aheadBehind` for arbitrary pairs. Set/unset upstream ops.
6. **Pull**: fetch + integrate for the 3 strategies, dirty check + Stash & Pull flow, conflicts handoff, submodule auto-update hook. Test: each strategy on diverged, ff-able, and up-to-date fixtures.
7. **Fast-forward non-checked-out branch** (`fetch .`).
8. **Push**: target prompt, porcelain parser, PR URL hint, rejection classification, force-with-lease flow with preview, tag push, remote delete. Test: rejected push, stale lease (remote moved after our fetch), new branch, protected-branch stderr fixture.
9. **Credential chain**: integration token lookup (stub ProviderService), keychain store, prompt dialog, remember-after-success, forget-all, non-interactive mode. Test: askpass with a local HTTPS git server (`git http-backend` behind a node basic-auth proxy in tests).
10. **SSH**: settings per profile, `GIT_SSH_COMMAND` builder, agent modes per OS, passphrase/host-key prompts, key generation (ssh-keygen + permissions), add-to-provider call. Test: local `sshd` in Linux CI container with fixture keys.
11. **Proxy**: settings, system resolution, env injection, proxy auth prompt, cert options. Test: local proxy (`proxy-chain` npm) in integration tests.
12. **LFS**: detection, status channel, init, track/untrack (+ convert existing files), pull/fetch/push/prune with progress file, pointer detection in diff, LFS badge in staging, locks (feature-detected). Test: fixture with a local LFS server (`lfs-test-server` or the git-lfs standalone `file://` transfer).
13. **Submodules**: list/state, add, init/update, update --remote, set URL, delete, open-as-tab with back navigation and pointer-change banner, auto-update after ops. Test: nested submodule fixture.
14. **Worktrees**: list, create (3 modes), open (same/new tab), lock/unlock, remove (+ delete branch), prune, view-settings inheritance, per-worktree WIP nodes feed for spec 04.
15. **Hooks**: hooks-path preference, discovery + non-executable warning, failure classification, output modal, retry/retry-without-hooks. Test: fixtures with failing pre-commit, commit-msg, and pre-push hooks (sh scripts; on Windows via bundled sh).
16. **E2E (Playwright)**: add remote → push new branch with upstream prompt → remote commit → auto-fetch shows ↓1 → pull ff → force push flow.

## 8. Edge cases

- **Detached HEAD**: Pull disabled. Push opens the target prompt with a required branch name (pushes `HEAD:refs/heads/<name>`).
- **Unborn branch / empty repo**: Push disabled until the first commit. Fetch works.
- **No remotes**: Pull/Push buttons show "Add a remote" CTA.
- **Upstream gone** (`[gone]`): pull → `UpstreamGone` → offer "Unset upstream" / "Push to recreate".
- **Upstream on a different remote than origin**: always use the configured `branch.<b>.remote`.
- **Remote name with slashes** (`team/origin`): allowed by git. Remote-branch parsing uses the known remote list (longest prefix match) to split `refs/remotes/<remote>/<branch>`.
- **Remote URL is a local path** (`../repo.git`, `C:\repos\x`): no auth. Treat provider as none.
- **Multiple push URLs** (`remote.x.pushurl` set multiple times): show the first, and the edit dialog warns "multiple push URLs configured; editing replaces all".
- **Mirror remotes / custom refspecs**: honor them. The edit dialog shows refspecs read-only.
- **Shallow repos**: pushing from shallow may fail (`shallow update not allowed`) → `ShallowRepository` with "Unshallow" action (`git fetch --unshallow`).
- **Pull with local branch name ≠ upstream branch name**: we use `@{upstream}`, which is name-agnostic.
- **Pull rebase over local merge commits**: without `--rebase-merges`, merges are flattened. Warn when the local-only range contains merges (`git rev-list --merges @{u}..HEAD` non-empty).
- **Force push to protected branches**: remote rejection → `ProtectedBranch` with a host-specific message.
- **Push while auto-fetch is running**: the queue serializes. Coalescing only applies to fetches.
- **Credential prompts storm** (many submodules): askpass dedupes prompts per host within one op. The answer is reused for subsequent prompts with the same host + username.
- **2FA hosts with password auth**: AuthenticationFailed message suggests tokens / connecting the integration.
- **SSH key with CRLF** or wrong permissions on Windows: detect `bad permissions` / `invalid format` in stderr, and show fix instructions / "Fix permissions" action.
- **known_hosts on Windows with bundled ssh**: bundled MSYS ssh uses `%HOME%/.ssh`. Set `HOME` to `%USERPROFILE%` if unset so both ssh flavors share files.
- **LFS without server lock support**: hide locks. **LFS quota exceeded** → LfsError with server message.
- **LFS pointer files committed without the filter** (pattern added later): status shows them modified after `git lfs install`. Document; offer "Convert existing files".
- **Submodule with relative URL** (`../lib.git`): resolved against the parent's remote URL by git. Credentials for the parent host apply.
- **Submodule path with spaces/unicode**: always pass after `--`.
- **Worktree path on a different drive** (Windows): fine for git. The default path may be long, so respect `core.longpaths`.
- **Worktree folder deleted manually**: shows as `prunable`, with a Prune action.
- **Hooks producing ANSI/interactive output** (e.g. prompts for input): stdin is closed, so hooks reading stdin get EOF. Document that interactive hooks are unsupported.
- **Hooks on Windows with CRLF shebang**: fails with `/usr/bin/env: 'bash\r'`. Detect and suggest normalizing line endings (inferred helpful message).

## 9. Acceptance criteria

- [ ] Add, edit (rename + URLs), and remove a remote from the left panel. Remote branches and upstream configs update accordingly.
- [ ] With GitHub connected, the Add Remote GitHub tab lists forks of the current repo, and adding one fetches it.
- [ ] Auto-fetch runs at the configured interval (default 1 min), 0 disables it, it never shows a credential prompt, and it pauses with a visible badge after an auth failure.
- [ ] Ahead/behind badges match `git rev-list --left-right --count` for every local branch with an upstream, and update after fetch, commit, and push.
- [ ] Pull strategies behave as: ff-if-possible merges on divergence, ff-only does nothing on divergence and explains why, rebase replays local commits. The default persists across restarts.
- [ ] Pull with conflicting local changes offers Stash & Pull, and the stash is restored afterwards (or kept on conflict).
- [ ] Pushing a branch with no upstream prompts for remote + name, and sets the upstream.
- [ ] A rejected push offers Pull and Force Push. Force push uses `--force-with-lease` with the sha the user saw and fails safely if the remote moved again.
- [ ] Pushing a tag and deleting a remote branch/tag work and trigger pre-push.
- [ ] A PR creation link from push output appears as an action.
- [ ] HTTPS push to GitHub/GitLab/Bitbucket/Azure works using the integration token with no prompt. A non-integrated host prompts once, and "Remember" stores the credential in the OS keychain only after success.
- [ ] SSH works with (a) an app-generated key added to GitHub via API, (b) the local agent on macOS/Linux, (c) Windows OpenSSH agent and Pageant modes. Unknown host keys show a fingerprint dialog.
- [ ] LFS: detection, init, track/untrack, pull/fetch/push/prune with progress, LFS badge, pointer metadata in diffs. Locks work against a lock-capable server and are hidden otherwise.
- [ ] Submodules: add, initialize, update, update-to-remote, edit URL, delete, open as tab, return with pointer-change prompt. Status icons correct for the 4 states.
- [ ] Worktrees: create (existing/new/detached), open in same or new tab, lock/unlock, remove (incl. dirty force and delete branch), prune. Each worktree with changes shows a WIP node.
- [ ] Manual proxy and system proxy route git HTTPS traffic. Proxy auth prompt works. Credentials are never logged.
- [ ] A failing pre-commit/pre-push hook blocks the op and shows its output with Retry / Retry without hooks. Hooks see the user's shell PATH on macOS.

## 10. Out of scope / later

- `git lfs migrate` (history rewrite) UI.
- Git subtree workflows.
- Managing `~/.ssh/config` entries from the UI.
- Credential helper management (installing/configuring GCM).
- SOCKS proxy authentication UI (env `ALL_PROXY` passthrough works).
- Per-remote auto-fetch intervals. Fetching only the upstream remote on auto-fetch.
- Agent Sessions view for worktrees (coding-agent card UI) → spec 12 §4.12.
- Pre-flight conflict detection against remote branches (spec 14).

## 11. Cross-spec dependencies

- **Askpass with integration tokens (spec 10 §6.1, checked against it):** for an HTTPS prompt whose host matches a connected integration in the active profile, the askpass bridge (spec 02 §6.3) answers with `gitHttpCredentialFor(integration)`:

  | Provider | Username | Password |
  |---|---|---|
  | GitHub / GHE | `x-access-token` | OAuth token or PAT |
  | GitLab / Self-Managed | `oauth2` | OAuth token or PAT |
  | Bitbucket Cloud | `x-token-auth` | OAuth access token. With the Atlassian API-token fallback (spec 10), use the username Atlassian documents for git over HTTPS with API tokens (verify at build time) |
  | Bitbucket Data Center | account username | HTTP access token |
  | Azure DevOps | any non-empty string (we send the account login) | OAuth token or PAT |

  Spec 10 refreshes tokens before handing them out (`expiresAt - now < 120 s`). If a token-based answer leads to `AuthenticationFailed`, also emit spec 10's `auth:reauthRequired` so the integration is marked expired. The §6.6 step 3 retry with a prompt still applies to manual ops.
- **SSH key selection per provider host (specs 10 §6.5, 13):** `buildSshCommand(remoteUrl, profile)` picks the key in this order: `integrations.<integrationKey>.sshKeyPath` (spec 13, set by spec 10's "Generate SSH key and add to provider") when the remote host matches that integration's host (after `insteadOf` and `~/.ssh/config` `HostName` resolution, spec 10 §6.3), then `ssh.privateKeyPath`, then agent/default identities (§6.7). Key generation for both specs uses `ssh:key:generate` (§6.7), so a passphrase never appears in argv. Spec 10's `ssh:generateAndUpload` calls it and then `HostingProvider.uploadSshKey`. `ssh:key:addToProvider` here delegates to the same spec 10 upload.
- **LFS pull after clone (spec 03 clone service):** the clone builder sets `GIT_LFS_SKIP_SMUDGE=1` and, when the cloned repo uses LFS (§6.8 detection), queues `{ type: 'lfs.pull' }` as the clone's final progress phase (`CloneProgress.phase: 'lfs'`). The same happens after `submodule.update { init: true }` for LFS-enabled submodules.
- **Sparse checkout entry point (specs 03 §6 / §7 step 17, 13 repo section "Sparse Checkout"):** clone-time sparse setup belongs to spec 03. Ongoing management uses the `GitOperation` variants `{ type: 'sparse.set'; paths: string[]; cone: boolean }`, `{ type: 'sparse.disable' }` and `{ type: 'sparse.reapply' }` (commands `git sparse-checkout set [--cone|--no-cone] --stdin`, `disable`, `reapply`) plus a read channel `git:sparse:list` (`git sparse-checkout list`). These are reached from Preferences › Repo › Sparse Checkout and a toolbar/palette "Sparse checkout…" entry. Fetch/pull here need no special handling.
- **Custom CA certificates (spec 13 Network section):** `network.caBundlePath` applies to git as `-c http.sslCAInfo=<path>` on network commands, and `network.useOsCertStore` (Windows) as `-c http.sslBackend=schannel` (§6.11). Spec 10's HttpClient adds the same bundle to Electron's trust (`NODE_EXTRA_CA_CERTS` at startup or a `session.setCertificateVerifyProc` fingerprint allow-list for "trust this certificate"), so git and provider APIs accept the same servers.
- **Settings owned by spec 13:** `general.autoFetchInterval`, `general.autoPrune`, `general.autoUpdateSubmodules`, `git.pullMode` (values = `PullStrategy`), `git.pushFollowTags`, `git.pullRebaseMerges`, `git.useCredentialHelpers`, `ssh.*`, `network.*`. Repo-level `core.hooksPath`, LFS and submodule overrides are in spec 13's repo sections. Secrets use the SecretStore naming in spec 13 §5.1.
