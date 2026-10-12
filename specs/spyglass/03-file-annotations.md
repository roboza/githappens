# S03 — File Annotations: Blame Gutter, Heatmap and Changes

> Spyglass spec. Depends on S01 (git facade, `spyglass:` URIs, caches) and S02 (`BlameService`, hover builder, format tokens). Reuses spec 07 §4.10 (blame block semantics, author colors, optional age heatmap) and spec 02 §6.9 (diff parsing).

## 1. Purpose

Whole-file views of history, toggled per editor:

- **File blame**: a gutter column on every line block with author, date and message, colored by age or author.
- **Heatmap**: a thin bar per line colored by how recently the line changed (hot = recent, cold = old).
- **File changes**: markers for lines changed by the working tree (or by a chosen commit) compared with a base, with hover diffs.

Also: **revision navigation** — step a file back and forth through the commits that changed it, keeping the annotation mode.

## 2. Reference behavior

- Three annotation modes, toggled from the editor title bar, the command palette or a keybinding: whole-file blame, file changes, and an age heatmap. Only one mode is active per editor at a time. Toggling can apply to the current file only or to every file in the window (a setting).
- **Blame** puts a block before each line: author, relative date, message subject (format customizable), a small avatar, and a left border colored by age (heatmap-like) or a separator between commit blocks. Lines of the same commit as the cursor line are highlighted. The overview ruler marks the lines of the current commit.
- **Heatmap** adds a colored bar in the gutter area (left or right of line numbers). Recent changes are "hot" (warm colors), older ones fade to "cold"; the cutoff age is configurable, and the bar can also be shown alongside blame.
- **Changes** marks lines added/changed since a base (the previous commit for a historical revision, or uncommitted changes for the working file) with gutter markers and overview-ruler marks; hovering shows the diff.
- **Revision navigation** commands open the previous/next revision of the current file, keeping the same annotations, and show the commit in the title. Diff editors get the same navigation (step the comparison back).
- File annotations are free features.

## 3. User stories

1. As a developer, I want to blame the whole file to see which parts are old and stable versus new.
2. As a reviewer, I want a heatmap to spot recently churned code at a glance.
3. As a developer, I want to see which lines I've changed without opening the SCM diff.
4. As a developer investigating a bug, I want to step back through a file's revisions with blame still on.
5. As a user, I want one keystroke to toggle annotations on and off.

## 4. UI specification

### 4.1 Toggling

- Editor title button `spyglass.toggleFileBlame` (icon `$(person)` *(our icon choice)*) with a dropdown (submenu `spyglass/editor/annotations`): Blame, Heatmap, Changes, Clear.
- Commands: `spyglass.toggleFileBlame`, `spyglass.toggleFileHeatmap`, `spyglass.toggleFileChanges`, `spyglass.toggleFileChangesSince` (pick a commit/branch), `spyglass.clearFileAnnotations`. Default keybinding: `alt+b` toggles blame when `editorTextFocus && spyglass:isTracked` *(our choice; reference uses a different chord)*.
- Escape clears annotations when `spyglass:annotationStatus == 'computed'` and `spyglass.fileAnnotations.dismissOnEscape` (default `true`).
- `spyglass.fileAnnotations.toggleMode` = `file` (default: per editor) | `window` (every visible and future editor until toggled off).
- Context key `spyglass:annotationStatus` = `computing` | `computed` | `` drives a spinning title icon while computing.

### 4.2 Blame mode

- Gutter: one `before` decoration per line, fixed width `spyglass.blame.gutterWidth` chars (default 32). First line of each commit block shows `spyglass.blame.format` (default `${message|20} ${agoOrDate|11}`; tokens from S02 §4.2); following lines show nothing but keep the width (render ` ` padding).
- Optional avatar (`spyglass.blame.avatars`, default `true`): gutter icon via a per-author `TextEditorDecorationType` with `gutterIconPath` (data URI of the avatar or initials SVG). Limited to 50 distinct authors per file; beyond that initials only.
- Color: left border of the gutter block via `before.border` — `spyglass.blame.colorBy` = `age` (default; heat scale §4.3) | `author` (palette by `hash(email)`, spec 07 §4.10) | `none`.
- Commit-block separators: `spyglass.blame.separateBlocks` (default `true`) draws a top border on the first line of each block (theme color `spyglass.blameBlockSeparator`).
- Highlight of the current commit: when the cursor moves, every line from the same commit gets background `spyglass.blameHighlight` and overview ruler mark (`OverviewRulerLane.Center`) — `spyglass.blame.highlight.locations` = subset of `gutter` | `line` | `overview` (default all).
- Uncommitted lines: "Uncommitted" in italic.
- Hover on the gutter: S02 details/changes hover (`spyglass.hovers.annotations.over` = `annotation` | `line`).
- `spyglass.blame.compact` (default `true`): the first line of a block shows text; the second line of a block (if any) shows the author name; rest empty.

### 4.3 Heatmap mode

- One decoration type per heat bucket (10 hot + 10 cold buckets = 20 types, created lazily) applying a 2 px `border-left` (or `border-right`) at line start (`before` content with width 0 and border), `spyglass.heatmap.location` = `left` (default) | `right` *(right = after line numbers via `before` margin trick; inferred-feasible)*.
- Age → bucket: commits newer than `spyglass.heatmap.ageThresholdDays` (default 90) are hot; bucket index by log-scaled age relative to the newest and the threshold. Colors interpolate between `spyglass.heatmap.hotColor` (default `#f66a0a`) and `spyglass.heatmap.coldColor` (default `#0a60f6`) with opacity by recency.
- `spyglass.heatmap.fadeLines` (default `true`): old lines get reduced text opacity (`opacity` style via `textDecoration: 'none; opacity: 0.6'` trick) — only if `spyglass.heatmap.fadeLinesOpacity` > 0 *(our extension; uses the known `textDecoration` CSS-injection pattern, which VS Code tolerates but does not document — keep behind setting)*.
- `spyglass.heatmap.withBlame` (default `false`): show the bar while blame mode is on.
- Legend: hovering the bar shows "Changed 3 days ago (hot)" plus the S02 details hover.

### 4.4 Changes mode

- Base selection: working-file editors compare with `HEAD` by default (`spyglass.changes.base` = `head` | `index` | `upstream` | `mergeBase`) ; historical revisions (`spyglass:` URIs) compare with the commit's first parent.
- Markers: `gutterIconPath` SVGs (added = bar, modified = bar, deleted = triangle) using theme colors `spyglass.changesAdded`, `spyglass.changesModified`, `spyglass.changesDeleted`; overview ruler marks in the left lane; optional line background (`spyglass.changes.highlightLines`, default `false`).
- Hover over a marker: the hunk diff (S02 changes-hover builder, hunk scope) plus actions: Open Changes, Stage Hunk / Revert Hunk (only for working-file vs HEAD/index; delegates to built-in `git.stageSelectedRanges` / `git.revertSelectedRanges` by selecting the hunk range).
- "Changes since…" (`spyglass.toggleFileChangesSince`): pick any ref/commit from a quick pick (branches, tags, recent commits of the file); the title shows "Changes since `main`".
- Not a QuickDiff provider: the built-in Git extension already provides SCM quick diff; Spyglass's changes mode is a temporary overlay *(our decision; see §10)*.

### 4.5 Revision navigation

- Editor title buttons (shown when `spyglass:isTracked`): `spyglass.openPreviousRevision` (`$(arrow-left)`), `spyglass.openNextRevision` (`$(arrow-right)`, enabled only on historical revisions, context `spyglass:hasNextRevision`), `spyglass.openWorkingFile` (return).
- Opens `spyglass:` URIs (S01 §6.3) with a title `file.ts (abc1234)` via a `ResourceLabelFormatter` contribution for the `spyglass` scheme (`label: "${path} (${query.rev})"` *(manifest label template)*).
- The active annotation mode is re-applied on the new revision (blame at that revision: `git blame <sha> -- <pathAtSha>`).
- Diff editors (`vscode.diff` between two `spyglass:`/file URIs): `spyglass.diffWithPrevious` / `spyglass.diffWithNext` step both sides.
- Path at revision follows renames using the file-history mapping (spec 07 §6.7 `--follow --name-status`).

## 5. Data model & contracts

```ts
export type AnnotationMode = 'blame' | 'heatmap' | 'changes';

export interface AnnotationState {
  editorKey: string;                    // document uri + viewColumn
  mode: AnnotationMode;
  status: 'computing' | 'computed' | 'error';
  rev: Sha | 'worktree';
  changesBase?: string;                 // for 'changes'
  disposables: vscode.Disposable[];
}

export interface HeatBucket { index: number; hot: boolean; color: string; decoration: vscode.TextEditorDecorationType; }

export interface ChangeMarker {          // derived from spec 02 DiffHunk
  kind: 'added' | 'modified' | 'deleted';
  startLine: number; endLine: number;   // 0-based, inclusive (deleted: the line after the deletion)
  hunk: DiffHunk;
}
```

## 6. Implementation details

### 6.1 Rendering strategy

- Decorations are computed for the **whole file** once (blame is whole-file anyway) but applied in **one `setDecorations` call per decoration type**. With 10k lines that is fine for VS Code (decorations are virtualized by the renderer).
- Per-line `before.contentText` is unique per block, so blame uses `DecorationOptions[]` with `renderOptions` per range on a single base type (width, color, margin set on the base type; text set per range). This avoids one decoration type per commit.
- Avatars are the exception: gutter icons must be set on the type, so one type per author (capped §4.2).
- Recompute on: document save, repo `refs`/`status` change, setting change in `spyglass.blame.*`/`heatmap.*`/`changes.*`. During editing (dirty doc), the S02 §6.2 shifting logic updates line ranges; after idle the real `--contents -` blame refreshes.

### 6.2 Git commands

| Mode | Command |
|---|---|
| Blame (working tree) | `git blame --incremental [-w] [-M] [-C] [--contents -] -- <path>` (shared with S02 cache) |
| Blame (revision) | `git blame --incremental [-w] <sha> -- <pathAtSha>` |
| Heatmap | same blame data; only `author-time` per line used |
| Changes (working vs HEAD) | `git diff --no-color --no-ext-diff -U0 HEAD -- <path>` (spec 02 §6.9 parser, `-U0` for exact markers); with `--contents`-like dirty support: diff of buffer vs `git show HEAD:<path>` computed in-process with a Myers diff (`diff` npm package) to reflect unsaved edits |
| Changes since ref | `git diff -U0 <ref> -- <path>` (or in-process for dirty buffers against `BlobReader` content of `<ref>:<path>`) |
| Revision list for navigation | `git log --follow --format=%H%x00%P -z --name-status -- <path>` (spec 07 §6.7, cached `FileHistoryPage`) |

### 6.3 Large files

- Above `spyglass.blame.maxLines` (default 20,000): toggling shows "This file has N lines. Annotate anyway?" (modal-less notification with button).
- Incremental rendering: for files > 2,000 lines, apply decorations for the visible range first (from `--incremental` progress), then the rest.

## 7. Step-by-step implementation plan

1. `AnnotationController` per editor (state machine, context keys, toggle commands, Escape).
2. Blame gutter: base decoration type, per-block render options, separators, compact mode. Integration test: decorations on a fixture file equal expected text per line (exposed via debug command).
3. Current-commit highlighting on cursor move.
4. Heatmap buckets + color interpolation (unit tests for age → bucket), heatmap rendering.
5. Avatars in gutter (per-author types, cap).
6. Changes mode: diff parsing → markers; dirty buffer in-process diff; hover with actions.
7. Revision navigation commands, `ResourceLabelFormatter`, rename-aware path mapping; diff navigation.
8. Window toggle mode and setting-change reapply.

## 8. Edge cases

- **Untracked file**: blame/heatmap unavailable (toggle disabled via `spyglass:isTracked`); changes mode shows all lines as added.
- **Deleted file at revision**: previous-revision navigation stops at the commit that added it; next-revision past a delete opens nothing and shows "File deleted in `abc1234`".
- **Binary / LFS / too large**: annotations disabled with explanation.
- **Diff editors**: annotations apply to the modified (right) side only; left side supports blame when it is a `spyglass:` revision.
- **Word wrap**: gutter text only on the first visual line; heat bar spans wrapped lines (`isWholeLine: true`).
- **Theme changes**: colors are `ThemeColor`s, so they update automatically; avatar initials SVGs are regenerated.
- **Two editors on the same document**: each editor has its own mode (`editorKey` includes the view column).
- **Folding / sticky scroll**: decorations follow VS Code's model; nothing special.

## 9. Acceptance criteria

- [ ] Blame mode on a 10k-line file computes ≤ 700 ms and shows visible range ≤ 300 ms.
- [ ] Heatmap colors are monotonic with age; the threshold setting moves the hot/cold split.
- [ ] Changes mode matches `git diff -U0` for saved files and reflects unsaved edits.
- [ ] Previous/next revision preserves the annotation mode and follows renames.
- [ ] Clear/Escape removes every decoration type created by the controller (no leaks: decoration count returns to baseline in a test).

## 10. Out of scope / later

- A Spyglass `QuickDiffProvider` (SCM gutter) — the built-in Git extension already provides one; adding a second source creates duplicate gutters. Revisit only for "changes since branch base" as a permanent quick-diff (VS Code supports multiple quick-diff providers with a picker *(inferred; verify current API)*).
- Notebook annotations.
- Author statistics overlay per block (lines owned %); see S05 contributors.

## 11. Cross-spec dependencies

- **S02** `BlameService`, hover builders, format tokens, autolinks.
- **Spec 07 §4.10** block/author color semantics; heatmap is "our addition" there and a reference feature here — both use the same age-bucket function from `packages/ui-kit` (or a small shared module in `packages/git`) so desktop and Spyglass look alike.
- **S04** file history provides the revision list; **S11** settings, colors, commands, context keys.
