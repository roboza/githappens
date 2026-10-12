# Hive 04 — Board, Panels, Attention Inbox & Graph Lens

> Owns: every Hive surface in the renderer — the pinned Hive app tab (one cross-repo board with a repo filter and the attention inbox; decided 2026-10-12), the compact per-repo left-panel mode, lane cards, the lane drawer (Terminal, Activity, Changes, Checks, Checkpoints, Info), the cross-repo attention inbox, notifications and badges, the "Hive lens" in the commit graph (G3), and keyboard behavior. Review/landing screens inside the drawer are specified in file 06; task creation dialogs in file 05.

## 1. Purpose

The user's scarce resource is attention. The UI must answer three questions at a glance — *who needs me*, *who is working*, *what is ready to land* — and let the user act on each without hunting through terminals and worktrees. It must also put agents where Git users already look: the commit graph.

## 2. Reference behavior

- The reference desktop app shows agents in a left-panel mode toggled from the normal ref list; each worktree is a card (branch, uncommitted changes, ahead/behind, PRs, agent status) with a three-dot menu, sort and filter (by status or branch) and text search; the toggle shows the highest-priority status of the repo's sessions; pending permission requests show inline with Allow / Deny and a command preview; the graph shows a WIP row for each worktree with changes or an active session, including agent status; external agent windows can be focused, or the session relaunched in the app's terminal; a "Running" state shows immediately when a session starts.
- The editor extension surfaces sessions in a sidebar list/tree (grouped by workspace or worktree), on graph overview cards and in a details panel; waiting sessions are most prominent; "completed" means ready to review.
- The vendor's separate agent environment uses a task board with stages, colored status dots with an "unread" state, and an "agent graph" overview of all sessions.
- Across the market (file 00): a cross-project inbox for approvals and questions, "unreviewed changes" counters, kanban columns that move automatically from activity signals, and side-by-side compare are the converging patterns. Nobody shows agent lanes inside a real commit graph (G3).

## 3. User stories

1. As a user I want one place listing everything waiting for me across all repos, in priority order, operable from the keyboard.
2. As a user I want one board of my tasks by stage (Working, Needs you, Review, Done) across all my repos, and to narrow it to the repo I'm working in with one click.
3. As a user I want to open any lane and see its live terminal, what it has done, what it changed, whether checks pass, and what it cost — in one drawer.
4. As a user I want to approve or deny a permission request without opening the terminal, with the full command visible.
5. As a user I want OS notifications when an agent needs me and GitHappens is in the background, without being spammed.
6. As a Git user I want to see all lane branches against their base in the graph, with status, conflicts and fan-out groups (G3).
7. As a user I want the existing left-panel Agents mode to keep working, just better.

## 4. UI specification

### 4.1 Placement in the app shell (spec 01 §4.1)

```
<AppShell>
 ├─ <TitleBar>
 │   ├─ <RepoTabBar> [Launchpad pinned] [Hive pinned ● 3] <RepoTab/>* …        ← Hive pinned app tab with attention badge
 │   └─ <TitleBarRight> … <AttentionBadgeButton/> (count; opens the Hive tab on its Needs-you inbox)
 ├─ <Toolbar> … <ToolbarRight> TerminalToggle · SearchButton · LaunchpadButton · WorkspacesButton · <HiveButton/> (count of live runs; opens the Hive tab scoped to this repo)
 ├─ <MainArea>  (repo tabs)
 │   ├─ <LeftPanel> <LeftPanelModeSwitch/> List | Hive  →  <HivePanel/> (§4.3, per-repo summary and entry point)
 │   ├─ <CenterArea> <GraphView/> (+ Hive lens, §4.8) | …
 │   └─ <RightPanel> … | <LaneDrawer/> (§4.4, when a lane is selected from the left panel or graph)
 ├─ <HiveTabView/>  (pinned app tab, §4.2: inbox rail + board/list + docked LaneDrawer)
 └─ <StatusBar> … <HiveStatusItem/> ("3 agents · 1 needs you"; click → Hive tab scoped to the active repo)
```

- **Hive is a single pinned app tab** (decided 2026-10-12), like Launchpad (spec 11 §4.2): `TabKind 'hive'` with no `repoPath`, leftmost after Launchpad, icon only with a status/attention badge, cannot be closed (hidden entirely when `hive.enabled` is off). There is exactly one board, covering all repos that have Hive lanes; it is **not** a per-repo tab.
- **Scope:** the board has a repo filter (`All repos` default, multi-select of repos, and workspaces from spec 11). Opening it **from a repo context** — toolbar Hive button, `hive.openBoard` while a repo tab is active, the left-panel "Open board" link, the status bar item, a repo tab's context menu "Open in Hive" — activates the pinned tab with a quick scope chip **"This repo: acme/web ✕"**; clearing the chip returns to the saved filter. Opening it from the tab bar, the title-bar badge or `hive.openBoardAll` shows the saved filter.
- **Lane drawer:** inside the Hive tab it docks on the right of the board; in a repo tab it renders in the right panel when a lane is selected from the left panel or the graph. Both can `Expand` to the full review layout of file 06 (inside whichever tab hosts it). "Open repo" in the drawer switches to (or opens) that repo's tab.
- **Status bar item:** live runs and attention count for the active repo (all repos on hover); click → Hive tab scoped to that repo.

### 4.2 Hive board (`HiveBoardView`)

```
HiveTabView (pinned)
├─ Header: Scope [All repos ▾] [This repo: acme/web ✕]   [+ New task ▾] (split: New task… · From issue… · From PR… · Fan-out…; asks for the repo when the scope isn't a single repo)
│          Search [ ]   Filter: Agent ▾ Status ▾ Label ▾   View: Board | List
│          Lanes 7 · 3.4 GB  ·  Today: 2h 10m agent time · $4.20 (est.)   ·  Conflicts ⚠ 2 (matrix; per repo, picker when several repos are in scope)
├─ InboxRail (left, collapsible; the cross-repo attention inbox, §4.6) — "Needs you (3)" items across the repos in scope
├─ Columns (default; collapsible, WIP counts)
│   Draft/Queued │ Working │ Needs you │ Review │ Done
│   ┌──────────────────────────────────────┐
│   │ TaskCard                    acme/web  │  ← repo chip (hidden when scoped to one repo)
│   │  Fix login redirect loop        #482  │  ← title, linked issue/PR chip
│   │  ┌ LaneRow (one per lane) ───────────┐│
│   │  │ ● Claude Code  needs permission   ││  ← status dot + text, since 2m
│   │  │   hive/fix-login-3fa2  ↑3 ↓1  12 files +240 −31  ✓ checks  $0.84 ││
│   │  │   ⚠ conflicts with "Refactor auth" (2 files)                     ││
│   │  │   [Allow] [Deny] [Open]            (inline when answerable)      ││
│   │  └───────────────────────────────────┘│
│   │  labels · depends on #… · plan ✓ · scope src/auth/**                 │
│   └──────────────────────────────────────┘
├─ LaneDrawer (right, docked, when a lane is selected; §4.4)
└─ Footer: queue: 2 tasks waiting for a free slot (max 4, all repos) · Edit limits
```

- **Grouping:** with several repos in scope, cards are grouped by repo inside each column (collapsible repo headers with counts); `Group by: Repo | None` toggle. The list view gets a Repo column.

- **Column assignment** is derived (file 01 §6.2): *Needs you* = any lane with an open `permission`/`question`/`plan-review`/`error`/`checks` item; *Working* = any lane `provisioning|running` and not needing you; *Review* = stage `review`; *Done* = stage `done`; *Draft/Queued* = `draft|queued`. Dragging a card sets `stageOverride` (display only) and shows a small "pinned to column" marker; dragging into Done asks "Mark done (keep lanes) / Accept a lane… / Archive".
- **Fan-out tasks** show one LaneRow per lane, sorted by status priority; a "Compare (3)" button opens the compare view (file 06 §4.4).
- **Status dot colors** (theme tokens, spec 13): working = `--kl-blue` pulsing (respects `ui.reduceMotion`), needs-permission/needs-input/plan-review = `--kl-orange`, error/checks failed = `--kl-red`, idle with unread changes = `--kl-teal` + bold title, idle seen = `--kl-grey`, done = `--kl-green`, exited = hollow grey. Status text always accompanies color (accessibility).
- **Unread:** a lane is unread when it has `turn-complete` with changes after `seenAt`; opening the drawer sets `seenAt`.
- **Card menu (⋯):** Open drawer · Send message… · Stop · Resume · Add lane (another agent)… · Run checks · Open worktree ▸ (current tab / new tab / editor / file manager / external terminal) · Copy branch name · Edit task… · Archive.
- **List view:** a table with one row per lane: repo, status, task, agent, branch, ahead/behind, files, checks, cost, last activity; sortable; multi-select actions (Stop, Run checks, Discard, Archive).
- **Empty state:** "Run several coding agents in parallel, each in its own worktree." + detected agents chips + [New task] + link to Agents preferences when none detected.
- **Loading/error:** skeleton cards; per-lane error banner (e.g. "Worktree folder missing — Recreate · Discard").

### 4.3 Left-panel Hive mode (`HivePanel`, replaces `AgentSessionsPanel`)

- Toggle `List | Hive` in the left-panel header (shown when `hive.showLeftPanelToggle`, alias `ui.showAgentsToggle`). The Hive segment shows a dot with the repo's rollup status (highest priority across sessions: needs-permission > needs-input > error > working > review/unread > idle) and a count of attention items.
- Content: search box, sort (Status · Recent · Branch), filter (Active · All · Needs you), then one compact row per lane (status dot, title, agent icon, branch, file count, ahead/behind) grouped as: **Needs you**, **Working**, **Review**, **Other worktrees** (non-Hive worktrees of the repo, with "Start agent here" — the §4.12 behavior), **External sessions** (process- or hook-detected, read-only).
- Row actions on hover: Focus terminal (opens drawer on Terminal tab) · Allow/Deny (when answerable) · ⋯ (card menu).
- Header link **Open board** (and the `hive.openBoard` shortcut) activates the pinned Hive tab scoped to this repo. The left-panel mode is the per-repo summary; the board itself lives only in the pinned tab.
- Footer: `[+ New task]` (for this repo) and a "Signals" plug icon showing how many detected agents report live status (opens Agents preferences, file 02 §4.1) — mirrors the reference's plug indicator.

### 4.4 Lane drawer (`LaneDrawer`)

```
LaneDrawer
├─ Header: status dot · task title · agent ▾ (switch agent for the next session) · branch (copy) · base ▾ · ↑↓ · [Stop] [⋯] [Expand]
├─ AttentionStrip (when the lane has open items; §4.6 item renderer inline)
├─ Tabs: Terminal | Activity | Changes (n) | Checks | Checkpoints (n) | Info
│   Terminal: xterm attached via hive:session:attach (live, interactive); session picker if the lane has several sessions;
│             "Pop out to terminal panel"; for headless/ACP runs a read-only rendered stream
│   Activity: timeline from hive:session:events — turns (prompt excerpt), tool calls (coalesced), permission decisions,
│             plans (G8), reports (G5), subagents, errors; filter chips; "Jump to terminal at this point" when pty offsets exist
│   Changes:  review surface (file 06 §4.1): file tree + diff, inline comments (G1), "Send feedback to agent (3)", commit/shape, accept
│   Checks:   check list with last result, duration, log viewer, [Run checks], forge CI rollup for the lane PR (G5)
│   Checkpoints: list (seq, label, time, +/−), diff between any two, Restore… (file 06 §4.6)
│   Info:     worktree path (open / reveal), setup steps and logs, ports, env names (no values), adapter + preset + model,
│             runs (pid, start/end, exit, argv redacted), usage (time, tokens, cost, by session) (G9), disk usage (G7), scope (G12)
└─ Composer (bottom): [Send to agent…] text area (Mod+Enter sends), "queue until idle" indicator (file 02 §6.3.5)
```

### 4.5 Usage and cost display (G9)

- Card: compact cost (`$0.84`) or time (`18m`) when cost is unknown; tooltip shows tokens in/out, active vs wall time, source (agent-reported / estimate).
- Board header: today's totals for the repos in scope; Info tab: per-session breakdown; compare view: cost column per lane.
- Budget progress bar on the card when a task budget exists; `budget` attention items at 80 % / 100 % (file 08 §6.7).
- Never display a guessed cost: when tokens are unknown, show time only.

### 4.6 Attention inbox (`InboxRail`, cross-repo, part of the Hive tab)

The inbox is a rail inside the pinned Hive tab (left of the board, collapsible, remembered), listing open attention items for the repos in the current scope (with "This repo" scope: that repo only; a "+N in other repos" link widens it). The title-bar badge and `hive.toggleInbox` open the Hive tab with the rail expanded and focused; `Mod+Alt+.` jumps to the next item from anywhere (switching to the Hive tab). Inline renderers of the same items also appear on cards, in the left panel and in the drawer's attention strip, so most items can be answered without leaving a repo tab.

```
InboxRail                              (scope follows the board) [Mark all reviewed]
├─ ▸ acme/web · Fix login redirect loop · Claude Code                         2m
│    Wants to run:  ┌──────────────────────────────────────────────┐
│                   │ npm run migrate -- --env test                 │  (monospace, full text, scrollable)
│                   └──────────────────────────────────────────────┘
│    cwd: hive/fix-login-3fa2 (inside lane) · risk: medium (runs package script)
│    [Allow once  Mod+Enter]  [Deny…  Mod+Backspace]  [Answer in terminal]  [Open lane]   expires in 4:31
├─ ▸ acme/api · Add rate limiter · plan ready (G8)          [Review plan]                 5m
├─ ▸ acme/web · Refactor auth · checks failed: test (3 failing)  [Open log] [Send to agent]
├─ ▸ acme/web · Bump deps · ready for review (14 files)      [Review]
└─ ▸ acme/api · ⚠ predicted conflict between 2 lanes         [Open matrix]
```

- Order: priority, then age (file 01 §6.7). Grouped by repo when more than one repo is in scope.
- **Permission item renderer** (also used inline on cards, the left panel and the drawer strip): agent + tool name, full command or file list (never silently truncated; long commands scroll, with "Copy"), cwd and whether anything is **outside the lane worktree** (red label), Hive's risk classification with reasons (file 08 §6.3), expiry countdown, options from `PermissionRequestView.options`. "Deny…" opens a one-line message field (sent to the agent when the adapter supports a deny message).
- **Allow is never a single key.** Keyboard: `J/K` move, `Enter` open lane, `Mod+Enter` allow once (only when the item is focused and its command is fully rendered), `Mod+Backspace` deny, `T` answer in terminal, `Esc` close. High-risk items require clicking Allow (keyboard allow disabled) *(our extension)*.
- **Plan-review renderer (G8):** the plan (markdown, or ACP plan entries as a checklist), editable in place; buttons Approve (continue with write access) · Revise… (send feedback, stay in planning) · Reject (stop lane). See file 05 §6.5.
- **Question renderer:** agent's message, "Answer" text box (sent via `hive:session:send`), or ACP elicitation form.
- **Review renderer:** file count, +/−, checks state, [Review] opens the drawer's Changes tab.
- Answered/expired items disappear after 3 s with an undo-free toast ("Allowed `npm test` for Claude in fix-login").

### 4.7 Notifications and badges

- **In-app toasts** (spec 01 §4.10) for: lane provisioning failed, run crashed, accept done/failed, queue progress.
- **OS notifications** (only when the window is unfocused and enabled per kind in `hive.notifications`): needs-permission, needs-input/question, plan-review, error, review-ready (off by default), checks failed. Title "Claude needs permission — Fix login", body = one-line summary. Click → focus window, open the Hive tab with the inbox rail focused on that item. Rate limits from file 01 §6.7.
- **Hive tab badge:** dot with the highest-priority status across all repos plus the open attention count.
- **Dock/taskbar badge:** total open attention items (`app.setBadgeCount` on macOS/Linux Unity; Windows overlay icon via `BrowserWindow.setOverlayIcon` with a small number glyph).
- **Repo tab badge:** orange dot when that repo has open attention items.
- Rich notifications (action buttons Allow/Deny in the OS notification, tray menu, quiet hours, sounds) are deferred (G15, §10).

### 4.8 Graph integration and the Hive lens (G3)

Always on (when Hive is enabled):

- Spec 04's WIP row per linked worktree shows, for lane worktrees, the lane's status dot and title instead of the folder name, and "agent working" even with no file changes yet (the reference shows WIP rows for worktrees with an active session). Toggle `hive.graph.showLaneWipRows` (default on).
- Lane branch ref pills get a small agent icon; hover card shows lane status, agent, task, checks, cost; click opens the drawer.

**Hive lens** (H4) — a graph filter mode toggled from the graph toolbar ("Hive lens" button, command `hive.graph.lens`, shortcut §4.10):

- **Refs shown:** the base branches of all non-closed lanes + every lane branch (+ remote-tracking counterparts if pushed) + remote lanes' PR branches (G11). Implemented as spec 04 solo mode with an explicit rev list (no change to the graph engine), commits outside those histories hidden, history below the oldest merge-base collapsed into one "… N earlier commits" row.
- **Lane chips:** at each lane branch tip, a chip with status dot, agent icon, title, `↑a ↓b` vs its base, checks badge.
- **Conflict edges:** dashed red curves between lane tips that the conflict matrix (file 07) predicts will conflict, labeled with the file count; hover lists files; click opens the matrix cell.
- **Fan-out grouping:** lanes of one fan-out task share a colored bracket in the lane column and a group label ("Fix login × 3").
- **Dependency arrows:** a thin arrow from a dependent lane's chip to its prerequisite lane's chip (file 07 §5.1).
- **Moving base:** when the base advanced since lane creation, the base tip is marked and each lane chip shows "behind by N" with a Restack action.
- **Scope overlay** (G12): optional highlight of lanes whose changes leave their declared scope.
- Rendering uses spec 04's canvas layer for edges (additional edge type `annotation` drawn above lanes, not affecting lane assignment) and DOM overlays for chips; capped at 30 lanes (beyond that, chips collapse into a "+N lanes" stack per base).

### 4.9 States

| Surface | Empty | Loading | Error |
|---|---|---|---|
| Board | intro + New task | skeleton cards (first load), cached state shown immediately afterwards | banner "Hive couldn't load state for this repo — Retry · Open logs" |
| Left panel | "No lanes yet — New task / Start agent in a worktree" | spinner rows | inline error row |
| Drawer Terminal | "This session has ended — Resume / View activity" | "Starting Claude Code…" with elapsed time | spawn error with adapter hint (e.g. "`claude` not found — Agents preferences") |
| Inbox | "Nothing needs you" | — | — |
| Graph lens | "No active lanes" chip in the graph toolbar | — | — |

### 4.10 Shortcuts and commands (defaults; rebindable, spec 13)

| Context | Action | Win/Linux | macOS | Command id |
|---|---|---|---|---|
| Global | Open Hive tab scoped to the active repo (all repos when no repo tab is active) | Ctrl+Shift+A | Cmd+Shift+A | `hive.openBoard` |
| Global | Open Hive tab with the saved scope | — | — | `hive.openBoardAll` |
| Global | New task | Ctrl+Alt+N | Cmd+Option+N | `hive.newTask` |
| Global | Jump to next attention item | Ctrl+Alt+. | Cmd+Option+. | `hive.nextAttention` |
| Global | Open Hive tab with the inbox rail focused | Ctrl+Alt+I | Cmd+Option+I | `hive.toggleInbox` |
| Graph | Toggle Hive lens | Ctrl+Alt+H | Cmd+Option+H | `hive.graph.lens` |
| Inbox (focused item) | Allow once | Ctrl+Enter | Cmd+Enter | `hive.attention.allow` |
| Inbox (focused item) | Deny | Ctrl+Backspace | Cmd+Backspace | `hive.attention.deny` |
| Inbox | Next / previous | J / K | J / K | `hive.attention.next/prev` |
| Board | Open selected lane | Enter | Enter | `hive.lane.open` |
| Drawer | Focus lane terminal | Ctrl+Alt+` | Cmd+Option+` | `hive.lane.focusTerminal` |
| Drawer | Send message | Ctrl+Enter (in composer) | Cmd+Enter | `hive.session.send` |

Single-letter keys follow spec 01's rule (inactive in text inputs, Monaco and the terminal). Conflicts were checked against spec 01 §4.9 and spec 12 §4.11 (`Ctrl+Shift+H` is file history, so the lens uses `Ctrl+Alt+H`; `Ctrl+Alt+T` is avoided because Linux desktops reserve it); the full command list is in file 09 §4.3.

## 5. Data model & IPC

The UI consumes `useHiveStore` / `useAttentionStore` (file 01 §5.6). The pinned tab's UI state is app-level (one board), stored in `profiles/<profileId>/hive/ui.json`:

```ts
export interface HiveTabUiState {             // pinned tab, one per profile
  scope: { kind: 'all' } | { kind: 'repos'; repoKeyHashes: string[] } | { kind: 'workspace'; workspaceId: string };
  quickRepo?: string;                         // transient "This repo" chip (repoKeyHash); not persisted across restarts
  groupByRepo: boolean;
  boardView: 'board' | 'list';
  collapsedColumns: TaskStage[];
  collapsedRepos: string[];
  inboxRail: { open: boolean; width: number };
  filters: { adapters: AdapterId[]; statuses: SessionStatus[]; labels: string[]; text: string };
  listSort: { key: 'repo' | 'status' | 'activity' | 'task' | 'cost'; dir: 'asc' | 'desc' };
  drawerTab: 'terminal' | 'activity' | 'changes' | 'checks' | 'checkpoints' | 'info';
}
```

Per-repo UI state in `repo-ui/<sha1>.json` (spec 01 `RepoUiState`) keeps only `graphLens: boolean` and `leftPanelMode: 'list' | 'hive'`.

No new IPC beyond file 01 §5.4; `notify:desktop` (spec 01) and a new `app:setBadge` (`{ count: number }`) invoke for dock/taskbar badges.

## 6. Implementation details

- **Rendering performance:** board and list are virtualized (react-window) for > 50 lanes; card status updates are throttled to 4 Hz per card; the drawer's Activity view virtualizes events and loads older pages on scroll.
- **Terminal attach:** reuse the spec 12 `TerminalPanel` xterm component in "attached" mode (no shell tab semantics, no close-kills-pty); replay buffer size from `terminal.scrollback`.
- **Graph lens data:** a selector builds `{ revs: string[]; annotations: GraphAnnotation[] }` from Hive state and the conflict matrix and passes it to spec 04 via a new `graph:setOverlay` renderer API (renderer-only, not IPC): `GraphAnnotation = { kind: 'lane-chip' | 'conflict-edge' | 'dep-arrow' | 'group-bracket' | 'base-marker'; … }`.
- **Accessibility:** status always has text; dots have `aria-label`; inbox is an ARIA listbox with live region announcements for new permission requests ("Claude needs permission in fix-login"); focus never jumps automatically to a new item (to avoid accidental approvals).
- **Theming:** all colors from tokens; new tokens `hive-working`, `hive-attention`, `hive-error`, `hive-review`, `hive-done` default to existing palette entries (spec 13 §5.3).

## 7. Step-by-step implementation plan

1. `HivePanel` replacing `AgentSessionsPanel` with the existing data (adopted lanes), status dots and rollup toggle. Test: component tests with store fixtures.
2. Lane drawer with Terminal (attach) and Info tabs. Test: attach/detach keeps the agent running.
3. Activity tab (events backfill + live). Test: 10k events virtualized; coalescing of tool events.
4. Attention item renderers + inline Allow/Deny on cards and panel; keyboard rules. Test: no single-key allow; high-risk requires click.
5. Pinned Hive tab (`TabKind 'hive'`, spec 01) with scope filter, "This repo" quick scope from repo contexts, repo grouping. Test: opening from a repo tab scopes to that repo; clearing restores the saved scope.
6. Inbox rail (cross-repo), title-bar badge, Hive tab badge, OS notifications with rate limits. Test with fake timers and fake notifier.
6a. Board view (columns, derivation, drag override, fan-out lane rows, list view with Repo column). Test: column derivation table.
7. Usage display (G9) on cards/header/Info. Test: unknown cost shows time only.
8. Graph WIP-row enrichment and ref-pill icons (spec 04 hooks). Test: visual snapshot.
9. Hive lens (G3): rev list, chips, conflict edges, groups, dependency arrows. Test: visual snapshots on fixture repos with 3 lanes incl. a conflicting pair.
10. Shortcuts and palette commands registration (file 09).

## 8. Edge cases

- **Many repos with agents:** one board; cards and inbox group by repo; the status bar shows totals across repos on hover.
- **Lane in a repo whose tab is closed:** still listed on the board and in the inbox; its drawer works inside the Hive tab (main-process state does not need the repo tab); "Open repo" opens the repo tab.
- **New task with "All repos" scope:** the dialog asks for the repo first (recent repos and repos with lanes on top).
- **Repo removed or moved on disk:** its lanes show under a "Missing repo" group with Re-link / Remove from Hive.
- **Permission request arrives while the user is typing in the composer:** no focus steal; the strip appears above the composer.
- **Request answered in the terminal** at the same time as clicking Allow: the bridge delivers the first decision; the second gets `delivered: false` and a toast "Already answered in the terminal".
- **Very long commands** (multi-KB heredocs): rendered in a scroll box with line numbers; Allow disabled until the user scrolled to the end or expanded it *(our extension)*.
- **Reduced motion:** no pulsing dots.
- **Small windows:** drawer becomes a full-width overlay below 1100 px; board columns scroll horizontally.

## 9. Acceptance criteria

- [ ] A permission request from any open repo appears in the inbox within 1 s, with full command, cwd/outside-worktree flag and risk, and can be answered with mouse or `Mod+Enter`; single keys never approve.
- [ ] Hive is a single pinned tab: it cannot be closed, shows lanes from every repo with a repo filter, and opening it from a repo tab (toolbar, shortcut, left panel, status bar) scopes it to that repo with a removable "This repo" chip.
- [ ] Board columns reflect lane status changes within 1 s; fan-out tasks show one row per lane and a Compare button.
- [ ] The left-panel `List | Hive` toggle shows the rollup status and supports everything the old Agents view did (start agent in a worktree, focus terminal, stop, open worktree, show changes).
- [ ] The drawer's Terminal tab is interactive and closing the drawer never stops the agent.
- [ ] OS notifications fire only when unfocused and respect per-kind settings and rate limits; dock/taskbar badge shows the open count.
- [ ] Hive lens shows only base + lane branches with chips, conflict edges, fan-out brackets and dependency arrows on a fixture with 3 lanes.
- [ ] Cost is shown only when reported or estimated from a configured price table; otherwise time.

## 10. Out of scope / later

- Rich OS notifications with Allow/Deny buttons, tray menu, quiet hours, per-kind sounds (G15).
- Mobile/remote check-in (G23).
- Session history search across closed lanes (G22).
- Agent-blame gutter in diffs/blame (G4; file 06 §10).
- A chat UI for ACP sessions (README non-goals).
- Several Hive boards side by side (one pinned tab only; saved views are a later idea).

## 11. Cross-spec dependencies

- **Spec 01:** pinned app tab `TabKind 'hive'` (no `repoPath`; pinned like Launchpad, spec 11 §4.2), title-bar badge slot, toolbar slot, left-panel mode switch (`List | Hive`), right-panel drawer host, toasts, `notify:desktop`, shortcut table additions.
- **Spec 11:** pinned-tab conventions shared with Launchpad; workspace scopes for the board filter.
- **Spec 04:** WIP rows per worktree (§11) enriched with lane status; solo-mode rev list for the lens; new overlay/annotation layer (`graph:setOverlay`) for chips, conflict edges, brackets and arrows.
- **Spec 12:** xterm terminal component in attached mode; `TerminalPanel` pop-out.
- **Spec 13:** theme tokens `hive-*`, `ui.showAgentsToggle` alias, keybinding overrides.
- **Files 06/07:** Changes/compare/checkpoint UIs and conflict matrix data.
