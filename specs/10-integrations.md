# 10 — Hosting & Issue-Tracker Integrations

> Depends on: 00 (architecture), 02 (GitService/IPC contract), 03 (clone/open), 04 (graph badges), 05 (drag & drop), 09 (remotes, SSH, credentials), 13 (profiles/preferences).
> Consumed by: 11 (Workspaces & Launchpad), 14 (Code Suggest, cloud features).
> Roadmap: Phase 4 (spec 15 §8).

---

## 1. Purpose

GitHappens' biggest differentiator after the graph is that it "knows" where a repository is hosted. Once a user connects GitHub, GitLab, Bitbucket or Azure DevOps, the app can list and clone remote repositories, add forks as remotes, open/review/merge pull requests without leaving the client, show PR state directly on branches in the graph, generate and upload SSH keys, and show issues from GitHub/GitLab/Jira/Trello/Azure Boards with one-click "create branch from issue".

For us this spec defines:

- `AuthService` — OAuth (system browser + loopback/custom-protocol redirect + PKCE) and PAT fallback, token storage in the OS keychain, refresh, sign-out.
- `ProviderService` — a provider-agnostic TypeScript interface (`HostingProvider`, `IssueTracker`) with one implementation per service, normalized data models, rate-limit handling and caching.
- Renderer features — Integrations preferences, clone-from-provider, add-remote-from-fork, Create PR dialog, PULL REQUESTS and ISSUES sections in the left panel, the PR detail view, graph PR badges, CI/Actions section, avatars.

---

## 2. Reference behavior

Items marked *(inferred)* are design decisions rather than documented behavior.

### 2.1 Connecting a service

- All integrations live in **Preferences → Integrations**, one tab per service (GitHub, GitHub Enterprise, GitLab, GitLab Self-Managed, Bitbucket, Bitbucket Server/Data Center, Azure DevOps, Jira Cloud, Jira Data Center, Trello). They can also be started from the "Integrations" area of a new tab and from the empty state of the ISSUES section.
- **GitHub.com**: "Connect to GitHub" opens the system browser; after authorizing, the browser shows a success page and hands control back to the app. A manual token paste field exists for locked-down environments.
- **GitHub Enterprise / GitLab Self-Managed / Bitbucket Server-DC**: user enters the host URL, then clicks a "Generate token" link that opens the server's token page in the browser with the needed permissions; the token is pasted back. GitLab self-managed must be ≥ 13.1. Bitbucket Server support covers versions released within the last year; seeing PR reviewers needs Project Admin + Repository Admin token permissions.
- **Azure DevOps**: OAuth by default (requires the organization's "third-party application access via OAuth" policy to be on); PAT fallback with host domain if the org blocks OAuth. After OAuth, user picks an organization.
- **One account per service per profile.** Multiple accounts of the same service are handled with separate profiles (free — see §10).
- Organization access issues (GitHub OAuth app restrictions) are surfaced with guidance: request org approval / check third-party app restrictions.

### 2.2 Repository features

- **Clone**: the Clone dialog has a tab per connected provider listing the user's repositories (owned, collaborator, org) with search; selecting one fills the URL. Manual URL remains available.
- **Init/create remote repo**: create a repo on the provider (with .gitignore/license) and push the local one.
- **Fork**: fork a repository from within the app (GitHub) *(inferred: also GitLab)*.
- **Add remote**: the Add Remote dialog has a provider tab that lists the current repo's **forks** (owner avatars + names) so you can add a teammate's fork in one click.
- **Remote avatars**: remotes in the left panel and graph show the provider's owner avatar.
- **SSH keys**: "Generate SSH key and add to GitHub/GitLab/Bitbucket" creates a key pair and uploads the public key via API; for Azure DevOps and Bitbucket Server it is "generate and copy to clipboard" (user pastes into the web UI). A service-specific key can override the global SSH key from Preferences → SSH.

### 2.3 Pull requests

- **Create PR** entry points: drag one branch onto another in the graph or left panel → "Start a pull request from X to Y"; right-click target branch → "Start a pull request…"; the **+** button on the PULL REQUESTS section; command palette. Branch must be pushed first (the app offers to push).
- **Create PR form**: repo/remote + source/target branch pickers, title (defaults from branch name / single commit subject), description (markdown), reviewers, assignees, labels (availability varies by provider), template selector (templates committed in the repo, e.g. `.github/PULL_REQUEST_TEMPLATE/*.md`; must exist on the checked-out branch), "Submit as draft" (GitHub). A banner warns if source and target would conflict. GitHub.com additionally offers stacking ("add this PR to an existing stack").
- **PULL REQUESTS section** in left panel: lists open PRs for the repo's remotes, with built-in filters "My pull requests" / "All pull requests" plus user-defined filters using the provider's search syntax. Tooltip shows branches, author, timestamps, reviewers, assignees, labels, build status. A status icon summarizes: green (CI passed + approved), yellow (pending CI or reviews), red (failing CI or changes requested).
- **PR view** (opens as a tab-like view in the main area): editable title/description/reviewers/assignees/milestone/labels (GitHub), comment feed with add comment, refresh, quote-reply; build/check status that links to CI; double-click branch to check it out (prompts to add the fork's remote if missing); **Merge pull request** with merge / squash / rebase strategies; "Review code and suggest changes" (Code Suggest, spec 14); "Review on githappens.dev" for web review (we will add native approve, see §4.7).
- **Graph badges**: branches with an open PR show a PR icon on their ref label; hover shows PR number and stack position. A "merged" pill appears in the toolbar/commit details when the checked-out branch's PR was merged.
- **GitHub Actions**: older versions had a GITHUB ACTIONS left-panel section listing workflows and runs; version 11.10 removed it. We still build a lighter "CI" section because checks are valuable (see §4.8) — flagged optional.

### 2.4 Issues

- **ISSUES section** in left panel shows issues for the connected tracker; default filter "My issues" (assigned to me), plus custom filters. Supported: GitHub Issues, GitHub Enterprise, GitLab (+Self-Managed), Jira Cloud and Jira Data Center, Trello, Azure DevOps Boards *(Azure Boards listed as a Launchpad issue source; left-panel support inferred)*.
- **Issue detail** panel: title, description, status, assignee, labels, comments; edit fields and create issues (paid tiers; free tier is view-only).
- **Create branch from issue**: from the issue detail; branch name pre-filled from issue key + title; the branch is visually tagged with the tracker icon, and "View issue" appears in the branch context menu (link is stored locally *(inferred)*).

---

## 3. User stories

1. As a developer, I want to connect GitHub with one browser click so that I never handle tokens manually.
2. As an enterprise user, I want to connect GitHub Enterprise / GitLab Self-Managed / Bitbucket Data Center using my host URL and a PAT so that the app works behind my firewall.
3. As a user whose org blocks OAuth apps, I want a PAT fallback with an explicit list of required scopes.
4. As a user, I want to browse and search my provider repositories in the Clone dialog.
5. As a contributor, I want to add a teammate's fork as a remote by picking it from a list.
6. As a contributor, I want to drag my branch onto `main` and open a PR with title, body, reviewers, labels, template and draft flag.
7. As a reviewer, I want to see open PRs in the left panel with CI/review status at a glance.
8. As a reviewer, I want to read the PR description, comments, reviews and checks, approve or request changes, and merge with my chosen strategy — inside the app.
9. As a reviewer, I want to check out a PR (even from a fork) in one click.
10. As a user, I want branches in the graph to show a PR badge and status color.
11. As a user, I want to see recent CI runs for the current branch and re-run failed ones.
12. As a user, I want to see my Jira/GitHub/GitLab/Trello/Azure Boards issues and create a correctly named branch from an issue.
13. As a new user, I want the app to generate an SSH key and upload it to my provider.
14. As a security-conscious user, I want tokens stored only in the OS keychain and removable with "Disconnect".
15. As a user, I want clear messages when I hit rate limits or my token expires.

---

## 4. UI specification

### 4.1 Preferences → Integrations

```
PreferencesView
└─ IntegrationsPage
   ├─ IntegrationNav (vertical list; each row: logo, name, status dot)
   │   GitHub · GitHub Enterprise · GitLab · GitLab Self-Managed · Bitbucket ·
   │   Bitbucket Data Center · Azure DevOps · Jira Cloud · Jira Data Center · Trello
   └─ IntegrationPanel (for selected provider)
      ├─ DisconnectedState
      │   ├─ HostUrlField            (self-hosted only; validated, normalized)
      │   ├─ ConnectButton           ("Connect to GitHub" → OAuth)   [if OAuth supported]
      │   ├─ PatSection (collapsible "Use a personal access token instead")
      │   │   ├─ GenerateTokenLink   (opens provider token page with scopes prefilled)
      │   │   ├─ RequiredScopesList  (copyable)
      │   │   └─ TokenInput + ConnectWithTokenButton
      │   └─ OAuthWaitingOverlay     ("Waiting for browser…", Cancel, "Copy link")
      ├─ ConnectedState
      │   ├─ AccountCard (avatar, login, display name, host, token type, scopes, expiry)
      │   ├─ ScopeWarning (missing scope → "Reconnect to grant X")
      │   ├─ OrgSelector (Azure DevOps organizations / Jira sites, multi-select)
      │   ├─ SshKeySection  (Generate & upload | Upload existing | Copy public key)
      │   ├─ RateLimitIndicator (remaining / reset time)
      │   └─ DisconnectButton (confirm dialog; revokes token where API allows)
      └─ ErrorState (message + Retry + "Troubleshoot" link)
```

States: `disconnected | connecting | connected | expired | error`. Status dot: grey/blue (spinner)/green/amber/red.

The **OAuthWaitingOverlay** stays until (a) callback received, (b) user cancels, or (c) 5-minute timeout. "Copy link" lets users paste the authorize URL into a different browser profile.

### 4.2 Clone dialog provider tabs (extends spec 03)

```
CloneDialog
├─ Tabs: URL | GitHub | GitLab | Bitbucket | Azure DevOps | (self-hosted entries)
└─ ProviderRepoBrowser (provider tab)
   ├─ AccountSwitcher (if >1 account via profiles)
   ├─ OwnerFilter  (All / me / each org/group/workspace/project)
   ├─ SearchInput (debounced 250ms; server-side search when list > 500)
   ├─ RepoList (virtualized): avatar · owner/name · private lock · fork icon · updated · stars
   ├─ ProtocolToggle (HTTPS | SSH; default from Preferences)
   ├─ DestinationPicker
   └─ CloneButton
```
Empty: "Connect GitHub to browse your repositories" + Connect button. Error: "Some organizations are hidden because they restrict third-party apps" with a link to the provider's app-access page (GitHub: `https://github.com/settings/connections/applications/{client_id}`).

### 4.3 Add Remote dialog (extends spec 09)

Tabs `URL | <provider of origin>`. Provider tab shows **Forks of `owner/repo`** (and the parent if the current repo is a fork) with avatars; clicking fills name (`owner` login) and URL (HTTPS or SSH). Already-added forks are disabled with "Already added as `x`".

### 4.4 Create Pull Request

Entry points:
1. Drag source branch label onto target branch label (graph or left panel) → drop menu item **"Start a pull request from `feature` to `main`"** (only shown if both map to the same provider repo or fork network).
2. Context menu on a branch → **"Start a pull request to…"** (target defaults to repo default branch).
3. **+** on PULL REQUESTS section header.
4. Command palette: `Pull Request: Create`.

```
CreatePullRequestPanel (right-side panel or modal, 640px)
├─ Header: provider logo + "Create Pull Request"
├─ RepoRow:  [ Source: remote/owner ▾ ][ branch ▾ ]  →  [ Target: remote ▾ ][ branch ▾ ]
├─ UnpushedBanner      ("feature is not on origin — Push and continue")
├─ ConflictBanner      ("These branches have conflicts" — from local merge-tree check)
├─ ExistingPrBanner    ("PR #42 already exists for this branch — Open it")
├─ TemplateSelect      (None | template files found)
├─ TitleInput          (required; default rules below)
├─ BodyEditor          (markdown textarea + Preview tab; AI "Generate description" hook → spec 12)
├─ ReviewersPicker     (users + teams; async search; provider-capability gated)
├─ AssigneesPicker
├─ LabelsPicker        (colored chips)
├─ MilestonePicker     (GitHub/GitLab)
├─ Options: [ ] Draft  [ ] Delete source branch on merge (GitLab/Bitbucket/Azure) [ ] Squash (GitLab)
├─ CommitsPreview      (collapsible list from `git log target..source`)
└─ Footer: Cancel · Create Pull Request (spinner) 
```

Defaults:
- Title: if exactly one commit ahead → its subject; else branch name humanized (`feature/ABC-12-add-login` → `ABC-12 Add login`).
- Body: selected template content; if none and a single template file exists, preselect it.
- Draft checkbox hidden where unsupported (Bitbucket Cloud before draft support → hide *(inferred)*; Bitbucket DC hide).
- Fields not supported by a provider are hidden, never disabled-with-no-explanation (capability flags, §5.3).

After success: toast "PR #123 created" with "Open" (in-app view) and "Open on GitHub"; PR list and graph badges invalidate.

Shortcut: none by default; palette command bindable (spec 13).

### 4.5 Left panel — PULL REQUESTS section

```
LeftPanel
└─ PullRequestsSection (collapsible, count badge)
   ├─ Header: "PULL REQUESTS" · FilterDropdown · Refresh · +
   ├─ FilterDropdown: My pull requests · Review requested · All open · <custom filters> · Manage filters…
   └─ PrList (virtualized)
      └─ PrRow: status icon · #num · title · author avatar · (draft chip) · comment count
          ├─ hover → PrTooltip (src→target, author, created/updated, reviewers+state, assignees, labels, checks summary)
          ├─ click → open PullRequestView
          ├─ double-click → checkout PR branch
          └─ context menu: Open · Open in browser · Checkout · Checkout in new worktree · Copy link · Copy number · Merge… · Close
```

Status icon rules (rollup, §5.2 `PrRollupStatus`):
- `success`: checks success (or none) AND review decision approved (or not required).
- `failure`: any check failed OR changes requested OR mergeable === conflicting.
- `pending`: otherwise.

Empty states: no provider connected → "Connect GitHub to see pull requests"; connected but remote not on that provider → section hidden; zero PRs → "No open pull requests". Error → inline red line + Retry.

Custom filters: user-entered query string in provider syntax (GitHub search qualifiers like `is:pr review:required label:bug`; GitLab/Bitbucket/Azure use a structured form: author, reviewer, label, state). Stored per repo in `userData/repos/<repoId>/pr-filters.json`.

### 4.6 Graph PR badges (extends spec 04)

- A ref label whose branch (local tracking or remote) is the **head of an open PR** shows a small PR glyph after the name, tinted by rollup status (green/amber/red, grey for draft, purple when merged in the last 7 days).
- Hover: `#123 Add login (2 of 3 in stack) — 2 approvals, checks passing`.
- Click glyph → open PullRequestView.
- Mapping uses `PrIndex` (§5.4): `(remoteName, branchName) → PR[]` where head repo URL matches remote URL.
- Toolbar "Merged" pill: when HEAD branch's PR has state `merged`, show `PR #123 merged` pill with "Delete branch" quick action (calls spec 05 delete).

### 4.7 Pull Request View

Opens as a **center-area view** replacing the graph within the repo tab (back button returns to graph), or in a new app tab via middle-click *(our choice)*.

```
PullRequestView
├─ PrHeader
│   ├─ StateChip (Open/Draft/Merged/Closed) · #num · TitleInlineEdit
│   ├─ Meta: author avatar → "wants to merge N commits into main from feature"
│   │        (branches are clickable: double-click = checkout; missing fork remote → AddForkRemotePrompt)
│   ├─ StackNav (‹ 2/3 ›) when PR is part of a stack (GitHub)
│   └─ Actions: Refresh · Open in browser · Checkout · ⋯ (Close PR, Reopen, Convert to draft/Ready for review, Copy link)
├─ Tabs: Overview | Commits | Files changed | Checks
├─ OverviewTab
│   ├─ DescriptionCard (markdown render; Edit → markdown editor; task-list checkboxes toggle via edit)
│   ├─ Timeline (virtualized): comments, reviews (Approved / Changes requested / Commented),
│   │     review threads (file:line + diff hunk + replies, Resolve/Unresolve where supported),
│   │     commits pushed, label/assignee events, force-push events
│   ├─ CommentComposer (markdown, Preview, Ctrl+Enter submits, "Quote reply" from any comment)
│   └─ SidebarColumn
│       ├─ ReviewersBox (avatars + state icon; edit picker; "Re-request review")
│       ├─ AssigneesBox · LabelsBox · MilestoneBox
│       ├─ ChecksSummaryBox (n passed / failed / pending; each → Checks tab)
│       └─ LinkedIssuesBox (closing references parsed from body + provider linkage)
├─ CommitsTab: list (sha, subject, author, date); click → commit detail (spec 07) if object exists locally, else "Fetch PR to view"
├─ FilesChangedTab: file tree + Monaco diff (spec 07) computed LOCALLY after fetching PR head;
│      inline review comments shown as Monaco view zones; "Add comment" on line gutter (pending review)
├─ ChecksTab: grouped by workflow/pipeline: name, status, duration, "View logs" (browser), "Re-run" (if supported)
└─ MergeBox (bottom of Overview)
    ├─ Mergeability line: "No conflicts" / "Conflicts must be resolved" / "Blocked by required reviews/checks" / "Checking…"
    ├─ ReviewSubmit: [Comment] [Approve] [Request changes] + summary textarea (submits pending inline comments as one review)
    ├─ MergeSplitButton: Create merge commit ▾ | Squash and merge | Rebase and merge  (only allowed methods)
    ├─ Commit title/message editor for merge/squash (prefilled per provider defaults)
    ├─ [ ] Delete source branch after merge
    └─ Auto-merge toggle (GitHub/GitLab/Azure, when allowed)
```

Loading: skeleton header + timeline. Errors per box (checks failing to load doesn't break the view). Permission-aware: merge button disabled with tooltip when `viewerCanMerge` false.

Shortcuts: `Ctrl/Cmd+Enter` submit comment; `R` refresh when view focused; `Esc` back to graph.

### 4.8 CI / GitHub Actions section (optional, P2)

```
CiSection ("ACTIONS" for GitHub, "PIPELINES" for GitLab/Azure/Bitbucket)
├─ WorkflowGroup (per workflow file) → RunRow: status icon · run #, branch, event, actor, age
│     context: Open in browser · Re-run · Re-run failed jobs · Cancel
└─ Filter: Current branch | All branches
```
Default collapsed; polled only when expanded (60s; 15s if any run in progress).

### 4.9 ISSUES section & Issue panel

```
IssuesSection
├─ Header: tracker selector (icon dropdown: GitHub Issues / GitLab / Jira site / Trello board / Azure Boards project) · Filter · Refresh · + (create issue)
├─ Filter: My issues (default) · Created by me · Mentioned · All open · <custom: JQL / GitHub query / Trello list / WIQL>
└─ IssueList → IssueRow: type icon · key (#12 / ABC-12) · title · status chip · assignee avatar
        click → IssueDetailPanel (right panel)

IssueDetailPanel
├─ Key + TitleInlineEdit · StatusSelect (provider transitions) · Assignee · Labels · Priority (Jira) · Sprint/FixVersion (Jira) · Milestone
├─ Description (markdown; Jira ADF → markdown converter, read-only for ADF tables)
├─ Comments (+ add)
└─ Actions: [Create branch] [Open in browser] [Copy link]

CreateBranchFromIssueDialog
├─ BranchNameInput (template, default "{key}-{title-slug}", e.g. ABC-12-add-login-form; GitHub: "{number}-{slug}")
├─ BaseRefSelect (default: default branch / HEAD)
├─ [x] Checkout after create   [ ] Transition issue to "In Progress" (Jira/Azure)  [ ] Assign to me
└─ Create
```

Branch ↔ issue link is stored locally (`userData/repos/<repoId>/issue-links.json`: `branch → IssueRef`) and also inferred by parsing branch names (`/([A-Z][A-Z0-9]+-\d+)/` for Jira, `^(\d+)-` for GitHub/GitLab). Linked branches get the tracker icon on their ref label; branch context menu gets "View issue ABC-12".

### 4.10 Avatars

`AvatarService` (main): resolves avatar URL by (provider account, email) → cached image file in `userData/avatars/<sha1>.png` (TTL 7 days). Order: provider commit-author mapping (GitHub GraphQL `commit.author.user.avatarUrl` via PR/commit APIs) → provider user search by email (GitLab `/avatar?email=`) → Gravatar (`https://www.gravatar.com/avatar/<sha256(email)>?d=404`, opt-out setting) → generated initials. Renderer uses `githappens-avatar://<hash>` custom protocol to serve cached files (no remote loads from renderer; CSP stays strict).

---

## 5. Data model & IPC

### 5.1 Identifiers

```ts
export type ProviderKind = 'github' | 'gitlab' | 'bitbucket' | 'bitbucket-dc' | 'azure-devops';
export type TrackerKind  = 'github' | 'gitlab' | 'jira-cloud' | 'jira-dc' | 'trello' | 'azure-boards';

export interface IntegrationId {           // one connected account
  kind: ProviderKind | TrackerKind;
  host: string;                            // 'github.com', 'ghe.acme.com', 'dev.azure.com', 'acme.atlassian.net'
  accountId: string;                       // provider user id (stable)
}
export const integrationKey = (i: IntegrationId) => `${i.kind}:${i.host}:${i.accountId}`;

export interface RepoRef {                 // provider-side repo identity
  integration: IntegrationId;
  owner: string;                           // GH owner / GL namespace path / BB workspace / BBDC project key / Azure "org/project"
  name: string;                            // repo slug
  id?: string;                             // provider numeric/guid id
}
```

### 5.2 Normalized models

```ts
export interface ProviderUser { id: string; login: string; name?: string; avatarUrl?: string; email?: string; isTeam?: boolean; }

export interface RemoteRepo {
  ref: RepoRef; fullName: string; description?: string; isPrivate: boolean; isFork: boolean;
  parent?: RepoRef; defaultBranch: string; httpsUrl: string; sshUrl: string; webUrl: string;
  updatedAt: string; stars?: number; viewerPermission?: 'read' | 'triage' | 'write' | 'maintain' | 'admin';
}

export type PrState = 'open' | 'draft' | 'merged' | 'closed';
export type ReviewState = 'approved' | 'changes_requested' | 'commented' | 'pending' | 'dismissed';
export type CheckStatus = 'queued' | 'in_progress' | 'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required';
export type PrRollupStatus = 'success' | 'pending' | 'failure' | 'none';
export type MergeMethod = 'merge' | 'squash' | 'rebase' | 'rebase-merge' | 'semi-linear' | 'fast-forward';

export interface PullRequest {
  repo: RepoRef; number: number; id: string; title: string; body: string; state: PrState;
  author: ProviderUser; createdAt: string; updatedAt: string; mergedAt?: string; closedAt?: string;
  head: { repo: RepoRef | null; repoCloneUrl?: string; branch: string; sha: string };   // repo null => deleted fork
  base: { repo: RepoRef; branch: string; sha?: string };
  reviewers: Array<{ user: ProviderUser; state: ReviewState; required?: boolean }>;
  assignees: ProviderUser[]; labels: Array<{ name: string; color?: string }>; milestone?: { id: string; title: string };
  reviewDecision?: 'approved' | 'changes_requested' | 'review_required' | null;
  mergeable?: 'mergeable' | 'conflicting' | 'unknown';
  checksRollup: PrRollupStatus; rollup: PrRollupStatus;
  commentsCount: number; additions?: number; deletions?: number; changedFiles?: number;
  webUrl: string; isCrossRepository: boolean;
  viewer: { canMerge: boolean; canEdit: boolean; canApprove: boolean; isAuthor: boolean; reviewRequested: boolean };
  allowedMergeMethods: MergeMethod[];
  stack?: { position: number; size: number; prev?: number; next?: number };
  etag?: string;                            // for conditional refresh
}

export type TimelineItem =
  | { kind: 'comment'; id: string; author: ProviderUser; body: string; createdAt: string; editable: boolean }
  | { kind: 'review'; id: string; author: ProviderUser; state: ReviewState; body: string; createdAt: string }
  | { kind: 'thread'; id: string; path: string; line?: number; side?: 'LEFT' | 'RIGHT'; diffHunk?: string;
      resolved: boolean; outdated: boolean; comments: Array<{ id: string; author: ProviderUser; body: string; createdAt: string }> }
  | { kind: 'commits'; shas: string[]; actor?: ProviderUser; createdAt: string; forced?: boolean }
  | { kind: 'event'; event: string; actor?: ProviderUser; createdAt: string; detail?: string };

export interface CheckRun {
  id: string; name: string; group?: string;             // workflow / pipeline / build definition
  status: CheckStatus; startedAt?: string; completedAt?: string; detailsUrl?: string;
  canRerun: boolean; provider: 'actions' | 'gitlab-ci' | 'bitbucket-pipelines' | 'azure-pipelines' | 'status-api' | 'other';
}

export interface Issue {
  tracker: { kind: TrackerKind; integration: IntegrationId; scope: string };  // scope: repo full name / Jira site+project / Trello board / Azure org/project
  key: string;                                           // '#12', 'ABC-12', Trello shortLink, Azure id
  id: string; title: string; body: string; bodyFormat: 'markdown' | 'adf' | 'html';
  state: string; stateCategory: 'todo' | 'in_progress' | 'done';
  type?: string; priority?: string; assignees: ProviderUser[]; reporter?: ProviderUser;
  labels: string[]; sprint?: string; fixVersions?: string[]; milestone?: string;
  createdAt: string; updatedAt: string; webUrl: string; commentsCount?: number;
}
export interface IssueRef { trackerKind: TrackerKind; integrationKey: string; scope: string; key: string; webUrl: string; }
```

### 5.3 Provider abstraction

Lives in `/packages/providers`. Pure TS, no Electron imports; receives an `HttpClient` (injected, with auth + rate-limit middleware) so it can be unit tested with `msw`.

```ts
export interface ProviderCapabilities {
  oauth: boolean; pat: boolean; graphql: boolean;
  prDraft: boolean; prLabels: boolean; prAssignees: boolean; prMilestone: boolean; prTeamsAsReviewers: boolean;
  prTemplates: boolean; prAutoMerge: boolean; prStacks: boolean; reviewThreadsResolve: boolean;
  mergeMethods: MergeMethod[]; sshKeyUpload: boolean; forkList: boolean; createRepo: boolean;
  ci: boolean; ciRerun: boolean; issues: boolean; prRefspec: string | null;   // e.g. 'refs/pull/{n}/head'
}

export interface ListPage<T> { items: T[]; nextCursor?: string; total?: number }

export interface HostingProvider {
  readonly kind: ProviderKind;
  readonly capabilities: ProviderCapabilities;

  // identity
  getViewer(): Promise<ProviderUser>;
  getGrantedScopes(): Promise<string[]>;

  // repos
  listRepos(opts: { owner?: string; query?: string; cursor?: string; pageSize?: number }): Promise<ListPage<RemoteRepo>>;
  listOwners(): Promise<Array<{ login: string; avatarUrl?: string; kind: 'user' | 'org' | 'group' | 'workspace' | 'project' }>>;
  getRepo(ref: RepoRef): Promise<RemoteRepo>;
  listForks(ref: RepoRef, cursor?: string): Promise<ListPage<RemoteRepo>>;
  createFork?(ref: RepoRef, opts?: { owner?: string }): Promise<RemoteRepo>;
  createRepo?(opts: { owner?: string; name: string; private: boolean; description?: string; gitignore?: string; license?: string }): Promise<RemoteRepo>;
  matchRemoteUrl(url: string): Omit<RepoRef, 'integration'> | null;  // pure parse

  // pull requests
  listPullRequests(ref: RepoRef, filter: PrFilter, cursor?: string): Promise<ListPage<PullRequest>>;
  getPullRequest(ref: RepoRef, number: number, opts?: { etag?: string }): Promise<PullRequest | 'not-modified'>;
  getTimeline(ref: RepoRef, number: number, cursor?: string): Promise<ListPage<TimelineItem>>;
  getChecks(ref: RepoRef, sha: string): Promise<CheckRun[]>;
  listPrTemplates(ref: RepoRef, branch: string): Promise<Array<{ name: string; path: string; body: string }>>; // remote fallback; local read preferred
  searchUsers(ref: RepoRef, query: string): Promise<ProviderUser[]>;   // assignable users/teams
  listLabels(ref: RepoRef): Promise<Array<{ name: string; color?: string }>>;
  listMilestones?(ref: RepoRef): Promise<Array<{ id: string; title: string }>>;
  createPullRequest(input: CreatePrInput): Promise<PullRequest>;
  updatePullRequest(ref: RepoRef, number: number, patch: UpdatePrInput): Promise<PullRequest>;
  addComment(ref: RepoRef, number: number, body: string, inReplyTo?: string): Promise<TimelineItem>;
  submitReview(ref: RepoRef, number: number, input: SubmitReviewInput): Promise<void>;
  setThreadResolved?(ref: RepoRef, threadId: string, resolved: boolean): Promise<void>;
  merge(ref: RepoRef, number: number, input: { method: MergeMethod; title?: string; message?: string; deleteBranch?: boolean; expectedHeadSha: string }): Promise<{ merged: boolean; sha?: string; message?: string }>;
  setAutoMerge?(ref: RepoRef, number: number, method: MergeMethod | null): Promise<void>;
  close(ref: RepoRef, number: number): Promise<void>;
  reopen?(ref: RepoRef, number: number): Promise<void>;
  setDraft?(ref: RepoRef, number: number, draft: boolean): Promise<void>;

  // CI
  listCiRuns?(ref: RepoRef, opts: { branch?: string; cursor?: string }): Promise<ListPage<CheckRun & { runNumber?: number; branch?: string; event?: string; actor?: ProviderUser }>>;
  rerunCi?(ref: RepoRef, runId: string, opts?: { failedOnly?: boolean }): Promise<void>;
  cancelCi?(ref: RepoRef, runId: string): Promise<void>;

  // SSH
  uploadSshKey?(title: string, publicKey: string): Promise<{ id: string }>;
  listSshKeys?(): Promise<Array<{ id: string; title: string; fingerprint?: string }>>;
}

export interface PrFilter { preset?: 'mine' | 'review-requested' | 'assigned' | 'all'; state?: 'open' | 'closed' | 'merged' | 'all'; query?: string; author?: string; head?: string; }
export interface CreatePrInput { base: RepoRef; baseBranch: string; head: RepoRef; headBranch: string; title: string; body: string; draft?: boolean;
  reviewers?: string[]; teamReviewers?: string[]; assignees?: string[]; labels?: string[]; milestone?: string; deleteSourceBranch?: boolean; squash?: boolean; }
export type UpdatePrInput = Partial<Pick<CreatePrInput, 'title' | 'body' | 'reviewers' | 'teamReviewers' | 'assignees' | 'labels' | 'milestone' | 'baseBranch'>> & { state?: 'open' | 'closed' };
export interface SubmitReviewInput { event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'; body?: string;
  comments?: Array<{ path: string; line: number; side: 'LEFT' | 'RIGHT'; startLine?: number; body: string }>; commitSha: string; }

export interface IssueTracker {
  readonly kind: TrackerKind;
  listScopes(): Promise<Array<{ scope: string; label: string }>>;   // repos / Jira projects / Trello boards / Azure projects
  listIssues(scope: string, filter: IssueFilter, cursor?: string): Promise<ListPage<Issue>>;
  getIssue(scope: string, key: string): Promise<Issue>;
  createIssue?(scope: string, input: { title: string; body?: string; type?: string; assignees?: string[]; labels?: string[] }): Promise<Issue>;
  updateIssue?(scope: string, key: string, patch: Partial<{ title: string; body: string; assignees: string[]; labels: string[] }>): Promise<Issue>;
  listTransitions?(scope: string, key: string): Promise<Array<{ id: string; name: string; toCategory: Issue['stateCategory'] }>>;
  transition?(scope: string, key: string, transitionId: string): Promise<void>;
  addComment?(scope: string, key: string, body: string): Promise<void>;
  listComments?(scope: string, key: string): Promise<Array<{ id: string; author: ProviderUser; body: string; createdAt: string }>>;
}
export interface IssueFilter { preset?: 'assigned' | 'created' | 'mentioned' | 'all-open'; query?: string /* JQL, GH query, WIQL */; updatedSince?: string; }
```

Capability matrix (initial values):

| Capability | GitHub/GHE | GitLab/SM | Bitbucket Cloud | Bitbucket DC | Azure DevOps |
|---|---|---|---|---|---|
| OAuth | yes (GHE: PAT default, OAuth if user registers app) | yes (SM: PAT default) | yes | no (PAT) | yes (Entra ID) |
| GraphQL | yes | yes (partial use) | no | no | no |
| Draft | yes | yes ("Draft:" prefix / `draft` param) | yes *(inferred, API `draft` field)* | no | yes (`isDraft`) |
| Labels | yes | yes | no | no | yes (tags) |
| Milestone | yes | yes | no | no | no |
| Team reviewers | yes | no (groups via approval rules) | no | no | yes (groups) |
| Merge methods | merge/squash/rebase (repo-allowed) | merge/squash (+ ff/semi-linear per project) | merge/squash/fast-forward | merge strategies from repo settings | merge/squash/rebase/rebase-merge |
| PR refspec | `refs/pull/{n}/head` | `refs/merge-requests/{n}/head` | none (fetch head repo) | `refs/pull-requests/{n}/from` | `refs/pull/{n}/merge` (merge commit only) |
| SSH upload | yes (`admin:public_key`/`write:public_key`) | yes | yes | no (copy) | no (copy) |
| CI | Actions + checks + statuses | Pipelines | Pipelines (statuses) | build statuses | Pipelines/build statuses |

### 5.4 Main-process services

```ts
// AuthService — owns tokens; renderer never sees a token.
interface StoredCredential {
  integrationKey: string; type: 'oauth' | 'pat';
  accessToken: string; refreshToken?: string; expiresAt?: number; scopes: string[];
  tokenEndpoint?: string; clientId?: string;
}
// Persisted via SecretStore (spec 13 §5.1): account `<profileId>/integration/<integrationKey>`, secret = JSON(StoredCredential)
// Non-secret metadata in userData/integrations.json: { integrations: Array<IntegrationId & { login, avatarUrl, host, connectedAt, profileId }> }

// ProviderService
class ProviderService {
  forRemote(repoId: string, remoteName: string): Promise<{ provider: HostingProvider; ref: RepoRef } | null>;
  forIntegration(key: string): HostingProvider;
  tracker(key: string): IssueTracker;
}

// PrIndex — per open repo, maps branches to PRs for badges
interface PrIndexEntry { remote: string; branch: string; pr: Pick<PullRequest, 'number' | 'title' | 'state' | 'rollup' | 'stack' | 'webUrl'> }
```

### 5.5 IPC channels

Request/response (`ipcRenderer.invoke`), all typed in `/src/shared/ipc/integrations.ts`. Errors are returned as `{ ok: false, error: ProviderError }`.

```ts
export type ProviderErrorCode = 'auth_required' | 'token_expired' | 'insufficient_scope' | 'rate_limited' | 'not_found'
  | 'forbidden_org_policy' | 'network' | 'conflict' | 'validation' | 'unsupported' | 'server';
export interface ProviderError { code: ProviderErrorCode; message: string; retryAt?: number; missingScopes?: string[]; providerMessage?: string; helpUrl?: string }
```

| Channel | Payload → Result |
|---|---|
| `auth:list` | `() → ConnectedIntegration[]` |
| `auth:startOAuth` | `{ kind, host? } → { flowId }` (opens browser) |
| `auth:cancelOAuth` | `{ flowId } → void` |
| `auth:connectPat` | `{ kind, host, token, username? } → ConnectedIntegration` (validates first) |
| `auth:disconnect` | `{ integrationKey, revoke: boolean } → void` |
| `auth:tokenPageUrl` | `{ kind, host } → string` (PAT creation URL with scopes) |
| `provider:listOwners` / `provider:listRepos` / `provider:listForks` | as interface |
| `provider:resolveRemote` | `{ repoId, remote } → RepoRef \| null` |
| `provider:createRepo` / `provider:fork` | as interface |
| `pr:list` | `{ repoId, filter } → PullRequest[]` (aggregates all provider remotes) |
| `pr:get` / `pr:timeline` / `pr:checks` | as interface |
| `pr:create` / `pr:update` / `pr:comment` / `pr:review` / `pr:merge` / `pr:close` / `pr:setDraft` / `pr:resolveThread` | as interface |
| `pr:checkout` | `{ repoId, ref, number, mode: 'branch' \| 'worktree' } → { branch }` (git, §6.3) |
| `pr:templates` | `{ repoId, branch } → Template[]` (local first) |
| `pr:searchUsers` / `pr:labels` / `pr:milestones` | lookup |
| `pr:conflictCheck` | `{ repoId, source, target } → { conflicts: boolean; files: string[] }` |
| `ci:list` / `ci:rerun` / `ci:cancel` | |
| `issues:scopes` / `issues:list` / `issues:get` / `issues:create` / `issues:update` / `issues:transitions` / `issues:transition` / `issues:comment` | |
| `issues:createBranch` | `{ repoId, issue: IssueRef, branchName, base, checkout, transitionId?, assignSelf? } → { branch }` |
| `issues:linkForBranch` | `{ repoId, branch } → IssueRef \| null` |
| `ssh:generateAndUpload` | `{ integrationKey, title, keyType: 'ed25519' \| 'rsa', passphrase? } → { publicKey, path, uploaded: boolean }` |
| `avatar:resolve` | `{ email?, login?, integrationKey? } → string` (githappens-avatar:// URL) |

Events (`main → renderer`):

| Event | Payload |
|---|---|
| `auth:changed` | `{ integrations: ConnectedIntegration[] }` |
| `auth:oauthProgress` | `{ flowId, phase: 'browser-opened' \| 'exchanging' \| 'done' \| 'error', error? }` |
| `provider:rateLimit` | `{ integrationKey, remaining, limit, resetAt }` |
| `pr:indexUpdated` | `{ repoId, entries: PrIndexEntry[] }` |
| `auth:reauthRequired` | `{ integrationKey, reason }` |

Renderer data layer: TanStack Query keys `['pr','list',repoId,filterKey]`, `['pr',integrationKey,owner,name,number]`, `['pr','timeline',…]`, `['pr','checks',…,sha]`, `['issues',integrationKey,scope,filterKey]`, `['repos',integrationKey,owner,query]`. Mutations invalidate the matching keys plus `pr:index`.

---

## 6. Git & provider implementation

### 6.1 OAuth flows (AuthService)

General algorithm (RFC 8252 native-app pattern):

1. Generate `state` (32 random bytes, base64url) and PKCE `code_verifier` (43–128 chars) + `code_challenge = BASE64URL(SHA256(verifier))`.
2. Choose redirect:
   - **Loopback** (preferred): start `http.createServer` on `127.0.0.1`, port `0` (ephemeral) or a fixed registered port when the provider demands exact match; redirect `http://127.0.0.1:{port}/callback`.
   - **Custom protocol** (for providers that require a fixed redirect URL, e.g. Bitbucket Cloud consumers *(inferred)*): `githappens://oauth/callback`, registered via `app.setAsDefaultProtocolClient('githappens')`; on Windows/Linux the URL arrives via `second-instance` argv, on macOS via `open-url`.
3. `shell.openExternal(authorizeUrl)` — never an embedded BrowserWindow (password managers, SSO, 2FA, and providers block embedded webviews).
4. Callback handler validates `state`, responds with a small HTML page ("You can close this tab and return to GitHappens") and closes the server.
5. Exchange `code` (+ `code_verifier`) at the token endpoint **from the main process**.
6. Call `getViewer()` + read granted scopes; store credential in keytar; emit `auth:changed`.

**Client secrets.** Desktop apps cannot keep secrets. Strategy per provider:
- Providers supporting public PKCE clients (GitLab, Microsoft Entra ID, Atlassian *(requires secret — see below)*) → no secret.
- Providers requiring a secret (GitHub OAuth Apps, Bitbucket Cloud, Atlassian 3LO) → configurable **OAuth Broker**: a ~50-line stateless HTTPS function we host (`POST /token/{provider}` and `POST /refresh/{provider}` add the secret and forward to the provider; never logs tokens; see `services/oauth-broker`). Configured with `GH_OAUTH_BROKER_URL`; client ids with `GH_OAUTH_<KIND>_CLIENT_ID`. If absent (self-builders), GitHub falls back to **Device Flow** (`POST https://github.com/login/device/code`, show user code, poll `https://github.com/login/oauth/access_token` — no secret needed, must be enabled on the OAuth app) and others fall back to PAT.
- Refresh: before each request, if `expiresAt - now < 120s` refresh via token endpoint (through broker if needed); single-flight lock per integration so concurrent requests share one refresh. Refresh failure → `auth:reauthRequired`.

Per-provider parameters:

| Provider | Authorize / token endpoints | Scopes | Notes |
|---|---|---|---|
| GitHub.com | `https://github.com/login/oauth/authorize`, `/login/oauth/access_token` | `repo read:org read:user user:email workflow write:public_key` (+ `admin:public_key` only if listing/deleting keys) | OAuth App tokens don't expire; loopback redirect may use any port when registered callback is `http://127.0.0.1/callback`. `workflow` needed to push `.github/workflows` changes. Scopes reported in `X-OAuth-Scopes` header. |
| GitHub Enterprise Server | `https://{host}/login/oauth/...`, API `https://{host}/api/v3`, GraphQL `https://{host}/api/graphql` | same (classic PAT) | Default PAT (`https://{host}/settings/tokens/new?scopes=repo,read:org,...&description=GitHappens`). Fine-grained PATs supported but scope introspection limited → treat as "unknown scopes", probe on use. |
| GitLab.com | `https://gitlab.com/oauth/authorize`, `/oauth/token` | `api read_user read_repository write_repository` (`api` covers MRs, issues, keys) | Public PKCE app, tokens expire in 2h → refresh tokens (rotating; persist new refresh token atomically). |
| GitLab Self-Managed | same paths on `{host}` | PAT scopes `api, read_user, write_repository` | Token page: `https://{host}/-/user_settings/personal_access_tokens?name=GitHappens&scopes=api,read_user,write_repository`. Optional: user supplies own OAuth application ID for SM. Check `GET /api/v4/version` ≥ 13.1. |
| Bitbucket Cloud | `https://bitbucket.org/site/oauth2/authorize`, `/site/oauth2/access_token` | `account repository:write pullrequest:write issue:write pipeline webhook` *(webhook unused)* + `account:write` for SSH key upload *(scope names per Atlassian docs; verify at build time)* | Secret required → broker. Access tokens 2h, refresh. Fallback: Atlassian **API token** with scopes (app passwords are deprecated) used with Basic auth `email:token`. |
| Bitbucket Data Center/Server | — | HTTP access token: Repository write (+ Project admin for reviewers listing) | Bearer token. API `https://{host}/rest/api/latest`. Token page `https://{host}/plugins/servlet/access-tokens/manage`. |
| Azure DevOps | Microsoft Entra ID v2: `https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize` and `/token` | `499b84ac-1321-427f-aa17-267ca6975798/.default offline_access` (Azure DevOps resource) | Legacy Azure DevOps OAuth is closed to new apps → use Entra public client + PKCE + loopback. List orgs: `GET https://app.vssps.visualstudio.com/_apis/profile/profiles/me` then `GET https://app.vssps.visualstudio.com/_apis/accounts?memberId={id}`. PAT fallback scopes: Code (Read & write), Work Items (Read & write), Build (Read & execute), User Profile (Read), Project and Team (Read), Graph (Read). PAT auth = Basic `:{pat}`. |
| Jira Cloud | `https://auth.atlassian.com/authorize` (audience `api.atlassian.com`), `/oauth/token` | `read:jira-work write:jira-work read:jira-user offline_access` | Rotating refresh tokens; site list `GET https://api.atlassian.com/oauth/token/accessible-resources` → cloudId; API base `https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3`. Fallback: email + API token Basic against `https://{site}.atlassian.net/rest/api/3`. |
| Jira Data Center | — | PAT (Bearer) | API `https://{host}/rest/api/2`. |
| Trello | `https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&key={appKey}&return_url={loopback}` | read, write | Token returns in URL **fragment** → loopback page includes JS that POSTs `location.hash` to `/token` on the loopback server. Requests use `key` + `token` query params (main process only; never logged). |

**HTTPS git credentials.** When a remote maps to a connected integration, `GitService` supplies the token to git via our askpass helper (spec 09 §6.6 / §11, shared function `gitHttpCredentialFor`). Username per provider: GitHub `x-access-token`, GitLab `oauth2`, Bitbucket Cloud `x-token-auth`, Bitbucket DC `{username}` with token as password, Azure any non-empty user + token. Do not write tokens into `.git/config` or URLs.

### 6.2 API calls per feature

**GitHub (REST `https://api.github.com`, GraphQL `/graphql`, header `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`)**

| Feature | Call |
|---|---|
| Viewer | `GET /user`, scopes from `X-OAuth-Scopes`; `GET /user/emails` |
| Owners | `GET /user/orgs` |
| Repos | `GET /user/repos?affiliation=owner,collaborator,organization_member&sort=updated&per_page=100`; search `GET /search/repositories?q={q}+user:{login}` / `fork:true` |
| Forks | `GET /repos/{o}/{r}/forks?per_page=100&sort=newest` |
| Fork / create | `POST /repos/{o}/{r}/forks`; `POST /user/repos` or `/orgs/{org}/repos` (`gitignore_template`, `license_template`) |
| PR list (one query per repo) | GraphQL `repository(owner,name){ pullRequests(states:OPEN, first:50, orderBy:{field:UPDATED_AT,direction:DESC}){ nodes{ number title isDraft state author{login avatarUrl} headRefName headRefOid headRepository{nameWithOwner url sshUrl} baseRefName reviewDecision mergeable updatedAt comments{totalCount} reviewRequests(first:10){…} latestOpinionatedReviews(first:10){nodes{state author{login}}} labels(first:10){nodes{name color}} commits(last:1){nodes{commit{statusCheckRollup{state}}}} viewerCanUpdate } } }`. Presets via `search(type:ISSUE, query:"repo:o/r is:pr is:open author:@me")` / `review-requested:@me`. |
| PR detail | GraphQL by `pullRequest(number:)` incl. `timelineItems(first:100, itemTypes:[ISSUE_COMMENT, PULL_REQUEST_REVIEW, PULL_REQUEST_COMMIT, HEAD_REF_FORCE_PUSHED_EVENT, LABELED_EVENT, …])`, `reviewThreads(first:100){ isResolved isOutdated path line diffSide comments{…} }`, `viewerCanMergeAsAdmin`, repository `mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed` |
| Checks | GraphQL `statusCheckRollup.contexts` (CheckRun + StatusContext) or REST `GET /repos/{o}/{r}/commits/{sha}/check-runs` + `/status` |
| Create | `POST /repos/{o}/{r}/pulls` `{title, body, head: "forkOwner:branch", base, draft}` then `POST /issues/{n}/assignees`, `POST /issues/{n}/labels`, `POST /pulls/{n}/requested_reviewers {reviewers, team_reviewers}`, `PATCH /issues/{n} {milestone}` |
| Update | `PATCH /repos/{o}/{r}/pulls/{n}`; draft ↔ ready via GraphQL `convertPullRequestToDraft` / `markPullRequestReadyForReview` |
| Comment | `POST /repos/{o}/{r}/issues/{n}/comments`; reply in thread `POST /pulls/{n}/comments/{id}/replies` |
| Review | `POST /repos/{o}/{r}/pulls/{n}/reviews {commit_id, event, body, comments:[{path,line,side,start_line,body}]}` |
| Resolve thread | GraphQL `resolveReviewThread` / `unresolveReviewThread` |
| Merge | `PUT /repos/{o}/{r}/pulls/{n}/merge {merge_method, commit_title, commit_message, sha}` (409 if head moved); delete branch `DELETE /repos/{ho}/{hr}/git/refs/heads/{branch}`; auto-merge GraphQL `enablePullRequestAutoMerge` |
| Templates (remote fallback) | `GET /repos/{o}/{r}/contents/.github/PULL_REQUEST_TEMPLATE?ref=…` |
| Users / labels / milestones | `GET /repos/{o}/{r}/assignees`, GraphQL `suggestedReviewers`, `GET /orgs/{org}/teams`, `GET /repos/{o}/{r}/labels`, `/milestones` |
| Actions | `GET /repos/{o}/{r}/actions/runs?branch=&per_page=30`, `POST …/runs/{id}/rerun`, `…/rerun-failed-jobs`, `…/cancel` |
| SSH key | `POST /user/keys {title, key}` |
| Issues | `GET /search/issues?q=repo:o/r is:issue is:open assignee:@me`; `GET/PATCH /repos/{o}/{r}/issues/{n}`; `POST /repos/{o}/{r}/issues` |

**GitLab (`https://{host}/api/v4`, project id = URL-encoded `namespace/name`)**

| Feature | Call |
|---|---|
| Viewer | `GET /user`; scopes `GET /personal_access_tokens/self` (PAT) or `/oauth/token/info` |
| Repos | `GET /projects?membership=true&order_by=last_activity_at&per_page=100&search=` ; groups `GET /groups?min_access_level=10` |
| Forks | `GET /projects/{id}/forks`; fork `POST /projects/{id}/fork` |
| MR list | `GET /projects/{id}/merge_requests?state=opened&scope=all|created_by_me|assigned_to_me&reviewer_username=` (or GraphQL `project{mergeRequests}` for approvals/pipeline in one call) |
| MR detail | `GET /projects/{id}/merge_requests/{iid}` (+ `?include_rebase_in_progress`), `/approvals`, `/discussions`, `/pipelines`, `/notes` |
| Create | `POST /projects/{id}/merge_requests {source_branch, target_branch, target_project_id, title, description, assignee_ids, reviewer_ids, labels, milestone_id, remove_source_branch, squash, draft}` (create on the **source** project for fork MRs) |
| Comment/review | `POST /merge_requests/{iid}/notes`; inline: `POST /merge_requests/{iid}/discussions` with `position{base_sha,start_sha,head_sha,new_path,new_line}`; approve `POST /merge_requests/{iid}/approve`; "request changes" → GitLab ≥ 17.x review state *(inferred)*, else comment |
| Resolve | `PUT /merge_requests/{iid}/discussions/{id}?resolved=true` |
| Merge | `PUT /merge_requests/{iid}/merge {sha, squash, should_remove_source_branch, merge_commit_message, squash_commit_message, merge_when_pipeline_succeeds}` |
| Pipelines | `GET /projects/{id}/pipelines?ref=`, `POST /pipelines/{pid}/retry`, `/cancel` |
| SSH | `POST /user/keys {title, key}` |
| Issues | `GET /projects/{id}/issues?state=opened&scope=assigned_to_me`, `POST /projects/{id}/issues`, `PUT /issues/{iid}` (state_event close/reopen) |

**Bitbucket Cloud (`https://api.bitbucket.org/2.0`)**

| Feature | Call |
|---|---|
| Viewer | `GET /user`, `GET /user/emails` |
| Repos | `GET /repositories?role=member&sort=-updated_on&pagelen=100&q=name~"x"`; workspaces `GET /user/permissions/workspaces` |
| Forks | `GET /repositories/{ws}/{slug}/forks`; fork `POST /repositories/{ws}/{slug}/forks` |
| PR list | `GET /repositories/{ws}/{slug}/pullrequests?state=OPEN&pagelen=50&q=author.uuid="{uuid}"` ; fields via `fields=+values.participants` |
| Detail | `GET …/pullrequests/{id}`, `/activity`, `/comments`, `/statuses`, `/diffstat`, `/merge-task-status/{task}` |
| Create | `POST …/pullrequests {title, description, source:{branch:{name}, repository:{full_name}}, destination:{branch:{name}}, reviewers:[{uuid}], close_source_branch, draft}` |
| Review | `POST …/pullrequests/{id}/approve`, `DELETE …/approve`, `POST …/request-changes`; comment `POST …/comments {content:{raw}, inline:{path,to}}` |
| Merge | `POST …/pullrequests/{id}/merge {merge_strategy: merge_commit|squash|fast_forward, message, close_source_branch}` — may return 202 + task polling |
| CI | `GET …/commit/{sha}/statuses`; pipelines `GET …/pipelines/?target.branch=` , `POST …/pipelines/{uuid}/stopPipeline` |
| SSH | `POST /users/{uuid}/ssh-keys {key, label}` |
| Issues | Bitbucket issue tracker deprecated → not supported (Jira instead) |

**Bitbucket Data Center (`https://{host}/rest/api/latest`)**

Repos `GET /repos?limit=100&name=`; projects `GET /projects`; forks `GET /projects/{key}/repos/{slug}/forks`; PRs `GET …/pull-requests?state=OPEN&role.1=AUTHOR&username.1=…`; detail `/pull-requests/{id}`, `/activities`, `/merge` (GET returns `canMerge`, vetoes); create `POST …/pull-requests {title, description, fromRef:{id:"refs/heads/x", repository:{slug, project:{key}}}, toRef:{…}, reviewers:[{user:{name}}]}`; approve `PUT …/participants/{userSlug} {status:"APPROVED"|"NEEDS_WORK"}`; merge `POST …/merge?version={v}` (optimistic locking — must pass PR `version`); build status `GET /rest/build-status/latest/commits/{sha}`; comments `POST …/comments {text, anchor:{path,line,lineType,fileType}}`.

**Azure DevOps (`https://dev.azure.com/{org}/{project}/_apis`, `api-version=7.1`)**

Repos `GET /git/repositories`; projects `GET https://dev.azure.com/{org}/_apis/projects`; forks `GET /git/repositories/{repoId}/forks/{collectionId}`; PRs `GET /git/repositories/{repo}/pullrequests?searchCriteria.status=active&searchCriteria.creatorId=|reviewerId=`; detail `/pullrequests/{id}`, threads `/pullrequests/{id}/threads`, statuses `/pullrequests/{id}/statuses`, policy evaluations `GET https://dev.azure.com/{org}/{project}/_apis/policy/evaluations?artifactId=vstfs:///CodeReview/CodeReviewId/{projectId}/{prId}`; create `POST /git/repositories/{repo}/pullrequests {sourceRefName:"refs/heads/x", targetRefName, title, description, isDraft, reviewers:[{id}], workItemRefs:[{id}], labels:[{name}]}` (`forkSource:{repository:{id}}` for forks); vote `PUT /pullrequests/{id}/reviewers/{reviewerId} {vote: 10 approve | 5 approve w/ suggestions | -5 waiting | -10 reject}`; merge = `PATCH /pullrequests/{id} {status:"completed", lastMergeSourceCommit:{commitId}, completionOptions:{mergeStrategy: noFastForward|squash|rebase|rebaseMerge, deleteSourceBranch, mergeCommitMessage}}`; auto-complete = same PATCH with `autoCompleteSetBy`. Builds `GET /build/builds?branchName=refs/heads/x`, rerun `PATCH /build/builds/{id}?retry=true`. Work items: `POST /wit/wiql {query:"SELECT [System.Id] FROM WorkItems WHERE [System.AssignedTo] = @Me AND [System.State] <> 'Closed' ORDER BY [System.ChangedDate] DESC"}` then `GET /wit/workitems?ids=…&$expand=fields` (≤200 per call); update `PATCH /wit/workitems/{id}` (JSON-Patch, `application/json-patch+json`). SSH: not available via API → copy-to-clipboard + open `https://dev.azure.com/{org}/_usersSettings/keys`.

**Jira** — Cloud: `POST /rest/api/3/search/jql {jql, fields:[summary,status,assignee,issuetype,priority,labels,updated,sprint,fixVersions], nextPageToken, maxResults:50}` (the older `/search` is deprecated); presets: `assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC`, `reporter = currentUser()`, `text ~ currentUser()` *(mention approximation)*. Issue `GET /issue/{key}?expand=renderedFields`, transitions `GET/POST /issue/{key}/transitions`, comment `POST /issue/{key}/comment` (ADF body), create `POST /issue` (needs `GET /issue/createmeta/{projectKey}/issuetypes`). DC: `/rest/api/2/search` (POST, `startAt` paging), comments as plain wiki text.

**Trello** — `GET /1/members/me/boards?filter=open`, `GET /1/boards/{id}/cards?members=true&fields=name,desc,idList,shortLink,url,dateLastActivity,labels`, `GET /1/boards/{id}/lists`; "assigned to me": `GET /1/members/me/cards`; create `POST /1/cards {idList, name, desc}`; move (status) `PUT /1/cards/{id} {idList}`.

### 6.3 Git operations

- **Map remotes → provider repos**: `git remote -v` (spec 09) → each provider's `matchRemoteUrl` tries, in order, the hosts of connected integrations. Patterns: `https://host/owner/repo(.git)`, `git@host:owner/repo(.git)`, `ssh://git@host[:port]/owner/repo`, GitLab nested groups (`group/sub/repo`), Azure `https://{org}@dev.azure.com/{org}/{project}/_git/{repo}`, `git@ssh.dev.azure.com:v3/{org}/{project}/{repo}`, legacy `{org}.visualstudio.com`, Bitbucket DC `https://host/scm/{key}/{slug}.git` and `ssh://git@host:7999/{key}/{slug}.git`. Honor `url.<base>.insteadOf` by reading `git config --get-regexp ^url\.` and SSH host aliases from `~/.ssh/config` (`Host gh-work → HostName github.com`).
- **Checkout PR** (`pr:checkout`), queued via OperationQueue:
  1. If head repo == a configured remote R: `git fetch R refs/heads/{branch}:refs/remotes/R/{branch}` then `git switch -c {branch} --track R/{branch}` (or `git switch {branch}` if exists and fast-forwardable: `git merge --ff-only R/{branch}`; if diverged, offer reset / new name `{branch}-pr{n}`).
  2. Else if head repo is a fork not added: prompt "Add remote `{forkOwner}`?" → `git remote add {forkOwner} {url}` then step 1.
  3. Else / fork deleted: provider refspec: `git fetch {baseRemote} refs/pull/{n}/head:refs/remotes/{baseRemote}/pr/{n}` (GitLab `refs/merge-requests/{n}/head`, BBDC `refs/pull-requests/{n}/from`) and create local `pr/{n}` branch (no upstream).
  4. Worktree mode: `git worktree add ../{repo}.worktrees/pr-{n} -b {branch} {ref}` (spec 09 worktrees).
- **Files changed tab**: after fetching head, diff locally `git diff --merge-base {base_remote}/{baseBranch} {headSha}` (requires base fetched: `git fetch {baseRemote} {baseBranch}`). If commits unavailable (no permission to fetch), fall back to provider diff APIs (`GET /pulls/{n}/files`) rendered read-only.
- **Conflict pre-check** for Create PR: `git merge-tree --write-tree --name-only --no-messages {target} {source}` (git ≥ 2.38); exit code 1 → conflicts, list files.
- **Templates (local)**: read from the source branch via `git ls-tree -r --name-only {branch} -- .github docs .gitlab .azuredevops` and `git show {branch}:{path}`. Locations: GitHub `.github/pull_request_template.md`, `PULL_REQUEST_TEMPLATE.md` (root/docs), `.github/PULL_REQUEST_TEMPLATE/*.md`; GitLab `.gitlab/merge_request_templates/*.md`; Azure `.azuredevops/pull_request_template.md`, `.vsts/…`, `docs/…`, plus `pull_request_template/branches/{target}.md`; Bitbucket: none (default description from repo settings via API *(inferred)*). Case-insensitive match.
- **Commits ahead preview**: `git log --format=%H%x00%s {target}..{source}`.
- **Create branch from issue**: `git check-ref-format --branch {name}` to validate; `git branch {name} {base}`; optional `git switch {name}`.
- **Push before PR**: delegate to spec 09 push with `--set-upstream`.

### 6.4 Rate limiting, caching, resiliency

- `HttpClient` middleware chain: auth header → User-Agent `GitHappens/{version}` → conditional request (`If-None-Match` with stored ETag; GitHub 304s don't count against the limit) → retry (network errors and 502/503/504: 3 tries, exponential backoff 500ms·2^n + jitter) → rate-limit parser.
- Headers parsed: GitHub `x-ratelimit-remaining/reset/resource`, `retry-after` (secondary limits); GitLab `RateLimit-Remaining/Reset`, `Retry-After`; Bitbucket `X-RateLimit-*` + 429; Azure `X-RateLimit-Remaining`, `Retry-After`, `X-RateLimit-Delay` (TSTU throttling); Jira 429 + `Retry-After`.
- Budget policy: if remaining < 10% → background polling for that integration pauses until reset; user-initiated requests still go. On 429/secondary-limit → `rate_limited` error with `retryAt`; global per-integration concurrency cap 4 (GitHub recommends serial mutations — mutations are serialized per integration).
- GraphQL: request `rateLimit { cost remaining resetAt }` in queries; keep page sizes ≤ 50 for nested connections.
- Caches: TanStack Query in renderer (`staleTime` PR list 60s, PR detail 30s, checks 15s while pending/120s otherwise, repos list 10 min, labels/users 30 min); main-process ETag store (in-memory LRU 2,000 entries) so refetches are cheap. Persist last PR list per repo to disk for instant paint at startup (marked stale).
- Polling: PR list for the **active** repo tab every 120s when window focused, 10 min when blurred, paused when offline (`net.online` / failed connectivity probe). PR view open → poll detail every 30s; checks every 15s while any pending. Manual refresh always available. Fetch completion in the repo (spec 09) triggers PR list invalidation.
- PrIndex rebuilt on PR list change and on ref changes (RepoWatcher event).

### 6.5 SSH key generation & upload

`ssh:generateAndUpload`: generate the pair with spec 09's `ssh:key:generate` (`ssh-keygen -t ed25519 -C "{login}@githappens-{hostname}"`, default path `~/.ssh/githappens_{kind}_ed25519`; a passphrase is answered through node-pty and never placed in argv); refuse to overwrite existing files (append `_2`). Upload via provider API; on `insufficient_scope` prompt reconnect with the extra scope. Set Preferences → Integrations → {provider} → "Use this key" which spec 09 maps into `GIT_SSH_COMMAND="ssh -i {key} -o IdentitiesOnly=yes"` for remotes matching that provider host.

---

## 7. Step-by-step implementation plan

1. **Shared types & IPC contract**: add `/src/shared/ipc/integrations.ts` with all types in §5; generate preload bindings; unit test type-level exhaustiveness of channel map.
2. **HttpClient** (`/packages/providers/http`): fetch wrapper (Node 20 `fetch` / undici) with middleware chain, ETag store, retry, rate-limit parsing, typed `ProviderError` mapping. Tests with `msw` for 200/304/401/403-scope/404/429/5xx.
3. **SecretStore integration**: keytar read/write/delete for `StoredCredential`; metadata JSON; migration-safe versioning. Test with in-memory keytar mock.
4. **AuthService – PAT path**: `connectPat` validates via `getViewer()` + scope check; GitHub first. Test: wrong token → `auth_required`; missing scope → `insufficient_scope` with list.
5. **AuthService – OAuth loopback + PKCE**: loopback server, state check, timeout, cancel, success page; custom protocol handler registration; `second-instance`/`open-url` wiring. Test: simulate callback via HTTP request to the loopback port; wrong state rejected.
6. **OAuth Broker** (separate tiny repo/dir `/services/oauth-broker`, optional): token exchange + refresh proxies for GitHub, Bitbucket, Atlassian; no persistence, structured logs without bodies. GitHub Device Flow fallback in app.
7. **Token refresh** single-flight + `auth:reauthRequired`. Test concurrency: 10 parallel requests → 1 refresh.
8. **Remote URL matcher** for all providers + insteadOf + ssh config aliases. Table-driven unit tests (≥ 40 URL fixtures).
9. **GitHubProvider**: viewer, owners, repos, forks, PR list (GraphQL), PR detail, timeline, checks, create/update/comment/review/merge/close, templates (remote), users/labels/milestones, SSH upload, Actions runs. Recorded fixtures.
10. **Preferences → Integrations UI** (GitHub + GHE) with states; `auth:*` channels; rate-limit indicator.
11. **Clone dialog provider tab** + Add Remote fork list (spec 03/09 hooks).
12. **PR list section** + PrRow + tooltip + filters (presets + GitHub query), polling policy, persisted last list.
13. **PrIndex + graph badges** (spec 04 ref label decoration API) + merged pill.
14. **Checkout PR** git flow (§6.3) through OperationQueue, incl. fork remote prompt and worktree mode. E2E with fixture repo + mock provider.
15. **Create PR panel**: entry points (drag-drop drop menu item registered with spec 05 DnD registry, context menu, +, palette), local templates, conflict pre-check, commits preview, push-first flow, capability-gated fields.
16. **PR View**: header, overview/timeline, comment composer, sidebar boxes, merge box with methods, review submit, files-changed tab using Monaco diff with inline comments, checks tab.
17. **GitLabProvider** (+ Self-Managed PAT + version check) — reuse UI; capability flags hide unsupported fields.
18. **BitbucketCloudProvider** and **BitbucketDcProvider** (version-locking merges, 202 task polling).
19. **AzureDevOpsProvider**: Entra OAuth, org picker, PRs, votes, policies → mergeability, builds; PAT fallback.
20. **IssueTracker** implementations: GitHub, GitLab, Jira Cloud (3LO + accessible-resources), Jira DC (PAT), Trello (fragment token), Azure Boards (WIQL). ADF→markdown converter (subset: paragraphs, headings, lists, code, links, mentions).
21. **ISSUES section + IssueDetailPanel + CreateBranchFromIssue**, issue-link storage and branch-name inference, ref-label tracker icon.
22. **SSH generate & upload** per provider; per-provider key selection forwarded to spec 09.
23. **AvatarService** + `githappens-avatar://` protocol + Gravatar opt-out.
24. **CI section** (optional): Actions/pipelines runs, rerun/cancel.
25. **Hardening**: offline mode, rate-limit pause, error toasts with help links, telemetry-free logging (redact `Authorization`, `token=`, `key=`), accessibility pass, e2e suite on 3 OSes with mock provider server.

---

## 8. Edge cases

- **Multiple remotes on different providers** (origin=GitHub, mirror=GitLab): PR list aggregates; each row shows provider icon. Default PR target = `upstream` if present and is the fork parent, else `origin`.
- **Fork workflow**: origin = user's fork, upstream = parent. Create PR default target = upstream default branch; head = `forkOwner:branch`. PR list queries the **parent** repo filtered to PRs whose head repo is the fork plus all PRs (filter dependent).
- **Remote not mapped** (unknown host, self-hosted not connected): PR section shows "Connect `git.acme.com`" quick action that pre-fills host.
- **Same host, multiple accounts** (work vs personal GitHub): resolved by profile (spec 13); within one profile only one account per host — show warning if a remote's owner isn't accessible ("Repository not found with account X").
- **GitHub org OAuth restrictions**: org repos missing → `forbidden_org_policy` with link to request approval.
- **SAML SSO-protected orgs**: GitHub returns 403 with `X-GitHub-SSO: required; url=…` → show "Authorize token for SSO" button opening that URL.
- **Fine-grained PATs / GitHub App tokens**: no `X-OAuth-Scopes` header → scopes "unknown", rely on per-call 403 handling.
- **Token revoked externally** → 401 → mark integration `expired`, keep metadata, prompt reconnect; never loop.
- **Keychain unavailable** (Linux without libsecret / locked keyring): fall back to `safeStorage`-encrypted file; if `safeStorage.isEncryptionAvailable()` false, refuse to persist and keep token in memory for the session with a banner.
- **Loopback blocked** by firewall/AV or browser on another machine (remote desktop): offer "Paste the redirect URL" manual fallback field; GitHub device flow alternative.
- **Corporate proxies / custom CAs**: HttpClient uses Electron `net`/session proxy resolution and system CA store (`--use-system-ca` / `NODE_EXTRA_CA_CERTS` setting in spec 13); self-signed GHE certs → explicit "trust this certificate" prompt storing fingerprint.
- **Deleted head fork / deleted head branch**: checkout via provider refspec; Bitbucket Cloud has no PR ref → show "Source branch no longer available".
- **PR head moved during merge** → provider 409/`sha` mismatch → refresh and ask user to retry.
- **Mergeability "unknown"** (GitHub computes lazily) → show "Checking…", re-poll after 3s up to 5 times.
- **Bitbucket async merge** (202) → poll task status until done/timeout 60s.
- **Bitbucket DC version conflict** (409 stale version) → refetch & retry once automatically if user intent unchanged.
- **Azure DevOps**: PR refs `refs/heads/...` prefix stripping; policies block completion → list unmet policies; votes are per reviewer including groups; project names with spaces (URL-encode).
- **GitLab nested subgroups and renamed projects** (301 redirects) → follow and update cached RepoRef; MR iid vs id confusion — always use iid in UI and URLs.
- **Huge PRs** (3,000+ files, 10,000+ timeline items): virtualize lists, paginate timeline lazily, cap Monaco diff per file (spec 07 large-file rule), files list from local git not API.
- **Draft PRs on plans that don't support drafts** (GitHub private repo on free org) → 422 → retry without draft after confirming with user.
- **Template on target vs source branch**: we read from source branch; if none, try target branch, then remote default branch via API.
- **Unicode/emojis in branch names and titles**; branch-name slug from issue strips to `[a-z0-9-]`, preserves Jira key casing, max 60 chars, avoids `..`, `@{`, trailing `.lock`.
- **Jira next-gen vs classic** transitions differ; status names localized → use `statusCategory` for grouping.
- **Trello token in query string**: never log URLs; HttpClient redaction.
- **Offline**: all provider sections show cached data with "Offline — showing data from 10:42" and disable mutations.
- **Detached HEAD / empty repo / bare repo**: PR section still works (no "current branch" PR); Create PR from context menu needs a branch; bare repos can't checkout PR (worktree mode only).
- **Clock skew** affecting token expiry → use server `Date` header to compute offset.

---

## 9. Acceptance criteria

- [ ] GitHub.com connects via browser OAuth in ≤ 3 user actions; token stored only in keychain (verified: no token in `userData` files or logs).
- [ ] PAT connection works for GitHub Enterprise, GitLab Self-Managed (≥ 13.1), Bitbucket DC and Azure DevOps; missing scopes are listed explicitly.
- [ ] Disconnect removes the keychain entry and, where supported (GitHub `DELETE /applications/{client_id}/token` via broker, GitLab `/oauth/revoke`), revokes the token.
- [ ] Expired/revoked token surfaces a single reconnect prompt; no repeated error toasts.
- [ ] Clone dialog lists ≥ 1,000 repos smoothly with search; org-restriction hint shown when applicable.
- [ ] Add Remote shows forks with avatars; adding one runs `git remote add` and fetches.
- [ ] Dragging a pushed branch onto another shows "Start a pull request…"; creating a PR with title/body/reviewers/assignees/labels/draft/template succeeds on GitHub; GitLab/Bitbucket/Azure show only supported fields and succeed.
- [ ] Conflict banner appears when `merge-tree` reports conflicts.
- [ ] PULL REQUESTS section shows correct rollup icons for fixtures: approved+green, pending, changes requested, failing CI, conflicts.
- [ ] Graph shows PR badge on head branches within 2 s of PR list load; hover tooltip correct; merged pill shows after merge.
- [ ] PR View: description, timeline, review threads, checks render; comment, approve, request changes, and merge (each allowed method) work on GitHub and at least one other provider.
- [ ] Checkout PR works for same-repo branch, fork branch (adds remote), and deleted fork (refspec) cases.
- [ ] ISSUES section lists "My issues" for GitHub, GitLab, Jira Cloud, Jira DC, Trello, Azure Boards; create branch from issue produces a valid name and links the branch (tracker icon + "View issue").
- [ ] SSH key generated and uploaded to GitHub, GitLab, Bitbucket Cloud; copy-to-clipboard path for Azure/BBDC.
- [ ] Rate-limit: when GitHub remaining < 10%, background polling stops and indicator shows reset time; 429 handled with `Retry-After`.
- [ ] All provider HTTP traffic originates in the main process; renderer CSP blocks remote origins (images served via `githappens-avatar://`).
- [ ] Recorded-fixture unit tests ≥ 85% line coverage in `/packages/providers`.

---

## 10. Out of scope / later

- Full code-review parity with web (multi-line suggestions syntax ```` ```suggestion ````, review of individual commits, file "viewed" state sync) — v1.x.
- Code Suggest and Cloud Patches (spec 14).
- Launchpad, Workspaces cross-repo PR views (spec 11) — this spec only provides the provider layer they reuse.
- Stacked PR creation/management (GitHub stack API is new; we display stack position only if returned) — later.
- Webhooks/push notifications (would require a server) — polling only.
- Gitea/Forgejo, AWS CodeCommit, Gerrit providers — later; the interface is designed to accommodate them.
- Multiple accounts per host in the same profile (separate profiles are required; we keep that model for v1).
- Editing GitHub Actions workflows via a visual editor (users edit YAML in the in-app editor).
- Creating issues in Bitbucket Cloud's legacy issue tracker.
- AI PR description generation is defined in spec 12; this spec only exposes the hook button.

---

## 11. Cross-spec dependencies

- **Provider web-link builder (used by spec 04 §4.10 "Copy link"/"View on provider", spec 05 `copy:link`, spec 07 file menus, spec 12 §4.10 "Open on <provider>", spec 09 remote menu "Open on <provider>"):** `HostingProvider.webUrl(ref: RepoRef, target: WebTarget): string`, where `WebTarget = { kind: 'repo' } | { kind: 'commit'; sha } | { kind: 'branch'; name } | { kind: 'tag'; name } | { kind: 'file'; rev; path; line?: number; endLine?: number } | { kind: 'pr'; number } | { kind: 'compare'; base; head }`. It is a pure function with no network call. It is exposed as the read channel `provider:webUrl { repoId, remote?, target } → string | null` (remote defaults to the branch upstream's remote, else `origin`). Patterns:

  | Provider | commit | branch | file (+line) |
  |---|---|---|---|
  | GitHub/GHE | `/{o}/{r}/commit/{sha}` | `/tree/{branch}` | `/blob/{rev}/{path}#L{n}[-L{m}]` |
  | GitLab/SM | `/{ns}/{r}/-/commit/{sha}` | `/-/tree/{branch}` | `/-/blob/{rev}/{path}#L{n}[-{m}]` |
  | Bitbucket Cloud | `/{ws}/{r}/commits/{sha}` | `/branch/{branch}` | `/src/{rev}/{path}#lines-{n}[:{m}]` |
  | Bitbucket DC | `/projects/{KEY}/repos/{slug}/commits/{sha}` | `/browse?at=refs/heads/{branch}` | `/browse/{path}?at={rev}#{n}[-{m}]` |
  | Azure DevOps | `/{org}/{proj}/_git/{r}/commit/{sha}` | `?version=GB{branch}` | `?path=/{path}&version=GC{sha}&line={n}&lineEnd={m}` |

  The branch and file columns are relative to the repo web base shown in the commit column. Path and branch segments are URL-encoded per segment. When a remote maps to no connected integration but its host is a known public host (github.com, gitlab.com, bitbucket.org, dev.azure.com), the builder still works from the parsed URL, since no token is needed. Otherwise the menu item is hidden.
- **Fork listing and SSH key upload consumed by spec 09:** spec 09's `git:remote:forks` delegates to `HostingProvider.listForks` (`provider:listForks`) and maps `RemoteRepo` to its fork rows (`cloneUrlHttps = httpsUrl`, `cloneUrlSsh = sshUrl`). Spec 09's `ssh:key:addToProvider` calls `HostingProvider.uploadSshKey`, which is gated by `capabilities.sshKeyUpload`. Azure DevOps and Bitbucket DC fall back to copy-to-clipboard plus opening the key settings page. Per-integration key paths are stored as spec 13 `integrations.<integrationKey>.sshKeyPath` and applied by spec 09 `buildSshCommand`.
- **OAuth broker (00 §4 `/services/oauth-broker`):** the GitHub, Bitbucket Cloud and Atlassian code exchange and refresh go through `OAUTH_BROKER_URL` (§6.1). The broker is stateless, never logs bodies, and is deployed in Phase 4 (spec 15 §8). Builds without it fall back to GitHub Device Flow or PAT entry.
- **GitHub Actions section:** the CI section (§4.8, §2.3) stays **optional**: hidden by default (spec 01 `LeftSectionId 'actions'` with `visible: false`), polled only when expanded, and not part of any release acceptance criterion.
- **Git operations go through spec 02:** `pr:checkout` is the `GitOperation` `{ type: 'pr.checkout' }` (queued and journaled, spec 02 §11). Issue branch creation uses spec 05's `branch.create`. Push-before-PR uses spec 09's `push`.
- **Secrets and avatars:** tokens use SecretStore naming from spec 13 §5.1. `AvatarService` and the `githappens-avatar://` protocol defined here are also used by spec 04 (`avatar:get` is an alias of `avatar:resolve`).
