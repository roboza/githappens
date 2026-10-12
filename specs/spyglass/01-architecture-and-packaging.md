# S01 — Architecture, Git Access and Packaging

> Spyglass spec. Binding decisions from [`../00-overview.md`](../00-overview.md) apply unless this file overrides them for the extension (it runs in VS Code's extension host, not in Electron main). Reuses: spec 02 (`@githappens/git`), spec 04 (`@githappens/graph`), spec 10 (`@githappens/providers`), spec 11 (`@githappens/launchpad`), spec 14 (`@githappens/cloud-api`), spec 15 (monorepo tooling, CI, testing layers).

## 1. Purpose

Define how Spyglass is built so every feature spec (S02–S11) sits on one foundation:

- the **extension layout** inside the GitHappens monorepo and how it reuses the desktop packages;
- **activation** that costs nothing until a git repository is open, and stays out of VS Code's startup path;
- **git access**: our own git CLI runner (spec 02) for reads, coordinated with VS Code's built-in Git extension for repository discovery, state and SCM;
- **performance budgets** and a caching model, so annotations feel instant on large files and repos;
- support for **Remote Development**, **Restricted Mode**, **virtual workspaces** and the **web** host, each with an explicit capability level;
- **telemetry** stance, **publishing** to the Visual Studio Marketplace and Open VSX, and **versioning**.

## 2. Reference behavior

Researched from the reference extension's marketplace page, README, changelog and contribution manifest (see README "Sources").

- The reference extension (stable 19.3.0, 2026-10-01; requires VS Code ≥ 1.101) activates on startup-finished, on its URI handler, on terminals, on its own file-system scheme and on restoring its webview panels. It does not activate per language. Its manifest is very large: about 470 settings (over 200 of them per-view options), about 1,170 commands (many duplicated per context menu location), about 60 keybindings, 4 view containers, a custom editor for the rebase todo file, and an MCP server definition provider. Spyglass deliberately aims for a much smaller surface (S11).
- Two entry points: a Node `main` and a `browser` (web worker) entry. No explicit `extensionKind`, so it runs on the workspace side. It declares virtual workspaces as supported and untrusted workspaces as limited.
- It runs git through **its own spawned git CLI** (located through the built-in Git extension's resolved path, or its own setting) instead of the built-in extension's API. It still listens to the built-in extension for repository open/close events *(inferred from its settings and behavior)*.
- It caches blame and log results per document and invalidates on repository changes and saves. Settings let users turn caching and individual features off for very large repos.
- It supports **Remote Development** by running in the workspace (remote) extension host. In virtual workspaces (for example a GitHub repository opened in the browser without a clone), it runs in a **limited** mode backed by a hosting-provider API.
- It ships a separate **web** bundle with reduced features. Anything that needs a local git process is unavailable there.
- Many views are rendered with **webviews** (graph, commit details, home/welcome, rebase editor, visual history, patch details). Tree views carry the rest (commits, branches, remotes, stashes, tags, worktrees, contributors, repositories, file/line history, search & compare, launchpad, drafts, workspaces). Since 19.0 the graph is its primary view.
- The VS Code **Timeline API is still proposed** (`vscode.proposed.timeline.d.ts` on VS Code main, checked 2026-10-12), so marketplace extensions cannot contribute timeline items; the reference's "visual history" is its own webview. Spyglass follows the same constraint (S04 §6.7).
- Licensing of the reference: code outside its `plus/` directories is MIT; code under `plus/` (graph, launchpad, worktrees, visual history, cloud patches, AI, account) is source-available under a proprietary license. Spyglass authors must not read or adapt that code (README §10).
- Paid features are gated by account state and plan, with a trial. Some paid features are free for public/local repositories and paid for private hosted ones. Spyglass has **no paid tiers** (see README §8): every feature is free; only features that need GitHappens Cloud require a (free) GitHappens account.

## 3. User stories

1. As a developer, I want Spyglass to add no measurable delay to VS Code startup, so that installing it is free of cost.
2. As a developer on a 500k-commit monorepo, I want current-line blame to appear within a blink of resting the cursor, so that I keep using it.
3. As a developer on Remote-SSH/WSL/Dev Containers, I want Spyglass to work exactly as locally, because my repository lives remotely.
4. As a security-conscious user opening an untrusted folder, I want Spyglass not to run git (which can execute configured programs) until I trust the folder.
5. As a vscode.dev user, I want useful (if reduced) history features without a clone.
6. As a maintainer, I want the extension to reuse the desktop app's tested git parsers and graph layout, so that fixes land once.
7. As a VSCodium or Cursor user, I want to install Spyglass from Open VSX.

## 4. UI specification

Architecture-level surfaces only (feature UIs live in S02–S10):

| Surface | Description |
|---|---|
| **Output channel "Spyglass"** | `LogOutputChannel` (`window.createOutputChannel('Spyglass', { log: true })`). Every git invocation is logged at `debug` with argv (redacted, spec 02 `redact`), cwd, duration and exit code. Errors at `error`. |
| **Status bar "Spyglass busy" item** | Shown only while a user-initiated long git op runs (fetch/pull/push/rebase). Click → show output. |
| **Walkthrough** | `contributes.walkthroughs` "Get started with Spyglass": turn on inline blame, open the graph, connect GitHappens, connect a provider, set up AI. Each step has a completion event (`onCommand:` / `onSettingChanged:`). |
| **Restricted Mode banner** | In untrusted workspaces, the Spyglass views show a welcome view: "Spyglass needs a trusted workspace to run git. [Manage Workspace Trust]". |
| **Git missing state** | When no git is found: views show "Git not found. [Set spyglass.git.path] [Install Git]". |
| **Unsupported git** | git < 2.36: a one-time warning notification; features needing ≥ 2.38 are hidden (spec 00 git policy). |

## 5. Data model & contracts

### 5.1 Repository layout

```
/apps/spyglass                      # the VS Code extension (new workspace package @githappens/spyglass)
  package.json                      # extension manifest (name "spyglass", publisher "githappens")
  src/
    extension.node.ts               # activate() for the Node extension host (desktop + remote)
    extension.web.ts                # activate() for the web extension host (limited, S01 §6.9)
    container.ts                    # composition root; lazily constructs services
    git/                            # SpyglassGit facade, CliGitBackend, VscodeGitBridge, RepositoryRegistry
    cache/                          # BlameCache, LogCache, CommitCache, RemoteInfoCache
    annotations/                    # S02, S03 decoration controllers
    hovers/ codelens/ statusbar/    # S02
    views/                          # S05 tree views
    webviews/host/                  # S04/S06/S07/S09 webview controllers (host side)
    rebase/                         # S07 custom editor
    desktop/                        # S08 deep links, bridge client, app detection
    auth/ providers/                # S08/S09 account + hosting-provider auth
    cloud/ launchpad/               # S09
    ai/                             # S10
    commands/ config/ context/      # S11 command registry, typed settings, context keys
  webviews/                         # React 19 apps built with Vite: graph, commit, compare, rebase, home, launchpad, patch
  test/                             # unit (vitest), integration (@vscode/test-electron), web (@vscode/test-web)
/packages/git                       # REUSED (spec 02): runner, locator, parsers, blame, log cursor, search plan
/packages/graph                     # REUSED (spec 04): GraphModel, lane layout, canvas render, hit testing
/packages/providers                 # REUSED (spec 10): GitHub/GitLab/Bitbucket/Azure/Jira clients
/packages/launchpad                 # REUSED (spec 11): classify, filters, snooze
/packages/cloud-api                 # REUSED (spec 14): REST types, patch crypto
/packages/ai                        # NEW, extracted from apps/desktop/src/main/ai (spec 12 §6.3) — S10 §6.1
/packages/search                    # NEW, extracted from apps/desktop/src/renderer/.../graph/search-query.ts — S04 §6.5
/packages/links                     # NEW: shared deep-link grammar for githappens:// and vscode:// routes — S08 §5
/packages/ui-kit                    # NEW (optional): React components shared by desktop renderer and Spyglass webviews
```

Rules:

- `packages/*` stay free of `electron` and `vscode` imports (already true for git/graph/providers/launchpad). New packages must keep this rule; a lint rule (`no-restricted-imports`) enforces it.
- Spyglass imports packages as **source** and bundles them (esbuild). No package is published to npm.
- Extracting `packages/ai`, `packages/search` and `packages/links` changes desktop imports only; desktop behavior must not change (desktop test suites must stay green).

### 5.2 Composition

```ts
// src/container.ts
export interface Container {
  readonly context: vscode.ExtensionContext;
  readonly log: vscode.LogOutputChannel;
  readonly config: SpyglassConfig;            // typed view over `spyglass.*` (S11 §5.1), emits onDidChange(section)
  readonly git: SpyglassGit;                  // §5.3
  readonly repos: RepositoryRegistry;         // §5.4
  readonly caches: CacheHub;                  // §6.5
  readonly desktop: DesktopIntegration;       // S08
  readonly account: GitHappensAccount;        // S08 §5.4
  readonly providers: ProviderHub;            // S09 §5.1
  readonly ai: AiHub;                         // S10
  readonly views: ViewRegistry;               // S05
  readonly webviews: WebviewRegistry;         // S04/S06/S07/S09
}
```

Services are constructed lazily on first use (`lazy(() => new X(...))`). `activate()` only registers commands, providers and listeners. It never spawns git or does network IO synchronously.

### 5.3 Git facade

```ts
export type RepoId = string; // same definition as spec 02 RepoId: hash of realpath'd worktree root

export interface SpyglassRepository {
  id: RepoId;
  root: vscode.Uri;                  // worktree root (file: or vscode-remote: authority stays the same in remote hosts)
  gitDir: string; commonDir: string;
  isBare: false;                     // bare repos are not opened by VS Code
  isWorktree: boolean;               // linked worktree
  objectFormat: 'sha1' | 'sha256';
  readonly onDidChange: vscode.Event<RepoChange>;   // scopes as spec 02 RefreshScope
  readonly state: RepoStateSnapshot;                // HEAD, branch, upstream, ahead/behind, rebase/merge state
}

export interface RepoChange { repoId: RepoId; scopes: RefreshScope[]; reason: 'vscode-git' | 'watcher' | 'op' | 'focus' | 'manual'; }

export interface SpyglassGit {
  // reads (concurrent, GIT_OPTIONAL_LOCKS=0)
  blame(repo: SpyglassRepository, path: string, o: BlameRequest): Promise<BlameResult>;          // S02/S03
  blameLines(repo: SpyglassRepository, path: string, o: BlameRequest & { range: [number, number] }): Promise<BlameResult>;
  log(repo: SpyglassRepository, q: LogQuery): LogCursor;                                           // spec 02 LogQuery
  fileHistory(repo: SpyglassRepository, q: FileHistoryQuery): Promise<FileHistoryPage>;          // spec 07 §6.7 (packages/git file-views)
  lineHistory(repo: SpyglassRepository, q: LineHistoryQuery): Promise<LineHistoryPage>;          // S04 §6.2 (git log -L)
  commit(repo: SpyglassRepository, sha: Sha): Promise<CommitDetail>;                             // spec 07 CommitDetail
  files(repo: SpyglassRepository, target: DiffTarget): Promise<FileListResult>;                  // spec 07 DiffTarget
  patch(repo: SpyglassRepository, target: DiffTarget, path: string): Promise<FilePatch>;
  show(repo: SpyglassRepository, rev: string, path: string): Promise<FileContent>;               // BlobReader (cat-file --batch)
  refs(repo: SpyglassRepository): Promise<RefInfo[]>;
  stashes(repo: SpyglassRepository): Promise<StashEntry[]>;
  remotes(repo: SpyglassRepository): Promise<RemoteInfo[]>;
  worktrees(repo: SpyglassRepository): Promise<WorktreeInfo[]>;
  contributors(repo: SpyglassRepository, o: ContributorQuery): Promise<Contributor[]>;           // S05 §6.8
  search(repo: SpyglassRepository, q: SearchQuery, signal: AbortSignal): AsyncIterable<Sha[]>;  // packages/search + packages/git search plan
  // writes (serialized per commonDir through spec 02 OperationQueue)
  run(repo: SpyglassRepository, op: GitOperation, o?: { progress?: vscode.Progress<{ message?: string; increment?: number }>; token?: vscode.CancellationToken }): Promise<OpResult>;
}
```

`GitOperation` is the spec 02 §5.5 union. Spyglass registers the same executors from `packages/git/src/ops/executors`. The desktop undo journal (spec 05) is **not** used by Spyglass in v1 (see §10). Ops still refuse to run while another git process holds `index.lock` (spec 02 error `IndexLocked`).

### 5.4 Repository registry

```ts
export interface RepositoryRegistry {
  readonly repositories: readonly SpyglassRepository[];
  readonly onDidOpen: vscode.Event<SpyglassRepository>;
  readonly onDidClose: vscode.Event<SpyglassRepository>;
  getForUri(uri: vscode.Uri): SpyglassRepository | undefined;   // longest-prefix match; handles nested repos & submodules
  getOrOpenForUri(uri: vscode.Uri): Promise<SpyglassRepository | undefined>; // discovers repos outside the workspace (e.g. an opened file from elsewhere)
  active(): SpyglassRepository | undefined;                      // repo of the active editor, else last focused in a Spyglass view, else first
}
```

### 5.5 Webview message envelope (shared by every webview)

```ts
// packages shared between host and webview: apps/spyglass/src/webviews/protocol.ts
export type WebviewId = 'graph' | 'commitDetails' | 'compare' | 'rebase' | 'home' | 'launchpad' | 'patch' | 'timeline';
export interface IpcRequest<M extends string = string, P = unknown> { kind: 'req'; id: number; method: M; params: P; }
export interface IpcResponse<R = unknown> { kind: 'res'; id: number; ok: boolean; result?: R; error?: { code: string; message: string }; }
export interface IpcNotification<M extends string = string, P = unknown> { kind: 'notify'; method: M; params: P; }
export type IpcMessage = IpcRequest | IpcResponse | IpcNotification;
// Every webview declares its own `Methods` map: { [method]: { params; result } } and `Notifications` map.
// The first message from the webview is { kind:'req', method:'ready', params:{ protocol: 1 } }.
// The host answers with the initial state (bootstrap) so no state is embedded in HTML.
```

Rules: messages are JSON-serializable only; large arrays (graph rows) use chunked notifications; all host handlers validate params with zod before use (webview content is untrusted, it renders commit messages and PR bodies).

## 6. Implementation details

### 6.1 Activation and manifest

- `main`: `dist/extension.node.js`; `browser`: `dist/extension.web.js`.
- `activationEvents`: `["onStartupFinished"]`. Commands, views, custom editors, URI handler and webview serializers activate implicitly (VS Code ≥ 1.74 generates those events).
- `engines.vscode`: `^1.101.0` *(our choice, same floor as the reference: recent enough for `LogOutputChannel`, `WebviewView`, tree badges and drag-and-drop, `SecretStorage`, `env.uriScheme` and the stable MCP server definition provider API used by S10 §6.8; old enough for Cursor/Windsurf/VSCodium forks that lag behind; re-evaluate each quarter)*.
- `extensionKind`: `["workspace"]` — runs next to the repository in remote windows.
- `extensionDependencies`: none. `vscode.git` is used when present (`extensions.getExtension('vscode.git')`) but not required.
- `capabilities.untrustedWorkspaces`: `{ supported: 'limited', description: 'Spyglass does not run git in Restricted Mode.', restrictedConfigurations: ['spyglass.git.path', 'spyglass.git.extraArgs', 'spyglass.ai.baseUrl'] }`.
- `capabilities.virtualWorkspaces`: `{ supported: 'limited', description: 'History features use the hosting provider API; editing operations are unavailable.' }`.
- Activation does, in order: create the log channel; read config; register commands (all of S11) with handlers that resolve services lazily; register decoration/hover/CodeLens providers (no work until a git document is visible); register views with lazy `TreeDataProvider`s; register the URI handler (S08); start `RepositoryRegistry` discovery **after** `setTimeout(0)`. Target ≤ 30 ms synchronous activation (budget §6.6).

### 6.2 Git access strategy

Decision: **spawn the git CLI ourselves through `@githappens/git` (`GitProcessRunner`), and use `vscode.git` only for discovery, state events and SCM-related hand-offs.**

Why not only `vscode.git`'s API: its exported API (`git.d.ts`, `getAPI(1)`) covers repository state, refs, simple log, diff and many mutating ops, but has no porcelain/incremental blame, no `log -L`, no streaming log cursor, no pickaxe search, no custom formats, and its surface changes slowly. It does give us the resolved git path, repository lifecycle, and `state.onDidChange` that fires after the built-in extension's own debounced file watching.

| Concern | Source |
|---|---|
| git executable | `spyglass.git.path` if set → `vscode.git` API `git.path` → spec 02 `GitLocator` (PATH, common install dirs, shell-env on macOS). No bundled git in the extension. |
| Repository discovery | `vscode.git` `repositories` + `onDidOpenRepository`/`onDidCloseRepository` when available; otherwise our own: `git rev-parse` (spec 02 §6.8) for each workspace folder and for each opened file's directory (cached negative results per directory). |
| Change events | `vscode.git` `repository.state.onDidChange` (HEAD, refs, index, working tree) mapped to `RefreshScope`s; plus our own `workspace.createFileSystemWatcher` on `<gitDir>/{HEAD,index,packed-refs,FETCH_HEAD,refs/**,logs/refs/stash,rebase-merge/**,MERGE_HEAD}` when `vscode.git` is disabled or for linked worktrees/common dir. Debounce 250 ms, coalesce scopes (spec 02 §6.14 rules). Window focus → `status` + `refs` refresh. |
| Reads | `SpyglassGit` over `@githappens/git` (`GitService`, `blameIncremental`, `parseBlamePorcelain`, `fileHistory`, `LogCursor`, `BlobReader`, `buildSearchPlan`). |
| Writes | `GitOperation` via spec 02 `OperationQueue` (one per common dir). Where the built-in extension offers an equivalent command and the user expects VS Code's own UX (commit, stage), Spyglass calls the built-in command (`git.commit`, `git.stage`) instead of re-implementing. |
| Credentials for fetch/push | Delegate network ops to `vscode.git` (`repository.fetch/pull/push`) when available, so VS Code's askpass/credential UX (and its GitHub auth integration) is used. Without `vscode.git`: spawn with `GIT_TERMINAL_PROMPT=0` and our askpass that prompts via `window.showInputBox` (spec 02 §6.3 bridge pattern, VS Code edition). |

Environment for every spawn (spec 02 §6.1): `LC_ALL=C` where parsing depends on it, `GIT_OPTIONAL_LOCKS=0` for reads, `GIT_TERMINAL_PROMPT=0`, `GIT_PAGER=cat`, `-c core.quotepath=false -c color.ui=false`, never `--no-optional-locks` on git < 2.15 (not supported anyway by policy).

### 6.3 Documents and URIs

- Supported document schemes: `file`, `vscode-remote` (same host), `untitled` (no blame), `git` (built-in extension's revision URIs: parse `{ path, ref }` from the query), and our own `spyglass` scheme.
- **`spyglass:` scheme** — a `TextDocumentContentProvider` (read-only) for file content at a revision: `spyglass:/<path>?{"repo":"<repoId>","rev":"<sha|:index>","path":"<repo-relative>"}`. URIs are created by `revUri(repo, rev, path)`. Used by diffs (`vscode.diff`), "open file at revision", and the annotations of past revisions (S03). Content comes from `BlobReader`; binary → placeholder text "Binary file (N bytes)"; LFS pointer → smudged content when `git lfs` is available (`git cat-file --filters`).
- **`FileDecorationProvider`** — not used for git status (the built-in extension does that); used only to badge files in Spyglass trees (e.g. "renamed").

### 6.4 Dirty documents

Blame of a modified, unsaved document uses `git blame --incremental --contents - -- <path>` with the editor text piped on stdin, so line numbers match the buffer. This runs at most once per 500 ms of idle editing (`spyglass.blame.dirtyDelay`, default 500), and never while the user types. Between runs, cached blame lines are shifted using `TextDocumentChangeEvent` deltas (inserted lines get "Uncommitted"). Files > `spyglass.blame.maxLines` (default 20,000, matches spec 07 §6.8) are not blamed automatically.

### 6.5 Caching

| Cache | Key | Value | Size / TTL | Invalidation |
|---|---|---|---|---|
| `BlameCache` | `repoId + path + (rev \| 'wt:' + docVersion)` | `BlameResult` (lines + commit map) | LRU 50 entries or 64 MiB | repo change scopes `refs`/`status` for working-tree entries; never for sha-pinned entries; document close evicts its working-tree entry |
| `CommitCache` | `repoId + sha` | `CommitDetail` + numstat | LRU 2,000 | immutable (sha-keyed) |
| `LogCache` | `repoId + LogQuery hash` | live `LogCursor` + loaded pages | 5 min idle (spec 02 §6.6) | `refs`/`graph` scope |
| `RemoteInfoCache` | `repoId` | remotes + parsed provider `RepoRef` (spec 10 §5.1) | session | `remotes`/`config` scope |
| `AvatarCache` | `email + size` | `vscode.Uri` (data or https) | disk: `globalStorageUri/avatars`, 7 days | — |
| `PrForBranchCache` | `repoRef + branch` | PR summary | 2 min | manual refresh, `refs` scope |
| `ProviderCache` | request key | provider responses | spec 10 §6.4 rules | — |

Sha-keyed data is immutable and never invalidated, only evicted. All caches are per window (extension host) and in memory, except avatars.

### 6.6 Performance budgets

Measured in the integration perf suite (S12 §6.4) on a reference machine (8-core, NVMe) with the `huge` fixture (spec 15 §7.2, 200k commits) and a 10k-line file with 2,000 blame entries.

| Metric | Budget (p95) |
|---|---|
| Synchronous `activate()` | ≤ 30 ms; extension host "activation time" ≤ 80 ms |
| Bundle size (`extension.node.js`, minified) | ≤ 1.5 MB; webviews loaded on demand, each ≤ 600 KB gzip |
| Current-line blame shown after cursor rest, blame cached | ≤ 50 ms after the `spyglass.currentLine.delay` (default 150 ms) |
| First blame of a 10k-line file (cold) | ≤ 700 ms; first visible-range annotations streamed ≤ 300 ms via `--incremental` |
| Hover (cached blame, no provider call) | ≤ 30 ms; provider-enriched hover (PR link) adds async ≤ 1 s, rendered progressively |
| CodeLens resolve per file | ≤ 150 ms (one `blame` shared with S02 inline blame) |
| Tree view first children | ≤ 300 ms; ≤ 1 s on 5,000 branches |
| Graph webview first paint (500 rows) | ≤ 1 s from command; 60 fps scroll (frame p95 ≤ 16 ms) |
| Idle CPU with nothing visible | 0 git processes; no timers more frequent than 60 s |
| Memory | ≤ 150 MB extension host heap growth after 1 h of normal use on the huge fixture |

Concurrency: at most 4 concurrent read git processes per repo and 8 overall (`spyglass.git.maxConcurrentProcesses`); one persistent `cat-file --batch` per repo (spec 02 §6.15.7), killed after 2 min idle.

### 6.7 Remote development

- Runs in the remote extension host (`extensionKind: workspace`); git runs on the remote machine; webviews run on the client and talk to the host via messages (no direct file access).
- Avatars and provider calls go out from the remote host. If the remote has no internet, provider features show "Provider unavailable from this remote" and degrade.
- Desktop hand-off from a remote window: `vscode.env.openExternal` opens `githappens://` URLs on the **client** machine. Repository paths are mapped (S08 §6.4): WSL → `\\wsl.localhost\<distro>\<path>`; SSH / containers / Codespaces → hand off by remote URL + branch + sha instead of path.
- `vscode.env.remoteName` is reported in the S08 hand-off payload.

### 6.8 Restricted Mode (untrusted workspaces)

git reads can execute configured programs (`core.fsmonitor`, `diff.<driver>.textconv`, `core.sshCommand`, hooks on writes). In Restricted Mode Spyglass registers commands and views but **does not spawn git**; views show the trust welcome content; `workspace.onDidGrantWorkspaceTrust` triggers normal startup. This mirrors the built-in Git extension's behavior.

### 6.9 Virtual workspaces and the web host

Capability levels:

| Host | Git source | Available | Unavailable |
|---|---|---|---|
| Desktop / remote (Node) | git CLI | everything | — |
| Virtual workspace on Node host (e.g. remote repositories extension) | provider API (`@githappens/providers`: GitHub GraphQL `blame`, commits by path; GitLab blame API) *(Phase S6)* | inline blame, hovers, file history, commit details (read-only), PR views, launchpad | annotations of uncommitted changes, graph, rebase, stashes, worktrees, any write |
| Web (`browser` entry, vscode.dev / github.dev) | provider API only | same as above | same as above + desktop bridge (only `githappens://` hand-off by URL) |

The web bundle excludes `@githappens/git` process code (`child_process`, `fs`) through esbuild `platform: 'browser'` plus a shim module that throws `UnsupportedInWeb`. The provider-backed backend implements the read subset of `SpyglassGit` and is selected when `workspace.workspaceFolders[0].uri.scheme !== 'file'` and the URI maps to a provider repo.

### 6.10 Telemetry stance

- **No telemetry** in v1: no usage analytics, no crash upload. Matches spec 15 §9 ("no telemetry without consent").
- If added later: opt-in only, gated by both `vscode.env.isTelemetryEnabled` and `spyglass.telemetry.enabled` (default `false`), using `@vscode/extension-telemetry`-style `TelemetryLogger` so VS Code's telemetry output channel shows every event.
- Network calls are limited to: configured hosting providers, avatar services (`spyglass.avatars.source`), GitHappens Cloud (only when signed in), the configured AI provider (only after consent, S10). Each is listed in the README "Privacy" section of the marketplace page.

### 6.11 Build

- **esbuild** for the extension host bundles (`format: cjs`, `platform: node`, `target: node20`; web: `format: cjs`, `platform: browser` with `process`/`path` polyfills only where needed). VS Code's extension host loads CommonJS; the workspace packages are ESM TypeScript source and are bundled.
- **Vite 7** for webviews (React 19, CSS Modules, theme from VS Code CSS variables `--vscode-*`). One entry per webview, shared chunk for `ui-kit`. Output to `dist/webviews/<id>/`.
- Content Security Policy for every webview: `default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};`. `localResourceRoots` = `[dist/webviews]` only.
- Turborepo tasks: `spyglass#build`, `spyglass#test`, `spyglass#test:integration`, `spyglass#package`. Follow the installed turbo version's docs before editing `turbo.json` (repo AGENTS.md).

### 6.12 Publishing and versioning

- Identity: publisher `githappens`, name `spyglass` → marketplace id **`githappens.spyglass`**; display name "Spyglass — Git history, blame and graph for VS Code" *(final copy is marketing's call)*; MIT license *(open question, README §11)*; icon and artwork original.
- Registries: **Visual Studio Marketplace** (`@vscode/vsce publish`) and **Open VSX** (`ovsx publish`) from the same `.vsix`. One platform-neutral VSIX (no native modules).
- Versioning: SemVer, independent of the desktop app. **Even minor = stable, odd minor = pre-release** (`vsce publish --pre-release`), the convention VS Code recommends because the marketplace does not accept SemVer pre-release tags. Patch numbers for fixes.
- Compatibility with the desktop app is negotiated at runtime by the bridge protocol version (S08 §5.3), not by version pinning.
- Release pipeline (GitHub Actions, spec 15 §6.6 style): tag `spyglass-v<x.y.z>` → build → unit + integration tests on Linux/Windows/macOS → package → publish to both registries (tokens in repository secrets `VSCE_PAT`, `OVSX_PAT`) → GitHub Release with the VSIX attached.
- `CHANGELOG.md` and `README.md` in `apps/spyglass/` are the marketplace page content; images are our own screenshots.

## 7. Step-by-step implementation plan

1. Create `apps/spyglass` package, manifest skeleton, esbuild config, `activate()` that registers an output channel and one command. Test: `@vscode/test-electron` smoke test activates the extension in < 80 ms.
2. Add lint rule forbidding `vscode`/`electron` imports in `packages/*`; add `@githappens/git` dependency and bundle it. Test: bundle builds, size budget check in CI.
3. Implement `GitLocator` integration (setting → `vscode.git` path → locator) and `RepositoryRegistry` (both discovery paths). Test: fixture workspace with nested repo + submodule + linked worktree.
4. Implement change events (vscode.git + own watcher fallback) with scope coalescing. Test: external `git commit` triggers one `refs` event within 500 ms.
5. Implement `SpyglassGit` reads on top of `GitService`; `spyglass:` content provider. Test: open a file at a past revision via command.
6. Implement caches (§6.5) with metrics in the debug log. Unit tests for LRU sizing and invalidation.
7. Webview infrastructure: protocol, zod validation, CSP, theming bridge, Vite build. Test: a "hello" webview round-trips `ready` → bootstrap.
8. Restricted Mode and virtual workspace gating. Test: untrusted workspace spawns zero git processes (spy on runner).
9. Release pipeline: package, publish dry-run to both registries on every main build.
10. Extract `packages/search`, `packages/links`, `packages/ai` from desktop (no behavior change; desktop tests green).

## 8. Edge cases

- **Multi-root workspaces**: every folder may hold zero or more repos; repository picker shown when a command has no editor context.
- **Nested repos and submodules**: longest-prefix match; submodule files are blamed in the submodule repo.
- **Files outside any workspace folder** (opened via "Open File"): discovered on demand; repo registered as "external" and not shown in the Repositories view unless pinned.
- **Symlinked paths**: realpath before matching; display the path as the user opened it.
- **Case-insensitive file systems**: compare paths case-insensitively on Windows/macOS when matching documents to repos.
- **`vscode.git` disabled** (`git.enabled: false`): own discovery and watchers; Spyglass still works.
- **Built-in git and Spyglass using different git binaries**: allowed; Spyglass logs both versions at startup.
- **sha256 repositories**: hashes of 64 hex chars everywhere (spec 02 `Sha`).
- **git ≥ 2.36 but < 2.38**: features using `merge-tree --write-tree` (conflict prediction in S09) are hidden.
- **Huge repos without commit-graph**: Spyglass does **not** write `commit-graph` silently (unlike desktop spec 02 §6.15.1); it offers a one-time "Optimize repository (write commit-graph)" notification for repos > 50k commits *(our choice — VS Code users did not opt into a GUI managing their .git)*.
- **Extension host restart / reload window**: caches are rebuilt lazily; webviews restore through `WebviewPanelSerializer` with persisted state (`vscode.setState`).
- **Forks of VS Code without `vscode.git`**: fallback paths apply; features relying on built-in commands (`git.commit`) hide their buttons.

## 9. Acceptance criteria

- [ ] Installing Spyglass adds ≤ 80 ms activation time (Developer: Show Running Extensions) on the reference machine.
- [ ] With no git repository open, Spyglass spawns zero processes.
- [ ] In Restricted Mode, zero git processes; trusting the workspace starts Spyglass without reload.
- [ ] Works in Remote-SSH, WSL and Dev Containers (integration test on WSL/devcontainer in CI where available, manual checklist otherwise).
- [ ] Web bundle loads on vscode.dev and shows a clear "limited mode" state.
- [ ] `packages/*` contain no `vscode`/`electron` imports (lint).
- [ ] The same VSIX installs from the Marketplace and Open VSX.
- [ ] No outbound network request happens before the user enables a feature that needs it (verified with a request-logging proxy in an integration test).

## 10. Out of scope / later

- Undo journal for operations performed from Spyglass (desktop spec 05); revisit if users ask.
- Bundled git in the extension.
- JetBrains or other editor plugins.
- Telemetry (see §6.10).
- Full read/write support in virtual workspaces.

## 11. Cross-spec dependencies

- **Spec 02** — `GitProcessRunner`, `GitLocator`, parsers, `LogCursor`, `BlobReader`, `OperationQueue`, error taxonomy and `redact` are reused unchanged; Spyglass replaces only the IPC layer (calls are in-process).
- **Spec 04** — `GraphModel`, layout and canvas renderer run inside the S06 webview.
- **Spec 07** — `DiffTarget`, `CommitDetail`, `FileListResult`, `FileHistoryEntry` types are reused as the S04 data model.
- **Spec 10/11/14** — provider, launchpad and cloud packages are reused by S09.
- **Spec 12** — AI service extracted to `packages/ai` (S10) and search grammar to `packages/search` (S04).
- **Spec 13** — Spyglass settings are VS Code settings (`spyglass.*`), not the desktop settings registry; shared values are synchronized as described in S08 §6.6.
- **Spec 15** — CI, fixture repos and Vitest conventions apply; Spyglass adds `@vscode/test-electron` and `@vscode/test-web` layers (S12).
