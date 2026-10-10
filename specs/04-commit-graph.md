# 04 — Commit Graph

> Depends on: 00 (binding tech), 01 (app shell / panels / shortcuts), 02 (GitService, IPC, watcher, op queue). Feeds: 05 (drag & drop ops, context-menu actions), 06 (WIP node), 07 (commit detail / diff on selection), 10 (PR badges, avatars), 12 (advanced search, interactive rebase), 13 (graph preferences).
> Code lives in `packages/graph` (pure layout + renderer, no Electron imports) and `apps/desktop/src/renderer/views/graph`.

---

## 1. Purpose

The commit graph is the center of the app. It shows the repository's history as a DAG: one row per commit, newest at the top, colored lanes for lines of development, and labels for branches, tags, stashes and HEAD. Most git operations start here: select a commit to inspect it, right-click for actions, double-click to check out, drag a branch onto another to merge or rebase. Users pick GitHappens because this view is fast, readable and interactive. Our graph has to open a 100k+ commit repository in under 2 s, scroll at 60 fps, and stay correct when refs change under it.

---

## 2. Reference behavior

Researched from desktop Git client help pages (Interface guide, Hiding & Soloing, Keyboard shortcuts, Tips, release notes), the commit-graph feature page, and observed product behavior. Items marked *(inferred)* come from screenshots or general product knowledge rather than explicit documentation.

### 2.1 Layout and columns
- The graph occupies the central panel. The default columns are **Branch/Tag**, **Graph** and **Commit Message**. Users can also turn on **Author**, **Date/Time** and **SHA**.
- Columns can be reordered by dragging headers. Right-clicking a header, or opening the gear icon in the graph header, toggles column visibility. Widths, order and visibility are **saved per repository**, and defaults can be set in Preferences › UI Customization.
- Column dividers can be dragged to resize. Hovering the graph's colored lines and dragging also resizes the graph column.
- The author column header has a **filter control** that limits the graph to chosen authors.
- There is a **compact graph column** option in the graph settings gear: narrower lanes and small dot nodes instead of avatars.
- Newer versions add a "Changes" column (file count plus a +/− bar) *(feature page)*. We treat it as optional (§10).

### 2.2 Rows and nodes
- Each row is one commit, newest first. Lines between rows show parent relationships, and merges render as lines joining lanes.
- The **WIP node** is a synthetic top row that appears when the working tree has changes. It is drawn as a dashed or hollow circle in the HEAD lane, and its message cell shows "// WIP" or a draft summary plus counts of changed files. Clicking it opens the staging panel (spec 06).
- A synthetic **conflict/merge-in-progress** entry replaces the WIP node during a conflicted merge or rebase. "Select first" (Ctrl+Home / ⌘↑) selects the WIP or conflict entry when one exists (v11.6).
- **Commit nodes** are circles that hold the author's avatar (Gravatar or provider avatar, with GitHub/GitLab/Bitbucket DC avatars added in v11.1–11.2), ringed in the lane color. When no avatar is available, the circle shows initials.
- **Merge commits** are drawn as smaller plain dots without an avatar *(inferred)*.
- **Stash nodes** appear in the graph attached to the commit they were created from, with a distinct icon and a dashed connector *(inferred styling)*.
- The legend lists commits, merge commits, WIP, branches and stash nodes.

### 2.3 Ref labels (Branch/Tag column)
- Each ref pointing at a commit appears as a pill in the left column on that commit's row, joined to the node by a horizontal line in the lane color.
- Icons: a computer/laptop icon for a local branch, the remote's provider avatar or a cloud icon for a remote branch, a tag icon for tags, and a check mark for the checked-out branch (HEAD).
- When a local branch and its upstream point at the same commit, they collapse into **one pill showing both icons** *(inferred)*.
- If more refs exist than fit, the pill shows a **"+N"** counter. Hovering it opens a list of all refs.
- Hovering a pill shows hide (eye) and solo affordances *(inferred)*. Branches with an open pull request show a **PR icon** that links to the PR (feature page).
- Remote-only branches (no local counterpart) show only the remote icon. Double-clicking one creates a local tracking branch and checks it out.

### 2.4 Highlighting and selection
- **Ghost branch:** hovering or selecting a commit shows its nearest containing branch as a translucent label in the ref column.
- **Branch highlight:** hovering a branch highlights the commits reachable from it and fades unrelated rows. This can be disabled in Preferences › UI Customization.
- Single click selects a commit and shows its details in the right panel (spec 07).
- **Shift-click** selects a contiguous range and **Ctrl/⌘-click** toggles individual commits. Two selected commits produce a comparison diff. A consecutive range produces a combined diff, including WIP if the range reaches the top. Multi-select enables "Cherry pick N commits" and similar bulk actions. Selections that are not consecutive and contain more than two items produce no combined diff, and the app explains why.
- **Double-click** a commit to check out its branch. If no branch points at it, the commit is checked out detached.

### 2.5 Keyboard navigation (defaults)
| Action | Win/Linux | macOS |
|---|---|---|
| Next / previous row | J / ↓, K / ↑ | same |
| Left / right panel item | H / ←, L / → | same |
| Next / previous commit in same branch (first-parent) | Shift+J / Shift+↓, Shift+K / Shift+↑ | same |
| First row (WIP if present) | Ctrl+Home | ⌘↑ |
| Last loaded row | Ctrl+End | ⌘↓ |
| Toggle commit detail panel | Ctrl+K | ⌘K |
| Search commits | Ctrl+F | ⌘F |
| Find file → history/blame | Ctrl+Shift+H | ⌘⇧H |
| Close panel / clear selection | Esc | Esc |

### 2.6 Visibility controls
- **Hide** a branch, tag, remote or stash from the left panel (eye icon) or a context menu. Hidden refs show a gray icon. Hiding affects display only.
- **Solo** a branch from its context menu. Every ref that is not soloed is hidden. Soloed refs show an orange icon, and whole remotes can be soloed.
- Right-clicking the Branches, Remotes, Tags or Stashes section header offers bulk hide/show.
- v11.10 adds **Pin to left**, which keeps a branch's lane in the leftmost column (unpin from the context menu), and **Smart Branch Visibility**, a gear-menu filter showing only the current branch, its target branch and their upstreams.
- v11.6 hides prefetch refs (`refs/prefetch/*`) and git notes from the graph.

### 2.7 Search and filter
- Ctrl/⌘+F opens graph search. Matching rows are highlighted and arrows step through the results. You can search by message, author, SHA, and changed file or code (feature page). There are also author/team filters and filters for "my changes", date range and commit type, plus an option to dim merge commits.
- AI natural-language search exists in newer versions (spec 12, out of scope here).

### 2.8 History depth
- By default the app loads a limited number of commits (a preference, historically around 2,000) and loads more as you scroll near the bottom. A "show all commits" style preference removes the cap *(inferred defaults)*.

### 2.9 Context menus
The commit menu covers checkout, create branch/tag/worktree here, cherry-pick, reset (soft/mixed/hard), revert, copy SHA, copy link, compare with working directory, create patch, interactive rebase, view on provider, Solo, and AI explain. Ref menus add pull, push, merge, rebase, fast-forward, rename, delete, set upstream, PR actions, copy name, hide/solo/pin. The full list we implement is in §4.10.

### 2.10 Drag and drop
Dragging a branch pill onto another branch pill or commit opens a menu with: Merge A into B, Rebase B onto A, Interactive rebase, Fast-forward, Reset B to A, Push A to B (for remotes) and Start pull request. Spec 05 defines the operations. This spec defines the gesture and the hit targets.

---

## 3. User stories

1. As a developer, I want to see branches as straight, color-coded lanes so that I can follow a line of work without it zig-zagging.
2. As a developer, I want the WIP node at the top so that I always see my uncommitted state relative to HEAD.
3. As a developer, I want to see every ref (local, remote, tag, HEAD, stash) attached to its commit, with icons, so that I know where things are.
4. As a reviewer, I want to hover a branch and see only its ancestry highlighted so that I can tell what it contains.
5. As a developer, I want to multi-select commits with shift/ctrl so that I can cherry-pick, squash or compare them.
6. As a maintainer of a large monorepo, I want the graph to open and scroll smoothly with 500k commits so that the tool doesn't slow me down.
7. As a developer, I want to hide noisy branches or solo the ones I care about so that the graph only shows relevant history.
8. As a developer, I want to search by message, author, SHA or changed file and jump between matches.
9. As a developer, I want to right-click any commit or ref and find every relevant git action.
10. As a developer, I want to drag `feature` onto `main` to merge or rebase in one gesture.
11. As a developer, I want "Jump to HEAD" to scroll the graph to my current commit.
12. As a team member, I want to see author avatars and PR badges so that I recognize work at a glance.
13. As a user with a small screen, I want a compact graph mode and configurable columns.

---

## 4. UI specification

### 4.1 Component tree

```
<GraphView repoId>                         // views/graph/GraphView.tsx
├─ <GraphToolbarStrip>                     // search field, filter chips, gear menu, jump-to-HEAD
│   ├─ <GraphSearchBox/>                   // Ctrl+F; mode dropdown (message|author|sha|file|content)
│   ├─ <GraphFilterChips/>                 // active author filter, solo mode, smart visibility
│   └─ <GraphSettingsMenu/>                // gear: columns, compact, highlight, dim merges, avatars, history limit
├─ <GraphHeader columns>                   // column headers: drag to reorder, resize handles, right-click menu
│   └─ <ColumnHeader id> × N               // author header hosts <AuthorFilterPopover/>
├─ <GraphViewport>                         // single scroll container; owns scrollTop & viewport size
│   ├─ <UnderlayCanvas/>                   // full-width: row backgrounds (hover/selection/highlight/search), ref connector lines
│   ├─ <RefColumnLayer/>                   // DOM, virtualized: <RefPillGroup> per visible row
│   │   └─ <RefPill/> | <OverflowPill +N/> | <GhostRefPill/>
│   ├─ <GraphCanvas/>                      // lanes, edges, nodes, avatars (Canvas 2D)
│   ├─ <TextColumnsLayer/>                 // DOM, virtualized pooled rows: message, author, date, sha
│   │   └─ <GraphRow index> → <MessageCell/> <AuthorCell/> <DateCell/> <ShaCell/>
│   ├─ <DragGhost/>                        // follows pointer during ref drag
│   └─ <ScrollShim/>                       // tall spacer (or scaled-scroll mode, §4.13)
├─ <LoadMoreFooter/>                       // "Loading more…" / "Load all N commits" / end-of-history
├─ <GraphContextMenu/>                     // built from MenuModel (§4.10), rendered by app-shell menu system
└─ <GraphEmptyState/> | <GraphErrorState/> | <GraphLoadingSkeleton/>
```

The state lives in Zustand `useGraphStore(repoId)`. Layout data stays in typed arrays outside React state, held by `GraphModel` and referenced through a version counter, so no array copies are made per render.

### 4.2 Columns

| id | Default | Min/Default width | Content | Notes |
|---|---|---|---|---|
| `refs` | visible, first | 80 / 180 | Ref pills | Overflow "+N" when the pills don't fit |
| `graph` | visible | 24 / auto (lanes×laneW + pad, max 400) | Canvas | Lanes past the width are clipped with a fade (§4.6) |
| `message` | visible | 120 / flex | Summary (first line) + optional body preview in muted text | Flex column takes the remaining space |
| `author` | hidden | 80 / 140 | Avatar (16px) + name | Header filter |
| `datetime` | hidden | 90 / 150 | Relative ("3 hours ago") or absolute, per preference (spec 13) | Tooltip shows the full ISO time. Author vs committer date is a preference |
| `sha` | hidden | 60 / 80 | Abbreviated SHA (7, or `core.abbrev`) in monospace | Click copies |
| `changes` | hidden, later | 80 / 110 | Files changed, with a +/− bar | §10 |

- Reorder by dragging a header. A drop indicator appears between headers. `graph` may move anywhere, but `message` always remains the flex column.
- Resize by dragging the 4px handle on a header's right edge. Double-clicking the handle autosizes the column. For `graph`, autosize fits the maximum lane count in the visible rows.
- Visibility can be toggled from the header right-click menu or the gear menu. At least `message` must stay visible.
- Persistence: `ColumnLayout` is saved per repo in `userData/repos/<repoKey>/graph.json`, falling back to the global default in Preferences › UI Customization (spec 13).

### 4.3 Row metrics

| Mode | Row height | Lane width | Node radius | Avatar | Merge dot radius | Font |
|---|---|---|---|---|---|---|
| Normal | 28 px | 22 px | 10 px (avatar inside, 2px ring) | 16 px | 4 px | 13px UI |
| Compact | 22 px | 12 px | 4 px dot, no avatar | none | 3 px | 12px UI |

Row height also scales with the UI zoom preference (spec 13). All metrics live in `GraphMetrics`, so nothing is hard-coded in the renderer.

### 4.4 Special rows
- **WIP row** (index 0 when the working tree is dirty or the index is non-empty): a hollow dashed circle in HEAD's lane color, joined to HEAD's node by a dashed edge. The message cell shows the commit-composer summary draft (spec 06) or `// WIP`, plus badges such as `✎3 +1 −2` (modified/added/deleted). Clicking it selects WIP and the right panel shows staging.
- **Merge-in-progress / conflict row:** replaces the WIP row while `MERGE_HEAD`, `REBASE_HEAD`/`rebase-merge`, `CHERRY_PICK_HEAD` or `REVERT_HEAD` exists. It has a warning color, the label "Merge conflict — 3 files", and a dashed edge to both HEAD and the incoming commit (MERGE_HEAD) when that commit is in the graph. Clicking it opens the conflict list (spec 08).
- **Stash rows:** one row per stash, inserted at its timestamp but always above its base commit (§6.4). The node is a square-ish "box" icon in a neutral color. A dashed edge runs to the base commit, and the label pill reads `stash@{n}: message`.
- **Detached HEAD:** a `HEAD` pill with a detached icon on the HEAD commit.

### 4.5 Ref pills
```
[✓ 💻☁ main  ⓟ#123]──────●
 │  │  │       └ PR badge (provider icon + number; click opens PR panel, spec 10)
 │  │  └ remote icon (provider logo or cloud); present if upstream at same commit (combined pill)
 │  └ local icon
 └ checked-out marker
```
- **Grouping rule per row:** each local branch absorbs remote branches that are its configured upstream (`branch.<n>.remote/merge`) and point at the same commit, which produces the combined pill. Other remote branches with the same short name on the same commit are also absorbed *(inferred)*.
- **Sort order within a row:** HEAD branch, then other local branches, remote-only branches, tags and stash. Within each group the order is alphabetical.
- **Width:** the first pill gets the full column width minus the "+N" width and truncates its name in the middle (`feature/…/login`). Only the first pill shows in the column. The rest collapse into "+N".
- **Hover:** a tooltip lists the full name and upstream ahead/behind counts (`↑2 ↓5`). The eye (hide) and solo icons appear at the pill's right end. Hovering also triggers the branch highlight (§4.8).
- **"+N" hover/click:** a popover lists every ref on that row with the same icons. Each entry can be dragged, right-clicked or double-clicked.
- **Connector:** a line in the lane color runs from the pill's right edge to the node's left edge, crossing intervening lanes in the graph column. It is drawn on `UnderlayCanvas` so it sits beneath lanes.
- **Ghost pill:** for the hovered or selected commit with no ref, the nearest descendant branch tip (§6.7) renders at 40% opacity.
- **Colors:** the pill background is the lane color at 20% alpha with a solid lane-color border. The HEAD pill is bold.
- **Tags:** a tag icon and the tag name. Annotated tags show the tagger and message in the tooltip.
- **Hidden refs** never render pills. Their commits remain if another visible ref reaches them.

### 4.6 Graph canvas visuals
- **Lane color** comes from `palette[column % palette.length]`. The palette comes from the theme (spec 13) and has 10–12 hues. Color follows the column, not the branch name *(inferred)*. An optional "color by branch" mode is described in §6.3.6.
- **Edge stroke:** 2px (normal) or 1.5px (compact), with round caps. Edges into hidden or unloaded commits fade over the last 2 rows using a gradient.
- **Edge shapes (default "rounded-orthogonal"):**
  - *Pass-through:* a vertical line along the lane between row centers.
  - *Merge-out* (from node at column c to a second parent's lane k): the line runs horizontally at the node's row from c toward k, then turns down into lane k with a quarter-circle corner of radius `min(laneW, rowH)/2`.
  - *Branch-in* (a child lane k ending at the parent node at column c): the line comes down lane k, turns with a quarter-circle corner, and runs horizontally into the node at the node's row.
  - An alternative style, "bezier" (Preferences), draws each non-vertical segment as a cubic from `(x1, y1)` to `(x2, y2)` with control points `(x1, y1 + 0.8·rowH)` and `(x2, y2 − 0.8·rowH)`, in the manner of vscode-git-graph.
- **Nodes** are drawn after edges. Normal commits get a filled circle with the avatar image clipped to a circle and a 2px lane-color ring. Merge commits get a solid lane-color dot. The HEAD commit gets an extra outer ring. Selected commits get a highlight ring in the theme accent color. WIP and stash nodes use their own shapes (§4.4).
- **Dimming:** rows outside the highlight set, outside the search match set (in filter mode), or merge commits under "dim merges" draw at 30% alpha in both canvas and DOM.
- **Overflow:** when lanes exceed the graph column width, lanes beyond the right edge are clipped and a 12px fade gradient is drawn at the edge. Hovering the fade shows "N more lanes — widen column".

### 4.7 Interactions (mouse)

| Gesture | Target | Result |
|---|---|---|
| Click | Row (any column) | Select single. Detail panel shows the commit (spec 07) |
| Ctrl/⌘+click | Row | Toggle in selection |
| Shift+click | Row | Range from anchor to row |
| Double-click | Commit row | Checkout (§6.9) |
| Double-click | Ref pill | Checkout that ref (remote-only: create tracking branch + checkout) |
| Right-click | Row / node | Commit menu. If the row is part of a multi-selection, the multi-select menu instead |
| Right-click | Pill | Ref menu for that ref |
| Hover | Pill | Branch highlight + action icons |
| Hover | Node | Tooltip (sha, author, date, refs) after 400 ms, plus the ghost ref |
| Drag | Pill → pill/row | Ref drag-and-drop (§4.11) |
| Drag | Graph column divider or lane area edge | Resize graph column |
| Wheel / trackpad | Viewport | Vertical scroll. Shift+wheel or horizontal scroll pans the graph column if lanes overflow |
| Middle-click | Pill | Toggle hide *(our addition)* |

### 4.8 Highlighting (ancestry)
- **Trigger:** hovering a ref pill or a left-panel branch entry, or the "highlight selected branch" mode (selecting a pill keeps the highlight until Esc).
- **Effect:** commits reachable from the ref, among loaded rows, draw normally. Every other row and edge draws at 30% alpha. The lanes of the highlighted commits are drawn last so they sit on top.
- Computation is described in §6.6 and caches results per ref tip SHA.
- Preference `ui.graphHoverHighlight` (spec 13, default on).

### 4.9 Multi-select
- The selection model holds an `anchor` row, a `Set<rowKey>` and a `focus` row. Row keys are SHAs, so the selection survives relayout. `'WIP'` is a valid key.
- The detail panel shows:
  - 1 commit: commit detail.
  - 2 commits: a comparison `A..B` (spec 07).
  - A contiguous run along first-parent ancestry: the combined diff `oldest^..newest`. If WIP is included, the combined diff of the working tree against `oldest^`.
  - Otherwise: "N commits selected" with bulk actions and the message "Combined diff unavailable for non-consecutive selections".
- Keyboard: Shift+↑/↓ extends the selection *(our addition; Shift+J/K is first-parent navigation, so we use Shift+Alt+↑/↓ for extend)*.

### 4.10 Context menus (complete list)

Menus are built from data (`MenuItemModel[]`) so that commands are shared with the command palette (spec 01). Each item names an op id from spec 05 or 07. Disabled items show a tooltip with the reason.

**Commit row menu** (single commit `C`; `B` = current branch; `head` = HEAD sha):
1. Checkout this commit (detached). If refs exist on C, the submenu lists "Checkout <ref>".
2. Create branch here…
3. Create tag here…
4. Create annotated tag here…
5. Create worktree here… (spec 09)
6. Cherry pick commit (disabled if C is an ancestor of HEAD). For a merge commit: "Cherry pick (mainline 1)…" → parent picker.
7. Reset `B` to this commit ▸ Soft / Mixed / Hard (disabled when detached → "Reset HEAD to this commit")
8. Revert commit (merge commit → mainline picker)
9. Edit commit message (enabled when C is HEAD (amend), or when C is in HEAD's first-parent history without merges above it (reword via interactive rebase, spec 12))
10. Interactive rebase `B` onto this commit… / "Rebase children of C interactively" (spec 12)
11. Drop commit (via rebase, same enablement as 9)
12. Move commit up / down (via rebase, same enablement) *(inferred)*
13. Compare commit against working directory
14. Compare with… (pick another commit/ref)
15. Create patch from commit… / Copy patch to clipboard
16. Explain commit (AI, spec 12)
17. Copy commit SHA / Copy short SHA / Copy commit message
18. Copy link to commit (needs a provider remote) / View commit on <Provider>
19. Solo branches containing this commit *(inferred)* / Hide
20. Mark as… none (reserved)

**Multi-selection menu** (N ≥ 2 commits):
1. Cherry pick N commits (applied oldest → newest)
2. Revert N commits
3. Squash N commits (only if contiguous on HEAD's first-parent history, spec 12)
4. Drop N commits (same constraint)
5. Compare these 2 commits (N = 2) / Show combined diff (contiguous)
6. Create patch from N commits
7. Copy SHAs (newline-separated)

**Local branch pill menu** (`X`; `B` = checked-out branch):
1. Checkout `X` (hidden if `X` is checked out)
2. Pull (fast-forward if possible) / Pull (rebase) (only if `X` has an upstream; for a non-checked-out branch, "Fast-forward `X`" via `git fetch . upstream:X` *(inferred)*)
3. Push / Force push (with lease) / Set upstream…
4. Fetch `X`'s remote
5. Merge `X` into `B` / Rebase `B` onto `X` / Interactive rebase `B` onto `X` (hidden if `X == B`)
6. Fast-forward `B` to `X` (enabled if B is an ancestor of X)
7. Reset `B` to `X` ▸ Soft / Mixed / Hard
8. Cherry pick `X`'s tip commit
9. Create branch here… / Create tag here… / Create worktree from `X`…
10. Start a pull request from `X`… / View pull request #n (if open PR) (spec 10)
11. Compare `X` with `B` / with…
12. Rename `X`…
13. Delete `X` (local) / Delete `X` and its remote branch
14. Copy branch name / Copy link to branch
15. Hide / Solo / Pin to left (Unpin)
16. Set as base for "Smart Branch Visibility" *(our addition, optional)*

**Remote branch pill menu** (`origin/Y`):
1. Checkout → create local tracking branch `Y` (if absent) or checkout existing
2. Fetch `origin/Y` / Fetch `origin`
3. Merge / Rebase / Interactive rebase / Fast-forward / Reset (as above, with `origin/Y` as source)
4. Create branch here…
5. Start pull request from `Y` / View PR
6. Delete `origin/Y` (remote push --delete)
7. Copy remote branch name / Copy link to branch / Open branch on <Provider>
8. Hide / Solo / Hide remote `origin` / Solo remote `origin`

**Tag pill menu:** Checkout tag (detached) · Create branch here · Push tag to <remote> ▸ · Delete tag locally · Delete tag from <remote> ▸ · Copy tag name · Copy annotated message · Hide / Solo · Annotate (convert lightweight → annotated) *(our addition, later)*.

**Stash row menu:** Apply stash · Pop stash · Delete stash (confirm) · Edit stash message · Create branch from stash (`git stash branch`) · Copy SHA · Hide stash.

**WIP row menu:** Stash all changes · Stash (include untracked) · Discard all changes (confirm; reset + clean prompt) · Create branch with these changes… · Open terminal here · Copy patch of all changes.

**Header context menu:** column visibility checkboxes · "Reset columns to default" · Compact graph · Show avatars / initials only.

### 4.11 Drag and drop of refs
- **Drag source:** any pill (local, remote, tag) or a "+N" popover entry. Drag starts after a 4px move. The `DragGhost` shows the pill under the cursor.
- **Drop targets:** another pill, any commit row (target = that commit), the WIP row (no-op), a remote in the left panel (push), or the PR section of the left panel (start PR). The hovered target row gets an accent outline. Invalid targets show a not-allowed cursor.
- On drop the graph emits `onRefDrop({ source: RefRef, target: RefRef | { sha } })`. Spec 05 resolves the menu (Merge/Rebase/Interactive rebase/Fast-forward/Reset/Push/Start PR/Cherry-pick tip) and shows it at the drop point. Esc cancels the drag.
- **Conflict preview (optional):** while the cursor hovers a target for 500 ms, run `merge-tree` prediction (spec 08 §4.9) and badge the target "⚠ N conflicts".

### 4.12 Search and filter UI
- Ctrl/⌘+F focuses `GraphSearchBox`. The mode is set by a dropdown or prefix: no prefix → message+author+sha, `@` author, `#` sha, `file:` path, `~` content (pickaxe `-S`), `=` regex content (`-G`). Spec 12 owns the full query syntax. This spec defines what the graph does with results.
- **Results:** a set of SHAs. Matching rows get a highlight band, and the box shows `3 / 41` with ↑/↓ (Enter / Shift+Enter) to jump between results. A toggle switches between **Highlight** (default; non-matches stay normal) and **Filter** (non-matches dimmed to 30%) *(highlight is the documented behavior; filter is inferred)*.
- **Loaded-only vs. full:** message, author and sha matching on loaded rows is instant and client-side. "Search entire history" (automatic for `file:`, `~`, `=`) runs git in the main process (§6.8), streams SHAs, and loads more history as needed so that matches are visible.
- **Author filter popover** (author header): a checklist of authors in loaded history with counts and a "Me" shortcut. Applying it adds `--author` re-query semantics (§6.8.3) and a filter chip.
- **Jump to HEAD:** toolbar button, command palette "Graph: Jump to HEAD", and shortcut Ctrl/⌘+Shift+0 *(our choice)*. If HEAD's row isn't loaded, the graph loads until it is, then scrolls it to the vertical center and selects it.

### 4.13 Virtualization and scrolling
- A single native scroll container. Its spacer height is `rowCount × rowH`.
- When `rowCount × rowH > 15,000,000 px` (Chromium's limit is about 33.5M), enable **scaled scroll mode**. The spacer is fixed at 15M px and `virtualTop = scrollTop × (totalH − viewportH) / (15M − viewportH)`. Wheel deltas are applied in virtual space by a wheel handler so that per-pixel scrolling stays smooth.
- Only rows in `[firstVisible − overscan, lastVisible + overscan]` (overscan = 10) are rendered in DOM. Row elements are pooled and recycled by `index % poolSize` and positioned with `transform: translateY`.
- The canvases cover the viewport, not the full content. On scroll, `requestAnimationFrame` redraws only the visible rows plus one row above and below for edges.

### 4.14 States
- **Loading (first open):** a skeleton of 20 gray rows. The first chunk (≤ 500 rows) paints as soon as it is laid out, so the target is first paint under 300 ms on a warm cache.
- **Empty repo (no commits):** "This repository has no commits yet". The WIP row still shows if there are files.
- **Error** (git failure, corrupt repo): an inline error card with the stderr excerpt, a "Retry" button, and "Open terminal here".
- **Refreshing:** the old graph stays visible while the new layout builds, then swaps atomically (§6.10). A 2px progress bar shows under the header.
- **History truncated:** the footer reads "Showing 2,000 of ~48,213 commits · Load more · Load all". On reaching the bottom, the next chunk loads automatically if the preference is enabled.

---

## 5. Data model & IPC

### 5.1 Shared types (`src/shared/graph.ts`)

```ts
export type Sha = string;                       // 40 hex (SHA-1) or 64 hex (SHA-256 repos)

// Commit rows use spec 02's CommitSummary (sha, parents, authorName/Email/Time,
// committerName/Email, commitTime, subject). The body is fetched lazily (spec 07).
export type RawCommit = CommitSummary;          // alias kept for readability in this spec

export type RefKind = 'head' | 'local' | 'remote' | 'tag' | 'stash';

// GraphRef is a renderer view derived from spec 02 RefInfo (git:refs):
// kind = isHead ? 'head' : RefInfo.type; isCheckedOut = RefInfo.isHead; upstream/ahead/behind from RefInfo.upstream;
// isAnnotatedTag = !!RefInfo.tagObjectSha. Refs of type 'other' (including refs/githappens/*) are never shown.
export interface GraphRef {
  fullName: string;                             // refs/heads/main, refs/remotes/origin/main, refs/tags/v1
  shortName: string;                            // main, origin/main, v1
  kind: RefKind;
  sha: Sha;                                     // peeled target (tags peeled to commit)
  remote?: string;                              // for remote branches
  upstream?: string;                            // for local branches: refs/remotes/origin/main
  ahead?: number; behind?: number;              // vs upstream
  isCheckedOut?: boolean;
  isAnnotatedTag?: boolean;
  worktreePath?: string;                        // checked out in another worktree
  pullRequest?: { provider: ProviderId; number: number; url: string; state: 'open'|'draft' };
}

// StashEntry: spec 02 §5.1 (index, ref, sha, parents, message, time). The base commit is parents[0].

export interface RepoHeadState {
  headSha: Sha | null;                          // null in empty repo
  headRef: string | null;                       // null when detached
  isDetached: boolean;
  wip: { staged: number; unstaged: number; untracked: number; conflicted: number } | null;
  inProgress: null | { kind: 'merge'|'rebase'|'cherry-pick'|'revert'|'stash-apply'; otherSha?: Sha };
}

export interface GraphQuery {
  repoId: string;
  limit: number | 'all';                        // commits to load initially
  chunkSize: number;                            // default 5000
  order: 'date' | 'topo';                       // default 'date'
  includeRemotes: boolean;                      // default true
  includeTags: boolean;
  hiddenRefs: string[];                         // full ref names
  soloRefs: string[];                           // if non-empty: only these
  authorFilter?: string[];                      // emails/names (re-query semantics)
  firstParentOnly?: boolean;                    // later
}
```

### 5.2 Layout output (`packages/graph/src/types.ts`)

All arrays are typed so they can be transferred zero-copy from the layout worker. Row `i` is in display order and row 0 is WIP when present.

```ts
export const enum NodeKind { Commit = 0, Merge = 1, Wip = 2, Stash = 3, Conflict = 4 }
export const enum EdgeKind { Pass = 0, MergeOut = 1, BranchIn = 2, Dashed = 8 /* flag */ }

export interface LayoutChunk {
  startRow: number;
  rowCount: number;
  // per row
  column: Uint16Array;          // node lane
  color: Uint8Array;            // palette index (normally column % P)
  nodeKind: Uint8Array;
  // edges for the gap BELOW each row (between row r and r+1); CSR layout
  edgeStart: Uint32Array;       // length rowCount+1; offsets into edge arrays (relative to chunk)
  edgeFrom: Uint16Array;        // column at row r
  edgeTo: Uint16Array;          // column at row r+1
  edgeKind: Uint8Array;
  edgeColor: Uint8Array;
  // parent links for highlighting / navigation (row indices; -1 = not loaded)
  parentStart: Uint32Array;     // CSR
  parentRow: Int32Array;
  maxColumn: number;            // widest lane in this chunk
}

export interface GraphModel {          // renderer-side aggregate (not React state)
  version: number;                     // bumps on any change
  rowCount: number;
  shas: Sha[];                         // row → sha
  rowOf: Map<Sha, number>;
  commits: RawCommit[];                // row → commit (WIP/stash rows synthesized)
  chunks: LayoutChunk[];               // contiguous
  refsByRow: Map<number, GraphRef[]>;
  maxColumn: number;
  complete: boolean;                   // no more history
  totalEstimate?: number;              // from rev-list --count (async)
}
```

### 5.3 Renderer state (`useGraphStore`)

```ts
interface GraphUiState {
  columns: ColumnLayout;                 // { order: ColumnId[]; widths: Record<ColumnId, number>; visible: Record<ColumnId, boolean> }
  compact: boolean;
  selection: { anchor: Sha | 'WIP' | null; keys: Set<Sha | 'WIP'>; focus: Sha | 'WIP' | null };
  hover: { row: number | null; ref: string | null };
  highlight: { refFullName: string; rows: Uint8Array } | null;
  search: { query: string; mode: SearchMode; matches: Sha[]; current: number; filterMode: boolean; running: boolean };
  visibility: { hidden: Set<string>; solo: Set<string>; pinned: string[]; smart: boolean };
  dimMerges: boolean;
  scroll: { top: number; anchorSha?: Sha; anchorOffset?: number };
}
```

### 5.4 IPC channels (contract in `src/shared/ipc/graph.ts`)

| Channel | Dir | Payload → Result | Notes |
|---|---|---|---|
| `graph:open` | invoke | `GraphQuery` → `{ sessionId, head: RepoHeadState, refs: GraphRef[], stashes: StashEntry[] }` | Starts the log stream |
| `graph:chunk` | event | `{ sessionId, seq, commits: RawCommitBatch, done: boolean }` | `RawCommitBatch` is columnar (see below) |
| `graph:loadMore` | invoke | `{ sessionId, count: number \| 'all' }` → `void` | Resumes the paused stream |
| `graph:cancel` | invoke | `{ sessionId }` → `void` | Kills the git process |
| `graph:refsChanged` | event | `{ repoId, refs, stashes, head, reason }` | From RepoWatcher (spec 02) |
| `graph:countCommits` | invoke | `{ repoId, query }` → `number` | `rev-list --count`, async/low priority |
| `graph:search` | invoke | `{ repoId, query: GraphSearchQuery }` → `{ searchId }` | |
| `graph:searchResults` | event | `{ searchId, shas: Sha[], done }` | Streamed |
| `graph:revealCommit` | invoke | `{ sessionId, sha, maxLoad? }` → `{ row } \| { needsConfirm } \| { notInGraph }` | Loads history until `sha` is laid out (§11) |
| `graph:containingBranches` | invoke | `{ repoId, sha }` → `string[]` | `branch -a --contains`, used for ghost fallback & tooltips |
| `graph:commitBody` | invoke | `{ repoId, sha }` → `{ body, trailers, signature? }` | Lazy |
| `avatar:get` | invoke | `{ email, provider?, size }` → `{ url: string }` | Alias of spec 10 `avatar:resolve`. Returns a `githappens-avatar://<hash>?s=` URL |
| `graph:saveLayout` / `graph:loadLayout` | invoke | `ColumnLayout` per repo | Persistence |

**Mapping to the spec 02 contract.** The `graph:*` channels are a graph-session facade registered in `src/shared/ipc/graph.ts`. In main they are implemented on top of `GitService.log()` (the `git:log:start` / `git:log:next` / `git:log:dispose` cursor), `git:refs`, `git:stash:list` and `git:revParse`. They never parse git output themselves. `graph:refsChanged` is emitted when spec 02's `git:repo:changed` carries the `refs`, `graph` or `stash` scope. Avatars use spec 10's `avatar:resolve` (`githappens-avatar://` protocol). `avatar:get` above is an alias of that channel, not a second service.

`RawCommitBatch` is a columnar, transfer-friendly batch: `{ count, shaBuf: Uint8Array /* count×20|32 raw bytes */, parentCount: Uint8Array, parentIdx: … }`. To keep v1 simple, we may send `RawCommit[]` with string fields. 5,000 commits come to about 1 MB of structured clone, which is acceptable. **Decision:** v1 sends `RawCommit[]` in chunks of 5,000, and the columnar format is an optimization tracked in §10.

### 5.5 Layout worker messages (`packages/graph/src/worker.ts`)

```ts
type ToWorker =
  | { t: 'reset'; sessionId: string; opts: LayoutOptions; head: RepoHeadState; stashes: StashEntry[]; pinnedTips: Sha[] }
  | { t: 'append'; commits: RawCommit[]; done: boolean }
  | { t: 'reach'; tipRow: number; requestId: number }            // ancestry bitset
  | { t: 'ghost'; row: number; requestId: number };
type FromWorker =
  | { t: 'chunk'; chunk: LayoutChunk }                           // transferable buffers
  | { t: 'reach'; requestId: number; rows: Uint8Array }
  | { t: 'ghost'; requestId: number; tipRow: number | -1 };

interface LayoutOptions {
  edgeStyle: 'rounded' | 'bezier';
  colorMode: 'column' | 'branch';
  laneReuseCooldown: number;      // rows a freed lane stays unusable (default 1)
  mergeLanePlacement: 'right-first' | 'leftmost';
}
```

---

## 6. Git implementation

### 6.1 Loading refs

```bash
git for-each-ref --format='%(refname)%00%(objectname)%00%(*objectname)%00%(objecttype)%00%(upstream)%00%(upstream:track,nobracket)%00%(HEAD)%00%(worktreepath)' \
  refs/heads refs/remotes refs/tags
git rev-parse --verify -q HEAD          # head sha (fails in empty repo)
git symbolic-ref -q HEAD                # refs/heads/x or exit 1 when detached
git stash list --format='%gd%x00%H%x00%P%x00%ct%x00%gs'   # parents: first = base
```

- For tags, use `%(*objectname)` (the peeled commit) when it is non-empty, otherwise `%(objectname)`. Skip tags that peel to non-commits (tree/blob tags) and show them only in the left panel.
- Exclude `refs/remotes/*/HEAD` symbolic refs, `refs/prefetch/*`, `refs/notes/*` and the reserved `refs/githappens/*` namespace (00 §4). Log rev-sets use spec 02 `buildRevSet`, which adds `--exclude=refs/githappens/*`.
- For `upstream:track`, parse `ahead N, behind M` / `gone`.
- `%(worktreepath)` (git ≥ 2.23) marks branches checked out in other worktrees.

### 6.2 Streaming the log

```bash
git -c core.quotepath=off -c log.showSignature=false log \
  --date-order --no-color -z \
  --format='%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ce%x1f%ct%x1f%s' \
  <visible tips…> HEAD [--not <hidden-only tips…>] [--author=…]
```

- Use `-z` with the `\x1f` unit separator. Records are NUL-terminated, and subjects can't contain NUL. Strip a trailing `\n`.
- **Tips:** with no solo/hide active, use `--branches --remotes --tags HEAD` (plus `--exclude=refs/prefetch/*` before `--branches`). Otherwise pass the visible tip SHAs explicitly. With many tips (more than 1,000), write them to `--stdin` to avoid command-line length limits (Windows: 32k).
- **Hidden refs:** a commit reachable only from hidden refs must disappear. A commit reachable from both hidden and visible refs stays. Passing only the visible tips does this, so no `--not` is needed.
- **Order:** `--date-order` guarantees that no parent precedes its children and streams immediately. With a commit-graph file it is fast, and the first records arrive in ~20 ms. `--topo-order` (a preference) groups branches better but on old git must walk everything before printing. With generation numbers (commit-graph, git ≥ 2.20) it is incremental too.
- **Performance:** on open, GitService checks for `.git/objects/info/commit-graph` (or a `commit-graphs` chain). If it is missing and the repo has more than 10k commits, spec 02 §6.15.1 runs `git commit-graph write --reachable --changed-paths` once in the background (low priority, never two at once). This respects the user setting `graph.maintainCommitGraph` (spec 13, default on).
- **Chunking and backpressure:** the main process parses stdout incrementally (split on `\0`) and emits a `graph:chunk` every 5,000 records, or every 50 ms for the first chunk. After `limit` commits, the main process **pauses** the stream with `child.stdout.pause()` and keeps the process alive so that `loadMore` resumes it without restarting. The process is killed after 5 minutes idle or on session cancel. On resume after a kill, it restarts with `--skip=<loaded>`. Correctness holds because the order is deterministic for an unchanged ref set.
- **Encoding:** read stdout as a Buffer and decode UTF-8 per record. If `i18n.logOutputEncoding` is set, git already re-encodes. Use `--encoding=UTF-8`.

### 6.3 Lane assignment algorithm (`packages/graph/src/layout.ts`)

This is a single pass, top to bottom, that is incremental and deterministic. It works directly on the streamed row order, so it can lay out row *k* as soon as rows 0..k are known. That makes the first paint immediate and the cost per new chunk O(chunk × active lanes). The "active lanes" model is the one used by `git log --graph` and most GUI clients. On top of it we add refinements: lanes never shift sideways (straight branches), first-parent continuity, pinned/HEAD lanes, and lane-reuse rules.

#### 6.3.1 Concepts
- **Lane slot:** an entry in the array `lanes[]`. A slot is either `null` (free) or `{ expect: Sha, fp: boolean, color: number, pinRank: number }`. `expect` is the commit this line is waiting to reach as we move down. `fp` is true if the edge that created this expectation is a first-parent edge.
- **Gap r:** the vertical space between row r and r+1. Edges are stored per gap.
- Rows are processed in order. When row r is processed we emit the edges of gap r−1 (lines arriving at r) and set up the expectations that will produce gap r.

#### 6.3.2 State
```ts
interface LaneState {
  lanes: (Slot | null)[];
  waiting: Map<Sha, number[]>;      // expect sha → lane indices (kept in sync with lanes)
  freedAt: Int32Array | number[];    // lane → row index at which it was freed (cooldown)
  reserved: Map<Sha, number>;        // pinned tips not yet seen → reserved lane
  pendingMergeOut: {from: number; to: number; color: number}[]; // edges for the current gap
  rowsDone: number;
}
```

#### 6.3.3 Pseudocode

```
function init(pinnedTips: Sha[]):          // pinnedTips[0] = HEAD sha (if not detached-hidden), then user-pinned branches
  lanes = []
  for (i, sha) in enumerate(dedupe(pinnedTips)):
      reserved[sha] = i ; lanes[i] = RESERVED   // placeholder: occupied but draws nothing
  // WIP row (if present) is fed as a synthetic commit {sha:'WIP', parents:[headSha] (+MERGE_HEAD)} first,
  // so it naturally lands in HEAD's reserved lane 0.

function processRow(r, c: Commit):
  edgesAbove = []                            // gap r-1 → r
  W = waiting.get(c.sha) ?? []               // lanes whose line ends at c

  // 1) choose c's column
  if W nonempty:
      col = pickContinuation(W)
  else if reserved.has(c.sha):
      col = reserved[c.sha]; reserved.delete(c.sha)
  else:
      col = allocate(r, preferNear = null)   // a branch tip (no loaded children)

  // 2) edges arriving at row r
  for i in 0..lanes.length-1:
      s = lanes[i]
      if s == null or s == RESERVED: continue
      if s.expect == c.sha:
          if i == col: edgesAbove.push(Pass(i, i, s.color))
          else:        edgesAbove.push(BranchIn(i, col, s.color))   // line from lane i bends into node
      else:
          edgesAbove.push(Pass(i, i, s.color))                      // passes by untouched
  emitGap(r-1, edgesAbove ∪ pendingMergeOut)   // merge-outs created at row r-1 also live in gap r-1
  // dedupe: if a MergeOut(c→k) in this gap targets a lane k that was *created* by that merge,
  // drop the Pass(k→k) for this gap; the MergeOut path already includes the vertical descent.
  pendingMergeOut = []

  // 3) free lanes that terminated at c (all of W except col)
  for i in W where i != col: lanes[i] = null; freedAt[i] = r
  waiting.delete(c.sha)

  // 4) first parent continues in col
  color = colorFor(col)
  if c.parents.length == 0:
      lanes[col] = null; freedAt[col] = r             // root: line ends
  else:
      p0 = c.parents[0]
      if waiting.has(p0) and options.joinExistingFirstParent:
          // another lane already expects p0 (two branches that will meet). Keep c's own lane anyway
          // so the branch stays straight; the two lanes merge later at p0 (BranchIn there).
      setExpect(col, p0, fp=true, color)

  // 5) additional parents (merge)
  for p in c.parents[1..]:
      if waiting.has(p):
          j = leftmost(waiting[p])                   // reuse an existing line heading to p
          pendingMergeOut.push(MergeOut(col, j, lanes[j].color))
      else:
          k = allocate(r, preferNear = col)
          setExpect(k, p, fp=false, colorFor(k))
          pendingMergeOut.push(MergeOut(col, k, colorFor(k)))

  // 6) trim trailing nulls so width shrinks when branches end
  while lanes.length > 0 and last(lanes) == null: lanes.pop()

  record row r: column=col, color=color, nodeKind = c.parents.length>1 ? Merge : Commit (or synthetic kind)
  record parents rows later (resolved when parents arrive; see 6.3.7)

function pickContinuation(W):
  // first-parent continuity: a lane that reached c via a first-parent edge means c is "the same branch"
  // as that child. Prefer it so the branch's line is straight through c.
  F = [i in W where lanes[i].fp]
  candidates = F nonempty ? F : W
  // pinned/HEAD lanes win, then leftmost (keeps main lines on the left)
  return argmin over candidates of (lanes[i].pinRank, i)

function allocate(r, preferNear):
  isFree(i) = (i >= lanes.length) or (lanes[i] == null and r - freedAt[i] > cooldown)
  if preferNear != null and mergeLanePlacement == 'right-first':
      for i in preferNear+1 .. lanes.length:        // first free to the right of the merge node
          if isFree(i): return claim(i)
  for i in 0 .. lanes.length:                       // else first free anywhere (lanes.length = append)
      if isFree(i) and not reservedLane(i): return claim(i)

function setExpect(i, sha, fp, color):
  lanes[i] = { expect: sha, fp, color, pinRank: inheritedPinRank }
  waiting[sha].push(i)
```

#### 6.3.4 Properties
- **Straight branches.** Once a lane is assigned, it never moves horizontally. Freeing a lane leaves a hole (`null`) instead of shifting lanes to its right, so every first-parent chain is a straight vertical line from its tip to the point where it joins another lane.
- **First-parent continuity.** At a fork point (commit `c` with several children whose first parent is `c`), the line that continues through `c` is the leftmost or pinned first-parent line. The other children's lines bend into `c` (BranchIn). Lines that reached `c` only as a merge's second parent never take the column when a first-parent line exists. As a result, `main` stays straight and merged feature branches hang off it to the right.
- **No overlaps.** Each slot holds at most one expectation, and a node is placed only in a slot that expects it or a free slot. Vertical segments therefore never share a lane cell. Property tests (spec 15) assert: (a) every gap's Pass edges have distinct columns; (b) every parent link is represented by an edge path; (c) node columns equal the column of an arriving Pass or the target of all BranchIns.
- **Cooldown.** A lane freed at row r can't be reused until row r + 1 + cooldown. Without the cooldown, a line could end and a new unrelated line could start in the same column on the next row, which reads as a continuation (the confusion pvigier calls out).
- **Pinned lanes.** HEAD's tip (and user-pinned branches, v11.10) reserve lanes 0..k before any rows are processed. Rows newer than HEAD from other branches therefore can't steal lane 0, and HEAD's first-parent history is a straight line at the far left. `pinRank` propagates down first-parent edges so the pinned line keeps winning `pickContinuation`.
- **Complexity:** O(R × L) for R rows and average active lanes L, with an O(1) `waiting` lookup. On linux.git (~1.3M commits, L ≈ 20–40) this runs in about 1–2 s in a worker. On 100k rows it takes about 60 ms.
- **Determinism:** the output depends only on the row order and the pinned tips. This is what makes incremental append and the convergence reuse in §6.10 possible.

#### 6.3.5 Merge edge rules and joins
- **MergeOut to an existing line:** if the second parent `p` is already expected by lane `j` (for example, two merges of the same commit), the merge edge joins lane `j` instead of opening a new lane. This keeps the graph narrow.
- **Octopus merges** (more than 2 parents): each extra parent gets its own MergeOut, in parent order. With right-first placement they fan out to the right.
- **Criss-cross merges** need no special case. Each parent edge is independent.
- **Two lanes expecting the same commit:** this happens when, for example, `feature` was branched from a commit on `main` and both are visible. Both lines continue down until the commit row, where one Passes and the others BranchIn. Lines are never merged early.

#### 6.3.6 Color modes
- `column` (default): `color = column % P`. This is cheap and stable, and every lane in a column has the same color.
- `branch`: a color is assigned when a lane is *created* (tip or merge parent). It uses the least-recently-freed palette index, reusing a color only after the previous line using it has ended (as `availableColours` does in vscode-git-graph). The lane's color is stored in the slot and inherited by first-parent continuation. A BranchIn edge keeps the color of the incoming lane.

#### 6.3.7 Parent row resolution
Parents appear below their children, so a child's parent row index is unknown when the child is laid out. While processing parent `p` at row r, each child that listed `p` gets its parent slot filled with r. We keep `pendingParentRefs: Map<Sha, Array<{childRow, parentIdx}>>`. When the stream finishes, or for parents never loaded (limit or hidden), the entries stay `-1` and their edges fade out at the bottom of the loaded region (§4.6).

#### 6.3.8 Synthetic rows
- **WIP:** inserted before row 0 as `{ sha: 'WIP', parents: [headSha, mergeHead?] }`, with NodeKind.Wip and dashed edges. If HEAD is unborn (empty repo), there are no parents.
- **Conflict entry:** same as WIP, with NodeKind.Conflict and parents `[HEAD, MERGE_HEAD/REBASE_HEAD/CHERRY_PICK_HEAD]`. A second parent that isn't loaded simply fades.
- **Stashes:** see §6.4.

#### 6.3.9 Worked example
The history: `main` (HEAD) = E → D(merge of C and B) → C. `feat` = F → C. `topic` (deleted, merged by D) = B → C. The working tree is dirty.
```
row  commit         parents  col  lanes after row        edges drawn in gap ABOVE this row
0    WIP            [E]      0    [E]                    —                        (lane 0 reserved for HEAD tip E)
1    E  main,HEAD   [D]      0    [D]                    Pass(0→0, dashed)
2    F  feat        [C]      1    [D, C]                 Pass(0→0)                 (F is a tip → allocate → lane 1)
3    D  merge       [C, B]   0    [C, C, B]              Pass(0), Pass(1)          (B: right-first → lane 2; MergeOut(0→2) in gap 3)
4    B              [C]      2    [C, C, C]              Pass(0), Pass(1), MergeOut(0→2) + vertical into 2
5    C              [...]    0    [C's parent]           Pass(0), BranchIn(1→0), BranchIn(2→0)
```
At row 5, `waiting[C] = [0, 1, 2]` and all three are first-parent lanes. Lane 0 carries `pinRank` 0 (HEAD), so it continues, and lanes 1 and 2 bend into C. The result is `main` straight in lane 0, `feat` straight in lane 1, and the merged topic straight in lane 2. Both side lanes end at their fork point, and the trailing-null trim then shrinks the width back to 1.

### 6.4 Stash placement
- A stash commit `S` has parents `[base, indexCommit, untrackedCommit?]`. Only `S → base` is drawn, as a dashed edge. The index and untracked helper commits never become rows.
- **Insert position:** walk the date-ordered stream and emit `S` immediately before the first row whose committer time is older than `S.time`, but never after `base`. If `base` is reached first, emit `S` immediately before `base`. Implement this in the main-process parser by holding stash entries in a min-heap keyed by time and flushing them as the log stream passes.
- If `base` isn't reachable from visible refs (for example, the stash came from a hidden branch), the stash row is still shown and its edge fades. Hidden stashes are omitted entirely.

### 6.5 Avatars
- **Source priority:** (1) the provider avatar when the repo's remote maps to a connected provider and the provider API maps the email or commit to a user (GitHub `GET /repos/{o}/{r}/commits/{sha}` → `author.avatar_url`, batched and cached per email; spec 10). (2) Gravatar: `https://www.gravatar.com/avatar/<sha256(lowercase(trim(email)))>?s=<2×size>&d=404`. Gravatar accepts SHA-256 hashes today, and MD5 is a fallback. (3) GitHub noreply emails (`12345+user@users.noreply.github.com`) → `https://avatars.githubusercontent.com/u/12345?s=…`. (4) Initials fallback.
- **Initials:** the first letters of the first and last name words (or the first two characters of the email local part), uppercase, on a background colored by `hash(email) % palette`.
- **Fetching** happens in the main process (`AvatarService`) with a disk cache in `userData/avatars/<hash>-<size>.png`, a 7-day TTL, negative caching of 404s for 1 day, and at most 6 concurrent requests. It is served to the renderer through the custom privileged protocol `githappens-avatar://<hash>?s=32` (owned by spec 10's AvatarService), which avoids leaking requests from the renderer and satisfies CSP.
- **Renderer:** an `AvatarCache` holds an LRU of 512 `ImageBitmap`s, decoded once and drawn with `ctx.drawImage` clipped to a circle. Until a bitmap is ready, the initials are drawn and the row is redrawn when it loads.
- **Privacy:** the preferences `ui.authorDisplay: 'avatar' | 'initials'` and `ui.useGravatar` (spec 13), plus an offline mode that disables network fetches.

### 6.6 Ancestry highlighting (reachability)
- **Input:** the ref tip row t. **Output:** `Uint8Array(rowCount)` with reachable rows = 1.
- **Algorithm:** BFS/DFS over `parentRow` CSR arrays starting at t, using an explicit stack. All parent rows are greater than the child row, so a single forward sweep also works: `mark[t]=1; for r = t..n-1: if mark[r]: for p in parents(r): if p>=0: mark[p]=1`. This is O(n) with sequential memory access, about 1 ms per 100k rows.
- It runs in the layout worker (the `reach` message), and the result is cached by `(tipSha, model.version)` in an LRU of 32. Hover requests are debounced by 60 ms.
- Edge dimming: an edge in gap r is highlighted only if both of its endpoints are reachable. For a Pass edge in lane i, that means the line belongs to a reachable expectation, so we additionally record `edgeOwnerRow` (the row whose expectation created the line) during layout. `edgeOwnerRow` (Int32Array parallel to edges) is a required field that is omitted from the type listing above for brevity.

### 6.7 Ghost branch (nearest containing branch)
- For the hovered or selected row r with no visible ref, find the nearest ref tip row t < r such that r is reachable from t, minimizing the number of child-hops. Walk upward over a **child CSR** (built lazily in the worker from parent CSR), using BFS from r over children. The first row visited that carries a branch ref wins. Ties are broken by local branch, then HEAD branch, then alphabetical order.
- The walk is capped at 5,000 visited rows. If it hits the cap, fall back to `graph:containingBranches` (`git branch -a --contains <sha> --format=%(refname)`) and choose by the same priority.

### 6.8 Search and filter commands
1. **Client-side (loaded rows):** a case-insensitive substring or regex match against `subject`, `authorName`, `authorEmail` and the `sha` prefix. It is chunked with `requestIdleCallback` for more than 50k rows.
2. **Git-side** (`graph:search`, streamed SHAs, read-only, not queued):
   - Message: `git log <tips> --format=%H -i --grep=<q> [--all-match]`
   - Author: `git log <tips> --format=%H -i --author=<q>`
   - File path: `git log <tips> --format=%H -- <pathspec>` (`:(icase)` glob magic when the user types wildcards)
   - Content added/removed: `git log <tips> --format=%H -S<q> [--pickaxe-regex]`. Diff regex: `-G<q>`.
   - SHA: `git rev-parse --verify -q <q>^{commit}` (supports abbreviations and refs).
   The main process returns SHAs. The renderer marks those already loaded. For a match beyond the loaded range, "jump to" triggers `loadMore` until the row is loaded (capped by a confirmation for more than 50k commits: "Load 120,000 more commits to show this result?").
3. **Author filter.** The default is **dim mode**: rows whose author is not selected are dimmed client-side, the graph topology is unchanged, and `git log --author` (multiple `--author` flags are ORed) is used only to find matches beyond the loaded range. The optional **"Show only these authors"** mode re-opens the session with `--author=…`. Commit limiting by author does not rewrite parents (only pathspec simplification does), so `%P` may name commits that are not in the result. The layout treats them like unloaded parents: the edges fade after 1 row, and rows render as disconnected nodes in lane 0..k. *(inferred: the author filter keeps the graph shape and dims other authors.)*

### 6.9 Double-click checkout resolution
1. If a local branch points at the commit: `git checkout <branch>` (spec 05 checkout op, with WIP handling and an autostash prompt).
2. Else, if remote branches point at it: if a local branch tracking that remote branch exists and is behind/at that commit, offer "Checkout `Y` and fast-forward". Else create a tracking branch: `git checkout -b Y --track origin/Y`. If `Y` exists with a different upstream, prompt for a name.
3. Else, if a tag points at it: detached checkout of the tag after confirmation.
4. Else: a confirmation dialog "Checkout detached HEAD at abc1234?" with the options "Checkout", "Create branch here" and "Cancel".

### 6.10 Incremental updates when refs change
Triggers come from spec 02's `git:repo:changed` event. Its `scopes` (`refs`, `graph`, `stash`, `status`, `repoState`) replace the per-kind events. The RepoWatcher watches `.git/refs`, `packed-refs`, `HEAD`, `logs/refs/stash`, `index`, `MERGE_HEAD` and similar files with the spec 02 §6.14 debounce (300 ms trailing, 1.5 s max wait).

Decision tree (in `GraphController`, renderer):
1. **WIP-only change** (index or worktree): recompute `RepoHeadState.wip`. Add or remove the WIP row by re-running layout from row 0. That is cheap with convergence (below), and usually only the top rows change.
2. **Ref decorations only:** the new and old sets of *visible tip SHAs* are equal and HEAD's sha is unchanged (examples: tag or branch created at an existing commit, branch renamed or deleted when another visible ref still points at the same commit, upstream tracking change). Update `refsByRow` and pills only. No relayout. If HEAD's ref changed but its sha did not (checkout of another branch at the same commit), recompute pinned lanes. If pin order changes, do a full relayout.
3. **Tip set changed** (commit, fetch, reset, rebase, branch delete): start a **new session** in the background while the old model stays on screen.
   - New log stream → worker `reset` → layout.
   - **Convergence reuse:** keep the old model's lane-state checkpoints every 1,024 rows: a hash of `lanes[]` (expect SHAs and colors) plus the row's sha. As new rows are laid out, when new row r' has sha equal to old row r and the lane-state hash equals old checkpoint r (checked at old checkpoints only), verify the next 64 SHAs of the incoming stream against old rows r+1..r+64. If they match, **adopt the old suffix**: copy old chunks from r onward, shift row indices by `r' − r`, remap parent rows, cancel the git stream, and mark the model with the old `complete` flag. Because layout is deterministic given identical remaining input and identical state, the suffix is identical. The 64-SHA check guards against reorderings caused by old-dated new commits. The rare false adoption is self-correcting on the next full refresh. A setting `graph.convergenceReuse` (default on) allows turning it off for debugging.
   - **Swap:** once the new model covers `[0, max(lastVisible + 200, oldLoadedCount_if_user_scrolled))`, swap atomically and bump `version`.
4. **Scroll anchoring:** before the swap, record `anchorSha` = the first fully visible row's sha and its pixel offset. After the swap, set scrollTop so that the anchor row keeps its offset. If the anchor vanished (for example, after a rebase), anchor to the nearest surviving ancestor (walk the old parents until a sha exists in the new model), or else the top. If the user is at the very top (scrollTop < rowH), stay at the top so new commits appear.
5. **Selection:** keep the selected keys whose SHAs still exist. If a selected commit was rewritten (amend/rebase), map it via `git reflog`-free heuristics: if HEAD moved and the old selection was the old HEAD, select the new HEAD.
6. **Throttle:** at most one relayout in flight. Further triggers coalesce into a single "dirty" flag that is processed after the current one finishes.

### 6.11 Canvas rendering (`packages/graph/src/render.ts`)

```ts
interface RenderInput {
  ctx: CanvasRenderingContext2D; dpr: number;
  viewport: { top: number /* virtual px */; height: number; width: number; scrollX: number };
  metrics: GraphMetrics; palette: string[]; theme: GraphTheme;
  model: GraphModel; dim: (row: number) => boolean; selected: (row: number) => boolean;
  avatars: AvatarCache; hoverRow: number | null;
}
```
Per frame:
1. `first = floor(top / rowH) - 1`, `last = ceil((top + height) / rowH) + 1`, clamped.
2. `ctx.setTransform(dpr, 0, 0, dpr, -scrollX*dpr, -(top % rowH + rowH)*dpr)` and clear. (Draw relative to row `first` so that coordinates stay small even in scaled mode. Float precision at 30M px is fine, but small numbers are safer.)
3. **Edges pass:** for `g in first..last`, the edges of gap g. Batch strokes by `(color, dashed, dimmed)` into Path2D buckets to minimize state changes, with one `stroke()` per bucket per frame. Dimmed buckets are drawn first, then normal, then highlighted.
   - `x(col) = padL + col*laneW + laneW/2`, `y(row) = row*rowH + rowH/2` (relative).
   - Pass: `moveTo(x(c), y(g)); lineTo(x(c), y(g+1))`.
   - MergeOut (c→k, rounded): `moveTo(x(c), y(g)); lineTo(x(k) ∓ R, y(g)); arcTo(x(k), y(g), x(k), y(g)+R, R); lineTo(x(k), y(g+1))`.
   - BranchIn (k→c, rounded): `moveTo(x(k), y(g)); lineTo(x(k), y(g+1)-R); arcTo(x(k), y(g+1), x(k)∓R, y(g+1), R); lineTo(x(c), y(g+1))`.
   - Bezier style: `moveTo(x1,y1); bezierCurveTo(x1, y1+0.8h, x2, y2-0.8h, x2, y2)`.
4. **Nodes pass:** for each row, draw the node shape by kind. Avatars use `save(); beginPath(); arc(); clip(); drawImage(bitmap); restore()` and then a ring stroke. To cut clip cost, pre-render circular avatar bitmaps once (an `OffscreenCanvas` mask at the needed size × dpr) and cache them as ImageBitmap.
5. **Overlay:** selection rings, the hover ring, and the overflow fade.

- **DPI:** the canvas backing size is `cssW*dpr × cssH*dpr`. Listen to `matchMedia(\`(resolution: ${dpr}dppx)\`)` change events and to `ResizeObserver`, then resize and redraw. Snap vertical lines to `round(x*dpr)/dpr + 0.5/dpr` for crisp 1px-equivalent strokes on odd widths.
- **Budget:** at most 2 ms per frame for 60 rows × 20 lanes. Redraw only on scroll, data or hover change, never continuously.
- **UnderlayCanvas:** row backgrounds (hover = `--graph-row-hover`, selected = `--graph-row-selected`, search match = `--graph-row-match`, current search = stronger) and ref connectors from the pill's right x (reported by the RefColumnLayer through a measure map) to the node's left x. Both canvases share the same transform logic.

### 6.12 Hit testing
- `row = floor((virtualTop + clientY − viewportTop) / rowH)`. Clicks anywhere in a row select it.
- **Node hit (graph column):** `dx = localX + scrollX − x(column[row]); dy = …`. Within `nodeR + 3`, it counts as a node hit (used for the tooltip and the drag target highlight).
- **Pills:** DOM elements with their own handlers. Drag and drop uses pointer events with `setPointerCapture`, not HTML5 DnD, to get full control and avoid Electron drag-image quirks. The drop target is found with `document.elementFromPoint` → `[data-ref]` or `[data-row]`.
- **Edge hover:** not supported (not needed).

### 6.13 Keyboard model
- `j/k/↓/↑` move focus ±1 row and select it. `Shift+j/k` moves to the first-parent child or parent (parent: `parentRow[first]`; child: the nearest row above whose first parent is this row, via child CSR).
- `Home/End` (Ctrl) go to the first or last loaded row. `PageUp/PageDown` move by viewport rows.
- `Enter` opens or focuses the detail panel. `Space` toggles the selection of the focused row. `Ctrl+C` copies the selected SHA(s). `Ctrl+Shift+C` copies the subject.
- Auto-scroll keeps the focused row inside the viewport with a 3-row margin.
- `ContextMenu` key / Shift+F10 opens the commit menu for the focus row.

### 6.14 Accessibility
- The viewport has `role="grid"` and `aria-rowcount` = total rows. Each virtual row has `role="row"`, `aria-rowindex` and `aria-selected`. The node is described in the message cell's `aria-label` ("Merge commit by Ann, 3 hours ago, branches main, origin/main").
- Lane colors are not the only signal. HEAD has a ring and a check icon, and remotes have icons. The palette is validated for contrast in both themes (spec 13).

---

## 7. Step-by-step implementation plan

Each step ends with tests that pass on their own.

1. **Shared types and IPC contract.** Add `src/shared/graph.ts` and `src/shared/ipc/graph.ts` (types from §5). Test: type-only compile.
2. **Ref parser.** Implement `parseForEachRef`, `parseStashList`, and HEAD detection in `packages/git`. Test: fixture outputs including peeled tags, `[gone]` upstream, worktree refs, `refs/remotes/origin/HEAD` exclusion, unicode names.
3. **Log stream parser.** Implement `LogStreamParser` (Buffer → RawCommit with `\0`/`\x1f` splitting, a partial-record carry-over across chunks, and SHA-256 support). Test: records split at random byte boundaries, including multi-byte UTF-8 split across chunks.
4. **GraphSession in main.** Spawn git log, chunking, pause/resume (`loadMore`), cancel, idle kill, `--skip` restart, `--stdin` tips, and the stash interleave heap (§6.4). Test: real git against `branchy` and `huge` fixtures. The first chunk must arrive in under 150 ms on `huge` with commit-graph.
5. **Commit-graph maintenance.** Detect the commit-graph file and write it in the background with a lock guard. Test: runs once, and a second open does not rerun it.
6. **Lane layout core** (`packages/graph/layout.ts`). Implement §6.3 with incremental `append`. Test: golden snapshots on hand-made topologies (linear, fork, merge, octopus, criss-cross, multiple roots, pinned HEAD, WIP, stash). Property tests with fast-check on random DAGs check the no-overlap, connectivity and determinism invariants, and that chunked feeding equals one-shot feeding.
7. **Parent/child CSR, reach, ghost.** Test: reach bitsets against a brute-force reachability check, and ghost nearest-ref selection.
8. **Layout worker** with transferable chunks. Test: worker round-trip in Vitest (`@vitest/web-worker`).
9. **Renderer core** (`render.ts`). Implement metrics, edge path builders and node drawing with an injected ctx. Test: draw against a recording mock context and snapshot the command list. Visual regression via Playwright screenshots on 3 fixtures in both light and dark themes.
10. **GraphViewport virtualization.** Implement the scroll container, pooled DOM rows, canvas sizing, DPR handling and scaled scroll mode. Test: Playwright scroll through 200k rows with no blank frames (measure via `performance` marks) and the scroll position mapping in scaled mode.
11. **Text columns + header.** Implement column layout, resize, reorder, show/hide and per-repo persistence. Test: component tests plus persistence round-trip.
12. **Ref pills.** Implement grouping (combined local+remote), sort, truncation, +N popover, connectors and ghost pills. Test: grouping unit tests and pill snapshots.
13. **Avatars.** Use spec 10's AvatarService and `githappens-avatar://` protocol; implement renderer bitmap LRU, initials fallback and the privacy setting. Test: mock HTTP 200/404, cache TTL, and the noreply email mapping.
14. **Selection and keyboard.** Implement single, ctrl and shift selection, focus navigation, first-parent navigation and copy. Test: selection reducer unit tests, plus e2e for range selection driving the detail panel (spec 07 stub).
15. **Hover highlight.** Wire the reach requests, dimming in canvas and DOM, and the preference toggle. Test: e2e hovering `feature` dims main-only commits.
16. **Context menus.** Implement the MenuModel builders for commit, multi, local, remote, tag, stash, WIP and header menus, with enablement rules and op dispatch to spec 05 commands. Test: a unit table of (state → enabled items).
17. **Double-click checkout** (§6.9). Test: e2e on a remote-only branch creates a tracking branch.
18. **Drag and drop of refs.** Implement pointer-capture DnD, target detection and the `onRefDrop` event to spec 05. Test: e2e dragging `feature` to `main` shows the action menu.
19. **Hide/solo/pin/smart visibility.** Implement the visible-tip computation, re-query, the left-panel integration and persistence per repo. Test: hiding a branch removes its exclusive commits but keeps shared commits.
20. **Lazy load + footer.** Add the limit preference, auto-load on scroll to within 200 rows of the end, "Load all" and the count estimate. Test: scrolling loads more, and the end-of-history state appears.
21. **Search/filter.** Implement client-side match, git-side search, result navigation, filter mode, the author filter and jump-to-match loading. Test: each mode on a fixture with known answers.
22. **Jump to HEAD**, plus centering and loading HEAD if it is not loaded. Test: e2e after scrolling far.
23. **Incremental updates** (§6.10). Implement the decision tree, convergence reuse, the atomic swap, scroll anchoring and selection carry-over. Test: commit, fetch, tag-create and rebase scenarios, asserting minimal work (no relayout for tag create; convergence adopted on new commit in 100k repo; relayout under 200 ms).
24. **Compact mode + edge style preference.** Test: visual snapshots.
25. **WIP / conflict / stash rows.** Integrate with spec 06/08 state. Test: dirtying a file shows WIP, a conflicted merge shows the conflict row, and a stash shows a stash row above its base.
26. **Performance hardening.** Add the `huge` fixture (200k) and a 1M synthetic benchmark. Budgets: first paint under 2 s for 1M, scroll frame under 4 ms (p95), memory under 400 MB renderer.

---

## 8. Edge cases

- **Empty repo (unborn HEAD):** no log is run (`rev-parse HEAD` fails). Show the empty state plus a WIP row if there are files. Ref pills are absent.
- **Detached HEAD:** HEAD pin uses `headSha`. The pill reads "HEAD" with a detached icon. Lane 0 is reserved for it.
- **HEAD hidden by solo** (user solos another branch): HEAD is still always shown *(inferred: the checked-out branch is always kept visible)*.
- **Orphan branches / multiple roots:** each root ends its lane (`parents=[]`). Unrelated histories appear as separate lane systems.
- **Grafts / replace refs / shallow clones:** shallow boundary commits have parents that don't exist. `git log` reports no parents for grafted shallow commits (as `--parents` sees them), and we mark rows listed in `.git/shallow` with a "shallow boundary" fade and a tooltip.
- **Commits with identical timestamps / clock skew:** `--date-order` still guarantees topological order. Our layout requires only that guarantee.
- **Very wide graphs** (thousands of active lanes in repos with many unmerged remote branches): lanes are clipped with horizontal scroll of the graph column. Layout memory per gap is bounded by active lanes, so consider "Smart Branch Visibility" or hiding remotes, and show a suggestion banner when maxColumn exceeds 50.
- **Thousands of refs** (10k tags): pill grouping is by row map, and tips go through `--stdin`. Watcher `packed-refs` changes trigger a full ref reload, which takes about 50 ms for 10k refs via for-each-ref.
- **Ambiguous names** (branch and tag both named `v1`): always use full ref names internally and display the kind icon (v11.6 fix).
- **Unicode / RTL in messages and names:** render with `unicode-bidi: plaintext` in cells. Truncation uses grapheme-safe ellipsis (`Intl.Segmenter`).
- **Extremely long subjects:** CSS ellipsis. The full text is in the tooltip.
- **SHA-256 repositories:** SHA length 64, and abbreviation uses `core.abbrev` or 7.
- **Bare repositories:** no WIP row, no checkout actions (disabled with the reason "bare repository").
- **Worktrees:** a branch checked out in another worktree shows a worktree icon. Checkout is disabled with the reason shown, and there is an "Open worktree" action instead.
- **Submodule repos:** the graph is per repo. Submodule commits are not shown.
- **Mid-rebase:** HEAD is detached at the rebase progress point. Show the conflict/rebase row. ORIG_HEAD/onto are not pinned.
- **Refs changing during streaming:** cancel and restart the session if a refsChanged event arrives before the stream completes (coalesced).
- **git missing or erroring:** error state with stderr. Partial streams keep what was loaded and show "History incomplete — Retry".
- **Windows command-line limit:** tips go via `--stdin` above 1,000 refs or 24k characters.
- **Hidden ref is HEAD's upstream:** hiding a remote branch must not hide commits that are reachable from visible local branches.
- **Stash whose base is not loaded (limit):** the stash row is placed at its time position and its edge fades.
- **High-DPI changes** when moving a window between monitors: handled via the matchMedia listener.
- **Graph column narrower than one lane:** nodes are still drawn at lane 0 and clipped. The minimum width is 24px.
- **Scaled scroll mode** (more than ~540k rows at 28px): verify that keyboard navigation and jump-to-row compute virtualTop correctly.

---

## 9. Acceptance criteria

- [ ] Opening the `huge` fixture (200k commits, commit-graph present) paints the first rows in under 500 ms and finishes layout of all loaded rows (limit=all) in under 3 s. A 1M-commit repo paints first rows in under 2 s.
- [ ] Scrolling at maximum fling speed through 200k rows shows no blank rows and p95 frame time under 8 ms (Playwright trace).
- [ ] Main/HEAD's first-parent history is a single straight line in lane 0. No lane ever shifts horizontally between consecutive rows (property test).
- [ ] Property tests pass on 10,000 random DAGs: no overlapping vertical segments, all loaded parent links drawn, and chunked layout equals one-shot layout.
- [ ] The WIP row appears within 500 ms of saving a file and disappears after a commit.
- [ ] Local+upstream at the same commit render as one combined pill with both icons. "+N" shows when more refs exist, and the popover lists all of them.
- [ ] Each ref kind shows its icon, the checked-out branch shows a check, and remote-only branches show only the remote icon.
- [ ] Avatars load from Gravatar or the provider and fall back to initials. Setting avatars to "initials" makes zero network requests.
- [ ] Merge commits render as small dots. Octopus merges render one edge per parent.
- [ ] Hovering a branch dims all commits not reachable from it within 100 ms on 100k rows.
- [ ] Shift- and ctrl-click selection works. Two commits show a comparison, a contiguous range shows a combined diff, and a non-contiguous selection of 3 or more shows the explanation.
- [ ] Every context-menu item in §4.10 exists, is enabled or disabled per its rules, and dispatches the correct op.
- [ ] Double-click on a commit with a local branch checks out the branch. On a remote-only branch it creates a tracking branch. On a bare commit it prompts for detached checkout.
- [ ] Dragging a branch pill onto another pill emits `onRefDrop` and spec 05's menu appears.
- [ ] Hide, solo and pin work, persist per repo, and match the semantics in §2.6.
- [ ] Search by message, author, SHA, file path and content returns correct results. Matches are navigable, and off-screen matches load history after confirmation.
- [ ] Jump to HEAD scrolls to and selects HEAD even when it is outside the loaded range.
- [ ] Creating a tag does not trigger a relayout. A new commit in a 100k repo updates the graph in under 300 ms (convergence reuse), and the scroll position is preserved by anchor.
- [ ] Column order, widths and visibility persist per repo. Compact mode toggles instantly.
- [ ] Rendering is crisp at DPR 1, 1.25, 1.5 and 2, including after moving between monitors.
- [ ] Keyboard navigation matches §2.5. Screen reader announces row summaries.

---

## 10. Out of scope / later

- "Changes" column (files changed, +/− bar). This needs `git log --shortstat` or a per-commit `diff-tree --numstat` computed lazily for visible rows and cached. *Later.*
- Columnar binary transfer of commit batches (shared ArrayBuffers). This is an optimization only when profiling demands it.
- AI natural-language graph search (spec 12).
- Smart Branch Visibility auto-detection of the "target branch" via provider PR base (spec 10/11). v1 uses upstream plus default branch.
- Cloud Patches and "Share commit" (spec 14).
- A graph minimap or overview scroller. Edge hover tooltips.
- Commit signature verification badges in rows (`%G?` is expensive). Spec 06/07 shows it in the detail panel.
- Multiple-repo combined graph (workspaces, spec 11).
- `git notes` display.
- Team-view "who's working on this branch" indicators (spec 14).

---

## 11. Cross-spec dependencies

- **Ref-label hit regions for drag-and-drop (spec 05 §4.4, §7 step 12):** labels are drawn in DOM/canvas layers that spec 05 cannot inspect, so `GraphController` exposes `getRefLabelRegions(): Array<{ refFullName: string; row: number; rect: DOMRectReadOnly }>` for the rows in the viewport and `hitTestRefLabel(clientX, clientY): { refFullName: string; row: number } | null`. Regions are recomputed on scroll, resize, zoom and pill-overflow changes. "+N" overflow pills resolve to their popover items. `onRefDrop({ source, target })` (§4.11) carries full ref names. Spec 05 owns the drop-action menu built from it (`computeDropActions`).
- **Loading search hits beyond loaded history (spec 12 §4.7, §6.7):** new invoke channel `graph:revealCommit { sessionId, sha, maxLoad?: number } → { row: number } | { needsConfirm: { commitsToLoad: number } } | { notInGraph: true }`. It resumes the paused log stream (`graph:loadMore`) until `sha` is laid out, asks for confirmation above 50k commits (§6.8.2), and returns `notInGraph` when the commit is unreachable from the visible rev-set (hidden/solo refs). Spec 12's deep search calls this instead of an `injectCommits` API. Search results are highlighted only after their rows exist.
- **WIP node per linked worktree (inferred; one per worktree, spec 09 §2):** besides the current worktree's WIP row, each other non-bare linked worktree with changes gets a `NodeKind.Wip` row placed directly above that worktree's HEAD commit. The row is labeled with the worktree folder name and its changed-file count, and has a dashed edge to its HEAD and a hover action "Open worktree" (spec 09 §6.10). Data comes from spec 02 `git:status { worktreePath }` (one status per worktree, cap 20). These rows are display-only: clicking selects them, and staging happens only after opening that worktree.
- **Author filter (§4.12, §6.8.3; specs 12 and 02):** the author popover and the `@` search prefix (query syntax owned by spec 12) produce `GraphQuery.authorFilter: string[]`. In "Show only these authors" mode it is passed to spec 02 `LogQuery.author` as an array (multiple `--author`, ORed). Dim mode stays client-side.
- **Hidden `refs/githappens/*` (00 §4, specs 02 and 05):** undo keep-alive refs are excluded from the ref list (§6.1), from pills, from hide/solo lists and from every log rev-set (spec 02 `buildRevSet` adds `--exclude=refs/githappens/*`). Commits reachable only from them never appear as rows.
