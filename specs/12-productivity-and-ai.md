# 12 — Productivity & AI

> Depends on: 01 (app shell, command palette, toolbar, panels), 02 (GitService, IPC, OperationQueue), 04 (graph search highlight/filter hooks), 05 (interactive rebase engine, Git Flow command layer, undo journal), 06 (commit composer, staging), 07 (diff viewer), 08 (conflict tool), 10 (PR creation), 13 (preferences, keybindings, secrets). Cross-link: 14 (Code Suggest / cloud patches).

## 1. Purpose

GitHappens layers productivity tools on top of its graph: an **integrated terminal** that follows the active repo, **AI assistance** (commit messages, explanations, stash messages, conflict resolution, PR descriptions, multi-commit composition), fast **search/filter** and a **fuzzy file finder**, **Git Flow** shortcuts, and **Open in…** integrations with external tools. These features cut down context switching, and the AI features turn chores like writing messages and summarizing diffs into one click. This spec defines all of them. AI defaults to Anthropic Claude (`claude-sonnet-5-5`), and the provider and key are configurable.

## 2. Reference behavior

Items marked *(inferred)* are design decisions rather than documented behavior.

### 2.1 Integrated terminal
- Opened from the toolbar Terminal button or the Command Palette ("terminal"). It docks as a bottom panel under the graph. A full "terminal tab" mode shows a compact graph next to the terminal *(inferred)*. The default toggle shortcut is commonly Ctrl/Cmd+` *(inferred)*.
- Multiple tabs (+ button). **Each repository/worktree keeps its own tab set**, and long-running commands keep running when you switch repos or worktrees.
- **Git autocomplete**: typing `git` shows suggestions for subcommands and their flags. Other autocomplete tools can conflict. Configured under Preferences → In-App Terminal.
- Shell: the OS default on macOS/Linux (zsh/bash). On Windows, Preferences → Terminal chooses PowerShell or Bash (Git Bash).
- Appearance: font family, size, line height, cursor style.
- The panel can be minimized to its header. A trash icon ends the session. Dragging a file from the OS or the Commit Panel into the terminal inserts its path.
- A separate command-line companion with commands for workspaces, PRs, issues, AI commit and graph output is out of scope; Desktop does not depend on one *(inferred)*.

### 2.2 AI assistance
| Feature | Where | Behavior |
|---|---|---|
| Generate commit message | Sparkle button next to commit summary | Summary + description generated from **staged** changes; also offered when amending. |
| Explain commit(s) | Commit Panel "Explain" on one or more selected commits | Plain-language summary of the changes. |
| Explain branch changes | Right-click branch / HEAD commit | Summarizes the diff from base (merge-base) to the branch head; commits are chosen automatically. |
| Stash message | Sparkle in stash UI | Generates a message from staged changes. |
| Auto-resolve conflicts (Preview) | Conflicted file in merge tool | Proposed resolution per hunk with an explanation and a **confidence level**. The user reviews, edits, and accepts or discards. |
| PR title & description | Create-PR form | Generates both and honors a selected PR template. |
| Commit Composer (Preview) | "Compose commits with AI" on staged changes, or recompose a contiguous commit range | Splits changes into proposed commits. The user can reorder, squash, and edit messages, and nothing happens until "Create commits". Undoable. |
| Custom instructions | Preferences → AI | Global instructions plus per-feature ones (commit msg, explain, stash, PR, conflicts, composer), e.g. "use conventional commits". |
| Providers | Preferences → AI | A hosted default, or BYOK: OpenAI, Azure, Anthropic, Gemini, or a Custom URL (e.g. local Ollama). Admins can disable AI at the org level. |
- Changelog generation is **not** a documented Desktop feature (it exists in the `gk` CLI/GitLens *(inferred)*). We include it as our own extension.

### 2.3 Search, filter, palette
- Commit search (Ctrl/Cmd+F): matches message, SHA, and author, highlights matches in the graph, and steps through them with Enter/Shift+Enter. It only covers loaded history (default 2,000 commits, configurable, or "show all").
- Left-panel filter box (Ctrl/Cmd+Alt+F *(inferred)*) filters branches, tags, remotes, and stashes by name.
- Hide/Solo branches (spec 04).
- **Command Palette** Ctrl/Cmd+P runs actions (checkout, create branch, rename, etc.).
- **Fuzzy finder** for files: the palette includes file search that opens a file in the in-app editor or file history *(inferred: "Open file" in palette)*.

### 2.4 Git Flow
- Preferences → Gitflow: branch names (main/develop), prefixes, and version tag prefix. Initializing creates `develop` locally if it is missing.
- A Gitflow section in the left panel has a green action button (Start Feature/Release/Hotfix). Right-click a flow branch → Finish. Feature finish can optionally rebase on develop first. Release finish merges into main and develop and creates a tag (with a tag message dialog). Hotfix branches start from main and finish into both.

### 2.5 Open in external apps
- Commit/file context menus: "Open in default program", "Show in folder/Finder/Explorer", "Open in external editor" (configured in Preferences → General → External editor, e.g. VS Code, Sublime, Atom), "Open in terminal" (external terminal, configurable) *(inferred list)*. Repo-level "Open repo in file manager / terminal / editor".

### 2.6 Code Suggest
Cloud-based code review suggestions on PRs. Covered as optional in spec 14; this spec only defines how AI can draft suggestion text.

## 3. User stories

1. As a CLI-comfortable developer I want a terminal docked under the graph that opens in my repo's root and remembers its tabs per repo.
2. As a developer I want git subcommand and flag hints as I type in the terminal.
3. As a developer I want one click to get a good commit message from my staged changes, in my team's style.
4. As a reviewer I want "Explain" for a commit or a branch so I can understand changes quickly.
5. As a developer I want AI help on conflicted hunks, with a confidence level, without anything applied automatically.
6. As a developer I want PR titles and descriptions drafted from my branch's commits and diff, following the repo's template.
7. As a developer I want to split a messy working tree into logical commits with AI and still be able to undo.
8. As a privacy-conscious user I want to pick the AI provider and use my own API key, or turn AI off completely.
9. As a power user I want a fuzzy finder (files and commands) and graph search/filter.
10. As a Git Flow team I want start/finish actions for feature/release/hotfix branches.
11. As a developer I want to open the repo or a file in my editor, file manager, or external terminal.
12. As a release manager I want a changelog draft for a range of commits.

## 4. UI specification

### 4.1 Component tree
```
<AppShell>
  <Toolbar> … <TerminalToggleButton/> <AiMenuButton (sparkle)/>
  <RepoView>
    <BottomDock>                                   (resizable, collapsible to header)
      <TerminalPanel repoId>
        <TerminalTabBar> tabs · [+] · [shell ▾] · [trash] · [minimize] · [maximize]
        <XtermView ptyId/>                         (one per tab; hidden tabs keep their pty alive)
        <GitAutocompletePopup/>                    (anchored to cursor cell)
    <GraphSearchBar/>                              (spec 04 hosts highlight; this spec owns query UI)
    <LeftPanel> <PanelFilterInput/> <GitFlowSection/>
  <CommandPalette mode="commands|files|branches|commits"/>
  <AiPanels>
    <AiCommitMessageButton/> (embedded in spec 06 composer)
    <ExplainPanel target/>   (right panel tab "Explain")
    <AiConflictAssist/>      (embedded in spec 08 merge tool)
    <AiPrDraftButton/>       (embedded in spec 10 PR form)
    <CommitComposerView/>    (center view, §4.6)
    <ChangelogDialog/>
  <Preferences> … <TerminalPrefs/> <AiPrefs/> <GitFlowPrefs/> <ExternalAppsPrefs/>  (spec 13 host)
```

### 4.2 Terminal panel
- Toggle: toolbar button, Ctrl/Cmd+` (configurable), palette "Toggle Terminal". Opening creates the first tab if none exist.
- **cwd**: the repo worktree root (for worktrees, that worktree's path). A tab bar label shows `shellName — repoName`. New tabs inherit the cwd of the active tab's current directory *(we track it with OSC 7 if the shell emits it, otherwise we fall back to the repo root)*.
- **Per-repo sessions**: `TerminalStore` maps `repoId → TerminalTab[]`. Switching repo tabs swaps the visible set. Ptys keep running in the background. Closing a repo tab prompts if a process other than the shell is running (detected via node-pty `process` property).
- **Maximize** mode fills the center area. A thin "mini graph" strip of the last 20 commits is shown at the top *(inferred, like the terminal tab; optional)*.
- Context menu: Copy, Paste, Select All, Clear, Find (xterm search addon), Split right *(later)*.
- Links: URLs are clickable via xterm web-links addon and open in the browser. File paths matching `path:line` open in the in-app editor (spec 07) with Ctrl/Cmd+click.
- Drag & drop: a file from the OS or the Commit Panel inserts its shell-quoted path.
- **Auto-refresh**: after a command finishes (detected by prompt return via OSC 133 shell integration, or by a 500 ms idle fallback), we trigger a repo refresh. The RepoWatcher usually catches changes already. This covers `.git` changes that the watcher debounces.
- Empty/error states: if pty spawn fails, an inline error "Could not start <shell>: <message>" with an "Open terminal settings" button.

### 4.3 Git autocomplete
- Activates when the current input line (tracked from keystrokes since the last prompt; with OSC 133 we know prompt boundaries) starts with `git `.
- Suggestions:
  - 1st token: subcommands (static list of porcelain plus the user's aliases from `git config --get-regexp ^alias\.`).
  - Flags: per-subcommand static table (`packages/git/completions.json`, generated at build time from `git <cmd> --git-completion-helper`, which git ships for bash completion).
  - Ref arguments (for checkout/switch/merge/rebase/branch -d/push/cherry-pick): local/remote branch and tag names from the repo store (no extra git calls).
  - Paths for add/restore/rm: changed files from the WIP status first, then the file tree.
- UI: popup below the cursor with up to 8 items and a description column. Tab/Enter accept (inserts the remainder), Esc dismisses, ↑/↓ navigate. It never intercepts Enter when the popup is closed.
- Setting: `terminal.autocomplete` (boolean, spec 13). It is automatically suppressed when we detect a conflicting completion tool (e.g., Fig/Amazon Q env var `TERM_PROGRAM` variants *(heuristic)*) and the user is told why.

### 4.4 AI entry points
| Entry | UI | States |
|---|---|---|
| Commit message | Sparkle button right of summary (spec 06). Click → spinner in button; the summary/description fill progressively (streamed). Undo restores the previous text (Ctrl+Z in field). A ▾ menu: "Regenerate", "Shorter", "Conventional commit", "Explain staged changes instead". | disabled when nothing staged (tooltip), AI disabled, or no key |
| Explain commit(s) | Right panel tab "Explain" when commit(s) selected; button "Explain with AI". Output is streamed markdown with sections: Summary, Notable changes, Risks. Copy button. | |
| Explain branch | Branch context menu "Explain branch changes" → Explain tab with the target branch's base→head range header ("12 commits, 34 files vs main") | |
| Explain WIP *(ours)* | WIP node context menu | |
| Stash message | Sparkle in stash dialog (spec 05 §4.9) | |
| Conflict assist | Merge tool header "Resolve with AI". Per-hunk proposal card: proposed text (diff vs ours/theirs), explanation, confidence badge (High/Medium/Low), [Accept] [Edit] [Reject]. "Accept all high-confidence". Nothing is written until Accept. | |
| PR draft | PR form "Generate title & description" (spec 10). Uses the chosen template. | |
| Commit Composer | WIP context menu / Commit Panel ⋯ "Compose commits with AI"; graph multi-select on current branch "Recompose N commits with AI" | |
| Changelog *(ours)* | Range selection or two-tag selection → "Generate changelog" → dialog with editable markdown, Copy / Save to CHANGELOG.md (prepend) | |

Global: when AI is disabled (pref or org policy), all sparkle buttons are hidden, not just disabled. The first use shows a **one-time consent dialog** listing what is sent (diffs, file paths, commit messages) and to which provider/endpoint.

### 4.5 AI preferences (hosted in spec 13 page "AI")
- Enable AI features (master switch).
- Provider: **Anthropic (default)** | OpenAI | Azure OpenAI | Google Gemini | Custom OpenAI-compatible URL (Ollama, LM Studio).
- API key field (stored with SecretStore; shows "••••abcd" and a Test button that sends a tiny request).
- Model: free-text + suggestions per provider. Anthropic default `claude-sonnet-5-5`.
- Effort (Anthropic): low | medium | high (default `low` for commit/stash messages, `medium` for explain/PR/changelog, `high` for conflicts/composer). Each is overridable per feature.
- Max diff size sent (default 120k chars). Exclude path globs (default: lockfiles, `*.min.js`, `dist/**`, binary, `.env*`).
- Custom instructions: Global plus per feature (commit, explain, stash, PR, conflicts, composer, changelog). Also a **repo-level** file `.githappens/ai-instructions.md` merged after global *(ours)*.
- Commit message style: free / conventional commits / gitmoji; language (default UI language).

### 4.6 Commit Composer view
```
<CommitComposerView>
  <Header> "Compose commits — 14 files, 312 lines"   [Regenerate] [Cancel] [Create commits]
  <ProposalList>               (dnd reorder; each card collapsible)
    <ProposedCommitCard>
      summary/description inputs · file+hunk chips (drag chips between cards) · [Squash into above] [Delete → returns hunks to "Unassigned"]
  <UnassignedBucket/>          (hunks not placed; must be empty or will remain uncommitted — warned)
  <HunkPreview/>               (diff of selected chip)
```
- "Create commits" runs as one composite op with a single journal entry (spec 05 kind `ai-compose`) → one Undo restores the original state.
- Recompose mode: the input is the combined diff of a contiguous range `A^..B` on the current branch. The output replaces the range. **v1 requires B == HEAD** (no replay). Later versions will replay commits above B via cherry-pick.

### 4.7 Search & filter
- Graph search bar (Ctrl/Cmd+F): input with mode chips **Message · Author · SHA · File path · Content (pickaxe)**. Default: message+author+SHA. Results count "3 of 41", Enter/Shift+Enter navigate, and the graph scrolls to and selects the match. Toggle "Filter graph" hides non-matching rows (spec 04 renders the filtered row set with collapsed edges) vs the default highlight mode.
- Search scope: loaded commits are searched in memory first (instant). A button "Search entire history" runs a git query (§6.7) and loads matches into the graph through spec 04 `graph:revealCommit` (loads history until the hit is laid out).
- Left panel filter: substring + fuzzy on ref names. Matches in collapsed folders auto-expand them.

### 4.8 Command palette & fuzzy finder
- Ctrl/Cmd+P opens the palette in **commands** mode. Ctrl/Cmd+Shift+O opens it in **files** mode *(ours)*. Typed prefixes switch mode: `>` commands, `@` branches, `#` commits (message/SHA), `:` go to line in the open editor. With no prefix, the palette stays in the mode it was opened in.
- Fuzzy matching: fzf-like scoring (consecutive bonus, word-boundary bonus, path-segment bonus). Highlight matched chars. Max 200 results, virtualized.
- Files mode: tracked + untracked-not-ignored files (`git ls-files -co --exclude-standard -z`), cached per repo and refreshed by the watcher. Actions: Enter = open in in-app editor (spec 07), Ctrl/Cmd+Enter = file history, Alt+Enter = blame, Shift+Enter = open externally.
- Recent items float to top (MRU per repo).

### 4.9 Git Flow UI
- Left panel **GITFLOW** section (visible when `gitflow.branch.develop` is configured; otherwise a "Initialize Git Flow" link appears in its header ⋯ menu).
- Header green "+" button → menu: Start Feature / Start Release / Start Hotfix. Each opens an inline name input (prefix shown as a non-editable chip, e.g. `feature/` + name).
- Lists feature/release/hotfix branches grouped. Right-click → Finish <type> <name>, Publish (push with upstream), Delete.
- Finish dialog:
  - Feature: ☐ Rebase on develop before merging, ☑ Delete branch after finish, ☐ Push develop.
  - Release/Hotfix: tag name (prefill `<versiontagprefix><name>`), tag message (required, multi-line), ☑ Delete branch, ☐ Push main, develop and tags.
- Init dialog (also Preferences → Git Flow): main branch, develop branch, prefixes (feature/, release/, hotfix/, support/), version tag prefix. Buttons: Initialize / Cancel. "Reset to defaults".

### 4.10 Open in…
- Repo menu (toolbar repo name ▾ and palette): Open in File Manager, Open in Terminal (external), Open in Editor.
- File context menus (staging, tree, diff): Open in external editor, Open with default program, Show in folder, Copy full path.
- Commit context menu: "Open on <provider>" (spec 10 link builder).
- Preferences: external editor (detected list: VS Code, VS Code Insiders, Cursor, Sublime, JetBrains IDEs, Vim/Neovim in terminal, custom command with `{path}` `{line}` placeholders), external terminal (detected: Windows Terminal, PowerShell, Git Bash, cmd; macOS Terminal, iTerm2, Warp, Ghostty; Linux gnome-terminal, konsole, xterm, kitty, alacritty, custom with `{cwd}`).

### 4.11 Shortcuts (defaults; rebindable in spec 13)
| Action | Win/Linux | macOS |
|---|---|---|
| Toggle terminal | Ctrl+` | Cmd+` |
| New terminal tab | Ctrl+Shift+` | Cmd+Shift+` |
| Command palette | Ctrl+P | Cmd+P |
| File finder | Ctrl+Shift+O | Cmd+Shift+O |
| Graph search | Ctrl+F | Cmd+F |
| Left panel filter | Ctrl+Alt+F | Cmd+Opt+F |
| AI commit message | Ctrl+Alt+M | Cmd+Opt+M |
| Open repo in editor | Ctrl+Shift+E | Cmd+Shift+E |

### 4.12 Agent Sessions view *(inferred)*
An "Agents" mode for the left panel lists local coding-agent sessions per worktree. This subsection is our interpretation. It ships behind `ui.showAgentsToggle` (spec 13, default off).
- **Toggle:** the left-panel header gets a segmented `List | Agents` control. `List` is the normal ref tree (spec 01). `Agents` replaces it with `<AgentSessionsPanel>`.
- **Rows:** one group per worktree of the repo (spec 02 `git:worktrees`), showing the branch, folder name and WIP count (spec 02 `git:status { worktreePath }`). Under each worktree, one card per detected session shows agent kind (Claude Code, Codex CLI, GitHub Copilot CLI, Gemini CLI, or "Custom"), status (`running` / `waiting for input` / `idle` / `exited`), start time and the terminal tab it runs in.
- **Detection (no agent integration required):** a session is a pty in our integrated terminal (§6.1) whose foreground process name matches a known agent binary (`claude`, `codex`, `copilot`, `gemini`, or the user's `tools.agentCommand`). Status comes from pty activity: output within 2 s means `running`, a prompt-like last line with no output for more than 10 s means `waiting for input`, otherwise `idle`. Agents started outside the app are listed only when they are found by process cwd under a worktree path (best effort, macOS/Linux `ps`/`lsof`, Windows `Get-CimInstance`). Those sessions are read-only.
- **Actions:** "New agent session" on a worktree opens a terminal tab in that worktree running `tools.agentCommand` / `tools.agentArgs` (spec 13), after running the repo's `RepoSettings.agentSetupCommands` once per new worktree. "Create worktree + agent" combines spec 09's `worktree.add` with that. Other actions are Focus terminal, Stop (sends Ctrl+C, then kill after confirmation), Open worktree, and Show changes (selects that worktree's WIP node, spec 04 §11).
- **Out of scope:** reading agent transcripts, approving agent tool calls from our UI, and vendor-specific status plugins (spec 13 lists "agent status plugins" as a later extension).

## 5. Data model & IPC

```ts
// src/shared/terminal.ts
export interface TerminalTab { id: string; repoId: string; title: string; shell: string; cwd: string; pid?: number; exited?: { code: number } }
export interface PtySpawnReq { repoId: string; cwd: string; shell?: string; args?: string[]; cols: number; rows: number; env?: Record<string, string> }

// src/shared/ai.ts
export type AiProviderId = 'anthropic' | 'openai' | 'azure-openai' | 'gemini' | 'openai-compatible';
export type AiFeature = 'commitMessage' | 'explainCommits' | 'explainBranch' | 'explainWip' | 'stashMessage'
                      | 'conflictResolve' | 'prDraft' | 'composeCommits' | 'changelog';
export interface AiSettings {
  enabled: boolean;
  provider: AiProviderId;
  model: string;                         // default 'claude-sonnet-5-5'
  baseUrl?: string;                      // azure / openai-compatible
  effort: Partial<Record<AiFeature, 'low' | 'medium' | 'high'>>;
  maxDiffChars: number;                  // default 120_000
  excludeGlobs: string[];
  instructions: { global: string } & Partial<Record<AiFeature, string>>;
  commitStyle: 'free' | 'conventional' | 'gitmoji';
  language?: string;
  consentGivenFor?: string;              // provider+endpoint hash; re-prompt on change
}
export interface AiRequestBase { requestId: string; repoId: string; feature: AiFeature }
export type AiRequest =
  | AiRequestBase & { feature: 'commitMessage'; amend?: boolean; hint?: 'shorter' | 'conventional' }
  | AiRequestBase & { feature: 'explainCommits'; shas: string[] }
  | AiRequestBase & { feature: 'explainBranch'; branch: string; base?: string }
  | AiRequestBase & { feature: 'explainWip' }
  | AiRequestBase & { feature: 'stashMessage' }
  | AiRequestBase & { feature: 'conflictResolve'; path: string }
  | AiRequestBase & { feature: 'prDraft'; head: string; base: string; template?: string }
  | AiRequestBase & { feature: 'composeCommits'; source: { kind: 'staged' } | { kind: 'range'; from: string; to: string } }
  | AiRequestBase & { feature: 'changelog'; from: string; to: string; format: 'keepachangelog' | 'grouped' | 'plain' };

export interface CommitMessageResult { summary: string; description: string }
export interface ConflictProposal { hunkId: string /* = spec 08 Segment.id */; resolvedText: string; explanation: string; confidence: 'high' | 'medium' | 'low' }
export interface ComposeProposal { commits: { summary: string; description: string; hunks: { path: string; hunkId: string }[] }[]; unassigned: { path: string; hunkId: string }[] }
export interface PrDraftResult { title: string; body: string }

export interface AiStreamEvent { requestId: string; kind: 'delta' | 'done' | 'error'; text?: string; result?: unknown; error?: AiError; usage?: { inputTokens: number; outputTokens: number } }
export interface AiError { code: 'disabled' | 'no-key' | 'auth' | 'rate-limit' | 'too-large' | 'refused' | 'network' | 'provider' | 'cancelled' | 'invalid-output'; message: string; retryAfterMs?: number }

// search / palette
export interface GraphSearchReq { repoId: string; text: string; fields: ('message' | 'author' | 'sha' | 'path' | 'content')[]; regex?: boolean; caseSensitive?: boolean; limit?: number }
export interface GraphSearchRes { shas: string[]; truncated: boolean }

// git flow
// Git Flow configuration type: GitflowConfig (spec 13 §5.2; keys gitflow.branch.master|develop, gitflow.prefix.*).
export interface GitFlowFinishReq { repoId: string; type: 'feature' | 'release' | 'hotfix'; name: string; rebase?: boolean; deleteBranch: boolean; tag?: { name: string; message: string }; push?: boolean }

// open in
export interface ExternalAppConfig { editor: { id: string; command?: string; args?: string[] }; terminal: { id: string; command?: string; args?: string[] } }
```

### IPC channels
| Channel | Kind | Payload |
|---|---|---|
| `pty:spawn` | invoke | `PtySpawnReq` → `{ptyId, pid, shell}` |
| `pty:write` | send (fire-and-forget) | `{ptyId, data}` |
| `pty:resize` | send | `{ptyId, cols, rows}` |
| `pty:kill` | invoke | `{ptyId}` |
| `pty:data` | event | `{ptyId, data}` (batched every 8 ms) |
| `pty:exit` | event | `{ptyId, exitCode, signal}` |
| `pty:cwd` | event | `{ptyId, cwd}` (from OSC 7) |
| `pty:listShells` | invoke | → `{id, name, path}[]` |
| `terminal:completions` | invoke | `{repoId, line, cursor}` → `{items:{label, insert, detail}[]}` |
| `ai:run` | invoke | `AiRequest` → `{requestId}` (starts; results stream) |
| `ai:event` | event | `AiStreamEvent` |
| `ai:cancel` | invoke | `{requestId}` |
| `ai:testConnection` | invoke | `{provider, model, baseUrl?}` → `{ok, latencyMs, error?}` |
| `ai:settings:get/set` | invoke | `AiSettings` = spec 13 `ai.*` settings (stored via `settings:set`); the key goes to SecretStore as `<profileId>/ai/<provider>` |
| `ai:compose:apply` | invoke (mutating op via `git:op:run` variant `ai.compose`) | `{repoId, proposal: ComposeProposal, base}` → `OpResult` |
| `graph:search` (spec 04) | invoke | `GraphSearchReq` (from the §11 query syntax) → `{ searchId }`; results stream on `graph:searchResults`; off-window hits use `graph:revealCommit` |
| `files:list` | invoke | `{repoId}` → `string[]` (cached) |
| `gitflow:get` / `gitflow:init` / `gitflow:reset` (spec 13), `gitflow:start`, `gitflow:finish` | invoke | mutating ones map to `git:op:run` variants `gitflow.*` (spec 05 §6.12 commands) |
| `open:editor` / `open:terminal` / `open:fileManager` / `open:default` | invoke | `{path, line?}` / `{cwd}` |
| `open:detectApps` | invoke | → detected editor/terminal list |

The renderer never sees API keys. AIService in main reads them from SecretStore.

## 6. Implementation details

### 6.1 PtyService (main)
- `node-pty.spawn(shell, args, { name: 'xterm-256color', cols, rows, cwd, env, useConpty: true /* Windows 10 1809+ */ })`.
- Shell resolution: setting → `process.env.SHELL` (mac/linux; login shell args `-l`) → Windows: setting (`powershell.exe` / `pwsh.exe` / bundled-or-installed `bash.exe --login -i` / `cmd.exe`).
- Env: inherit the resolved user shell env (spec 02 resolves the login shell env once at startup), plus `TERM_PROGRAM=GitHappens`, `GITHAPPENS_REPO=<path>`, `COLORTERM=truecolor`. **Prepend the bundled git dir only if** the user's PATH lacks git (so the terminal uses the same git as the user).
- **Shell integration** (opt-in, default on for bash/zsh/pwsh): inject an rc snippet via env (`ZDOTDIR` shim for zsh, `--rcfile` for bash, `-NoExit -Command . <script>` for pwsh) that emits OSC 7 (cwd) and OSC 133 A/B/C/D (prompt start/end, command start/finish with exit code). Fall back gracefully when not available.
- Output batching: accumulate data per pty and flush every 8 ms or at 64 KB to the renderer. Apply backpressure when the renderer is behind (`pty.pause()`/`resume()` if xterm write queue > 1 MB).
- Lifecycle: ptys belong to a repo. Closing a repo tab kills its ptys (after confirmation if busy). On app quit, kill all ptys.
- Windows: handle `ConPTY` resize races (debounce resize 50 ms).

### 6.2 Git autocomplete source
- Build step: for each porcelain subcommand run `git <cmd> --git-completion-helper` (outputs flags) with the bundled git version and write `completions.json` (`{cmd: {flags: string[], description}}`). Descriptions come from a static hand-written table for the ~40 most-used commands.
- Runtime: aliases `git config --get-regexp '^alias\.'` (cached, invalidated on config change). Refs come from the repo store.
- Tokenizer handles quotes and `--opt=value`.

### 6.3 AIService architecture (main)
```
AIService
  ├─ ProviderRegistry: AnthropicProvider (default) | OpenAIProvider | AzureOpenAIProvider | GeminiProvider | OpenAICompatibleProvider
  ├─ ContextBuilder: gathers git data per feature (§6.4), applies excludeGlobs + size budget
  ├─ PromptLibrary: versioned system prompts per feature + custom instruction merge
  ├─ OutputParsers: JSON schema validation per feature (zod)
  └─ RequestManager: AbortController per requestId, concurrency 2 per window, telemetry-free usage log (local only)
```
Provider interface:
```ts
interface AiProvider {
  id: AiProviderId;
  stream(opts: { system: string; user: string; model: string; effort: 'low'|'medium'|'high'; maxTokens: number; signal: AbortSignal;
                 jsonSchema?: object; onText: (delta: string) => void }): Promise<{ text: string; usage?: { inputTokens: number; outputTokens: number } }>;
  test(model: string): Promise<void>;
}
```

**AnthropicProvider** (official `@anthropic-ai/sdk`, main process only):
- Client: `new Anthropic({ apiKey, maxRetries: 2, timeout: 120_000 })`. The key comes from SecretStore.
- Default model `claude-sonnet-5-5` (configurable string, never hard-coded elsewhere).
- Streaming text features (explain, changelog, PR body): `client.messages.stream({ model, max_tokens, system, messages: [{ role: 'user', content }], output_config: { effort } })`. Forward `text` deltas to `ai:event`, then `await stream.finalMessage()` for usage and `stop_reason`.
- Structured features (commit message, stash message, conflict proposals, compose, PR title+body): `client.messages.parse({ ..., output_config: { effort, format: zodOutputFormat(Schema) } })` from `@anthropic-ai/sdk/helpers/zod`. This guarantees JSON matching the schema. For commit messages we still want progressive fill, so stream raw text with the format constraint and parse on completion.
- Do **not** send `temperature`, a thinking budget, or an assistant prefill (rejected on this model family). Thinking is adaptive by default. Depth is controlled via `output_config.effort`.
- Prompt caching: the system prompt (feature instructions + custom instructions) is stable per feature, so mark it `cache_control: { type: 'ephemeral' }`. This helps repeated "Regenerate" clicks and multi-commit explains.
- Check `stop_reason`: `refusal` → `AiError{code:'refused'}` with a neutral message. `max_tokens` → retry once with doubled `max_tokens`, then `invalid-output`.
- Errors map from SDK typed exceptions: `Anthropic.AuthenticationError` → `auth`; `Anthropic.RateLimitError` → `rate-limit` (`retry-after` header); `Anthropic.BadRequestError` with a too-long prompt → `too-large`; `Anthropic.APIConnectionError` → `network`; other `Anthropic.APIError` → `provider`. Don't string-match messages.
- max_tokens per feature: commit/stash 2,000; PR 4,000; explain 4,000; changelog 8,000; conflicts 16,000; compose 16,000.
- *Optional:* server-side refusal fallback (`fallbacks: 'default'` with beta header `server-side-fallback-2026-07-01`, Claude API only). This is off by default and exposed as an advanced toggle.

Other providers: OpenAI-compatible chat completions with `response_format: json_schema` where supported, otherwise "JSON only" instructions + zod validation + one repair retry. The custom URL provider supports Ollama/LM Studio. The user is warned that small local models may produce invalid output.

### 6.4 Context building per feature (git commands)
| Feature | Git data | Notes |
|---|---|---|
| commitMessage | `git diff --cached --no-color --no-ext-diff -U3 --stat` + `git diff --cached --no-color --no-ext-diff -U3 --find-renames`; branch name `git symbolic-ref --short HEAD`; last 10 subjects `git log -10 --format=%s` (style hint); amend: `git diff --cached HEAD~1` + current message | Branch issue keys (e.g., `ABC-123`) are passed as a hint |
| explainCommits | per sha `git show --no-color --stat --patch --format=fuller <sha>` | cap per-commit diff |
| explainBranch | base = `git merge-base <branch> <base or upstream default branch>`; `git log --format='%h %s' base..branch`; `git diff --stat base...branch`; `git diff base...branch` | |
| explainWip | `git diff HEAD --stat` + `git diff HEAD` + untracked file list | |
| stashMessage | same as commitMessage on the staged diff (or the whole WIP if nothing is staged) | |
| conflictResolve | for path: stages `git show :1:<p>`, `:2:<p>`, `:3:<p>` (base/ours/theirs), the conflicted worktree file with markers, plus `git log --format=%s -5 MERGE_HEAD` / ours for intent | each hunk gets an id; the model returns proposals keyed by hunk id |
| prDraft | like explainBranch + PR template text + linked issue title (spec 10) | |
| composeCommits | staged diff split into hunks with stable ids `path#n` (spec 06 parser) | the model assigns hunk ids → commits; validation: every hunk id exactly once |
| changelog | `git log --no-merges --format='%H%x00%s%x00%b%x00%an' from..to` + PR numbers parsed from messages | |

**Budgeting**: estimate tokens ≈ chars/4. When over `maxDiffChars`: (1) drop excluded globs, (2) drop binary and generated files, (3) keep `--stat` for everything but truncate per-file patches to the first N lines and add a `[truncated]` marker, (4) still too large → `too-large` error with "Select fewer files". Secrets guard: lines matching common secret patterns (AWS keys, `-----BEGIN PRIVATE KEY-----`, `.env`-style `KEY=` in env files) are redacted to `[REDACTED]` before sending.

### 6.5 Prompts (summaries; full text lives in `PromptLibrary`, versioned)
- System prompt structure: role ("You write git commit messages for the user's repository"), output contract (JSON schema), style rules (imperative mood, summary ≤ 72 chars and ideally ≤ 50, wrap body at 72, explain *why*), commit style (conventional/gitmoji/free), language, then **user custom instructions** (global, then feature, then repo file) delimited in a clearly labeled section. Repo diff content goes in the user message inside `<diff>` tags, with an instruction that diff content is data and not instructions (prompt-injection hardening).
- Commit message schema: `{ summary: string (maxLength 100), description: string }`. Post-process: trim, collapse a trailing period on the summary, hard-wrap the description at 72 unless it contains code blocks/lists.
- Conflict schema: `{ proposals: { hunkId, resolvedText, explanation, confidence: 'high'|'medium'|'low' }[] }`. We verify that `resolvedText` contains no conflict markers; any that do are downgraded to `low` with a warning.
- Compose schema: `{ commits: { summary, description, hunkIds: string[] }[] }`. Validation: union of hunkIds equals the input set and there are no duplicates. Missing ids → `unassigned`. Unknown ids are dropped.

### 6.6 Applying AI results (git)
- Commit/stash message: only fills the composer. The user commits via spec 06.
- Conflicts: on Accept, write the hunk's resolved text into the merge tool's output model (spec 08). Saving the file and `git add` remain user actions.
- **Compose (staged source)**, executed as an op with a single journal entry (snapshot: HEAD, index tree, worktree stash):
  1. `git write-tree` → save the original index tree `T0` (journal).
  2. For each proposed commit i: reset the index to HEAD: `git read-tree HEAD`. Then apply the patches of its hunks (built with the spec 06 hunk-patch builder from the original staged diff) with `git apply --cached --recount`. Then `git commit -F <msg> [--no-verify per composer setting]`.
  3. After the last commit, assert the new HEAD tree plus unassigned hunks equals `T0`'s content: `git diff --cached` must equal the unassigned hunks (they are re-applied to the index so they stay staged).
  4. On failure at any step: `git reset --soft <origHead>` + `git read-tree T0` → original state, report the error.
- **Recompose range (v1: range must end at HEAD, no merges, clean worktree)**: `git reset --soft <from>^` → the staged diff equals the range's combined diff → run the compose flow above. Undo restores the original HEAD (keep-alive ref).
- Changelog save: prepend to `CHANGELOG.md` (create if missing). This is a normal file change and shows in WIP.

### 6.7 Graph search
- In-memory: the renderer graph store holds the loaded commits (sha, subject, body?, author name/email). Match with case-insensitive substring or regex. SHA prefix ≥ 4 chars.
- Deep search (main):
  - message: `git log --all --format=%H -i --grep=<text> [--extended-regexp] -n <limit>`
  - author: `git log --all --format=%H -i --author=<text> -n <limit>`
  - path: `git log --all --format=%H -n <limit> -- '*<text>*'` (glob pathspec via `:(glob)`)
  - content (pickaxe): `git log --all --format=%H -S<text> [--pickaxe-regex]` (slow → cancellable, progress shown)
  - sha: `git rev-parse --verify --quiet <text>^{commit}`
  Args are passed as separate argv elements (no shell). `--` separates pathspecs. `--all` is always built by spec 02 `buildRevSet` (so `refs/githappens/*` is excluded). Results are highlighted in spec 04, and off-window hits are loaded with spec 04 `graph:revealCommit`.

### 6.8 File finder
- `git ls-files -z --cached --others --exclude-standard` (with `--recurse-submodules` off; submodule roots listed as entries). Cached, and invalidated by watcher events for add/unlink.
- Matching runs in a Web Worker in the renderer for lists > 20k files.

### 6.9 Git Flow
Commands are defined in spec 05 §6.12. Here:
- `gitflow:get` (spec 13) reads the config through spec 02 `git:config:list { pattern: '^gitflow\.' }`.
- `gitflow:init` writes keys with `git config --local` and creates `develop` from main if missing (`git branch develop <main>`), and `main` if missing in an empty repo (skip).
- Start: `git switch -c <prefix><name> <base>` where base = develop (feature/release) or main (hotfix). Optional publish: `git push -u <remote> <branch>`.
- Finish: a composite op, journaled once. A conflict mid-finish leaves the user in a merge state with banner text "Git Flow finish paused: resolve conflicts then Continue". The **Continue** button resumes the remaining steps (state persisted in `<gitdir>/githappens/gitflow-finish.json`).

### 6.10 Open in external apps
- File manager: `shell.showItemInFolder(path)` (file) / `shell.openPath(dir)`.
- Default program: `shell.openPath(file)`.
- Editor: detected by checking known install paths and PATH binaries (`code`, `cursor`, `subl`, `idea`, `webstorm`, ...). Launch via `child_process.spawn(cmd, args, { detached: true, stdio: 'ignore' })`. Line support: VS Code `-g file:line`, JetBrains `--line N file`, Sublime `file:line`. Custom template placeholders `{path}`, `{line}`, `{repo}`.
- External terminal: Windows Terminal `wt.exe -d <cwd>`, PowerShell `start powershell -NoExit -Command Set-Location <cwd>` (spawned with `cwd` set instead of string interpolation), Git Bash `git-bash.exe --cd=<cwd>`. macOS `open -a Terminal <cwd>` / `open -a iTerm <cwd>`. Linux `gnome-terminal --working-directory=<cwd>`, `konsole --workdir <cwd>`, else `x-terminal-emulator` with cwd.
- Never build shell strings from paths. Always pass argv arrays.

### 6.11 `gk` CLI interplay (optional)
- If `gk` is on PATH, the terminal autocomplete also offers `gk` subcommands (`gk --help` parsed once).
- No functional dependency. We may later expose `githappens://open?path=` deep links so a CLI can open a repo in the app (spec 03 handles protocol registration).

## 7. Step-by-step implementation plan

1. **PtyService** + IPC (`pty:*`), node-pty native rebuild in electron-builder (spec 15), and a basic `TerminalPanel` with one xterm tab per repo. Test: spawn, echo, resize, and kill on every OS in CI.
2. **Tabs, per-repo session map, minimize/maximize, dock resizing**, persistence of panel open state per repo (not processes).
3. **Shell selection + Windows options**, terminal preferences (font, size, line height, cursor).
4. **Shell integration scripts** (OSC 7/133) and the auto-refresh trigger. Fallback idle heuristic.
5. **xterm addons**: fit, web-links, search, unicode11, webgl (with canvas fallback). File-path link provider → in-app editor. Drag-and-drop path insertion with shell quoting per shell type.
6. **Git autocomplete**: build-time `completions.json` generator, runtime tokenizer, popup UI, refs/paths sources, conflict detection, preference.
7. **AI settings & SecretStore integration**, consent dialog, master switch, org-policy hook (a remote config flag, later).
8. **AIService core**: provider interface, AnthropicProvider (stream + parse), error mapping, cancel, `ai:testConnection`. Unit-test with a mocked SDK. Do a live smoke test behind an env flag.
9. **ContextBuilder** with budgeting, exclusion globs, and secret redaction. Golden tests on fixture repos.
10. **Commit message generation** wired into the spec 06 composer (streamed fill, undoable, regenerate variants, amend mode).
11. **Stash message**, **Explain commits/branch/WIP** (Explain tab with streamed markdown rendering, sanitized).
12. **PR draft** hook for spec 10.
13. **Conflict assist** in spec 08 (per-hunk cards, confidence, accept/edit/reject, marker validation).
14. **Commit Composer**: proposal UI with dnd hunk chips, validation, composite op apply with journal + undo. Recompose (range at HEAD).
15. **Changelog** dialog.
16. **Other providers** (OpenAI, Azure, Gemini, OpenAI-compatible) behind the same interface. JSON repair retry.
17. **Graph search bar**: in-memory search, highlight/filter modes, deep search IPC, and spec 04 injection.
18. **Command palette modes + fuzzy file finder** (worker-based scorer, MRU).
19. **Git Flow**: config/init dialog, left-panel section, start inline input, finish dialog, composite op with resumable state.
20. **Open in…**: app detection, preferences, menus everywhere, line-number support.
21. **E2E**: terminal command updates graph. AI flows with a mocked provider server (record/replay fixtures). Compose undo restores byte-identical state. Git Flow release finish produces the expected refs/tags.

## 8. Edge cases

- **Terminal**: shell missing or misconfigured → fallback to the OS default with a warning. Repo path with spaces/unicode → cwd passed directly (no quoting issues). Very fast output (e.g., `yes`) → batching + backpressure keeps the UI responsive. Windows ConPTY unavailable (old Windows 10) → winpty fallback. WSL repos (`\\wsl$\...`) → offer `wsl.exe --cd <linuxPath>` as the shell. Repo closed while a command is running → confirm kill.
- **Autocomplete**: multiline commands, `git -C dir ...` (skip global options before the subcommand), aliases that are shell commands (`!`) → no flag hints.
- **AI**: nothing staged → button disabled with tooltip "Stage changes first". Only binary changes staged → send file list + stat only. Huge diffs → truncation strategy and visible notice "Message based on partial diff". Offline → `network` error with retry. Rate limited → countdown using `retryAfterMs`. Invalid key → link to settings. Model id not available for the key → provider error surfaced verbatim (sanitized). Provider returns invalid JSON (non-Anthropic) → one repair attempt, then `invalid-output`. User edits the summary while streaming → streaming stops writing to that field (user wins). Request cancelled when switching repos.
- **Prompt injection**: diff content may contain instructions ("ignore previous instructions"). The system prompt states that diff content is data. Outputs only fill UI fields and never execute commands, and conflict/compose outputs are validated structurally before use.
- **Privacy**: excluded globs and secret redaction apply to every feature. A per-repo "Disable AI for this repo" flag in `.git/config` (`githappens.ai=false`) is honored.
- **Compose**: hunks that overlap after reorder (the same file in multiple commits) → patches applied in order against the progressively updated index. Failure → full rollback. Pre-commit hooks may modify files between commits → compose runs with `--no-verify` by default (shown to the user) because hooks modifying the index would break the plan. Signing prompts per commit (gpg-agent caches).
- **Search**: regex syntax error → inline error. Pickaxe on huge repos → cancellable, partial results streamed. Search while the graph is filtered by solo/hide → search respects the visible set unless "search all refs" is checked.
- **File finder**: repos with 500k files → worker scoring with incremental results. Sparse checkout → only checked-out paths.
- **Git Flow**: non-standard names (`master`) → read from config. Missing develop branch on finish → error with a "Create develop" button. Tag already exists → prompt for a different name. Finishing a release while not up to date with the remote → suggest fetch first (no auto-pull).
- **Open in**: editor not found → prompt to configure. Paths on network shares → pass through. Linux without any known terminal → show a settings prompt.

## 9. Acceptance criteria

- [ ] Terminal toggles with Ctrl/Cmd+`, opens in the repo root (or worktree root), and keeps separate tabs per repo. Background processes survive repo switching.
- [ ] Shell selectable on Windows (PowerShell, pwsh, Git Bash, cmd, WSL). Fonts/cursor prefs apply live.
- [ ] Running `git commit` in the terminal updates the graph within 1 s.
- [ ] Autocomplete shows subcommands, flags, branch names, and changed paths. Can be disabled.
- [ ] AI commit message from staged changes streams into the composer using `claude-sonnet-5-5` by default. Respects conventional-commit style and custom instructions. Summary ≤ 72 chars in ≥ 95% of fixture runs.
- [ ] Explain commits/branch/WIP produce streamed markdown. Explain branch uses merge-base automatically.
- [ ] Stash message generation works from the stash dialog.
- [ ] Conflict assist shows per-hunk proposals with confidence, never writes without Accept, and rejects outputs containing markers.
- [ ] PR draft fills title/body and honors a template.
- [ ] Commit Composer creates N commits whose combined tree equals the original staged tree. One Undo restores the original HEAD and index.
- [ ] Changelog dialog produces grouped markdown for a tag range and can prepend to CHANGELOG.md.
- [ ] Provider switch (Anthropic/OpenAI/Azure/Gemini/OpenAI-compatible) works. Keys never reach the renderer (verified by IPC audit test). AI master switch hides all AI UI.
- [ ] Consent dialog shown on first use and after a provider/endpoint change.
- [ ] Graph search on message/author/SHA highlights matches with navigation. Filter mode hides non-matches. Deep search finds commits beyond the loaded window. Pickaxe search is cancellable.
- [ ] Fuzzy file finder returns results in < 50 ms for 100k files (worker).
- [ ] Git Flow init/start/finish for feature, release (with tag), and hotfix. Finish is a single undoable op and resumes after conflicts.
- [ ] Open in editor (with line), file manager, default program, and external terminal work on Windows, macOS, and Linux.

## 10. Out of scope / later

- AI chat/agent panel that runs git commands autonomously.
- Code Suggest and AI review comments on PRs (spec 14).
- Split terminal panes and terminal session restore across app restarts (process state).
- Org-level AI policy enforcement via our own backend (spec 14).
- Local embedding/semantic search over history.
- `gk` CLI feature parity or bundling.
- Recompose ranges that don't end at HEAD (needs a replay of later commits).
- GitHub Flow / trunk-based presets beyond Git Flow.

## 11. Cross-spec dependencies

- **Search query syntax used by spec 04 (owned here):** the graph search box (spec 04 §4.12) and `GraphSearchReq` share one grammar. Spec 04 renders results and loads off-window hits with `graph:revealCommit`.

  | Input | Meaning | `GraphSearchReq.fields` | Git (deep search) |
  |---|---|---|---|
  | `text` (no prefix) | message + author + SHA prefix | `['message','author','sha']` | `--grep` OR `--author` OR `rev-parse` |
  | `@name` | author / committer name or email (`@me` = profile email) | `['author']` | `-i --author=<name>` |
  | `#abc123` | SHA prefix (≥ 4 hex) or ref name | `['sha']` | `git rev-parse --verify -q <q>^{commit}` |
  | `file:<glob>` | commits touching a path | `['path']` | `-- ':(glob)<glob>'` (`:(icase)` if lowercase) |
  | `~text` | content added/removed (pickaxe) | `['content']` | `-S<text>` |
  | `=regex` | content regex | `['content']`, `regex: true` | `-G<regex>` |
  | `/regex/` | message regex | `['message']`, `regex: true` | `--grep=<re> -E` |

  Terms separated by spaces are ANDed (`--all-match`). Quoted strings keep spaces. An unknown prefix is treated as plain text. The command palette's own prefixes (`>`, `@` branches, `#` commits, `:` line, §4.8) apply only inside the palette.
- **AI explain / resolve used by spec 08 and graph menus:** spec 08's "Auto-resolve with AI" calls `ai:run { feature: 'conflictResolve' }` and receives `ConflictProposal[]` keyed by `hunkId` (= spec 08 `Segment.id`). "Explain commit" / "Explain branch changes" in spec 04/05 context menus call `explainCommits` / `explainBranch` and open the Explain tab (§4.4).
- **Interactive-rebase menu items (owned here; engine and editor in spec 05 §4.6/§6.8):** this spec registers the commands and menu entries "Interactive rebase from here…" (commit menu), "Interactive rebase `H` onto `B`" (ref menu and drop menu via spec 05 `computeDropActions`), "Squash N commits" and "Recompose N commits with AI" (multi-select), and palette commands `rebase.interactive` and `ai.recompose`. All of them open spec 05's `InteractiveRebaseView` or this spec's Commit Composer. Inside the rebase view it adds "Reword with AI" on a row (commitMessage feature on that commit's diff).
- **Agent Sessions view (inferred):** §4.12 defines it. It depends on spec 02 `git:worktrees` / per-worktree `git:status`, spec 09 worktree ops, spec 13 `ui.showAgentsToggle`, `tools.agentCommand`, `tools.agentArgs` and `RepoSettings.agentSetupCommands`, and spec 01's left-panel header for the `List | Agents` toggle (spec 01 §10 defers it to here).
- **Multiple terminal tabs per worktree:** `TerminalStore` is keyed by spec 02 `RepoId`, which is per worktree root, so every linked worktree keeps its own tab set and its ptys keep running across tab switches (§4.2). "New terminal tab" (Ctrl/Cmd+Shift+`) adds a tab in the active worktree. Opening a worktree from spec 09 or the Agents view activates that worktree's tab set.
- **"Compose commits with AI":** entry points are the WIP context menu, the Commit Panel ⋯ menu and graph multi-select (§4.4). The composite op is the `GitOperation` `{ type: 'ai.compose' }` with a single undo-journal entry of kind `ai-compose` (spec 05). Hunk patches are built with spec 06's hunk-patch builder.
- **Settings in spec 13:** `ai.*` (= `AiSettings`), `terminal.*`, `tools.editor` / `tools.terminal` / `tools.terminalCommand` / `tools.agentCommand` / `tools.agentArgs`, and repo Gitflow (`GitflowConfig`).
