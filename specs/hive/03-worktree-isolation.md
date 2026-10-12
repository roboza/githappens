# Hive 03 — Worktree Isolation (Lanes)

> Owns: `LaneManager` — creating, preparing, tracking and removing the worktree + branch behind every lane; naming; base selection; setup steps; copying ignored files; dependency reuse (symlink / copy-on-write clone) (G7); environment and port blocks; check command definitions (G5); repo-level Hive config (local + committed) and its trust gate; retention cap, disk usage and garbage collection (G7). The "try it locally" handoff (G6) is specified in file 06 §6.8 and uses this file's worktree primitives.

## 1. Purpose

Parallel agents in one checkout trample each other. A linked git worktree per lane gives each agent its own files, index and HEAD while sharing objects and refs with the main repo, so creation is fast and results are ordinary branches. This file makes lane creation a one-click, repeatable operation that leaves the lane immediately runnable (dependencies installed, `.env` present, a free port range) and makes cleanup safe.

## 2. Reference behavior

- The reference desktop app's "New Agent Session" creates a worktree, runs the repo's configured setup commands (dependency install, build, copying env files) and starts the agent in one step; since 12.6 it first asks for branch name, base branch (searchable) and agent, with a split button keeping a one-click default. New worktrees inherit the source repo's view settings (hidden/soloed refs, collapsed folders). It offers "Remove worktree and delete branch", can remove the active worktree (switching to the main worktree first), groups worktrees of one repo in the tab bar, and shows folder names when they differ from the branch.
- The vendor's separate agent environment creates one worktree per repo per task in a user-configured worktree folder and runs repo commands on creation; it advertises cleaning up what agents leave behind.
- Comparable tools: Conductor runs a **setup** script on workspace creation, a **run** script on demand and an **archive** script before removal, exposes the workspace path, root path and default branch as env vars, and assigns each workspace a block of 10 ports starting at a per-workspace base, with a "nonconcurrent" mode for projects bound to one fixed port. Vibe Kanban runs an optional setup script per attempt and offers a dev-server preview. Claude Code's own `--worktree` puts worktrees under `.claude/worktrees/` inside the repo (Hive does not, see §6.2).

## 3. User stories

1. As a user I want a new lane to be ready to run (deps installed, env files present) without me typing anything.
2. As a user I want to choose the base (default: the repo's default branch, or my current branch) and see where the worktree will go.
3. As a team I want to share setup steps in the repo, but I don't want a repo I just cloned to run commands on my machine without asking.
4. As a user running several dev servers I want each lane to get its own ports.
5. As a user I want discarded lanes to disappear completely — folder, branch, ports — and be recoverable for a while.
6. As a user I want to turn an existing worktree into a Hive lane.
7. As a user with a large JavaScript/Rust project I don't want every lane to cost 2 GB of `node_modules`/`target` and ten minutes of install (G7).
8. As a user I want to see how much disk my lanes use and have old finished lanes cleaned up automatically (G7).
9. As a user I want my repo's test/lint/build commands defined once so Hive can run them in any lane (G5).

## 4. UI specification

### 4.1 Lane options (inside New Task, file 05 §4.1 — "Workspace" section)

| Field | Default | Notes |
|---|---|---|
| Base | `hive.defaultBase`: `default-branch` → `origin/HEAD`'s branch (local if it exists and is not behind; else remote-tracking ref), alternatives: `current-branch`, `ask` | Searchable ref picker (spec 05 branch switcher component). Shows "behind origin by N — Fetch first?" hint. |
| Branch name | generated (§6.1), editable | Validated live with `branch:validateName` (spec 05) + uniqueness. |
| Location | `<hive.worktreeRoot>/<folder>` | Read-only path preview with "Change…" (folder picker; persisted per repo). |
| Setup | "Run setup (3 steps)" checkbox, link "Edit…" | Disabled with reason when repo config is untrusted. |
| Copy files | ".env, .env.local (2 files)" summary | From config `copy` globs (§6.3). |
| Dependencies | "Clone node_modules (copy-on-write) · fallback: run setup" | From config `reuse` (§6.3a, G7). |
| Ports | "41020–41029" | Shown only when `ports.enabled`. |

### 4.2 Lane provisioning progress (lane card + drawer Info tab)

Stepper: `Create worktree` → `Copy files` → `Setup: pnpm install` → `Setup: pnpm build` → `Start agent`. Each step shows elapsed time, a spinner, ✓ / ✗, and a "Show output" toggle streaming `setup.log`. On failure: **Retry step**, **Skip and start agent**, **Open terminal here**, **Discard lane**.

### 4.3 Repo settings → Hive (spec 13 repo-specific section "Agents", renamed "Hive")

```
Hive (this repository)
├─ Worktree folder: [ <repoParent>/<repoName>.worktrees ]  Change…
├─ Branch prefix:   [ hive/ ]
├─ Default base:    [ Default branch ▾ ]
├─ Setup steps (local, not committed)            [+ Add] [↑↓] [✎] [🗑]
│     1. pnpm install --frozen-lockfile
│     2. pnpm -w build:types
├─ Copy into new lanes (gitignored files):  .env, .env.local, config/local.json   [Edit globs]
├─ Reuse dependencies (G7): node_modules → [Copy-on-write clone ▾]  target/ → [Symlink ▾]  [+ Add]
├─ Checks (G5): test: [ pnpm test ]  lint: [ pnpm lint ]  typecheck: [ pnpm tsc -b ]  [+ Add]   Run after each agent turn: [ ]
├─ Ports: [x] Assign a port block per lane   Block size [10]   Range [41000–48999]
├─ Run command (optional): [ pnpm dev --port $GITHAPPENS_HIVE_PORT ]   Mode: [Concurrent ▾]
├─ Teardown steps (optional, before discard)
└─ Shared config file: .githappens/hive.jsonc — Status: Trusted (hash 3f2a…) · Review changes · Revoke trust
```

### 4.4 Trust prompt for committed config

Shown the first time a Hive action needs setup/teardown/run steps in a repo whose `.githappens/hive.jsonc` (or a changed version of it) is untrusted:

```
This repository defines Hive setup commands
  .githappens/hive.jsonc (committed by the repository, last changed in a1b2c3d by Jane Doe)
  Setup:   pnpm install --frozen-lockfile
           cp .env.example .env
  Run:     pnpm dev --port $GITHAPPENS_HIVE_PORT
These commands will run on your computer in each new lane.
[ Trust and run ]   [ Run without repository steps ]   [ Cancel ]
```

Trust is stored per `(repo commonDir, sha256(file contents))` (file 08 §6.5). Any change to the file re-prompts and shows a diff against the last trusted version.

## 5. Data model & IPC

```ts
// src/shared/hive/lanes.ts
export interface LaneSpec {
  adapterId: AdapterId;
  model?: string; effort?: string; preset?: string; runner?: 'pty' | 'headless' | 'acp';
  branch?: string;                         // default generated
  base?: string;                           // ref; default from config
  worktreePath?: string;                   // default generated
  runSetup?: boolean;                      // default true
  promptOverride?: string;                 // fan-out variants (file 05 §6.4)
  existing?: { worktreePath: string };     // adopt instead of create
}

export interface SetupStep {
  id: string;
  name?: string;                           // shown in stepper; default = command
  run: string;                             // command line, run by the user's shell (§6.4.2)
  shell?: 'default' | 'bash' | 'pwsh' | 'cmd' | 'sh';
  timeoutSec?: number;                     // default 900
  continueOnError?: boolean;               // default false
  when?: { platform?: NodeJS.Platform[]; exists?: string };   // run only if a path exists in the worktree (e.g. 'pnpm-lock.yaml')
}

export interface RepoHiveConfigFile {      // .githappens/hive.jsonc (committed, optional)
  $schema?: 'githappens://schemas/hive.json';
  version: 1;
  setup?: SetupStep[];
  teardown?: SetupStep[];
  run?: { command: string; mode: 'concurrent' | 'exclusive' };
  copy?: string[];                         // globs of gitignored files to copy from the main worktree
  symlink?: string[];                      // globs to symlink instead of copy (opt-in, e.g. large caches)
  env?: Record<string, string>;            // non-secret env for agent + steps; may reference $GITHAPPENS_HIVE_* vars
  ports?: { enabled: boolean; blockSize?: number };
  branchPrefix?: string;
  instructions?: string[];                 // repo files to include in shared instructions (file 07 §6.4), e.g. ['AGENTS.md']
  reuse?: ReuseRule[];                     // G7 dependency reuse
  checks?: CheckDef[];                     // G5 lane checks
}

export interface ReuseRule {               // G7
  path: string;                            // dir relative to repo root, gitignored, e.g. 'node_modules', 'apps/web/.next/cache'
  strategy: 'cow-clone' | 'symlink' | 'copy' | 'none';   // cow-clone falls back per §6.3a
  fallback?: 'copy' | 'setup' | 'none';    // when cow-clone is unavailable; default 'setup' (let setup steps install)
  invalidateOn?: string[];                 // lockfiles; if they differ between source and lane base, skip reuse (default per ecosystem)
}

export interface CheckDef {                // G5
  id: string;                              // 'test' | 'lint' | 'typecheck' | 'build' | custom slug
  name?: string;
  run: string;                             // command line, same execution model as setup steps
  timeoutSec?: number;                     // default 1800
  required?: boolean;                      // default true: failing blocks Accept unless overridden (file 06 §6.9)
  autoRun?: 'never' | 'after-turn' | 'before-accept';   // default 'before-accept'
}

export interface LocalRepoHiveConfig extends Omit<RepoHiveConfigFile, '$schema' | 'version'> {
  worktreeRoot?: string;
  defaultBase?: 'default-branch' | 'current-branch' | 'ask' | { ref: string };
  useCommittedConfig: boolean;             // default true (still gated by trust)
}

export interface ResolvedRepoHiveConfig {
  local: LocalRepoHiveConfig;
  committed: { present: boolean; path?: string; hash?: string; trust: 'trusted' | 'untrusted' | 'changed' | 'denied'; parseError?: string; config?: RepoHiveConfigFile; lastTrustedDiff?: string };
  effective: {                              // what will actually be used
    setup: Array<SetupStep & { origin: 'local' | 'committed' }>;
    teardown: Array<SetupStep & { origin: 'local' | 'committed' }>;
    run?: RepoHiveConfigFile['run'] & { origin: 'local' | 'committed' };
    copy: string[]; symlink: string[]; env: Record<string, string>;
    ports: { enabled: boolean; blockSize: number };
    branchPrefix: string; worktreeRoot: string; defaultBase: LocalRepoHiveConfig['defaultBase'];
  };
}
```

Storage of the local config: git config (local scope) in the main repo, extending the existing `githappens.agentSetup` multi-value key used by the shipped Agent Sessions code:

| Key (`git config --local`) | Meaning |
|---|---|
| `githappens.agentSetup` (multi) | setup steps (existing; one command per value; kept for compatibility) |
| `githappens.hive.teardown` (multi) | teardown steps |
| `githappens.hive.copy` (multi) | copy globs |
| `githappens.hive.symlink` (multi) | symlink globs |
| `githappens.hive.worktreeRoot` | path |
| `githappens.hive.branchPrefix` | string |
| `githappens.hive.defaultBase` | `default-branch` \| `current-branch` \| `ask` \| `ref:<name>` |
| `githappens.hive.ports` | `true`/`false` + `githappens.hive.portBlock` (int) |
| `githappens.hive.run` / `githappens.hive.runMode` | command / `concurrent` \| `exclusive` |
| `githappens.hive.useCommittedConfig` | bool |
| `githappens.hive.reuse` (multi) | `<path>=<strategy>[:<fallback>]` (G7) |
| `githappens.hive.check.<id>` / `githappens.hive.checkAuto.<id>` / `githappens.hive.checkRequired.<id>` | check command / auto-run / required (G5) |

Git config is per repository (shared by all its worktrees through `commonDir`), survives GitHappens reinstalls, and is never committed. Spec 13's `RepoSettings.agentSetupCommands` is satisfied by this storage (cross-spec note §11). Writes go through `git:config:set` (queued, spec 02).

## 6. Implementation details

### 6.1 Naming

- **Slug:** from the task title (or issue key + title): NFKD-normalize, strip diacritics, lowercase, replace runs of non `[a-z0-9]` with `-`, trim `-`, max 40 chars at a word boundary. Empty → `task`.
- **Short id:** last 4 chars of the lane ULID in base32 lowercase.
- **Branch:** `<prefix><slug>-<shortid>`; for issue tasks `<prefix><issueKeyLower>-<slug>-<shortid>` (e.g. `hive/abc-12-fix-login-3fa2`); for fan-out, one lane per agent `…-<agentShort>-<shortid>` (`cc`, `cx`, `gm`, `cp`, `cu`, `oc`, `ai`, custom → first 4 chars). Never nest under an existing branch name (ref D/F conflict): if `refs/heads/<prefix><slug>` exists as a branch, the flat names above still work because of the `-<shortid>` suffix.
- **Prefix** default `hive/` (`hive.branchPrefix`, repo override). Must be a valid ref component; validated with `git check-ref-format --branch`.
- **Folder:** `<slug>-<shortid>` (no prefix, short paths for Windows). Collision → append `-2`, `-3`.
- **Worktree root:** default `<repoParent>/<repoName>.worktrees/` — the same default as spec 09 §4.3 Create Worktree, so Hive lanes and manual worktrees live together. Never inside the repository's working tree (avoids nested-repo confusion in tools, file watchers and agent context), never under `.git`.
- **Windows long paths:** if `worktreeRoot` + folder + the repo's longest tracked path would exceed 240 chars and `core.longpaths` is not `true`, warn in the dialog and offer "Use short root `%USERPROFILE%\.githappens\wt\<repoShort>`".
- **Windows Defender / indexing (G7):** real-time scanning of fresh worktrees and `node_modules` clones can dominate lane creation time. The Hive settings page shows a one-time *hint* with the exact folder to exclude (and the Dev Drive alternative, which uses performance mode scanning); Hive never changes Defender settings itself (file 08 non-goals).

### 6.2 Creating a lane (`hive.lane.create` op)

Preconditions (fail fast with `HiveError`):

1. Base resolves: `git rev-parse --verify -q <base>^{commit}` → `base.sha`. If the base is a remote-tracking ref and the local branch of the same name exists and is behind, use the remote-tracking sha (fresher) and record `base.ref` as the local branch name for landing.
2. Branch name valid and unused: `git show-ref --verify -q refs/heads/<branch>` must fail (→ else `branch-exists`, UI offers a new suffix).
3. Target path does not exist or is an empty dir (→ else `path-exists`).
4. Concurrency/disk limits (file 08 §6.7).

Commands (queued, exclusive on the commonDir queue because refs change):

```
git worktree add -b <branch> -- <path> <base.sha>
git -C <path> config --worktree githappens.hive.lane <laneId>        # only if extensions.worktreeConfig is already enabled; otherwise skipped (marker file is authoritative)
```

Then (outside the queue): write the marker file (file 01 §6.4); copy view settings from the source repo's UI state into the new worktree's state (spec 09 §6.10, same as manual worktree creation); emit `hive:changed`.

Hive does **not** set an upstream for the lane branch (no remote branch exists yet); push happens only on "Create PR" or explicit push (file 06).

LFS: if the repo uses LFS (spec 09 `LfsStatus.repoUsesLfs`), checkout smudges as usual; a slow LFS checkout shows progress via spec 02 progress parsing. Submodules: if `.gitmodules` exists, run `git -C <path> submodule update --init --recursive` as an automatic first setup step (skippable, `hive.lanes.initSubmodules`, default `true`) because spec 09 notes submodules are not initialized in new worktrees.

Sparse checkout: if the main worktree uses sparse-checkout (cone mode), mirror it: `git -C <path> sparse-checkout set --cone <dirs from main's sparse-checkout list>` before setup *(our extension)*.

### 6.3 Copying ignored files

- Globs are evaluated against the **main worktree** (or the worktree the task was created from), restricted to files that are gitignored (`git -C <src> ls-files --others --ignored --exclude-standard -z -- <glob>…`) so Hive never duplicates tracked files and never overwrites checked-out content.
- Copy preserves mode bits; symlinks inside the source are copied as symlinks only if they point inside the source tree; files > 50 MiB or more than 1 000 files total require confirmation (likely a mis-configured glob like `node_modules/**`).
- `symlink` globs create symlinks (Windows: directory junctions for dirs, symlinks for files only when Developer Mode/privilege allows; otherwise fall back to copy with a notice). Symlinked shared folders are flagged in the lane Info tab ("shared with main worktree — agents can modify them").
- Never copied, even if matched: `.git`, `.githappens/` internals, anything under `.env*` that matches the secrets scanner rule "looks like a private key" (`-----BEGIN (RSA|EC|OPENSSH) PRIVATE KEY-----`) unless the user confirms per file *(our extension; file 08 §6.4)*.

### 6.3a Dependency reuse (G7)

Agents in N lanes should not each pay a full dependency install. Per `ReuseRule`, before setup steps:

1. **Applicability:** the source dir exists in the main worktree and is gitignored; every `invalidateOn` file (defaults: `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lockb` for `node_modules`; `Cargo.lock` for `target`; `poetry.lock`/`uv.lock` for `.venv`) has the same blob in the main worktree's HEAD and in the lane base (`git rev-parse <rev>:<path>` comparison). If not, skip reuse and let setup install.
2. **`cow-clone`** (preferred for mutable dirs like `node_modules`): a copy-on-write clone, so the lane can modify it without affecting the source and disk is only used for changed blocks.
   - macOS APFS: `clonefile(2)` on the directory (via a tiny native addon or `cp -c -R`).
   - Linux Btrfs/XFS (reflink): `cp -a --reflink=always`; on failure (ext4 etc.) → fallback.
   - Windows: block cloning on ReFS / Dev Drive (`FSCTL_DUPLICATE_EXTENTS_TO_FILE`, via the native helper) when source and target are on the same ReFS volume; NTFS → fallback. The Hive settings page tells Windows users that placing `worktreeRoot` on a **Dev Drive** enables fast clones *(hint only; Hive never creates volumes)*.
3. **`symlink`** (good for read-mostly caches like Rust `target/` shared intentionally, or `.gradle` caches): symlink/junction to the source dir; flagged in the lane Info tab as shared.
4. **`copy`**: plain recursive copy (with the 1 000-file / 50 MiB confirmation of §6.3 lifted for reuse rules, since they are explicit).
5. **Fallback** per rule (`setup` by default: do nothing, the setup steps install).
6. Reuse runs in the "Copy files" stepper step; time saved is shown ("node_modules cloned in 1.2 s").

Package-manager-native sharing (pnpm's content-addressed store, Yarn PnP, uv cache, cargo's shared `CARGO_TARGET_DIR`) already makes installs cheap; the repo-settings page suggests these when it detects the ecosystem *(our extension)*.

### 6.4 Setup, run and teardown steps

#### 6.4.1 Sources and order

Effective setup = `[submodule init (auto)] + committed setup (if trusted & useCommittedConfig) + local setup`. Teardown = local teardown + committed teardown (reverse order of origin). Local always runs after committed so users can patch the team's steps.

#### 6.4.2 Execution

- Each step runs in a **non-interactive child process** (not the agent pty), cwd = lane worktree, shell = the user's configured terminal shell (spec 13 `terminal.shell`) with `-c` / `-Command` / `/d /s /c`, or the step's explicit `shell`.
- Env = filtered base env (file 08 §6.4) + config `env` + Hive vars:

  | Var | Value |
  |---|---|
  | `GITHAPPENS_HIVE` | `1` |
  | `GITHAPPENS_HIVE_LANE`, `GITHAPPENS_HIVE_TASK` | ids |
  | `GITHAPPENS_HIVE_WORKTREE` | lane worktree path |
  | `GITHAPPENS_HIVE_ROOT` | main worktree path (for copying from it) |
  | `GITHAPPENS_HIVE_BRANCH`, `GITHAPPENS_HIVE_BASE` | names |
  | `GITHAPPENS_HIVE_DEFAULT_BRANCH` | repo default branch |
  | `GITHAPPENS_HIVE_PORT`, `GITHAPPENS_HIVE_PORT_COUNT` | port block (if enabled) |

- Output streamed to `setup.log` and the stepper; timeout per step (default 900 s) → kill tree, step failed.
- Steps run **sequentially**; lanes provisioned in parallel run their steps in parallel but at most `hive.setup.maxParallel` (default 2) per repo, because installs (e.g. pnpm store, cargo target) contend on shared caches.
- On failure (`continueOnError: false`): lane → `error` (setup failed), agent not started unless the user picks "Skip and start agent". The once-per-worktree marker of the shipped implementation becomes `lane.setup.status`.
- Re-running setup on an existing lane: "Run setup again" in the lane menu.

#### 6.4.3 Run command (optional)

`run.command` is a per-lane "Run" button (dev server, tests). It runs in a Hive-owned pty (visible in a "Run" sub-tab of the lane drawer). `mode: exclusive` stops any other lane's run process in the same repo before starting (for projects with fixed ports or a shared DB) — same semantics as Conductor's nonconcurrent mode. The run process is stopped on lane discard/accept.

#### 6.4.3a Checks (G5)

`CheckDef`s run like setup steps (non-interactive child process, lane env, timeout, logs) but on demand: lane drawer "Run checks", before accept when `autoRun: 'before-accept'`, or after each `turn-complete` when `autoRun: 'after-turn'` (debounced; cancelled if a new turn starts). Results are attached to the lane HEAD + WIP state they ran on; any later change marks them `stale`. Checks share the per-repo parallelism cap with setup (`hive.setup.maxParallel`). Landing guards and the "send failure to agent" flow are in file 06 §6.9.

#### 6.4.4 Teardown

Runs before discard (and before removal after accept when `hive.lanes.removeAfterAccept`), with a 120 s total budget; failure is reported but does not block removal (user can cancel removal).

### 6.5 Port blocks

- Enabled per repo. Global pool `hive.ports.range` default `41000–48999`, block size default 10.
- Allocation: lowest free block not used by any live lane (any repo, this profile), verified free by trying to `listen()` on the first port of the block on `127.0.0.1` and `::1` (quick probe, ports closed immediately). Persisted on the lane; released on discard/accept-and-remove.
- Exposed as `GITHAPPENS_HIVE_PORT` (first port) and `GITHAPPENS_HIVE_PORT_COUNT`. Also aliased as `PORT` **only** if the repo config sets `env.PORT: "$GITHAPPENS_HIVE_PORT"` (Hive never overrides common vars by default).
- Port numbers are informational for agents: the lane's shared instructions (file 07 §6.4) mention "Use port $GITHAPPENS_HIVE_PORT for dev servers" when ports are enabled.

### 6.6 Adopting an existing worktree

`hive:lane:adopt` (or automatic adoption, file 01 §6.6): validates the path is a worktree of this repo (`git worktree list`), branch/HEAD read from it, `ownership: 'adopted'`, `base` = `hive.defaultBase` resolved now (editable later in Info tab). No setup steps are run automatically (offer "Run setup in this worktree").

### 6.7 Removing a lane (`hive.lane.discard` op)

1. Require no live runs (stop them first with confirmation; take a checkpoint, file 06 §6.6).
2. Run teardown (§6.4.4).
3. Capture for undo: lane branch tip sha; worktree dirty state as a snapshot commit (same temp-index method as spec 05 §6.11) → keep-alive refs `refs/githappens/hive/<laneId>/discard/tip` and `…/discard/wip`.
4. `git worktree remove --force -- <path>` (force because we already snapshotted; if the worktree is locked, ask, then `--force --force`). If removal fails because of open file handles on Windows (`Permission denied`/`Directory not empty`), retry 3× with 1 s backoff, then leave the folder, run `git worktree prune`, and schedule folder deletion on next start ("Couldn't delete folder — a program has files open in it").
5. Unless `keepBranch`: `git branch -D -- <branch>` (lane branches are Hive-owned; the keep-alive ref makes this recoverable).
6. Release ports; delete per-run temp files; keep session logs per retention (file 08 §6.6).
7. Journal entry `hive-discard` with `extra: { laneId, branch, tip, wipSnapshot, worktreePath }`. **Undo** = `git worktree add -b <branch> -- <path> <tip>` (or `git worktree add <path> <branch>` if kept), then restore WIP from the snapshot (`git -C <path> checkout <wip> -- .` + `git -C <path> reset` to keep it unstaged; untracked files restored from the snapshot tree), lane state back to `review`. Undo is available while keep-alive refs exist (30 days, `hive.retention.discardedDays`).

Adopted lanes: discard never removes the worktree or branch; it offers "Discard uncommitted changes" (spec 06 discard with journal) and "Remove from Hive".

### 6.8 Garbage collection, retention cap and disk usage (G7)

Daily (and on repo open, throttled):

- Delete keep-alive refs older than retention (`git update-ref -d`).
- `git worktree prune` when Hive finds admin dirs whose folders are gone.
- Orphan scan: folders under `worktreeRoot` that contain a `.git` file pointing to this repo but no worktree registration → list in Repo settings → Hive → "Cleanup" (never auto-delete user folders).
- **Retention cap:** at most `hive.retention.closedLanesKept` (default 15) closed lanes (accepted, or stopped and untouched for `hive.retention.idleDays`, default 14) keep their worktrees per repo; older ones beyond the cap have their worktree removed automatically (branch kept for accepted lanes until merged-and-deleted by the user; for unaccepted lanes the discard flow with keep-alive refs runs). Never applies to lanes with live runs, open review comments, a handoff in progress, or `pinned: true`. A toast lists what was cleaned with Undo.
- **Disk usage:** per lane computed lazily (du-style walk excluding `.git`, counting symlinks as 0 and CoW clones as their apparent size with a "shared blocks not counted" note when the FS can't report it), capped at 2 s per lane, cached 10 min. Shown on lane cards (on hover), in the lane Info tab, and as a repo total in the board header ("Lanes: 7 · 3.4 GB"). Low-disk guard in file 08 §6.7.
- Lanes `accepted` beyond the cap or older than `idleDays` → suggest cleanup in the board's Done column ("12 finished lanes still have worktrees (3.4 GB) — Clean up").

## 7. Step-by-step implementation plan

1. Naming utilities (slug, branch, folder, collision handling, `check-ref-format`). Test: unicode titles, issue keys, D/F conflicts.
2. Config resolution: git-config local keys (incl. legacy `githappens.agentSetup`), committed JSONC parsing with schema validation, effective merge. Test: precedence, parse errors, unknown keys warned.
3. Trust store integration (file 08 §6.5) and trust prompt. Test: hash change re-prompts, deny persists.
4. `hive.lane.create` op incl. preconditions, marker, view-settings inheritance, submodules, sparse mirroring. Test with fixture repos (`worktrees`, `submodules`, `lfs`, sparse).
5. Ignored-file copy/symlink with limits and private-key guard. Test: globs matching tracked files are skipped.
5a. Dependency reuse (G7): lockfile invalidation, CoW clone per platform (APFS clonefile, reflink, ReFS block cloning via the native helper), symlink/junction, copy, fallback. Test on CI runners per OS with a temp APFS/Btrfs/ReFS volume where available; NTFS/ext4 fallback path always tested.
6. Setup runner (sequential steps, per-repo parallelism cap, timeouts, logs, retry/skip) and check runner (G5) sharing it. Test with scripts that fail, hang, print lots.
7. Port allocator with probe. Test: two lanes never share a block; busy port skipped.
8. Run command (concurrent/exclusive). Test exclusive stops the other lane's run.
9. Discard with snapshot, teardown, undo. Test: undo restores branch, worktree and uncommitted + untracked files.
10. GC and cleanup UI. Test: retention expiry deletes refs; orphan folders listed, not deleted.

## 8. Edge cases

- **Base branch checked out elsewhere:** irrelevant for creation (we branch from its sha).
- **Empty repo / unborn HEAD:** Hive requires at least one commit; New Task shows "Make a first commit to use Hive".
- **Detached HEAD as base:** allowed (`base.ref = 'HEAD'`, landing then requires choosing a target branch).
- **Shallow clone:** worktrees work; merge-base may be missing → WIP ahead/behind shows "?" and accept falls back to requiring a fetch (`git fetch --deepen` offer).
- **Partial clone (`--filter=blob:none`)**: worktree add fetches blobs lazily; progress shown; offline → `worktree-failed` with network hint.
- **Worktree root on another drive / network share:** allowed; warn for network shares (watchers and performance).
- **Case-only branch collisions on case-insensitive FS** (`hive/Fix` vs `hive/fix`): slugs are lowercase; check `refs/heads` case-insensitively on Windows/macOS.
- **User manually deletes the lane folder:** reconciliation marks lane `error`; actions Recreate (`git worktree prune` + add from branch) / Discard.
- **User checks out another branch inside the lane worktree:** lane `branch` updated to the new HEAD with a warning in Info ("Lane branch changed from X to Y"); accept uses the current branch.
- **Setup modifies tracked files** (e.g. lockfile churn): shown as WIP before the agent even starts; Info tab notes "Setup changed 1 tracked file" and offers "Discard setup changes".
- **Antivirus/indexers locking files on Windows** during removal: retry + deferred deletion (§6.7).
- **Thousands of lanes over time:** worktree list caps (spec 09 caps WIP nodes at 20); Hive itself keeps only non-discarded lanes in `state.json`; discarded lanes are pruned from state after retention.

## 9. Acceptance criteria

- [ ] New lane from a task is created at `<repo>.worktrees/<slug>-<id>` on a `hive/…` branch from the chosen base in ≤ 2 s on a 100k-file repo (excluding setup).
- [ ] Setup steps from git config run in order with streamed output; failure stops the agent from starting and offers retry/skip.
- [ ] A committed `.githappens/hive.jsonc` never runs before the user trusts its exact contents; a modified file re-prompts with a diff.
- [ ] Gitignored `.env` files listed in `copy` appear in new lanes; tracked files are never overwritten.
- [ ] Two concurrent lanes get disjoint port blocks exposed as `GITHAPPENS_HIVE_PORT`.
- [ ] Discard removes folder, branch and port block; Undo restores all of them including uncommitted and untracked files.
- [ ] Adopted worktrees are never deleted by Hive.
- [ ] With a `node_modules` reuse rule on APFS, Btrfs or ReFS/Dev Drive, a new lane gets a working `node_modules` in under 5 s without running install; on NTFS/ext4 the fallback runs setup (G7).
- [ ] Only the 15 most recent closed lanes keep worktrees; older ones are cleaned with an Undo toast; per-lane and total disk usage is displayed (G7).
- [ ] Check commands from repo config run in the lane and report pass/fail per check (G5).

## 10. Out of scope / later

- Container/devcontainer-based lanes (G21; file 08 §10, file 11 H6+).
- Adopting worktrees that agents create on their own (Claude `--worktree`, Codex app, agent teams) as lanes automatically (G16; today they can be adopted manually with `hive:lane:adopt`).
- Automatic detection of reuse candidates without configuration (we only suggest them).
- Multi-repo lanes (one task, several repos).
- Remote worktrees over SSH.

## 11. Cross-spec dependencies

- **Spec 09 §6.10** worktree create/remove/prune commands, default path convention, view-settings inheritance, Windows long paths; spec 09's Create Worktree dialog stays for manual worktrees.
- **Spec 02** `git:config:set` (queued), `git:worktrees`, OperationQueue, progress parsing.
- **Spec 05 §6.11** snapshot technique (temp index for untracked) and keep-alive refs; `branch:validateName`.
- **Spec 13** repo-specific "Agents" section becomes "Hive"; `RepoSettings.agentSetupCommands` is implemented as git config `githappens.agentSetup` (matches the shipped code); `terminal.shell` used for steps.
- **Spec 12** PtyService for the Run command.
- **File 08** trust store, env filtering, disk limits.
