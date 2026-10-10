# 07 — Diff Viewer, Commit Detail & File Views

> Depends on: 00, 01 (panels, shortcuts), 02 (GitService, IPC), 04 (selection → what to show), 06 (staging actions inside diffs of WIP files). Feeds: 08 (merge tool reuses the Monaco diff infrastructure), 12 (AI explain), 13 (diff preferences).
> Code: `apps/desktop/src/renderer/views/diff`, `views/commit-detail`, `views/file-history`; parsers in `packages/git/src/diff`.

---

## 1. Purpose

Once a user selects something in the graph, they want to know what changed. This spec covers:
- the **commit detail panel** (metadata plus the list of changed files),
- the **diff viewer** for any file in any context (commit, comparison, WIP, stash),
- **file history** and **blame**,
- the **in-app editor**, for quick edits to working-tree files,
- hand-off to **external diff tools and editors**,
- **file search**.

The panels have to be fast, readable (syntax highlighting, word-level highlights), and safe with huge or binary files.

---

## 2. Reference behavior

Sources: desktop Git client help ("Diff", "Interface", "Keyboard shortcuts", "Tips"), release notes, and product knowledge. *(inferred)* marks behavior that isn't documented.

### 2.1 Opening diffs
- Clicking a commit opens the **Commit Panel** on the right. It shows the commit message, author and committer, SHA, parent SHAs and the changed files. Clicking a file opens its diff in the center area, which temporarily replaces the graph. A close (×) button or Esc returns to the graph.
- Clicking a file under the WIP node (staged or unstaged) shows the working-tree diff, with stage/unstage/discard hunk and line actions (spec 06).
- **Shift-click** two commits to compare them. Shift- or Ctrl-clicking a consecutive range gives the **combined changes**. If the range reaches the top, WIP is included. Selecting more than two non-consecutive items doesn't produce a diff, and the app explains why.
- **Compare against working directory:** Ctrl/⌘-click a commit and the WIP node, or right-click › "Compare commit against working directory".
- **Ctrl/⌘+D** opens the diff (or the merge tool) for the selected file.

### 2.2 Diff viewer
- **View modes** (toggle at the top right): **Hunk** (only changed blocks with context, each with actions), **Inline** (the whole file with changes inline), and **Split** (old on the left, new on the right).
- Word-level highlighting, syntax highlighting, a minimap (file overview), and up/down arrows to jump between change sets. Removed lines are red and added lines are green.
- **Word wrap toggle** (v11.9).
- In Hunk view on a commit diff, each hunk has **Revert hunk**, which applies the inverse to the working directory as unstaged changes (v11.2). For WIP, each hunk has **Discard hunk** instead (v11.7).
- **"Edit in working directory"** opens the in-app editor for that file.
- **File History** and **File Blame** buttons sit at the top right of a file diff. They're also available from the file's context menu in the commit panel.
- A **Diff View / File View** toggle switches between the changes and the full file. File view can show blame.
- Whitespace options *(inferred: an "ignore whitespace" setting in preferences)*.
- Image files show old and new images side by side *(inferred)*. Binary files show a "binary file" notice.
- LFS files show the pointer or the resolved content when LFS is set up *(inferred)*.

### 2.3 Commit panel
- Shows the summary, the body, author avatar and name, "authored/committed" dates, the SHA (copyable), and parent SHAs (clickable, which selects the parent in the graph).
- Files show as a **Path view** (flat list with directories) or a **Tree view** (folder hierarchy), switched by a toggle. A **"View all files"** checkbox shows every file in the commit's tree, not just the changed ones.
- Each file shows a status icon: added, modified, deleted, renamed (old → new). Hovering shows the path, and right-click opens a context menu.
- File context menu: Open file (in-app), Open in external editor, Show in folder (file explorer), Copy file path, File history, File blame, Open in external diff tool, Revert/Checkout file at this commit, Create patch from file, Ignore (WIP only), Stage/Unstage/Discard (WIP).

### 2.4 External tools
- Preferences › External Tools: **Diff tool** (Beyond Compare, FileMerge, Kaleidoscope, KDiff3, Araxis, P4Merge, or "Git config default" for anything else, such as Meld via `diff.tool`), **Merge tool** (spec 08), **External editor** (VS Code, Sublime, Atom, IntelliJ family, etc.), and Terminal.
- If a supported tool is missing from the list, its command-line tools need to be installed.

### 2.5 File history and blame
- **File History:** a list of the commits that touched the file (follows renames), with the diff of the selected commit on the right. Each entry shows the author, date and message.
- **File Blame:** the full file with per-line or per-hunk author and date annotations, color-coded by author.
- **Ctrl/⌘+Shift+H:** search for a file by name, then open its history or blame.
- **Ctrl/⌘+F** inside a file view searches the file.

### 2.6 In-app editor
- A built-in editor (Monaco-based *(inferred)*) to edit working-tree files with syntax highlighting, search and save. You can create new files from the WIP panel *(inferred)*.

---

## 3. User stories

1. As a developer, I want to click a commit and see its message, metadata and changed files immediately.
2. As a reviewer, I want hunk, inline and split views with word-level highlights, so that I can read changes in whichever layout suits me.
3. As a developer, I want to ignore whitespace-only changes when reviewing reformatted code.
4. As a developer, I want to compare any two commits, or a commit against my working directory.
5. As a designer, I want to see before/after for changed images.
6. As a developer, I want to see the full history of a file across renames, and who last touched each line.
7. As a developer, I want to quickly fix a typo in a file without leaving the app.
8. As a power user, I want to open any diff in Beyond Compare or my configured `difftool`.
9. As a user on a huge repo, I don't want the app to freeze when a commit touches a 200 MB file or 30,000 files.

---

## 4. UI specification

### 4.1 Component tree

```
<RightPanel>
└─ <CommitDetailPanel target: DiffTarget>          // single commit | comparison | stash | WIP (WIP → spec 06 StagingPanel)
   ├─ <CommitHeader>                               // summary (selectable), sha chip [copy], parents chips, "Explain" (AI, spec 12)
   │   ├─ <PersonLine role="author"/>              // avatar, name <email>, relative date (tooltip absolute)
   │   ├─ <PersonLine role="committer"/>           // only if differs from author
   │   ├─ <SignatureBadge/>                        // lazy, spec 06
   │   └─ <CommitBody/>                            // markdown-ish, links for #123 / issue keys (spec 10)
   ├─ <FileListToolbar>                            // Path|Tree toggle, "View all files" checkbox, filter box, sort, counts (+a −d ~m)
   └─ <FileList virtualized>                       // rows: status icon, path (dir muted), +/− counts, hover actions
<CenterArea>
└─ <DiffView fileTarget>                           // replaces graph while open; breadcrumb "Graph › abc123 › src/a.ts"
   ├─ <DiffToolbar>
   │   ├─ mode: Hunk | Inline | Split   [Ctrl+Alt+1/2/3 (ours)]
   │   ├─ Diff View | File View toggle
   │   ├─ whitespace: Show | Ignore changes at EOL | Ignore amount | Ignore all  (dropdown)
   │   ├─ word wrap toggle · prev/next change (↑/↓, F7/Shift+F7) · change counter "3/11"
   │   ├─ History · Blame · Edit in working directory · Open in external diff tool · Open file ▸
   │   └─ Close (Esc)
   ├─ <DiffBanner/>                                // rename "a → b (93% similar)", mode change, submodule, LFS, large-file warnings
   └─ one of:
       ├─ <HunkDiff/>           (Monaco DiffEditor with hideUnchangedRegions + hunk action zones, OR custom virtualized list — §6.4)
       ├─ <InlineDiff/>         (Monaco DiffEditor renderSideBySide=false)
       ├─ <SplitDiff/>          (Monaco DiffEditor renderSideBySide=true)
       ├─ <FileView/>           (Monaco Editor read-only, optional <BlameGutter/>)
       ├─ <ImageDiff/>          (side-by-side | swipe | onion skin | difference)
       ├─ <BinaryDiff/>         (size before/after, "open externally")
       ├─ <SubmoduleDiff/>      (old → new sha, commit list)
       └─ <LargeFileGuard/>     ("Load anyway")
<FileHistoryView path rev>                          // center area
   ├─ <HistoryList virtualized/>                    // commit rows: avatar, summary, author, date, rename marker
   └─ <DiffView/> for selected entry (path at that commit)
<BlameView path rev>                                // center area: <FileView> + <BlameGutter> + <BlameHoverCard>
<FileEditorView path>                               // center area: Monaco editor, dirty dot, Save/Revert, "Back to diff"
<FileSearchPalette/>                                // Ctrl/⌘+Shift+H, fuzzy file finder → History | Blame | Open
```

### 4.2 Commit detail panel
- **Header:** the summary in 15px semibold, the body below it (monospace optional, preference). Long bodies collapse after 12 lines with "Show more".
- **Metadata grid:** Author (avatar, name, email on hover, "authored 3 days ago"), Committer (only when the name, email or time differs), Date. SHA in monospace with a copy button. Parents: one chip per parent with a short SHA. Click selects that row in the graph (spec 04 jump), and Shift+click compares against that parent. Merge commits show "Merge: 2 parents" and a **parent selector** for the file list ("Changes vs parent 1 (default) | parent 2 | combined (`--cc`)").
- **File list toolbar:** the Path/Tree toggle is persisted globally. "View all files" is a checkbox. The filter textbox does a substring match on paths. Counts show added, deleted, modified and renamed.
- **File rows:** a status letter or icon (`A` green, `M` amber, `D` red, `R` blue with "old → new", `C` copy, `T` type change, `U` unmerged), the path with the basename emphasized, numstat `+12 −3` when available, and hover actions (Open, History, Blame, External diff).
- **Tree view:** folders are collapsible. Single-child chains compact to `src/a/b`. Folder rows show aggregated counts.
- **Keyboard:** ↑/↓ moves through files with the diff updating (300 ms debounce while holding a key). Enter opens the diff. Esc returns to the graph.
- **States:** loading shows a skeleton. A commit with more than 5,000 changed files shows "Showing first 5,000 of 31,204 files · Show all" (the virtualized list can render them, but numstat is skipped above 5,000). An error shows a card.

### 4.3 Diff modes
- **Hunk:** shows only changed regions with N context lines (default 3, configurable from 0 to 25). Separators between hunks have "⋯ Expand 20 lines ↑↓" controls. Each hunk header shows `@@ -a,b +c,d @@ function context` and actions:
  - commit/stash/compare diffs: **Revert hunk** (→ working tree, unstaged).
  - WIP unstaged: **Stage hunk**, **Discard hunk**, plus line selection → Stage lines / Discard lines (spec 06).
  - WIP staged: **Unstage hunk**, Unstage lines.
- **Inline:** the whole new file, with deleted lines shown as view zones in red above the insertion point. Word-level changes are highlighted.
- **Split:** two synchronized editors (old | new), with connector shading in the gutter. Line numbers appear on both sides.
- **File View:** the full file at that revision (new side; old side for deleted files). Toggling Blame adds a blame gutter.
- **Toggling** keeps the scroll position mapped to the same logical line where possible. The mode is a global preference (`diff.defaultView`, spec 13, default Hunk), and the last-used mode is remembered.
- **Navigation:** next/previous change (↓/↑ buttons, F7/Shift+F7, `Alt+↓/↑`). The counter shows `3/11`. When the last change is reached, "next" moves to the next file in the commit's file list *(our addition)*.

### 4.4 Word-level highlights
- Monaco's diff computer (the `advanced` algorithm) produces inner-line char changes. We render them with stronger background tokens (`--diff-insert-word`, `--diff-delete-word`). For hunk mode with a custom renderer, we compute word diffs per hunk pair (§6.5).

### 4.5 Whitespace options
| Option | Git flag | Monaco option |
|---|---|---|
| Show all (default) | — | `ignoreTrimWhitespace: false` |
| Ignore changes at EOL | `--ignore-space-at-eol` | `ignoreTrimWhitespace: true` (approximation) |
| Ignore amount of whitespace | `-b` | custom: normalize runs before diff |
| Ignore all whitespace | `-w` | custom: strip whitespace before diff |
| Ignore blank lines | `--ignore-blank-lines` | custom |
- The option is per-session in the diff toolbar, and the default comes from Preferences. When any ignore option is active, hunk staging actions are **disabled**, with the tooltip "Disable whitespace filtering to stage hunks", because patches built from a whitespace-ignoring diff won't apply.

### 4.6 Image diff
- Detection: by extension (png, jpg, jpeg, gif, webp, bmp, ico, svg, avif) or by sniffing magic bytes.
- **Side-by-side (default)** *(inferred)*: old | new, with dimensions and file sizes under each, on a checkerboard background for transparency.
- **Swipe**, **Onion skin** (opacity slider) and **Difference** (canvas pixel diff) are **our additions**, behind a segmented control.
- Added images show only the new side, deleted images only the old.
- SVG gets a toggle between rendered image and text diff.
- Size cap: images over 50 MB are not rendered (binary card shown instead).

### 4.7 Binary, LFS, submodule, mode and rename banners
- **Binary:** "Binary file changed · 12.4 KB → 13.1 KB", with Open old / Open new (temp file in the OS default app) and Open in external diff tool.
- **LFS pointer:** if both blobs are LFS pointers, the banner reads "Git LFS file · oid a1b2…→c3d4… · 4.2 MB → 4.3 MB". When the objects are available locally (`.git/lfs/objects/…`), show the real content diff (image or text). Otherwise offer "Fetch LFS object" (spec 09) and a "Show pointer diff" toggle.
- **Submodule:** "Submodule `libs/foo` updated a1b2c3d → e4f5a6b (+12 commits)". If the submodule is initialized, list `git -C libs/foo log --oneline a..b` (max 100), with "Open submodule" (spec 03/09). Also handle the case where it moved backwards ("rewound 3 commits").
- **Mode change:** "File mode changed 100644 → 100755". If there's no content change, show only the banner.
- **Rename/copy:** "Renamed from `old/path.ts` (similarity 87%)". The diff is computed against the old path's content.
- **Type change:** "Changed from symlink to file" (`T`). A symlink diff shows the target path text.

### 4.8 Commit comparison
- With two selected commits A (older by row) and B, the panel header reads "Comparing `A` ↔ `B`" with a swap button. The file list is `git diff A B`. Each diff is between A:path and B:path.
- Contiguous range: the header reads "N commits combined (`oldest^` → `newest`)".
- Commit vs working directory: "Comparing `A` ↔ Working directory". File diffs compare A:path with the file on disk, and Revert/Edit actions are allowed on the right side.
- Branch compare (from the ref menu "Compare `X` with `B`"): the same view, with an extra toggle **Two-dot vs Three-dot** (`A..B` vs merge-base `A...B`). The default is three-dot, meaning "what B has that A doesn't".

### 4.9 File history view
- Opened from the toolbar History button, the file context menu, or the file search palette. A breadcrumb shows "History: `src/app.ts`".
- **Left:** a virtualized list of commits touching the path, newest first. Each row has an avatar, summary, author, relative date and short SHA. Rows where the file was renamed show a "renamed from `x`" marker. A toggle sets "Follow renames" (default on). Filtering by author or message is client-side.
- **Right:** the DiffView for that commit's change to the file (all modes available). It can be switched to File View, which shows the full file at that revision, with blame optional.
- **Actions per entry:** Select in graph, Checkout file at this revision, Open file at revision, Copy SHA, Compare with working copy.
- Lazy loading: 200 entries at a time.

### 4.10 Blame view
- A full file (Monaco read-only) with a left gutter 220px wide. Consecutive lines from the same commit form a **block**. The first line of a block shows the avatar, author (truncated) and relative date. Later lines show a thin color bar. The color per author is derived from `hash(email)` into the palette. An optional age heatmap (newer = brighter) is our addition.
- Hover card: full summary, SHA, author, date, and the actions "Show commit", "Blame prior revision" (`<sha>^`), "Show diff" and "Copy SHA".
- Blame can be opened at any revision (`rev`) or on the working copy (uncommitted lines show as "You · Uncommitted").
- Options: ignore whitespace (`-w`), detect moves/copies (`-M`, `-C`), and respect `blame.ignoreRevsFile` (honored automatically by git; show a note "Ignoring revisions from .git-blame-ignore-revs").

### 4.11 In-app editor
- Opened by "Edit in working directory", by "Open file" on a WIP file, or with Ctrl/⌘+E on a WIP diff *(our shortcut)*.
- A Monaco editor on the working-tree file. The file's language is detected from its extension. EOL is preserved (CRLF/LF detected on load), as are encoding (UTF-8 with or without BOM, UTF-16LE/BE via BOM, other encodings read-only with a notice) and the final newline.
- The toolbar shows Save (Ctrl/⌘+S), Revert (reload from disk), Close, a dirty indicator, the line ending selector and the encoding label. There is no autosave by default.
- On save: the file is written atomically (temp file + rename, preserving mode). The watcher refreshes WIP (spec 06). If the file changed on disk since load (mtime or hash check), show a conflict prompt: "Overwrite" / "Reload" / "Compare".
- Closing with unsaved changes prompts Save / Discard / Cancel.
- "New file…" from the WIP panel creates an empty file at a chosen path and opens the editor.
- Files read-only in this context (commits, stashes) open the editor in read-only mode with a banner: "Viewing `abc123` — Edit working copy".

### 4.12 External editor / diff tool
- "Open in external editor" runs the command from Preferences (`{editor} "{path}"` with optional `:{line}` templates per known editor: `code -g path:line`, `subl path:line`, `idea --line N path`). If none is configured, use `shell.openPath`.
- "Open in external diff tool" is described in §6.9.
- "Show in folder" uses `shell.showItemInFolder`.

### 4.13 File search palette (Ctrl/⌘+Shift+H)
- A modal fuzzy finder (fzf-style scoring, matching basename first) over the set of paths in HEAD plus the working tree (including untracked, not ignored). The results list is virtualized. Each result has the actions History (Enter), Blame (Ctrl+Enter) and Open (Alt+Enter).
- An "Include deleted files" toggle searches all paths ever in history. This is expensive: `git log --all --format= --name-only --diff-filter=D | sort -u`, run lazily with a spinner.

### 4.14 Large-file and huge-diff safeguards
| Condition | Behavior |
|---|---|
| Blob > 1 MB or > 20,000 lines | `LargeFileGuard`: "This file is large (3.2 MB). Diff may be slow." [Load diff] [Open externally]. Remembered per session. |
| Blob > 50 MB | Never loaded into Monaco. Binary-style card with sizes + external tool. |
| Line > 10,000 chars (minified) | Monaco `maxTokenizationLineLength = 20000`, word diff disabled for that line, warn "Long lines — syntax highlighting limited". |
| Diff computation > 2 s | Monaco `maxComputationTime: 2000`. If it times out, the banner reads "Diff too complex — showing simplified line diff" (uses the git hunks). |
| Commit with > 5,000 files | No numstat. List virtualized. Tree view built lazily. |
| Binary detection | `git diff --numstat` reports `-\t-`, or a NUL in the first 8,000 bytes (git's heuristic), or `.gitattributes` `binary`/`-diff`. |

### 4.15 Shortcuts (diff context)
| Action | Win/Linux | macOS |
|---|---|---|
| Open diff / merge tool for selected file | Ctrl+D | ⌘D |
| Close diff | Esc | Esc |
| Next/prev change | F7 / Shift+F7, Alt+↓/↑ | same |
| Next/prev file | Ctrl+↓ / Ctrl+↑ *(ours)* | ⌘↓/⌘↑ |
| Hunk / Inline / Split | Ctrl+Alt+1/2/3 *(ours)* | ⌘⌥1/2/3 |
| Toggle word wrap | Alt+Z | ⌥Z |
| Find in file | Ctrl+F | ⌘F |
| File search → history/blame | Ctrl+Shift+H | ⌘⇧H |
| Save (editor) | Ctrl+S | ⌘S |

---

## 5. Data model & IPC

```ts
export type Rev = string;                         // sha, ref, or special
export const WORKTREE = ':worktree' as const;     // file on disk
export const INDEX = ':index' as const;           // staged blob (:0:path)

export type DiffTarget =
  | { kind: 'commit'; sha: Sha; parentIndex?: number | 'combined' }   // default parent 0
  | { kind: 'compare'; from: Rev; to: Rev | typeof WORKTREE; mode: 'two-dot' | 'three-dot' }
  | { kind: 'range'; oldest: Sha; newest: Sha; includeWip: boolean }
  | { kind: 'stash'; index: number; sha: Sha }
  | { kind: 'wip'; area: 'unstaged' | 'staged' };                       // spec 06

export type FileStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | 'X';
export interface ChangedFile {
  path: string;                 // new path
  oldPath?: string;             // for R/C
  status: FileStatus;
  similarity?: number;          // 0-100 for R/C
  oldMode?: string; newMode?: string;
  oldOid?: string; newOid?: string;
  additions?: number; deletions?: number;   // undefined when binary or numstat skipped
  binary?: boolean;
  submodule?: boolean;          // mode 160000
}
export interface CommitDetail {
  sha: Sha; parents: Sha[]; tree: string;
  author: Person; committer: Person;          // Person { name, email, time, tz }
  subject: string; body: string; trailers: Record<string, string[]>;
  refs: string[];
}
export interface FileListResult { files: ChangedFile[]; truncated: boolean; totalCount: number; }

export interface FileContentRequest { repoId: string; rev: Rev; path: string; maxBytes: number; }
export interface FileContent {
  kind: 'text' | 'binary' | 'too-large' | 'lfs-pointer' | 'missing' | 'submodule';
  text?: string;                // decoded
  encoding?: 'utf8' | 'utf8bom' | 'utf16le' | 'utf16be' | 'unknown';
  eol?: 'lf' | 'crlf' | 'mixed';
  size: number;
  lfs?: { oid: string; size: number; available: boolean };
  submoduleSha?: string;
  imageDataUrl?: never;         // images fetched via protocol, see below
}

export type Hunk = DiffHunk;          // spec 02 §5.1 (header, section = function context, lines: DiffLine[])
export interface FilePatch { file: ChangedFile; hunks: Hunk[]; isBinary: boolean; tooLarge: boolean; }

export interface DiffOptions {
  context: number;              // -U
  whitespace: 'none' | 'eol' | 'amount' | 'all';
  ignoreBlankLines: boolean;
  renames: boolean; copies: boolean; renameLimit?: number;
  algorithm: 'myers' | 'minimal' | 'patience' | 'histogram';   // default from diff.algorithm or 'histogram'
}

// BlameLine, BlameCommitInfo and BlameResult are spec 02 §5.1 types (not redefined here).
// Person (author/committer display) is built in the renderer from BlameCommitInfo.author/authorMail/authorTime.
export interface FileHistoryEntry { sha: Sha; path: string; oldPath?: string; status: FileStatus; author: Person; subject: string; }
```

**Mapping to the spec 02 contract.** These are domain channels layered on spec 02, following the same rule as spec 05 §5. Read channels (`diff:*` except `diff:revertHunk`, `history:file`, `blame:file`, `files:list`) are registered in the git contract and implemented with spec 02 reads: `git:commit:detail`, `git:diff`, `git:diff:numstat`, `git:show:file`/`BlobReader` and `git:blame`. Type equivalences: `ChangedFile` extends spec 02 `FileChangeSummary` with modes/oids from the raw block, `Hunk` is spec 02 `DiffHunk`, and `FilePatch.hunks` is `DiffHunk[]`. `diff:revertHunk` is a mutating `GitOperation` (`{ type: 'diff.revertHunk' }`) run via `git:op:run` with undo-journal kind `revert-hunk` (spec 05 §11).

**IPC channels**

| Channel | Payload → Result |
|---|---|
| `diff:commitDetail` | `{repoId, sha}` → `CommitDetail` |
| `diff:files` | `{repoId, target: DiffTarget, opts: DiffOptions, limit?: number}` → `FileListResult` |
| `diff:filePatch` | `{repoId, target, path, oldPath?, opts}` → `FilePatch` |
| `diff:fileContent` | `FileContentRequest` → `FileContent` |
| `diff:allFiles` | `{repoId, rev}` → `string[]` (View all files; `ls-tree`) |
| `diff:revertHunk` | `{repoId, target, path, hunkIndex \| patch}` → `void` (op queue, undo journal) |
| `history:file` | `{repoId, path, rev, follow, skip, limit}` → `FileHistoryEntry[]` |
| `blame:file` | `{repoId, path, rev \| WORKTREE, opts}` → stream id; events `blame:chunk {lines, commits}` / `blame:done` |
| `fs:readWorktreeFile` | `{repoId, path}` → `{ bytes: Uint8Array; mtimeMs; hash }` |
| `fs:writeWorktreeFile` | `{repoId, path, bytes, expectedHash?}` → `{ ok } \| { conflict: true }` |
| `fs:createFile` | `{repoId, path}` → void |
| `tools:openDiffTool` | `{repoId, target, path}` → void |
| `tools:openEditor` | `{repoId, path, line?}` → void |
| `tools:showInFolder` | `{repoId, path}` → void |
| `files:list` | `{repoId, includeUntracked, includeDeleted}` → stream of paths |
| Protocol `githappens-rev://<repoId>/<rev>/<path>` | Serves raw blob bytes (images) with the correct MIME type. `rev` may be `:worktree` or `:index`. Path-traversal guarded |

All path parameters are validated in the main process: they must be relative, contain no `..` that escapes the repo, and be normalized to `/`. The worktree write handler refuses paths outside the repo root and inside `.git/`.

---

## 6. Git implementation

### 6.1 Commit detail
```bash
git show -s --format='%H%x00%P%x00%T%x00%an%x00%ae%x00%at%x00%ad%x00%cn%x00%ce%x00%ct%x00%B' --date=raw <sha>
git interpret-trailers --parse < body   # or parse locally (key: value lines in last paragraph)
```

### 6.2 Changed file list
- **Single commit** (vs parent p):
  `git diff-tree -r -z --no-commit-id --raw --numstat -M [-C] --root <parent> <sha>`
  For a root commit: `git diff-tree --root -r -z --raw --numstat <sha>`.
  Combined merge (`--cc`): `git diff-tree -r -z --cc --raw <sha>`. Only files that differ from all parents are listed.
- **Compare:** `git diff -z --raw --numstat -M <from> <to>`. For three-dot: `git diff <from>...<to>`.
- **Against worktree:** `git diff -z --raw --numstat -M <from>` (includes tracked files only). Untracked files are added from `git ls-files --others --exclude-standard -z`.
- **Range:** `git diff -z --raw --numstat -M <oldest>^ <newest>`. If oldest is a root, use the empty tree `4b825dc642cb6eb9a060e54bf8d69288fbee4904` (SHA-1) or `git hash-object -t tree /dev/null` for SHA-256. With `includeWip`, use `git diff <oldest>^` (to the worktree).
- **Stash:** `git stash show -z --raw --numstat --include-untracked stash@{n}` (git ≥ 2.32 for `-u`; fallback: diff `stash^1 stash` plus untracked from `stash^3`).
- **Parsing:** the `--raw -z` records are `:oldmode newmode oldoid newoid STATUS[score]\0path\0[newpath\0]`. Numstat `-z` records are `adds\tdels\t` followed by `path\0` or, for renames, `\0old\0new\0`. Join the two by order (both are emitted in the same order). Binary shows `-\t-`.
- **Limits:** add `-l<renameLimit>` (default 1000; preference). If more than 5,000 files, skip `--numstat` and rerun with `--raw` only.
- **View all files:** `git ls-tree -r -z --name-only <sha>`, merged with changed statuses.

### 6.3 File content
- Batch reads use a long-lived `git cat-file --batch` process per repo (spec 02 `BlobReader`). Request `<rev>:<path>` (a SHA-1 oid is preferable when known from `--raw`). The response header gives the size, so check `maxBytes` before reading the body. If the blob is too large, read and discard the bytes and return `too-large`. Better: query `--batch-check` first for the size.
- Index blob: `:0:<path>` (or `:<path>`). Worktree: read from disk in main with `fs.promises.readFile`, size-checked via `stat` first.
- Decoding: detect the BOM. Otherwise try strict UTF-8 (`TextDecoder('utf-8', {fatal:true})`). On failure, use the `working-tree-encoding` gitattribute if present, else latin1 with `encoding:'unknown'` and a banner.
- LFS pointer detection: size under 1024 and the text starts with `version https://git-lfs.github.com/spec/v1`. Parse `oid sha256:<hex>` and `size`. Content is available if `.git/lfs/objects/<o[0:2]>/<o[2:4]>/<oid>` exists. Serve that file via the protocol. Text content: `git lfs smudge` is unnecessary since the object file is raw content.
- Submodule (mode 160000): the "blob" is a commit SHA from `--raw`, so no cat-file is needed.

### 6.4 Rendering strategy (Monaco)
- **Inline/Split:** `monaco.editor.createDiffEditor` with models `original` (old content) and `modified` (new content), language from `monaco.languages` by filename. Options: `renderSideBySide`, `ignoreTrimWhitespace`, `diffAlgorithm: 'advanced'`, `maxComputationTime: 2000`, `renderOverviewRuler: true` (the minimap equivalent), `wordWrap`, `readOnly: true` (except WIP's modified side when editing is enabled; spec 06 keeps it read-only and uses the editor view).
- **Hunk:** Monaco DiffEditor with `hideUnchangedRegions: { enabled: true, contextLineCount: N, minimumLineCount: 3, revealLineCount: 20 }` in inline layout. **Hunk actions** need *git's* hunks (so that stage/discard patches apply exactly). We render action bars as Monaco **view zones / overlay widgets** anchored at each git hunk's `newStart` line, using `FilePatch` from `git diff`. When Monaco's and git's hunk boundaries differ, git's boundaries win for actions, and Monaco is used only for display.
- **Fallback renderer:** for content over the large-file thresholds the user chose to load, or for patch-only contexts (no full blobs available, for example `stash show`), render `FilePatch` directly in a virtualized list (`<PatchList>`) with Shiki/Monaco tokenization per visible line. Word highlights come from §6.5.
- Models are cached in an LRU (10 entries) keyed by `(repoId, rev, path)` and disposed on eviction to avoid Monaco memory leaks.

### 6.5 Word diff for patch renderer
- For each hunk, pair consecutive `-` and `+` runs of equal length (or use LCS pairing when lengths differ). Tokenize each pair of lines into words with `/\w+|\s+|[^\w\s]/gu`, then run Myers on the token arrays and mark changed tokens. Skip pairs where the line length exceeds 2,000 characters.

### 6.6 Patch for actions
```bash
git diff --no-color --no-ext-diff -U<ctx> [-w|-b|--ignore-space-at-eol] [--ignore-blank-lines] \
   --diff-algorithm=<alg> -M <from> <to> -- <path> [<oldPath>]
```
- Always pass `--no-ext-diff --no-color --no-textconv` for patch actions. For display, `--textconv` may be enabled by preference so that `diff=<driver>` attributes are respected.
- **Revert hunk** (commit diff → worktree): build a single-hunk patch (file headers plus that hunk), then run `git apply --reverse --recount -` (no `--cached`; add `--3way` only when the preference "Revert hunk: allow 3-way" is on), so the inverse lands as unstaged changes. If the hunk doesn't apply cleanly (the worktree diverged), show the error and suggest a cherry-pick/revert of the whole commit. Record it in the undo journal (spec 05) as a reverse-apply.
- **Discard hunk** (WIP) is in spec 06.

### 6.7 File history
```bash
git log --follow -z --format='%x1e%H%x00%an%x00%ae%x00%at%x00%s' --name-status -M <rev> -- <path>
```
- `--follow` works for a single path only. Parse the `name-status` that follows each record to get the path at that commit (for renames: `R087\0old\0new`). Pagination uses `--skip`/`-n`. Pass the path at each entry to the diff (`diff:filePatch` with the commit target and that path/oldPath).
- `--follow` can't be combined with some options and is approximate. The "Follow renames" toggle off drops `--follow`.
- Diff for a history entry: `git diff-tree -p -M <sha>^ <sha> -- <oldPath> <path>`, or Monaco on the blobs `<sha>^:<oldPath>` and `<sha>:<path>`.

### 6.8 Blame
```bash
git blame --incremental [-w] [-M] [-C] [--ignore-revs-file=…(auto)] <rev> -- <path>
# working copy: git blame --incremental --contents - -- <path>   (feed disk bytes via stdin)  or omit rev
```
- The `--incremental` output streams `sha origLine finalLine count`, followed by header lines (`author`, `author-mail`, `author-time`, `summary`, `previous`, `boundary`, `filename`) the first time each SHA appears. Parse it into `BlameLine` ranges plus a `BlameCommitInfo` map, and render progressively.
- An uncommitted line has the SHA `0000000…`.
- Large files: blame is allowed up to 20,000 lines. Above that, it requires a click.

### 6.9 External diff tool
- **Preference value:** `diffTool: 'none' | 'git-config' | KnownDiffTool`.
- **git-config:** for commit/compare targets, `git difftool --no-prompt [--tool=<t>] <from> <to> -- <path>`. For WIP unstaged: `git difftool --no-prompt -- <path>`. For staged: `git difftool --no-prompt --cached -- <path>`. git creates the temp files.
- **Known tool:** write the two blobs to a temp dir (`os.tmpdir()/githappens/<random>/{old,new}/<basename>`, files read-only), then spawn the tool detached:

| Tool | Command template |
|---|---|
| Beyond Compare | Win `BComp.exe "{old}" "{new}" /lefttitle="{oldTitle}" /righttitle="{newTitle}"`; mac/Linux `bcomp "{old}" "{new}"` |
| Kaleidoscope | `ksdiff --partial-changeset --relative-path "{path}" -- "{old}" "{new}"` |
| P4Merge | `p4merge -nl "{oldTitle}" -nr "{newTitle}" "{old}" "{new}"` |
| KDiff3 | `kdiff3 --L1 "{oldTitle}" --L2 "{newTitle}" "{old}" "{new}"` |
| Araxis | Win `Compare.exe /wait "{old}" "{new}"`; mac `compare "{old}" "{new}"` |
| FileMerge | `opendiff "{old}" "{new}"` |
| Meld | `meld "{old}" "{new}"` |
| VS Code | `code --wait --diff "{old}" "{new}"` |
| WinMerge | `WinMergeU.exe /e /u /dl "{oldTitle}" /dr "{newTitle}" "{old}" "{new}"` |

- **Tool discovery:** a `ToolLocator` checks PATH plus known install dirs (for example `C:\Program Files\Beyond Compare 4\BComp.exe`, `/Applications/Beyond Compare.app/Contents/MacOS/bcomp`, `/usr/local/bin/ksdiff`). Undetected tools are listed but disabled, with the hint "Install command line tools".
- When the right side is WORKTREE, pass the real working file path, not a temp copy, so edits persist.
- Temp files are cleaned up after the process exits, or on app exit.

### 6.10 Editor write
- Main process: `writeFileAtomic(path, bytes)`. Write to `path.tmp-<rand>` in the same directory, `fsync`, then `rename`. Preserve mode with `chmod` (stat first), and follow symlinks (write to the target). On Windows, retry rename on `EPERM` (AV locks) 3 times with backoff.
- Compare `expectedHash` (sha1 of the bytes loaded) with the current disk bytes before writing. Mismatch → `{conflict:true}`.

### 6.11 File list for search
```bash
git ls-files -z --cached --others --exclude-standard     # current + untracked
git log --all --format= --name-only -z --diff-filter=D   # deleted (optional, lazy)
```

---

## 7. Step-by-step implementation plan

1. **Types and IPC contract** (§5). Compile test.
2. **Parsers:** `parseRawNumstatZ`, `parseCommitDetail`, `parseUnifiedPatch` (hunks, `\ No newline`, binary markers, mode lines, rename headers, submodule `Subproject commit`), `parseBlameIncremental`, `parseFileHistory`. Unit tests with fixture outputs, including unicode paths, paths with tabs and newlines (`-z`), CRLF content and SHA-256.
3. **BlobReader:** long-lived `cat-file --batch` and `--batch-check`, a request queue, and size limits. Test: 1,000 concurrent reads and a too-large blob.
4. **Content decoding:** BOM, UTF-8 strict, latin1 fallback, EOL detection, LFS pointer detection. Tests.
5. **`githappens-rev://` protocol:** streaming blobs, worktree files and index blobs, with traversal guard tests.
6. **Commit detail panel:** header, metadata, parents, file list (path/tree, filter, view-all), virtualization, keyboard. Component tests plus e2e clicking a commit.
7. **DiffView shell:** toolbar, banners, mode persistence, Esc/breadcrumb, Monaco loader (lazy chunk, web workers configured for Electron with `MonacoEnvironment.getWorkerUrl`). Test: e2e opens a text diff.
8. **Inline and Split modes** with Monaco, language detection and theme bridge (spec 13 tokens → Monaco theme). Visual snapshot tests.
9. **Hunk mode:** hideUnchangedRegions plus git-hunk action zones. Expanding context. Revert hunk (commit diffs). Test: revert hunk e2e produces the expected worktree change and an undo entry.
10. **Whitespace options:** wire flags, disable staging when ignoring. Test: a reformatted file shows no changes with `-w`.
11. **Navigation:** next/previous change and file, counters, word wrap toggle. Test.
12. **Image diff:** side-by-side, swipe, onion, difference via `githappens-rev://` URLs. Test: fixture with a changed PNG.
13. **Binary, LFS, submodule, mode, rename and type-change banners.** Fixture tests (`lfs`, `submodules` fixtures).
14. **Large-file guard and huge-commit limits.** Test: a 60 MB blob shows the card and never loads Monaco (assert no model created).
15. **Commit comparison and range/WIP compare:** targets from spec 04 selection, swap, two- vs three-dot. Tests against known diffs.
16. **Merge commit parent selector and `--cc` combined view.** Test on a `branchy` fixture.
17. **File history view** with follow renames, pagination and per-entry diff. Test: a renamed file shows the full history.
18. **Blame view:** incremental streaming, gutter blocks, hover card, blame prior revision, working-copy blame. Test: blame of a known fixture matches `git blame --porcelain`.
19. **In-app editor:** open, encoding/EOL round-trip, atomic save, conflict detection, dirty-close prompt, new file. Test: CRLF and BOM files are saved byte-identical when unchanged.
20. **External editor and diff tool:** ToolLocator, templates, temp files, git-config difftool mode. Test: a mock tool script records its argv.
21. **File search palette:** fuzzy scoring, actions, deleted-file mode. Test: the ranking prefers the basename.
22. **Performance pass:** model LRU disposal, worker-based word diff for the patch renderer. Budget: open the diff of a 5k-line file in under 150 ms.

---

## 8. Edge cases

- **Root commit:** diff against the empty tree. Parents list is empty, and the UI shows "Initial commit".
- **Merge commits:** the default is a diff vs the first parent *(inferred)*. The parent selector allows the others. `--cc` may list zero files ("No conflicts were resolved in this merge").
- **Renames with modifications at low similarity:** they show as D + A. The rename limit is exceeded on huge commits, and git warns "inexact rename detection skipped". Surface this warning in the banner.
- **Case-only renames** on case-insensitive filesystems (`File.ts` → `file.ts`): the worktree read must use the exact index path.
- **Paths with newlines, tabs, quotes or unicode:** always use `-z`, `core.quotepath=off`, and pass pathspecs with `--literal-pathspecs` (or the `:(literal)` prefix).
- **CRLF:** `core.autocrlf` means the blob (LF) differs from disk (CRLF). For WIP diffs use `git diff` semantics (git normalizes). For Monaco worktree-vs-index diffs, normalize EOL in both models when `autocrlf`/`eol` attributes apply, or users see whole-file changes. Show "Line endings differ" when the only difference is EOL.
- **Files with no trailing newline:** show the "No newline at end of file" marker (Monaco handles it; the patch renderer shows a `\` line).
- **Symlinks:** the blob content is the link target. Never follow symlinks when reading worktree symlink files for diff (use `fs.readlink`).
- **Submodule not initialized:** banner without the commit list. Avoid false "changes in uninitialized submodule" warnings.
- **Deleted file:** only the old side. File View shows the old content. Edit is disabled. "Restore file" checks out from the parent.
- **Added empty file:** "Empty file added".
- **Permission-only change:** a mode banner, no hunks.
- **Textconv/filter drivers** (for example `diff=lfs` or `*.docx diff=word`): display may use textconv. Actions never do.
- **Encodings:** UTF-16 files are considered binary by git (they contain NULs). If a BOM is detected, show them as text with a note that hunk staging is disabled.
- **Huge single line** (minified JS): guard by line length (§4.14).
- **Stash with untracked files:** the third parent holds the untracked files. Merge them into the list as `A` with a "untracked" tag.
- **Comparing unrelated histories:** three-dot fails with no merge base, so fall back to two-dot with a notice.
- **Worktree file modified externally while the editor is open:** watch the event. If the editor is not dirty, reload silently. If it is dirty, show the banner "File changed on disk".
- **Bare repo:** no worktree actions (edit, revert hunk, compare with worktree are disabled).
- **Sparse checkout:** files outside the sparse cone can't be edited. Mark them "not in sparse checkout".
- **SHA-256 repos:** use the empty tree oid via `git hash-object -t tree --stdin </dev/null`.

---

## 9. Acceptance criteria

- [ ] Clicking a commit shows metadata, parents and the changed file list within 150 ms (warm) for commits with fewer than 500 files.
- [ ] Hunk, Inline and Split modes render the same changes. Toggling preserves the approximate scroll position. The mode persists.
- [ ] Word-level highlights appear on modified lines.
- [ ] The whitespace "ignore all" option hides indentation-only changes and disables hunk staging with an explanation.
- [ ] Revert hunk on a commit diff applies the inverse to the worktree as unstaged changes and is undoable.
- [ ] Image diffs show old and new side by side with dimensions. Swipe and onion modes work.
- [ ] Binary files show sizes. LFS pointers show the LFS banner, and real content when available locally.
- [ ] Renames show "renamed from" with similarity. Mode changes and submodule updates show banners. The submodule commit list appears when initialized.
- [ ] Selecting two commits shows their comparison. A contiguous range shows the combined diff. Commit-vs-WIP works.
- [ ] A merge commit's parent selector works, and the `--cc` view lists only conflict-resolved files.
- [ ] File history follows a renamed file through at least 2 renames. Selecting an entry shows its diff.
- [ ] Blame output matches `git blame` line attribution. Hovering shows commit info. "Blame prior revision" works.
- [ ] The in-app editor saves atomically, preserves EOL, BOM and mode, detects on-disk conflicts and prompts on unsaved close.
- [ ] External diff opens the configured tool with correct files and titles. "Git config default" uses `git difftool`.
- [ ] Ctrl/⌘+Shift+H finds files fuzzily and opens history or blame.
- [ ] A 60 MB file never freezes the UI. Files over 1 MB require a confirmation. Minified files render without jank.
- [ ] Paths with unicode, spaces, tabs and newlines work across list, diff, history, blame and editor.

---

## 10. Out of scope / later

- Inline review comments on diffs (PR review lives in spec 10).
- Semantic or structural diff (AST-aware).
- Three-way compare of arbitrary commits (the merge tool in spec 08 covers conflicts only).
- Editing the modified side directly in the Split diff (the editor view covers editing).
- Rendering PDFs, Office documents or notebooks as rich diffs. A Jupyter `.ipynb` cell-aware diff is a candidate later.
- Patch create/apply UI: spec 12.
- Image diff for non-browser formats (PSD, TIFF) beyond the binary card.
