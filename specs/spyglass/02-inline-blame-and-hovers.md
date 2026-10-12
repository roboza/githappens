# S02 — Inline Blame, Hovers, Status Bar Blame and CodeLens

> Spyglass spec. Depends on S01 (git facade, caches, budgets). Reuses spec 02 §6.10 blame parsing (`packages/git` `blameIncremental`, `parseBlamePorcelain`), spec 07 §4.10 blame semantics (uncommitted lines, ignore-revs), spec 10 (PR lookup, avatars, remote links), spec 13 date-format semantics.

## 1. Purpose

Answer "who changed this line, when, and why?" without leaving the editor:

- **Current-line blame**: a faint annotation at the end of the line(s) under the cursor.
- **Hovers**: rich commit details (message, author, date, PR, links, actions) and the line's previous version.
- **Status bar blame**: a compact summary of the current line's commit.
- **CodeLens**: "recent change" and "authors" lenses above the file and code blocks.

These are the features most users install the reference extension for, so they must be fast, quiet by default and fully configurable.

## 2. Reference behavior

- **Inline (current-line) blame** shows, after the end of the active line, a dimmed text with author, relative date and commit subject. It updates as the cursor moves, after a short delay, and can follow every selected line in a multi-line selection. A format string with tokens controls the text; the user can toggle it with a command and per-file. Uncommitted lines show a "you, uncommitted" style annotation.
- **Hovers** appear when hovering the annotation (or optionally anywhere on the line). The **details hover** shows avatar, author, relative and absolute date, commit sha, full message with autolinked issue keys, the associated PR (if a provider is connected), and command links (open commit details, open changes, compare with previous, copy sha, open on remote, explain with AI, open in the desktop app). The **changes hover** shows the line's diff against the previous revision, with a toggle to show the whole hunk.
- **Status bar** shows author and relative date of the current line's commit; clicking runs a configurable command (default: show commit details/quick pick); hovering shows the details hover.
- **CodeLens** offers two lenses: "recent change" (author and date of the most recent commit touching the scope) and "authors" (count and the top author). They can apply to the document, to containers (classes/modules) and to blocks (functions/methods), using the document's symbols. Clicking a lens runs a configurable action (show commit, file history, toggle blame, quick pick). Lenses can be disabled per language.
- **Autolinks**: issue references (`#123`, `JIRA-42`) in messages are turned into links using provider info and user-defined patterns (prefix + URL template). Some providers' references get enriched titles when connected.
- These features are free in the reference extension *(the AI explain and PR enrichment links in hovers depend on account/plan)*.

## 3. User stories

1. As a developer, I want to see who last changed the current line and why, so I don't have to run `git blame`.
2. As a developer, I want the annotation to stay out of the way while I type, and only appear when I pause.
3. As a reviewer, I want the hover to show the PR that introduced the line, so I can read the discussion.
4. As a developer, I want to see what the line looked like before, without opening a diff.
5. As a team lead, I want "authors" lenses to see who knows a function best.
6. As a user with custom issue trackers, I want `ACME-123` in commit messages to link to our tracker.
7. As a screen-reader user, I want the blame information available through the status bar and an accessible command, not only through decorations.

## 4. UI specification

### 4.1 Current-line annotation

- Rendered with one `TextEditorDecorationType` (`after` attachment, `rangeBehavior: ClosedClosed`, `isWholeLine: false`) applied to the end of each annotated line.
- Text: `spyglass.currentLine.format`, default `${author}, ${agoOrDate} • ${message}`. Max 50 chars message (`spyglass.currentLine.messageMaxLength`, truncation with `…`). Uncommitted: `${you}, uncommitted changes` (localized).
- Style: theme colors `spyglass.currentLineForeground` (default `#99999959` dark / `#99999990` light), `spyglass.currentLineBackground` (transparent), margin `0 0 0 3em`, font style italic off; honours `spyglass.currentLine.fontFamily/fontSize/fontStyle` (empty = editor default).
- Scope: `spyglass.currentLine.scope` = `line` (cursor line only, default) | `selection` (each line of each selection, max 30 lines).
- Timing: shows after `spyglass.currentLine.delay` (default 150 ms) of cursor rest; hidden immediately on typing in that line (`onDidChangeTextDocument`) and shown again after rest.
- Visibility: toggled globally by `spyglass.currentLine.enabled` (default `true`) and per window by `spyglass.toggleLineBlame` (session only). Hidden when: document is not in a repo, file is ignored, the line is beyond EOF, the editor is a diff editor's left side (configurable), or the document has > `spyglass.blame.maxLines` lines.
- Pull-request suffix *(our extension, optional)*: `${pr}` token renders `#123` when a PR is cached for the commit; never triggers a network call by itself.

### 4.2 Format tokens

Our own token syntax: `${name}` or `${name|width}` (pad/truncate to width) or `${name?prefix:suffix}` (emit with affixes only when non-empty).

| Token | Value |
|---|---|
| `author` | author name; `You` when author email equals `user.email` of the repo (configurable `spyglass.blame.showYou`) |
| `authorEmail`, `authorFirst`, `authorInitials` | variants |
| `ago` | relative ("3 weeks ago"), localized via `Intl.RelativeTimeFormat` |
| `date` | absolute, `spyglass.dateFormat` (`iso` \| `short` \| `long` \| custom pattern; same semantics as spec 13 `ui.dateFormat`) |
| `agoOrDate` | relative if newer than `spyglass.blame.relativeDateCutoffDays` (default 30) else absolute |
| `sha`, `shortSha` | full / abbreviated (`core.abbrev` or 7) |
| `message` | subject (first line) |
| `pr` | `#<number>` of the associated PR if cached |
| `committer`, `committerAgo` | committer variants |

Tokens are parsed once per format change into a compiled template (no `eval`).

### 4.3 Hover

Registered as a `HoverProvider` for `{ scheme: 'file' }`, `{ scheme: 'vscode-remote' }`, `{ scheme: 'spyglass' }`, `{ scheme: 'git' }`.

- `spyglass.hovers.enabled` (default `true`), `spyglass.hovers.currentLine.over` = `annotation` (only when the mouse is over the annotation's range: we check `position.character >= lineLength`) | `line` (anywhere on the line).
- `spyglass.hovers.annotations.over` = same for full-file annotations (S03).
- Two sections, each togglable: `spyglass.hovers.details` (default `true`), `spyglass.hovers.changes` (default `true`), `spyglass.hovers.changesDiff` = `line` | `hunk` (default `line`).
- Rendered as `MarkdownString` with `isTrusted: { enabledCommands: [...spyglass command ids] }` and `supportThemeIcons: true`, `supportHtml: false`.

Details section layout (top to bottom):

1. Avatar (16 px, `![](uri)` from `AvatarCache`) + **author** + `<email>` link to compose-in-search (opens S04 search `@email`) + relative date + absolute date in parentheses.
2. Commit message: subject bold, body as markdown-escaped text (no HTML), with autolinks (§6.4). Max 30 body lines, then "…show more" (command opens commit details).
3. PR line (when a provider is connected): state icon (`$(git-pull-request)`, merged/closed/draft variants), `#123 Title` link to the PR, "opened by X". Loaded asynchronously: the hover is first returned without it; when the PR resolves within `spyglass.hovers.prTimeoutMs` (default 800 ms) we return the enriched hover; otherwise the PR shows next time from cache.
4. Command row (theme icons with tooltips): Open Commit Details · Open Changes · Open Changes with Working File · Compare with Previous Revision · Blame Previous Revision · Copy SHA · Open on Remote · Explain (AI, only when AI is enabled) · Open in GitHappens (only when the app is detected, S08).
5. Footer: `sha` (short) and "Committed by X" when committer ≠ author.

Changes section: a fenced ```` ```diff ```` block with the previous and current version of the line (or hunk), max 20 lines; header "Changed in `abc1234` • compare". For uncommitted lines it compares the working file with the index or HEAD ("Uncommitted changes").

### 4.4 Status bar

- `StatusBarItem` id `spyglass.blame`, alignment from `spyglass.statusBar.alignment` (`left` default *(our choice)* | `right`), priority 1000.
- Text: `spyglass.statusBar.format`, default `$(git-commit) ${author}, ${agoOrDate}`. Tooltip: the details hover markdown (`MarkdownString` tooltip, same builder).
- Click: `spyglass.statusBar.command` enum: `showCommitDetails` (default), `showQuickCommitMenu`, `toggleFileBlame`, `toggleLineBlame`, `showFileHistory`, `showLineHistory`, `openOnRemote`, `copySha`, `revealInGraph`, `openInGitHappens`.
- Also `spyglass.statusBar.enabled` (default `true`), `spyglass.statusBar.reduceFlicker` (keep last text while loading; default `true`).
- Accessibility: `accessibilityInformation.label` = "Blame: <author>, <absolute date>, commit <short sha>, <subject>". Command `spyglass.announceLineBlame` reads the same string through `window.showInformationMessage` with `{ modal: false }` (screen readers announce notifications).

### 4.5 CodeLens

- `CodeLensProvider` for the same schemes as hovers; `spyglass.codeLens.enabled` (default `false` *(our default: lenses shift code lines, which many users dislike)*).
- Scopes: `spyglass.codeLens.scopes` array of `document` | `containers` | `blocks` (default `["document", "containers"]`). Symbols come from `vscode.executeDocumentSymbolProvider`; containers = Class, Module, Namespace, Interface, Struct, Enum; blocks = Function, Method, Constructor, Property (with body > 1 line).
- `spyglass.codeLens.symbolScopes` exclusions per symbol kind (e.g. `["!Module"]`).
- `spyglass.codeLens.excludeLanguages` (default `[]`), `spyglass.codeLens.includeSingleLineSymbols` (default `false`).
- Lenses: **Recent change** — text `${author}, ${ago}`; **Authors** — text `N authors (Top Author and others)`. Each togglable (`spyglass.codeLens.recentChange.enabled`, `spyglass.codeLens.authors.enabled`) with its own click command enum (`showCommitDetails`, `showQuickCommitMenu`, `showFileHistory`, `showLineHistory`, `toggleFileBlame`, `toggleFileHeatmap`, `showAuthorsQuickPick`, `none`).
- `provideCodeLenses` returns unresolved lenses with ranges only (cheap); `resolveCodeLens` fills titles from the shared blame result.
- Dirty documents: lenses are hidden while the document is dirty if `spyglass.codeLens.hideWhenDirty` (default `true`), to avoid jumping.

### 4.6 Quick commit menu

`spyglass.showQuickCommitMenu` (from status bar, lens, hover, command palette): a `QuickPick` with the commit header as title and items: Open Commit Details, Open Changes, Open All Changes (multi-diff editor), Compare with HEAD/Working Tree, Show in Graph, Show File History, Copy SHA / Message, Open on Remote, Cherry-pick / Revert / Create Branch / Create Tag here (mutations confirm first), Explain (AI), Open in GitHappens.

## 5. Data model & contracts

```ts
export interface BlameRequest {
  rev?: Sha | 'HEAD';                 // undefined = working tree
  contents?: string;                  // dirty buffer for --contents -
  ignoreWhitespace?: boolean;         // spyglass.blame.ignoreWhitespace
  detectMoves?: boolean;              // -M (spyglass.blame.detectMoves, default false)
  detectCopies?: boolean;             // -C (spyglass.blame.detectCopies, default false)
  ignoreRevsFile?: 'auto' | 'off';    // auto = git honors blame.ignoreRevsFile; off = --ignore-revs-file=""
  signal?: AbortSignal;
}

export interface LineBlame {           // per editor line, derived from spec 02 BlameResult
  line: number;                       // 0-based editor line
  sha: Sha;                           // '0000…' for uncommitted
  origLine: number;
  commit: BlameCommitInfo;            // spec 02 type (author, authorMail, authorTime, summary, previous …)
  previous?: { sha: Sha; path: string };
}

export interface CommitPresentation {   // input to the format/hover builders
  sha: Sha; shortSha: string;
  author: { name: string; email: string; isYou: boolean; avatar?: vscode.Uri };
  committer: { name: string; email: string; time: number };
  authorTime: number;
  subject: string; body?: string;     // body loaded lazily (CommitCache)
  uncommitted: boolean;
  pr?: PullRequestSummary;            // spec 10 normalized PR (number, title, state, url)
  remoteUrl?: string;                 // commit web URL (spec 10 web links)
}

export interface AutolinkPattern {      // spyglass.autolinks[]
  prefix: string;                     // e.g. "ACME-"
  url: string;                        // e.g. "https://jira.acme.com/browse/ACME-<num>"
  alphanumeric?: boolean;             // default false: <num> must be digits
  ignoreCase?: boolean;
  title?: string;                     // optional label in hovers
}
```

Placeholder in `AutolinkPattern.url` is `<num>` *(our syntax)*.

## 6. Implementation details

### 6.1 Blame pipeline

1. `onDidChangeTextEditorSelection` (and active editor change) → debounce by `currentLine.delay`.
2. Resolve repo (`RepositoryRegistry.getForUri`) and path. Skip untracked files (`git ls-files --error-unmatch` result cached per path until `status` scope changes) — shown as nothing (or `Untracked` if `spyglass.currentLine.showUntracked`).
3. `BlameCache.get(key)`; on miss, start `blameIncremental` (`git blame --incremental [-w] [-M] [-C] [--contents -] [<rev>] -- <path>`). The current line is answered as soon as its range arrives (progressive); the full result completes the cache entry.
   - For a single cursor line in a cold file larger than 2,000 lines, run a fast `git blame --porcelain -L <n>,<n>` in parallel and use whichever answers first.
4. Render the annotation for the cursor line(s); build `CommitPresentation` from the blame commit map; body is not needed for the annotation.
5. Cancel in-flight work when the editor or line changes (AbortSignal → runner kills git).

### 6.2 Shifting cached blame for edits

`TextDocumentChangeEvent.contentChanges` are applied to the cached `LineBlame[]`: deleted lines removed, inserted lines marked uncommitted, modified lines marked uncommitted. After `dirtyDelay` idle, the true blame is recomputed with `--contents -`. On save, the working-tree entry is recomputed without `--contents`.

### 6.3 PR association

- For a commit sha and the repo's provider `RepoRef` (spec 10 §5.1), look up the PR that introduced it:
  - GitHub: GraphQL `commit.associatedPullRequests(first: 1)`, batched for up to 50 shas per request.
  - GitLab: `GET /projects/:id/repository/commits/:sha/merge_requests`.
  - Bitbucket Cloud: `GET /repositories/{ws}/{repo}/commit/{sha}/pullrequests`.
  - Azure DevOps: `pullrequestquery` with `commits` *(per spec 10 §6.2 provider client)*.
- Merge-commit fallback without a provider: parse `Merge pull request #N` / `(#N)` in the subject (works offline).
- Results cached by sha in `globalState` (immutable mapping once merged), 2 min for "not found".
- Only performed when `spyglass.hovers.pullRequests` (default `true`) and a provider session exists (S09 §6.1). Never prompts for sign-in from a hover.

### 6.4 Autolinks

Order: (1) user `spyglass.autolinks` patterns, (2) provider references (`#123`, `GH-123`, `!123` for GitLab MRs, `owner/repo#123`), (3) connected tracker keys (Jira project keys from spec 10 when connected). Linkified only in hovers, commit details and tree tooltips. Issue titles are fetched only when `spyglass.autolinks.enrich` (default `true`) and connected, with the same async pattern as PRs.

### 6.5 Remote URLs

"Open on Remote" builds commit/file/line URLs with spec 10 web-link builders from the remote of the current branch's upstream, else `origin`, else the first remote. `spyglass.remotes` (S11) lets users map custom hosts to a provider type and URL templates for self-hosted servers.

### 6.6 Decoration lifecycle

- One decoration type for the current line, created on activation and disposed on deactivate; re-created when style settings change.
- `editor.setDecorations(type, [])` when hiding. Decorations are applied only to `window.visibleTextEditors` that show the active document.
- The annotation must never be included in copy/paste or affect layout beyond the line end (`after` content is non-selectable by design).

## 7. Step-by-step implementation plan

1. Format template compiler + unit tests (all tokens, widths, affixes, unicode names).
2. `BlameService` over `SpyglassGit.blame` with cache, progressive answer, single-line fast path, cancellation. Unit tests with fixture repos.
3. Current-line controller (debounce, scope line/selection, hide on typing). Integration test: move cursor in a fixture file; assert decoration text via a test-only command `spyglass.debug.currentAnnotations`.
4. Edit shifting + `--contents -` dirty blame. Test: insert lines, assert uncommitted markers then real blame after idle.
5. Hover builder (details + changes) with command links; snapshot tests of the markdown.
6. Status bar item + click commands + accessibility label.
7. CodeLens provider (symbols, scopes, resolve). Integration test with a TypeScript fixture.
8. PR association via provider hub (msw-mocked tests) and offline merge-subject fallback.
9. Autolinks (user patterns + provider refs). Unit tests.
10. Quick commit menu.

## 8. Edge cases

- **Uncommitted / untracked / ignored / new files**: annotation says "uncommitted" (modified lines), nothing for untracked unless enabled, nothing for ignored.
- **Boundary commits** (shallow clones): blame lines with `boundary` show "(shallow history boundary)" in the hover; no "previous revision" actions.
- **Renamed files**: blame follows content; the hover shows the `filename` of the originating commit when different ("in `old/path.ts`").
- **`.git-blame-ignore-revs`**: honored automatically when `blame.ignoreRevsFile` is configured; the hover footer notes "Ignoring revisions from …". If a file named `.git-blame-ignore-revs` exists but the config is not set, offer once to enable it for the repo (`git config blame.ignoreRevsFile .git-blame-ignore-revs`) *(our extension)*.
- **CRLF**: line count from VS Code's document; `--contents -` sends the buffer with its EOLs.
- **Very long lines / minified files**: annotations are skipped for lines > 10,000 chars and files listed in `files.exclude`-like `spyglass.blame.excludeGlobs` (default `["**/*.min.js", "**/dist/**"]`).
- **Merge conflicts in the file**: blame still works on working tree; conflict marker lines show "uncommitted".
- **Detached HEAD, during rebase**: blame is relative to the working tree, unaffected.
- **Submodule pointer lines** — n/a (submodules are not text).
- **LFS files**: no blame (pointer file); annotation hidden.
- **Notebooks**: cells are blamed only via the notebook file's text if `spyglass.blame.notebooks` (default off).
- **Author name collisions with "You"**: `isYou` uses email comparison (case-insensitive), with `user.email` per repo.

## 9. Acceptance criteria

- [ ] Annotation appears ≤ 50 ms after the delay when blame is cached, ≤ 700 ms cold for a 10k-line file.
- [ ] Typing on a line hides its annotation instantly; it reappears after the pause with "uncommitted".
- [ ] Hover shows author, dates, message, sha, autolinks and command links; PR appears when connected.
- [ ] Changes hover shows the correct previous version of the line, including for lines whose file was renamed.
- [ ] Status bar shows the same commit as the annotation; click runs the configured command.
- [ ] CodeLens recent-change and authors lenses match `git blame` data for the symbol range.
- [ ] All features off by setting leave zero decorations, lenses and status items.
- [ ] No provider network calls when no provider is connected.

## 10. Out of scope / later

- Blame for notebooks' cell-level history.
- "Blame of the blame" chains in a single hover (navigating `previous` repeatedly) — handled by "Blame Previous Revision" command instead.
- Inline display of PR review comments next to lines.

## 11. Cross-spec dependencies

- **Spec 02 §6.10** blame grammar and `BlameResult`/`BlameCommitInfo` types; **spec 07 §4.10/§6.8** blame options and size limit.
- **Spec 10** PR lookup per commit, web links, avatars (`avatar:resolve` logic reimplemented in Spyglass with the same sources: provider avatar → Gravatar (opt-in) → initials).
- **S03** shares `BlameService` and hover builder; **S04** provides the commit details target of most hover links; **S08** "Open in GitHappens"; **S10** "Explain"; **S11** settings, commands and theme colors.
