# 11 — Workspaces, Launchpad & Home/Focus View

> Depends on: 03 (repo management, clone, repo tabs), 09 (fetch/pull), 10 (ProviderService, IssueTracker, PR models), 13 (profiles/preferences).
> Optional dependency: 14 (cloud backend for shared/cloud workspaces, snooze/pin sync).
> Roadmap: Phase 5 (spec 15 §8).

---

## 1. Purpose

Developers rarely work in one repository. GitHappens answers this with:

- **Workspaces** — named groups of repositories (e.g. "Payments: api, web, infra") that can be opened together, fetched/pulled in bulk, cloned onto a new machine in one step, and inspected through a cross-repo overview of branches, WIP, PRs and issues.
- **Launchpad** — a unified, prioritized inbox of pull requests, issues and uncommitted work across all connected providers and repositories, grouped by "what needs my action" (needs review, ready to merge, blocked, …) with pin and snooze.
- **Home / Focus view** — the landing screen of a new tab: recent repos, workspaces, and a compact Launchpad summary. (The cross-repo dashboard "Focus View" is folded into Launchpad and the status-bar summary.)

For us, these are the main reason to keep the app open all day. They are built entirely on the provider layer of spec 10 plus local git status; the only cloud-dependent parts (shared cloud workspaces, synced pin/snooze) are optional (spec 14).

---

## 2. Reference behavior

### 2.1 Workspaces

- Two kinds:
  - **Local Workspace** — stored only on the machine, needs no integration, not shareable. Repos added individually, by scanning a directory, or by importing a VS Code `.code-workspace` file. A **"Sync with local directory"** option keeps the workspace equal to all repos under a folder. Can be converted to a cloud workspace later.
  - **Cloud Workspace** — stored in the user's cloud account, defined by a hosting provider plus a set of provider repositories; available on every machine where the user signs in; shareable with teams or users in the same organization. Requires a connected integration. Not available in on-premise editions.
- Opened from the folder icon / `Alt+O` (`Cmd+O` on macOS), shown in the **Repository Management** view. Workspaces have name, color, icon, description; groups can be hidden/unhidden and reordered by drag.
- **Bulk actions** on checked repos: Clone (missing repos; HTTPS unless SSH configured), Fetch, Pull (with pull-mode dropdown), Open (in app or editor), Locate (set local path), Remove from workspace.
- A **Workspace Overview** shows each repo's state and lets you jump in *(added in 8.8; detailed contents inferred: current branch, ahead/behind, WIP count, PR count)*.
- Opening a cloud workspace's Launchpad icon shows its PRs; an Insights icon opens a web dashboard (spec 14).

### 2.2 Launchpad

- Opened from a **Launchpad tab** pinned at the top-left of the tab bar.
- Tabs: **Pull Requests**, **Issues**, **WIPs** (repos with uncommitted changes, "View Repo"), **All**, **Snoozed**.
- **Personal** vs **Team** mode: Personal = items I created, am assigned, am requested to review, or am mentioned in; Team = everyone's items in the selected workspace, filterable by contributor (paid tier).
- Scope selector: a workspace, or "None" = everything tied to my identity across connected services.
- PR table columns: last updated, status (open/draft/at-risk + review + build state), title (+ line diff counts, code-suggestion indicator), authors, collaborators, repository & branch, actions.
- Filters: workspace, service/source, project, labels, contributor; for issues creator/assignee/mentions; Jira sprint/fix version; GitHub/GitLab milestones; time ranges.
- Item actions: open in browser, open repo, open code suggestions, review, checkout branch, checkout in new worktree, close PR, merge (when ready, per GitLens docs), create branch from issue, **pin** (stick to top), **snooze** (1h, 4h, until tomorrow, or indefinitely → moves to Snoozed).
- Status groups (GitLens-equivalent Launchpad): **Ready to merge**, **Blocked**, **Requires follow-up**, **Needs your review**, **Waiting for review**, **Draft**, **Snoozed**, plus **Pinned** and (GitLens) **Current branch** / **Other**. Ordering is automatic: actionable first.
- **Saved views**: save a filter set as a named tab; per mode (Personal/Team).
- **Status-bar summary**: compact counts (e.g. ready to merge, no reviewers, conflicts); clicking opens Launchpad with that group expanded; respects the Launchpad filters.

### 2.3 Home / Focus view

- New tab shows recents, workspaces, integrations prompts. Older "Focus View" displayed PRs, issues and WIPs of a workspace in one dashboard; it has been superseded by Launchpad *(inferred from release history)*. We implement a **Home view** that embeds a compact Launchpad.

---

## 3. User stories

1. As a developer on a multi-repo product, I want to group repos into a workspace so I can open, fetch and pull them together.
2. As a developer on a new laptop, I want to clone all missing repos of a workspace into a chosen folder in one click.
3. As a developer, I want a workspace overview showing, per repo, the current branch, ahead/behind, uncommitted changes, open PRs and assigned issues.
4. As a developer, I want a workspace that automatically includes every repo under `~/code/acme`.
5. As a VS Code user, I want to import my `.code-workspace` file.
6. As a reviewer, I want one list of every PR that needs my review across GitHub, GitLab, Bitbucket and Azure DevOps.
7. As an author, I want to see which of my PRs are ready to merge, blocked by CI/conflicts, or waiting on reviewers.
8. As a user, I want to pin important items and snooze ones I can't act on yet.
9. As a user, I want to filter by repo, provider, label, milestone/sprint and time, and save the filter as a view.
10. As a user, I want quick actions (checkout, open, merge, create branch from issue) without leaving the Launchpad.
11. As a user, I want a status-bar hint of how many items need me.
12. As a team lead (optional), I want a team mode showing everyone's PRs in a workspace.

---

## 4. UI specification

### 4.1 Workspaces in Repository Management

```
RepoManagementView (spec 03)
├─ Sidebar: Recent · Favorites · WORKSPACES (list, + New Workspace, drag-reorder, hide/unhide)
└─ WorkspaceView (selected workspace)
   ├─ WorkspaceHeader
   │   ├─ Icon/color swatch · Name (inline edit) · Description · Kind badge (Local / Directory-synced / Cloud)
   │   ├─ Buttons: Open all · Launchpad (scoped) · Refresh · ⋯ (Edit, Convert to cloud*, Export .json, Delete)
   │   └─ Summary chips: 12 repos · 2 missing · 3 with changes · 5 behind · 7 open PRs
   ├─ BulkToolbar (enabled when ≥1 checked): Clone · Fetch · Pull ▾ (ff-only / merge / rebase) · Open ▾ (GitHappens / editor) · Locate · Remove
   ├─ Tabs: Repositories | Pull Requests | Issues | Branches
   ├─ RepositoriesTab → RepoOverviewTable (virtualized)
   │   columns: ☐ · name (+ provider icon) · local path / "Not cloned" · current branch · ↑ahead ↓behind ·
   │            WIP (files changed) · stashes · open PRs (mine / total) · last fetched · status (spinner/✔/⚠)
   │   row click → expand: local branches with upstream state, PRs for repo, last 3 commits on HEAD
   │   row double-click → open repo in tab
   ├─ PullRequestsTab → LaunchpadList scoped to workspace, PR type only (reuse §4.3)
   ├─ IssuesTab       → LaunchpadList scoped to workspace, issues only
   └─ BranchesTab     → cross-repo branch matrix: rows = branch names present in ≥2 repos, columns = repos,
                        cell = ahead/behind vs upstream or "—" (helps coordinated feature branches)
```

`*` Convert to cloud only when spec 14 backend is configured.

**New Workspace dialog**

```
NewWorkspaceDialog
├─ Step 1: Kind — Local | Directory-synced | Cloud (disabled w/ tooltip unless backend configured) | Import .code-workspace
├─ Step 2 (Local):   name, color/icon, description, RepoPicker (recents + browse folder + scan folder w/ depth 1–4)
├─ Step 2 (Dir):     root folder, scan depth (default 2), include nested repos toggle, ignore globs (node_modules, .git/modules)
├─ Step 2 (Cloud/provider-defined): integration select, owner/org filter, repo multi-select (search), default clone folder
└─ Create
```

Empty states: no workspaces → illustration + "Create a workspace" + "Import .code-workspace". Workspace with no repos → "Add repositories". Missing repos → amber "Not cloned" with inline Clone button.

Shortcuts: `Alt+O` / `Cmd+O` open Repository Management at workspaces; `Ctrl/Cmd+Shift+O` palette "Workspace: Open…".

### 4.2 Launchpad tab

Launchpad is a **pinned app tab** (leftmost, icon only, cannot be closed) rendering `LaunchpadView`.

```
LaunchpadView
├─ LaunchpadHeader
│   ├─ ScopeSelect: All connected · <workspaces…>
│   ├─ ModeToggle: Personal | Team (Team requires a workspace scope)
│   ├─ SearchInput (client-side fuzzy over title, number, repo, branch, author; `#123`, `ABC-12` exact)
│   ├─ FilterBar: Provider ▾ · Repository ▾ · Labels ▾ · Author/Contributor ▾ · Milestone/Sprint/FixVersion ▾ · Updated ▾ (24h, 7d, 30d, any)
│   └─ Right: LastRefreshed "2m ago" · Refresh · ViewSettings ⋯ (group by: status | repo | provider | none; density)
├─ ViewTabs: Pull Requests (n) · Issues (n) · WIPs (n) · All · Snoozed (n) · <Saved views…> · +
├─ LaunchpadList (virtualized, grouped)
│   ├─ GroupHeader (collapsible, count, color): Pinned · Needs your review · Ready to merge · Blocked ·
│   │                 Requires follow-up · Waiting for review · Draft · Current branch · Other
│   └─ LaunchpadRow
│       PR row:    status glyphs (review, CI, conflict) · title · #num · +add/−del · repo · head→base ·
│                  author avatar · collaborator avatars · updated · inline actions (hover): Checkout · Open · Merge* · Pin · Snooze ▾ · ⋯
│       Issue row: tracker icon · key · title · status chip · priority · assignee · repo/project · updated · actions: Create branch · Open · Pin · Snooze · ⋯
│       WIP row:   repo icon · repo name · branch · n files changed (+/−) · last modified · actions: Open repo · Stash · Commit… (opens repo WIP)
├─ DetailDrawer (right, optional): reuse PullRequestView (spec 10 §4.7) compact mode / IssueDetailPanel
└─ Footer: provider error chips ("GitLab: token expired — Reconnect"), rate-limit chips
```

States:
- **No integrations** → hero "Connect a provider to see pull requests and issues" with provider buttons (spec 10 Preferences deep link). WIPs tab still works (local only).
- **Loading first time** → skeleton rows per group; show cached data (stale banner) immediately if available.
- **Partial failure** → show successful providers' items; footer error chips per failing source.
- **Empty group** → hidden; all empty → "You're all caught up" message.

Keyboard: `↑/↓` move selection, `Enter` open detail, `C` checkout, `O` open in browser, `P` pin, `S` snooze menu, `M` merge (confirm), `/` focus search, `R` refresh, `1–5` switch view tabs.

Snooze menu: 1 hour · 4 hours · Tomorrow (09:00 local) · Next week (Mon 09:00) · Until updated (unsnooze when item `updatedAt` changes) · Indefinitely.

**Merge from Launchpad**: only in "Ready to merge" group, opens a small confirm popover with method select (from `allowedMergeMethods`), then calls `pr:merge`.

### 4.3 Status bar summary

`StatusBarLaunchpadIndicator` (spec 01 status bar slot): icon + up to three counters `● 3 review · ✔ 2 mergeable · ⛔ 1 blocked`. Click → Launchpad tab with Personal mode, PR view, that group expanded and scrolled into view. Hidden when no integrations or all counts zero (setting to always show). Tooltip lists top 5 items.

### 4.4 Home view (new tab)

```
HomeView (rendered in an empty/new tab, spec 01)
├─ Left column
│   ├─ QuickActions: Open repo · Clone · Init · New workspace
│   ├─ RecentRepos (10, with branch + dirty dot)
│   └─ Workspaces (cards: name, repo count, status chips; click → WorkspaceView)
└─ Right column — "Focus"
    ├─ CompactLaunchpad: groups "Needs your review", "Ready to merge", "Blocked" (max 5 each, "See all in Launchpad")
    ├─ MyIssues (top 5 by priority/updated)
    └─ WIPs across recent repos (repos with uncommitted changes)
```
Focus column hides if Preferences → General → "Show Focus on Home" is off.

---

## 5. Data model & IPC

### 5.1 Workspaces

```ts
export type WorkspaceKind = 'local' | 'directory' | 'cloud';

export interface WorkspaceRepo {
  id: string;                              // stable uuid within workspace
  name: string;                            // display name
  localPath?: string;                      // absolute; undefined => not cloned / not located
  provider?: { integrationKey: string; owner: string; name: string; cloneUrlHttps: string; cloneUrlSsh: string; webUrl: string };
  addedAt: string;
}

export interface Workspace {
  id: string; kind: WorkspaceKind; name: string; description?: string;
  color?: string; icon?: string;                       // icon = emoji or built-in glyph id
  order: number; hidden: boolean;
  repos: WorkspaceRepo[];
  directory?: { root: string; depth: number; includeNested: boolean; ignore: string[] };   // kind = 'directory'
  cloud?: { remoteId: string; orgId?: string; sharedWith?: Array<{ type: 'user' | 'team'; id: string; name: string }>; version: number; syncedAt?: string };
  defaultCloneRoot?: string;                            // where missing repos are cloned
  createdAt: string; updatedAt: string;
}

export interface WorkspaceFile { version: 1; workspaces: Workspace[] }   // userData/workspaces.json (per profile)

export interface RepoStatusSummary {
  workspaceRepoId: string; localPath?: string; exists: boolean; isRepo: boolean;
  head?: { branch?: string; detached: boolean; sha: string };
  upstream?: string; ahead: number; behind: number;
  wip: { staged: number; unstaged: number; untracked: number; conflicted: number };
  stashCount: number; lastFetchAt?: string;              // mtime of .git/FETCH_HEAD
  operationInProgress?: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect';
  openPrs?: { mine: number; total: number; needsMyReview: number };
  error?: string;
}

export interface BulkOpRequest { workspaceId: string; repoIds: string[]; op: 'fetch' | 'pull' | 'clone' | 'open';
  options?: { pullMode?: PullStrategy /* spec 09 */; cloneRoot?: string; protocol?: 'https' | 'ssh'; concurrency?: number; openIn?: 'app' | 'editor' } }
export interface BulkOpProgress { bulkId: string; repoId: string; state: 'queued' | 'running' | 'done' | 'failed' | 'skipped'; message?: string; progress?: number }
```

### 5.2 Launchpad

```ts
export type LaunchpadItemType = 'pr' | 'issue' | 'wip';
export type LaunchpadGroup = 'pinned' | 'current-branch' | 'needs-review' | 'ready-to-merge' | 'blocked'
  | 'follow-up' | 'waiting-for-review' | 'draft' | 'other' | 'snoozed';

export interface LaunchpadItemBase {
  uid: string;                     // `${type}:${integrationKey}:${scope}:${key}` or `wip:${repoPath}`
  type: LaunchpadItemType; title: string; updatedAt: string; webUrl?: string;
  repo?: { workspaceRepoId?: string; localPath?: string; fullName: string; provider?: ProviderKind | TrackerKind };
  involvement: Array<'author' | 'assignee' | 'reviewer' | 'review-requested' | 'mentioned' | 'creator'>;
}
export interface LaunchpadPr extends LaunchpadItemBase { type: 'pr'; pr: PullRequest }           // from spec 10
export interface LaunchpadIssue extends LaunchpadItemBase { type: 'issue'; issue: Issue }
export interface LaunchpadWip extends LaunchpadItemBase { type: 'wip'; status: RepoStatusSummary }
export type LaunchpadItem = LaunchpadPr | LaunchpadIssue | LaunchpadWip;

export interface LaunchpadGrouped { group: LaunchpadGroup; items: LaunchpadItem[]; priority: number }

export interface ItemUserState {               // pin/snooze, persisted
  uid: string; pinnedAt?: string;
  snooze?: { until?: string; untilUpdatedAfter?: string; indefinite?: boolean; snoozedAt: string };
}
export interface LaunchpadFilters {
  scope: { kind: 'all' } | { kind: 'workspace'; workspaceId: string };
  mode: 'personal' | 'team';
  providers?: string[]; repos?: string[]; labels?: string[]; authors?: string[];
  milestones?: string[]; sprints?: string[]; fixVersions?: string[];
  updatedWithin?: '24h' | '7d' | '30d' | 'any'; text?: string;
}
export interface SavedView { id: string; name: string; tab: 'prs' | 'issues' | 'wips' | 'all'; filters: LaunchpadFilters; groupBy: 'status' | 'repo' | 'provider' | 'none' }
export interface LaunchpadStateFile { version: 1; itemStates: Record<string, ItemUserState>; savedViews: SavedView[]; lastFilters: LaunchpadFilters }
// userData/launchpad.json (per profile)
```

### 5.3 Grouping rules (deterministic, implemented in `/packages/launchpad/classify.ts`, pure)

Evaluate in order; first match wins (for PRs):

| # | Group | Rule |
|---|---|---|
| 0 | `pinned` | `itemState.pinnedAt` set (still shown with sub-status glyphs) |
| 0' | `snoozed` | active snooze (not expired; `untilUpdatedAfter` < `updatedAt` cancels) → only in Snoozed tab |
| 1 | `current-branch` | PR head branch == checked-out branch of any open repo tab in scope |
| 2 | `blocked` | viewer is author AND (`mergeable == 'conflicting'` OR `checksRollup == 'failure'` OR `reviewDecision == 'changes_requested'`) |
| 3 | `ready-to-merge` | viewer is author or can merge AND state open (not draft) AND `checksRollup ∈ {success, none}` AND `reviewDecision ∈ {approved, null-but-no-required-reviews}` AND `mergeable == 'mergeable'` |
| 4 | `needs-review` | viewer in `reviewers` with state `pending` or review explicitly requested (user or team the viewer belongs to) AND viewer hasn't reviewed since last head push |
| 5 | `follow-up` | viewer is author AND new comments/reviews by others since viewer's last activity *(approximation: `updatedAt` > viewer's last comment/push)*; or viewer reviewed and author pushed new commits since ("re-review") |
| 6 | `waiting-for-review` | viewer is author, not draft, no approvals yet, reviewers requested or none assigned (sub-flag "No reviewers" shown in status column; counted in status bar) |
| 7 | `draft` | draft PRs where viewer is author |
| 8 | `other` | everything else (team mode, mentions) |

Issues: `pinned` → `current-branch` (issue linked to checked-out branch, spec 10 issue links) → `in-progress` (stateCategory in_progress, assigned to me) → `todo` → `other`. WIPs aren't grouped (sorted by last modified).

Within groups: pinned by `pinnedAt` desc; others by `updatedAt` desc. Group display order: pinned, current-branch, needs-review, blocked, ready-to-merge, follow-up, waiting-for-review, draft, other. Rules are versioned (`CLASSIFIER_VERSION`) and covered by table tests.

### 5.4 IPC channels

| Channel | Payload → Result |
|---|---|
| `workspace:list` | `() → Workspace[]` |
| `workspace:create` / `workspace:update` / `workspace:delete` / `workspace:reorder` | CRUD |
| `workspace:addRepos` / `workspace:removeRepos` | `{ workspaceId, repos: Partial<WorkspaceRepo>[] }` |
| `workspace:scanDirectory` | `{ root, depth, ignore } → Array<{ path, name, remotes }>` |
| `workspace:importCodeWorkspace` | `{ filePath } → Workspace` |
| `workspace:exportJson` / `workspace:importJson` | portability for local workspaces |
| `workspace:status` | `{ workspaceId } → RepoStatusSummary[]` (fast path; incremental updates via event) |
| `workspace:locate` | `{ workspaceId, repoId, path } → WorkspaceRepo` (validates remote matches) |
| `workspace:bulk` | `BulkOpRequest → { bulkId }` |
| `workspace:bulkCancel` | `{ bulkId }` |
| `workspace:openAll` | `{ workspaceId, repoIds? }` → opens repo tabs (spec 01) |
| `launchpad:query` | `{ filters, tab } → { items: LaunchpadItem[]; errors: Array<{ source: string; error: ProviderError }>; fetchedAt }` |
| `launchpad:refresh` | `{ force?: boolean }` |
| `launchpad:setItemState` | `{ uid, pin?: boolean, snooze?: ItemUserState['snooze'] \| null }` |
| `launchpad:views` / `launchpad:saveView` / `launchpad:deleteView` | saved views |
| `launchpad:summary` | `() → { needsReview: number; readyToMerge: number; blocked: number; noReviewers: number; conflicts: number }` |

Events: `workspace:changed`, `workspace:statusUpdated { workspaceId, summaries }`, `workspace:bulkProgress BulkOpProgress`, `launchpad:updated { fetchedAt, summary }`.

Mutating PR/issue actions (checkout, merge, create branch) reuse spec 10 channels (`pr:checkout`, `pr:merge`, `issues:createBranch`).

### 5.5 Main-process services

```
WorkspaceStore      — JSON persistence, atomic writes (write tmp + rename), schema migrations
WorkspaceStatus     — computes RepoStatusSummary with lightweight git commands; subscribes to RepoWatcher for open repos
DirectorySync       — chokidar watch on directory roots (depth-limited) to add/remove repos
BulkRunner          — p-limit concurrency (default 4), per-repo OperationQueue, cancel via AbortController
LaunchpadService    — fan-out queries to ProviderService/IssueTracker, merge, dedupe, classify, cache
```

TanStack Query keys: `['workspaces']`, `['workspace-status', id]`, `['launchpad', filtersHash, tab]`, `['launchpad-summary']`.

---

## 6. Git & provider implementation

### 6.1 Workspace repo status (per repo, read-only, concurrent ≤ 6)

1. `git -C {path} rev-parse --is-inside-work-tree --git-dir` → exists/isRepo.
2. `git -C {path} status --porcelain=v2 --branch --show-stash -z` → branch, upstream, `# branch.ab +A -B`, stash count (`# stash N`, git ≥ 2.35; else `git rev-list --walk-reflogs --count refs/stash`), entries counts (`1`/`2` ordinary/renamed with XY, `u` unmerged, `?` untracked). Use `--untracked-files=normal`; for huge repos honor `status.showUntrackedFiles` and a per-repo timeout (5 s → show "status timed out").
3. Operation in progress: check existence of `.git/MERGE_HEAD`, `rebase-merge/`, `rebase-apply/`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `BISECT_LOG`.
4. Last fetch: `stat .git/FETCH_HEAD` mtime.
5. Remote identity for provider matching: `git remote get-url origin` (and `upstream`).

Results cached in memory keyed by repo path with the watcher's `generation` counter; recomputed on watcher events (debounced 500 ms) or every 60 s for not-open repos when WorkspaceView is visible. Not computed at all when no workspace view or Launchpad WIP tab is visible.

### 6.2 Directory scan

Walk with `fs.opendir` to `depth`; a folder is a repo if it contains `.git` (dir or file → worktree/submodule; skip submodules unless includeNested). Skip ignore globs and symlink loops (track realpaths). Present results for confirmation; directory-synced workspaces apply adds/removes automatically and show a toast.

`.code-workspace` import: parse JSONC (strip comments, trailing commas); `folders[].path` relative to file dir; keep only folders that are (or are inside) git repos; name from file basename.

### 6.3 Bulk operations

- **Fetch**: `git fetch --all --prune --progress` per repo (spec 09 fetch with credentials/askpass), concurrency 4 (setting 1–16).
- **Pull**: per repo, refuse if WIP conflicts or operation in progress; mode → `git pull --ff-only` | `--no-rebase` | `--rebase` (spec 09). Results: "Up to date", "Fast-forwarded 3 commits", "Failed: diverged — open repo".
- **Clone missing**: for each repo without `localPath`: target `{cloneRoot}/{name}` (if exists and is the same remote → auto-locate; if exists and differs → `{name}-2`); protocol from preferences or SSH if a key is configured for that provider; `git clone --progress {url} {dir}`; set `localPath` on success.
- **Open**: opens repo tabs (cap 15 at once; confirm above that) or `code {path}` / configured editor.
- Each repo op goes through that repo's `OperationQueue`; the bulk runner aggregates progress events; cancel aborts running child processes (SIGTERM, then SIGKILL after 3 s) and marks remaining `skipped`.

### 6.4 Launchpad data fetching

**Sources** for scope = all: every connected integration (spec 10). For scope = workspace: repos in workspace with provider identity (from `provider` field or matched remotes) + issue trackers configured for the workspace (Jira projects / Trello boards are attached to a workspace via settings; default: all).

**Personal mode queries** (one search call per integration rather than per repo, to save rate limit):

| Provider | Query |
|---|---|
| GitHub | GraphQL `search(type: ISSUE, first: 50)` × 4 queries batched in one request with aliases: `is:open is:pr author:@me archived:false`, `is:open is:pr review-requested:@me`, `is:open is:pr assignee:@me`, `is:open is:pr mentions:@me` (+ `repo:o/r` terms when scoped to a workspace; split into multiple queries if > 250 chars). Same for `is:issue`. Request the PR fields of spec 10 §6.2. |
| GitLab | `GET /merge_requests?state=opened&scope=created_by_me`, `?reviewer_id={me}`, `?scope=assigned_to_me`; issues `GET /issues?scope=assigned_to_me&state=opened`; plus approvals per MR (GraphQL `currentUser { authoredMergeRequests, reviewRequestedMergeRequests, assignedMergeRequests }` with `approved`, `headPipeline.status`, `conflicts` — one call). |
| Bitbucket Cloud | `GET /pullrequests/{selected_user_uuid}?state=OPEN` (PRs authored, all repos) and per-workspace-repo `GET …/pullrequests?q=reviewers.uuid="{uuid}" AND state="OPEN"` (no cross-repo reviewer search → only for workspace repos or recently used repos, cap 30 repos). |
| Bitbucket DC | `GET /rest/api/latest/dashboard/pull-requests?state=OPEN&role=AUTHOR|REVIEWER` (cross-repo). |
| Azure DevOps | `GET https://dev.azure.com/{org}/_apis/git/pullrequests?searchCriteria.creatorId={me}&searchCriteria.status=active` and `reviewerId={me}` (org-level endpoint), per selected org. Work items via WIQL `@Me`. |
| Jira | JQL `assignee = currentUser() AND statusCategory != Done` (+ `OR reporter = currentUser()` when filter includes created), project filter from workspace. |
| Trello | `GET /1/members/me/cards?filter=open` (+ board filter). |

**Team mode** (requires workspace scope): per repo PR list (spec 10 `listPullRequests` with `preset: 'all'`), concurrency 4, issues per repo/project with no personal filter, cap 500 items/source with "showing first 500".

**Pipeline**:
1. `LaunchpadService.refresh()` dispatches all source fetches in parallel (per-integration concurrency limits from spec 10 HttpClient).
2. Normalize to `LaunchpadItem`; dedupe by `uid` merging `involvement` arrays.
3. Enrich: map PR head repo → workspace repo/local path; mark `current-branch` using RepoManager's open repos.
4. Apply user state (pin/snooze; expire snoozes).
5. Classify (§5.3), filter (§5.2), sort.
6. Cache snapshot in memory + persist to `userData/cache/launchpad-{profile}.json` (no bodies/comments, only list fields; for instant startup paint).
7. Emit `launchpad:updated` with summary for the status bar.

WIP items: `WorkspaceStatus` summaries with `wip` totals > 0 for repos in scope (scope all = recent repos + all workspace repos with localPath).

### 6.5 Refresh strategy

| Trigger | Action |
|---|---|
| App start | paint from disk cache (stale badge) → refresh after 3 s idle |
| Launchpad tab visible & window focused | refresh every **3 min** (personal), **5 min** (team) |
| Launchpad hidden, status bar indicator on | summary refresh every **10 min** (personal queries only) |
| Window blurred > 10 min | pause; refresh on focus if data older than 2 min |
| Manual Refresh / `R` | immediate, bypasses ETag cache (`force`) |
| Mutation (merge, checkout, create branch, pin) | optimistic update + targeted refetch of that item |
| Repo fetch/push completed (spec 09) | invalidate items for that repo |
| Rate-limit low for an integration | skip that source, show chip, use cached items |
| Offline | no requests; banner "Offline — showing data from …" |

Snooze expiry timer: main process sets a single `setTimeout` to the nearest `until`, re-classifies and emits update.

### 6.6 Optional cloud sync (spec 14)

When the user is signed in to our backend: workspaces of kind `cloud` sync via `GET/PUT /v1/workspaces` with `version` optimistic concurrency; pin/snooze state and saved views sync via `/v1/launchpad/state`. Without backend, everything is local; "Export/Import workspace JSON" gives a manual sharing path (paths are not exported; provider identity is, so import + "Clone missing" reproduces the workspace on another machine).

---

## 7. Step-by-step implementation plan

1. **Types & IPC contract** for workspaces and launchpad (`/src/shared/ipc/workspaces.ts`, `launchpad.ts`).
2. **WorkspaceStore** with atomic JSON writes, schema version, per-profile file; unit tests for CRUD/migrations/corrupt-file recovery (back up to `.bak`, start empty with toast).
3. **Repository Management sidebar WORKSPACES list** + NewWorkspaceDialog (Local kind) + edit/delete/reorder/hide.
4. **WorkspaceStatus**: porcelain-v2 parser (reuse spec 02 parser), op-in-progress detection, timeouts; RepoOverviewTable rendering with virtualized rows. Fixture test with 20 repos in mixed states.
5. **Directory scan + Directory-synced kind** with chokidar depth-limited watcher; `.code-workspace` import.
6. **BulkRunner**: fetch/pull/clone/open with concurrency, progress events, cancel; BulkToolbar UI with per-row progress. E2E: clone 5 repos from local bare fixtures.
7. **Locate** flow: pick folder, verify `git remote get-url` matches provider/remote URL (warn on mismatch).
8. **Provider-defined workspace** (cloud kind minus sharing): pick repos from integration (spec 10 `listRepos`), "Clone missing" with clone root.
9. **Launchpad classifier package** (`/packages/launchpad`): pure functions classify/filter/sort with ≥ 60 table-driven tests.
10. **LaunchpadService**: GitHub personal queries first (batched GraphQL), normalization, dedupe, user-state application, disk cache, summary.
11. **LaunchpadView UI**: pinned tab, header, filter bar, grouped virtualized list, row actions (checkout/open/pin/snooze), keyboard navigation, empty/error states.
12. **Pin/Snooze** persistence + expiry timer + Snoozed tab.
13. **Add GitLab, Bitbucket Cloud/DC, Azure DevOps** PR sources; **issue sources** (GitHub, GitLab, Jira, Trello, Azure Boards); Issues tab; Create branch from issue action.
14. **WIPs tab** from WorkspaceStatus.
15. **Saved views** + view tabs.
16. **Status bar indicator** + click-through to group.
17. **Workspace tabs** (Pull Requests / Issues / Branches) reusing LaunchpadList and branch matrix (`git for-each-ref --format='%(refname:short) %(upstream:track)' refs/heads` per repo).
18. **Home view** with compact Launchpad, recents, workspaces.
19. **Team mode** (workspace-scoped, per-repo listing) behind setting.
20. **Merge from Launchpad** with confirm popover.
21. **Optional cloud sync hooks** (spec 14) behind feature flag.
22. Performance pass: 2,000 items render < 100 ms; refresh with 5 integrations < 4 s on typical network; memory cap for cache.

---

## 8. Edge cases

- Workspace repo path deleted/moved → status `exists:false` → "Locate…" or "Clone"; never auto-remove (except directory-synced kind).
- Same repo in multiple workspaces → shared status cache by realpath.
- Repo path on unavailable network drive / unmounted volume → status timeout, row shows "Unavailable", bulk ops skip.
- Symlinked repo paths / case-insensitive filesystems (macOS/Windows) → normalize with `realpath` + case-fold on win32 for dedupe.
- Worktrees: a repo's linked worktrees listed as separate WIP rows only if added explicitly.
- Bulk pull on repo with uncommitted changes that would be overwritten → git error surfaced per row; suggest "autostash" option (`--autostash` for rebase mode).
- Bulk clone into folder without write permission / disk full → per-row failure, rest continue.
- Clone of large repos → progress per row, cancel works; partial dir cleaned up on cancel/failure.
- Directory-synced root containing 1,000+ repos → scan capped at 500 with warning; watcher depth limited.
- `.code-workspace` with folders outside any repo / remote URIs (`vscode-remote://`) → skipped with summary.
- Launchpad with no workspace and many orgs → GitHub search returns max 1,000 results; we cap at 200 per query and show "Refine filters".
- Same PR surfaces from two integrations (e.g. GHE + github.com mirror) → uid differs by host; acceptable.
- PR transferred/repo renamed → old uid disappears; pin/snooze state garbage-collected after 30 days unseen.
- Snooze "until updated" on item updated by the viewer themselves (e.g. they commented) → still unsnooze (simple rule) *(our choice)*.
- Clock changes / sleep-wake → recompute snooze expiry on `powerMonitor.resume`.
- Provider partially failing (Jira down) → other sources still render; summary computed from available data with "partial" marker.
- Team-mode on very large workspaces (50+ repos) → rate-limit aware sequential paging; show progress "Loaded 32/50 repos".
- GitHub `reviewDecision` null when branch protection doesn't require reviews → treat "no approvals needed" as ready if checks pass and mergeable.
- Draft PR that is also "needs my review" → draft rule applies only to author; reviewers see it in needs-review only if explicitly requested *(our choice)*.
- Profiles (spec 13): workspaces, launchpad state are per profile; switching profile reloads stores.

---

## 9. Acceptance criteria

- [ ] Create, edit, reorder, hide, delete local workspaces; persisted across restarts; corrupt file recovered with backup.
- [ ] Directory-synced workspace adds a newly cloned repo under the root within 5 s.
- [ ] `.code-workspace` import produces a workspace containing exactly the git repos referenced.
- [ ] Workspace overview shows branch, ahead/behind, WIP counts, stash count, op-in-progress, last fetch and PR counts for 30 repos in < 2 s (warm).
- [ ] Bulk Fetch/Pull/Clone/Open run with configurable concurrency, per-repo progress, cancel, and per-repo error reporting without aborting the batch.
- [ ] Clone missing repos for a provider-defined workspace reproduces the workspace on a clean machine.
- [ ] Launchpad shows PRs from GitHub, GitLab, Bitbucket (Cloud & DC), Azure DevOps and issues from GitHub, GitLab, Jira, Trello, Azure Boards in one list.
- [ ] Classifier table tests pass for all groups; fixture PRs land in expected groups.
- [ ] Pin moves item to top across restarts; snooze hides until expiry (1h/4h/tomorrow/next week/until updated/indefinite) and returns automatically.
- [ ] Filters and saved views work and persist; search finds by `#num`/`KEY-1`/title.
- [ ] Row actions: checkout PR (incl. fork), open in browser, merge from Ready to merge, create branch from issue.
- [ ] Partial provider failures shown as chips while other items remain visible.
- [ ] Status bar indicator counts match Launchpad groups and click navigates to the group.
- [ ] Polling pauses when blurred/offline/rate-limited; manual refresh always works.
- [ ] Startup paints cached Launchpad within 300 ms of window show.

---

## 10. Out of scope / later

- Sharing cloud workspaces with teams/users, org-level team Launchpad and Insights — spec 14 (optional backend).
- Real-time updates via provider webhooks (needs server) — polling only.
- Cross-repo atomic operations (multi-repo commit/branch create in one action) — later; Branches tab is read-only for v1 except "Create branch in selected repos" (P2).
- AI prioritization / summaries in Launchpad — spec 12 hooks later.
- Issue boards/kanban rendering — not planned.
- Code-suggestion indicators in Launchpad — only if spec 14 Code Suggest is built.
