# 15 — Packaging, Testing Strategy & Phased Roadmap

## 1. Purpose

Define how the app is built, signed, distributed and auto-updated; how it is tested; and the **order in which specs 01–14 are implemented**. This is the "start here" document for engineering once 00-overview has been read.

## 2. Reference behavior

- GitHappens ships for Windows (installer, per-user, auto-update), macOS (signed + notarized DMG, Intel and Apple Silicon builds), and Linux (.deb, .rpm, .tar.gz, Snap, plus AppImage-like portable builds).
- It auto-updates in the background and shows a "restart to update" prompt; release notes open in-app after an update.
- Releases are frequent (roughly monthly feature releases plus patch releases), with a separate early-access/preview channel.
- It bundles its own git engine (historically NodeGit/libgit2; newer versions can use the system git for some ops) so it works on machines without git installed.

## 3. User stories

- As a user I can install the app on Windows, macOS, or Linux with one download and no prerequisites (git bundled).
- As a user I get updates automatically and can choose Stable or Preview channel.
- As a developer on the team I can run `pnpm dev` and get a hot-reloading app against a fixture repo in under a minute.
- As a release manager I can tag a version and CI produces signed artifacts for all platforms.

## 4. UI specification (update-related only)

- **Update available toast** (bottom-right): "Version X.Y.Z is ready — Restart now / Later". Persistent dot on the app menu until restarted.
- **What's new view**: opened once after an update; renders bundled `CHANGELOG.md` section for the new version (Markdown → React).
- **Preferences › General › Updates**: channel select (Stable / Preview), "Check for updates" button, "Automatically download updates" toggle.
- **About dialog**: app version, Electron/Chromium/Node versions, bundled git version, active git path, copy-diagnostics button.

## 5. Data model & IPC

```ts
type UpdateChannel = 'stable' | 'preview';
interface UpdateStatus {
  state: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error';
  version?: string;
  progress?: number;          // 0..1
  error?: string;
}
// IPC
'app:getVersionInfo'   -> { app: string; electron: string; chrome: string; node: string; git: string; gitPath: string }
'update:check'         -> UpdateStatus
'update:install'       -> void           // quitAndInstall
'update:setChannel'    (channel: UpdateChannel) -> void
// events
'update:status'        (UpdateStatus)
```

## 6. Build & packaging implementation

### 6.1 Monorepo tooling
- **pnpm workspaces** + **Turborepo** for task caching.
- `apps/desktop` built with **electron-vite** (Vite for main, preload and renderer, separate configs).
- TypeScript project references; `strict: true`, `noUncheckedIndexedAccess: true`.
- ESLint (typescript-eslint, react-hooks), Prettier, `lint-staged` + Husky pre-commit.

### 6.2 Bundled git
- Use **`dugite`**-style approach: download platform-specific portable git (Git for Windows MinGit on Windows; prebuilt git on macOS/Linux) at `postinstall`, place under `resources/git`.
- Include **git-lfs** binary in the bundle. Bundled git must be **≥ 2.38** (`merge-tree --write-tree` for conflict prediction, specs 08/10).
- Build-time generator produces a git subcommand/flag completion table for the integrated terminal hints (spec 12).
- At runtime `GitLocator` (spec 02) chooses: user-preference path → bundled git → system git. Minimum supported system git: **2.36** (needed for `worktree list --porcelain -z`; see spec 02). `merge-tree --write-tree` requires 2.38 — feature-detect.

### 6.3 Native modules
- `node-pty`, `keytar` (or replace keytar with Electron `safeStorage` + encrypted file to avoid native module), `@parcel/watcher`.
- Rebuild with `@electron/rebuild` in CI per platform/arch.

### 6.4 electron-builder targets
| OS | Targets | Signing |
|---|---|---|
| Windows | NSIS (per-user, x64 + arm64), portable zip | Authenticode via Azure Trusted Signing or EV cert |
| macOS | DMG + zip (x64, arm64, or universal) | Developer ID + notarization (`notarytool`), hardened runtime, entitlements for JIT |
| Linux | AppImage, deb, rpm, tar.gz, (snap optional) | GPG-signed repo metadata |

- File associations: none required; register URL protocol `githappens://` (used by OAuth callbacks fallback and "open in app" links — spec 10).
- CLI shim: install `githappens` command (`/usr/local/bin` symlink on macOS via menu action; added to PATH by NSIS on Windows) supporting `githappens -p <path>` (spec 03).

### 6.5 Auto-update
- `electron-updater` with GitHub Releases (or S3) as feed; `latest.yml` / `latest-mac.yml` / `latest-linux.yml`; preview channel uses `preview.yml`.
- Check on startup + every 4 h; download in background; prompt to restart.
- Linux deb/rpm: show "new version available — download" link instead of in-place update.

### 6.6 CI/CD (GitHub Actions)
1. `ci.yml` on PR: install → typecheck → lint → unit tests (Vitest) → build renderer → e2e smoke (Playwright Electron) on ubuntu, windows, macos matrix.
2. `release.yml` on tag `v*`: build per OS/arch → sign/notarize → upload to draft release → generate update manifests → publish.
3. Nightly: build preview channel from `main`.

## 7. Testing strategy

### 7.1 Layers
| Layer | Tool | Targets |
|---|---|---|
| Parsers & command builders | Vitest | `packages/git` — every parser gets golden-file tests from captured real git output (including unicode paths, CRLF, renames, submodules). |
| Graph layout | Vitest + snapshot | `packages/graph` lane assignment on generated topologies; property tests (fast-check): no two active edges share a lane cell, every parent edge connects. |
| Services | Vitest + real git in temp dirs | GitService ops against fixture repos (merge, rebase, conflicts, stash, LFS, submodules, worktrees). |
| Provider clients | Vitest + `msw` | Recorded HTTP fixtures for GitHub/GitLab/Bitbucket/Azure. |
| Components | Vitest + Testing Library | Staging panel, commit composer, merge tool panes. |
| E2E | Playwright `_electron` | Full flows: clone → commit → push to local bare remote; resolve conflict; interactive rebase; undo. |
| Perf | Custom bench script | Load linux-kernel-sized history (≥1M commits) and assert first paint < 2s, scroll 60fps (frame time p95 < 16ms). |
| Visual | Playwright screenshots | Graph rendering, light/dark themes. |

### 7.2 Fixture repos
`test/fixtures/make-*.ts` scripts create deterministic repos (fixed dates/authors via `GIT_AUTHOR_DATE`, `GIT_COMMITTER_DATE`):
- `linear` (100 commits), `branchy` (octopus merges, criss-cross merges), `conflict` (two branches editing same lines + delete/modify + binary), `submodules`, `lfs`, `worktrees`, `huge` (generated 200k commits via `git fast-import`), `unicode-paths`, `empty`, `bare` + clone pair for push/pull tests.

### 7.3 Test infrastructure services
- Local **sshd** container (with a git user + authorized test key) for SSH auth/push tests (spec 09).
- Local **Git LFS server** (e.g. `lfs-test-server`) for LFS push/pull/lock tests.
- Local **HTTP proxy** (e.g. mitmproxy/squid) for proxy settings tests.
- Local HTTPS git server with basic auth (e.g. `git http-backend` behind nginx) for askpass/credential tests.
- CI matrix job running against **system git 2.36** (minimum) in addition to the bundled git.

### 7.4 Quality gates
- Unit coverage ≥ 80% for `packages/git` and `packages/graph`.
- No renderer process may import `child_process`/`fs` (enforced with ESLint `no-restricted-imports`).
- Every IPC channel declared in the per-domain contracts under `src/shared/ipc/` (git channels in `git-contract.ts`, spec 02 §5.3); a test asserts main registers handlers for all.

## 8. Phased roadmap

Each phase ends with a usable, shippable build. Specs referenced in brackets.

### Phase 0 — Foundations (≈2 weeks)
1. Scaffold monorepo, electron-vite, React, theming tokens, CI. [00, 15]
2. Typed IPC layer + preload bridge. [02]
3. `GitLocator`, `GitProcess` spawn wrapper with cancellation & progress. [02]
4. Settings store (JSON) and secret store. [13]
5. Fixture repo generators + test harness. [15]

### Phase 1 — Read-only viewer (≈4 weeks) — **"MVP-view"**
1. Open repo, recent repos, repo tabs. [03]
2. App shell: toolbar, left panel (branches/remotes/tags/stashes), right panel, status bar. [01]
3. Log/refs parsers, lane algorithm, canvas graph with virtualization, ref labels. [02, 04]
4. Commit detail panel, file list, diff viewer (Monaco, hunk + split). [07]
5. Repo watcher auto-refresh. [02]
6. Graph search/filter, jump to HEAD. [04, 12]

### Phase 2 — Everyday Git (≈5 weeks) — **"MVP-write"** (first public alpha)
1. WIP node + staging panel (file/hunk/line), discard, ignore. [06]
2. Commit composer, amend, hooks output. [06]
3. Branch create/checkout/rename/delete, tags. [05]
4. Fetch/pull/push with auth (askpass, SSH agent), upstream prompts, ahead/behind. [09]
5. Stash save/apply/pop/drop. [05]
6. Clone & init. [03]
7. Undo/redo journal for the core actions. [05]
8. Command palette + keyboard shortcuts. [01]

### Phase 3 — Power operations (≈5 weeks) — beta
1. Drag-and-drop ref operations: merge, rebase, fast-forward, push. [05]
2. Cherry-pick, revert, reset (soft/mixed/hard). [05]
3. Merge conflict detection + built-in 3-way merge tool + external tools. [08]
4. Interactive rebase UI. [05, 12]
5. File history, blame, in-app editor. [07]
6. Submodules, worktrees, LFS. [09]
7. Integrated terminal. [12]
8. Preferences UI complete, profiles, themes. [13]
9. Local target-branch conflict prediction via `git merge-tree --write-tree` (no backend needed). [08, 10]

### Phase 4 — Integrations (≈5 weeks) — 1.0
1. Deploy `services/oauth-broker`; OAuth + provider abstraction; GitHub first, then GitLab, Bitbucket, Azure DevOps. [10]
2. Clone from provider, add remotes from forks, SSH key upload. [10]
3. Pull requests: list, detail, create via drag-drop, checkout, review/merge. [10]
4. Issue trackers (GitHub/GitLab issues, Jira) + create-branch-from-issue. [10]
5. Commit signing (GPG/SSH) + verified badges. [06, 13]
6. Packaging, signing, auto-update, release pipeline hardened. [15]

### Phase 5 — Productivity (≈4 weeks) — 1.x
1. Workspaces (local), multi-repo overview, bulk fetch. [11]
2. Launchpad (PRs/issues across providers). [11]
3. AI features (commit message, explain, PR description, conflict assist) with BYO key. [12]
4. Git Flow. [12]
5. Agent Sessions view (`List | Agents`, optional, inferred). [12]

### Phase 6 — Optional cloud (scope-dependent)
1. Account + settings sync. [14]
2. Cloud patches / share WIP. [14]
3. Team view / teammate conflict prevention (target-branch prediction already shipped in Phase 3). [14]

## 9. Acceptance criteria (release-level)

- [ ] Installs and launches on Windows 10+, macOS 12+, Ubuntu 22.04+ with no git preinstalled.
- [ ] Opens a 1M-commit repo; first graph paint < 2 s; smooth scroll.
- [ ] All Phase 1–4 e2e flows pass on all three OSes in CI.
- [ ] Auto-update works stable → stable and stable → preview.
- [ ] No plaintext secrets on disk (verified by scanning userData in e2e).
- [ ] Crash reporting opt-in only; no telemetry without consent.

## 10. Edge cases

- Corporate machines with no write access to Program Files → per-user install.
- macOS Gatekeeper quarantine on bundled git binaries → must be signed inside the app bundle.
- Windows long paths (>260 chars) → set `core.longpaths=true` when spawning bundled git on Windows.
- Antivirus locking files during `git checkout` on Windows → retry with backoff for EBUSY/EPERM in watcher and op queue.
- ARM Linux → provide arm64 AppImage/deb.

## 11. Out of scope / later

- Mobile apps, a browser-based web version (not planned).
- Enterprise self-hosted license server.
- Plugin/extension API (consider after 1.x).

## 12. Legal note

This project uses its own name, logo, icons, and artwork, and must not copy any other Git client's proprietary code, assets, or documentation text. Specs describe *behavior* (which is not copyrightable) in our own words.
