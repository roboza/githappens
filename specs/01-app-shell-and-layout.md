# 01 — App Shell & Layout

> Covers the main window frame: repo tab bar, toolbar, breadcrumb, left panel, center (graph host), right panel (commit detail / WIP), status bar, Command Palette, fuzzy finder, keyboard shortcuts, notifications/toasts, application menus, zoom, fullscreen and panel resizing.
> Depends on: 00 (architecture), 02 (GitService/IPC), 13 (settings, keybindings, themes). Consumed by nearly every other spec.

---

## 1. Purpose

GitHappens' value is a single, dense, always-visible workspace: the commit graph in the middle, every ref of the repo on the left, the detail of whatever is selected on the right, and one-click git actions on top. The shell must make the most common operations (pull, push, branch, stash, undo) reachable in one click or one keystroke, must keep several repositories open at once as tabs, and must provide a keyboard-first escape hatch (Command Palette) for everything else. The shell is also the host for global concerns: toasts, progress, zoom, theming, and menus.

## 2. Reference behavior

**Window regions (left→right, top→bottom)**
- **Tab bar** (top): one tab per open repository, plus a "+" new-tab button that opens a New Tab / Repo Management page. Tabs can be reordered by dragging, closed by middle-click or Ctrl/Cmd+W, switched with Ctrl/Cmd+1..9. Hovering a tab shows the repo's full path. Right-click → *Alias repository* gives the tab a custom display name. A dropdown lists all open tabs. Tabs are remembered per **profile** and swap when the profile changes. Since 12.4, worktrees of the same repo are visually grouped together in the tab bar (can be disabled in UI Customization). The right end of the tab bar holds the profile/account avatar menu, the Command Palette (wand) icon, notifications (bell) and the Preferences gear.
- **Toolbar** (under tabs): left side shows the **repo/branch breadcrumb** — `repository ▾` (click to switch/open repos) and `branch ▾` (click to checkout another branch via a filterable list). Center contains action buttons: **Undo**, **Redo**, **Pull** (with a dropdown: Fetch All, Pull fast-forward if possible, Pull fast-forward only, Pull rebase; the chosen item can be set as the default), **Push**, **Branch**, **Stash**, **Pop**. Conditional buttons: **LFS** (when LFS is initialized), **Sparse** (when sparse checkout is active), **Git Flow** (when gitflow initialized, inferred). Right side: **Terminal** toggle (opens in-app terminal panel), search (magnifier, Ctrl/Cmd+F), and Workspaces/Launchpad entry points. Button text labels can be toggled via Preferences → UI Customization "Show toolbar icon labels".
- **Left Panel**: a `List | Agents` segmented control (12.x; hideable). In List mode, collapsible sections: **Local**, **Remote** (grouped by remote, then folder by `/` path segment), **Pull Requests**, **Issues**, **Teams**, **Tags**, **Stashes**, **Submodules**, **Worktrees**. GitHub Actions had a section in 9.x–11.x but was removed in 11.10 (we keep it optional, off by default). Sections can be collapsed, resized, hidden via header context menu, and double-clicking a header maximizes that section. A filter box at the top (Ctrl/Cmd+Alt+F) filters refs across sections; including a remote name (e.g. `origin/feat`) matches remote branches. Each ref row shows ahead/behind counts against upstream, and hover reveals an eye icon for **Hide**. Right-click → **Solo** keeps only explicitly soloed refs visible in the graph. Section header right-click → Hide all / Show all. Hidden refs show a dimmed eye; soloed refs show an orange solo indicator.
- **Center**: Commit Graph (spec 04), with columns (Branch/Tag, Graph, Commit Message; optional Author, Date/Time, SHA), WIP node at top.
- **Right panel (Commit Panel)**: when the WIP node is selected → staging view (Unstaged files, Staged files, commit message Summary + Description, Commit button; spec 06). When a commit is selected → commit detail (SHA, parents, author/committer, date, message, changed files as list or tree, diff on click; spec 07). Multi-select of commits shows a combined diff/compare view. Toggle with Ctrl/Cmd+K. Clicking a file replaces the graph area with the diff view; Esc returns.
- **Status bar** (bottom): Launchpad summary (counts of PRs/issues needing attention; hideable), current plan/account badge, zoom selector (100, 110, 125, 140, 150, 175, 200%), plus feedback/help link. 12.x added terminal panel docking above status bar.
- **Command Palette** (Ctrl/Cmd+P, or wand icon, or Help → Command Palette): live-filtered list of commands grouped by category (Repo, Settings, View, History, Core, File, Stash, Branch, Checkout, Patch, Logs); many commands take an argument (filename, branch, profile) and turn into a second-stage picker. Context-dependent: commands only appear when applicable.
- **Fuzzy finder**: Ctrl/Cmd+Shift+O opens repo via palette, Ctrl/Cmd+Shift+H "file history/blame" picker; the same palette component does fuzzy file search ("Open File", "View File", "Blame", "History").
- **Notifications**: toasts for operation results/errors (location configurable in UI Customization: e.g. bottom-left / top-right — inferred list), desktop OS notifications (toggle), and a notification bell center for news/updates and marketing (marketing can be disabled only on paid plans).
- **Zoom**: Ctrl/Cmd + = / − / 0; status bar selector; View menu; range up to 300% (12.3).
- **Fullscreen**: F11 (Win/Linux), Ctrl+Cmd+F (mac).
- **Panel resizing**: drag splitters between left panel / graph / right panel; left panel sections resizable vertically; graph columns resizable and reorderable (persisted per repo).

**Keyboard shortcuts (researched list)** — see §4.9 for the full table, which we reproduce as data (shortcut facts, not prose).

## 3. User stories

1. As a developer I want several repositories open as tabs so I can jump between them without reopening.
2. As a user I want one-click Pull/Push/Branch/Stash/Pop/Undo/Redo from the toolbar.
3. As a user I want to switch branch from the breadcrumb with a filterable dropdown.
4. As a power user I want every action reachable through a Command Palette with fuzzy search.
5. As a user I want to hide noisy branches or solo the ones I care about so the graph is readable.
6. As a user I want to filter the left panel by name to find a branch among hundreds.
7. As a user I want to collapse/resize panels and have my layout remembered.
8. As a keyboard user I want vim-style navigation (J/K/H/L) and standard shortcuts for staging and committing.
9. As a user I want clear toasts for success/failure with a "details" link to the git output.
10. As a user I want to zoom the whole UI and go fullscreen.
11. As a user I want to rename (alias) a tab so two clones of the same repo are distinguishable.

## 4. UI specification

### 4.1 Component tree

```
<App>
 ├─ <ThemeProvider/>                       (spec 13)
 ├─ <KeybindingProvider/>                  (global key dispatcher)
 ├─ <ToastHost/>  <ModalHost/>  <ContextMenuHost/>
 ├─ <CommandPalette/>                      (portal, hidden by default)
 └─ <AppShell>
     ├─ <TitleBar>                         (custom frame on Win/Linux; native traffic lights on mac)
     │   ├─ <RepoTabBar>
     │   │   ├─ <RepoTab/>*  (icon, alias|name, dirty dot, close ×, worktree group bracket)
     │   │   ├─ <NewTabButton/>  (+)
     │   │   └─ <TabOverflowDropdown/>
     │   └─ <TitleBarRight> <ProfileMenu/> <PaletteButton/> <NotificationBell/> <PreferencesButton/>
     ├─ <Toolbar>
     │   ├─ <Breadcrumb> <RepoSwitcher/> <BranchSwitcher/> </Breadcrumb>
     │   ├─ <ToolbarActions>
     │   │   Undo · Redo · PullSplitButton · Push · Branch · Stash · Pop · [LFS] · [Sparse] · [GitFlow]
     │   └─ <ToolbarRight> TerminalToggle · SearchButton · LaunchpadButton · WorkspacesButton
     ├─ <MainArea>   (horizontal SplitPane: left | center | right)
     │   ├─ <LeftPanel>
     │   │   ├─ <LeftPanelModeSwitch/>   (List | Agents, optional)
     │   │   ├─ <LeftPanelFilter/>
     │   │   └─ <SectionStack>  (vertical resizable)
     │   │       LocalSection · RemoteSection · PullRequestsSection · IssuesSection · TeamsSection
     │   │       TagsSection · StashesSection · SubmodulesSection · WorktreesSection · [ActionsSection]
     │   ├─ <CenterArea>
     │   │   ├─ <GraphView/> | <DiffView/> | <MergeTool/> | <RepoManagementView/> | <LaunchpadView/>
     │   │   └─ <BottomDock> <TerminalPanel/> (spec 12) </BottomDock>
     │   └─ <RightPanel>  <WipPanel/> | <CommitDetailPanel/> | <MultiCommitPanel/> | <RefDetailPanel/>
     └─ <StatusBar> LaunchpadSummary · OperationProgress · PlanBadge · ZoomSelector · HelpLink
</App>
```

### 4.2 Tab bar
- Tab label: `alias ?? repoFolderName`; tooltip: absolute path + current branch.
- Indicators: spinner while an op runs; dot when WIP has changes (inferred); red badge if repo path missing.
- Interactions: click = activate; middle-click / × / Ctrl+W = close; drag = reorder (persist order); right-click menu: *Alias repository…*, *Remove alias*, *Close tab*, *Close other tabs*, *Close tabs to the right*, *Copy path*, *Open in file manager*, *Open in terminal*, *Duplicate tab* (inferred).
- Special tabs: **New Tab** (Repo Management / welcome, spec 03), **Launchpad**, **Workspace** tabs (spec 11). These are typed `TabKind`.
- Worktree grouping: tabs whose repo `commonDir` matches are rendered adjacent with a shared bracket; setting `ui.groupWorktreeTabs`.
- Overflow: tabs shrink to min 120px, then horizontal scroll + overflow dropdown listing all tabs with filter.

### 4.3 Toolbar
| Button | Action | Disabled when |
|---|---|---|
| Undo | `undo.undoLast` (spec 05) | journal empty / op running |
| Redo | `undo.redoLast` | nothing to redo |
| Pull ▾ | default pull mode; menu: Fetch All, Pull (ff if possible), Pull (ff only), Pull (rebase), "Set as default" check | no remotes |
| Push | push current branch; if no upstream → prompt for remote/branch name | detached HEAD (shows tooltip) |
| Branch | inline create-branch input at HEAD in graph (Ctrl+B) | empty repo w/o commits |
| Stash | `git stash push` incl. untracked (per pref) | no WIP changes |
| Pop | pop top stash | no stashes |
| LFS ▾ | Pull/Push/Fetch LFS, Track pattern | LFS not initialized → hidden |
| Terminal | toggle bottom terminal panel | — |
- Each button shows busy spinner when its op is running and count badges (Pull shows behind-count, Push shows ahead-count — inferred).
- Labels optional (`ui.toolbarLabels`).

### 4.4 Breadcrumb
- `RepoSwitcher`: dropdown with filter: open tabs, favorites, recents, "Open…", "Clone…", "Init…" (spec 03).
- `BranchSwitcher`: shows current branch or `HEAD (detached at abc1234)`; dropdown lists local branches then remote branches with filter; Enter = checkout (remote → create tracking local branch).

### 4.5 Left panel
- Section header: chevron, title, count, actions (+ create, … menu). Double-click header = maximize section (others collapse to headers); double-click again = restore.
- Rows: tree for `/`-separated names (folders collapsible), current branch bold + check icon, upstream ahead/behind `↑2 ↓5`, hover icons: eye (hide), solo. Context menus delegate to spec 05/09/10.
- Filter box: case-insensitive fuzzy subsequence on ref full name; matched characters highlighted; sections with zero matches collapse automatically; Esc clears. Typing `origin/` restricts to that remote.
- Hide/Solo state per repo, persisted (`repoUiState.hiddenRefs`, `soloedRefs`). Solo mode: if `soloedRefs.size>0` graph only renders commits reachable from soloed refs (passes them as explicit revs to `git log`, spec 04). Header context: Hide all / Show all / Unsolo all.
- Collapsed/expanded sections and section heights persisted per repo.
- Empty states: "No tags", "No stashes", "Connect GitHub to see pull requests" (button → Preferences/Integrations).
- Agents mode (12.x): out of scope initially (see §10).

### 4.6 Right panel
- Selection-driven: `selection.kind` = `wip | commit | commits | ref | stash | none`.
- Header: for commit — short SHA (click copies), parents (links), author avatar/initials, date (format from settings); for WIP — "N file changes on <branch>".
- Resize via splitter (min 280px, max 60% width); collapse with Ctrl/Cmd+K.
- Placeholder when nothing selected: hint text.

### 4.7 Status bar
- Left: operation progress for the active repo (e.g. "Fetching origin… 45%") with cancel ×; last error indicator.
- Center/right: Launchpad summary (hideable), plan badge (we show app version / "Free"), zoom dropdown (presets 80–300%), feedback/help.

### 4.8 Command Palette & fuzzy finder
- Opens centered overlay 600px wide, input on top, result list (max 12 visible, virtualized). Arrow/Ctrl+J/K or ↑/↓ to move, Enter run, Esc close, Tab to accept argument stage, Backspace on empty argument returns to command stage.
- **Two-stage commands**: a command may declare `arg: {kind: 'file'|'branch'|'remoteBranch'|'tag'|'stash'|'profile'|'repo'|'commitQuery'|'text'}`; after selecting, palette switches to a picker with that provider.
- Ranking: fuzzy score (fzf-like: consecutive bonus, word-start bonus, path-segment bonus) + recency boost (MRU list of last 20 commands).
- Prefix modes (inferred, our design): `>` commands (default), `@` branches, `#` files, `:` commits search.
- Shows keybinding hint at right of each row.
- Full command registry (initial):

| Category | Command id | Title | Arg |
|---|---|---|---|
| Repo | `repo.closeTab` | Close Tab | — |
| Repo | `repo.open` | Open Repo | repo |
| Repo | `repo.openInFileManager` | Open in File Manager | — |
| Repo | `repo.openInIde` | Open in {IDE} (one per detected IDE) | — |
| Repo | `repo.openInExternalEditor` | Open in External Editor | — |
| Repo | `repo.openExternalDiff` | Open in External Diff/Merge Tool | — |
| Repo | `repo.openInTerminal` | Open in Terminal | — |
| Repo | `repoMgmt.clone` / `.init` / `.open` | Repo Management: Clone / Init / Open | — |
| Repo | `repo.maintenance` | Perform Repo Maintenance (`git gc`/`git maintenance run`) | — |
| Settings | `gitflow.configure` | Configure Git Flow | — |
| Settings | `lfs.configure` / `lfs.init` | Configure LFS / Initialize LFS | — |
| Settings | `signing.configure` | Configure GPG Signing | — |
| Settings | `theme.light` / `theme.dark` | Switch to Light / Dark theme | — |
| Settings | `theme.select` | Switch Theme | theme |
| Settings | `account.manage` | Manage Account | — |
| Settings | `prefs.open` | Settings | — |
| Settings | `profile.switch` | Switch to Profile | profile |
| View | `view.zoomIn/zoomOut/zoomReset` | Increase/Decrease/Reset Zoom | — |
| View | `view.shortcuts` | Keyboard Shortcuts | — |
| View | `view.toggleLeftPanel` | Toggle Left Panel | — |
| View | `view.toggleRightPanel` | Toggle Commit Detail Panel | — |
| View | `view.toggleSyntaxHighlighting` | Toggle Syntax Highlighting | — |
| View | `view.toggleTheme` | Toggle Theme | — |
| View | `view.toggleTerminal` | Toggle Terminal | — |
| View | `view.fullscreen` | Toggle Fullscreen | — |
| History | `history.blame` | Blame | file |
| History | `history.file` | History | file |
| History | `history.searchCommits` | Search Commits (message / sha / author) | commitQuery |
| Core | `core.undo` / `core.redo` | Undo / Redo | — |
| File | `file.create/delete/open/view/edit` | Create/Delete/Open/View/Edit File | file |
| File | `wip.discardAll` / `wip.stageAll` / `wip.unstageAll` | Discard / Stage / Unstage all changes | — |
| Stash | `stash.create/apply/pop` | Stash: Create / Apply / Pop | stash (apply/pop) |
| Branch | `branch.create/rename` | Create / Rename Branch | text |
| Branch | `tag.create` / `tag.createAnnotated` | Create (Annotated) Tag | text |
| Branch | `remote.fetchAll` / `remote.pull` / `remote.push` | Fetch All / Pull / Push | — |
| Branch | `pr.start` | Start Pull Request | — |
| Branch | `wip.view` | View Working Directory Changes | — |
| Checkout | `branch.checkout` | Checkout | branch |
| Patch | `patch.createFromWip` / `patch.apply` | Create patch from WIP / Apply patch | file |
| Logs | `logs.activity/errors/performance` | Activity / Error / Performance logs | — |
| Logs | `app.releaseNotes` | View Release Notes | — |
| Worktree | `worktree.open` / `worktree.create` | Open / Create Worktree (inferred) | worktree |

### 4.9 Keyboard shortcut table (defaults; `Mod` = Ctrl on Win/Linux, Cmd on mac)

| Context | Action | Win/Linux | macOS | Command id |
|---|---|---|---|---|
| Global | Show shortcuts list | Ctrl+/ | Cmd+/ | `view.shortcuts` |
| Global | Command Palette | Ctrl+P | Cmd+P | `palette.toggle` |
| Global | Open repo (palette) | Ctrl+Shift+O | Cmd+Shift+O | `repo.open` |
| Global | Repo Management | Alt+O (inferred; doc lists Alt+O for file manager too) | Cmd+O | `repoMgmt.show` |
| Global | File history/blame picker | Ctrl+Shift+H | Cmd+Shift+H | `history.file` |
| Global | Open repo in terminal | Alt+T | Option+T | `repo.openInTerminal` |
| Global | Open repo in file manager | Alt+O | Option+O | `repo.openInFileManager` |
| Global | Open diff/merge tool | Ctrl+D | Cmd+D | `repo.openExternalDiff` |
| Global | Search commits / focus search | Ctrl+F | Cmd+F | `history.searchCommits` |
| Global | Focus left panel filter | Ctrl+Alt+F | Cmd+Option+F | `leftPanel.focusFilter` |
| Global | Toggle left panel | Ctrl+J | Cmd+J | `view.toggleLeftPanel` |
| Global | Toggle commit detail panel | Ctrl+K | Cmd+K | `view.toggleRightPanel` |
| Global | Close panel/overlay | Esc | Esc | `view.closeCurrent` |
| Global | Fullscreen | F11 | Ctrl+Cmd+F | `view.fullscreen` |
| Global | Zoom in | Ctrl+= / Ctrl++ | Cmd+= / Cmd++ | `view.zoomIn` |
| Global | Zoom out | Ctrl+- | Cmd+- | `view.zoomOut` |
| Global | Reset zoom | Ctrl+0 | Cmd+0 | `view.zoomReset` |
| Global | Preferences | Ctrl+, (inferred) | Cmd+, | `prefs.open` |
| Tabs | New tab | Ctrl+T | Cmd+T | `tab.new` |
| Tabs | Close tab / repo | Ctrl+W | Cmd+W | `repo.closeTab` |
| Tabs | Go to tab 1–9 | Ctrl+1..9 | Cmd+1..9 | `tab.goto.N` |
| Tabs | Next tab | Ctrl+Tab | Cmd+Tab* | `tab.next` |
| Tabs | Previous tab | Ctrl+Shift+Tab | Cmd+Shift+Tab* | `tab.prev` |
| Tabs | Favorite repo 1–9 | Ctrl+Alt+1..9 | Cmd+1..9 (conflicts; we use Cmd+Option+1..9) | `favorite.open.N` |
| Repo | Create branch | Ctrl+B | Cmd+B | `branch.create` |
| Repo | Fetch all | Ctrl+L | Cmd+L | `remote.fetchAll` |
| Repo | Undo | Ctrl+Z | Cmd+Z | `core.undo` |
| Repo | Redo | Ctrl+Y / Ctrl+Shift+Z | Cmd+Y / Cmd+Shift+Z | `core.redo` |
| WIP | Stage selected file | S | S | `wip.stageFile` |
| WIP | Unstage selected file | U | U | `wip.unstageFile` |
| WIP | Stage all | Ctrl+Shift+S | Cmd+Shift+S | `wip.stageAll` |
| WIP | Unstage all | Ctrl+Shift+U | Cmd+Shift+U | `wip.unstageAll` |
| WIP | Commit staged | Ctrl+Enter | Cmd+Enter | `wip.commit` |
| WIP | Commit and push (spec 06 §4.5) | Ctrl+Shift+Enter | Cmd+Shift+Enter | `wip.commitPush` |
| WIP | Stage all + commit (moved from Ctrl+Shift+Enter in Phase 8) | Ctrl+Alt+Enter | Cmd+Alt+Enter | `wip.stageAllCommit` |
| WIP | Focus commit message | Ctrl+Shift+M | Cmd+Shift+M | `wip.focusMessage` |
| Graph | Next / previous row | J or ↓ / K or ↑ | same | `graph.down/up` |
| Graph | Left / right (parent/child lane, inferred) | H or ← / L or → | same | `graph.left/right` |
| Graph | Next / prev commit in same branch | Shift+J/↓, Shift+K/↑ | same | `graph.branchDown/Up` |
| Graph | First commit (top) | Ctrl+Home | Cmd+↑ | `graph.first` |
| Graph | Last commit (bottom) | Ctrl+End | Cmd+↓ | `graph.last` |
| File view | Find in file | Ctrl+F | Cmd+F | `editor.find` (Monaco) |

\*mac Cmd+Tab is OS-reserved, so we bind `Ctrl+Tab` on mac as well (Electron receives Ctrl+Tab) — inferred mitigation.

Note: J and K use vim semantics (J=down, K=up), not the "previous"/"next" labels some documentation uses (inferred).

Single-letter shortcuts (S/U/J/K/H/L) fire only when focus is not in a text input / Monaco / terminal.

### 4.10 Notifications / toasts
- `ToastHost` stacked, max 4 visible, location from `ui.notificationLocation` (`bottom-left` default (inferred), `bottom-right`, `top-right`, `top-left`).
- Kinds: `success` (auto-dismiss 4s), `info` (6s), `warning` (sticky until dismissed or 10s), `error` (sticky), `progress` (bound to an op id, updates percent, becomes success/error on completion).
- Actions: up to 2 buttons (e.g. "Details" opens git output log modal; "Retry"; "Undo").
- Error toasts include the git command and stderr excerpt (first 5 lines) with "Show full output".
- OS notifications (Electron `Notification`) only when window not focused and `notifications.desktop` enabled; used for long ops completing (clone/fetch/push) and PR events.
- Notification center (bell): list of persisted app notices (update available, what's new); unread count badge.

### 4.11 Menus (Electron application menu; mac app menu adds About/Preferences/Hide/Quit)
- **File**: New Tab, Open Repo…, Clone Repo…, Init Repo…, Open Recent ▸ (last 10), Repo Management, Open Terminal, Open in File Manager, Preferences (Win/Linux), Switch Profile ▸, Close Tab, Exit.
- **Edit**: Undo, Redo, Cut, Copy, Paste, Select All (role-based for text inputs; Undo/Redo route to git undo when focus is not in a text field).
- **View**: Command Palette, Toggle Left Panel, Toggle Commit Detail, Toggle Terminal, Zoom In/Out/Reset, Toggle Fullscreen, Toggle DevTools (dev builds or hidden flag).
- **Repo** (inferred grouping): Fetch All, Pull, Push, Create Branch, Stash, Pop Stash, Git Flow ▸, LFS ▸, Repo Settings.
- **Help**: Keyboard Shortcuts, Command Palette, Documentation, Release Notes, Support Logs (open log folder), Check for Updates, About.
- Menu accelerators are generated from the keybinding registry (single source of truth) so user overrides (spec 13) update the menu.

### 4.12 Zoom & fullscreen
- Zoom via `webContents.setZoomFactor(f)`; allowed range 0.5–3.0; presets [0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.5, 1.75, 2, 2.5, 3]; zoom in/out steps to the next preset. Persisted `ui.zoom` (per profile).
- Fullscreen via `BrowserWindow.setFullScreen(!isFullScreen())`.

### 4.13 Panel resizing
- Custom `SplitPane` (pointer events, 4px hit area, double-click splitter = reset default width). Left default 260px (min 180, max 50%), right default 400px (min 280). Collapsing animates to 0 and keeps last width. Persisted globally in `layout` (per profile) and section heights per repo.
- Window bounds persisted (`windowState.json`: x, y, width, height, maximized, displayId); restored on launch if display still exists, else centered.

## 5. Data model & IPC

```ts
// shared/shell.ts
export type TabKind = 'repo' | 'newTab' | 'launchpad' | 'workspace' | 'repoManagement';
export interface TabDescriptor {
  id: string;                 // uuid
  kind: TabKind;
  repoPath?: string;          // absolute, normalized
  alias?: string;
  worktreeOf?: string;        // commonDir of main repo for grouping
  workspaceId?: string;
}
export interface TabsState { tabs: TabDescriptor[]; activeTabId: string | null; }

export interface LayoutState {
  leftPanelWidth: number; leftPanelCollapsed: boolean;
  rightPanelWidth: number; rightPanelCollapsed: boolean;
  terminalHeight: number; terminalOpen: boolean;
}
export type LeftSectionId = 'local'|'remote'|'pullRequests'|'issues'|'teams'|'tags'|'stashes'|'submodules'|'worktrees'|'actions';
export interface RepoUiState {          // persisted per repo (spec 03 repoUiStore)
  sections: Record<LeftSectionId, { visible: boolean; collapsed: boolean; heightRatio: number }>;
  maximizedSection?: LeftSectionId;
  hiddenRefs: string[];                 // full ref names: refs/heads/x, refs/remotes/origin/y, refs/tags/z, refs/stash@{n}
  soloedRefs: string[];
  collapsedFolders: string[];           // e.g. 'local:feature/'
  graphColumns: GraphColumnConfig[];    // spec 04
}

export type Selection =
  | { kind: 'none' } | { kind: 'wip'; worktree?: string }
  | { kind: 'commit'; sha: string } | { kind: 'commits'; shas: string[] }
  | { kind: 'ref'; ref: string } | { kind: 'stash'; index: number };

export interface CommandDef {
  id: string; title: string; category: 'Repo'|'Settings'|'View'|'History'|'Core'|'File'|'Stash'|'Branch'|'Checkout'|'Patch'|'Logs'|'Worktree';
  arg?: { kind: 'file'|'branch'|'remoteBranch'|'tag'|'stash'|'profile'|'repo'|'theme'|'commitQuery'|'text'|'worktree'; placeholder?: string };
  when?: (ctx: CommandContext) => boolean;   // enablement
  run: (ctx: CommandContext, arg?: string) => Promise<void> | void;
}
export interface CommandContext { activeRepo?: string; hasRemotes: boolean; hasWip: boolean; hasStashes: boolean;
  isDetached: boolean; lfsEnabled: boolean; gitflowEnabled: boolean; focus: FocusZone; }
export type FocusZone = 'graph'|'leftPanel'|'rightPanel'|'wipFiles'|'textInput'|'editor'|'terminal'|'palette'|'modal';

export interface ToastSpec { id?: string; kind: 'success'|'info'|'warning'|'error'|'progress';
  title: string; body?: string; opId?: string; progress?: number;
  actions?: { label: string; commandId: string; args?: unknown }[]; timeoutMs?: number | null; }
```

**Stores (renderer, Zustand):** `useTabsStore`, `useLayoutStore`, `useSelectionStore` (per tab), `useRepoUiStore` (per repo), `useToastStore`, `usePaletteStore`, `useCommandRegistry`, `useKeybindingStore` (spec 13).

**IPC channels** (invoke unless noted; `evt:` = main→renderer event):

| Channel | Payload → Result |
|---|---|
| `shell:getInitialState` | → `{ tabs: TabsState; layout: LayoutState; windowState }` |
| `shell:saveTabs` | `TabsState` → void (debounced 500 ms in renderer) |
| `shell:saveLayout` | `LayoutState` → void |
| `repoUi:get` / `repoUi:save` | `{repoPath}` / `{repoPath, state: RepoUiState}` |
| `window:setFullscreen` / `window:toggleFullscreen` | → boolean |
| `window:setZoom` | `{factor}` → void |
| `window:minimize/maximize/close` | custom title bar buttons |
| `menu:invoke` (evt) | `{commandId, args}` — menu click forwarded to renderer command registry |
| `menu:rebuild` | `{ accelerators: Record<commandId, string>, recent: string[] }` |
| `shell:openPath` | `{path}` → reveal in Finder/Explorer (`shell.showItemInFolder`) |
| `shell:openExternal` | `{url}` (allowlist http/https) |
| `terminal:openExternal` | `{cwd}` → spawn configured external terminal (spec 13) |
| `notify:desktop` | `{title, body}` → OS notification |
| `git:progress` (evt) | spec 02 §5.3 `GitEventContract` (`repoId, opId, phase, percent, overall, text`), from the OperationQueue |
| `git:op:state` (evt) | spec 02 §5.3 (`repoId, opId, label, state, error?: SerializedGitError`) |
| `app:openRepoRequest` (evt) | `{path}` — second instance / CLI / file drop (spec 03) |
| `logs:open` | `{kind:'activity'|'error'|'performance'}` |

## 6. Git implementation

The shell itself mostly delegates. Relevant git commands it triggers:

- Breadcrumb branch: `git symbolic-ref --quiet --short HEAD` (fallback `git rev-parse --short HEAD` → detached).
- Ahead/behind for refs: `git for-each-ref --format='%(refname)%00%(upstream)%00%(upstream:track,nobracket)%00%(objectname)' refs/heads refs/remotes refs/tags` (parsed by spec 02).
- Branch switcher checkout: `git checkout <branch>` / remote: `git checkout -b <local> --track <remote>/<branch>` (spec 05).
- Pull modes: Fetch All plus the spec 09 `PullStrategy` values (`ff-if-possible`, `ff-only`, `rebase`), implemented by spec 09 §6.4 as fetch + integrate, not `git pull`. The default mode is stored in `git.pullMode` (spec 13).
- Push: `git push <remote> <branch>`; no upstream → `git push -u <remote> <branch>`.
- Stash: `git stash push [--include-untracked] -m "<msg>"`; Pop: `git stash pop` (stash@{0}).
- Solo filter: graph query uses `git log <soloedRefs...>` instead of `--all`; Hide: `git log --all --exclude=<hidden> ...` is not sufficient for multiple branch hide semantics, so spec 04 computes `--branches --remotes --tags` with `--exclude` patterns placed before each pseudo-ref (`git log --exclude=refs/heads/foo --branches ...`).
- Perform maintenance: `git maintenance run --task=gc` (git ≥2.29) else `git gc --auto`.
- Patch: `git diff HEAD > file.patch` (incl. `--binary`), apply: `git apply --3way <file>`.

## 7. Step-by-step implementation plan

1. **Window bootstrap**: create `WindowManager` with `BrowserWindow` (`frame:false` on Win/Linux with custom title bar, `titleBarStyle:'hiddenInset'` on mac), `contextIsolation:true`, `sandbox:true`. Persist/restore bounds (`windowState.json`). Test: open/close restores size.
2. **Preload API skeleton**: typed `window.api.invoke(channel, payload)` and `window.api.on(evt, cb)` generated from the per-domain contracts in `shared/ipc/` (git channels: `shared/ipc/git-contract.ts`, spec 02 §5.3, exposed as `window.api.git`).
3. **AppShell layout** with static placeholders for each region; CSS grid `rows: titlebar 38px | toolbar 48px | 1fr | statusbar 24px`.
4. **SplitPane** component + `useLayoutStore` persisted via `shell:saveLayout`. Unit test drag math; e2e: resize persists after restart.
5. **Tab model**: `useTabsStore` with open/close/activate/reorder/alias; persistence via `shell:saveTabs`; restore on launch when `general.rememberTabs`. Keyboard: Ctrl+T/W/1..9/Tab.
6. **Command registry + keybinding dispatcher**: register commands; global `keydown` listener resolves chord → command by `FocusZone` and `when`. Keybindings loaded from spec 13 store (defaults table §4.9). Test: each default shortcut dispatches its command id.
7. **Menu builder** in main generated from registry accelerators (`menu:rebuild`), clicks forwarded via `menu:invoke`.
8. **Command Palette**: overlay, fuzzy matcher (`packages/shared/fuzzy.ts`, unit-tested ranking), two-stage arguments, providers for files (`git ls-files -co --exclude-standard`), branches, tags, stashes, profiles, themes, repos.
9. **Toolbar**: buttons wired to commands; disabled/when states; Pull split button with persisted default; busy states from `git:progress` / `git:op:state`.
10. **Breadcrumb** repo & branch switchers.
11. **Left panel**: section stack with resizable sections, collapse/maximize; ref tree builder (split names on `/`); data from TanStack Query `['refs', repo]`; hide/solo icons and persistence; filter box with fuzzy highlight.
12. **Integrations-backed sections** (PRs, Issues, Teams, Actions) rendered as empty-state placeholders until spec 10/14 supply data.
13. **Right panel host** switching on `Selection`.
14. **Status bar**: op progress with cancel (`git:op:cancel`, spec 02), zoom selector, Launchpad summary placeholder.
15. **Toasts & notification center**, wire `git:op:state` failures (`SerializedGitError`) to error toasts with "Details".
16. **Zoom & fullscreen** commands + persistence.
17. **Context menus**: generic `ContextMenuHost` with item model (label, commandId, args, enabled, submenu, separator) — used by tabs, refs, commits.
18. **Accessibility**: roles (`tablist`, `tree`, `toolbar`, `dialog`), focus ring, F6 cycles focus zones (inferred, our addition).
19. **E2E suite**: Playwright scenarios for tabs, palette, shortcuts, hide/solo, resize persistence.

## 8. Edge cases

- **Repo path deleted/moved** while tab open or on restore → tab shows "Repository not found" state with Locate…/Remove buttons.
- **Detached HEAD**: breadcrumb shows short SHA; Push disabled with tooltip; Branch button creates branch at HEAD.
- **Empty repo (no commits)**: Branch/Stash/Pop disabled; graph shows only WIP; breadcrumb shows unborn branch name from `git symbolic-ref HEAD`.
- **Bare repo**: no WIP, no stash, no staging panel; toolbar hides Stash/Pop; right panel only commit details.
- **Thousands of refs**: left panel virtualized (react-window); filter debounced 80 ms.
- **Ref names with unicode/emoji/very long**: ellipsize middle, full name in tooltip.
- **Same repo opened twice**: focus existing tab instead of duplicating (unless different worktree).
- **Keyboard shortcut in text input**: single-letter shortcuts suppressed; Ctrl+Z in commit message undoes text, not git.
- **mac Cmd+Tab / Cmd+1..9 conflicts** with favorites; resolve as noted in §4.9.
- **Op running when user closes tab**: confirm "An operation is in progress. Cancel and close?"; cancel kills process (spec 02).
- **Window on disconnected monitor**: re-center on primary display.
- **Zoom with HiDPI**: canvas graph must re-read `devicePixelRatio * zoomFactor` (spec 04).
- **Solo with no remaining reachable commits** (e.g., soloed ref deleted): auto-remove stale refs from solo/hidden lists on refs refresh.
- **Many toasts** (e.g., fetch errors on auto-fetch): coalesce identical toasts by key, show "×3".

## 9. Acceptance criteria

- [ ] Window restores size/position/maximized state; custom title bar works on Win/Linux, native traffic lights on mac.
- [ ] Multiple repo tabs open; reorder, alias, close (middle-click, ×, Ctrl/Cmd+W), switch (Ctrl/Cmd+1..9, Ctrl+Tab); tabs restored per profile on restart.
- [ ] Toolbar Undo/Redo/Pull(+modes, default)/Push/Branch/Stash/Pop/Terminal invoke the right ops and reflect disabled/busy states.
- [ ] Breadcrumb switches repo and branch.
- [ ] Left panel shows all listed sections, collapsible, resizable, maximizable, hideable; filter works including `remote/` prefix; hide/solo affects the graph and persists per repo.
- [ ] Right panel switches between WIP and commit details on selection; toggles with Ctrl/Cmd+K.
- [ ] Status bar shows progress with cancel and zoom selector.
- [ ] Command Palette opens with Ctrl/Cmd+P, fuzzy-matches, supports two-stage commands, and contains every command in §4.8 that applies to the current context.
- [ ] All shortcuts in §4.9 work and appear in the Keyboard Shortcuts overlay (Ctrl/Cmd+/), and reflect user overrides.
- [ ] Error toasts show git stderr and a details view; desktop notifications only when unfocused & enabled.
- [ ] Zoom 50–300% and fullscreen work and persist zoom.
- [ ] Application menu accelerators match the keybinding registry.

## 10. Out of scope / later

- Agent Sessions (`List | Agents`) left panel mode and per-worktree agent status: defined in spec 12 §4.12, Phase 5 (spec 15).
- Teams section data (spec 14), GitHub Actions section (removed upstream; optional later).
- Detachable windows / multiple main windows.
- Touch Bar support (deprecated hardware).
- Customizable toolbar button order.
