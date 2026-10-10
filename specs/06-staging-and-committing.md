# 06 — Staging & Committing

> Depends on: 02 (GitService, OperationQueue, RepoWatcher, IPC), 04 (WIP node row), 05 (Undo journal, stash, squash-merge state), 07 (Monaco diff viewer that hosts hunk/line selection). Related: 08 (conflicted files in the staging panel), 09 (push after commit), 12 (AI commit message, Commit Composer), 13 (preferences).

## 1. Purpose

The staging area is where most daily time in GitHappens is spent: seeing what changed, choosing exactly which files, hunks or lines go into the next commit, writing a good message, and committing (optionally pushing). GitHappens makes this visual through the **WIP node** at the top of the graph and the **Commit Panel** on the right. This spec covers the WIP node, the staging lists, file/hunk/line staging and discarding (with exact patch construction), ignore rules, the commit composer (summary/description, amend, skip hooks, push after commit, templates, co-authors, signing), hook execution, and special commit situations (initial, empty, merge, squash).

## 2. Reference behavior

Items marked *(inferred)* are design decisions rather than documented behavior.

- **WIP node**: appears at the top of the graph (above HEAD's row, connected by a dashed line to HEAD) whenever the working tree or index differs from HEAD; it displays "// WIP" plus counts of modified/added/deleted files (pencil/plus/minus icons). Typing a summary directly into the WIP node's inline field is possible; the same text is used as the stash message when stashing. Clicking it opens the Commit Panel.
- **Commit Panel**: "Unstaged Files (N)" list with *Stage all changes* button; "Staged Files (N)" list with *Unstage all changes*. Hover a file → *Stage File* / *Unstage File* button. Multi-select files → right-click → Stage / Unstage / Discard selected / Ignore / Stash file. Top of panel has a trash icon (discard all) and *Path / Tree* view toggle; sorting options for files *(sort options: path, name, status — inferred)*. Stage all: Ctrl/Cmd+Shift+S *(and Ctrl/Cmd+Shift+U unstage all, inferred)*.
- **Hunk/line staging**: clicking a file opens its diff in the center; each hunk has *Stage Hunk* / *Unstage Hunk* / *Discard Hunk* buttons; selecting lines (click/shift-click/drag in the gutter) enables *Stage selected lines*, also via right-click. Unstaging lines works from the staged diff.
- **Discard**: permanent from git's perspective, but the app's Undo can restore a discard.
- **Ignore**: right-click unstaged (untracked) file → *Ignore* ▸ *this file* / *all files with extension .x* / *all files in folder y/*. Writes to the root `.gitignore` (nested `.gitignore` files are not edited). For tracked files: *Ignore and stop tracking* additionally removes from index.
- **Commit message**: Summary field (single line) with a character counter *(shows remaining characters against a 72 recommendation — inferred exact number)* and a multi-line Description field. Commit with Ctrl/Cmd+Enter. Commit button text reflects staged count "Commit changes to N files".
- **Amend**: "Amend previous commit" checkbox; loads the previous message. Also selecting HEAD commit allows editing its message → *Update Message*.
- **Skip hooks**: checkbox in the Commit Panel bypassing all hooks for that commit (equivalent to `--no-verify`).
- **Push after committing**: checkbox; triggers push immediately after commit.
- **Templates**: uses `commit.template` from repo config then global; editable from Preferences → Commit; if none exists the app writes a repo-local template file and points repo config at it; options: auto-apply template, strip `#` comment lines.
- **Co-authors**: standard `Co-authored-by: Name <email>` trailers; the app shows co-author avatars in commit details. A co-author picker exists in newer versions *(inferred)*.
- **Signing**: Preferences → Commit Signing: enable GPG (or SSH, newer versions) signing, choose signing key, path to gpg program; "sign commits by default" and "sign tags by default"; graph/commit details show a verified badge for signed commits *(GitHub verification vs local verification — inferred: local `%G?`)*.
- **AI commit message**: sparkle button next to summary generates summary+description from staged changes; can regenerate when amending (spec 12).
- **Hooks**: the app runs hooks; on failure the commit fails, the hook's output is shown in an error/toast with "details" *(inferred)*; message is preserved.

## 3. User stories

1. As a developer I want to see at a glance in the graph that I have uncommitted changes and how many files.
2. As a developer I want to stage whole files, hunks, or individual lines so each commit is focused.
3. As a developer I want to discard a file, hunk, or line and still be able to Undo it.
4. As a developer I want to ignore a file, extension, or folder in two clicks.
5. As a developer I want a summary field that tells me when I exceed 72 characters.
6. As a developer I want to amend, skip hooks, or commit-and-push in one action.
7. As a team member I want commit templates and co-author trailers applied consistently.
8. As a security-conscious developer I want commits signed (GPG or SSH) and to see verified badges.
9. As a developer I want clear hook output when `pre-commit` fails, without losing my message.
10. As a new-repo user I want to make the initial commit in an empty repository.

## 4. UI specification

### 4.1 Component tree
```
<Graph>
  <WipRow>                            (row 0, spec 04 provides row slot)
    <WipNode dashed-edge-to-HEAD/>
    <WipInlineSummary input/>         (bound to composer.summary)
    <WipCounts modified added deleted conflicted/>
<RightPanel mode="wip">
  <CommitPanel>
    <CommitPanelHeader> "N file changes on <branch>" · [Discard all 🗑] · [Path|Tree] · [Sort ▾] · [Stash] · [⋯]
    <FileSection kind="unstaged" title="Unstaged Files (N)" action="Stage all changes">
      <FileList virtualized view=path|tree>
        <FileRow status-icon path rename-arrow eol-warning-badge [Stage File] [Discard]/>
    <FileSection kind="staged" title="Staged Files (N)" action="Unstage all changes">
      <FileList .../>
    <ConflictSection/>                (spec 08; shown when merge/rebase conflicts)
    <CommitComposer>
      <AmendToggle/> <SkipHooksToggle/> <PushAfterCommitToggle/> <SignToggle (only if signing configured)/>
      <SummaryInput maxHint=72 counter/> <AiGenerateButton/> (spec 12)
      <DescriptionTextarea/>
      <CoAuthorPicker chips/>
      <CommitButton label="Commit changes to N files" | "Amend previous commit" | "Commit merge" />
      <HookOutputDrawer/>
<CenterDiffView file=… side="unstaged|staged">       (spec 07 Monaco)
  <HunkToolbar per hunk: Stage hunk | Unstage hunk | Discard hunk/>
  <LineSelectionGutter/> → floating bar "Stage 3 lines | Discard 3 lines"
```

### 4.2 WIP node states
| State | Rendering |
|---|---|
| Clean | No WIP row (or row hidden). |
| Changes | `// WIP` (or inline summary text) + counts. |
| Merge/rebase/cherry-pick in progress | Row label "Merging <src> into <H>" / "Rebasing (3/5)"; conflict count in red. |
| Unborn branch (empty repo) | WIP row is the only row; counts; no dashed edge. |
| Detached HEAD | Edge points to the detached commit. |
Clicking selects it and switches right panel to Commit Panel. Typing in inline summary updates composer state (same store).

### 4.3 File lists
- Status icons: M (modified), A (added/untracked shown as "+"), D, R (renamed `old → new`), C (copied, rare), T (type change), U (conflicted), `!` LFS pointer *(ours)*.
- **Path view**: flat list, full relative path, directory part dimmed, filename emphasized; long paths ellipsize in the middle.
- **Tree view**: collapsible folders with aggregated counts; folder row hover → *Stage folder* / *Unstage folder* / *Discard folder*.
- **Sort**: by path (default), file name, status, extension; ascending/descending. Persisted per profile.
- Selection: click, Ctrl/Cmd toggle, Shift range, Ctrl/Cmd+A within a section. Double-click a file = stage/unstage toggle *(inferred)*. Space = stage/unstage selected. Delete/Backspace = discard (with confirm).
- Drag files between Unstaged and Staged sections to stage/unstage *(ours — inferred)*.
- Context menu (unstaged): Stage, Discard changes, Ignore ▸ (file / `*.ext` / `folder/`), Stash file(s), Open file (spec 07 editor), Open in external editor, Show in folder, Copy path, Copy relative path, File history, File blame, Edit file.
- Context menu (staged): Unstage, Stash file(s), Ignore and stop tracking (tracked only), Open/copy items.
- Empty states: "No unstaged changes"; both empty → panel shows "Working directory clean" and composer disabled unless "Allow empty commit" (⋯ menu).
- Loading: skeleton rows while first status load; subsequent refreshes keep stale data and swap atomically (no flicker).
- Large change sets: virtualized; >5000 files shows banner "Large number of changes — tree view collapsed by default".

### 4.4 Diff-level staging (inside spec 07 diff view)
- The diff shown depends on which list the file was clicked in: unstaged → `index ↔ worktree`; staged → `HEAD ↔ index`. A file may appear in both lists (partially staged) — both diffs reachable; a toggle at top "Unstaged | Staged" switches.
- Hunk header bar: `@@ -10,6 +10,8 @@ functionName` + buttons. Unstaged diff: *Stage hunk*, *Discard hunk*. Staged diff: *Unstage hunk*.
- Line selection: click a changed line's gutter to toggle; Shift+click range; drag to paint. Only `+`/`-` lines selectable; context lines ignored. Selected lines highlighted stronger. Floating action bar shows *Stage N lines* / *Discard N lines* (unstaged) or *Unstage N lines* (staged). Right-click gives the same actions. Esc clears selection.
- Works in inline (unified) and split view; in split view, left side selects `-` lines, right side `+` lines.
- Disabled (with tooltip) for binary, LFS pointer, submodule, symlink and type-change entries; for files with "\ No newline" pairs see §8.
- After staging, the diff refreshes and the selection clears; the scroll position is preserved by anchoring on the nearest remaining hunk.

### 4.5 Commit composer
- **Summary**: single-line input; counter shows `n/72`; at 51–72 counter amber *(GitHub truncates titles at ~72; 50 is the conventional soft limit)*, >72 red but **not blocking**. Paste with newlines: first line → summary, rest → description.
- **Description**: auto-growing textarea (max 50% panel height), monospace optional, ruler at column 72 (preference).
- Hard limits: none; commit button disabled when summary is empty (unless amending and keeping the message, or a merge with MERGE_MSG prefilled).
- **Amend toggle**: on enable, if composer is empty load HEAD's message (summary/description split at first blank line); on disable, restore the message the user had before toggling. Button label "Amend previous commit". Warn inline if HEAD is already pushed (HEAD reachable from its upstream): "This commit is on origin/x — amending will require force push."
- **Skip hooks**: checkbox, per-commit (resets after commit unless preference "remember").
- **Push after commit**: checkbox, sticky per repo; if branch has no upstream, push dialog (spec 09) opens to choose remote.
- **Sign**: shown when signing configured; defaults to config `commit.gpgSign`; unchecking adds `--no-gpg-sign`.
- **Co-authors**: chip input with autocomplete from `git shortlog -sne --all` (cached) and provider org members (spec 10); stored as trailers appended on commit (never duplicated if already in the description).
- **Template**: applied when composer is empty and preference "auto-apply" is on; comment lines (`#`) stripped on commit if "strip comments" (default true, mirrors `--cleanup=strip`).
- **Message draft persistence**: composer state saved per repo+branch to userData every 1 s (debounced) and restored on reopen *(the WIP message survives restarts — inferred)*.
- **Shortcuts**: Ctrl/Cmd+Enter commit; Ctrl/Cmd+Shift+Enter commit & push *(ours)*; Ctrl/Cmd+Shift+S stage all; Ctrl/Cmd+Shift+U unstage all; Ctrl/Cmd+Shift+M focus summary *(ours)*.

### 4.6 Hook output & errors
- During commit, the button shows a spinner and "Running hooks…" if a hook exists (`core.hooksPath` or `.git/hooks/pre-commit|prepare-commit-msg|commit-msg|post-commit` executable, or for Windows any file without `.sample`).
- `HookOutputDrawer` streams stdout/stderr live (xterm.js read-only instance so ANSI colors render).
- Failure: red banner "pre-commit hook failed (exit 1)" + drawer auto-expanded; message preserved; buttons *Retry* and *Commit skipping hooks*.
- Hooks that modify files (formatters) → after hook, status refreshes; if the hook staged additional changes they are included (git behavior).
- Post-commit hook failures don't fail the commit; shown as warning toast.

### 4.7 Signing indicator & verified badge
- Commit detail (spec 07) and graph row tooltip show a badge: ✔ Verified (green) — `G`; ? Unknown key (`U`/`E`) amber; ✖ Bad (`B`/`X`/`Y`/`R`) red; none for unsigned. When a provider is connected, the provider's verification state overrides (GitHub `verification.verified`) *(inferred: provider data is used)*.

### 4.8 Line-ending warnings
- If staging produces git's "LF will be replaced by CRLF" / "CRLF will be replaced by LF" warnings, the file row gets an EOL badge with tooltip, and a one-time dismissible banner suggests configuring `core.autocrlf` or `.gitattributes`.
- Diff view shows "Line endings differ" when the only changes are EOLs (spec 07 option to ignore whitespace).

## 5. Data model & IPC

```ts
// src/shared/wip.ts
export type FileStatusCode = 'M' | 'A' | 'D' | 'R' | 'C' | 'T' | 'U' | '?';
export interface WipFile {
  path: string;                 // new path
  origPath?: string;            // for renames/copies
  status: FileStatusCode;
  similarity?: number;          // rename score
  isBinary?: boolean; isLfs?: boolean; isSubmodule?: boolean; isSymlink?: boolean;
  modeChange?: { from: string; to: string };
  eolWarning?: 'lf-to-crlf' | 'crlf-to-lf';
  conflict?: { ours: string; theirs: string; kind: 'both-modified'|'added-by-us'|'deleted-by-them'|'both-added'|'both-deleted'|'added-by-them'|'deleted-by-us' };
}
export interface WipStatus {
  repoId: string;
  headSha: string | null;       // null = unborn
  branch: string | null;        // null = detached
  unstaged: WipFile[];          // index ↔ worktree (incl. untracked)
  staged: WipFile[];            // HEAD ↔ index
  conflicted: WipFile[];
  opState: import('./ops').OpState;
  prefillMessage?: { source: 'MERGE_MSG' | 'SQUASH_MSG' | 'template' | 'rebase-edit'; text: string };
}

export type Side = 'unstaged' | 'staged';
export interface LineSelection {
  path: string; side: Side;
  /** identifies lines by their diff-relative identity, robust to re-render */
  lines: { hunkIndex: number; lineIndex: number }[];
  diffHash: string;             // hash of the diff text used to build the selection; mismatch → refuse & refresh
}
export interface StageReq { repoId: string; paths: string[] }                     // whole files
export interface HunkReq { repoId: string; path: string; side: Side; hunkIndex: number; diffHash: string }
export interface DiscardReq { repoId: string; paths: string[]; includeUntracked: boolean }
export interface IgnoreReq { repoId: string; pattern: string; stopTracking?: string[] }

export interface CommitReq {
  repoId: string;
  summary: string; description: string;
  coAuthors: { name: string; email: string }[];
  amend: boolean; skipHooks: boolean; allowEmpty: boolean;
  sign: 'config' | 'force' | 'off';
  cleanup: 'strip' | 'whitespace' | 'verbatim';
  pushAfter: boolean;
  author?: { name: string; email: string };   // override (rare; profile-based, spec 13)
}
export interface CommitResult { ok: boolean; sha?: string; journalId?: string; hookFailed?: { hook: string; exitCode: number; output: string }; stderr?: string; pushResult?: unknown }

export interface ComposerDraft { summary: string; description: string; coAuthors: CommitReq['coAuthors']; amend: boolean; skipHooks: boolean; pushAfter: boolean }
```

### IPC channels
Contract mapping follows spec 05 §5. Mutating channels (`wip:stage*`, `wip:unstage*`, `wip:discard*`, `wip:ignore`, `commit:create`, `commit:rewordHead`, `commit:saveTemplate`) become `GitOperation` variants run through `git:op:run` from spec 02. Read channels (`wip:status`, `wip:diff`, `commit:headMessage`, `commit:template`, `commit:coAuthorSuggestions`, `commit:verify`) are thin wrappers over spec 02's `git:status` / `git:diff` (`DiffSpec` kinds `workdir` / `staged` / `untracked`), and they add parsing for hunks and lines. `WipStatus` is derived from spec 02's `StatusResult`.

| Channel | Payload → Result | Notes |
|---|---|---|
| `wip:status` | `{repoId}` → `WipStatus` | also pushed as event `wip:changed` whenever spec 02 `git:repo:changed` carries the `status` scope (debounce per spec 02 §6.14) |
| `wip:diff` | `{repoId,path,side,context?:number,ignoreWs?:boolean}` → `{ text: string; hunks: ParsedHunk[]; diffHash: string; isBinary: boolean }` | |
| `wip:stage` / `wip:unstage` | `StageReq` → `OpResult` | |
| `wip:stageAll` / `wip:unstageAll` | `{repoId}` | |
| `wip:stageHunk` / `wip:unstageHunk` / `wip:discardHunk` | `HunkReq` | |
| `wip:stageLines` / `wip:unstageLines` / `wip:discardLines` | `LineSelection & {repoId}` | |
| `wip:discard` / `wip:discardAll` | `DiscardReq` | journaled (spec 05 `discard`) |
| `wip:ignore` | `IgnoreReq` | |
| `commit:create` | `CommitReq` → `CommitResult` | journaled `commit`/`amend` |
| `commit:hookOutput` (event) | `{repoId, hook, chunk, stream:'out'|'err'}` | |
| `commit:headMessage` | `{repoId}` → `{summary,description}` | for amend |
| `commit:rewordHead` | `{repoId,summary,description}` | "Update message" path; journaled `amend` |
| `commit:template` | `{repoId}` → `{path?: string; text?: string}` | |
| `commit:saveTemplate` | `{repoId, scope:'repo'|'global', text}` | |
| `commit:coAuthorSuggestions` | `{repoId, q}` → `{name,email}[]` | |
| `signing:config` / `signing:setConfig` | → `SigningConfig` | spec 13 UI |
| `commit:verify` | `{repoId, shas[]}` → `Record<sha,'G'|'B'|'U'|'X'|'Y'|'R'|'E'|'N'>` | lazily for visible rows |

```ts
// Hunks and lines are spec 02's DiffHunk / DiffLine (§5.1): DiffLine.type 'context'|'add'|'del'|'nonewline',
// content (without prefix, keeps a trailing \r), oldLineNo/newLineNo, patchOffset. In §6.5 the patch notation
// ' ' / '+' / '-' stands for type 'context' / 'add' / 'del'.
export type ParsedHunk = DiffHunk;
export interface SigningConfig { format: 'openpgp' | 'ssh' | 'x509'; key?: string; program?: string; signCommits: boolean; signTags: boolean; allowedSignersFile?: string }
```

## 6. Git implementation

Common: the spec 02 §6.1 env/args policy (`-c core.quotepath=false -c color.ui=false`, English `LC_MESSAGES`, `GIT_OPTIONAL_LOCKS=0` for status/diff reads). All patches are handled as **Buffers** (never decoded/re-encoded) to preserve encoding and CR bytes; text decoding only for display.

### 6.1 Status
```
git status --porcelain=v2 -z --branch --untracked-files=all --renames --find-renames=50% --ignore-submodules=none
```
Parse v2 records: `1 XY ...` ordinary, `2 XY ... Rscore path\0origPath` rename/copy, `u XY ...` unmerged, `? path` untracked, `# branch.*` headers. X = index status → staged list; Y = worktree status → unstaged list. A file with X≠'.' and Y≠'.' appears in both. Unborn branch: `# branch.oid (initial)`.
**Unstaged rename detection** *(renames show only once staged — inferred)*: worktree renames appear as `D` (tracked deleted) + `?` (untracked). Optional preference "Detect renames in unstaged" pairs them by running `git diff --no-index`-free approach: `git add -N <untracked>` is **not** used (it mutates the index); instead compare blob hashes `git hash-object <untracked>` vs `git ls-files -s <deleted>` for exact renames only.
Untracked folders: `--untracked-files=all` lists files; for huge untracked trees (>10k, e.g., forgotten `node_modules`) fall back to `--untracked-files=normal` and show the folder as a single row with "Ignore folder" quick action.

### 6.2 File-level stage / unstage / discard
```
git add -- <paths...>                         # stage (handles new + modified)
git add -u -- <paths...>                      # stage deletions (or `git rm --cached --quiet`)
git add -A                                    # stage all (incl. deletions/untracked)
git restore --staged -- <paths...>            # unstage (git ≥ 2.23)
git reset -q HEAD -- <paths...>               # unstage fallback
git rm --cached -q -- <paths...>              # unstage when HEAD unborn (no HEAD to reset to)
git reset -q                                  # unstage all (unborn: git rm -r --cached -q .)
git restore --worktree -- <paths...>          # discard tracked unstaged changes (worktree ← index)
git restore --staged --worktree --source=HEAD -- <paths>  # discard both staged+unstaged ("Discard all" for a file)
git clean -f -q -- <untrackedPaths...>        # discard untracked files (NOT -x; ignored files untouched)
```
Path lists are passed via `--pathspec-from-file=- --pathspec-file-nul` (git ≥ 2.26) on stdin to avoid command-length limits on Windows and to handle special characters; use `--literal-pathspecs` (`GIT_LITERAL_PATHSPECS=1`) so `*`, `[` in filenames are literal.
Discard is journaled first (spec 05 §6.11 snapshot: `write-tree` + `stash create` + untracked tree) so Undo can restore.

### 6.3 Diff for display / patch building
```
git diff --no-color --no-ext-diff --no-renames -U3 --binary -- <path>           # unstaged (index→worktree)
git diff --cached --no-color --no-ext-diff --no-renames -U3 --binary -- <path>  # staged (HEAD→index)
git diff --cached ... 4b825dc642cb6eb9a060e54bf8d69288fbee4904 -- <path>         # staged when unborn (empty tree)
```
Untracked file diff: `git diff --no-index --no-color -- /dev/null <path>` (exit code 1 means differences, so pass `expectedExitCodes:[0,1]`; git treats `/dev/null` specially on every platform, Windows included). `--no-renames` ensures patches name a single path. `diffHash = sha1(rawDiffBuffer)`.

### 6.4 Hunk staging
Hunk patch = file header lines (`diff --git`, `index`, mode lines, `---`, `+++`) + the selected hunk verbatim.
```
git apply --cached --whitespace=nowarn --recount -          # stage hunk (patch on stdin)
git apply --cached --whitespace=nowarn --recount -R -       # unstage hunk (patch from staged diff)
git apply          --whitespace=nowarn --recount -R -       # discard hunk (patch from unstaged diff) — see §6.6 caveat
```
`--recount` makes git ignore line counts in hunk headers (robust against our header math); we still compute headers correctly.

### 6.5 Line staging — patch construction algorithm
Input: `ParsedHunk[]` from the relevant diff, a set `S` of selected `(hunkIndex,lineIndex)`.

**Stage selected lines** (diff = index→worktree; result applied to index with `--cached`, forward):
For each hunk containing ≥1 selected line, build a new hunk:
```
for line in hunk.lines:
  ' '                 → keep as ' '
  '+' and selected    → keep as '+'
  '+' not selected    → omit
  '-' and selected    → keep as '-'
  '-' not selected    → emit as ' ' (line stays in index)
```
Headers: `oldStart = hunk.oldStart` (index side unchanged), `oldLines = count(' ') + count('-')`, `newLines = count(' ') + count('+')`, `newStart = oldStart + cumulativeDelta` where `cumulativeDelta` is the sum of `(newLines − oldLines)` of previously emitted hunks in this patch. If `oldLines == 0` then `oldStart` refers to the line *before* insertion (git convention) — handled naturally because we keep original oldStart. Hunks with no selected lines are dropped entirely.

**Unstage selected lines** (diff = HEAD→index; apply with `--cached -R`):
The patch must describe HEAD→(index with the selected changes reverted):
```
  ' '                 → ' '
  '+' selected        → '+'      (reverse-applying removes it from index)
  '+' not selected    → ' '      (stays in index; in reverse patch it's context present in the "new" side)
  '-' selected        → '-'      (reverse-applying re-adds it to index)
  '-' not selected    → omit     (already absent from index)
```
Headers: `newStart = hunk.newStart` (index side is the "new" side and must match exactly), `newLines = count(' ') + count('+')`, `oldLines = count(' ') + count('-')`, `oldStart = newStart − cumulativeDelta` for previously emitted hunks. Apply with `git apply --cached -R --recount`.

**Discard selected lines** (diff = index→worktree): same transformation as *unstage* (unselected `+` → context, unselected `-` → omit), applied reverse to the worktree — but implemented **in memory** (§6.6) rather than via `git apply`.

**"\ No newline at end of file" handling**: the marker attaches to the immediately preceding line. When the preceding line is omitted, omit the marker. When a `-` line carrying the marker is converted to context while a later `+` line in the same hunk is kept, the result would be invalid (content after a no-EOL line). Rule: if the hunk's last `-` and last `+` lines are the EOF pair, selecting either one auto-selects both (UI shows them linked).

**New (untracked) files**: build patch with header `diff --git a/p b/p`, `new file mode 100644` (or `100755` from `fs.stat` exec bit), `--- /dev/null`, `+++ b/p`, single hunk `@@ -0,0 +1,K @@` with selected `+` lines only (K = count). Applying with `--cached` creates the index entry containing only those lines. If *all* lines selected, prefer `git add -- p` (exact bytes, filters applied).
**Deleted files**: if all `-` lines selected → `git rm --cached -- p` (stage deletion) rather than an empty-file patch; partial selection → normal modification patch (file becomes shorter, not deleted).
**Mode-only changes** (`old mode`/`new mode`): exposed as a pseudo-line "File mode 100644 → 100755" selectable item; staging it alone uses `git update-index --chmod=+x|-x -- p`.

Worked example (stage only `+B2`; the original hunk replaces `b` with `B1`,`B2`):
```
original                         emitted patch
@@ -10,4 +10,5 @@                @@ -10,4 +10,5 @@
 a                                a
-b                                b        ('-' unselected -> context)
+B1                               (omitted: '+' unselected)
+B2   [selected]                 +B2
 c                                c
 d                                d
```
Emitted counts: old side = a,b,c,d (4); new side = a,b,B2,c,d (5). After applying, the index holds `a b B2 c d` and the remaining unstaged diff is `-b +B1` relative to it. Counts are always computed from emitted lines; `--recount` is a second safety net.

### 6.6 Discard lines/hunks in memory (CRLF-safe)
Reason: with `core.autocrlf=true` or `text eol=crlf`, `git diff` output reflects the *clean* (LF) form, while the worktree file has CRLF; `git apply` (worktree) then fails or corrupts EOLs. Algorithm:
1. Read worktree file as Buffer; split into lines keeping EOL bytes; detect dominant EOL.
2. Diff `newNo` numbers map 1:1 to worktree lines (line count is preserved by EOL conversion).
3. Walk selected lines in descending `newNo` order: selected `+` → remove worktree line `newNo`; selected `-` → insert `text + dominantEOL` at the position after the nearest preceding kept line (computed from the hunk ordering).
4. Write atomically (temp file + rename, preserving mode). Encoding untouched (bytes-level; `-` line text bytes come from the diff which is the clean form — for non-UTF-8 files with `working-tree-encoding` attribute, fall back to `git apply -R` and warn).
5. Journal snapshot taken before step 4 (Undo restores).
Hunk discard uses the same routine with all lines of the hunk selected.

### 6.7 Ignore
- Patterns: file → `/path/to/file` (anchored, escape `#`, leading `!`, trailing spaces and `[*?` with backslash); extension → `*.ext`; folder → `/path/to/folder/`.
- Append to `<worktreeRoot>/.gitignore` (create if missing), ensuring the file ends with a newline before appending; preserve the existing EOL style of the file.
- Avoid duplicates: `git check-ignore -q --no-index -- <path>` before writing → if already ignored, toast "Already ignored by <source>" (via `git check-ignore -v`).
- Stop tracking: `git rm -r --cached -q -- <paths>` (staged deletion; file stays on disk).
- `.gitignore` itself shows as modified afterwards (expected).

### 6.8 Commit
Message assembly: `summary.trim()` + (description ? `\n\n` + description : '') + co-author trailers. Trailers added via `git interpret-trailers --if-exists addIfDifferent --trailer "Co-authored-by: N <e>"` on the message file (keeps proper trailer block formatting). Message written to a temp file (UTF-8, LF), passed with `-F`.
```
git commit -F <msgfile> --cleanup=strip [--amend] [--no-verify] [--allow-empty] [-S[<keyid>] | --no-gpg-sign] [--author="N <e>"]
```
- `--cleanup=strip` when the template comment-strip option is on; `--cleanup=whitespace` otherwise (keeps `#` lines).
- Amend with no staged changes and unchanged message → still allowed (rewrites committer date) — UI asks "Nothing changed, amend anyway?".
- Reword HEAD only: `git commit --amend --only -F <msgfile>` (`--only` with no paths ignores staged changes).
- Merge in progress (`MERGE_HEAD` exists): plain `git commit -F <msgfile>` creates the merge commit; composer prefilled from `.git/MERGE_MSG`; amend disabled.
- Squash merge: prefill from `.git/SQUASH_MSG`.
- Cherry-pick/revert conflict resolved: prefill from `.git/MERGE_MSG`; commit with `git cherry-pick --continue` / `git revert --continue` instead (spec 05 banner) so the sequencer state clears.
- Rebase `edit` stop: amend mode forced; after commit, banner prompts *Continue rebase*.
- Hooks stream: spawn with `stdio: pipe` and forward chunks to `commit:hookOutput`. Git doesn't say which hook is printing, so the drawer is labelled "Hook output". Exit code ≠ 0 with HEAD unchanged → `hookFailed` (hook name reported as `pre-commit/commit-msg` unless stderr names it).
- After success: `git rev-parse HEAD` → sha; journal `commit` entry (before = previous HEAD, after = new); clear composer draft (keep co-authors if preference "sticky co-authors").
- Push after commit: enqueue spec 09 push op (`git push` with upstream, or prompt). Failure does not roll back commit.
- Environment for signing: pass through `GPG_TTY` unset, `GNUPGHOME`, `SSH_AUTH_SOCK`; on Windows ensure `gpg.program` resolves (spec 13 setting). Timeouts: none for commits (pinentry may wait for user).

### 6.9 Templates
```
git config --get commit.template            # repo then global (git resolves both; detect scope with --show-origin)
git config --local commit.template .git/githappens/commit-template.txt   # when user saves a repo template and none exists
```
Template path supports `~` expansion; relative paths resolve against repo root. Read text, split into summary/description at first line.

### 6.10 Signing configuration & verification
```
git config --get gpg.format                 # openpgp | ssh | x509
git config --get user.signingkey
git config --get commit.gpgsign / tag.gpgsign
git config --get gpg.program / gpg.ssh.program / gpg.ssh.allowedSignersFile
gpg --list-secret-keys --with-colons        # populate key picker (openpgp)
ssh-add -L                                  # populate ssh key picker; or choose a .pub file
git log --format='%H%x00%G?%x00%GS%x00%GK' --no-walk <shas...>   # verification for visible rows
```
SSH verification requires `gpg.ssh.allowedSignersFile`; without it `%G?` returns `N`/`E` → show "Signed (unverified)". Tag signing for annotated tags in spec 05.

### 6.11 Empty repo / initial commit
- Unborn HEAD: staged diff uses empty tree `4b825dc642cb6eb9a060e54bf8d69288fbee4904`; unstage uses `git rm --cached`; amend disabled; commit is a normal `git commit`.
- Undo initial commit (spec 05): `git update-ref -d HEAD` keeps index → back to unborn with everything staged.

## 7. Step-by-step implementation plan

1. **Status parser** (`packages/git/status.ts`) for porcelain v2 -z incl. renames, unmerged, unborn; fixture-based unit tests (unicode, spaces, newline-in-filename).
2. **`wip:status` + watcher-driven `wip:changed`** event; Zustand `wipStore`; WIP row in graph (spec 04 hook) with counts.
3. **File lists UI**: path view, virtualized rows, selection model, stage/unstage/stage-all/unstage-all with `--pathspec-from-file`.
4. **Tree view + sort** options; persistence.
5. **Discard file/all** with journal snapshot; Undo integration test (discard → undo → bytes identical incl. untracked).
6. **Diff parser** (`packages/git/diffParse.ts`) producing `ParsedHunk` with old/new line numbers, `\ No newline` flags, binary detection; `diffHash`.
7. **Hunk stage/unstage** via `git apply --cached [--reverse] --recount`; hunk toolbar in Monaco (spec 07 decorations API).
8. **Line patch builder** (pure function `buildLinePatch(hunks, selection, mode: 'stage'|'unstage')`) + exhaustive unit tests: middle lines, first/last lines, all-adds, all-deletes, multiple hunks with offsets, EOF no-newline pairs, new file, deletion, CRLF content. Property test: applying the produced patch to a temp index yields expected blob (`git apply --cached --check` + `git show :p`).
9. **Line selection UI** (gutter clicks, shift range, drag paint, split/inline), floating action bar, linked EOF pairs.
10. **In-memory discard** for lines/hunks with CRLF fixtures (`core.autocrlf=true`, `.gitattributes eol=crlf`).
11. **Ignore** menu + `.gitignore` writer + stop tracking.
12. **Commit composer** UI: summary counter, description, paste splitting, drafts persistence, Ctrl+Enter.
13. **`commit:create`**: message file, trailers, cleanup, flags; journal; refresh graph.
14. **Amend** (load message, pushed warning) and **Reword HEAD** path.
15. **Hook detection + streaming output drawer**, failure banner with Retry / Skip hooks.
16. **Push after commit** wiring to spec 09.
17. **Templates** read/write/auto-apply/strip.
18. **Co-author picker** + suggestions.
19. **Signing**: config read/write UI (spec 13 hosts settings page), per-commit toggle, `%G?` verification badges, provider override.
20. **Special states**: merge/squash/cherry-pick/revert/rebase-edit prefills, unborn repo, empty commit option.
21. **EOL warnings** parsing from `git add` stderr; badge + banner.
22. **AI generate button** hook-up (spec 12) — composer exposes `setMessage({summary,description})`.
23. E2E: stage lines across 3 hunks then commit; discard lines in CRLF file; hook failure path; signing with a test GPG key (CI uses ephemeral `GNUPGHOME`).

## 8. Edge cases

- **Partially staged file** appears in both lists; staging a hunk from unstaged when the staged part overlaps — patches are always computed from the *current* diff; `diffHash` mismatch (file changed since render) → reject with "File changed, refreshed" and re-render.
- **File changed on disk between diff and apply** (editor autosave): `git apply --cached` uses index (not worktree) for stage → safe; discard rechecks hash of worktree file before writing.
- **Binary files**: hunk/line staging disabled; file-level only.
- **LFS files**: diff shows pointer text; line staging disabled; file stage uses `git add` (filters run).
- **Submodules**: shown as single row "Submodule commit changed abc→def" (+dirty marker); stage = `git add <sm>`; discard = `git submodule update --init -- <sm>` (confirm). Spec 09 for details.
- **Symlinks / type changes**: file-level only.
- **Renames staged then content edited**: staged list shows R, unstaged shows M on new path.
- **Case-only renames on Windows/macOS** (`Readme.md`→`README.md`): appears as rename via `git mv`; we show both; staging uses `git add -A -- old new`.
- **Unicode / special chars in paths**: always `-z` and pathspec-from-file + literal pathspecs; Windows paths >260 chars need `core.longpaths=true` (offer to set).
- **Newline in filename**: supported by `-z` parsing; display with `⏎` glyph.
- **Huge files (>5 MB diff)**: diff view asks "Load large diff?"; line staging still allowed after loading.
- **Huge number of changes (100k)**: status parse streamed; stage-all uses `git add -A` not a path list.
- **`index.lock`** present: the spec 02 §6.13 lock pre-check and shared lock dialog apply.
- **Conflicted files**: cannot be staged via hunk/line tools; staging a conflicted file (`git add`) marks resolved — confirm if conflict markers still present (scan for `<<<<<<<`).
- **Empty summary but description present**: block commit with tooltip.
- **Message with leading `#`**: with `--cleanup=strip` those lines vanish — composer warns when summary begins with `#` and strip is on.
- **Hooks requiring TTY** (husky with interactive prompts): no TTY → hook may fail; output shown; suggest skip hooks.
- **Hooks on Windows**: git for Windows runs shell hooks via bundled sh; ensure bundled git's `usr/bin` is on PATH for hooks.
- **Signing failure** (no agent / wrong key): commit fails with git stderr "gpg failed to sign the data" → message preserved, button "Commit without signing".
- **Amend on a merge commit**: allowed (git supports); description warns.
- **Amend when HEAD is pushed**: warning only.
- **Bare repo**: WIP and staging hidden entirely.
- **Sparse checkout**: `git add` outside sparse cone errors — show git's message.
- **`core.fileMode=false`**: mode changes hidden by git; nothing special.
- **Autocrlf warnings in stderr** must not be treated as errors (exit code governs).

## 9. Acceptance criteria

- [ ] WIP row appears/disappears within 300 ms of file save/revert; counts correct for M/A/D/R/conflicts.
- [ ] Stage/unstage file, folder, all; discard file/folder/all with Undo restoring exact bytes (tracked + untracked).
- [ ] Path/Tree views and sort options persist.
- [ ] Hunk stage/unstage/discard works on multi-hunk files; header offsets correct (verified by `git diff --cached` content).
- [ ] Line stage/unstage/discard works for: middle lines, single `-`, single `+`, mixed, across hunks, new file partial, EOF no-newline pair, CRLF files with autocrlf on.
- [ ] `buildLinePatch` unit suite ≥ 40 cases passes; property test round-trips 1000 random diffs.
- [ ] Ignore file/extension/folder writes correct anchored patterns to root `.gitignore`; stop tracking removes from index.
- [ ] Summary counter turns amber >50, red >72, never blocks; paste splits lines.
- [ ] Amend loads HEAD message, warns if pushed; reword-only path leaves staged changes staged.
- [ ] Skip hooks passes `--no-verify`; hook failure shows streamed output and preserves message.
- [ ] Commit & push pushes after commit; push failure leaves commit intact.
- [ ] Template auto-applied; `#` lines stripped per option; repo template saved to `.git/githappens/commit-template.txt` when none exists.
- [ ] Co-authors produce well-formed trailers without duplicates.
- [ ] GPG and SSH signing work; badges show G/U/B states; provider verification overrides when available.
- [ ] Initial commit in empty repo; empty commit via ⋯ menu; merge/squash/cherry-pick prefills.
- [ ] Commit is undoable (spec 05) leaving changes staged.

## 10. Out of scope / later

- Staging by word/character (intra-line).
- Nested `.gitignore` editing and `.git/info/exclude` target selection (later: "Ignore ▸ locally only").
- Commit message linting rules (conventional commits validator) beyond AI custom instructions.
- `git add -p`-style "split hunk" smaller than diff hunks (achieved via line selection instead).
- Multiple identities per repo beyond profiles (spec 13).
- Commit Composer (multi-commit AI split) — spec 12.

## 11. Cross-spec dependencies

- **"Commit and Merge" / "Continue Rebase" buttons (shown by spec 08 §6.7, owned here):** the `CommitButton` label and action follow spec 02 `RepoInfo.state`:

  | `RepoState` | Label | Action |
  |---|---|---|
  | `merging` | "Commit and Merge" | `commit:create` (message prefilled from `MERGE_MSG`) |
  | `rebasing` / `rebasing-interactive` | "Continue Rebase" | spec 08 `conflict:continue` with the composer message (commits first if the message was edited) |
  | `cherry-picking` | "Continue Cherry-pick" | `conflict:continue` |
  | `reverting` | "Continue Revert" | `conflict:continue` |

  The button is disabled while spec 02 `git:conflicts` is non-empty (tooltip "Resolve N conflicted files first"). Spec 08's banner "Continue" focuses this button rather than running its own commit, so there is one commit path for hook output, signing and the undo journal.
- **Hunk/line staging inside the spec 07 diff view:** spec 07 hosts the Monaco `DiffView` and exposes hunk action zones anchored on git's hunks (spec 07 §6.4) plus the line-selection gutter. This spec supplies the actions (`wip:stageHunk`, `wip:unstageHunk`, `wip:discardHunk`, `wip:*Lines`), the patch builder (§6.4–6.6) and the `diffHash` guard. Spec 07 disables these actions when a whitespace-ignore option is active (spec 07 §4.5) or for binary/LFS/submodule files (§4.4).
- **"Commit and skip hooks":** the composer's Skip hooks toggle passes `--no-verify` (§4.5, §6.8). The hook-failure banner offers "Commit skipping hooks" (§4.6), which re-runs the same `CommitReq` with `skipHooks: true`. Spec 09 §6.12 owns hook discovery and failure classification (`HookFailed`) and its push equivalent "Retry without hooks". The default comes from spec 13 repo setting `RepoSettings.commitSkipHooksDefault`.
- **Spec 02 types and events:** hunks/lines use spec 02 `DiffHunk`/`DiffLine`. `WipStatus` is derived from `StatusResult`. Refresh is driven by `git:repo:changed`. Path lists go through spec 02's `withPathspec` helper.
