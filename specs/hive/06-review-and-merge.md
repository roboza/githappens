# Hive 06 — Review, Feedback, Checks, Landing, Handoff & Checkpoints

> Owns: the lane review surface; inline review comments and the feedback loop back to the agent (G1); lane checks and forge CI as landing guards (G5); comparing fan-out lanes; commit shaping with agent trailers and identity/signing policy (G2); accepting a lane (merge, squash, rebase + fast-forward, push to PR, create PR); conflict handoff; discarding; "try it locally" handoff between lane and main checkout (G6); checkpoints and restore; undo integration with the spec 05 journal; provenance capture for later agent blame (G4 data).

## 1. Purpose

Agents are cheap to start and expensive to trust. This is where a Git client earns its place: show exactly what an agent changed against the right base, let the user push back with precise comments, prove the lane works (checks), turn messy agent history into reviewable commits, land it the way the team lands code, and make every step undoable.

## 2. Reference behavior

- The reference desktop app's worktree cards show uncommitted changes, ahead/behind and linked PRs; reviewing uses the normal WIP/commit views of each worktree; its marketing describes organizing an agent's raw changes into logical commits with its commit composer before committing *(inferred from marketing)*. Cleanup is "remove worktree and delete branch".
- The vendor's separate agent environment shows files an agent changed per worktree, opens diffs next to the producing session, lets the user stage files and write the commit message in the same view, shows merge readiness, keeps branches current, and routes unresolvable conflicts to the user.
- Comparable tools: Vibe Kanban sends batched diff comments back to the agent and offers rebase/merge/PR from the diff header; the Codex app has a review queue with inline comments and approve/revise/reject; Cline Kanban asks the agent to produce a clean commit/PR; Conductor shows checks per workspace; Copilot coding agent and Jules react to PR review comments; Cursor compares fan-out results side by side. Nobody offers undoable landings or commit shaping with provenance (file 00).

## 3. User stories

1. As a reviewer I want the lane diff against its merge-base with the base, including uncommitted and untracked files, file by file.
2. As a reviewer I want to leave comments on lines and send them to the agent in one go, then see which ones were addressed (G1).
3. As a reviewer I want PR review threads and failing CI to feed the same loop (G1).
4. As a user I want to run the repo's checks in the lane and be stopped (with an override) from landing a lane whose checks fail (G5).
5. As an explorer I want to compare three lanes for the same task, file by file, with checks, size, scope and cost side by side, and take one (or take one file from another).
6. As a user I want to land as merge, squash or rebase, or open a PR, and choose whether to keep, squash or compose the agent's commits, with trailers recording which agent/session produced them (G2).
7. As a user I don't want my signing key used for commits an agent made without my consent (G2).
8. As a user I want to try the lane in my main checkout (where my dev environment is) and go back (G6).
9. As a user I want to rewind a lane to a checkpoint from before the agent went off the rails.
10. As a user I want Undo for accept, discard, shaping, handoff and restore.

## 4. UI specification

### 4.1 Changes tab / expanded review view

```
LaneReview (hive/fix-login-3fa2 → main, merge-base a1b2c3d)                   [Expand ⤢]
├─ ReviewHeader: ↑3 ↓1 · 12 files +240 −31 (3 uncommitted, 1 untracked) · scope ✓ · conflicts: none with main, ⚠ 2 files with "Refactor auth"
│               Checks: ✓ lint ✓ typecheck ✗ test (3 failing) · CI: — · Cost $0.84 · 18m
├─ Toolbar: View [All changes ▾ | Committed | Uncommitted | Since last review | Since checkpoint ▾]  Diff [Hunk|Inline|Split]  [Run checks]
├─ Left: file tree with status letters, comment counts, "outside scope" markers, "viewed" checkboxes
├─ Center: Monaco diff (spec 07) with comment gutter (+ on hover), existing comments inline, outdated comments collapsed
├─ Right (collapsible): Commits (agent commits list, base..lane) · Feedback (draft comments queue, sent rounds) · Report (agent's end-of-run report, G5)
└─ Footer (LandingBar): [Send feedback (3) ▸]   [Try in main checkout]   [Commit WIP…]   [Shape ▾]   [Accept ▾]   [Discard…]
```

- **Since last review**: diff between the lane state at the last "Send feedback" round (a checkpoint taken at send time) and now — what the agent changed in response.
- **Viewed** checkboxes per file persist per lane and reset when the file changes.
- Comment composer: markdown, `Mod+Enter` adds to draft queue; "Add & send now" sends immediately as a single-comment round.

### 4.2 Landing bar actions

- **Commit WIP…**: commits uncommitted changes in the lane (spec 06 composer embedded; AI commit message available, spec 12). Required before Accept when WIP exists, unless "Include uncommitted changes" is ticked in the accept dialog (Hive commits them first with an auto message + trailers).
- **Shape ▾** (G2): Keep commits (add trailers) · Squash into one commit… · Compose with AI… (spec 12 Commit Composer on range `mergeBase..lane`) · Reword… — each a `hive.lane.shape` op, undoable.
- **Accept ▾**: Merge into `main` · Squash into `main` · Rebase onto `main` and fast-forward · Fast-forward only · Push to PR #482 (PR lanes) · Create pull request… · Merge into another branch…
- **Try in main checkout** (G6).
- **Discard…**: dialog with "Keep branch" checkbox, a summary of what will be removed, and the undo window ("recoverable for 30 days").

### 4.3 Accept dialog

```
Accept "Fix login redirect loop" (Claude Code)
Into:      [main ▾]   (checked out in main worktree: clean ✓)
Method:    (●) Merge commit  ( ) Squash  ( ) Rebase + fast-forward  ( ) Fast-forward only
History:   (●) Keep agent commits (3)  ( ) Squash to one  ( ) Compose with AI…        (G2)
Message:   [Fix login redirect loop (#482)                          ]  (squash/merge commit message; AI ✨)
Trailers:  Agent: claude-code · Agent-Model: opus · Agent-Session: 7c5d… · Task: 01J…   [edit]
Author:    Me (Robert Oswald) — commits are authored by you; the trailers record the agent (G2, decided 2026-10-12)
Signing:   [x] Sign the commits I create now (uses your signing setup)   Agent-made commits: unsigned (policy)  (G2)
Guards:    ✗ Checks: test failed 4 min ago on this state  [Run again] [View log]   [ ] Accept anyway (recorded in audit log)   (G5, decided 2026-10-12)
           ✓ No predicted conflicts with main   ✓ No live agent run   ✓ Scope respected
After:     [x] Remove worktree (keeps last 15 closed lanes otherwise)  [x] Delete branch   [ ] Push main to origin
                                                                       [Cancel]   [Accept  Mod+Enter]
```

Disabled states with reasons: live run ("Stop the agent first" + button), base dirty (offer stash flow), predicted conflicts (offer §6.4 handoff choices), failing required checks without override.

### 4.4 Compare view (fan-out)

```
Compare — "Fix login redirect loop" (3 lanes)
┌──────────────────┬─────────────┬─────────────┬─────────────┐
│                  │ Claude Code │ Codex       │ Gemini      │
├──────────────────┼─────────────┼─────────────┼─────────────┤
│ Status           │ idle        │ idle        │ error       │
│ Files / +/−      │ 4 · +60 −12 │ 9 · +210 −40│ 2 · +8 −3   │
│ Checks           │ ✓✓✓         │ ✓✓✗         │ —           │
│ Outside scope    │ 0           │ 2           │ 0           │
│ Conflicts w/ base│ none        │ 1 file      │ none        │
│ Cost / time      │ $0.84 · 18m │ $1.10 · 25m │ $0.20 · 4m  │
│ Report           │ summary ▸   │ summary ▸   │ —           │
│                  │ [Accept…]   │ [Accept…]   │ [Accept…]   │
├──────────────────┴─────────────┴─────────────┴─────────────┤
│ File matrix: rows = union of changed paths, cells = +/− or ·  (click → diff)  │
│ Diff mode: [Each vs base | A vs B (pick two)]                                │
└──────────────────────────────────────────────────────────────────────────────┘
```

- **A vs B** diff: `git diff <laneA-snapshot> <laneB-snapshot> -- <path>` (snapshots include WIP, §6.1).
- **Take this file from…** *(our extension)*: in lane A's diff of a file, "Use Codex's version" checks out that path from lane B's snapshot into lane A's worktree (`git -C <laneA> checkout <laneBSnap> -- <path>`), journaled as a `discard`-kind entry with the previous content captured, so the user can combine the best parts before accepting one lane.
- **Accept one:** after accepting a lane, a prompt offers "Discard the other 2 lanes" (default on; recoverable 30 days).
- No automatic ranking or winner selection (G18 deferred; non-goal for auto-landing).

### 4.5 Try in main checkout (G6)

Confirm popover: "Your main worktree has 2 changed files — they will be stashed (undoable). The lane's agent is paused while its branch is checked out in main." Buttons: [Move lane to main] [Cancel]. While handed off, the lane card shows "In main checkout" with **[Move back]**; the main repo tab shows a banner "You are trying lane 'Fix login' — Move back · Accept from here".

### 4.6 Checkpoints tab

List: `#7 · after turn "add tests" · 12:41 · 9 files +180 −20` with actions **Diff vs current**, **Diff vs previous**, **Restore…** (dialog: "Restore files only (keep commits)" vs "Restore files and branch position"; a `before-restore` checkpoint is taken automatically), **Create checkpoint now**.

## 5. Data model & IPC

```ts
export interface LaneReviewSummary {
  laneId: HiveId;
  base: { ref: string; sha: Sha }; mergeBase: Sha | null;
  snapshotSha: Sha;                      // commit representing lane HEAD + WIP (§6.1)
  commits: Array<{ sha: Sha; summary: string; author: string; trailers: Record<string, string> }>;  // mergeBase..HEAD
  files: Array<FileChangeSummary & { committed: boolean; uncommitted: boolean; untracked: boolean; outsideScope: boolean; comments: number; viewed: boolean }>;
  conflicts: { withBase: string[]; withLanes: Array<{ laneId: HiveId; files: string[] }> };
  checks: LaneChecksSummary | null;
  report?: { summary: string; testsRun?: string[]; knownGaps?: string[] };
  usage?: UsageTotals;
  guards: AcceptGuard[];
}
export type AcceptGuard =
  | { kind: 'live-run'; sessionIds: HiveId[] } | { kind: 'wip-uncommitted'; files: number }
  | { kind: 'checks-failed'; ids: string[] } | { kind: 'checks-stale' } | { kind: 'forge-ci'; rollup: 'pending' | 'failure' }
  | { kind: 'conflicts-base'; files: string[] } | { kind: 'base-dirty'; worktree: string; files: number }
  | { kind: 'scope'; files: string[] } | { kind: 'handoff-active' } | { kind: 'behind-base'; behind: number };

export interface LaneCompareResult {
  lanes: Array<{ laneId: HiveId; snapshotSha: Sha; files: FileChangeSummary[]; checks: LaneChecksSummary | null; outsideScope: number; conflictsWithBase: number; usage?: UsageTotals }>;
  pathMatrix: Array<{ path: string; cells: Array<{ additions: number | null; deletions: number | null } | null> }>;
}

export interface FeedbackReq {                 // G1
  laneId: HiveId;
  commentIds: HiveId[];                        // drafts to send (local, pr-thread, ci)
  includeCi?: { checkIds?: string[]; forgeRunIds?: string[] };
  extra?: string;                              // free text added to the round
  target: { sessionId: HiveId } | { newSessionAdapter: AdapterId };   // continue existing session or start a new one in the lane
}

export type ShapeReq = { laneId: HiveId } & (
  | { kind: 'trailers-only' }
  | { kind: 'squash'; message: string }
  | { kind: 'compose'; proposal: unknown /* spec 12 ComposeProposal */ }
  | { kind: 'reword'; sha: Sha; message: string }
) & { sign: boolean };                    // author is always the user (decided 2026-10-12)

export interface AcceptReq {
  laneId: HiveId;
  into: string;                                // target branch (local name)
  method: 'merge' | 'squash' | 'rebase-ff' | 'ff' | 'push-to-pr';
  history: 'keep' | 'squash' | 'compose';      // applied via shape first when not 'keep'
  message?: string;                            // merge/squash message
  includeWip: boolean;
  sign: boolean;                               // author is always the user (decided 2026-10-12)
  overrideGuards: Array<AcceptGuard['kind']>;  // only 'checks-failed' | 'checks-stale' | 'forge-ci' | 'scope' | 'behind-base' are overridable
  after: { removeWorktree: boolean; deleteBranch: boolean; pushTarget: boolean };
}

export interface CreatePrFromLaneReq {
  laneId: HiveId;
  remote: string; remoteBranch?: string;       // default: lane branch name
  base: string;                                // PR target (default: lane base ref)
  title: string; body: string;                 // prefilled from task + report + spec 12 prDraft (optional)
  draft: boolean;                              // default true
  linkIssue?: boolean;                         // "Fixes #482" line
  labels?: string[]; reviewers?: string[];
  history: 'keep' | 'squash' | 'compose';
}
```

IPC: file 01 §5.4 (`hive:review:*`, `hive:checks:*`, `hive:lane:accept|discard|restack|createPr|shape|handoff|fromWip|commitWip`, `hive:checkpoint:*`).

## 6. Git implementation

### 6.1 Lane snapshot and diffs

All review reads use a **snapshot commit** that represents "lane HEAD + uncommitted + untracked" without touching the lane's index:

```
tmp=$(mktemp)                                  # temp index file
GIT_INDEX_FILE=$tmp git -C <lane> read-tree HEAD
GIT_INDEX_FILE=$tmp git -C <lane> add -A -- .  # respects .gitignore; ignored files excluded
tree=$(GIT_INDEX_FILE=$tmp git -C <lane> write-tree)
snap=$(git -C <lane> commit-tree $tree -p HEAD -m "githappens hive snapshot")   # GIT_AUTHOR/COMMITTER fixed to "GitHappens Hive <hive@localhost>" and epoch from HEAD to keep it deterministic
```

Cached by `(HEAD sha, status fingerprint)`; not referenced (GC-able) unless promoted to a checkpoint. Runs in the read pool with `GIT_OPTIONAL_LOCKS=0` (the temp index avoids `index.lock` on the lane).

Diffs: `mergeBase = git merge-base <base.sha> HEAD` (lane), file list `git diff --numstat -z -M <mergeBase> <snap>`, per-file content through spec 02 `git:diff` with a `range` spec `{ from: mergeBase, to: snap }`. "Committed" = `mergeBase..HEAD`; "Uncommitted" = `HEAD..snap`.

### 6.2 Review comments and the feedback loop (G1)

- Comments anchor to `(path, side, line)` plus `anchor.lineText` and `hunkHeader`. After the lane changes, re-anchor: search for `lineText` within ±20 lines of the old position in the new snapshot; if found move, else mark `outdated` (shown collapsed with the old hunk).
- **Sending a round:** take a checkpoint (`trigger: 'manual'`, label "Before feedback round N") so "Since last review" works; compose the feedback prompt; deliver through `hive:session:send` semantics (file 02 §6.3.5) to the chosen session (or start a new session in the lane with the chosen adapter); mark comments `sent` with `sentInRound`.
- **Prompt format** (plain text, stable for agents):

  ```
  Review feedback (round 2) for branch hive/fix-login-3fa2. Address each item, then summarize what you changed per item number.

  1. src/auth/callback.ts:42 (new)
     > if (!session) return redirect('/login')
     Comment: This still loops when the cookie is expired but present. Check expiry first.

  2. test/auth/callback.test.ts (file)
     Comment: Add a test for the expired-cookie case.

  CI / checks:
  3. check "test" failed (exit 1), last 60 lines:
     …log excerpt (redacted)…
  ```

- **PR threads** (`origin: 'pr-thread'`): imported via spec 10 `pr:timeline` (unresolved, not outdated); after the agent's round, the user may "Reply & resolve on PR" per thread (spec 10 `pr:comment` + `pr:resolveThread`), never automatically.
- **CI** (`origin: 'ci'`): from lane checks (local logs) or forge checks (spec 10 `ci:list` + job log); excerpt = last 60 lines of failing step, redacted (file 08 §6.4).
- **Addressed detection** (advisory): after the agent's next `turn-complete`, a comment whose anchored lines changed is marked "probably addressed" (user still resolves).

### 6.3 Accepting a lane (`hive.lane.accept`)

Order: guards → optional WIP commit → optional shaping (§6.7) → `before-accept` checkpoint → integrate → post-steps. One journal entry `hive-accept` covers integrate + post-steps (shaping has its own entry).

**Guards** (computed fresh inside the op, not trusted from the UI):

1. No live run in the lane (`live-run`, not overridable).
2. No handoff active (not overridable).
3. Target branch exists: `git rev-parse --verify -q refs/heads/<into>`.
4. Conflict prediction: `git merge-tree --write-tree --name-only --no-messages <into> <laneHead>` (spec 08 §6.9); exit 1 → `conflicts-base` (not overridable here; §6.4).
5. Checks (G5, §6.9): required checks passed on the current snapshot, else `checks-failed`/`checks-stale` (overridable, audited).
6. Forge CI for push-to-PR / PR lanes (overridable).
7. Scope (G12) violations (overridable).

**Integrate** — let `T` = target branch, `L` = lane HEAD (after WIP commit/shaping), `W` = worktree where `T` is checked out (from `git worktree list` / spec 04 `RefInfo.worktreePath`), if any.

| Case | Method | Commands |
|---|---|---|
| `T` checked out in `W`, `W` clean | merge | `git -C W merge --no-ff -m <msg> -- <L>` (with `-S` only if `sign`) |
| | squash | `git -C W merge --squash -- <L>` then `git -C W commit -m <msg> [--author=<bot>] [-S]` |
| | ff | `git -C W merge --ff-only -- <L>` |
| | rebase-ff | in lane: `git -C <lane> rebase <T>` (conflict → §6.4), then `git -C W merge --ff-only -- <L'>` |
| `T` checked out in `W`, `W` dirty | any | guard `base-dirty`: offer "Stash, integrate, pop" (spec 05 stash ops, separate journal entries) or "Integrate without touching my files" only when none of the incoming paths are dirty in `W` — then use `git -C W merge` which git allows when changed paths don't overlap; else refuse |
| `T` not checked out anywhere | merge | `tree=$(git merge-tree --write-tree <T> <L>)` (exit 0 required) → `c=$(git commit-tree <tree> -p <T> -p <L> -m <msg> [-S])` → `git update-ref -m "githappens hive: accept" refs/heads/<T> <c> <Told>` |
| | squash | same tree → `git commit-tree <tree> -p <T> -m <msg>` → `update-ref` (CAS on `<Told>`) |
| | ff | `git merge-base --is-ancestor <T> <L>` → `git update-ref refs/heads/<T> <L> <Told>` |
| | rebase-ff | rebase in lane as above, then ff via `update-ref` |
| push-to-pr | — | `git -C <lane> push <remote> <L>:refs/heads/<headRef>` (fast-forward only; non-ff → offer restack onto the fetched head; `--force-with-lease=<headRef>:<expected>` only after explicit confirmation) via spec 09 push op with askpass |

All `update-ref` calls pass the expected old value (compare-and-swap) so a concurrent change fails with `accept-base-moved` instead of losing commits. Identity for Hive-created commits: the user's identity from git config as author and committer (decided 2026-10-12).

**Post-steps:** lane → `accepted` with `outcome`; optional `push` of `T` via spec 09 (separate op, not undoable — barrier); optional worktree removal (file 03 §6.7 without keep-alive snapshot of WIP since it is empty/committed) and branch delete (`git branch -d`, or `-D` for squash/rebase-ff where the lane tip isn't an ancestor, protected by the keep-alive ref `refs/githappens/hive/<laneId>/accepted/tip`); task → `done`, `acceptedLaneId` set; issue transition offer (spec 10) if the task came from an issue.

**Undo `hive-accept`:** drift check `T` tip == recorded `after` (else explain like spec 05). If `T` is checked out in a clean `W`: `git -C W reset --keep <Told>`; else `git update-ref refs/heads/<T> <Told> <Tnew>`. Recreate the lane worktree/branch from keep-alive refs if they were removed (file 03 §6.7 undo). Lane → `review`. Push barrier: if `T` was pushed, undo stops at the push barrier (spec 05 rule) and offers "Revert merge commit" instead.

### 6.4 Conflict handoff

When integration would conflict (guard 4) the user chooses:

1. **Ask the agent to resolve** (default when the lane's agent is available): feedback round with "Merge `<T>` into your branch and resolve conflicts in: a.ts, b.ts. Keep both behaviors where possible. Run the checks." — the agent runs `git merge <T>` itself (it is an ordinary command in its permission flow).
2. **Resolve myself in the lane:** `git -C <lane> merge --no-ff <T>` (queued op) → conflicts appear in the lane worktree; open the lane's worktree in a GitHappens tab and spec 08's merge tool; when resolved and committed, Accept is clean.
3. **Rebase lane onto `T`** (`hive.lane.restack`, mode rebase) → spec 08 conflict flow in the lane worktree.

Hive never leaves the user's main worktree in a conflicted state as a side effect of Accept.

### 6.5 Pull requests

- **Create PR from lane:** optional shaping; `git -C <lane> push -u <remote> <lane>:refs/heads/<remoteBranch>` (spec 09 push op; GitHappens credentials via askpass in main — the agent never sees them); then spec 10 `pr:create { head, base, title, body, draft }`. Body template: task brief summary, agent report, checks summary, "Generated with <agent> via GitHappens Hive" footer (configurable, can be disabled), `Fixes #<n>` when linked. Lane outcome `pr-open`; task stage `done` with `pr` set (reopens to `review` if the PR is closed unmerged, via Launchpad refresh).
- **Follow-up after review:** PR review comments → G1 import → feedback → agent commits → "Push to PR" (fast-forward).
- **Push policy:** Hive pushes only on explicit user action. Agents might push themselves using the user's own git credentials (they run as the user); Hive detects remote branch updates for lane branches during fetch and records an audit `agent-push-detected` notice (file 08 §6.10).

### 6.6 Checkpoints

- **Create:** compute the snapshot (§6.1); skip if its tree equals the previous checkpoint's tree; `git update-ref refs/githappens/hive/<laneId>/cp/<seq> <snap>`; record `HiveCheckpoint`. Triggers: `turn-complete` (debounced 2 s), feedback rounds, before accept/restore/rebase/handoff, stop/quit, manual.
- **Retention:** max `hive.checkpoints.maxPerLane` (default 50); prune oldest non-`before-*` first; all deleted 30 days after the lane closes (file 03 §6.8).
- **Restore (`hive.checkpoint.restore`)**, lane must have no live run (offer to stop/pause):
  1. Take a `before-restore` checkpoint.
  2. *Files only* (keep HEAD): `git -C <lane> read-tree --reset -u <cpTree>` then `git -C <lane> reset -q` (index back to HEAD, worktree = checkpoint content as uncommitted changes), then remove files that are untracked now and absent in the checkpoint: `git -C <lane> clean -fd -- <paths>` restricted to the computed list (never `-x`).
  3. *Files and branch position:* `git -C <lane> reset --hard <cp.headSha>` then step 2 (current HEAD stays reachable through the `before-restore` checkpoint).
  4. Journal `hive-restore` (undo = restore the `before-restore` checkpoint the same way).
- Hive checkpoints are invisible to the graph (reserved namespace, spec 00).

### 6.7 Commit shaping, trailers, identity and signing (G2)

- **Trailers** (default on, `hive.commits.trailers`): `Agent: <adapterId>`, `Agent-Model: <model>` (if known), `Agent-Session: <agentSessionId>`, `Task: <taskId>` (plus `Task-Ref: <issue key or URL>` when the task is linked to an issue/PR). Added with `git interpret-trailers --in-place`-equivalent logic in our message builder (`--if-exists replace`).
- **Keep (trailers-only):** rewrite `mergeBase..L` linearly: for each commit in order, `git commit-tree <tree> -p <newParent> -m <msg+trailers>` preserving author/date (`GIT_AUTHOR_*` from the original), committer = user; then `git update-ref refs/heads/<lane> <newTip> <oldTip>`; lane worktree HEAD follows (branch checked out there; run inside the lane's queue lane with `git -C <lane> reset --soft <newTip>` to keep the index consistent). Lanes containing merge commits: trailers-only is disabled; offer squash.
- **Squash:** `tree=$(git rev-parse L^{tree})`; `git commit-tree <tree> -p <mergeBase> -m <msg+trailers>` → update-ref + `reset --soft` in the lane.
- **Compose:** spec 12 `ai.compose` on `{ kind: 'range', from: mergeBase, to: L }` producing commits with trailers appended.
- **Reword:** spec 05 interactive-rebase reword on the lane.
- **Identity (decided 2026-10-12):** commits are authored and committed by the user; attribution to the agent is carried by the `Agent:`/`Task:` trailers. A separate bot author identity (with the user as committer or `Co-authored-by`) is **not offered in v1**; it is listed in §10 as a possible later option.
- **Signing policy:** commits created by Hive on the user's explicit action follow the user's normal signing settings (spec 06/13), shown in the dialog with a checkbox. Commits **made by agents** inside lanes are unsigned by default: Hive starts agent processes with `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` setting `commit.gpgsign=false` and `tag.gpgsign=false` (`hive.commits.agentSigning: 'disable'`, alternatives `'inherit'`), so a user's signing key/agent is not used silently by an agent (file 08 §6.4). Shaping with `sign: true` re-creates those commits signed by the user's explicit action.
- **Style lint:** if spec 12 `ai.commitStyle` is `conventional`, warn on non-conforming summaries in the shape/accept dialogs (no auto-rewrite).
- Journal `hive-shape`: undo = `update-ref` back to the old tip (kept alive by a keep-alive ref) + `reset --soft` in the lane.

### 6.8 Try in main checkout and reverse handoff (G6)

**To main (`direction: 'to-main'`)** — lane `L` (branch `B`), main worktree `M`:

1. Preconditions: no live run in the lane (offer pause = stop with resume later); `M` has no in-progress operation (spec 02 `RepoState` clean).
2. If `M` is dirty: `git -C M stash push --include-untracked -m "githappens hive: before trying <B>"` → record stash sha.
3. Lane WIP: if the lane has uncommitted changes, `git -C L stash push --include-untracked -m "githappens hive: lane WIP <laneId>"` (stashes are shared through `refs/stash` in the common dir, so `M` can apply it).
4. Free the branch: `git -C L switch --detach` (git forbids the same branch in two worktrees).
5. `git -C M switch <B>`; if step 3 created a stash: `git -C M stash pop --index <lane stash>` (by sha match in `git stash list`).
6. Record `lane.handoff = { state: 'in-main', mainPrevHead, stashSha }`; journal `hive-handoff`. Lane card: "In main checkout"; starting sessions in the lane is blocked; the run command (file 03 §6.4.3) can be run in `M` instead.

**Back (`direction: 'back'`):**

1. If `M` has changes (the user's experiments on `B`): ask "Keep these changes on the lane" (stash, then pop in the lane after step 3) or "Commit them on the lane" (commit in `M` on `B`) or "Discard".
2. `git -C M switch <mainPrevHead>` (or `--detach <sha>`), then pop the original main stash (sha from step 2 above); conflicts → spec 08 stash conflict flow (stash kept).
3. `git -C L switch <B>`; pop the carried stash if any.
4. Clear `lane.handoff`; journal entry.

**Undo** of a handoff entry runs the opposite direction. If the user commits on `B` in `M` meanwhile, those commits simply belong to the lane.

**Reverse handoff (`hive:lane:fromWip`, "Move my changes to a new lane"):** in the current worktree: `git stash push --include-untracked -m "githappens hive: move to lane"` → create lane from the current HEAD (base = current branch) → `git -C <lane> stash pop`; journal `hive-from-wip` (undo: stash in the lane, remove the lane, pop in the original worktree). Then optionally start an agent with "Continue this work: …".

### 6.9 Checks and landing guards (G5)

- Local checks: `CheckDef`s from repo config (file 03 §6.4.3a) run in the lane worktree; results keyed to the snapshot sha; a newer snapshot marks them `stale`.
- Forge CI: for lanes with a PR (created or push-to-PR), spec 10 `pr:checks` rollup polled by spec 11's Launchpad refresh cadence and on focus; displayed next to local checks.
- **Guard behavior (decided 2026-10-12)** (`hive.landing.requireChecks`: `required-only` default, `all`, `off`): failing or stale required lane checks **block Accept**; the only way past is the explicit "Accept anyway" override, which must be ticked per accept (never remembered) and is audited as `accept-override`; overrides are recorded in the audit log with the check ids and the snapshot sha (file 08 §6.8).
- **Send failure to agent:** one click creates a feedback round with the failing check's log excerpt (§6.2).
- **End-of-run report** (template `report: true`): requested via the adapter's `report` capability (Claude `--json-schema`, Codex `--output-schema`, MCP `hive_request_review`, or last message); schema `{ summary: string; filesTouched: string[]; testsRun: string[]; knownGaps: string[] }`; shown in the Report panel and in compare.

### 6.10 Provenance capture (G4 data only)

ProvenanceRecords (file 01 §6.5a) are captured from H2. On shaping, a mapping `oldSha → newSha` is appended to `provenance/<laneId>.jsonl` so later blame can follow rewritten commits. On accept, a summary line (`laneId`, landed commit range, agent, model, session) is appended. No UI and no git-notes export yet.

## 7. Step-by-step implementation plan

1. Snapshot builder + cache; `hive:review:summary` (files, commits, mergeBase). Test: untracked and ignored handling, deterministic snapshot sha for identical states.
2. Changes tab with spec 07 diff components, view modes, viewed flags. Test: component tests.
3. Review comments (create, anchor, re-anchor, outdated). Test: re-anchoring after scripted edits.
4. Feedback rounds: prompt builder, delivery queue, checkpoint per round, "since last review". Test with the fake agent receiving the prompt verbatim.
5. PR thread import / reply & resolve; CI excerpt import. Test with `msw` fixtures.
6. Checks runner + guards + overrides + audit. Test: stale detection after a new edit.
7. Accept: all cases of the integrate table, CAS update-ref, post-steps, undo. Test on fixture repos: target checked out clean/dirty/not checked out; conflicts predicted; concurrent ref move.
8. Conflict handoff choices. Test: lane merge conflict opens spec 08 tool in the lane worktree.
9. Create PR / push-to-PR with spec 09/10. Test against local bare remote + `msw` provider.
10. Shaping (trailers-only, squash, compose, reword), user identity, signing env for agents. Test: `GIT_CONFIG_*` disables signing in agent processes; trailers parse with `git interpret-trailers --parse`.
11. Compare view + take-file-from-lane. Test with 3 fake lanes.
12. Handoff to main / back / from WIP with stashes and undo. Test: dirty main, dirty lane, conflicts on pop.
13. Checkpoints create/prune/restore/undo. Test: restore files-only vs branch, untracked removal limited to computed paths.
14. Provenance capture hooks. Test: records appended for hook edit events and checkpoint diffs.

## 8. Edge cases

- **Lane base is a remote-tracking branch** (`origin/main`) and the local `main` is behind: Accept targets local `main`; if local `main` lacks commits that the lane's base has, guard `behind-base` suggests fast-forwarding `main` first (spec 09 `fastForwardBranch`).
- **Agent rewrote history** (force-reset its branch): review uses the current branch; checkpoints still hold old states.
- **Agent committed with `--no-verify` or bypassed hooks:** Accept runs integration with hooks as normal (the user's merge/commit hooks apply); hook failures surface per spec 06 §4.6.
- **LFS files in the lane:** diffs show pointers per spec 07; checks run normally; push-to-PR includes LFS push via spec 09.
- **Submodule pointer changes:** shown as submodule diffs (spec 07); accept treats them normally.
- **Binary files:** compare matrix shows size changes; "take file from lane" works for binaries too.
- **Huge lanes** (> 5 000 files changed): review shows a warning and file tree only, diff on demand; compare matrix capped at 2 000 rows.
- **Merge commits in lane** (agent merged base in): keep/merge/squash allowed; trailers-only rewrite disabled; rebase-ff uses `--rebase-merges` only if spec 05's flag is on.
- **Target branch protected on the forge:** local accept still possible; push of `T` fails per spec 09 with the provider message; suggest Create PR.
- **Handoff while the main tab has an open merge tool:** blocked (`RepoState` not clean).
- **Undo after the user pushed `T`:** stops at the push barrier (spec 05).

## 9. Acceptance criteria

- [ ] Review shows committed, uncommitted and untracked changes vs merge-base, including files created by the agent, without touching the lane's index.
- [ ] Comments on 3 files sent as one round reach the agent verbatim; after the agent's turn, "Since last review" shows only the agent's response changes and moved comments stay anchored.
- [ ] Failing required checks block Accept until overridden; the override appears in the audit log.
- [ ] Accept works for target checked out (clean), checked out (dirty, non-overlapping), and not checked out; a concurrent ref move fails safely; Undo restores the target and the lane.
- [ ] Predicted conflicts never leave the main worktree conflicted; "Ask the agent to resolve" produces a clean accept on the fixture.
- [ ] Agent-made commits are unsigned by default even with `commit.gpgsign=true`; shaped/accepted commits created by the user follow the user's signing setup; trailers are present and parseable.
- [ ] "Try in main checkout" and "Move back" round-trip main WIP and lane WIP exactly, and both directions are undoable.
- [ ] Restoring a checkpoint and undoing the restore returns the lane to the exact prior state (byte-identical tracked and untracked files).
- [ ] Compare shows files/checks/scope/conflicts/cost for 3 lanes; "Use this file from lane B" works and is undoable.

## 10. Out of scope / later

- Agent blame UI and git-notes export compatible with git-ai / Agent Trace (G4, H5; data is captured from H2).
- Stacked lanes and stacked PRs (G10).
- Pre-landing AI review pass that auto-generates comments (G14) — manual `review-pr` template exists.
- Best-of-N ranking assist (G18); automatic winner selection is a non-goal.
- Semantic (LLM) conflict checks (G19).
- Native forge merge queues.
- A bot author identity for agent work (not offered in v1; commits are authored by the user with `Agent:`/`Task:` trailers).

## 11. Cross-spec dependencies

- **Spec 05:** journal kinds `hive-accept`, `hive-discard`, `hive-restore`, `hive-shape`, `hive-handoff`, `hive-from-wip`; push barrier; stash ops; interactive-rebase reword; keep-alive refs; `reset --keep` undo pattern.
- **Spec 06:** commit composer embedded for "Commit WIP"; signing settings; hook output.
- **Spec 07:** Monaco diff components, binary/LFS/submodule diffs.
- **Spec 08:** merge-tree prediction (§6.9), merge tool in lane worktrees, stash-pop conflicts.
- **Spec 09:** push (askpass in main), fast-forward non-HEAD branch, worktree remove.
- **Spec 10:** `pr:create`, `pr:timeline`, `pr:comment`, `pr:resolveThread`, `pr:checks`, `ci:list`, issue transitions.
- **Spec 12:** commit message AI, Commit Composer (`ai.compose`), `prDraft`, `commitStyle`.
