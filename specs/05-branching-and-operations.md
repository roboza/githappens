# 05 — Branching & Git Operations

> Depends on: 02 (GitService, OperationQueue, IPC contract), 04 (graph selection, ref labels, drag sources). Related: 06 (WIP / commit), 08 (conflicts), 09 (push/fetch/remotes), 10 (Create PR), 12 (Git Flow UI, interactive-rebase AI helpers, terminal).

## 1. Purpose

GitHappens' core promise is that history-shaping operations (branching, merging, rebasing, cherry-picking, resetting, stashing) are **visible and direct**: you right-click or drag a ref in the graph and the result is drawn immediately. A safety net — **Undo/Redo** — makes these operations low-risk. This spec defines every ref/history mutation the app exposes, the exact git commands behind them, the drag-and-drop matrix, the interactive-rebase editor, and the undo journal that every mutating op must write to (binding rule from 00 §3).

## 2. Reference behavior

Items marked *(inferred)* are design decisions rather than documented behavior.

### 2.1 Branches
- **Create:** right-click any commit → *Create branch here*; an inline text box appears on the row, Enter commits, Esc cancels. Toolbar *Branch* button creates at HEAD (or at the WIP's HEAD). The new branch is checked out automatically when created from the toolbar *(inferred: new branches created via the toolbar are checked out; "Create branch here" from a commit does not check out)*.
- **Checkout:** double-click the branch label in graph or left panel, or context menu *Checkout*. Double-clicking a **remote-only** branch creates a local tracking branch of the same name and checks it out; if a local branch with that name exists but tracks something else, the user is prompted *(inferred: prompt offers "Reset local to remote" vs "Checkout local")*.
- **Rename:** context menu *Rename* (inline edit) or Command Palette "Rename Branch". Remote branch renames are not directly supported — the app re-pushes/deletes *(inferred)*.
- **Delete:** cannot delete the checked-out branch. Context menu *Delete <branch>*; if it has an upstream, the menu also offers *Delete <branch> and remote <origin/branch>* *(inferred from UI)*. Multi-select in left panel (Shift range, Ctrl/Cmd toggle) → *Delete N branches* with a single confirmation.
- **Set upstream:** context menu *Set Upstream* opens a picker of remote branches *(inferred)*.
- **Copy:** *Copy branch name*, *Copy commit SHA*, *Copy link to branch/commit* (remote URL, provider-aware).

### 2.2 Tags
- *Create tag here* (lightweight) and *Create annotated tag here* (message, shown in hover tooltip).
- *Push tag to <remote>*; delete *locally*, *from remote*, or both. Tags cannot be renamed (delete + recreate). Tags cannot be "checked out" as branches; user can check out detached or create a branch at a tag.
- Left panel TAGS section has a filter box; section visibility toggled via right-click on panel headers.

### 2.3 Drag and drop
Dragging a ref label (branch, remote branch, tag *(inferred)*) onto another ref label opens a context menu of operations between source and target: merge, rebase, fast-forward, interactive rebase, push, create PR, reset. Details and full matrix in §4.4.

### 2.4 Merge / rebase / cherry-pick / revert / reset
- Merge creates a merge commit when not fast-forwardable. A preference (Preferences → Commit → Merge behavior) can make merges **squash** (stage result, no merge commit). Fast-forward is offered separately as *Fast-forward X to Y*.
- Rebase via drag, via range selection ("Rebase N commits onto <branch>"), via pivot commit, and "Rebase onto this commit" for an unlabeled commit.
- Interactive rebase: actions Pick / Reword / Squash / Drop (keys P, R, S, D), Reset button to undo pending edits in the editor, drag rows to reorder *(reorder documented in older versions)*. Restrictions: no merge commits in the range; branches must share a common ancestor; cannot include the root commit; cannot rebase a parent onto its child. A rebase started in-app must be completed in-app.
- Cherry-pick single or multiple selected commits (multi-commit cherry-pick is undoable since 11.8).
- Revert creates an inverse commit (prompt whether to commit immediately *(inferred)*).
- Reset <branch> to this commit — Soft / Mixed / Hard submenu.

### 2.5 Stash
- Toolbar *Stash* stashes all changes; message comes from the WIP summary field. *Pop* pops latest. Apply keeps the entry; Pop removes it; Delete is permanent. Hide/show stashes in the graph. *Edit stash message*.
- **Partial stash:** right-click staged files → *Stash file* stashes only those.
- Apply a single file from a stash: select stash → right-click a file → apply file.
- AI stash message (spec 12).

### 2.6 Undo / Redo
Toolbar Undo/Redo, Ctrl/Cmd+Z, Ctrl+Y / Ctrl/Cmd+Shift+Z. Officially undoable:
| Action | Undo | Redo |
|---|---|---|
| Checkout | ✔ | ✔ |
| Commit | ✔ (soft-resets, keeps changes) | ✔ |
| Discard (file/all/hunk) | ✔ | ✔ |
| Branch delete | ✔ | ✔ |
| Remote remove | ✔ | ✔ |
| Reset branch to commit | ✔ | ✔ |
| Rebase / interactive rebase / drop / reword | ✔ (11.8+) | ✔ |
| Multi-commit cherry-pick | ✔ (11.8+) | ✔ |
| AI Commit Compose | ✔ | ✔ |
Not undoable by default (*inferred*): push, fetch/pull (pull's merge part arguably), tag push/delete on remote, stash drop *(inferred)*, merge *(inferred — not listed)*. Undo applies only to the **most recent** supported action; we extend this to a full stack (§4.7, §6.10) while keeping the same default UX.

## 3. User stories

1. As a developer I want to create a branch from any commit with one right-click so I can start work anywhere in history.
2. As a developer I want to double-click a remote branch and get a local tracking branch checked out so I don't type `git switch -c`.
3. As a developer I want checkout to handle my dirty tree (stash, carry-over, or discard) without losing work.
4. As a maintainer I want to multi-select and delete stale local and remote branches at once.
5. As a developer I want to drag my feature branch onto `main` and pick Merge / Rebase / Fast-forward from a menu.
6. As a developer I want an interactive rebase editor where I reorder by drag and set pick/reword/squash/fixup/drop per commit.
7. As a developer I want to cherry-pick several selected commits in graph order.
8. As a developer I want to reset a branch soft/mixed/hard with a clear warning about data loss.
9. As a developer I want to stash with a message, include untracked files, stash only some files, and apply/pop/delete stashes.
10. As a developer I want Ctrl+Z to undo my last checkout, commit, discard, branch delete, reset, or rebase.
11. As a release manager I want lightweight and annotated tags I can push or delete remotely.
12. As a developer I want Git Flow start/finish shortcuts (UI in spec 12).

## 4. UI specification

### 4.1 Component tree
```
<RepoView>
  <Toolbar>  UndoButton · RedoButton · PullButton · PushButton · BranchButton · StashButton · PopButton
  <LeftPanel>
    <RefSection kind="local|remote|tags|stashes|worktrees">
      <RefRow draggable onDoubleClick=checkout onContextMenu=RefContextMenu/>
  <Graph>
    <RefLabel draggable droppable/>         (spec 04)
    <InlineNameEditor/>                     (create/rename branch/tag inline)
  <RefContextMenu/> <CommitContextMenu/> <StashContextMenu/> <TagContextMenu/>
  <DropActionMenu source target/>           (§4.4)
  <DialogHost>
    <CheckoutDirtyDialog/> <RemoteCheckoutConflictDialog/>
    <DeleteBranchesDialog/> <ResetConfirmDialog/> <CreateTagDialog/>
    <SetUpstreamDialog/> <RevertDialog/> <StashDialog/>
  <InteractiveRebaseView/>                  (replaces graph center; §4.6)
  <OperationBanner/>                        (in-progress merge/rebase/cherry-pick: Continue/Skip/Abort)
  <UndoToast/>                              ("Undid: Checkout feature/x" + Redo link)
```

### 4.2 Context menus (contents, in order)

**Local branch** (target `B`, current `H`):
- Checkout `B` (hidden if `B==H`)
- Pull (fast-forward if possible) — only if `B==H` and upstream exists; *Fast-forward B to upstream* if `B!=H`
- Push / Push to… / Set upstream…
- Merge `B` into `H` · Rebase `H` onto `B` · Interactive rebase `H` onto `B` (hidden if `B==H`)
- Fast-forward `H` to `B` (visible only if `H` is ancestor of `B`)
- Create branch here · Create tag here · Create annotated tag here
- Reset `H` to this commit ▸ Soft / Mixed / Hard (if `B!=H`)
- Cherry-pick commit · Revert commit (target is tip commit)
- Rename `B` · Delete `B` · Delete `B` and `origin/B` (if upstream)
- Explain branch changes (AI, spec 12) · Start PR from `B` (spec 10)
- Copy branch name · Copy commit SHA · Copy link to branch
- Hide / Solo (spec 04)
- Git Flow ▸ Finish (only for flow-prefixed branches, spec 12)

**Remote branch** `origin/X`: Checkout (creates tracking `X`), Create branch here, Merge into H, Rebase H onto, Fast-forward H to, Interactive rebase, Delete `origin/X` (pushes deletion), Copy name/link, Create PR.

**Commit** (single): Create branch here, Checkout this commit (detached), Cherry-pick, Revert, Reset H to this commit ▸, Rebase H onto this commit, Interactive rebase from here (children of this commit up to H), Create tag here / annotated tag, Copy SHA, Copy link, Explain commit (AI).

**Multiple commits selected**: Cherry-pick N commits, Revert N commits *(our extension)*, Squash N commits (contiguous, on H's first-parent line), Rebase N commits onto…, Explain (AI).

**Tag**: Push tag to <remote>, Delete local, Delete from <remote>, Delete both, Create branch here, Checkout (detached), Copy name.

**Stash**: Apply, Pop, Delete, Edit message, Hide, Create branch from stash *(our extension: `git stash branch`)*.

### 4.3 Inline name editor
- Appears on the graph row (or left-panel row) in place of the label. Validation runs on every keystroke via `git check-ref-format --branch` (debounced 100 ms, main process) plus local existence check. Red border + tooltip on invalid ("Name contains `..`", "Branch already exists").
- Spaces are auto-converted to `-` *(inferred)*.
- Enter = submit, Esc = cancel, blur = cancel.

### 4.4 Drag-and-drop matrix

Drag sources: local branch label, remote branch label, tag label, a commit row (handle on node), a stash row *(our extension)*. Drop targets: a ref label in graph or left panel, the left-panel REMOTE header for a remote (e.g., "origin"), the PR section header. During drag, valid targets highlight; invalid ones show a not-allowed cursor. On drop a `DropActionMenu` opens at the cursor listing applicable actions; Esc dismisses.

Notation: `S` source, `T` target, `H` checked-out branch. "ff(T,S)" = T is ancestor of S.

| Source ↓ / Target → | Local branch T (T == H) | Local branch T (T ≠ H) | Remote branch `r/T` | Remote node (left-panel remote) | Tag |
|---|---|---|---|---|---|
| **Local branch S** (S==H) | — | Merge T into S; Rebase S onto T; Interactive rebase S onto T; Fast-forward T to S (if ff(T,S)) ⚠ moves non-HEAD branch via `update-ref`; Reset S to T ▸ (soft/mixed/hard) | Merge r/T into S; Rebase S onto r/T; Interactive rebase S onto r/T; **Push S to r/T** (set upstream option, force variant if non-ff); Create PR S → T | Push S to remote (as `S`), set upstream | Reset S to tag ▸; Rebase S onto tag; Merge tag into S |
| **Local branch S** (S≠H) | Merge S into H; Rebase H onto S; Interactive rebase H onto S; Fast-forward H to S (if ff(H,S)); Reset H to S ▸ | Fast-forward T to S (if ff); Create PR S → T (if both published) *(other ops require checkout; offered as "Checkout T and merge S" — inferred)* | Push S to r/T; Create PR S → T | Push S to remote | — |
| **Remote branch r/S** | Merge r/S into H; Rebase H onto r/S; Interactive rebase H onto r/S; Fast-forward H to r/S; Reset H to r/S ▸ | Fast-forward T to r/S (if ff) | Create PR S → T (same provider) | — | — |
| **Tag** | Merge tag into H; Rebase H onto tag; Reset H to tag ▸ | — | — | Push tag to remote | — |
| **Commit row** | Cherry-pick onto H; Reset H to commit ▸; Rebase H onto commit | — | — | — | — |
| **Stash** *(ext.)* | Apply stash; Pop stash | — | — | — | — |

Rules:
- Dropping a ref on itself or on a ref pointing at the same commit → menu shows only "Nothing to do (same commit)".
- If `S` and `T` have no merge base, Rebase/Interactive rebase are disabled with tooltip "No common ancestor".
- If an operation is already in progress (merge/rebase/cherry-pick), every mutating item is disabled except "Abort current …".
- "Create PR" only appears when the target remote maps to a connected provider (spec 10).
- Drag-to-push on an existing remote branch that would be non-fast-forward shows "Force push S to r/T (with lease)" in red.

### 4.5 Checkout dirty-tree handling
`CheckoutDirtyDialog` appears when checkout would fail due to local changes (we pre-check, §6.3):
- Title: "You have uncommitted changes that conflict with <target>".
- Buttons: **Stash & Checkout** (default; stash with message `autostash: before checkout <target>`; after checkout, offer toast "Pop stash now?" with auto-pop if preference `checkout.autoPopStash=true`), **Discard & Checkout** (red, requires second click; journaled so undoable), **Cancel**.
- If changes **don't** conflict, git carries them over silently (default git behavior) — no dialog.
- Preference `checkout.autostash: 'ask' | 'always' | 'never'` (spec 13).

`RemoteCheckoutConflictDialog` (double-click `origin/X` when local `X` exists):
- If local `X` tracks `origin/X` and is ff-able: checkout `X` and fast-forward (toast).
- If diverged / different upstream: options *Checkout local X* / *Reset local X to origin/X* (hard, journaled) / *Create new branch…* (inline name `X-1`).

### 4.6 Interactive rebase view
Replaces the graph area; the left/right panels stay.
```
<InteractiveRebaseView>
  <Header> "Interactive rebase: feature/x onto main (5 commits)"   [Reset] [Cancel] [Start Rebase]
  <TodoList>                         (oldest at bottom, like the graph; toggle "oldest first")
    <TodoRow drag-handle action-dropdown sha author summary [reword-pencil]/>
  <RowDetailPane/>                   (diff/files of the focused commit, read-only)
  <RewordModal/>                     (summary + description, 72-char counter — reuse CommitComposer fields from 06)
```
- Actions per row: **pick**, **reword**, **edit** *(our ext.)*, **squash** (into the row below in display = older commit), **fixup** (squash discarding message), **drop**. Keys: P, R, E, S, F, D; ↑/↓ move focus; Alt+↑/↓ (Cmd+↑/↓) move row; Delete = drop.
- Reorder via drag (react-dnd/dnd-kit). Dropped rows render struck-through and faded. Squash/fixup rows render indented into their target with a connecting bracket.
- Validation: the oldest (first applied) commit cannot be squash/fixup (no predecessor) → that option disabled; all-drop allowed but warns "branch will point at base".
- Squash message: when Start is pressed and squash rows exist, a modal shows the combined messages (pre-filled) for editing, so the run is non-interactive.
- Reset restores the original todo.
- Start → OperationBanner shows progress `Applying 3/5`. On conflict, the conflict tool (spec 08) opens; banner offers Continue / Skip / Abort.

### 4.7 Undo/Redo UI
- Toolbar buttons with tooltips naming the action: "Undo Checkout feature/x", "Redo Commit 'Fix bug'". Disabled when nothing applicable.
- Shortcuts: Ctrl/Cmd+Z, Ctrl+Y, Ctrl/Cmd+Shift+Z — only when focus is not in a text input/editor.
- After undo: `UndoToast` "Undid <action>" with Redo link (5 s).
- If the undo cannot be applied safely (state drifted, §6.10), a dialog explains why and offers "Show in reflog" (opens a reflog list, *our extension*).
- Optional "History" popover (long-press / dropdown arrow on Undo) listing the last 20 journal entries, newest first *(our extension; the toolbar Undo itself only acts on the most recent)*.

### 4.8 Reset confirm dialog
- Soft/Mixed: no confirmation if journaling is enabled (undoable), just toast.
- Hard: confirmation listing number of modified/untracked files that will be lost ("Untracked files are not removed"), checkbox "Don't ask again" (preference).

### 4.9 Stash UI
- Toolbar Stash: uses WIP summary text as message if non-empty; Shift+click opens `StashDialog` (message, ☐ include untracked, ☐ keep staged changes (`--keep-index`), ☐ only staged (`--staged`, git ≥ 2.35)).
- Staged file context menu: *Stash file(s)* → `git stash push -- <paths>`.
- Stash selection in graph shows its files in right panel (spec 07); untracked part shown under "Untracked (stashed)".
- Right-click file in a selected stash → *Apply this file from stash*.

### 4.10 Shortcuts summary
| Action | Win/Linux | macOS |
|---|---|---|
| Undo / Redo | Ctrl+Z / Ctrl+Y, Ctrl+Shift+Z | Cmd+Z / Cmd+Shift+Z |
| New branch | Ctrl+B | Cmd+B |
| Stash / Pop *(ours; Ctrl+Shift+S is Stage All in spec 06)* | Alt+S / Alt+Shift+S | Opt+S / Opt+Shift+S |
| Interactive rebase actions | P R E S F D | same |

## 5. Data model & IPC

```ts
// src/shared/ops.ts
export type RefName = string;            // full ref, e.g. refs/heads/main
export type Sha = string;

export interface BranchCreateReq { repoId: string; name: string; startPoint: Sha | RefName; checkout: boolean; track?: RefName; }
export interface BranchRenameReq { repoId: string; from: string; to: string; renameRemote?: { remote: string } }
export interface BranchDeleteReq { repoId: string; branches: { name: string; deleteRemote?: { remote: string; remoteBranch: string } }[]; force: boolean; }
export interface CheckoutReq {
  repoId: string;
  target: { kind: 'branch'; name: string } | { kind: 'remoteBranch'; remote: string; name: string; localName?: string }
        | { kind: 'commit'; sha: Sha } | { kind: 'tag'; name: string };
  dirtyStrategy: 'carry' | 'stash' | 'discard';   // decided by renderer after preflight
}
export interface CheckoutPreflight { blockingPaths: string[]; dirty: boolean; localExists?: { name: string; upstream?: string; relation: 'same'|'behind'|'ahead'|'diverged'|'unrelated' } }

export interface TagCreateReq { repoId: string; name: string; target: Sha; annotated?: { message: string; sign?: boolean } }
export interface TagDeleteReq { repoId: string; name: string; local: boolean; remotes: string[] }
export interface TagPushReq { repoId: string; name: string; remote: string }

export type MergeMode = 'default' | 'no-ff' | 'ff-only' | 'squash';
export interface MergeReq { repoId: string; source: RefName | Sha; mode: MergeMode; message?: string }
export interface RebaseReq { repoId: string; branch: string; onto: RefName | Sha; upstream?: Sha /* for range rebase: commits after upstream */ }
export type TodoAction = 'pick' | 'reword' | 'edit' | 'squash' | 'fixup' | 'drop';
export interface TodoItem { sha: Sha; action: TodoAction; newMessage?: string; summary: string }
export interface InteractiveRebaseReq { repoId: string; branch: string; onto: Sha; upstream: Sha; todo: TodoItem[] /* oldest first */; squashMessages: Record<Sha /* target */, string> }
export interface CherryPickReq { repoId: string; shas: Sha[] /* any order; main re-sorts topologically */; noCommit?: boolean; mainline?: number }
export interface RevertReq { repoId: string; shas: Sha[]; noCommit?: boolean; mainline?: number }
export interface ResetReq { repoId: string; branch: string; target: Sha; mode: 'soft' | 'mixed' | 'hard' }
export interface FastForwardReq { repoId: string; branch: string; to: RefName | Sha }
export interface StashPushReq { repoId: string; message?: string; includeUntracked?: boolean; keepIndex?: boolean; stagedOnly?: boolean; paths?: string[] }
export interface StashRef { repoId: string; index: number; sha: Sha }   // sha guards against index shift
export interface SetUpstreamReq { repoId: string; branch: string; upstream: string | null }

export type OpState = { kind: 'none' } | { kind: 'merge' | 'rebase' | 'cherry-pick' | 'revert'; head: Sha; onto?: Sha; step?: number; total?: number; conflicted: string[] };
// OpState is a derived view of spec 02 RepoInfo.state (RepoState) plus git:conflicts; detection lives in spec 02 §6.8/§6.14.

export interface OpResult { ok: boolean; journalId?: string; conflicts?: string[]; state: OpState; stderr?: string }
```

### Undo journal
```ts
export interface JournalEntry {
  id: string; repoId: string; ts: number;
  kind: 'checkout'|'commit'|'amend'|'discard'|'branch-create'|'branch-delete'|'branch-rename'|'reset'|'rebase'|'interactive-rebase'
      |'cherry-pick'|'revert'|'merge'|'fast-forward'|'stash-push'|'stash-pop'|'stash-drop'|'tag-create'|'tag-delete'|'remote-remove'|'ai-compose'
      |'revert-hunk'|'mark-resolved'|'patch-apply';   // specs 07, 08, 14 (see §11)
  label: string;                      // "Checkout feature/x"
  before: RepoSnapshot; after?: RepoSnapshot;   // after filled when op succeeds
  extra?: { discardBlob?: string; stashSha?: Sha; deletedBranches?: {name: string; sha: Sha; upstream?: string}[]; remote?: { name: string; fetchUrl: string; pushUrl?: string } };
  undoable: boolean; status: 'pending'|'done'|'undone'|'failed';
}
export interface RepoSnapshot {
  head: { kind: 'branch'; name: string } | { kind: 'detached'; sha: Sha };
  headSha: Sha | null;
  touchedRefs: Record<RefName, Sha | null>;  // only refs the op may change
  indexTree?: Sha;                    // `git write-tree` result (when op touches index)
  worktreeStash?: Sha;                // `git stash create` result incl. untracked (when op touches worktree)
}
```

### Mapping to the spec 02 contract
Spec 02 sends every mutating action through one channel, `git:op:run`, with a `GitOperation` discriminated union, and returns `OpResult {opId, summary, warnings, data}`. The **mutating** channels below are logical names. Each one becomes a `GitOperation` variant whose `type` is the channel name with `:` replaced by `.`, for example `{ type: 'branch.create', ...BranchCreateReq }`. Each variant gets an `OperationMeta` entry (`undoable`, `touches`). The `OpResult` interface defined above in this spec is renamed `OpOutcome` and is carried in spec 02's `OpResult.data`. **Read-only** channels (`checkout:preflight`, `merge:preview`, `rebase:todoFor`, `undo:peek`, `undo:list`, `branch:validateName`, `copy:link`) are registered as ordinary `git:*` read channels in the spec 02 contract.

### IPC channels (invoke unless noted)
| Channel | Req → Res |
|---|---|
| `branch:create` / `branch:rename` / `branch:delete` | → `OpResult` |
| `branch:setUpstream` | → `OpResult` |
| `branch:validateName` | `{repoId,name}` → `{valid:boolean; reason?:string}` |
| `checkout:preflight` | `CheckoutReq` → `CheckoutPreflight` |
| `checkout:run` | `CheckoutReq` → `OpResult` |
| `tag:create` / `tag:delete` / `tag:push` | → `OpResult` |
| `merge:run` / `merge:preview` (`{ff:boolean; conflictsLikely:string[]}` via `git merge-tree --write-tree`) | |
| `rebase:run` / `rebase:interactive` / `rebase:continue` / `rebase:skip` / `rebase:abort` | → `OpResult` |
| `rebase:todoFor` | `{repoId,branch,upstream}` → `TodoItem[]` (validates no merges) |
| `cherryPick:run` / `revert:run` / `sequencer:continue|skip|abort` | |
| `reset:run` / `ff:run` | |
| `stash:push` / `stash:apply` / `stash:pop` / `stash:drop` / `stash:rename` / `stash:applyFile` / `stash:branch` | |
| `undo:run` / `redo:run` / `undo:peek` (`→ {undo?:JournalEntry; redo?:JournalEntry}`) / `undo:list` | |
| `copy:link` | `{repoId, kind:'branch'|'commit', name|sha}` → `string` |
| event `repo:opState` | `OpState` pushed on change; recomputed when spec 02 `git:repo:changed` carries the `repoState` or `conflicts` scope (no separate watcher) |
| event `undo:changed` | `{canUndo,canRedo,undoLabel,redoLabel}` |

All mutating channels enqueue on the repo's `OperationQueue` and call `Journal.begin()` before executing and `Journal.commit()`/`fail()` after.

## 6. Git implementation

Common env for every command: the spec 02 §6.1 per-invocation policy (`GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0` for read ops, English `LC_MESSAGES` with the UTF-8 locale kept, `-c core.quotepath=false`, `GIT_EDITOR` = the non-interactive editor shim unless a message is provided via `-m`/`-F`). Where this spec writes `GIT_EDITOR=true`, read "the spec 02 editor shim".

### 6.1 Branch create / rename / delete
```
git check-ref-format --branch "<name>"                 # validate (exit 0 → normalized name on stdout)
git branch --no-track "<name>" <startPoint>            # create at commit
git branch --track "<name>" refs/remotes/<r>/<b>       # create tracking
git switch "<name>"                                    # when checkout=true (fallback: git checkout for git<2.23)
git branch -m "<old>" "<new>"                          # rename local
  # remote rename (opt-in): git push <r> <new>:refs/heads/<new>  &&  git push <r> --delete <old>  && git branch -u <r>/<new> <new>
git branch -d "<name>"                                 # safe delete; on "not fully merged" → prompt → git branch -D
git push <r> --delete <remoteBranch>                   # remote deletion (spec 09 auth)
```
Before delete, record `git rev-parse refs/heads/<name>` and `git rev-parse --abbrev-ref <name>@{upstream}` in journal `extra.deletedBranches`. Multi-delete: one `git branch -D a b c` call after safety check of each via `git merge-base --is-ancestor <sha> HEAD` OR upstream containment; unmerged ones are listed in the confirmation with a "force" checkbox. Remote deletions batched: `git push <r> --delete b1 b2 b3`.

### 6.2 Set upstream / copy link
```
git branch --set-upstream-to=<r>/<b> <branch>
git branch --unset-upstream <branch>
git remote get-url <r>      # → normalize ssh/https → provider web URL (spec 10): .../tree/<branch> or .../commit/<sha>
```

### 6.3 Checkout
Preflight:
```
git status --porcelain=v2 -z --untracked-files=all      # dirty?
git diff --name-only -z HEAD <target>                   # files that differ between commits
```
`blockingPaths` = intersection of dirty paths (tracked modified + untracked that exist in target tree: `git ls-tree -r --name-only -z <target> -- <untrackedPaths>`) and changed paths. Empty → `carry`.

Run:
- `carry`: `git switch <branch>` / `git switch --detach <sha>` / tag: `git switch --detach refs/tags/<t>^{commit}`.
- `stash`: `git stash push --include-untracked -m "autostash: before checkout <t>"` → switch → (optional) `git stash pop` (conflicts on pop → staging panel shows conflicts; stash retained by git).
- `discard`: journal snapshot first (`git stash create` + untracked capture, §6.10) then `git switch --discard-changes <t>` and `git clean -fd -- <blockingUntracked>` only for blocking untracked paths.
- Remote branch: `git switch -c <local> --track <r>/<b>`; if local exists & behind: `git switch <local> && git merge --ff-only <r>/<b>`; reset option: `git switch <local> && git reset --hard <r>/<b>` (journaled).
- Remote branch with name ambiguous across remotes: always explicit `--track`.

### 6.4 Tags
```
git tag "<name>" <sha>                                  # lightweight
git tag -a "<name>" -m "<msg>" <sha>                    # annotated (msg via -F tmpfile if multi-line)
git tag -s ...                                          # if tag.gpgSign or user chose sign (spec 06 signing config)
git push <r> refs/tags/<name>
git tag -d <name>
git push <r> --delete refs/tags/<name>
git for-each-ref refs/tags --format='%(refname:short)%00%(objecttype)%00%(*objectname)%00%(objectname)%00%(contents:subject)'
```
Journal: tag-delete records `objectname` (tag object sha for annotated, so recreate via `git update-ref refs/tags/<n> <tagObj>` preserves message/signature while the object still exists).

### 6.5 Merge
```
git merge --no-edit <src>                     # default (ff if possible, else merge commit)
git merge --no-ff --no-edit <src>             # or -m "<msg>" when user customized
git merge --ff-only <src>
git merge --squash <src>                      # then WIP shows staged result + prefilled .git/SQUASH_MSG (spec 06 reads it)
```
Preview (no side effects, git ≥ 2.38): `git merge-tree --write-tree --name-only --no-messages HEAD <src>` → exit 1 lists conflicted paths. Fast-forward check: `git merge-base --is-ancestor HEAD <src>`.
Conflicts → exit code 1 + `git status` shows `u` entries → `OpState{kind:'merge'}` → spec 08. Abort: `git merge --abort`.
Merge message default "Merge branch '<src>' into <H>" (git default).

### 6.6 Fast-forward non-HEAD branch
```
git merge-base --is-ancestor refs/heads/<T> <S>      # must succeed
git update-ref -m "fast-forward: <T> to <S>" refs/heads/<T> <S_sha> <T_old_sha>   # CAS on old value
```
For HEAD branch: `git merge --ff-only <S>`. For "fast-forward to upstream" of non-HEAD: `git fetch <r> <b>:<T>` is avoided; use update-ref after fetch.

### 6.7 Rebase (non-interactive)
```
git rebase <onto>                                     # HEAD branch onto target
git rebase --onto <newbase> <upstream> <branch>       # range / pivot: upstream = parent of pivot commit
git rebase --continue | --skip | --abort
```
We always check out the branch first (rebase <onto> <branch> does it implicitly). Status detection: existence of `.git/rebase-merge/` (`msgnum`, `end`, `onto`, `head-name`, `stopped-sha`) or `.git/rebase-apply/`. Parse those for `OpState.step/total`. `--continue` needs `GIT_EDITOR=true` to keep messages.

### 6.8 Interactive rebase
Generate list: `git rev-list --reverse --topo-order --parents <upstream>..<branch>`; if any line has >2 fields (merge) → reject ("Range contains merge commits"). Root inclusion: if upstream is empty (root), use `--root` *(allowed behind a flag, default off)*.

Execution, non-interactive with our todo:
1. Write `todo` file to temp dir, oldest first:
   ```
   pick a1b2c3d Subject
   exec git commit --amend -F "<tmp>/msg-a1b2c3d"   # for reword — avoids an editor
   squash d4e5f6a Subject
   fixup -C ...  (not used)
   drop 0f0f0f0 Subject
   ```
   Reword strategy: emit `pick <sha>` followed by `exec git commit --amend --no-verify -F <msgfile>` (keeps author, hooks skipped to avoid double runs; respects signing because `commit.gpgSign` still applies). For squash groups, emit `pick` + `fixup` lines then `exec git commit --amend -F <combinedMsgFile>` — yields exactly one editor-free final message.
2. Set `GIT_SEQUENCE_EDITOR` to a tiny Node script path (shipped in app resources) that copies our todo file over `$1`: `GIT_SEQUENCE_EDITOR="\"<node>\" \"<resources>/seq-editor.js\" \"<todoFile>\""`. Use `ELECTRON_RUN_AS_NODE=1` with `process.execPath` as `<node>`.
3. `GIT_EDITOR=true git rebase -i --onto <onto> <upstream> <branch>` (with `--autostash` if the user agreed to autostash; `--no-autosquash` to keep our order).
4. `edit` actions stop the rebase; UI shows "Stopped at <sha> for editing" with Continue (spec 06 commit composer in "amend" mode).
5. On conflict → `OpState{kind:'rebase', conflicted}` → spec 08.
6. On completion compare `ORIG_HEAD` to journal `before`.

### 6.9 Cherry-pick, revert, reset, squash
```
git cherry-pick <sha1> <sha2> ...         # renderer selection sorted oldest→newest by graph order (main re-sorts with rev-list --topo-order --reverse)
git cherry-pick -m 1 <mergeSha>           # merge commit: prompt for mainline parent
git cherry-pick --continue | --skip | --abort
git revert --no-edit <sha...>             # newest→oldest order; or --no-commit to stage only
git revert -m 1 <mergeSha>
git reset --soft|--mixed|--hard <sha>     # HEAD branch
git update-ref -m "reset: moving to <sha>" refs/heads/<B> <sha> <old>   # non-HEAD branch (soft only meaningful; mixed/hard require checkout → disabled)
```
**Squash N commits** (contiguous, HEAD first-parent, newest = HEAD or descendant): implemented as interactive rebase with `pick` oldest + `fixup` rest + `exec git commit --amend -F <msg>`; if the range ends at HEAD, the worktree is clean and there are no merges, use the fast path `git reset --soft <oldest>^ && git commit --no-verify -C <oldest> && git commit --amend --no-verify -F <msg>` (keeps the oldest commit's author/date). Otherwise use the rebase path.

### 6.10 Stash
```
git stash push [-m "<msg>"] [--include-untracked] [--keep-index] [--staged] [-- <paths>]
git stash list -z --format='%gd%x00%H%x00%ct%x00%gs'        # index, sha, time, subject
git stash apply [--index] stash@{n}
git stash pop  [--index] stash@{n}
git stash drop stash@{n}
git stash branch <name> stash@{n}
git checkout stash@{n} -- <path>                          # apply single tracked file
git checkout stash@{n}^3 -- <path>                        # single untracked file (third parent)
```
Before acting on `stash@{n}`, verify `git rev-parse stash@{n}` == `StashRef.sha`; if not, re-resolve by sha from `stash list` (indices shift).
**Edit stash message** (no native command): `sha=$(git rev-parse stash@{n})`, `git stash drop stash@{n}`, `git stash store -m "<new>" $sha` — note this moves the entry to the top; to preserve order, rebuild: drop entries 0..n and re-`store` in reverse order *(ordering behavior inferred)*.

### 6.11 Undo/Redo journal design
Storage: `<gitdir>/githappens/journal.jsonl` (append-only; max 200 entries; per repo). Also creates **keep-alive refs** `refs/githappens/undo/<entryId>/<n>` pointing at any commit the undo needs (prevents GC, survives reflog expiry). Deleted when entry falls off the stack or after 30 days.

Snapshot capture (`Journal.begin(kind, scope)`):
- `headSha = git rev-parse --verify -q HEAD`; `head` from `git symbolic-ref -q HEAD`.
- `touchedRefs`: the specific refs (e.g., branch being reset) via `git rev-parse`.
- If op touches index/worktree (checkout with discard, discard, reset --hard, stash-pop): `indexTree = git write-tree` (fails if conflicts → op blocked) and `worktreeStash = git stash create` (tracked changes) plus untracked capture: `GIT_INDEX_FILE=<tmp> git add -A -- . && GIT_INDEX_FILE=<tmp> git write-tree` → commit-tree it → keep-alive ref. (`stash create` doesn't include untracked; temp-index method does.)

Undo per kind:
| Kind | Undo | Redo | Drift check (must hold before undo) |
|---|---|---|---|
| checkout | `git switch <before.head>` (or `--detach <sha>`), carrying changes; if dirty-conflict → same dialog as §4.5 | switch to after.head | HEAD == after.head |
| commit | `git reset --soft <before.headSha>` (keeps changes staged) | `git reset --soft <after.headSha>` (commit kept alive by ref) | HEAD sha == after.headSha |
| amend | `git reset --soft <before.headSha>` (old commit) — index retains amended state | soft reset to after | same |
| discard | restore: `git read-tree <before.indexTree>` then `git checkout <worktreeStash> -- <paths>` and untracked from captured tree (`git checkout <untrackedTree> -- <paths>` then `git rm --cached` those paths) | re-run discard on same paths | discarded paths unchanged since (hash compare) |
| branch-create | `git branch -D <name>` (if still at created sha) | recreate | ref unchanged |
| branch-delete | `git branch <name> <sha>` + `git branch -u <upstream>` | delete again | name not reused |
| branch-rename | rename back | rename | |
| reset / fast-forward / rebase / interactive-rebase / cherry-pick / revert / merge / squash / ai-compose | for HEAD branch: `git reset --keep <before.headSha>` (refuses if it would clobber local changes; we surface that), non-HEAD: `git update-ref <ref> <old> <new>` | reset --keep to after.headSha | branch tip == after value |
| reset --hard | as above + restore worktree from `worktreeStash` & untracked tree | | |
| stash-push | `git stash pop` of the entry whose sha == recorded | `git stash push` again (new sha recorded) | stash entry still present |
| stash-pop | `git stash store -m <msg> <sha>` + restore worktree from snapshot | pop again | |
| stash-drop | `git stash store -m <msg> <sha>` | drop | |
| tag-create / tag-delete (local only) | delete / `git update-ref refs/tags/<n> <obj>` | | |
| remote-remove | `git remote add <n> <url>`; restore push url and fetch refspecs from captured `git config --get-regexp ^remote\.<n>\.` | remove | |
| push, fetch, pull, remote tag delete | **not undoable** (entry recorded with `undoable:false`, acts as a barrier: undo stops there and says "Cannot undo past Push") | | |

Merge being undoable is our extension. Pull = fetch (barrier) + merge/rebase (undoable as merge) — we record it as `undoable:false` *(inferred)*.
External changes: the RepoWatcher (spec 02) detects HEAD/ref changes not made by us; when HEAD differs from the top entry's `after`, the undo button stays enabled but drift check fails → explanatory dialog. Redo stack is cleared on any new journaled op.

### 6.12 Git Flow (commands; UI in spec 12)
We implement git-flow natively (no git-flow extension dependency), storing config in the standard `gitflow.*` keys for compatibility with the AVH extension:
```
git config gitflow.branch.master main ; git config gitflow.branch.develop develop
git config gitflow.prefix.feature feature/ ; .release release/ ; .hotfix hotfix/ ; .support support/ ; .versiontag ""
# init: create develop from main if absent: git branch develop main
# start feature X:  git switch -c feature/X develop
# finish feature X: [optional git rebase develop feature/X]; git switch develop; git merge --no-ff feature/X; git branch -d feature/X
# start release V:  git switch -c release/V develop
# finish release V: git switch main; git merge --no-ff release/V; git tag -a <prefix>V -m "<msg>"; git switch develop; git merge --no-ff release/V (or merge the tag); git branch -d release/V
# hotfix V: start from main; finish as release
```
Each finish is a **composite op** with one journal entry (snapshot of main, develop, branch refs) so a single undo restores all three refs.

### 6.13 Clean up branches *(our extension)*
Local branches pile up after PRs merge or close: `fetch --prune` drops the remote-tracking ref but never the local branch, and `git branch --merged` misses squash and rebase merges (the GitHub default). Entry points: **Branch ▾ → Clean up branches…** (toolbar split button) and the palette command `branch.cleanup`.

Flow: open the dialog → `fetch --all --prune` (if the repo has remotes; on failure, show an inline note and scan the last fetched state) → `git:branch:cleanupScan` → review → one `branch.delete`. The dialog is the confirmation: no second prompt. A success toast offers **Undo**.

Base branch: `refs/remotes/<r>/HEAD` (origin first), then `<r>/main`, `<r>/master`, local `main`, `master`. No base → nothing offered.

Protected (never listed, named in the footer): current branch, branches checked out in any worktree, `main`/`master`/`develop`/`trunk`, the base's local twin.

Classification of every other local branch:
| Reason | Detection | Group | Preselected |
|---|---|---|---|
| `merged` | `for-each-ref --merged=<base>`. Skipped when its tip equals the base tip and the upstream is not gone (most likely a branch just created) | Merged | yes |
| `rebase-merged` | every non-merge commit's `patch-id --stable` appears in the last 1000 base commits | Merged | yes |
| `squash-merged` | `patch-id --stable` of `git diff <merge-base> <tip>` appears in the last 1000 base commits | Merged | yes |
| `upstream-gone` | configured upstream ref missing, none of the above | Remote deleted, not merged | **no**. The row shows "N commits not merged", and selecting any shows an inline warning and turns the button red |

Rows show the name, reason badge, commits not merged, last commit date and author. Group checkboxes toggle the whole group (indeterminate when mixed). The button names the count ("Delete 4 branches").

Delete: `branch.delete` with `force: true` (squash-merged and remote-deleted branches fail `-d`) and `expectedSha` per branch. The executor re-reads each tip and skips any that moved since the scan, with a warning ("Skipped x: it changed since the scan."). Local only: remote branches are not touched. Undo restores every deleted ref and its tracking config via the journal (§6.11).

Later phases: provider PR status per row ("#142 merged" / "#98 closed", via `HostingProvider.listPullRequests`), a **Stale** group (no commits in 90 days, configurable, never preselected), per-row remote deletion (off by default, leased), user protect patterns (`release/*`), a background-scan badge on Branch, and workspace bulk cleanup (plan → confirm → `BulkRunner`, as for bulk push).

## 7. Step-by-step implementation plan

1. **Ref-name validation** service (`check-ref-format`) + `branch:validateName` IPC; unit tests with tricky names (`a..b`, `@{`, trailing `.lock`, unicode).
2. **Journal core**: `Journal.begin/commit/fail`, snapshot capture, keep-alive refs, jsonl storage, `undo:peek`. Unit-test against fixture repos with no UI.
3. **Branch create/rename/delete/set-upstream** handlers + journal kinds; left-panel and graph context menus; inline name editor.
4. **Checkout** preflight + run + both dialogs; double-click handlers; remote → tracking.
5. **Undo/Redo** for checkout, commit (hook from spec 06), branch create/delete/rename; toolbar buttons, shortcuts, toast, `undo:changed` event.
6. **Tags**: create (lightweight/annotated/signed), delete local/remote, push; journal tag kinds.
7. **Reset** soft/mixed/hard (HEAD + non-HEAD update-ref), confirm dialog, worktree snapshot for hard; undo.
8. **OpState detection** (`.git/MERGE_HEAD`, `rebase-merge`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `sequencer/`) + `OperationBanner` with Continue/Skip/Abort; `repo:opState` event via watcher.
9. **Merge** (default/no-ff/ff-only/squash) + `merge:preview`; conflict hand-off to spec 08.
10. **Fast-forward** HEAD and non-HEAD.
11. **Rebase** simple + range/pivot + "onto this commit".
12. **Drag-and-drop**: drag sources on labels/rows, drop target hit testing on canvas labels (spec 04 exposes label rects), `DropActionMenu` computed by a pure function `computeDropActions(source, target, repoState): DropAction[]` — exhaustively unit-tested against §4.4 matrix.
13. **Cherry-pick / revert** single & multi, mainline prompt for merges.
14. **Stash** push variants, list, apply/pop/drop/rename/applyFile/branch; stash UI; per-file stash.
15. **Interactive rebase**: `rebase:todoFor`, `seq-editor.js`, todo generation (reword/squash via exec amend), editor view with dnd, keyboard, reset, squash-message modal; edit-stop flow.
16. **Squash N commits** action built on step 15.
17. **Undo for history rewrites** (rebase, cherry-pick, merge, reset, squash, stash, remote remove) + barrier entries for push/fetch/pull.
18. **Copy SHA / name / link** (provider URL builder from spec 10; fallback to plain remote URL).
19. **Git Flow command layer** (UI in spec 12) with composite journaling.
20. E2E Playwright suite over fixture repos for every row of the drag matrix and every undo kind.

## 8. Edge cases

- **Detached HEAD**: menus say "HEAD (detached at abc1234)"; merge/rebase operate on HEAD; "Create branch here" emphasized; undo of checkout back to detached works. Leaving detached HEAD with commits not on any branch → warning dialog "N commits will become unreachable — create a branch?" (journal keep-alive refs preserve them anyway).
- **Empty repo / unborn branch**: no commits → only "Create first commit" (spec 06). `rev-parse HEAD` fails — snapshot stores `headSha:null`; undo of the first commit = `git update-ref -d refs/heads/<b>` + keep index.
- **Bare repos**: all worktree ops disabled; branch/tag ops allowed.
- **Worktrees**: cannot checkout a branch checked out in another worktree (`git switch` errors "already used by worktree at …") — preflight via `git worktree list --porcelain`, label shows worktree icon; delete branch also blocked.
- **Branch names**: unicode, slashes (`feature/a` vs existing `feature` file/dir conflict: `feature` branch prevents `feature/x` — surface git error), case-insensitive filesystems (`Main` vs `main` on Windows/macOS — warn when names differ only in case).
- **Same name on multiple remotes**: always use explicit `--track r/b`.
- **Protected/remote deletion rejected** (provider protection): show remote error, local deletion still done; journal partial.
- **Hooks**: `post-checkout`, `pre-rebase`, `post-rewrite` run; failures in `pre-rebase` abort with hook output shown (spec 06 hook output panel).
- **Signed commits**: rebase/cherry-pick re-sign if `commit.gpgSign=true`; passphrase prompts handled by gpg-agent/pinentry — if pinentry unavailable, op fails; show message.
- **Rebase with merges in range**: blocked; optional `--rebase-merges` later.
- **Conflicts during autostash pop** after rebase: git keeps stash; banner informs.
- **Index lock**: the queue serializes our ops. A lock left by an external process is handled only by the spec 02 §6.13 pre-check (poll up to 5 s for fresh locks, then `IndexLocked` and the shared "Delete lock & retry" dialog). No extra retry loop here.
- **Huge stashes / many branches** (10k refs): left panel virtualized; multi-delete batched in chunks of 200 refs per command to avoid Windows command-line length limits (32k).
- **Shallow clones**: merge-base may fail → disable rebase/IR with tooltip "History is shallow".
- **Stash index drift**: always verify by sha.
- **CRLF / filters**: `git stash create` honors filters; discard restore may re-normalize — acceptable.
- **Journal drift / external git commands**: drift check per §6.11; never force-apply.
- **Reflog expired / gc**: keep-alive refs prevent object loss; they're hidden from the graph (namespace excluded by `--exclude=refs/githappens/*` in log calls, spec 04).

## 9. Acceptance criteria

- [ ] Create/rename/delete branch from graph and left panel; invalid names rejected live.
- [ ] Multi-select delete of 20 local branches + their remotes in one confirmation; unmerged branches flagged.
- [ ] Double-click remote branch with no local → tracking branch created and checked out; with existing local → correct dialog per relation.
- [ ] Checkout with conflicting dirty tree shows Stash/Discard/Cancel; non-conflicting carries changes silently.
- [ ] Lightweight, annotated and signed tags created; push and remote delete work; annotated message shown on hover.
- [ ] `computeDropActions` returns exactly the matrix in §4.4 (unit test table); each action executes correctly in e2e.
- [ ] Merge default/no-ff/ff-only/squash; squash leaves staged result with SQUASH_MSG prefilled.
- [ ] Rebase, range rebase, pivot rebase, rebase onto commit.
- [ ] Interactive rebase: reorder by drag, all six actions, keyboard shortcuts, Reset, squash message editing; merges in range rejected; completes without any external editor opening.
- [ ] Cherry-pick and revert single + multiple in correct order; merge commits prompt for mainline.
- [ ] Reset soft/mixed/hard on HEAD; soft on non-HEAD branch; hard shows confirmation.
- [ ] Stash: message, include untracked, keep index, staged-only, per-file; apply/pop/delete/rename/apply-single-file; order preserved after rename.
- [ ] Undo/Redo works for every kind in §6.11 table; barrier entries block undo past push; drift is detected and explained; redo stack cleared on new op.
- [ ] In-progress op banner reflects state started from terminal as well.
- [ ] Copy SHA/link produce correct provider URLs for GitHub/GitLab/Bitbucket/Azure.
- [ ] No operation leaves `index.lock` behind; all ops cancellable where git supports it (abort).

## 10. Out of scope / later

- `--rebase-merges` interactive rebase, `--root` rebase (behind flag only).
- Undo of push via force-push-with-lease (possible later, dangerous).
- Branch "pinning"/favorites (spec 04/11), branch descriptions (`branch.<n>.description`).
- Git Flow UI (spec 12); GitHub Flow / trunk presets.
- Stash diff vs arbitrary commit, stash "pin".
- Visual rebase conflict prediction (spec 14 conflict prevention).

## 11. Cross-spec dependencies

- **Drop-action menu behind spec 04's `onRefDrop` (owned here):** spec 04 emits `onRefDrop({ source, target })` with full ref names, using its `getRefLabelRegions()` / `hitTestRefLabel()` hit regions (spec 04 §11). This spec owns `computeDropActions(source, target, repoState): DropAction[]` (§4.4 matrix) and the `DropActionMenu`. Spec 10 registers "Start a pull request" and spec 08 adds conflict-prediction badges to its items. Left-panel drop targets (spec 01) use the same function.
- **Undo entries for "Revert hunk" (spec 07 §6.6) and "Mark resolved" (spec 08 §6.6):** both are journaled `GitOperation`s with `OperationMeta.undoable = true`.
  - `revert-hunk`: snapshot as for `discard` (`indexTree` + `worktreeStash` limited to the touched path). Undo restores the file with `git checkout <worktreeStash> -- <path>`. Redo re-applies the stored reverse patch with `git apply --reverse --recount`. Drift check: the file's worktree hash equals the post-revert hash.
  - `mark-resolved`: before `git add`/`git rm`, record the unmerged index entries (`git ls-files -u -z -- <paths>`) and the worktree file hashes. Undo runs `git update-index --index-info` with the recorded stage 1/2/3 entries, which re-creates the conflict without touching the worktree file. Redo re-runs `git add`/`git rm`. It is only valid while the merge/rebase/cherry-pick/revert is still in progress. Once the op completes (state returns to `clean`), the entry becomes a barrier.
  - `patch-apply` (spec 14 cloud patches) snapshots like `discard` plus `touchedRefs` when a branch is created.
- **Delete `.orig` files after merge (setting `general.deleteOrigFiles`, spec 13, default true):** when a merge, rebase, cherry-pick, revert or stash-apply finishes (`RepoInfo.state` returns to `clean`), delete untracked `*.orig` files that appeared during the op. Candidates are `git ls-files --others --exclude-standard -z -- '*.orig' ':(glob)**/*.orig'` minus the set recorded in the journal snapshot at op start. Delete them with `fs.rm` inside the worktree only and show a toast "Removed N .orig backup files". Spec 08 also passes `-c mergetool.keepBackup=false` to `git mergetool` so most backups are never created.
- **Autostash preferences live in spec 13:** `checkout.autostash` (`'ask' | 'always' | 'never'`, default `'ask'`) and `checkout.autoPopStash` (default `false`) are spec 13 settings read by the checkout preflight (§4.5, §6.3). Pull autostash is the `autostash` flag of spec 09's `pull` operation. The interactive-rebase `--autostash` prompt (§6.8) uses `checkout.autostash` too.
- **Spec 02 contract:** mutating channels map to `GitOperation` variants as described in "Mapping to the spec 02 contract" (§5). Repo-state detection, lock handling and the editor shim come from spec 02 (§6.8, §6.13, §6.1). Keep-alive refs `refs/githappens/undo/*` (§6.11) rely on spec 02/04 hiding that namespace.
