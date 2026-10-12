# Hive — parallel coding-agent orchestration for GitHappens

> Status: draft spec, written 2026-10-12. Feature name: **Hive**. Code namespace: `hive` (main `src/main/hive/`, shared `src/shared/hive/`, IPC `hive:*`, settings `hive.*`, refs `refs/githappens/hive/*`).

Hive lets one developer run, supervise, review and land the work of several AI coding agents at the same time. Each agent works in its own git worktree on its own branch. GitHappens tracks what every agent is doing (working, waiting for you, done, failed), puts everything that needs a human into one attention queue, shows exactly what each agent changed, and turns accepted work into merges, rebases or pull requests with the same safety net (operation queue, undo journal, conflict prediction) as every other GitHappens operation.

Hive grows out of the small **Agent Sessions view** in spec 12 §4.12 and **replaces** it (see [Relation to Agent Sessions](#relation-to-agent-sessions-spec-12-412)).

This is a clean-room behavioral specification, under the same legal note as [`../README.md`](../README.md). It describes behavior in our own words. The reference product (a commercial desktop Git client, its editor extension and CLI) is described only where its behavior informed ours; it is never named. Third-party agent CLIs and protocols (Claude Code, Codex CLI, Gemini CLI, GitHub Copilot CLI, Cursor CLI, OpenCode, Aider, ACP, MCP) are named because they are integration targets.

Markers used throughout: *(inferred)* = we could not confirm the reference product's exact behavior; *(our extension)* = we add this on purpose; *(verify)* = third-party CLI detail that must be re-checked against the installed version at build time.

---

## 1. Goals and non-goals

### Goals

1. **Parallel, isolated work.** Start N agents on N tasks (or N agents on one task) without them touching each other's files or the user's checkout. One worktree + branch per agent attempt, created and cleaned up by GitHappens.
2. **Agent-agnostic.** Work with whatever CLI agent the user already has and is signed into. Built-in adapters for Claude Code, Codex CLI, Gemini CLI, GitHub Copilot CLI, Cursor CLI, OpenCode and Aider, plus a generic "any command" adapter. No agent is required, bundled or billed by us.
3. **Know the state without watching terminals.** Accurate status per session from the best available signal: agent hooks > structured output streams (stream-json / ACP) > terminal heuristics (the existing §4.12 classifier).
4. **One attention queue.** Permission requests, questions, errors and "ready for review" from every agent across every open repo land in one place, answerable without switching worktrees.
5. **Git-native review and landing.** Diff per lane against its base, compare lanes, commit/compose WIP, accept via merge / squash / rebase / PR, discard, and undo — all through spec 02's `OperationQueue` and spec 05's undo journal.
6. **Coordination.** Predict conflicts between lanes before they happen (spec 08 merge-tree), sequence dependent tasks, keep lanes rebased on a moving base, share instructions across agents.
7. **Close the review loop.** Inline review comments, PR review comments and failing CI checks go back to the lane's agent as one structured prompt (G1); per-lane checks (test/lint/build plus forge CI) gate landing (G5); an optional plan-approval gate stops a bad lane before it writes code (G8).
8. **Land clean history.** Squash, compose or keep the agent's commits, authored by the user with `Agent:`/`Task:` trailers; never sign with the user's key without consent (G2).
9. **Make it visible where Git users look.** A "Hive lens" in the commit graph shows the base plus every lane branch with status chips, conflict edges, fan-out groups and dependency arrows (G3).
10. **Account for cost.** Time, tokens and estimated cost per run, lane and task, with budget alerts (G9).
11. **Windows is first-class.** ConPTY, named-pipe hook bridge, short worktree paths, Defender/Dev Drive guidance and WSL awareness are designed in, not ported later; most orchestrators are macOS-only.
12. **Safe by default.** Hive never widens an agent's permissions on its own, never auto-approves, never hands GitHappens' tokens to an agent, and logs every privileged action.

Gap ids (G1 to G25) refer to the gap analysis in [00-landscape-and-gaps.md](00-landscape-and-gaps.md).

### Non-goals

- Hive is **not an agent** and does not call an LLM itself to write code. (Existing spec 12 AI features such as commit-message generation stay available inside Hive's review flow.)
- Hive is **not a sandbox.** A worktree isolates files from other lanes, not the machine from the agent. We document the posture honestly (file 08) and integrate the agents' own sandboxes; container/VM runners are a later phase.
- No bundled agent binaries, no reselling of model access, no telemetry of prompts or code.
- **Not an agent or chat product.** Hive does not compete with Claude Code, Codex, Cursor or Copilot on agent quality. The agent's own TUI runs in our terminal; a minimal ACP runner (H3) is used for structured status, plans and approvals, and a native chat UI is deferred and may never ship.
- **No permission bypass or auto-approval.** Agents run in their ask mode by default; a task or template may opt in to auto-accepting file edits inside the lane worktree; full bypass is never offered (only conceivable with a future sandbox/container runner) (decided 2026-10-12, file 08 §6.2).
- **No LLM that picks or lands a winner on its own.** Fan-out ranking only assists with objective signals (checks, size, scope, cost, conflicts); a human always accepts.
- **No custom branch model.** Hive uses plain git worktrees and branches; the disk cost of worktrees is answered with dependency reuse and retention caps (G7), not by replacing them.
- **No agent-to-agent messaging / A2A in v1.** Hive only *shows* subagent/teammate structure that agents report.
- **No cloud execution we host or bill.** Other vendors' cloud agents (Copilot coding agent, Codex cloud, Jules, Devin, Cursor cloud) are tracked as read-only remote lanes (G11, H3).
- **No silent edits to global agent configuration.** Global integrations are opt-in, previewed and reversible.

## 2. Personas

| Persona | Situation | What Hive gives them |
|---|---|---|
| **Solo multitasker** (primary) | Runs 2–5 terminal agents on one repo, loses track of which one is waiting. | Board + attention queue + desktop notifications; one-click new lane. |
| **Explorer** | Wants to try "the same task with Claude and Codex" and keep the better result. | Fan-out tasks, side-by-side compare, accept one / discard others. |
| **Maintainer / reviewer** | Works through issues and PR feedback. | Start a task from an issue, a PR review comment or a Launchpad item; land via PR. |
| **Team lead** (later) | Wants to see what agents on the team touch, avoid collisions. | Conflict matrix, team footprints via spec 14 (file 10). |
| **Security-conscious user** | Must not let agents run unattended with broad access. | Default "ask" permission modes, opt-in auto-accept of in-worktree edits per task only, no bypass in v1, audit log. |

## 3. Feature map

Phases H1–H6 are Hive's own; they slot into the app roadmap after spec 15 §8 (see file 11).

| Feature | File | Phase |
|---|---|---|
| HiveService, entities (Task/Lane/Session/Run/Checkpoint/AttentionItem/ReviewComment), persistence, `hive:*` IPC, event bus, usage/cost fields (G9) | [01-architecture-and-data-model.md](01-architecture-and-data-model.md) | H1 (G9 fields H2) |
| Adapter interface; built-in adapters; agent detection; launch args; pty / headless runners; status signals (hooks, streams, OSC, heuristics); hook bridge; usage extraction (G9); plan mode (G8) | [02-agent-adapters.md](02-agent-adapters.md) | H1 (pty + Claude hooks), H2 (Codex/Copilot/Gemini/OpenCode/Cursor signals, headless) |
| Minimal ACP runner for status, plans and approvals (G13); chat UI deferred | [02-agent-adapters.md](02-agent-adapters.md) §6.3.4 | H3 (runner), later or never (chat UI) |
| Hive MCP server for agents | [02-agent-adapters.md](02-agent-adapters.md) §6.6 | H5 |
| Worktree + branch per lane, naming, base branch, setup steps, env/file copy, dependency reuse and CoW clones (G7), port blocks, check commands (G5), retention cap and disk readout (G7), cleanup | [03-worktree-isolation.md](03-worktree-isolation.md) | H1 (G7 reuse/retention H2) |
| Pinned Hive app tab (one cross-repo board with repo filter and "This repo" quick scope, inbox rail), compact per-repo left-panel list, lane drawer (terminal attach, activity, changes, checks, cost), notifications, graph "Hive lens" (G3) | [04-hive-board-ui.md](04-hive-board-ui.md) | H1 (list + drawer), H2 (pinned tab + inbox), H4 (graph lens) |
| Task intake: prompt, issue, PR / review comment, CI failure, Launchpad, graph/branch; templates; plan gate (G8); file scope (G12); fan-out | [05-task-intake.md](05-task-intake.md) | H1 (prompt), H2 (plan gate), H3 (issues/PR/Launchpad/fan-out) |
| Review per lane, inline comments to agent feedback loop (G1), lane checks + forge CI landing guards (G5), compare lanes, commit shaping with trailers (G2), accept (merge/squash/rebase/PR), "try it locally" handoff (G6), discard, checkpoints, undo; provenance capture for later agent blame (G4 data) | [06-review-and-merge.md](06-review-and-merge.md) | H2 (review/feedback/checks/accept/discard/handoff), H4 (checkpoints) |
| Dependencies, declared file scope + overlap warnings (G12), cross-lane conflict prediction, merge queue / restack, shared instructions | [07-coordination.md](07-coordination.md) | H4 (scope warnings H3) |
| Security model, permission posture, secrets, commit identity/signing policy (G2), budgets (G9), resource and disk limits (G7), audit log | [08-security-and-limits.md](08-security-and-limits.md) | H1 (baseline), grows each phase |
| Settings `hive.*`, repo config file, commands, shortcuts, migration from §4.12 settings | [09-settings-and-commands.md](09-settings-and-commands.md) | H1 |
| Remote/cloud agent PRs as read-only remote lanes (G11); team visibility; optional cloud runners | [10-cloud-and-team.md](10-cloud-and-team.md) | H3 (remote lanes), H6 (team/cloud) |
| Phases, fake-agent harness, unit/integration/e2e strategy, release acceptance | [11-roadmap-and-testing.md](11-roadmap-and-testing.md) | none |

Deferred (file 11 §6.6): agent blame UI (G4; data captured from H2, UI in H5), stacked lanes/PRs (G10), pre-landing AI review pass (G14), rich notifications with actions/tray (G15), adopting agent-made worktrees (G16), scheduled automations (G17), best-of-N ranking assist (G18), semantic conflict checks (G19), multi-repo tasks (G20), container runner (G21), session search (G22), mobile check-in (G23), team policy (G24), agent-to-agent messaging (G25).

## 4. Glossary

| Term | Meaning |
|---|---|
| **Agent** | A third-party coding-agent CLI installed on the user's machine (e.g. `claude`, `codex`, `gemini`, `copilot`, `cursor-agent`, `opencode`, `aider`, or a custom command). |
| **Adapter** | Hive's integration module for one agent kind: detection, launch argv, signal sources, capabilities (file 02). |
| **Task** | A unit of intended work: a title, a prompt/brief, optional linked issue/PR, a base, and one or more lanes. The card on the board. |
| **Lane** (worktree lane) | One attempt at a task: one linked git worktree + one branch + the sessions that run in it. A fan-out task has several lanes. Lanes are what you review, accept or discard. |
| **Session** | One agent conversation inside a lane, as the agent understands it (for Claude Code: its session id; for Codex: its thread id). A lane may host several sessions over time (e.g. "continue with a different agent"). |
| **Run** | One OS process lifetime executing a session (pty, headless, or ACP child). Resume after an app restart = a new run of the same session. |
| **Runner** | The process host for a run: `pty` (interactive TUI in our terminal), `headless` (one-shot JSON stream), `acp` (JSON-RPC over stdio). |
| **Signal** | A normalized status event (`working`, `needs-permission`, `needs-input`, `turn-complete`, `error`, …) derived from hooks, streams or heuristics. |
| **Attention item** | Something that needs the human: a permission request, a question, an error, a lane ready for review, a predicted conflict. Lives in the attention queue. |
| **Checkpoint** | A snapshot commit of a lane's full worktree state (tracked + untracked, not ignored) taken at turn boundaries, kept under `refs/githappens/hive/…`. Allows rewind. |
| **Base** | The branch/commit a lane was created from and is reviewed/landed against. |
| **Accept / land** | Integrating a lane into its base (merge, squash, rebase+ff) or opening a PR from it. |
| **Discard** | Removing a lane's worktree and branch (undoable for 30 days via keep-alive refs). |
| **Hook bridge** | The local endpoint plus tiny helper executable that agent hooks call to deliver signals and receive permission decisions (file 02 §6.4). |
| **Remote lane** | A read-only lane for work done by a cloud agent (Copilot coding agent, Codex cloud, Jules, Devin, Cursor cloud), backed by its PR branch (G11, file 10). |
| **Review comment** | A note the user attaches to a line/hunk of a lane's diff; batched and sent back to the lane's agent as feedback (G1). |
| **Lane checks** | Repo-defined verification commands (test, lint, typecheck, build) run in the lane worktree, plus forge CI status for the lane's PR (G5). |
| **Plan gate** | Optional task mode where the agent first produces a plan that the user approves before it may write code (G8). |
| **Scope** | Optional globs a task declares it will touch; edits outside scope and overlapping scopes between lanes raise warnings (G12). |
| **Handoff** | Moving a lane's branch into the main checkout to try it locally and back again, undoable (G6). |
| **Hive lens** | Commit-graph filter showing only the base and lane branches with Hive annotations (G3). |
| **Fan-out** | Creating several lanes for one task with different agents/models/prompts to compare results. |

## 5. Architecture overview

```
┌──────────────────────────────── Main process ─────────────────────────────────┐
│ HiveService (singleton)                                                       │
│  ├─ HiveStore ............ tasks/lanes/sessions JSON + per-session event logs  │
│  ├─ AdapterRegistry ...... built-in + custom adapters, detection cache         │
│  ├─ RunnerFactory                                                             │
│  │    ├─ PtyRunner ....... wraps spec 12 PtyService (node-pty, xterm stream)   │
│  │    ├─ HeadlessRunner .. child_process + JSONL stream parser                 │
│  │    └─ AcpRunner ....... JSON-RPC 2.0 over stdio (H3)                         │
│  ├─ SignalBus ............ merges hook / stream / heuristic signals → status    │
│  ├─ HookBridge ........... local socket/pipe server + helper exe, per-run token │
│  ├─ LaneManager .......... worktree + branch lifecycle, setup steps, ports      │
│  ├─ CheckpointService .... snapshot commits, keep-alive refs, restore           │
│  ├─ ReviewService ........ diff stats, compare, comments→feedback, accept/discard│
│  ├─ ChecksService ........ lane checks (test/lint/build) + forge CI status      │
│  ├─ UsageMeter ........... time/tokens/cost per run, lane, task; budgets        │
│  ├─ ProvenanceRecorder ... agent-authored hunk records (data for agent blame)   │
│  ├─ RemoteLaneTracker .... cloud-agent PRs as read-only lanes (H3)             │
│  ├─ CoordinationService .. conflict matrix (merge-tree), deps, merge queue      │
│  ├─ AttentionQueue ....... prioritized items, OS notifications                  │
│  ├─ ResourceGovernor ..... concurrency, runtime/idle limits, disk, CPU/memory   │
│  ├─ AuditLog ............. append-only JSONL of privileged actions             │
│  └─ HiveMcpServer (H5) ... optional MCP tools for agents (task info, report)    │
│ Uses: RepoManager/GitService + OperationQueue (spec 02), Journal (spec 05),    │
│       PtyService (spec 12), ProviderService/AuthService (spec 10),             │
│       SettingsStore/SecretStore (spec 13), Notification (spec 01)              │
└──────────────▲──────────────────────────── typed IPC `hive:*` ───────────────┘
               │ invoke / events (contextBridge, no tokens ever cross)
┌──────────────┴──────────────────────── Renderer ─────────────────────────────┐
│ HiveTabView (pinned app tab: cross-repo board + inbox rail + docked drawer)   │
│ HivePanel (per-repo left-panel mode, replaces AgentSessionsPanel)             │
│ LaneDrawer (Terminal · Activity · Changes · Checks · Checkpoints · Info)      │
│ NewTaskDialog · CompareView · graph WIP badges + Hive lens · title-bar badge  │
│ useHiveStore (Zustand, fed by `hive:changed` deltas)                          │
└───────────────────────────────────────────────────────────────────────────────┘
        ▲ hooks call helper → HookBridge          ▲ agents run as child processes
┌───────┴───────────── Agent processes (one per run, cwd = lane worktree) ──────┐
│ claude · codex · gemini · copilot · cursor-agent · opencode · aider · custom  │
└───────────────────────────────────────────────────────────────────────────────┘
```

Key rules (binding for all Hive files):

1. **All git work goes through spec 02.** Lane creation, accept, discard, rebase, checkpoint restore are `GitOperation` variants (`hive.*`) on the repo's `OperationQueue` keyed by `commonDir`. Read-only probes (status per worktree, merge-tree) run in the read pool.
2. **Agents are never spawned by the renderer.** The renderer asks `hive:session:start`; main resolves the adapter, builds argv, env and cwd, and spawns.
3. **Agents write only inside their lane** as far as Hive can influence it (cwd, agent sandbox flags, permission rules). Hive itself never writes into the user's main worktree on an agent's behalf except through an explicit accept.
4. **Secrets stay in main.** Provider tokens, AI keys and per-adapter env secrets are read from SecretStore in main and are never sent over IPC (file 08).
5. **Status is advisory, git is truth.** What a lane changed is always computed from git (status/diff against base), never from the agent's own claims.

## 6. Relation to Agent Sessions (spec 12 §4.12)

The shipped Agent Sessions view (`apps/desktop/src/main/agents/*`, `shared/ipc/agents-contract.ts`, `renderer/src/views/agents/*`) detects agents in integrated terminals by foreground process name, classifies status from pty activity, finds external agents by process cwd, and starts an agent in a worktree after running setup commands from git config `githappens.agentSetup`.

Hive supersedes it as follows:

| §4.12 today | Hive |
|---|---|
| Left-panel `List \| Agents` toggle | Same toggle, relabelled `List \| Hive`; renders the compact per-repo `HivePanel` (file 04 §4.3), with an "Open board" link to the pinned Hive tab scoped to that repo. `ui.showAgentsToggle` keeps working as an alias of `hive.showLeftPanelToggle`. |
| Session = any pty whose foreground process is a known agent | Kept as **"ad-hoc sessions"**: a manually started agent in any terminal is adopted into an implicit lane for that worktree (file 01 §6.6). Hive-started sessions are first-class. |
| Status from pty activity heuristics (2 s running / 10 s prompt-like = waiting) | Kept as the **lowest-priority** signal source; hooks and structured streams take precedence (file 02 §6.3). |
| External sessions (process cwd) read-only | Kept; additionally, if the user opts in to global hook install, external sessions report real status and permission requests (file 02 §6.4.4). |
| `agents:list/start/stop/setup:get/setup:set` | Replaced by `hive:*` (file 01 §5.4). The `agents:*` channels remain for one release as thin shims over HiveService, then are removed. |
| `tools.agentCommand` / `tools.agentArgs` | Migrated into `hive.defaultAdapter` + the `custom` adapter (file 09 §6.4). |
| Setup commands in git config `githappens.agentSetup` (implementation) / `RepoSettings.agentSetupCommands` (spec 13) | Unified into lane setup steps: repo-local (git config, unchanged storage) plus an optional committed `.githappens/hive.jsonc`, which requires a per-repo trust decision (file 03 §6.4, file 08 §6.5). |
| Out of scope: transcripts, approving tool calls, status plugins | Now in scope: activity timeline, permission approve/deny through hooks, opt-in status integrations. |

Spec 12 §4.12, spec 13 (`ui.showAgentsToggle`, `tools.agent*`, `RepoSettings.agentSetupCommands`) and spec 15 Phase 5 item 5 should be updated by the owner to point here.

## 7. Index of files

| File | Lines | Summary |
|---|---|---|
| [00-landscape-and-gaps.md](00-landscape-and-gaps.md) | 550 | Competitive landscape and gap analysis (separate research); gap ids G1 to G25 |
| [01-architecture-and-data-model.md](01-architecture-and-data-model.md) | 714 | Entities (task, lane, session, run, checkpoint, attention, review comment, usage, provenance), state machines, persistence, `hive:*` IPC, events, `hive.*` git operations |
| [02-agent-adapters.md](02-agent-adapters.md) | 486 | Adapter contract, built-in adapters, detection, pty/headless/ACP runners, signals, hook bridge and helper, plan mode, usage, Windows specifics, MCP |
| [03-worktree-isolation.md](03-worktree-isolation.md) | 365 | Lane provisioning, naming, setup/teardown/run/check steps, file copy, dependency reuse and CoW clones, ports, trust gate, retention cap, disk usage, GC |
| [04-hive-board-ui.md](04-hive-board-ui.md) | 285 | Pinned Hive app tab (cross-repo board, repo filter, inbox rail), per-repo left-panel mode, lane drawer, notifications, cost display, Hive lens in the graph, shortcuts |
| [05-task-intake.md](05-task-intake.md) | 249 | Tasks from prompt/issue/PR/thread/CI/Launchpad/graph, templates, prompt composition and redaction, plan gate, scope, fan-out |
| [06-review-and-merge.md](06-review-and-merge.md) | 387 | Review, comments and feedback loop, checks guards, compare, shaping with trailers and signing policy, accept/PR, conflict handoff, try-in-main handoff, checkpoints, undo |
| [07-coordination.md](07-coordination.md) | 214 | Dependencies, scope overlap, conflict matrix, restack, merge queue, shared instructions, lens data |
| [08-security-and-limits.md](08-security-and-limits.md) | 247 | Threat model, permission presets (ask default, opt-in auto-accept edits, no bypass), risk classification, never-do list, env/secrets/redaction, trust, limits and budgets, audit log |
| [09-settings-and-commands.md](09-settings-and-commands.md) | 204 | `hive.*` settings, Preferences pages, commands, migration from Agent Sessions |
| [10-cloud-and-team.md](10-cloud-and-team.md) | 155 | Remote (cloud agent) lanes in H3, team visibility, org policy, mobile and cloud (later) |
| [11-roadmap-and-testing.md](11-roadmap-and-testing.md) | 171 | Phases H1 to H6, fake-agent harness, test layers, e2e scenarios, perf targets, release acceptance |

## 8. What the research found (summary)

Details and dates are in [Sources](#sources). A broader competitive landscape and a gap analysis against this spec live in [00-landscape-and-gaps.md](00-landscape-and-gaps.md) (separate research). In short:

- **Reference desktop app (versions 12.0 – 12.6, April – October 2026).** An "Agent Sessions" view shows each worktree as a card (branch, uncommitted changes, ahead/behind, linked PRs) with agent status. "New Agent Session" creates a worktree, runs configured setup commands and launches the chosen agent; since 12.6 a dialog asks for branch name, base branch and agent first, and a split button keeps a one-click default. Supported agents: Claude Code, Codex CLI, OpenCode, Copilot CLI, Gemini CLI (auto-detected), later Cursor CLI. Live status started with Claude Code via hooks the app installs into the agent's configuration; status/permission "plugins" were then added for OpenCode, Codex and Copilot CLI, installed from External Tools, and since 12.6 only on explicit request. Pending permission requests can be allowed or denied from the panel (Claude Code first, with a preview of the requested command; then Codex and Copilot). Sessions can start from issues in Launchpad or the left panel (branch + worktree + agent launched with the issue's context). The graph shows a WIP row per worktree with changes or an active session, including agent status. External agent windows can be focused or relaunched inside the app's terminal. The left-panel toggle shows the highest-priority status across sessions. Pricing tier for these features is not stated in the release notes *(unverified)*.
- **Reference editor extension (2026).** Shows Claude Code sessions (states: running, waiting for input, idle, completed) in a sidebar panel, on graph overview cards and in a details panel, via extension-managed hooks with an explicit install/uninstall command. Its MCP registration can target several detected agents.
- **Reference CLI / MCP server.** A local stdio MCP server exposing git, issue and PR tools to agents; it is not itself a session manager.
- **The same vendor's separate agent environment (public preview, mid-2026)** is task-centric: tasks bundle prompt, repos, worktree per repo, sessions and shared instructions; a todo list fills from assigned issues/PRs; prompt templates ("actions") such as Plan / Review / Address feedback; rich chat over ACP or agent CLIs in a wrapped terminal; hooks for status and to detect externally started sessions; permission requests with allow once / for session / always / reject, and an explicit rule that it never approves on the user's behalf. We borrow the task-centric model, templates and the permission posture.
- **Agent CLIs with usable hooks (2026):** Claude Code (richest: `PermissionRequest`, `Notification`, `Stop`, `SessionStart/End`, worktree events; per-run injection via `--settings`), Codex CLI (`hooks.json`/inline `[hooks]` with `PermissionRequest`/`PreToolUse`/`Stop`, hash-based trust; `-c` overrides; `exec --json`; `app-server`), Gemini CLI (`settings.json` hooks incl. `BeforeTool`/`AfterAgent`/`Notification`; `--acp`), GitHub Copilot CLI (`.github/hooks/*.json` and `~/.copilot/hooks/` incl. `preToolUse`/`permissionRequest`), Cursor CLI (`hooks.json`, `beforeShellExecution` allow/deny/ask; CLI hook firing reported unreliable), OpenCode (plugins/server event stream incl. `permission.asked`/`session.idle`; `opencode acp`), Aider (only `--notifications-command` for "waiting for input").
- **Comparable tools:** Conductor (setup/run/archive scripts, 10-port block per workspace, concurrent vs exclusive run mode), Claude Squad (tmux + worktrees, terminal-first), Vibe Kanban (kanban of task attempts, review comments sent back to agent, rebase/merge/PR from diff header; runs agents with permission bypass by default — a pattern we deliberately reject), Crystal (worktree sessions with diff/merge; deprecated in 2026), GitHub Agent HQ / mission control (assign and track cloud agents incl. Copilot coding agent, Claude, Codex, with org-level controls and audit).

### Positioning

"Editors run agents. GitHappens lands them." Hive works with any CLI agent on Windows, macOS and Linux, shows every agent as a branch in the graph, predicts collisions before they happen, sends your review back to the agent, shapes the result into clean commits, records which lines an agent wrote, and makes every landing undoable.

## 9. Open questions

### Decided

Decisions by the owner on **2026-10-12**:

- **Placement (was Q1):** Hive is a **single pinned app tab**, like Launchpad: one board across all repos with a repo filter, and a quick "This repo" scope when opened from a repo tab (toolbar, shortcut, left panel, status bar). The cross-repo attention inbox is part of that tab (inbox rail). It is not a per-repo tab; the left-panel `List | Hive` mode stays as the per-repo summary and entry point. (Files 01 §5.4/§5.6, 04 §4.1–§4.6, 09 §4.2–§4.3, 11.)
- **Permissions (was Q2):** **Ask by default.** A task or template may opt in to a preset that **auto-accepts file edits** inside the lane worktree (Claude Code `acceptEdits`; Codex `--sandbox workspace-write`). **Full permission bypass is never offered** unless a sandbox/container runner exists, and that runner is future work, so v1 has no bypass preset; bypass/blanket-approve flags are rejected even in extra args. (Files 08 §6.2, 02 §6.2, 05, 09.)
- **Attribution (was Q14):** commits are **authored by the user**, with `Agent:`/`Task:` trailers (plus `Agent-Model`/`Agent-Session`). A bot author identity is not offered in v1. (Files 06 §6.7, 09 §4.2.)
- **Checks (was Q15):** failing lane checks **block Accept**, with an explicit, audited **"Accept anyway"** override per accept. (Files 06 §4.3/§6.9, 08 §6.8.)

Also answered by the gap analysis: *track cloud agent PRs as read-only remote lanes?* Yes, in H3 (G11, file 10 §4.2).

### Still open

1. **Product name.** Is "Hive" final?
2. **Global hook installation.** Status for agents started *outside* GitHappens needs hooks in the user's global agent config. We make it opt-in with a diff preview and reversible markers (file 02 §6.4.4). Acceptable, or should we never touch global agent config?
3. **Committed repo config.** Allow `.githappens/hive.jsonc` (shared setup steps, copy globs, port env) with a trust prompt, or keep setup strictly local (git config) as today?
4. **"Allow for this session" scope.** We offer Allow once / Deny / Answer in terminal, plus a session-scoped exact-match allow rule that never applies to the destructive-command denylist (file 08 §6.3). Keep, or allow-once only?
5. **Headless fan-out.** Should fan-out lanes default to interactive pty runs (safer, visible) or headless runs (no TUI, cheaper to supervise)? Our default: pty.
6. **Concurrency default.** `hive.maxConcurrentRuns` = 4. Right number for typical laptops?
7. **Checkpoint cadence and retention.** Turn-boundary snapshots, max 50 per lane, kept 30 days after the lane is closed. OK, or opt-in only?
8. **Transcript retention.** We store pty logs and structured events locally for 14 days (redacted). Longer, shorter, or off by default?
9. **Licensing tier.** Free for local use? Gate fan-out/coordination behind any plan? (The reference does not clearly state a tier.)
10. **ACP chat surface.** The minimal ACP runner ships in H3 (G13). Is a native chat UI ever worth building, or do we stay terminal-first permanently?
11. **MCP server for agents (H5).** Expose a `githappens-hive` MCP server so agents can read their task brief and report progress? It widens the interface agents can call into the app.
12. **Container runner.** Should a devcontainer/Docker runner be on the roadmap (H6+) for real isolation? (It is also the precondition for ever offering a bypass preset.)
13. **Retention cap (G7).** Keep the 15 most recent closed lanes' worktrees (our default), or remove worktrees immediately on accept?
14. **Plan gate default (G8).** Off by default with per-template opt-in (our default), or on by default for fan-out tasks?
15. **Budget enforcement (G9).** Budgets only raise attention items (our default); should there be an optional hard stop?
16. **Agent commit signing.** Commits agents make in lanes are unsigned by default (we inject `commit.gpgsign=false` into agent processes, file 08 §6.4). Some teams require signed commits on every branch: keep the default, or inherit the user's signing setup?
17. **Native hook helper.** We specify a small Rust helper binary (fast, signed) with a Node fallback (file 02 §6.4.2). Accept adding a Rust toolchain to the build, or start with the Node fallback only?
18. **Codex "ask" mode (verify).** Our Codex default is `--sandbox read-only --ask-for-approval on-request` so every write asks; if Codex cannot prompt per write in that mode, should Codex lanes default to read-only (plan/review) unless the task opts in to auto-accept edits?


## Sources

All pages were read on **2026-10-12**. Sources for the broader market survey are listed separately in [00-landscape-and-gaps.md](00-landscape-and-gaps.md) §7. Facts were paraphrased; no text, screenshots or code were copied. Reference-vendor URLs are deliberately not reproduced here, per the naming rule in [`../README.md`](../README.md); they are kept in the research handoff notes for the owner.

Reference product (vendor URLs withheld):

- Desktop app release notes, "current" page covering 12.0.0 (2026-04-14) through 12.6.0 (undated, after 2026-09-15).
- Third-party mirror of the desktop 12.0.0 / 12.1.0 release notes (reseller changelog pages).
- Editor-extension help article on AI agents / agent sessions (last updated May 2026) and 17.x release notes (17.12, 2026-04-15, MCP registration for other agents).
- Vendor "agent management" feature page (undated, 2026).
- Vendor MCP getting-started page (last updated March 2026).
- Vendor standalone agent environment docs: overview and "Agent Sessions" page (August 2026 revision), product landing pages.

Agent CLIs and protocols:

- Claude Code hooks reference — https://code.claude.com/docs/en/hooks
- Claude Code CLI reference (`--settings`, `--session-id`, `--permission-mode`, `-p --output-format stream-json`, `--include-hook-events`, `claude agents --json`) — https://code.claude.com/docs/en/cli-reference
- Codex hooks — https://developers.openai.com/codex/hooks (redirects to https://learn.chatgpt.com/docs/hooks.md)
- Codex CLI command reference (`-c`, `--sandbox`, `--ask-for-approval`, `exec --json`, `exec resume`, `app-server`) — https://learn.chatgpt.com/docs/developer-commands?surface=cli
- Codex `notify` and TUI notifications (third-party guides, March–April 2026) — https://codex.danielvaughan.com/2026/04/10/codex-cli-agent-notifications-desktop-alerts-monitoring/
- Gemini CLI hooks — https://geminicli.com/docs/hooks/ and https://geminicli.com/docs/hooks/reference/ ; ACP mode — https://geminicli.com/docs/cli/acp-mode/
- GitHub Copilot CLI hooks reference — https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-hooks-reference and https://docs.github.com/en/copilot/reference/hooks-reference
- Cursor hooks — https://cursor.com/docs/hooks ; CLI output format — https://cursor.com/docs/cli/reference/output-format ; forum reports on CLI hook reliability (2026-08) — https://forum.cursor.com/t/cursor-agent-cli-never-invokes-hooks-json-on-linux-2026-08-11-same-version-works-on-macos/168326
- OpenCode ACP — https://opencode.ai/docs/acp ; server event names via third-party SDK — https://pkg.go.dev/github.com/justphantom/opencode-go-sdk-lite@v0.3.1
- Aider notifications — https://aider.chat/docs/usage/notifications.html
- Agent Client Protocol overview (protocol v1) — https://agentclientprotocol.com/protocol/overview

Comparable tools:

- Conductor scripts and environment variables — https://docs.conductor.build/core/scripts , https://conductor.build/docs/reference/environment-variables
- Vibe Kanban docs (monitoring, completing a task) — https://vibekanban.com/docs/core-features/monitoring-task-execution , https://vibekanban.com/docs/core-features/completing-a-task
- Landscape comparisons (vendor-authored, treated with caution) — https://agentsroom.dev/blog/best-multi-agent-coding-tools , https://superset.sh/compare/conductor-vs-crystal
- GitHub Agent HQ announcement (2025-10-28) — https://github.blog/news-insights/company-news/welcome-home-agents/ ; 2026 rollout coverage — https://www.i-programmer.info/news/105-artificial-intelligence/18651-github-adds-claude-and-codex-to-agent-hq.html
