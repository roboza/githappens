# Hive 07 — Coordination: Dependencies, Scope, Conflict Prediction, Merge Queue & Shared Instructions

> Owns: `CoordinationService` — task dependencies and sequencing; declared file scope and overlap/out-of-scope detection (G12); the cross-lane conflict matrix built on spec 08's `merge-tree` prediction; restacking lanes on a moving base; the local merge queue; shared instructions composed for every agent; the data that feeds the graph's Hive lens (G3: conflict edges, dependency arrows, fan-out groups).

## 1. Purpose

Parallel agents fail in a predictable way: two of them edit the same files, each result looks fine alone, and the second merge explodes. Hive can see every lane's changes as they happen, so it can warn early (scope overlap before start, predicted conflicts while running), order work (dependencies, a merge queue that restacks the rest after each landing), and give all agents the same ground rules (shared instructions).

## 2. Reference behavior

- The vendor's separate agent environment advertises flagging branches that are about to collide, keeping branches current automatically and routing conflicts it cannot reconcile to the user, plus shared instructions per task *(marketing-level; details not documented)*.
- The reference desktop app's earlier "conflict prevention" feature (our spec 14 §6.5 and spec 08 §4.9) predicts conflicts against a target branch with `git merge-tree`; GitHappens already ships this backend-free.
- Market (file 00): Cline Kanban card dependencies (finishing one starts the next); small tools (2026) predicting conflicts between parallel agent branches with `merge-tree` and suggesting a safe merge order, or "sealing" paths per agent; AGENTS.md/CLAUDE.md as the de-facto shared-instructions files.

## 3. User stories

1. As a user I want to declare that task B depends on task A, and have B start (or rebase) once A lands.
2. As a user I want to be warned before starting a lane whose declared scope overlaps an active lane (G12).
3. As a user I want to be told while agents run that two lanes will conflict, with the files, so I can stop one or sequence them.
4. As a user I want to land several finished lanes in order, with the rest automatically restacked onto the new base and conflicts handed to me or the agent.
5. As a user I want every agent to receive the same repo rules (AGENTS.md, test commands, port conventions) without editing each prompt.
6. As a user I want to see all of this in the graph (G3) and on the board.

## 4. UI specification

### 4.1 Conflict matrix (board header "Conflicts ⚠ 2" → popover / full view)

```
Predicted conflicts — acme/web (updated 12:44, auto-refresh while lanes run)
               main   Fix login   Refactor auth   Bump deps
main            ·       ✓            ⚠ 1            ✓
Fix login       ✓       ·            ⚠ 2            ✓
Refactor auth   ⚠ 1     ⚠ 2          ·              ✓
Bump deps       ✓       ✓            ✓              ·
Cell click → files list (+ "Show both diffs" + "Overlap only, no conflict" items)
Actions per pair: Sequence (make B depend on A) · Stop B · Message B's agent ("Avoid editing src/auth/session.ts; Fix login owns it")
Legend: ✓ clean · ◐ overlapping files, merges cleanly · ⚠ conflicts · ? unknown (old git / timeout)
```

### 4.2 Dependencies

- In New Task (file 05) and the card menu: "Depends on…" (multi-select of tasks in the repo). Card shows "waits for: Fix login" chips; graph lens draws arrows.
- Dependency modes per edge: **Wait** (default: B is queued until A is accepted; B's base = A's target after landing) or **Stack** (B starts now from A's lane branch; B is restacked when A changes or lands). Stack mode is the seed of stacked lanes (G10, deferred for PR stacks).

### 4.3 Merge queue (board footer / Review column header "Land in order…")

```
Merge queue → main
 1. Fix login            ✓ checks  ✓ clean vs main
 2. Bump deps            ✓ checks  ✓ clean after 1
 3. Refactor auth        ✗ test    ⚠ conflicts after 1 (2 files)
[Run queue]  Stop on: (●) first conflict ( ) first failing check   Method: [Squash ▾]   After each: restack the rest ✓ run checks ✓
```

Rows drag to reorder; the "after N" columns are predictions computed by chaining merge-trees (§6.4).

### 4.4 Shared instructions (Repo settings → Hive → Instructions; task dialog "Instructions" section)

- Sources (ordered): repo files listed in config `instructions` (default: `AGENTS.md` if present; plus `CLAUDE.md` only for non-Claude agents, since Claude reads it natively), Hive's generated lane facts, the repo-level "Hive instructions" text (local), and the task-level additional instructions.
- Preview of the composed instructions per adapter.

## 5. Data model & IPC

```ts
export interface TaskDependency { taskId: HiveId; dependsOn: HiveId; mode: 'wait' | 'stack' }

export interface ConflictMatrix {
  repoKeyHash: string;
  computedAt: number;
  nodes: Array<{ id: 'base' | HiveId /* laneId */; label: string; ref: string; snapshotSha: Sha }>;
  base: { ref: string; sha: Sha };
  cells: Array<{
    a: string; b: string;                        // node ids, a < b
    state: 'clean' | 'overlap' | 'conflict' | 'unknown';
    overlapFiles: string[];                      // paths changed on both sides (vs their merge-base)
    conflictFiles: string[];                     // from merge-tree
    computedFor: [Sha, Sha];                     // snapshot shas used
  }>;
  scopeOverlaps: Array<{ a: HiveId; b: HiveId; globs: string[] }>;   // declared-scope overlaps between tasks (G12)
}

export interface MergeQueue {
  repoKeyHash: string;
  target: string;
  laneIds: HiveId[];
  method: AcceptReq['method']; history: AcceptReq['history'];
  stopOn: 'conflict' | 'check-failure';
  predictions: Array<{ laneId: HiveId; afterPrevious: 'clean' | 'conflict' | 'unknown'; files: string[] }>;
  running?: { index: number; opId: string };
}
```

IPC: `hive:conflicts:matrix`, `hive:queue:get|set|run` (file 01 §5.4); event `hive:conflicts:updated`. Dependencies are part of `hive:task:update { dependsOn }` with mode stored alongside (`HiveTask.dependsOn` holds ids; modes in `HiveTask.dependencyModes?: Record<HiveId, 'wait' | 'stack'>`).

## 6. Implementation details

### 6.1 Conflict matrix computation

- **Nodes:** the base (per distinct base ref among active lanes — usually one) + each lane that is `running|stopped|review` (not provisioning/accepted/discarded), using the lane **snapshot** (file 06 §6.1) so uncommitted work counts.
- **Cheap prefilter (overlap):** for each node, the changed-path set vs its merge-base with the base (`git diff --name-only -z <mergeBase> <snap>`), cached by snapshot sha. Pairs with no shared path → `clean` without running merge-tree.
- **Prediction (git ≥ 2.38, spec 00 policy):** for pairs with shared paths: `git merge-tree --write-tree --name-only --no-messages <snapA> <snapB>` (merge-base computed by git); exit 0 → `overlap` (merges cleanly), exit 1 → `conflict` with listed paths; other exits → `unknown`. Lane-vs-base uses the base tip vs lane snapshot (equivalent to spec 08 §6.9 / spec 14 §6.5).
- **Budget:** at most `hive.conflicts.maxPairs` (default 45 = 10 nodes) per refresh; pairs ordered by overlap size; 20 s total time box (spec 14 §8 precedent), idle priority (`nice` on POSIX, below-normal priority class on Windows); results cached by `(snapA, snapB)` in an LRU of 512.
- **Refresh triggers:** lane snapshot change (debounced 30 s while agents run), base tip change (fetch/commit), lane created/closed, manual refresh. Runs only while a Hive view or the graph lens is visible, or when a lane is about to start/land.
- **Older git:** `unknown` with "Conflict prediction needs git 2.38+" hint; overlap still shown.

### 6.2 Notifications from the matrix

- New `conflict` cell involving a running lane → `conflict` attention item (priority 2) once per pair per snapshot pair, with actions: Sequence, Stop one, Message an agent (pre-filled feedback text naming the files and the other lane), Dismiss for this pair.
- Message-an-agent uses the G1 feedback channel (file 06 §6.2) — Hive never edits files to resolve.

### 6.3 Dependencies and sequencing

- **Wait mode:** B stays `queued` (task stage) until A's lane is accepted; then B's base is set to A's target branch tip and B starts automatically if `hive.deps.autoStart` (default true; else an attention `review`-priority item "Ready to start").
- **Stack mode:** B's lane is created from A's lane branch tip (`base = { ref: <A branch>, sha }`). When A's branch moves (agent commits, shaping), B is marked "behind its parent"; restack is offered (§6.5), automatic only when B has no live run and `hive.deps.autoRestack` is on. When A lands, B's base switches to A's target and B is restacked with `git rebase --onto <target> <A old tip> <B>` (handles squash landing).
- Cycles are rejected at edit time (DFS). Deleting/archiving A asks what to do with dependents (drop dependency / archive too).
- The graph lens draws dependency arrows from this data (file 04 §4.8).

### 6.4 Merge queue

- The queue is an ordered list of lanes for one target. Predictions chain merge-trees: simulate landing lane 1 on the target (`tree1 = merge-tree target L1`), create an in-memory commit (`commit-tree tree1 -p target -p L1`, unreferenced), then test lane 2 against it, and so on; squash/rebase methods use the same approximation (merge result tree) for prediction.
- **Run:** for each lane in order: guards → `hive.lane.accept` (file 06 §6.3) → if `restackRest`, restack remaining lanes onto the new target tip (§6.5) → if `runChecks`, run required checks on the next lane after its restack → stop on the configured condition and raise an attention item explaining where and why. Each landing is its own journal entry (undoable individually, newest first).
- The queue never pushes the target unless "Push target after queue" is ticked (single push at the end).

### 6.5 Restack (`hive.lane.restack`)

- Preconditions: no live run (or pause), lane clean or WIP auto-stashed (`git -C <lane> stash push -u`, popped after).
- `mode: 'rebase'`: `git -C <lane> rebase <onto>` (or `--onto <new> <oldBase>` for stacked lanes); conflicts → spec 08 flow in the lane worktree, or "Ask the agent to resolve" (feedback prompt including the conflicted files; the agent runs `git rebase --continue` itself), or abort (`git rebase --abort`).
- `mode: 'merge'`: `git -C <lane> merge --no-ff <onto>` — safer for lanes already pushed to a PR (no force push needed).
- Lane `base.sha` updated; checkpoint `before-rebase` taken first; journal kind `rebase`/`merge`.
- Auto-restack never runs on a lane with a live agent run, an active handoff, or unsent review comments.

### 6.6 Scope declarations (G12)

- `task.scope` = list of globs (picomatch, relative to repo root; `!` negation allowed).
- **Pre-start overlap:** when creating/starting a task with scope S, compare with every active lane's (a) declared scope — glob-vs-glob overlap is approximated by testing each glob's literal prefix against the other's globs and by matching both against the tracked file list (`git ls-files -z`, cached per HEAD), reporting concrete overlapping files; (b) actual changed paths of active lanes matched against S. Overlaps produce the New Task warning (file 05 §4.1) and a `scope` cell in the matrix.
- **Out-of-scope edits:** on each snapshot refresh, lane changed paths not matching the task scope → `lane.scopeViolations`, `scope` attention item (once per new path set), red marker in review, "Outside scope" column in compare.
- **Optional enforcement** (opt-in per task, `scope.enforce`): for adapters with answerable pre-tool hooks (Claude `PreToolUse`, Copilot `preToolUse`, Codex `PreToolUse`), the hook bridge denies write/edit tool calls whose target path is outside scope with a reason the agent sees ("Path outside the task scope src/auth/**; ask the user"). Shell commands cannot be reliably path-checked; they are not blocked by scope (file 08 §6.3).
- Scope is advisory text in the prompt for all agents (`{{scope}}`).

### 6.7 Shared instructions

Composed per run into `userData/…/hive/run/<runId>/instructions.md` (deleted after the run) and delivered via the adapter (file 02 `instructionsDelivery`):

```
# Working in a GitHappens Hive lane
- You are working in a git worktree at <path> on branch <branch>, created from <base>. Other agents may be working on the same repository in other worktrees; do not modify files outside this worktree.
- Commit your work on this branch in logical commits with clear messages. Do not push, do not create pull requests, do not switch branches, do not rewrite history before <base>.
- (if scope) Limit changes to: <globs>.
- (if ports) Use ports <p>–<p+n-1> for any servers you start; $GITHAPPENS_HIVE_PORT is the first one.
- (if checks) Before you finish, run: <check commands>.
- (if sibling lanes, opt-in) Other active lanes are changing: <branch>: <top paths>…
- (if plan gate approved) Follow the approved plan below.
<repo instruction files, verbatim, each under its own heading, capped at 32 KiB total>
<repo "Hive instructions" text>
<task additional instructions>
```

- The text is ours; repo files are included verbatim (they are the user's). Files that are already natively read by the agent (Claude reads `CLAUDE.md`; Codex/Copilot/others read `AGENTS.md` natively in recent versions *(verify per adapter)*) are not duplicated for that adapter (`nativeInstructionFiles` per adapter).
- Hive never writes instruction files into the worktree (they would show up as changes and get committed).

### 6.8 Data for the graph lens (G3)

`CoordinationService.lensModel(repo)` returns: lane chips (tip sha, status, checks, ahead/behind), conflict edges (matrix cells with `conflict`, plus `overlap` drawn faint when "show overlaps" is on), fan-out groups (lanes per task with > 1 lane), dependency arrows (§6.3), base markers (base tip at lane creation vs now). Spec 04 renders it via the overlay API (file 04 §6).

## 7. Step-by-step implementation plan

1. Changed-path sets per snapshot + overlap prefilter. Test: fixture with 3 lanes and overlapping files.
2. Pairwise merge-tree with budget, priority, cache, older-git fallback. Test: conflict/overlap/clean cases incl. rename/delete conflicts.
3. Matrix refresh triggers + `hive:conflicts:updated` + attention items. Test: running fake agents editing the same file produce exactly one conflict item.
4. Scope globs: overlap detection, out-of-scope detection, prompt text. Test: negations, nested globs.
5. Optional scope enforcement via hooks (Claude first). Test: write outside scope denied with reason; shell not blocked.
6. Dependencies (wait/stack), cycle detection, auto-start. Test: B starts after A accepted with the right base.
7. Restack (rebase/merge, stacked `--onto`, WIP stash, conflict choices). Test: stacked lane restack after parent squash-landing.
8. Merge queue predictions and run loop with stop conditions. Test: 3-lane queue where the third conflicts after the first.
9. Shared instructions composer with per-adapter native-file dedup. Test: golden outputs per adapter.
10. Lens model for spec 04. Test: snapshot of the model for fixtures.

## 8. Edge cases

- **Lanes with different bases:** matrix shows each base node; lane-vs-lane prediction still uses merge-tree's own merge-base.
- **Renames on one side, edits on the other:** merge-tree handles rename detection; overlap prefilter uses rename-aware diffs (`-M`) to include old paths.
- **Binary conflicts / submodules / mode changes:** reported as conflicts with the path; no hunks.
- **Very many lanes (> 10 nodes):** only the pairs with largest overlap within budget; the rest `unknown` with "Refresh more".
- **Snapshot churn while an agent works:** debounce + cache; matrix shows "computed for state at 12:44".
- **Dependency on a task whose lane is discarded:** dependents get an attention item "Dependency discarded — remove dependency or archive".
- **Queue target checked out and dirty:** queue stops before the first landing with `base-dirty`.
- **Restack of a lane already pushed to a PR:** default to merge mode to avoid force-push; rebase requires confirmation and later `--force-with-lease`.

## 9. Acceptance criteria

- [ ] Two running fake agents editing the same lines produce a `conflict` cell and one attention item within 60 s; editing different files produces none.
- [ ] Starting a task whose scope overlaps an active lane warns with concrete files before any lane is created.
- [ ] Out-of-scope edits are flagged in review and compare; with enforcement on, Claude Code write tools outside scope are denied with a visible reason.
- [ ] Wait-dependency: B starts automatically on A's acceptance with base = target tip; stack-dependency: B is restacked correctly after A squash-lands.
- [ ] Merge queue lands lanes in order, restacks the rest, and stops at the first predicted/actual conflict with a clear attention item; each landing is individually undoable.
- [ ] Shared instructions reach every adapter, without duplicating files the adapter reads natively, and nothing is written into the worktree.
- [ ] The lens model drives conflict edges and dependency arrows in the graph (file 04).

## 10. Out of scope / later

- Stacked PRs created from stack dependencies (G10).
- Semantic (LLM-based) conflict checks between lane diffs (G19).
- Multi-repo coordination (G20).
- Team-wide conflict prediction against teammates' lanes (spec 14 footprints; file 10).
- Agent-to-agent messaging and coordinator agents (G25; non-goal for v1 — only the "message an agent" convenience that the *user* sends).
- Hard path locking ("seals") across agents beyond the opt-in write-tool denial.

## 11. Cross-spec dependencies

- **Spec 08 §6.9 / spec 14 §6.5:** merge-tree prediction semantics, caching, time box and idle priority are reused verbatim; the matrix is a generalization to lane pairs.
- **Spec 05:** rebase/merge operations and journal kinds; stash ops for restack.
- **Spec 04:** overlay API for lens (file 04 §6).
- **Spec 02:** git version feature flag `mergeTreeWriteTree`.
- **Files 05/06/02:** scope field and prompt, accept/restack ops, hook-based enforcement.
