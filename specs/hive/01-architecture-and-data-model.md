# Hive 01 — Architecture & Data Model

> Owns: `HiveService` and its sub-services, the Hive entity model and state machines, persistence layout, the `hive:*` IPC contract and event bus, the `hive.*` `GitOperation` variants. Other Hive files add detail but reuse the types defined here.

## 1. Purpose

Hive needs one authoritative, main-process model of "what agents are doing where" that survives renderer reloads and app restarts, feeds several views (board, left panel, graph badges, attention inbox, status bar), and routes every git side effect through the existing engine. This file defines that model so that adapters (02), lanes (03), UI (04), intake (05), review (06) and coordination (07) can be built in parallel against stable contracts.

## 2. Reference behavior

- The reference desktop app keys its view by **worktree**: every worktree of the repo is a card, and agent sessions hang off worktrees. Sessions are discovered (process detection, hooks) as well as launched. Cards show branch, uncommitted changes, ahead/behind, linked PRs and agent status. The toggle shows the highest-priority status across a repo's sessions.
- The vendor's separate agent environment keys its model by **task**: a task bundles a prompt, linked issue/PR, one worktree per repo, several sessions and shared instructions, and moves through board stages (exploration → development → review → done).
- Session states seen across the reference products and comparable tools: starting, working/running, waiting for input, waiting for permission, idle, completed/done, error, ended; plus "unread" (finished but not yet looked at) and "reconnecting".

Hive combines both: **Task → Lane (worktree) → Session → Run**, with lanes also creatable without a task ("ad-hoc lane" for any existing worktree), so the worktree-centric view of §4.12 keeps working.

## 3. User stories

1. As a user I want Hive's state (tasks, lanes, sessions, pending approvals) to survive an app restart so that I can quit without losing track of five agents.
2. As a user I want an agent I started by hand in a GitHappens terminal to appear in Hive automatically.
3. As a user I want every git change Hive makes (create lane, accept, discard) to be visible in the operation log and undoable like other operations.
4. As a developer of GitHappens I want one typed contract for all Hive IPC so that preload and handlers can't drift.
5. As a user with several repos open I want one attention queue across all of them.

## 4. UI specification

This file has no UI of its own. Views are in file 04. The renderer store contract that views consume is defined in §5.6.

## 5. Data model & IPC

All types live in `apps/desktop/src/shared/hive/types.ts` unless noted. IDs are ULIDs (sortable, 26 chars) generated in main.

### 5.1 Core entities

```ts
import type { RepoId, Sha } from '../git-types';            // spec 02 §5.1
import type { IssueRef } from '../integrations';              // spec 10 §5.2
import type { RepoRef } from '../integrations';

export type HiveId = string;                 // ULID
export type AdapterId =
  | 'claude-code' | 'codex' | 'gemini' | 'copilot' | 'cursor' | 'opencode' | 'aider'
  | `custom:${string}`;                      // user-defined adapters (file 02 §5.3)

/** Repo identity Hive keys everything by: the shared commonDir, not a worktree root. */
export interface HiveRepoKey {
  commonDir: string;                          // realpath of spec 02 RepoInfo.commonDir
  mainWorktree: string | null;                // null for bare repos
  repoKeyHash: string;                        // sha1(commonDir) — used in paths
}

// ---------------------------------------------------------------- Task
export type TaskSource =
  | { kind: 'prompt' }
  | { kind: 'issue'; issue: IssueRef; title: string }
  | { kind: 'pr'; pr: { repo: RepoRef; number: number; webUrl: string }; mode: 'review' | 'address-feedback' | 'continue' }
  | { kind: 'pr-thread'; pr: { repo: RepoRef; number: number }; threadId: string; path?: string; line?: number }
  | { kind: 'launchpad'; itemUid: string }
  | { kind: 'branch'; ref: string }             // "continue work on this branch"
  | { kind: 'commit'; sha: Sha }               // "fix/explain this commit"
  | { kind: 'ci-failure'; laneId?: HiveId; pr?: { repo: RepoRef; number: number }; checkRunIds: string[] }   // G1/G5 "fix CI"
  | { kind: 'remote-lane'; remoteLaneId: HiveId }   // "continue locally" from a cloud agent PR (G11, file 10)
  | { kind: 'adopted' };                        // implicit task for an ad-hoc lane (§6.6)

export type TaskStage = 'draft' | 'queued' | 'active' | 'review' | 'done' | 'archived';

export interface HiveTask {
  id: HiveId;
  repo: HiveRepoKey;
  title: string;                              // ≤ 120 chars
  brief: string;                              // markdown prompt / instructions (≤ 64 KiB)
  source: TaskSource;
  templateId?: string;                        // file 05 §5.2
  base: { ref: string; sha: Sha };            // resolved at creation; ref may be a branch or 'HEAD'
  stage: TaskStage;                           // derived + user override (§6.2)
  stageOverride?: TaskStage;                  // user dragged the card
  laneIds: HiveId[];                          // ≥ 1 once started; fan-out => several
  dependsOn: HiveId[];                        // file 07 §5
  dependencyModes?: Record<HiveId, 'wait' | 'stack'>;   // default 'wait' (file 07 §6.3)
  labels: string[];
  scope?: string[];                           // declared path globs the task should touch (G12, file 07 §6.6)
  planGate?: { enabled: boolean; state: 'pending' | 'awaiting-approval' | 'approved' | 'rejected'; planText?: string; approvedAt?: number };  // G8, file 05 §6.5
  budget?: { maxCostUsd?: number; maxTokens?: number; maxWallMinutes?: number };   // G9, alerts only (file 08 §6.7)
  usage?: UsageTotals;                        // rolled up from lanes (G9)
  createdAt: number; updatedAt: number;
  acceptedLaneId?: HiveId;                    // the lane that landed (fan-out)
  pr?: { repo: RepoRef; number: number; webUrl: string };   // PR opened from the accepted lane
}

// ---------------------------------------------------------------- Lane
export type LaneState =
  | 'provisioning'     // worktree/branch being created, setup steps running
  | 'ready'            // worktree exists, no live run
  | 'running'          // ≥ 1 live run
  | 'stopped'          // runs ended; work present; not yet reviewed
  | 'review'           // user opened review or agent signalled done with changes
  | 'accepting'        // accept op queued/running
  | 'accepted'         // landed (merged/squashed/rebased) or PR opened ('pr-open')
  | 'discarding'
  | 'discarded'
  | 'error';           // provisioning or accept failed; see lane.error

export interface HiveLane {
  id: HiveId;
  taskId: HiveId;
  repo: HiveRepoKey;
  worktreePath: string;                       // absolute, realpath
  branch: string;                             // short name, e.g. 'hive/fix-login-3fa2'
  base: { ref: string; sha: Sha };            // copy of task.base at lane creation (may differ after restack)
  adapterId: AdapterId;                       // default agent for this lane
  model?: string; effort?: string;            // adapter-specific, passed through
  ownership: 'hive' | 'adopted' | 'remote';   // adopted = existing worktree, never deleted; remote = cloud-agent PR lane (G11), no worktree until "continue locally"
  remote?: RemoteLaneInfo;                    // when ownership = 'remote' (file 10 §5.1)
  handoff?: { state: 'in-main'; mainWorktree: string; mainPrevHead: { kind: 'branch'; name: string } | { kind: 'detached'; sha: Sha }; stashSha?: Sha; journalId: string };  // G6, file 06 §6.8
  state: LaneState;
  ports?: { base: number; count: number };    // file 03 §6.5
  setup: { status: 'pending' | 'running' | 'ok' | 'failed' | 'skipped'; logPath?: string; failedStep?: number };
  sessionIds: HiveId[];
  checkpointCount: number;
  wip: LaneWipSummary | null;                 // refreshed by LaneManager (§6.5)
  checks?: LaneChecksSummary;                 // G5, file 06 §6.9
  review?: { openComments: number; sentRounds: number };   // G1, file 06 §6.2
  scopeViolations?: string[];                 // paths changed outside task.scope (G12)
  diskBytes?: number;                         // lazily measured (G7, file 03 §6.8)
  usage?: UsageTotals;                        // G9
  outcome?: LaneOutcome;
  error?: HiveError;
  createdAt: number; updatedAt: number;
  lastActivityAt: number;                     // last signal from any run
  seenAt?: number;                            // user last opened this lane (for "unread")
}

export interface LaneWipSummary {
  headSha: Sha;
  aheadOfBase: number; behindBase: number;    // git rev-list --left-right --count base...HEAD
  changedFiles: number;                       // committed vs base + uncommitted, de-duplicated paths
  uncommittedFiles: number;
  additions: number; deletions: number;       // numstat base...worktree (approximate for untracked: counted as added lines)
  conflictsWith: HiveId[];                    // lanes with predicted conflicts (file 07)
  computedAt: number;
}

export type LaneOutcome =
  | { kind: 'merged'; into: string; mergeSha: Sha; method: 'merge' | 'squash' | 'rebase-ff' | 'ff' }
  | { kind: 'pr-open'; pr: { repo: RepoRef; number: number; webUrl: string } }
  | { kind: 'discarded'; keepAliveRef: string; tipSha: Sha | null };

export interface LaneChecksSummary {
  local: { state: 'none' | 'running' | 'passed' | 'failed' | 'stale'; ranAt?: number; headSha?: Sha; results: Array<{ id: string; name: string; state: 'passed' | 'failed' | 'skipped' | 'error' | 'running'; durationMs?: number }> };
  forge?: { rollup: 'success' | 'pending' | 'failure' | 'none'; prNumber?: number; updatedAt: string };   // spec 10 PrRollupStatus
}

// ---------------------------------------------------------------- Usage / cost (G9)
export interface UsageTotals {
  wallMs: number;                             // sum of run durations
  activeMs: number;                           // time in 'working' status
  inputTokens?: number; outputTokens?: number; cacheReadTokens?: number;
  costUsd?: number;                           // reported by the agent, else estimated from hive.pricing (file 08 §6.7)
  costSource?: 'agent' | 'estimate' | 'mixed';
  turns: number;
}

// ---------------------------------------------------------------- Review comments (G1)
export interface ReviewComment {
  id: HiveId;
  laneId: HiveId;
  path: string;
  side: 'new' | 'old';
  line: number; endLine?: number;
  anchor: { blobSha: Sha | null; hunkHeader: string; lineText: string };   // to re-anchor after the agent edits (file 06 §6.2)
  body: string;                               // markdown
  origin: 'local' | 'pr-thread' | 'ci';       // PR threads and CI annotations are imported (file 05 §6.3)
  externalId?: string;                        // PR thread id / check run id
  state: 'draft' | 'sent' | 'resolved' | 'outdated';
  sentInRound?: number;
  createdAt: number;
}

// ---------------------------------------------------------------- Provenance (G4 data; UI later)
export interface ProvenanceRecord {
  laneId: HiveId; sessionId: HiveId; runId: HiveId;
  adapterId: AdapterId; model?: string;
  at: number;
  path: string;
  kind: 'edit' | 'write' | 'patch' | 'checkpoint-diff';   // tool-level when hooks/ACP report it, else lane diff at checkpoint
  newBlobSha?: Sha;                           // blob after the edit, when known
  ranges?: Array<[number, number]>;           // new-side line ranges, when known
}

// ---------------------------------------------------------------- Session / Run
export type SessionStatus =
  | 'starting'          // process spawned, no signal yet
  | 'working'           // agent is executing a turn (tool calls / output)
  | 'needs-permission'  // blocked on a tool approval
  | 'needs-input'       // asked a question / idle prompt after an unfinished turn
  | 'idle'              // turn complete, waiting for the next prompt
  | 'done'              // headless run finished successfully / user marked done
  | 'error'             // turn failed (API error, crash, non-zero exit)
  | 'exited'            // process ended (pty) — terminal state of a run
  | 'unknown';          // heuristic source only, insufficient data

export interface HiveSession {
  id: HiveId;
  laneId: HiveId;
  adapterId: AdapterId;
  agentSessionId?: string;                    // the agent's own id (Claude session UUID, Codex thread id…)
  runner: 'pty' | 'headless' | 'acp';
  title: string;                              // "claude — fix-login" (editable)
  status: SessionStatus;
  statusSource: 'hook' | 'stream' | 'acp' | 'osc' | 'heuristic' | 'process';
  statusSince: number;
  permissionMode?: string;                    // as launched (audited)
  runIds: HiveId[];
  activeRunId?: HiveId;
  external?: { pid: number; detectedBy: 'process' | 'hook' };   // not launched by Hive (read-mostly)
  usage?: UsageTotals;                        // G9; tokens/cost only if the agent reports them, time always
  createdAt: number; updatedAt: number;
}

export interface HiveRun {
  id: HiveId;
  sessionId: HiveId;
  pid?: number;
  ptyId?: string;                             // spec 12 terminal id when runner = 'pty'
  argvRedacted: string[];                     // secrets masked (file 08 §6.4)
  cwd: string;
  startedAt: number;
  endedAt?: number;
  exit?: { code: number | null; signal?: string };
  endReason?: 'exit' | 'stopped-by-user' | 'killed-limit' | 'app-quit' | 'crash' | 'lost';
  usage?: UsageTotals;                        // G9
  eventLogPath: string;                       // JSONL of HiveSignal + activity (§5.3)
  ptyLogPath?: string;                        // capped raw pty capture (file 08 §6.6)
}

// ---------------------------------------------------------------- Checkpoint
export interface HiveCheckpoint {
  id: HiveId;
  laneId: HiveId;
  seq: number;                                // 1..N per lane
  ref: string;                                // refs/githappens/hive/<laneId>/cp/<seq>
  commitSha: Sha;                             // snapshot commit (file 06 §6.6)
  headSha: Sha;                               // lane HEAD at snapshot time
  trigger: 'turn-complete' | 'before-accept' | 'before-restore' | 'before-rebase' | 'before-handoff' | 'before-feedback' | 'manual';
  label: string;                              // first line of the user prompt that started the turn, or user text
  stats: { files: number; additions: number; deletions: number };
  createdAt: number;
}

// ---------------------------------------------------------------- Attention
export type AttentionKind =
  | 'permission'        // tool approval pending (answerable)
  | 'plan-review'       // plan gate: approve / edit / reject the agent's plan (G8)
  | 'question'          // agent asked something / elicitation (answer in terminal or inline text)
  | 'error'             // run failed, setup failed, accept failed
  | 'review'            // lane ready for review (turn complete with changes, or headless done)
  | 'conflict'          // predicted conflict with base or another lane (file 07)
  | 'scope'             // lane edited outside its declared scope, or scopes overlap (G12)
  | 'checks'            // lane checks or forge CI failed (G5)
  | 'budget'            // budget threshold crossed (G9)
  | 'remote'            // remote lane needs attention: PR ready, CI failed, agent asked (G11)
  | 'limit';            // resource limit reached (file 08 §6.7)

export interface AttentionItem {
  id: HiveId;
  kind: AttentionKind;
  repo: HiveRepoKey;
  taskId?: HiveId; laneId?: HiveId; sessionId?: HiveId;
  priority: 0 | 1 | 2 | 3;                    // 0: permission, question, plan-review; 1: error, checks, budget; 2: conflict, scope, limit, remote; 3: review
  title: string;                              // "Claude wants to run: npm test"
  detail?: string;                            // markdown; command preview, file list…
  permission?: PermissionRequestView;         // when kind = 'permission'
  createdAt: number;
  expiresAt?: number;                         // hook timeout; after this the agent falls back to its own prompt
  state: 'open' | 'answered' | 'expired' | 'dismissed' | 'superseded';
  answeredBy?: 'user' | 'rule' | 'terminal';  // 'rule' only for session-scoped exact-match rules (file 08 §6.3)
}

export interface PermissionRequestView {
  requestId: string;                          // bridge correlation id
  tool: string;                               // 'Bash', 'Edit', 'shell', 'write_file', 'mcp__x__y'…
  summary: string;                            // one line
  command?: string;                           // full command text for shell tools (shown monospace, never truncated silently)
  paths?: string[];                           // files affected, relative to lane worktree when inside it
  outsideWorktree: boolean;                   // any path / cwd outside the lane worktree
  risk: 'low' | 'medium' | 'high';            // Hive's own classification (file 08 §6.3), advisory
  riskReasons: string[];
  options: PermissionOption[];                // what this adapter can express
}
export type PermissionOption =
  | { id: 'allow-once' } | { id: 'deny'; withMessage: boolean }
  | { id: 'allow-session-exact' }             // our extension; disabled when risk = 'high'
  | { id: 'answer-in-terminal' };             // return "no decision" → agent shows its own prompt

export interface HiveError { code: HiveErrorCode; message: string; detail?: string; gitError?: unknown /* spec 02 SerializedGitError */ }
export type HiveErrorCode =
  | 'adapter-not-found' | 'adapter-version-unsupported' | 'spawn-failed' | 'auth-required'
  | 'worktree-failed' | 'branch-exists' | 'path-exists' | 'setup-failed' | 'untrusted-repo-config'
  | 'limit-concurrency' | 'limit-runtime' | 'limit-disk' | 'limit-memory'
  | 'accept-conflict' | 'accept-dirty-base' | 'accept-base-moved' | 'accept-checks-failed' | 'discard-dirty' | 'push-failed' | 'pr-failed'
  | 'handoff-dirty-main' | 'handoff-branch-in-use' | 'limit-budget'
  | 'hook-bridge-unavailable' | 'acp-protocol' | 'cancelled' | 'internal';
```

### 5.2 Signals (normalized status events)

```ts
export type HiveSignal =
  | { t: 'run-started'; at: number; pid?: number }
  | { t: 'session-id'; at: number; agentSessionId: string }
  | { t: 'turn-started'; at: number; prompt?: string /* first 500 chars */ }
  | { t: 'working'; at: number; tool?: string; detail?: string }
  | { t: 'tool'; at: number; phase: 'pre' | 'post' | 'failed'; tool: string; summary: string; paths?: string[] }
  | { t: 'permission-request'; at: number; req: PermissionRequestView; timeoutMs: number }
  | { t: 'permission-resolved'; at: number; requestId: string; decision: 'allow' | 'deny' | 'deferred' | 'expired'; by: 'user' | 'rule' | 'terminal' | 'agent' }
  | { t: 'needs-input'; at: number; message?: string }
  | { t: 'turn-complete'; at: number; summary?: string /* last assistant message, ≤ 2 KiB */ }
  | { t: 'error'; at: number; message: string; recoverable: boolean }
  | { t: 'usage'; at: number; inputTokens?: number; outputTokens?: number; costUsd?: number }
  | { t: 'file-changed'; at: number; path: string }                 // from hooks; advisory
  | { t: 'subagent'; at: number; phase: 'start' | 'stop'; name?: string }
  | { t: 'plan'; at: number; text: string; entries?: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed' }>; final: boolean }   // G8 (ACP plan, Claude plan mode, Codex plan items)
  | { t: 'report'; at: number; summary: string; testsRun?: string[]; knownGaps?: string[] }   // optional end-of-run lane report (G5)
  | { t: 'notice'; at: number; level: 'info' | 'warn'; message: string }
  | { t: 'heartbeat'; at: number; outputBytes: number; lastLine?: string }   // heuristic source
  | { t: 'run-exited'; at: number; code: number | null; signal?: string };

export interface SignalEnvelope { sessionId: HiveId; runId: HiveId; source: HiveSession['statusSource']; signal: HiveSignal }
```

### 5.3 Persistence layout

Hive state is per profile, in `app.getPath('userData')/profiles/<profileId>/hive/` (spec 13 §5.1 layout):

```
hive/
  index.json                         # { version: 1, repos: { [repoKeyHash]: { commonDir, lastOpenedAt } } }
  repos/<repoKeyHash>/
    state.json                       # { version: 1, tasks: HiveTask[], lanes: HiveLane[], sessions: HiveSession[],
                                     #   runs: HiveRun[] (last 20 per session), checkpoints: HiveCheckpoint[] }
    state.json.bak                   # previous good copy (rotated before each write)
    sessions/<sessionId>/
      events.jsonl                   # SignalEnvelope + activity lines, append-only, max 20 MiB then rotate (.1)
      pty.log                        # raw pty capture, ring-buffered to hive.retention.ptyLogMaxMiB (default 8)
      setup.log                      # lane setup step output (on the lane's first session dir)
    attachments/<taskId>/            # files the user attached to a brief (copied, ≤ 10 MiB each)
    reviews/<laneId>.json            # ReviewComment[] (G1)
    checks/<laneId>/<checkId>.log    # lane check output, last 3 runs per check (G5)
    provenance/<laneId>.jsonl        # ProvenanceRecord lines (G4 data, captured from H2; notes export later)
    usage.jsonl                      # one UsageTotals line per finished run (G9), kept 12 months
  attention.json                     # open AttentionItems (cross-repo), { version: 1, items: [] }
  audit.jsonl                        # append-only audit log (file 08 §6.8), rotated monthly, kept 12 months
  templates.json                     # user task templates (file 05 §5.2)
  ui.json                            # pinned Hive tab UI state: scope, grouping, view, inbox rail (file 04 §5)
  adapters.json                      # detection cache + custom adapter definitions (file 02 §5.3)
  trust.json                         # repo-config trust decisions (file 08 §6.5)
```

Rules:

- **Atomic writes:** write `state.json.tmp`, `fsync`, rename; previous file → `.bak`. Writes are debounced 250 ms and coalesced; on app quit flush synchronously.
- **Schema version** in every JSON file. Migrations live in `src/main/hive/store/migrations.ts`, run on load, never downgrade. Unknown future version → open read-only and show "Hive data was written by a newer GitHappens" banner.
- **Why userData, not `.git`:** the repo may be on a network share, shared between machines, or deleted; Hive state is personal. The only things Hive writes into the repository's git dir are refs under `refs/githappens/hive/*` (checkpoints, keep-alive), the per-worktree marker file `<gitdir-of-worktree>/githappens-hive.json` (§6.4) and spec 05 journal entries.
- **Corruption:** if `state.json` fails to parse, fall back to `.bak`; if both fail, rebuild a minimal state from `git worktree list` + marker files (§6.4) and log an `internal` audit entry.

### 5.4 IPC contract (`apps/desktop/src/shared/ipc/hive-contract.ts`)

Same envelope as spec 02 §5.3 (`IpcResult<T>`, exhaustive channel arrays checked at compile time, handler registration asserted by test per spec 15 §7.4).

```ts
export interface HiveStateSnapshot {
  repo: HiveRepoKey;
  tasks: HiveTask[]; lanes: HiveLane[]; sessions: HiveSession[]; checkpoints: HiveCheckpoint[];
  attention: AttentionItem[];                 // open items for this repo
  adapters: AdapterSummary[];                 // file 02 §5.2
  limits: { maxConcurrentRuns: number; activeRuns: number; queued: number };
  rev: number;                                // monotonically increasing per repo; deltas carry it
}

export interface HiveIpcContract {
  // ---- state
  'hive:state:get':        { req: { repoId: RepoId };                                   res: HiveStateSnapshot };
  'hive:state:list':       { req: { scope: 'all' | { repoKeyHashes: string[] } };       res: { repos: HiveStateSnapshot[]; limits: HiveStateSnapshot['limits'] } };  // pinned Hive tab (cross-repo board)
  'hive:repos:list':       { req: {};                                                   res: Array<{ repo: HiveRepoKey; displayName: string; openTab: boolean; liveRuns: number; openAttention: number; missing: boolean }> };  // board scope picker
  'hive:attention:list':   { req: { scope: 'all' | { repoId: RepoId } };                res: AttentionItem[] };
  // ---- tasks (file 05)
  'hive:task:create':      { req: TaskCreateReq;                                         res: { task: HiveTask; lanes: HiveLane[] } };
  'hive:task:update':      { req: { taskId: HiveId; patch: Partial<Pick<HiveTask, 'title' | 'brief' | 'labels' | 'stageOverride' | 'dependsOn'>> }; res: HiveTask };
  'hive:task:start':       { req: { taskId: HiveId };                                    res: { queued: boolean } };  // provisions lanes + launches (respects limits & deps)
  'hive:task:archive':     { req: { taskId: HiveId; discardOpenLanes: boolean };         res: void };
  'hive:task:addLane':     { req: { taskId: HiveId; lane: LaneSpec };                    res: HiveLane };              // fan-out after the fact
  // ---- lanes (file 03)
  'hive:lane:adopt':       { req: { repoId: RepoId; worktreePath: string };              res: HiveLane };              // existing worktree → ad-hoc lane
  'hive:lane:retrySetup':  { req: { laneId: HiveId };                                    res: void };
  'hive:lane:wip':         { req: { laneId: HiveId; force?: boolean };                   res: LaneWipSummary };
  'hive:lane:openWorktree':{ req: { laneId: HiveId; where: 'current-tab' | 'new-tab' | 'editor' | 'file-manager' | 'external-terminal' }; res: void };
  // ---- sessions & runs (file 02)
  'hive:session:start':    { req: SessionStartReq;                                       res: { session: HiveSession; run: HiveRun } };
  'hive:session:send':     { req: { sessionId: HiveId; text: string; submit: boolean };  res: void };                  // types into pty / sends ACP prompt / stdin
  'hive:session:interrupt':{ req: { sessionId: HiveId };                                 res: void };                  // Esc / Ctrl+C / session/cancel per adapter
  'hive:session:stop':     { req: { sessionId: HiveId; force: boolean };                 res: void };
  'hive:session:resume':   { req: { sessionId: HiveId };                                 res: { run: HiveRun } };     // new run, same agent session (if adapter supports resume)
  'hive:session:rename':   { req: { sessionId: HiveId; title: string };                  res: void };
  'hive:session:events':   { req: { sessionId: HiveId; before?: number; limit: number }; res: { events: SignalEnvelope[]; more: boolean } };
  'hive:session:attach':   { req: { sessionId: HiveId; cols: number; rows: number };    res: { ptyId: string; replay: string } };  // delegates to spec 12 terminal:attach
  // ---- attention (file 04 §4.6, file 08 §6.3)
  'hive:attention:respond':{ req: { itemId: HiveId; option: PermissionOption['id']; message?: string; answerText?: string }; res: { delivered: boolean } };
  'hive:attention:dismiss':{ req: { itemId: HiveId };                                    res: void };
  // ---- review & landing (file 06) — mutating ones become GitOperations (§5.5)
  'hive:review:summary':   { req: { laneId: HiveId };                                    res: LaneReviewSummary };
  'hive:review:compare':   { req: { laneIds: HiveId[] };                                 res: LaneCompareResult };
  'hive:lane:commitWip':   { req: { laneId: HiveId; message: string; paths?: string[] }; res: { sha: Sha } };
  'hive:review:comments':  { req: { laneId: HiveId };                                    res: ReviewComment[] };
  'hive:review:comment:upsert': { req: Omit<ReviewComment, 'id' | 'createdAt' | 'state'> & { id?: HiveId }; res: ReviewComment };
  'hive:review:comment:delete': { req: { id: HiveId };                                   res: void };
  'hive:review:importPrThreads': { req: { laneId: HiveId };                              res: ReviewComment[] };  // G1, unresolved PR threads → comments
  'hive:review:sendFeedback': { req: FeedbackReq;                                        res: { sessionId: HiveId; round: number } };  // G1, file 06 §6.2
  'hive:checks:run':       { req: { laneId: HiveId; ids?: string[] };                    res: { runId: HiveId } };   // G5
  'hive:checks:get':       { req: { laneId: HiveId };                                    res: LaneChecksSummary & { logs: Record<string, string /* log path */> } };
  'hive:lane:shape':       { req: ShapeReq;                                              res: { opId: string } };    // G2 commit shaping, file 06 §6.7
  'hive:lane:handoff':     { req: { laneId: HiveId; direction: 'to-main' | 'back' };     res: { opId: string } };    // G6, file 06 §6.8
  'hive:lane:fromWip':     { req: { repoId: RepoId; title: string; adapterId?: AdapterId; prompt?: string };  res: { task: HiveTask; lane: HiveLane } };  // G6 reverse: current WIP → new lane
  'hive:plan:respond':     { req: { taskId: HiveId; laneId: HiveId; decision: 'approve' | 'reject' | 'revise'; editedPlan?: string; message?: string }; res: void };  // G8
  'hive:usage:get':        { req: { scope: { taskId: HiveId } | { laneId: HiveId } | { repoId: RepoId; sinceMs?: number } }; res: UsageTotals & { byAdapter: Record<string, UsageTotals> } };  // G9
  'hive:remote:list':      { req: { repoId: RepoId; refresh?: boolean };                 res: HiveLane[] };          // G11 remote lanes
  'hive:remote:continueLocally': { req: { laneId: HiveId; adapterId: AdapterId };        res: { task: HiveTask; lane: HiveLane } };
  'hive:lane:accept':      { req: AcceptReq;                                             res: { opId: string } };
  'hive:lane:discard':     { req: { laneId: HiveId; keepBranch: boolean; force: boolean }; res: { opId: string } };
  'hive:lane:restack':     { req: { laneId: HiveId; onto?: string; mode: 'rebase' | 'merge' }; res: { opId: string } };
  'hive:lane:createPr':    { req: CreatePrFromLaneReq;                                   res: { pr: { number: number; webUrl: string } } };
  'hive:checkpoint:create':{ req: { laneId: HiveId; label?: string };                    res: HiveCheckpoint };
  'hive:checkpoint:restore':{ req: { checkpointId: HiveId; mode: 'worktree' | 'branch' }; res: { opId: string } };
  'hive:checkpoint:diff':  { req: { from: HiveId | 'base'; to: HiveId | 'worktree'; laneId: HiveId }; res: { files: unknown /* spec 02 FileChangeSummary[] */ } };
  // ---- coordination (file 07)
  'hive:conflicts:matrix': { req: { repoId: RepoId; refresh?: boolean };                 res: ConflictMatrix };
  'hive:queue:get':        { req: { repoId: RepoId };                                    res: MergeQueue };
  'hive:queue:set':        { req: { repoId: RepoId; laneIds: HiveId[] };                 res: MergeQueue };
  'hive:queue:run':        { req: { repoId: RepoId; stopOnConflict: boolean };           res: { opId: string } };
  // ---- adapters (file 02)
  'hive:adapters:list':    { req: { refresh?: boolean };                                 res: AdapterSummary[] };
  'hive:adapters:integration:preview': { req: { adapterId: AdapterId; scope: 'global' }; res: IntegrationPreview };
  'hive:adapters:integration:install': { req: { adapterId: AdapterId; scope: 'global'; previewHash: string }; res: IntegrationStatus };
  'hive:adapters:integration:uninstall': { req: { adapterId: AdapterId; scope: 'global' }; res: IntegrationStatus };
  'hive:adapters:custom:save': { req: CustomAdapterDef;                                  res: AdapterSummary };
  'hive:adapters:custom:delete': { req: { id: AdapterId };                               res: void };
  // ---- repo config, trust, templates, audit (files 03, 05, 08, 09)
  'hive:repoConfig:get':   { req: { repoId: RepoId };                                    res: ResolvedRepoHiveConfig };
  'hive:repoConfig:setLocal': { req: { repoId: RepoId; patch: Partial<LocalRepoHiveConfig> }; res: ResolvedRepoHiveConfig };
  'hive:repoConfig:trust': { req: { repoId: RepoId; fileHash: string; decision: 'trust' | 'deny' }; res: ResolvedRepoHiveConfig };
  'hive:templates:list':   { req: { repoId?: RepoId };                                   res: TaskTemplate[] };
  'hive:templates:save':   { req: TaskTemplate;                                          res: TaskTemplate };
  'hive:templates:delete': { req: { id: string };                                        res: void };
  'hive:audit:list':       { req: { repoId?: RepoId; since?: number; limit: number };    res: AuditEntry[] };
  'hive:secrets:list':     { req: { adapterId: AdapterId };                              res: { name: string; set: boolean }[] };   // names only
  'hive:secrets:set':      { req: { adapterId: AdapterId; name: string; value: string | null }; res: void };            // value flows renderer→main once, never back
}

export interface HiveEventContract {
  'hive:changed':          HiveDelta;                                   // entity upserts/removals for one repo
  'hive:attention':        { item: AttentionItem; change: 'opened' | 'updated' | 'closed' };
  'hive:signal':           SignalEnvelope;                              // only to windows that subscribed to that session (activity view)
  'hive:conflicts:updated':{ repoKeyHash: string; matrix: ConflictMatrix };
  'hive:adapters:changed': { adapters: AdapterSummary[] };
}

export interface HiveDelta {
  repoKeyHash: string; rev: number;
  upsert?: { tasks?: HiveTask[]; lanes?: HiveLane[]; sessions?: HiveSession[]; checkpoints?: HiveCheckpoint[] };
  remove?: { tasks?: HiveId[]; lanes?: HiveId[]; sessions?: HiveId[]; checkpoints?: HiveId[] };
}
```

Request types referenced above are defined elsewhere: `TaskCreateReq`, `TaskTemplate` (file 05); `LaneSpec`, `ResolvedRepoHiveConfig`, `LocalRepoHiveConfig` (file 03); `SessionStartReq`, `AdapterSummary`, `IntegrationPreview`, `IntegrationStatus`, `CustomAdapterDef` (file 02); `AcceptReq`, `CreatePrFromLaneReq`, `LaneReviewSummary`, `LaneCompareResult`, `FeedbackReq`, `ShapeReq` (file 06); `ConflictMatrix`, `MergeQueue` (file 07); `AuditEntry` (file 08); `RemoteLaneInfo` (file 10).

`hive:signal` subscription: the renderer calls `hive:session:events` once (backfill) and then receives live `hive:signal` for sessions whose Activity tab is open; a window subscribes via `window.api.hive.subscribeSignals(sessionId)` which sends `hive:signal:subscribe` / `hive:signal:unsubscribe` (fire-and-forget) so main doesn't broadcast every tool event to every window.

### 5.5 `GitOperation` variants (spec 02 §5.5)

| `type` | Payload | `OperationMeta` | Journal kind (spec 05) |
|---|---|---|---|
| `hive.lane.create` | `{ worktreePath; branch; startPoint: Sha; laneId }` | mutating, `touches: ['worktrees','refs','graph']`, `undoable: false` (discard is the inverse), `exclusive: 'repo'` | — |
| `hive.lane.discard` | `{ laneId; worktreePath; branch; keepBranch; force }` | mutating, `touches: ['worktrees','refs','graph']`, `undoable: true` | `hive-discard` (new) |
| `hive.lane.accept` | `AcceptReq` + resolved plan (file 06 §6.3) | mutating, `touches: ['refs','graph','status','worktrees']`, `undoable: true` | `hive-accept` (new) |
| `hive.lane.restack` | `{ laneId; onto; mode }` | mutating, `touches: ['refs','graph','status']`, `undoable: true` | `rebase` / `merge` (existing kinds, label "Restack lane …") |
| `hive.lane.commitWip` | `{ laneId; message; paths? }` | mutating, index lane of that worktree's gitDir, `undoable: true` | `commit` |
| `hive.checkpoint.restore` | `{ laneId; checkpointSha; mode }` | mutating, `touches: ['status','refs']`, `undoable: true` | `hive-restore` (new) |
| `hive.queue.run` | `{ laneIds; stopOnConflict }` | composite; one op per lane, each its own journal entry | per lane |
| `hive.lane.shape` | `ShapeReq` (squash / compose / reword with trailers) | mutating on the lane branch, `touches: ['refs','graph']`, `undoable: true` | `hive-shape` (new) |
| `hive.lane.handoff` | `{ laneId; direction }` | mutating in the **main** worktree (checkout/stash) and the lane worktree (detach), `undoable: true` | `hive-handoff` (new) |
| `hive.lane.fromWip` | `{ title; branch; worktreePath }` | stash-create in main + worktree add + apply, `undoable: true` | `hive-from-wip` (new) |

New journal kinds `hive-accept`, `hive-discard`, `hive-restore`, `hive-shape`, `hive-handoff`, `hive-from-wip` must be added to spec 05 `JournalEntry.kind` (cross-spec dependency, §11). Checkpoint *creation* only writes refs under `refs/githappens/hive/*` and is not journaled (it never changes user-visible state).

### 5.6 Renderer store

`useHiveStore` (Zustand), one slice per `repoKeyHash`, populated by `hive:state:get` (repo tab views) or `hive:state:list` (the pinned Hive tab, which loads every repo in its scope — Hive is a single cross-repo pinned app tab, `TabKind 'hive'` without `repoPath`, decided 2026-10-12; file 04 §4.1) and patched by `hive:changed` deltas (drop deltas with `rev ≤ current`; on a gap `rev > current + 1`, refetch the snapshot). A global `useAttentionStore` holds open attention items for all repos (`hive:attention:list { scope: 'all' }` at startup, then `hive:attention` events). Selectors: `selectLanesByStage`, `selectRepoRollupStatus` (highest-priority session status, for the left-panel toggle badge, file 04 §4.3), `selectLaneForWorktree(path)` (graph WIP rows, spec 04).

## 6. Implementation details

### 6.1 HiveService composition (main)

```ts
// src/main/hive/hive-service.ts
export class HiveService {
  constructor(deps: {
    repos: RepoManager;              // spec 02: GitService + OperationQueue per commonDir
    journal: Journal;                // spec 05
    pty: PtyService;                 // spec 12 §6.1
    providers: ProviderService;      // spec 10 (issues/PRs)
    settings: SettingsStore; secrets: SecretStore;   // spec 13
    notify: Notifier;                // spec 01 §4.10 OS notifications
    paths: { userData: string; profileId: string; resources: string };
  });
  readonly store: HiveStore;
  readonly adapters: AdapterRegistry;     // file 02
  readonly runners: RunnerFactory;        // file 02
  readonly signals: SignalBus;            // §6.3
  readonly bridge: HookBridge;            // file 02 §6.4
  readonly lanes: LaneManager;            // file 03
  readonly checkpoints: CheckpointService;// file 06 §6.6
  readonly review: ReviewService;         // file 06
  readonly coordination: CoordinationService; // file 07
  readonly attention: AttentionQueue;     // §6.7
  readonly governor: ResourceGovernor;    // file 08 §6.7
  readonly audit: AuditLog;               // file 08 §6.8
  start(): Promise<void>;                 // load index, start bridge, reconcile (§6.8)
  stop(reason: 'quit' | 'profile-switch'): Promise<void>;
}
```

Startup is lazy: `HiveService.start()` runs when the first repo tab opens or the pinned Hive tab is shown, and only if `hive.enabled` (file 09). Because the board is cross-repo, HiveService loads the `index.json` list of known repos at start and keeps each repo's state loaded while it has live runs, open attention items or is in the board's scope — independent of whether a repo tab is open (git operations for a repo without an open tab use a headless `GitService` instance from RepoManager). The hook bridge listener starts at the same time (needed for external sessions only when global integrations are installed).

### 6.2 State machines

**Task stage** (derived each time a lane or session changes; `stageOverride` wins for display only, never for behavior):

```
draft ──start──► queued ──(limits ok & deps met)──► active
  │                                                  │ all lanes stopped/review, or any lane signals turn-complete with changes and no live run
  │                                                  ▼
  │                                               review ──accept (one lane)──► done
  │                                                  │      └─ PR opened ──────► done (pr set; reopens to review if PR closed unmerged)
  │                                                  └─ new prompt / resume ──► active
  └──archive──► archived  (from any stage; open lanes discarded or kept per request)
```

Derivation rule: `active` if any lane is `provisioning|running`; else `review` if any lane is `stopped|review` with `changedFiles > 0`; `done` if `acceptedLaneId` set or task explicitly completed; `queued` if `hive:task:start` was called but no lane is provisioned yet; `draft` otherwise.

**Lane state:**

| From | Event | To |
|---|---|---|
| — | `hive:task:create` with start / `hive:task:start` / `addLane` | `provisioning` |
| `provisioning` | worktree + setup ok | `ready` → immediately `running` if a session start is pending |
| `provisioning` | git error / setup failed (`setup.onFailure = 'stop'`) | `error` (worktree kept; Retry setup / Discard offered) |
| `ready`, `stopped`, `review` | session run started | `running` |
| `running` | last live run ends | `stopped` |
| `stopped` | user opens Review tab / agent `turn-complete` with changes and no live run | `review` |
| `ready`,`stopped`,`review`,`error` | accept requested | `accepting` |
| `accepting` | op succeeded | `accepted` |
| `accepting` | conflict / failure | `review` with `error` set (conflict handoff, file 06 §6.4) |
| any except `accepting`,`discarding` | discard requested | `discarding` → `discarded` |
| `accepted`, `discarded` | undo of the journal entry | previous state (`review`) |

Invariants: a lane in `running` has ≥ 1 run without `endedAt`; a lane never transitions `discarded → running` (undo first); accepting/discarding require no live run (Hive asks to stop sessions first, or stops them with confirmation).

**Session status** is computed by the SignalBus (§6.3). Allowed transitions:

```
starting → working | idle | needs-input | needs-permission | error | exited
working  → needs-permission | needs-input | idle | error | exited | working
needs-permission → working (resolved allow/deny) | needs-input | idle | exited
needs-input → working (prompt sent / turn-started) | exited
idle     → working | exited | needs-input
error    → working (retry/resume) | idle | exited
done     → (terminal for headless) ; exited → (terminal for a run; resume creates a new run → starting)
```

### 6.3 SignalBus and status resolution

Every run has up to four signal sources: hook bridge (`hook`), structured stream / ACP (`stream`/`acp`), terminal escape sequences OSC 9 / OSC 777 / BEL (`osc`), and the pty heuristic (`heuristic`, the existing spec 12 classifier: output within 2 s ⇒ working; prompt-like last line and quiet > 10 s ⇒ needs-input; else idle). Resolution:

1. Sources have precedence `acp = stream > hook > osc > heuristic > process`.
2. A higher-precedence source **claims** a session after its first signal; lower sources are then used only to (a) detect liveness (output bytes) and (b) fill gaps: if the claimed source has been silent for `hive.signals.staleAfterMs` (default 120 s) while the heuristic sees continuous output, show `working` with `statusSource: 'heuristic'` and a "status may be stale" tooltip.
3. `permission-request` from any source opens an attention item immediately; `permission-resolved` closes it (with `by: 'terminal'` when the user answered inside the agent TUI; detected by the hook's next `tool:pre/post` for the same tool-use id, or by the request's bridge connection closing).
4. Debounce status transitions for display by 300 ms except into `needs-permission`, `needs-input`, `error` (immediate).
5. `run-exited` is authoritative: status becomes `exited` (pty) or `done`/`error` (headless, by exit code and final result event).

### 6.4 Worktree marker file

When Hive creates or adopts a lane it writes `<worktree-gitdir>/githappens-hive.json` (the per-worktree admin dir, i.e. `<commonDir>/worktrees/<name>/`, never inside the working tree):

```json
{ "version": 1, "laneId": "01J…", "taskId": "01J…", "profileId": "default", "createdBy": "githappens", "createdAt": 1760000000000 }
```

It lets Hive (a) recognize its own lanes after a state loss, (b) tell other GitHappens profiles that a worktree is Hive-managed, (c) clean up orphans safely (file 03 §6.8). Git ignores unknown files in that directory and `git worktree prune/remove` deletes it along with the admin dir.

### 6.5 WIP refresh

`LaneManager` refreshes `LaneWipSummary` for each non-discarded lane:

- on `git:repo:changed` for the lane's worktree (spec 02 RepoWatcher, when that worktree is open in a tab) or for the commonDir `refs`/`worktrees` scopes;
- on `turn-complete`, `tool:post` for file-editing tools (debounced 1 s), `run-exited`;
- every 30 s while the lane has a live run and a Hive view is visible (same cadence as spec 09 §6.10 WIP nodes), every 5 min otherwise;
- capped at 4 concurrent refreshes per repo, read pool, `GIT_OPTIONAL_LOCKS=0`.

Commands (cwd = lane worktree):

```
git status --porcelain=v2 -z --untracked-files=normal --branch     # uncommitted, head
git rev-list --left-right --count <base.sha>...HEAD                 # behind/ahead (left=base-only, right=lane-only)
git diff --numstat -z <mergeBase> --                                # committed+uncommitted tracked vs merge-base
                                                                    # mergeBase = git merge-base <base.sha> HEAD (cached per headSha)
```

Untracked files are counted from status (each counts as one file; lines via `git diff --no-index --numstat /dev/null <file>` only when ≤ 200 untracked files, else omitted and marked approximate).

### 6.5a Usage and provenance capture (G9, G4 data)

- **Time** is always measured: `wallMs` per run from spawn to exit; `activeMs` accumulates while the session status is `working`.
- **Tokens/cost** come only from what the agent reports (file 02 §6.2 per adapter: Claude stream-json `result` usage and cost, Codex `exec --json` turn usage, ACP usage updates, hook payloads where present). If tokens are known but cost is not, cost is estimated from `hive.pricing` (user-editable price table per model; empty by default, so no guessed numbers) and marked `costSource: 'estimate'`.
- Roll-ups: run → session → lane → task, recomputed on `usage` signals and run exit; persisted per run in `usage.jsonl` so totals survive pruning of old runs.
- **Provenance** records are appended when a hook or ACP event reports a file edit (tool name + path + new blob or ranges where available) and, as a fallback, from the lane diff at each checkpoint (`kind: 'checkpoint-diff'`). They are local only. The agent-blame UI and git-notes export (`refs/notes/ai`, compatible with git-ai / Agent Trace) are deferred (G4; file 06 §10).

### 6.6 Adoption of ad-hoc sessions and worktrees

- **Terminal adoption:** the existing agent detection (spec 12 implementation `agent-detect.ts`) runs inside `HiveService`. When a GitHappens pty's foreground process matches an adapter's `detect.processNames`, Hive finds the worktree containing the pty cwd. If no lane exists for that worktree, it creates an **adopted lane** (`ownership: 'adopted'`, `branch` = current branch or `detached@<sha7>`, `base` = configured default base, task with `source: { kind: 'adopted' }` and title = branch name), then a session with `runner: 'pty'` bound to that pty. Adopted lanes are never auto-removed and "Discard" on them only offers "Discard changes" and "Remove from Hive", never worktree deletion unless the user explicitly picks "Remove worktree" (spec 09 flow).
- **External processes:** sessions found by process cwd (no pty) get `external.detectedBy = 'process'`, read-only actions (Focus window where the OS allows, Relaunch in GitHappens = start a new Hive session with the adapter's resume flag if supported).
- **Hook-reported external sessions** (global integration installed): first hook event for an unknown agent session id with a cwd inside a known repo creates an adopted lane/session with `external.detectedBy = 'hook'`; permission requests from these are answerable.
- The main worktree is adoptable (users often run one agent there), but Hive warns on the card that it is not isolated.

### 6.7 AttentionQueue

- Items sorted by `priority`, then `createdAt`. Dedup key: `(kind, sessionId, requestId|laneId)`.
- `permission` items carry `expiresAt = now + adapter.permissionTimeoutMs - 5 s`. On expiry the bridge answers "no decision" (the agent shows its own prompt) and the item becomes `expired` with a "Answer in terminal" action.
- OS notification (spec 01 §4.10 `notify:desktop`) when the window is unfocused and `hive.notifications.*` allows that kind; clicking focuses the window and opens the lane drawer on that item. Rate-limited: max 1 notification per lane per 30 s, max 6 per minute overall, then a summary notification.
- Badge counts: pinned Hive tab and title-bar badge (all repos), repo tab badge (that repo), left-panel toggle (repo rollup).
- `review` items are created on `turn-complete` only if the turn changed files (WIP delta since the turn started) and are superseded by the next `turn-started`.
- `plan-review` items (G8) are created from a final `plan` signal (or the final message of a plan-mode turn) while `task.planGate.state = 'pending'`; answering them calls `hive:plan:respond` (file 05 §6.5).
- `checks` items (G5) are created when a lane check run or the lane PR's forge rollup turns `failure`; actions: Open log, Send failure to agent (G1 feedback with the failing output), Re-run.
- `budget` items (G9) at 80 % and 100 % of any task budget; never stop the agent automatically (file 08 §6.7).
- `scope` items (G12) when a lane's changed paths leave `task.scope`, or when a new lane's scope overlaps an active lane's scope (file 07 §6.6).
- Keyboard-first: the inbox supports `J/K` navigation and explicit, never single-letter, approval (file 04 §4.6).

### 6.8 Reconciliation on startup and repo open

1. Load `state.json`. Mark every run without `endedAt` as `endReason: 'lost'` if its pid no longer exists (pids are checked with `process.kill(pid, 0)` plus start-time comparison where the OS exposes it, to avoid pid reuse), else as orphaned-alive: Hive cannot reattach to a pty it no longer owns, so the session becomes `external` (read-only) unless the adapter supports resume.
2. `git worktree list --porcelain -z` (spec 02 §6.11). For each lane: worktree missing → state `error` with "Worktree folder was removed" (actions: Recreate from branch, Discard). Branch missing → `error` "Branch deleted outside GitHappens".
3. Worktrees with a marker file but no lane (state loss) → recreate lanes in `stopped` state under a task "Recovered lanes".
4. Re-run WIP refresh for all lanes; recompute task stages; rebuild attention: drop stale `permission` items (their bridge connections are gone), keep `error`/`review`/`conflict`.
5. With `hive.resumeOnStartup` (default off), offer a toast "3 agent sessions were running when GitHappens quit — Resume" (uses adapter resume, file 02 §6.2).

### 6.9 App quit and profile switch

On quit with live runs: dialog "N agents are still working" — Stop all and quit / Keep running in background *(our extension, only for headless runs; pty runs always end because node-pty children die with the app)* / Cancel. Before killing, Hive takes a `manual` checkpoint of each running lane (bounded 3 s total) so nothing in the worktree is lost, then sends each run its adapter's graceful stop (Ctrl+C twice for TUIs, `session/cancel` for ACP, SIGTERM for headless), waits 2 s, then kills the process tree (Windows: `taskkill /T /F /PID`; POSIX: kill the process group, ptys are session leaders).

Profile switch stops Hive for the old profile the same way, then starts it for the new one (Hive data is per profile).

## 7. Step-by-step implementation plan

1. **Types and contract.** Add `shared/hive/types.ts` and `shared/ipc/hive-contract.ts` with exhaustive channel arrays; handler stubs returning `internal`. Test: contract exhaustiveness compiles; spec 15 handler-registration test covers `hive:*`.
2. **HiveStore.** Load/save with atomic writes, `.bak`, migrations, debounced flush. Test: crash-safe write (kill during write in a child process), corrupted file falls back to `.bak`.
3. **Entities + state machines** as pure reducers in `packages/hive-core` (new package, no Electron imports): `reduceLane(state, event)`, `deriveTaskStage(task, lanes)`, `resolveSessionStatus(signals)`. Test: table-driven transition tests, property test that invariants hold under random event sequences (fast-check).
4. **SignalBus** with source precedence, debounce, staleness fallback. Test with synthetic signal streams.
5. **AttentionQueue** with dedup, expiry, notification rate limits. Test with fake timers.
6. **HiveService wiring** with RepoManager, PtyService, settings; `hive:state:get`, `hive:changed` deltas with `rev`. Test: renderer store applies deltas and refetches on gaps.
7. **`hive.*` GitOperations** registered in the operation registry with `OperationMeta`; journal kinds added (spec 05). Test: ops appear in the git output log and `git:op:state` events.
8. **Marker files + reconciliation** (§6.4, §6.8). Test with fixture repos: deleted worktree folder, deleted branch, missing state file.
9. **Adoption** of terminal sessions using the existing detector; `agents:*` shim channels mapped to Hive. Test: an agent started in a terminal tab appears as an adopted lane.
10. **Quit/profile-switch handling** with checkpoint-before-kill. Test with the fake agent (file 11 §6.1).

## 8. Edge cases

- **Bare repos:** no main worktree; lanes are still possible (worktrees of a bare repo). Adoption of "main worktree" is skipped.
- **Repo opened via a linked worktree path:** `HiveRepoKey` uses `commonDir`, so all tabs of the same repo share one Hive slice.
- **Same repo, two GitHappens windows:** state is in main, shared; both windows receive deltas.
- **Two profiles with the same repo:** separate Hive state; marker files carry `profileId`; a lane owned by another profile is shown as external, read-only.
- **Case-insensitive file systems:** realpath + case-fold comparison of worktree paths on Windows/macOS (as `worktreeFor` does today).
- **Clock changes:** ordering uses ULIDs and a monotonic counter; durations use `performance.now()` deltas at runtime.
- **Huge event logs:** rotation at 20 MiB; `hive:session:events` pages backwards by byte offset index kept in memory.
- **Repo moved/renamed on disk:** commonDir changes ⇒ new `repoKeyHash`; on open, if a known `state.json` references worktrees whose admin dirs now live under the new commonDir (git updates `gitdir` files on `git worktree repair`), offer "Re-link Hive data from <old path>".
- **Pid reuse** after reboot: start-time check (§6.8) prevents adopting an unrelated process.
- **Network drive repos:** watcher fallback (spec 02 §6.14) means WIP refresh relies on the 30 s timer.

## 9. Acceptance criteria

- [ ] `hive:*` contract compiles with exhaustive channel lists; main registers every handler.
- [ ] Tasks, lanes, sessions, checkpoints and open attention items survive app restart; runs that were live are marked `lost` or `external` correctly.
- [ ] Corrupting `state.json` recovers from `.bak`; deleting both recovers lanes from marker files.
- [ ] Lane and task state machines reject invalid transitions (unit tests) and the board never shows a lane `running` without a live run.
- [ ] Status precedence: with hooks active, heuristic output never overrides a `needs-permission` state; with hooks silent for 120 s and output flowing, status falls back to `working (heuristic)`.
- [ ] Every Hive git mutation appears in the operation log, runs on the repo's queue, and accept/discard/restore are undoable from the toolbar.
- [ ] An agent started manually in a GitHappens terminal appears as an adopted lane within 5 s.
- [ ] Quitting with running agents takes a checkpoint per lane before stopping them.

## 10. Out of scope / later

- Multi-repo tasks (G20; one task spanning several repos with one lane per repo) — the data model allows it later by making `HiveTask.repo` an array; deferred (file 11 §6.6).
- Agent-blame UI and git-notes export of provenance (G4) — data captured from H2, UI in H5.
- Session history search across closed lanes (G22).
- Sync of Hive state across machines (spec 14 settings sync excludes `hive/`).
- Keeping pty agents alive across app restarts (would need a detached pty host daemon).

## 11. Cross-spec dependencies

- **Spec 02:** `RepoInfo.commonDir`, `git:worktrees`, `git:status { worktreePath }`, `GitOperation` registry and `OperationMeta`, OperationQueue per commonDir (§6.13), RepoWatcher scopes (§6.14). New operation types `hive.*` (§5.5).
- **Spec 05:** new `JournalEntry.kind` values `hive-accept`, `hive-discard`, `hive-restore`; keep-alive refs convention reused under `refs/githappens/hive/*` (spec 00 reserved namespace).
- **Spec 12:** PtyService (§6.1) and terminal attach; existing agent detection code becomes Hive's adoption source; §4.12 superseded (README §6).
- **Spec 13:** profile-scoped userData layout gains `hive/`; SecretStore gains kind `hive/<adapterId>/<envName>` (file 08 §6.4).
- **Spec 01:** pinned app tab `TabKind 'hive'` (no `repoPath`, like Launchpad), OS notifications, title-bar badge, left-panel mode switch.
- **Spec 02/03:** RepoManager must be able to provide a `GitService` and `OperationQueue` for a repo that has no open tab (lanes keep working when the repo tab is closed).
- **Spec 04:** graph WIP rows read `selectLaneForWorktree` to show agent status (file 04 §4.8).
- **Spec 15:** handler-registration test, `packages/hive-core` added to coverage gates.
