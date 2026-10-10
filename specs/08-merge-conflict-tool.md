# 08 — Merge Conflict Detection & 3-Way Merge Tool

> Depends on: 00, 02 (GitService, op queue, watcher), 04 (conflict row in graph), 05 (merge/rebase/cherry-pick/revert/stash ops that produce conflicts), 06 (commit composer finishing the merge), 07 (Monaco infrastructure, file content reading). Feeds: 12 (AI resolve uses AIService), 13 (merge tool preferences), 14 (team conflict prevention).
> Code: `apps/desktop/src/renderer/views/merge-tool`, `packages/git/src/conflicts`, `packages/merge` (pure 3-way merge model, unit-testable).

---

## 1. Purpose

When a merge, rebase, cherry-pick, revert, stash apply/pop, or pull leaves files conflicted, the app has to:
1. detect it immediately and explain what happened,
2. list the conflicted files with their conflict type,
3. let the user resolve each file in a built-in 3-way merge tool (pick lines from either side, edit the output) or in their external tool,
4. mark files resolved, then continue or abort the operation safely.

GitHappens' merge tool is a main reason users choose it over the CLI. It has to be clear about "whose side is whose", which matters most during rebase, where ours and theirs are swapped.

---

## 2. Reference behavior

Sources: desktop Git client help ("Merge conflicts", "Diff" external tools, "Conflict prevention"), release notes, and merge-tool feature pages (the merge tool is Monaco-based and the output has autocomplete). *(inferred)* = not explicitly documented.

- After a conflicting operation, the graph shows a **conflict entry** at the top in place of WIP. The right panel shows a banner: "Merge conflicts detected" (or rebase/cherry-pick), with the conflicted files listed first and an **Abort** button *(inferred wording)*.
- Clicking a conflicted file opens the **Merge Tool**. The **current branch** is in the left pane (A), the **target/incoming branch** is in the right pane (B), and the **Output** is in the bottom pane.
- Each conflict section has a **checkbox** in A and B to take that whole chunk, and individual lines can be clicked or ticked (+) to take just those lines. Selections from both sides are combined in the output.
- The **output is directly editable** (a Monaco editor with autocomplete since 6.2).
- **Arrow buttons and keys** move between conflicts. **Ctrl/⌘+F** searches inside the tool. A **word-wrap** toggle was added in v11.9.
- **Save** writes the output and marks the file resolved (staged). Then the user commits ("Commit and Merge") or continues the rebase.
- In the commit panel, right-clicking a conflicted file offers **"Take current (branch)"** or **"Take incoming (branch)"** to resolve the whole file at once.
- **Auto-resolve with AI** (v11.2 preview): it generates a proposed resolution into the Output with an explanation and a confidence level per conflict. v11.2.1 fixed it for cherry-pick and stash conflicts, and v11.6 aligned the suggestions with exact lines.
- There is no license gating on the output editor.
- **External merge tools:** Preferences › General / External Tools › Merge Tool. The dropdown lists Beyond Compare, FileMerge, Kaleidoscope, KDiff3, Araxis and P4Merge; Meld, SemanticMerge, TortoiseMerge and WinMerge are supported through git's mergetool config (§6.8).
- **Conflict Prevention** (paid "Advanced" tier, team feature) warns when your branch and a teammate's branch modify the same files, before a merge happens. We implement a local variant (§4.9) and leave the team variant to spec 14.

---

## 3. User stories

1. As a developer, I want to be told immediately that my merge has conflicts, and which files, so that I don't commit a broken state.
2. As a developer, I want to see my version, their version and the result together, and pick lines with checkboxes.
3. As a developer, I want to type directly in the output to write a hand-merged resolution.
4. As a developer, I want "take all from mine" or "take all from theirs" for a whole file in one click.
5. As a developer rebasing, I want the panes labeled with real branch and commit names so that I'm not confused by ours/theirs swapping.
6. As a developer, I want to jump between conflicts with the keyboard.
7. As a developer, I want an AI suggestion for tricky conflicts, with an explanation, that I can accept or reject per conflict.
8. As a developer, I want to resolve delete/modify, rename and binary conflicts with clear choices.
9. As a power user, I want to launch Beyond Compare, KDiff3, Meld or VS Code instead.
10. As a developer, I want to abort and get back exactly where I was, or continue once everything is resolved.
11. As a developer, I want a warning before a merge or rebase that it will conflict.

---

## 4. UI specification

### 4.1 Component tree

```
<ConflictBanner op inProgress>                    // top of RightPanel (and thin strip above graph)
│   "Merge in progress: merging feature/login into main — 3 conflicted files, 1 resolved"
│   [Abort merge] [Continue] (disabled until 0 conflicts) [Skip commit] (rebase only) [?]
<ConflictFileList>                                // RightPanel, above staged/unstaged lists (spec 06)
│   └─ <ConflictFileRow path type status>         // icon by type, badge "2 conflicts", resolved ✓; hover: Open, Take A, Take B
<MergeToolView path>                              // CenterArea (replaces graph/diff)
├─ <MergeToolToolbar>
│   ├─ file name + conflict type badge, "Conflict 2 of 5" ‹ ›
│   ├─ [Take all A] [Take all B] [Take A then B] [Take B then A] [Reset to base / markers]
│   ├─ [Auto-resolve trivial] [✨ Auto-resolve with AI]
│   ├─ word wrap · ignore whitespace (display) · Ctrl+F
│   ├─ [Open in external tool ▾]
│   └─ [Save] [Save & mark resolved] [Close]
├─ <SplitPanes vertical>
│   ├─ <SidePane side="A" label="main (current)" sha>   // Monaco read-only + checkbox gutter
│   └─ <SidePane side="B" label="feature/login (incoming)" sha>
├─ <OutputPane>                                   // Monaco editable; conflict regions decorated; per-chunk status chips
│   └─ <ChunkActionBar/> per unresolved chunk (overlay widget): A ▢ B ▢ | AI suggestion ✓ ✗ | "edited"
└─ <AiExplanationDrawer/>                         // per-chunk explanation + confidence
<SpecialConflictView>                             // for non-text conflicts (§4.6): choice cards
<ConflictPreviewBadge/>                           // used by spec 04/05 drag-drop & menus (§4.9)
```

### 4.2 Conflict banner and file list
- The banner shows when the repo is in any in-progress state with conflicts, or with resolved conflicts not yet committed. The text depends on the operation:
  - Merge: "Merging **B** into **A**"
  - Rebase: "Rebasing **feature** onto **main** — step 3/7: `abc123 Fix login`"
  - Cherry-pick: "Cherry-picking `abc123` onto **main**", including the queue position when picking several
  - Revert: "Reverting `abc123`"
  - Stash: "Applying `stash@{0}` — conflicts" (no abort semantics; see §6.6)
  - Pull with merge or rebase: same as merge/rebase, with the remote branch named.
- Buttons:
  - **Abort** (confirm dialog: "Abort the merge? All resolutions will be lost.")
  - **Continue / Commit** (enabled when no unmerged paths remain). Continue focuses the commit composer (spec 06), prefilled from `MERGE_MSG`.
  - **Skip** (rebase and cherry-pick only)
  - **Mark all resolved** (only when every file has no remaining conflict markers)
- File rows: the conflict-type icon (see the table in §4.6), the path, a count of unresolved chunks (computed after parse), and a ✓ when resolved (staged). Hover actions: Open in merge tool, Take A (current), Take B (incoming), Open externally, Mark resolved.
- Context menu: Open merge tool · Take current (A) · Take incoming (B) · Take base · Mark resolved · Mark unresolved (`git checkout -m`/restore conflict) · Open in external merge tool · Open file in editor · Show in folder · Copy path.
- Keyboard: ↑/↓ over files, Enter opens. Ctrl/⌘+D opens the merge tool.

### 4.3 Merge tool layout
- **Top half:** A | B, side by side and resizable, 50/50 by default. Each shows the *whole file* for that side (stage 2 and stage 3 contents), with conflict regions highlighted (A tinted with the theme's "ours" color and B with "theirs"). Non-conflicting changes relative to the base are lightly shaded (git auto-merged them).
- **Bottom half:** the Output (editable), initially showing the auto-merged file. Each unresolved conflict region shows as a **placeholder block**: a hatched band reading "Conflict 2 — choose lines above or edit here". Once lines are chosen it holds them, marked with a left border colored by source (A, B or edited).
- **Pane labels** use names, not "ours/theirs" (§6.3): `A — main (current branch) · 1a2b3c4` and `B — feature/login (incoming) · 9f8e7d6`. A tooltip explains the git terminology ("git calls this 'ours'").
- **Optional base pane** (toggle "Show base"): a third read-only pane for stage 1 *(our addition; the default layout is A/B/Output)*.
- **Scrolling sync:** A, B and the Output scroll in lock-step aligned by conflict chunk. Between chunks, alignment uses line mapping from the stable segments.

### 4.4 Choosing lines (checkbox model)
- In A and B, each conflict chunk has a **chunk checkbox** in its gutter header and a **line checkbox** (+ icon on hover) per line.
- Ticking the chunk checkbox selects all its lines. A partial selection shows an indeterminate state.
- The chunk's output = the selected lines **in selection order of sides**. Whichever side was ticked first comes first. Within a side, lines keep their original order *(inferred: lines are appended in click order)*. A chip in the ChunkActionBar flips the order (A↔B).
- Unticking removes the lines. If nothing is selected, the chunk outputs empty (deletes the region) and is still marked "unresolved" until the user explicitly confirms "Resolve as empty" or ticks something. This prevents accidental deletion.
- **Manual edit:** typing inside a chunk's output region marks it **edited**. Its checkboxes become read-only and show "edited — reset to re-enable". "Reset chunk" restores the checkbox-driven content. Editing outside chunk regions is always allowed and does not affect chunk state.
- **Navigation:** ‹ › buttons, **Alt/⌥+↑/↓** or **F7/Shift+F7** jump to the previous or next *unresolved* chunk. Ctrl/⌘+Alt+↑/↓ goes to any chunk. Arrow keys alone move between conflicts when the focus is on a side pane gutter.
- **Keyboard picking:** with the focus on a chunk, `A` takes the A chunk, `B` takes the B chunk, `Shift+A`/`Shift+B` appends the other side, and `E` focuses the output region *(our shortcuts)*.

### 4.5 Save and resolve
- **Save** (Ctrl/⌘+S) writes the Output to the worktree file. If unresolved chunks remain, the dialog reads "2 conflicts are unresolved. Save anyway with conflict markers? / Cancel". If saved with markers, the file stays unmerged.
- **Save & mark resolved** (Ctrl/⌘+Enter) writes the file, then runs `git add -- <path>`. The file moves to resolved (✓), and the tool advances to the next conflicted file automatically (a preference, default on). When it was the last one, focus moves to the commit composer or Continue button.
- **Marker check before marking resolved:** if the output still contains lines matching `^(<{7}|={7}|>{7}|\|{7})( |$)`, warn "Output still contains conflict markers" (override allowed, for files that legitimately contain such lines).
- **Close** with unsaved output prompts Save / Discard / Cancel. Unsaved tool state is kept in memory per path while the operation is in progress, so reopening restores the selections.

### 4.6 Special conflict types (`SpecialConflictView`)

Porcelain v2 `XY` codes from `git status`:

| XY | Meaning | UI | Resolutions |
|---|---|---|---|
| UU | both modified | 3-way text tool | lines/edit |
| AA | both added | 2-way tool (no base: base = empty) | lines/edit |
| DU | deleted by us (A), modified by them | choice card: "A deleted this file; B modified it" plus a diff of B vs base | Keep B's file (`git add`) · Delete (`git rm`) |
| UD | modified by us, deleted by them | choice card, mirrored | Keep A's file · Delete |
| AU / UA | added by us/them only (rename/directory cases) | choice card | Keep · Delete |
| DD | both deleted (rename-rename split) | info card plus rename targets | Delete (`git rm`) |
| binary UU/AA | binary differs | card with sizes; image preview A/B (spec 07 ImageDiff) | Take A · Take B (`git checkout --ours/--theirs` + add) |
| submodule | gitlink differs | card with both SHAs and commit summaries | Take A sha · Take B sha · Choose commit… (`git update-index --cacheinfo 160000,<sha>,<path>`) |
| symlink | link targets differ | card with both targets | Take A · Take B · Edit target |
| mode conflict | executable bit differs | text tool plus a mode chooser chip | add + `git update-index --chmod=±x` |
| rename/rename, rename/delete | detected via `git status` porcelain v2 plus `merge-tree` messages *(inferred)* | card listing both paths | Keep path X / Y / both |
| LFS pointer | both sides pointers | card: fetch both objects and show content if an image; otherwise Take A/B | Take A · Take B |

### 4.7 Auto-resolve
- **Auto-resolve trivial** (deterministic, local; *our addition*): for each chunk, apply these rules in order:
  1. A == B after whitespace normalization → take A (identical changes that differ only in whitespace).
  2. A == base modulo whitespace → take B (A only changed whitespace).
  3. B == base modulo whitespace → take A.
  4. Both sides only *added* lines at the same point and the base region is empty. These are not resolved automatically, but offered as "take both (A then B)" with a highlight *(proposal only)*.
  Resolved chunks are marked "auto" with an undo button.
- **Auto-resolve with AI** (spec 12 AIService, opt-in, requires a configured AI provider):
  - Input per chunk: file path, language, base/A/B chunk text, plus ±30 lines of surrounding context and both commit messages. Requests are batched per file and sized below the token limit. If over the limit, only the chunks are sent.
  - The output follows spec 12's conflict schema: `{ proposals: { hunkId, resolvedText, explanation, confidence: 'high'|'medium'|'low' }[] }`, where `hunkId` is the `Segment.id` of the chunk. It is validated with a schema. On parse failure, show an error and do not apply anything.
  - Each suggestion is inserted into the output as a *proposal* (a distinct "AI" border color), with ✓ Accept / ✗ Reject and the explanation and confidence in the drawer. Nothing is staged automatically. Low-confidence suggestions get a warning style.
  - A privacy notice is shown the first time: "Conflict content will be sent to <provider>".
  - It works for merge, rebase, cherry-pick and stash conflicts (v11.2.1 parity).

### 4.8 External merge tool
- The "Open in external tool ▾" dropdown launches the configured tool (§6.8) for the current file. The internal tool is disabled while the external one runs, with an overlay "Waiting for Beyond Compare… [Cancel wait]". When the process exits:
  - The output file changed and has no markers (or the tool returned 0 with `trustExitCode`) → prompt "Mark `path` as resolved?" (or do it automatically, per preference).
  - Otherwise → leave it unmerged.
- Preference: "Use external merge tool by default", which makes clicking a conflicted file launch the external tool directly.

### 4.9 Conflict prevention hint (local)
- Before a merge, rebase, cherry-pick or pull is executed from a drag-drop menu or context menu (spec 05), and while hovering a drop target for 500 ms (spec 04 §4.11), run a **dry-run conflict check** (§6.9). If conflicts are predicted, the menu item shows "⚠ Will conflict in 3 files" with a hover list of files. The operation is still allowed.
- Branch pills in the graph can optionally show a small ⚠ when the branch would conflict with its PR target or the default branch. This is computed lazily for visible branches, cached by `(sha1, sha2)`, and off by default.
- Team-based prevention (others' unpushed work) belongs to spec 14.

### 4.10 States
- **No conflicts but operation in progress** (for example, a rebase paused for an `edit` step, or a merge with `--no-commit`): the banner still shows Continue/Abort, with no file list.
- **Loading file:** a skeleton in the three panes.
- **File too large** (> 5 MB or > 50k lines): "Large conflicted file — open in external tool or resolve as whole file (Take A/B)". The internal tool is allowed after confirmation.
- **Error** (for example, the stage blob is missing): an error card with "Open in editor (with markers)".

---

## 5. Data model & IPC

```ts
// Derived from spec 02 RepoInfo.state (RepoState): merging→'merge', rebasing/rebasing-interactive→'rebase',
// cherry-picking→'cherry-pick', reverting→'revert', applying-mailbox→'am'; 'stash-apply' = state 'clean' with unmerged entries.
export type InProgressOp = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'stash-apply' | 'am';

export interface RepoOperationState {
  op: InProgressOp | null;
  // human labels for panes
  current: { label: string; sha: Sha };     // pane A
  incoming: { label: string; sha: Sha };    // pane B
  base?: { sha: Sha | null };               // merge-base when known
  rebase?: { step: number; total: number; ontoLabel: string; currentCommit: { sha: Sha; subject: string } };
  sequencer?: { remaining: Sha[] };          // multi cherry-pick / revert
  message?: string;                          // MERGE_MSG contents
  conflicts: ConflictFileInfo[];
  resolvedPending: string[];                 // paths resolved (staged) during this op
}

export type ConflictCode = 'UU' | 'AA' | 'DU' | 'UD' | 'AU' | 'UA' | 'DD';
export interface ConflictFileInfo extends ConflictFile {   // ConflictFile / ConflictStage {mode, sha}: spec 02 §5.1 (git:conflicts)
  code: ConflictCode;
  kind: 'text' | 'binary' | 'submodule' | 'symlink' | 'lfs';
  unresolvedChunks?: number;                 // filled after parse
}

// pure merge model (packages/merge)
export interface MergeDocument {
  path: string;
  eol: '\n' | '\r\n';
  segments: Segment[];
}
export type Segment =
  | { type: 'stable'; lines: string[] }                       // auto-merged / unchanged
  | { type: 'conflict'; id: number; base: string[]; a: string[]; b: string[];
      aStartLine: number; bStartLine: number;                // line numbers in full A/B files (for pane mapping)
      state: ChunkState };
export interface ChunkState {
  selected: { side: 'a' | 'b'; line: number }[];             // order = output order
  edited?: string[];                                          // manual override
  ai?: { text: string; explanation: string; confidence: 'high'|'medium'|'low'; status: 'proposed'|'accepted'|'rejected' };
  auto?: 'trivial';
  resolved: boolean;
}
```

**IPC channels**

| Channel | Payload → Result | Notes |
|---|---|---|
| `conflict:state` | `{repoId}` → `RepoOperationState` | Also pushed as an event `conflict:stateChanged` when spec 02 `git:repo:changed` carries the `repoState` or `conflicts` scope |
| `conflict:loadFile` | `{repoId, path}` → `{ base: FileContent; ours: FileContent; theirs: FileContent; working: FileContent; merged: MergeDocument }` | merged = from `merge-file` (§6.4) |
| `conflict:saveFile` | `{repoId, path, text, markResolved: boolean}` → `{ ok; hasMarkers }` | op queue |
| `conflict:take` | `{repoId, paths: string[], side: 'ours'\|'theirs'\|'base'}` → void | Whole-file resolution |
| `conflict:resolveSpecial` | `{repoId, path, action: 'keep'\|'delete'\|'take-ours'\|'take-theirs'\|{ submoduleSha }\|{ rename: string }}` → void | |
| `conflict:markResolved` | `{repoId, paths}` → void | `git add` / `git rm` |
| `conflict:markUnresolved` | `{repoId, paths}` → void | `git checkout -m -- paths` |
| `conflict:abort` | `{repoId}` → void | |
| `conflict:continue` | `{repoId, message?}` → `{ nextState: RepoOperationState }` | May produce new conflicts (rebase) |
| `conflict:skip` | `{repoId}` → same | |
| `conflict:openExternal` | `{repoId, path}` → `{ exitCode; changed: boolean; hasMarkers: boolean }` | Resolves when the tool exits |
| `conflict:predict` | `{repoId, ours: Rev, theirs: Rev, kind: 'merge'\|'rebase'\|'cherry-pick'}` → `{ conflicts: string[]; supported: boolean }` | |
| `ai:run` `{ feature: 'conflictResolve', repoId, path, requestId }` | → streamed `ai:event`; `result` = `ConflictProposal[]` keyed by `hunkId` = `Segment.id` | Defined in spec 12 §5 / §6.5 |

---

## 6. Git implementation

### 6.1 Detecting the in-progress operation
RepoWatcher (spec 02) watches these `.git` entries (use `git rev-parse --git-path <x>` for worktrees):

| File/dir | Operation |
|---|---|
| `MERGE_HEAD` (+ `MERGE_MSG`, `MERGE_MODE`) | merge (incl. pull-merge) |
| `rebase-merge/` (`head-name`, `onto`, `msgnum`, `end`, `stopped-sha`, `done`, `git-rebase-todo`) | rebase (merge backend) |
| `rebase-apply/` (`applying` → am; else rebase apply backend) | rebase (apply) / `git am` |
| `REBASE_HEAD` | commit being replayed |
| `CHERRY_PICK_HEAD` (+ `sequencer/todo`) | cherry-pick |
| `REVERT_HEAD` (+ `sequencer/`) | revert |
| no head file, but unmerged index entries | stash apply/pop conflict (or `checkout -m`) |

Reading the state (`ConflictService.readState`):
```bash
git status --porcelain=v2 -z --branch --untracked-files=no     # 'u' records = unmerged
git ls-files -u -z                                              # "<mode> <oid> <stage>\t<path>\0" for stages 1..3
```
- Parse porcelain v2 `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`. Here h1/h2/h3 are the stage 1/2/3 oids, which makes `ls-files -u` optional. `<sub>` (`S...`) flags submodules. Mode `120000` = symlink. Kind detection: submodule if mode `160000`. Binary: `git diff --numstat` on the stages, or a NUL sniff. LFS: pointer sniff on stage blobs.

### 6.2 Pane labels
| Op | Pane A (git "ours", stage 2) | Pane B (git "theirs", stage 3) |
|---|---|---|
| merge / pull-merge | current branch `HEAD` (symbolic name) | `MERGE_HEAD`. Name from `MERGE_MSG` first line ("Merge branch 'x'") or `git name-rev --name-only --refs='refs/heads/*' --refs='refs/remotes/*' <sha>` |
| rebase | **the branch being rebased onto** (`onto`; name from `rebase-merge/onto` + name-rev) plus already-replayed commits | **the commit being replayed** (`REBASE_HEAD` / `stopped-sha`) from `head-name` (feature branch) |
| cherry-pick | current branch | `CHERRY_PICK_HEAD` ("abc123 subject") |
| revert | current branch | "revert of abc123" (the inverse of `REVERT_HEAD`) |
| stash apply/pop | current branch "Updated upstream" | "Stashed changes" (`stash@{n}`) |

The labels are computed in main and delivered in `RepoOperationState`. "Take current" and "Take incoming" in the UI **map to the A/B panes**, which already account for the rebase swap. Internally they always map to stage 2 (`--ours`) and stage 3 (`--theirs`).

### 6.3 Loading contents
- `base = :1:<path>`, `ours = :2:<path>`, `theirs = :3:<path>` via the spec 02 `BlobReader` (`cat-file --batch`, spec 02 §6.8). Missing stages (AA has no base, DU has no ours) → empty plus a flag.
- `working` = the file on disk with markers (git has written it).
- EOL: detect from ours. Normalize the merge to that EOL. Preserve a missing final newline per side.

### 6.4 Computing the merge document
Use **git's own merge** for fidelity with `merge.conflictStyle`, attributes and renormalization:
```bash
# write stages to temp files (or use process substitution-free approach: temp dir)
git merge-file -p --diff3 -L A -L BASE -L B  <ours.tmp> <base.tmp> <theirs.tmp>
# exit code = number of conflicts (≥0), negative/≥128 = error
```
- Use `--diff3` so that each conflict region includes the base. Parse the output with a strict marker parser at the default marker size of 7, or `--marker-size=<n>` when the file contains 7-char marker lines. Pick n = 1 + the longest run of `<`/`=`/`>`/`|` at line start in any stage, capped at 32. The parser produces `Segment[]`: lines outside markers → `stable`, and `<<<<<<< A` … `||||||| BASE` … `=======` … `>>>>>>> B` → `conflict{a, base, b}`.
- To map conflict chunks to line ranges in the full A and B files (for highlighting in the side panes): walk the segments while counting lines. The stable segment lines in the output correspond to merged content, not to A or B directly. To align, run a line diff (Myers) between A and the "A-projection" of the document (stable + a-lines). The positions of the a-lines in A give `aStartLine`, and the same for B. *Fallback:* search for the chunk's lines as a contiguous block near the expected position.
- **Respect custom merge drivers:** if `.gitattributes` assigns `merge=<driver>` or `merge=binary`/`-merge` for the path, don't recompute. Load `working` as is, and parse its markers if any. Otherwise treat it as binary (Take A/B only).
- **Why not use the working-tree file directly?** It may have been edited by the user, and `merge.conflictStyle` may be `merge` (no base). `merge-file` gives a fresh, base-including view. If the working file differs from the fresh merge output (the user edited it externally), offer "Load current file contents" vs "Start fresh" *(our addition)*.

### 6.5 Output composition (`packages/merge/compose.ts`)
```
function compose(doc):
  out = []
  for seg in doc.segments:
    if seg.type == 'stable': out.push(...seg.lines); continue
    s = seg.state
    if s.edited:       out.push(...s.edited)
    else if s.ai?.status == 'accepted': out.push(...split(s.ai.text))
    else if s.selected.length > 0:
         out.push(...s.selected.map(sel => sel.side=='a' ? seg.a[sel.line] : seg.b[sel.line]))
    else if not s.resolved:
         // placeholder region in the editor; when saving with unresolved chunks, emit markers:
         out.push('<<<<<<< ' + labelA, ...seg.a, '||||||| base', ...seg.base, '=======', ...seg.b, '>>>>>>> ' + labelB)
    // resolved + empty selection → nothing
  return out.join(doc.eol) + finalNewline
```
- The Output editor is a single Monaco model. Chunk regions are tracked with **decorations** (stickiness `AlwaysGrowsWhenTypingAtEdges`), so user edits inside a region update `edited` via `onDidChangeModelContent`. Edits that intersect a region boundary expand the region. When checkboxes change, we replace the decoration range's text with `pushEditOperations`, which keeps undo history (Ctrl+Z undoes a checkbox pick).
- Selection order: `selected` appends at the click (chunk checkbox appends all lines of that side in order). Unticking removes entries.

### 6.6 Whole-file and special resolutions
```bash
# Take A / Take B (respecting rebase labels already mapped)
git checkout --ours   -- <path> && git add -- <path>
git checkout --theirs -- <path> && git add -- <path>
# Take base
git show :1:<path> > <path> && git add -- <path>     # written by main via BlobReader, not a shell redirect
# keep file (DU/UD/AU/UA)
git add -- <path>
# delete file
git rm -- <path>          (use --cached if file absent on disk)
# submodule to chosen sha
git update-index --cacheinfo 160000,<sha>,<path>
# mode change
git update-index --chmod=+x -- <path>
# mark unresolved (re-create conflict)
git checkout -m -- <path>       # (git restore --merge)
```
- `git checkout --ours` fails for paths without that stage (DU). The UI never offers it there.
- Mark resolved for text files: `git add -- <path>`. For deleted resolutions: `git rm`.
- All of these go through the **OperationQueue** and record undo-journal entries (spec 05), so "Undo mark resolved" can run `git checkout -m`.

### 6.7 Abort / continue / skip
| Op | Abort | Continue | Skip |
|---|---|---|---|
| merge | `git merge --abort` | `git commit --no-edit` or with the composer message (`-F <msgfile>`; MERGE_MSG prefill; spec 06) | — |
| rebase | `git rebase --abort` | `git -c core.editor=true rebase --continue` (env `GIT_EDITOR=true`) or, if the user edited the message, commit first then continue | `git rebase --skip` |
| cherry-pick | `git cherry-pick --abort` | `git -c core.editor=true cherry-pick --continue` | `git cherry-pick --skip` |
| revert | `git revert --abort` | `git -c core.editor=true revert --continue` | `git revert --skip` |
| stash apply/pop | no native abort → "Reset conflicted changes": `git reset --merge` (confirm; the stash is kept because pop does not drop it on conflict) | resolve, then `git add` (or `git restore --staged` to leave changes unstaged); show "stash@{n} was kept, drop it?" → `git stash drop` | — |
| am | `git am --abort` | `git am --continue` | `git am --skip` |
- After **continue** in a rebase or multi-commit cherry-pick, the next step may conflict again. Re-read the state and reopen the banner with the new step number. The tool closes when `op` becomes null and shows the toast "Rebase complete".
- **Pre-abort guard:** if the user has unsaved output in the merge tool, warn first.
- Continue is enabled only when `git ls-files -u` is empty. Spec 06's commit button reads "Commit and Merge" / "Continue Rebase" / "Continue Cherry-pick".
- Running these with `GIT_EDITOR=true` avoids blocking on an editor. Hooks (pre-commit, commit-msg) still run, and failures surface their stderr (spec 06).

### 6.8 External merge tools
**Preference:** `mergeTool: 'none' | 'git-config' | KnownMergeTool`, plus an optional custom path, custom args template and `trustExitCode`.

**Strategy A (preferred): use git's mergetool machinery**, which already knows the arguments for most tools:
```bash
git -c mergetool.<tool>.path="<detected path>" mergetool --no-prompt --tool=<tool> -- <path>
# git-config default:
git mergetool --no-prompt -- <path>
```
git writes `<path>_LOCAL/_BASE/_REMOTE` temp files, runs the tool, checks the result, `git add`s on success, and keeps a `.orig` unless `mergetool.keepBackup=false`. Pass `-c mergetool.keepBackup=false` by default (preference). Built-in git tool names: `bc` (Beyond Compare), `kdiff3`, `meld`, `p4merge`, `opendiff` (FileMerge), `araxis`, `vscode`, `winmerge`, `tortoisemerge`, `smerge` (Sublime Merge), `vimdiff`, among others.

**Strategy B: custom command** for tools git lacks (Kaleidoscope, or user-defined). We write the stages to temp files ourselves and substitute variables:

| Tool | Template (`$LOCAL`=A, `$REMOTE`=B, `$BASE`, `$MERGED`=worktree path) |
|---|---|
| Beyond Compare | `bcomp "$LOCAL" "$REMOTE" "$BASE" -mergeoutput="$MERGED"` (Win: `BComp.exe … /mergeoutput="$MERGED"`) |
| Kaleidoscope | `ksdiff --merge --output "$MERGED" --base "$BASE" -- "$LOCAL" "$REMOTE"` |
| P4Merge | `p4merge "$BASE" "$LOCAL" "$REMOTE" "$MERGED"` |
| KDiff3 | `kdiff3 --auto "$BASE" "$LOCAL" "$REMOTE" -o "$MERGED" --L1 Base --L2 "<A label>" --L3 "<B label>"` |
| Meld | `meld "$LOCAL" "$BASE" "$REMOTE" --output "$MERGED"` (optionally `--auto-merge`) |
| VS Code | `code --wait --merge "$LOCAL" "$REMOTE" "$BASE" "$MERGED"` |
| Araxis | Win `Compare.exe /wait /merge /3 /a1 "$BASE" "$LOCAL" "$REMOTE" "$MERGED"`; mac `araxisgitmerge "$REMOTE" "$BASE" "$LOCAL" "$MERGED"` |
| FileMerge | `opendiff "$LOCAL" "$REMOTE" -ancestor "$BASE" -merge "$MERGED"` |
| WinMerge | `WinMergeU.exe -u -e -wl -wr -fm -dl "<A>" -dm Base -dr "<B>" "$LOCAL" "$BASE" "$REMOTE" -o "$MERGED"` |
| Custom | user template using the same variables |

- Spawn with arguments as an array (no shell), so there is no injection from paths. Wait for exit. Compare the `$MERGED` hash before and after. If `trustExitCode`, use the exit code. Otherwise, the result counts as resolved if the file changed and has no markers. Then prompt (or auto-run) `git add`.
- The ToolLocator (spec 07 §6.9) is shared and detects install paths per OS.
- Labels: pass A/B names (§6.2) where the tool supports titles.

### 6.9 Conflict prediction (dry run)
- **git ≥ 2.38:** `git merge-tree --write-tree --name-only --no-messages <ours> <theirs>`. Exit 1 means conflicts. The output is the tree oid followed by the conflicted paths. It touches neither the index nor the worktree.
- **Rebase or cherry-pick of N commits:** an exact prediction needs per-commit simulation. We approximate with a whole-branch merge-tree of `onto` vs the branch tip, labeled "may conflict". *(Exact: sequentially `git merge-tree --write-tree --merge-base=<c^> <acc> <c>` per commit, at most 50 commits, behind a preference.)*
- **Older git:** `supported: false`, and the badge is hidden.
- Results are cached by `(oursSha, theirsSha)` in an LRU of 256. The check is read-only and runs outside the op queue at low priority.

### 6.10 Post-op detection flow
1. A spec 05 op (merge, rebase, etc.) exits with a conflict code (merge: exit 1 with "CONFLICT" lines on stdout; rebase/cherry-pick: exit 1 or 128 plus the state files present).
2. GitService returns the spec 02 conflict outcome (`ok: false` with code `MergeConflict` / `RebaseConflict` / `CherryPickConflict` / `RevertConflict` / `StashConflict` and `details.files`). The renderer treats these codes as "completed with conflicts", not as a failure, and the toast reads "Merge produced conflicts in 3 files" with an "Open first conflict" action.
3. ConflictService reads the state (§6.1) and emits `conflict:stateChanged`. The graph (spec 04) shows the conflict row, the right panel shows the banner and file list, and the first conflicted file is auto-selected (preference: auto-open the merge tool).
4. The watcher catches state changes made outside the app (CLI merges) the same way.

---

## 7. Step-by-step implementation plan

1. **Types and IPC contract** (§5). Compile test.
2. **ConflictService.readState:** porcelain v2 `u` parsing, state-file detection for all ops (including worktree `--git-path`), and label resolution (§6.2). Test against the `conflict` fixture: generate merge, rebase, cherry-pick, revert, stash-pop and am conflicts by script, and assert codes and labels (especially the rebase swap).
3. **Marker parser and segmenter** (`packages/merge`): diff3-style output to `Segment[]`, marker-size detection, EOL handling, no final newline. Property test: `compose(all chunks take a)` equals `git merge-file --ours` output, and the same for b with `--theirs`.
4. **A/B line mapping** for chunk positions in the full side files. Unit tests with shifted stable regions.
5. **ChunkState model:** selection order, edited override, AI proposal, resolved flag, and `compose`. Unit tests, including undo via operations.
6. **Banner and conflict file list UI**, wired to abort/continue/skip (§6.7) through the op queue. e2e: a merge conflict appears in the list, abort restores the pre-merge HEAD and a clean tree.
7. **Whole-file quick resolutions** (Take A/B/base, keep/delete, mark resolved/unresolved). e2e per conflict code.
8. **MergeToolView layout:** three Monaco instances, labels, scroll sync, conflict decorations, side-pane checkbox gutters (glyph margin plus line decorations), chunk checkbox header widgets. Component tests.
9. **Output pane binding:** decorations-tracked regions, checkbox → edit operations, typing → edited state, reset chunk, placeholders. Tests with simulated edits.
10. **Navigation and keyboard** (next/previous unresolved, A/B/E keys, Ctrl+F, word wrap). Tests.
11. **Save / Save & mark resolved** with the marker check and auto-advance. e2e: resolve 2 files, then Continue completes the merge commit with MERGE_MSG.
12. **Rebase multi-step flow:** continue leads to the next conflict, the step counter updates, the completion toast shows. e2e on the fixture with 3 conflicting commits.
13. **Special conflict views** (DU/UD/AA/DD, binary, submodule, symlink, LFS, mode). Fixture-driven e2e per type.
14. **Auto-resolve trivial** rules plus undo. Unit tests per rule.
15. **External tools:** Strategy A (git mergetool with path override) and Strategy B templates, the waiting overlay, the post-exit check. Test with a fake tool script that writes a known resolution.
16. **AI resolve:** request builder, schema validation, proposals UI, privacy notice. Test with a mocked AIService (malformed JSON, low confidence).
17. **Conflict prediction:** merge-tree integration, caching, badges in spec 04/05 menus. Test: predicted files equal the actual conflicts on the fixture.
18. **Post-op detection flow** wiring (§6.10), including conflicts created by the external CLI and detected via the watcher. e2e: run `git merge` in the integrated terminal, and the UI updates within 1 s.

---

## 8. Edge cases

- **Rebase ours/theirs inversion:** handled by labels. "Take current" in rebase means the *onto* side, and the tooltip explains this. Test it explicitly.
- **Conflict markers inside the file's legitimate content** (for example, docs about git): use a bigger marker size (§6.4). The marker check on resolve is a warning only.
- **CRLF files:** the output must keep CRLF. Mixed EOL files keep each line's EOL from its source side *(best effort)*. `merge-file` handles bytes as is.
- **No trailing newline** on one side only: preserve it per chunk source and the final segment.
- **Huge conflicted files** (lock files, generated code): suggest Take A/B or regeneration. For `package-lock.json`, `yarn.lock` or `pnpm-lock.yaml`, show the hint "Lock files are best regenerated: take either side then run install" *(our addition)*.
- **Files deleted on disk by the user mid-resolution:** saving recreates the file. DU/UD views re-read state on focus.
- **User resolves via the CLI or editor while the tool is open:** a watcher event triggers a state refresh. If the file is no longer unmerged, close the tool with the notice "Resolved outside the app".
- **Autostash conflicts** (rebase/pull with `--autostash`): after the rebase completes, the autostash apply may conflict, which is a stash-apply-style state. Message: "Your autostashed changes conflicted; stash kept as stash@{0}".
- **Merge with `--no-commit`/`--squash`:** no conflicts, but the op is in progress (squash has no MERGE_HEAD, only `SQUASH_MSG`). Continue = commit.
- **Submodule conflicts with an uninitialized submodule:** only the SHAs can be chosen.
- **Rename/rename (1→2) and directory/file conflicts:** files like `path~HEAD` appear. Show both and let the user keep or delete each.
- **Case-only path conflicts** on case-insensitive FS: show a warning and recommend resolving via CLI *(rare)*.
- **Sparse checkout:** conflicted files outside the cone are still written to disk by git. Handle them normally.
- **Worktrees:** state files via `git rev-parse --git-path`, not `.git/`.
- **Index lock present** (another git process): ops fail with `index.lock`. Show "Another git process is running" with Retry (spec 02).
- **Signed commits on continue:** gpg prompts are handled by spec 06 signing (pinentry). A failure keeps the op in progress.
- **Hooks failing on continue** (pre-commit): show the hook output, and keep the state so the user can fix and continue again.
- **Binary file marked as text by attributes:** respect `-merge`/`binary` attributes and never show a text tool for them.
- **AI provider unavailable or timeout:** non-blocking error. Manual resolution is unaffected.

---

## 9. Acceptance criteria

- [ ] After a conflicting merge, rebase, cherry-pick, revert, stash pop or pull, the banner and conflicted file list appear within 1 s. Conflicts caused from the terminal are detected too.
- [ ] Panes are labeled with real branch or commit names. During a rebase, A is the onto branch and B is the commit being replayed.
- [ ] Clicking a UU file opens the 3-way tool with A, B and the Output. Conflict chunks are highlighted and navigable with buttons and keyboard.
- [ ] Chunk and line checkboxes compose the output in selection order. Unticking removes lines. Ctrl+Z undoes picks.
- [ ] Typing in the output marks a chunk "edited". Reset restores checkbox control.
- [ ] Save & mark resolved writes the file, runs `git add`, warns on remaining markers and advances to the next file.
- [ ] "Take current/incoming" from the file list resolves whole files correctly for merge and for rebase (swap-aware).
- [ ] DU/UD/AA/DD, binary, submodule and symlink conflicts each have a working dedicated resolution UI.
- [ ] Abort fully restores the pre-operation state (HEAD, index and worktree) for merge, rebase, cherry-pick and revert. Stash-pop "reset" keeps the stash.
- [ ] Continue completes a merge (commit with MERGE_MSG) and steps through a multi-commit rebase until done.
- [ ] Auto-resolve trivial resolves whitespace-only and identical chunks and can be undone.
- [ ] AI resolve inserts proposals with explanation and confidence. Nothing is applied without Accept, and malformed responses are rejected safely.
- [ ] External tools (at least Beyond Compare, KDiff3, Meld, P4Merge, VS Code and git-config default) launch with correct files. On exit, a resolved file can be marked resolved.
- [ ] Conflict prediction badges appear on drag-drop/merge menus on git ≥ 2.38 and match the actual conflicts on the fixture.
- [ ] CRLF and no-final-newline files round-trip without spurious changes.

---

## 10. Out of scope / later

- Team-based conflict prevention (detecting teammates' overlapping unpushed changes): spec 14.
- Semantic or structure-aware merge (AST merging, import-list union).
- `git rerere` UI (show reused resolutions, forget a resolution). We do honor rerere if enabled: git pre-resolves, and the tool shows "Resolved by rerere".
- Exact multi-commit rebase conflict prediction by default.
- License gating of the output editor.
- Merging notebook (`.ipynb`) cells or other structured formats.

---

## 11. Cross-spec dependencies

- **Per-hunk AI proposals (API defined in spec 12):** "Auto-resolve with AI" calls spec 12's `ai:run` with `feature: 'conflictResolve'` and `path`. Spec 12's ContextBuilder reads stages `:1:`/`:2:`/`:3:` and the marker file, assigns one `hunkId` per conflict `Segment` (`String(segment.id)`), and returns `ConflictProposal[]` (`hunkId`, `resolvedText`, `explanation`, `confidence`) through `ai:event`. This spec maps each proposal onto `ChunkState.ai` (`status: 'proposed'`) and owns the Accept/Reject UI (§4.7). Proposals containing conflict markers arrive downgraded to `low` (spec 12 §6.5). This spec never calls a provider directly and never stages a proposal automatically. Effort, privacy notice and the AI master switch come from spec 12/13 settings (`ai.*`).
- **Conflict prediction requires git ≥ 2.38:** §4.9 and §6.9 use `git merge-tree --write-tree`. Availability comes from spec 02 `GitExecutableInfo.features.mergeTreeWriteTree`. The bundled git is always ≥ 2.38 (00 "Git version policy"). With a user-selected system git 2.36–2.37, `conflict:predict` returns `supported: false` and every badge, menu hint and Create-PR conflict banner (spec 10 `pr:conflictCheck`) is hidden, never shown as an error.
- **Commit and continue buttons (spec 06 §11):** the banner's Continue/Commit hands off to spec 06's `CommitButton` ("Commit and Merge" / "Continue Rebase" / "Continue Cherry-pick" / "Continue Revert"). `conflict:continue` / `conflict:skip` / `conflict:abort` are `GitOperation` variants (`conflict.continue` etc.) run via `git:op:run`.
- **Undo of "Mark resolved" and whole-file resolutions (spec 05 §11):** `conflict:markResolved`, `conflict:take`, `conflict:resolveSpecial` and `conflict:saveFile { markResolved: true }` journal a `mark-resolved` entry before running `git add` / `git rm` / `git checkout --ours|--theirs`.
- **External merge tool settings (spec 13):** `tools.mergeTool`, `tools.customMergeCmd`, `tools.mergeToolTrustExitCode`, `tools.mergeToolKeepBackup` (default false, which becomes `-c mergetool.keepBackup=false`) and `tools.useExternalMergeToolByDefault`. Leftover `*.orig` files are cleaned per spec 05 §11 (`general.deleteOrigFiles`).
- **Spec 02 types:** `ConflictFileInfo` extends spec 02 `ConflictFile`. `InProgressOp` is derived from `RepoState`. Stage blobs come from spec 02 `BlobReader`. Conflict outcomes use the spec 02 conflict error codes (§6.10).
