# Hive — competitive landscape and gap analysis

> Status: research note, written 2026-10-12. Companion to [README.md](README.md) and Hive files 01–11. It looks at the agent-orchestration market as of October 2026, compares it with the Hive draft, and proposes additions. All tool descriptions are paraphrased. Vendor claims we could not check against a primary source are marked *(unverified)*. Pricing changes often and is given only as a rough guide.
>
> The reference desktop client and its sibling products are covered in README §8. They are not repeated here and are never named.

---

## 1. Summary — top 10 takeaways

1. **Parallel agents in worktrees became standard between October 2025 and April 2026.** Cursor 2.0 (Oct 2025), VS Code 1.107 background agents (Dec 2025), Windsurf Wave 13, the Codex app (Feb 2026), JetBrains Air (Mar 2026), Cursor 3 Agents Window (Apr 2026), Zed Parallel Agents (Apr 2026), the Claude Code desktop redesign (Apr 2026), the GitHub Copilot app (May–Jul 2026) and GitHub Desktop 3.6 (Jun 2026) all put one agent per git worktree. A worktree board alone no longer sets Hive apart. What can set it apart is what happens **after** the agent finishes.
2. **Two product camps have formed.** *Editor-centric* tools (VS Code, Cursor, Zed, JetBrains, Kiro, Antigravity) keep agents next to the code editor and treat git as plumbing. *Orchestrators* (Conductor, Superset, Nimbalyst, Air, Intent, the Codex app, the Copilot app, Vibe Kanban, Claude Squad) treat the agent as a worker and the workspace as a card. **No desktop Git client** has built real orchestration. Tower, Fork, SmartGit, Sublime Merge, Sourcetree and GitHub Desktop add worktrees and AI commit messages, nothing more. GitButler is the exception: it tries to *replace* worktrees with virtual/stacked branches fed by Claude Code hooks.
3. **The attention queue is the core UX everyone converges on.** Examples: Antigravity's Inbox, the Codex app's Triage/review queue, Agent HQ's "mission control", the VS Code Agent Sessions view with its unreviewed-change counts, crystl's single place for prompts, and Cursor's Agents Window. Hive's AttentionQueue is on target. It must be **cross-repo** and **keyboard-first** to beat these.
4. **Review is where the orchestrators are weakest.** Most offer a flat diff with "merge" or "open PR". Few offer commit shaping, stacked PRs, conflict prediction between lanes, undo of a landing, or line-level AI attribution. These are Git-client strengths, and Hive should lead with them.
5. **Conflict prediction between parallel agents is a new niche and an unsolved one.** In 2026 small single-purpose tools appeared: Clash, Braidkeep (git `merge-tree` prediction plus safe merge order), git-kura (path "seals"), conflict-check (LLM check for semantic clashes). A secondary write-up of a 2026 study of 33,596 agent PRs reports that 40% of repos had agent PRs overlapping in time *(unverified figure)*. Hive's spec 08 merge-tree based conflict matrix fits this need, and no editor ships it.
6. **The review comment → agent feedback loop is expected.** Vibe Kanban, Cline Kanban, the Codex review queue ("revise"), Copilot coding agent (PR comments become new work) and the reference vendor's "Address feedback" action all send reviewer comments back to the agent. Hive should treat it as P0.
7. **The best signal sources are hooks and ACP. Terminal scraping is the fallback.** Claude Code now has about 30 hook events, including `PermissionRequest`, `Notification` (idle/permission/elicitation), `Stop`, `WorktreeCreate`, and `TaskCreated`/`TaskCompleted`. Codex `exec --json` emits per-turn token usage. ACP (Zed + JetBrains, registry since Jan 2026, ~50 agents, adopted by Air and Microsoft's Intelligent Terminal) gives structured plans, tool calls and permission requests. The README's signal ladder (hooks > streams > heuristics) is right. **Plan the ACP runner earlier than H5.**
8. **AI-code attribution is becoming a standard.** Agent Trace (Cursor-led draft spec, Jan 2026, backed by Cognition, Jules, Amp, Vercel, Cloudflare, OpenCode, git-ai) and git-ai (authorship logs stored as `refs/notes/ai` git notes that survive rebase and squash) let you see "which lines did an agent write, in which session". That is a blame feature, and a Git client is the natural place to show it. Hive's draft does not have it.
9. **Cross-platform matters.** Conductor, Superset, Intent, crystl and (at launch) Air are macOS-only or macOS-first. Windows developers are poorly served outside editors. A first-class Windows experience (pty, hooks over named pipes, path length, Defender-friendly worktree placement) is a real differentiator for GitHappens.
10. **The market punishes thin wrappers.** Vibe Kanban's company shut down (Apr 2026), Crystal was deprecated (Feb 2026, folded into Nimbalyst), Opcode/Claudia went stale, and Terragon was reported "late" *(unverified)*. Standalone orchestrators without a deeper home are fragile. Hive should be a **Git feature that knows about agents**, not an agent chat app inside a Git client.

---

## 2. Tool landscape

Each entry covers: what it is · isolation · status/attention · review/merge · intake · multi-agent · notable UX · pricing. "Read" dates are in §7.

### 2.1 Editors and IDEs

**VS Code + GitHub Copilot (1.106 Oct 2025 → 1.107 Dec 2025 → 2026 releases).**
- *What:* Copilot agent mode in chat, an **Agent Sessions view** (1.106) and **Agent HQ** (1.107). Agent HQ unifies local, background and cloud agents, including third-party Claude and Codex sessions. A separate "Agents window" offers an agent-first surface (2026).
- *Isolation:* local (same workspace), background (current workspace **or a dedicated git worktree**), cloud (GitHub Actions-hosted Copilot cloud agent).
- *Status:* a sessions list with last-active time and a **count of unreviewed file changes**. Background sessions keep running after the chat is closed.
- *Review:* keep/undo per edit for local sessions. Cloud sessions produce a draft PR.
- *Intake:* chat prompt; "Continue in" moves a local chat to a background or cloud agent; issues via the cloud agent.
- *Multi-agent:* subagents, custom agents (`.agent.md`, org-level), MCP.
- *Notable:* the "unreviewed changes" counter is a cheap and useful attention signal.
- *Pricing:* Copilot plans with premium requests.

**Cursor (2.0 Oct 2025; 3.0 and 3.2 Apr 2026).**
- *What:* AI editor with an **Agents Window** that lists local, worktree, cloud and SSH agents in one sidebar.
- *Isolation:* local worktrees (up to 8 parallel). Cloud agents run in isolated VMs that clone from GitHub. 3.2 runs worktree work in the background by default, and one click brings a branch to the foreground.
- *Status:* sidebar per agent.
- *Review:* in-editor diff review; cloud agents open PRs; Bugbot does automated PR review.
- *Intake:* editor, Slack, Linear, GitHub.
- *Multi-agent:* **multi-model fan-out of one prompt with side-by-side compare** (2.0), `/multitask` async subagents (3.2).
- *Notable:* "move to foreground" handoff between background worktree and local checkout.
- *Pricing:* subscription with usage credits; cloud agents carry a model surcharge *(unverified)*.

**Windsurf / Cascade (Wave 13, Dec 2025 – early 2026).**
- *What:* AI IDE, now owned by Cognition.
- *Isolation:* Wave 13 added **git worktrees** for parallel Cascade sessions, multi-pane/multi-tab layouts, and a dedicated agent terminal (beta).
- *Status:* per pane.
- *Review:* in-editor.
- *Note:* reports say it is being rebranded and folded into Devin products *(unverified)*.
- *Pricing:* subscription with credits.

**Zed (Parallel Agents Apr 2026; 1.0 2026).**
- *What:* native editor with a **Threads Sidebar**. Threads are grouped by project and show title, status and agent. They are searchable and archivable.
- *Isolation:* per thread you choose whether to use a git worktree. Worktree threads group under their main repo, and Zed restores a worktree if it was deleted.
- *Agents:* built-in agent plus external agents over **ACP** (Claude, Codex, OpenCode, Cursor agent).
- *Review:* agent diff multibuffer.
- *Notable:* invented ACP (Aug 2025). A thread switcher with ctrl-tab.
- *Pricing:* free editor, paid hosted AI.

**JetBrains — AI Assistant / Junie / Air (Air public preview 2026-03-09; Junie CLI).**
- *What:* **Air** is a separate desktop app (built on Fleet) for delegating tasks to several agents at once. The IDEs host AI Assistant and Junie.
- *Isolation:* per task, choose local, **git worktree** or **Docker container**.
- *Agents:* Codex, Claude Agent, Gemini CLI, Copilot, Junie, plus anything that speaks ACP (JetBrains co-runs the **ACP Registry** with Zed, Jan 2026).
- *Status/review:* task list with per-task review. Detail is limited in sources.
- *Notable:* the IDE vendor split orchestration into its own app and kept editing in the IDE. That validates "orchestrator next to the editor", which is where a Git client sits.
- *Pricing:* Air free in preview, JetBrains AI subscription for cloud runs, Junie CLI $10–60/mo.

**Kiro (AWS; preview Jul 2025, GA late 2025/2026 — sources disagree).**
- *What:* Code-OSS based IDE built on **spec-driven development**: requirements → design → dependency-ordered tasks before any code. Also agent hooks (event-triggered background automations), steering files and MCP.
- *Isolation:* workspace. Some autonomous-agent cloud modes exist *(unverified)*.
- *Notable:* the plan is a reviewable artifact, and tasks execute in order.
- *Note:* positioned as the successor to Amazon Q Developer IDE plugins.
- *Pricing:* tiered credits.

**Google Antigravity (public preview Nov 2025).**
- *What:* agent-first IDE with a **Manager view** ("mission control") next to the editor.
- *Isolation:* workspaces per agent.
- *Status:* each agent shows status, its **Artifacts** (task lists, implementation plans, screenshots, browser recordings, test results) and pending approval requests. An Inbox collects them.
- *Review:* you comment on artifacts while work is in progress.
- *Notable:* "artifacts as proof of work" instead of raw transcripts.
- *Pricing:* free preview with rate limits.

**Visual Studio 2026 (April 2026 update).**
- *What:* Copilot agent mode. You can **start cloud agent sessions** from the agent picker; the cloud agent creates an issue and a PR on GitHub-hosted infrastructure.
- *Other:* user-level custom agents and a Debugger agent. Subagents "coming soon".
- *Isolation:* cloud for async work.
- *Pricing:* Copilot plans.

### 2.2 VS Code extensions

**Cline (Cline CLI 2.0 Feb 2026; Cline Kanban Mar 2026).**
- *What:* Cline Kanban is a browser board started from the terminal. Each card gets its **own worktree and terminal**.
- *Notable mechanics:* gitignored dependencies such as `node_modules` are **symlinked** from the main repo. The worktree is removed when the card goes to trash.
- *Review:* live diff next to the agent terminal, with **inline review comments**. "Commit" or "Open PR" asks the agent to turn its worktree into a clean commit or PR branch and resolve conflicts.
- *Coordination:* **card dependencies** (finishing one card starts the next).
- *Intake:* Linear import.
- *Agents:* Claude Code, Codex, Cline.
- *Pricing:* free, open source; you pay for models.

**Roo Code / Kilo Code.**
- *What:* open-source agent extensions (Kilo also runs in JetBrains and as a CLI).
- *Multi-agent:* **Orchestrator mode** (formerly "Boomerang tasks"). A parent task spawns subtasks in specialist modes (architect/code/debug) and receives only their summaries.
- *Isolation:* the editor workspace, with no worktrees by default.
- *Pricing:* free; BYO keys or a paid gateway.

**Continue.**
- *What:* open-source assistant, which in 2025–26 moved its focus to CI-run agents ("checks" on PRs).
- *Relevance:* AI checks run as PR status checks are a model for **pre-landing AI review** *(verify current product)*.
- *Pricing:* free core plus a hosted hub.

**Augment (Auggie; Intent public beta, early 2026).**
- *What:* **Intent** is a macOS desktop workspace. A **Coordinator** agent drafts a **living spec**, splits it into dependency-ordered tasks, and runs implementer agents in **parallel waves in isolated worktrees**. A **Verifier** then checks the result against the spec. Roles include Implement, Verify, Critique, Debug and Code Review.
- *Agents:* BYO Claude Code / Codex / OpenCode with fewer features than the native Auggie agent.
- *Fit:* Augment says it suits PR-sized changes of 3–15 files.
- *Pricing:* Augment subscription.

**Amazon Q Developer agent.**
- Being superseded by Kiro. Q IDE plugin paid support reportedly ends April 2027 *(unverified)*. No multi-agent story worth copying.

**Claude Code extension (VS Code / JetBrains) and Claude Code desktop.**
- *What:* the IDE extension shows Claude sessions with an inline diff. The **desktop app redesign (Apr 2026)** added automatic worktree isolation per session, multiple panes, diff review, and local plus remote sessions.
- *CLI:* `--worktree`, subagents, **agent teams** (experimental Feb 2026: a lead spawns teammates in separate worktrees that message each other).
- *Pricing:* Claude subscription or API.

**Codex extension and Codex app (app 2026-02-02 macOS, Windows 2026-03-04).**
- *What:* desktop "command center" with built-in **worktree threads** plus **cloud tasks** (isolated sandboxes).
- *Setup:* **local environments** with setup scripts kept in `.codex/`, which run when a worktree is created.
- *Handoff:* **Hand off** moves a thread between local checkout and worktree.
- *Cleanup:* keeps the 15 newest managed worktrees and auto-cleans on archive or disk pressure *(third-party)*.
- *Automations:* cron, webhook or manual triggers; worktree mode recommended for unattended runs.
- *Review:* a **review queue** with inline comments, then approve (commit/push/PR), revise (continue the thread) or reject. Runs with findings land in **Triage** as inbox items, and empty runs are auto-archived.
- *Cloud fan-out:* cloud tasks can produce several attempts per task *(from memory; verify)*.
- *Pricing:* ChatGPT plans.

**Multi-agent and worktree managers inside VS Code.** Several small extensions wrap `git worktree` plus a terminal per agent. None stands out, and the space is now covered natively by VS Code background agents.

### 2.3 Dedicated orchestrators

**Conductor (Melty Labs, macOS, Series A 2026).**
- *What:* desktop app. One **worktree workspace** per agent (Claude Code, Codex, Cursor agent), each with its own branch, terminal, diff, checks and PR flow.
- *Setup:* setup/run/archive scripts, a 10-port block per workspace, concurrent vs exclusive run mode (see README §8).
- *Status:* sidebar plus detail pane.
- *Intake:* prompt or issue.
- *Notable:* very fast "new workspace". Uses your existing Claude login.
- *Pricing:* free local; Pro ~$50/mo (cloud workspaces, multiplayer, API, mobile); Teams ~$60/user.

**Superset (macOS; Linux experimental; Windows unavailable).**
- *What:* source-available (ELv2) workspace for many CLI agents: Claude Code, Codex, OpenCode, Cursor Agent, Copilot, Gemini and more.
- *Isolation:* worktree per workspace.
- *Features:* port management, built-in diff and editor, open in an external IDE, in-app browser for dev servers, remote and cloud workspaces on your own machines, **scheduled unattended sessions**, iPhone/iPad app, its own CLI and MCP server.
- *Pricing:* free tier; Pro ~$20/seat/mo.

**Nimbalyst (formerly Crystal; MIT apps; macOS/Windows/Linux/iOS).**
- *What:* sessions on a **kanban board**, optional one-click worktree per session, tasks and files linked in one workspace.
- *Mobile:* iOS app to review diffs and resume sessions.
- *Agents:* Claude Code, Codex, OpenCode/Copilot (alpha).
- *History:* Crystal, an Electron app for parallel Claude/Codex sessions with diff and merge, was deprecated in Feb 2026 in its favour.
- *Pricing:* free for individuals; Teams $20/user/mo (free in beta).

**Claude Squad (Go TUI, AGPL).**
- *What:* tmux session plus worktree per agent (Claude Code, Codex, OpenCode, Amp, Aider).
- *UX:* tab between agents; pause/resume, which commits WIP and frees the worktree.
- *Review/merge:* left to the user.
- *Pricing:* free.

**Vibe Kanban (Bloop; Apache-2.0; company shut down 2026-04-10, community-maintained).**
- *What:* kanban of tasks and attempts with a worktree per attempt. Supports 10+ agents.
- *Review:* diff review with comments sent back to the agent; rebase/merge/PR from the diff header.
- *Caution:* runs agents with permission bypass by default (an anti-pattern; see README).
- *Status:* most-starred in the category but now unmaintained.

**Sculptor (Imbue, research preview, MIT).**
- *Isolation:* worktree, with an experimental **Docker container** backend.
- *Review:* changes reach your local environment only after you approve them, and **Pairing Mode** syncs an agent container with your local checkout.
- *Agents:* Claude Code and Imbue's harness.
- *Pricing:* free.

**Terragon.**
- Cloud orchestration of Claude Code agents in sandboxes, producing PRs. Reported in mid-2026 roundups as no longer operating *(unverified)*.

**uzi (Devflow, mid-2025).**
- CLI that runs N agents on the **same** prompt in worktrees plus tmux, with per-agent dev-server ports and checkpoint/merge commands. A best-of-N pioneer; quiet since v0.0.5 (Jun 2025).

**Container Use (Dagger, early development).**
- *What:* an **MCP server** that gives each agent a fresh container tied to a `container-use/<env>` git branch (worktree under the hood).
- *Review:* plain `git checkout`; a log of every command the agent ran.
- *Note:* conflicts are deferred to merge time. Free.

**OpenHands (All Hands; MIT).**
- *What:* open agent platform with a Docker sandbox. Self-hosted for free, or hosted cloud at ~$20/mo solo and $50/seat for teams.
- *Intake:* GitHub/GitLab issue resolver (label an issue → PR), Slack, Jira.
- *Other:* headless/CI mode.

**Devin (Cognition).**
- *What:* cloud agent with its own VM, editor, shell and browser.
- *Intake:* Slack, Linear, Jira, GitHub.
- *Review:* PRs, plus **Devin Review** of PRs.
- *Multi-agent:* parallel sessions.
- *Pricing:* ACU-based, with entry reportedly cut to ~$20/mo in April 2026 *(sources conflict)*.

**Factory (Droids).**
- *What:* cloud or local agents ("droids") with GitHub PR integration and multi-repo coordination.
- *Intake:* Slack, Linear, Jira.
- *Pricing:* ~$20–200/mo tiers *(sources conflict)*.

**GitHub Copilot coding agent and Agent HQ (coding agent GA Sep 2025; Agent HQ Oct 2025; Claude and Codex in Agent HQ early 2026).**
- *What:* assign an issue to Copilot, or mention `@Copilot` / `@Claude` / `@Codex`.
- *Isolation:* runs in GitHub Actions.
- *Output:* a **draft PR** with session logs, and it reacts to PR review comments.
- *Mission control:* assign, steer and track agents from github.com, VS Code, mobile and the CLI. The **same task can go to several agents to compare**.
- *Governance:* org-level Agent Control Plane (policy, audit).
- *Pricing:* premium requests on Copilot plans.

**GitHub Copilot app (Build 2026; all plans 2026-07-07; macOS/Windows/Linux).**
- *What:* native desktop client for agent sessions. **Every session runs in its own git worktree.** BYO model key without a subscription.
- *Note:* the closest direct competitor to Hive's desktop form factor, and it comes from the dominant forge.

**OpenAI Codex cloud tasks.**
- *What:* fire-and-forget tasks in cloud sandboxes from ChatGPT, the IDE extension, the app or GitHub `@codex`.
- *Output:* diff, terminal logs and citations; then a PR.
- *Other:* GitHub code review by Codex.

**Google Jules (GA Aug 2025; Jules Tools CLI and API Oct 2025).**
- *What:* async cloud VM agent. It plans with Gemini, asks for **plan approval**, runs tests and opens a PR.
- *Features:* memory, a stacked diff viewer, handling of PR review comments.
- *Integration:* CLI and API for scripting.
- *Future:* a successor ("Jules v2") was teased at I/O 2026 *(unverified)*.
- *Pricing:* free tier plus Google AI plans.

**Warp (ADE; Oz cloud orchestration Feb 2026; client open-sourced AGPL May 2026).**
- *What:* terminal-first. Local agents in the app, plus third-party CLI agents in tabs, with notifications when an agent needs input.
- *Oz:* runs hundreds of cloud agents and schedules recurring workflows. Since May 2026 it is a **multi-harness control plane** that manages Claude Code, Codex and the Warp agent, with per-agent least-privilege permissions, per-team credit caps and cross-harness memory (research preview).
- *Pricing:* credits.

**Amp (Sourcegraph spin-out).**
- *What:* CLI/editor agent built around **threads**. Threads can be shared (private / unlisted / workspace / group).
- *Features:* **Thread Map** (Dec 2025) visualizes how parallel threads relate. **Handoff** and thread mentions replaced fork (Jan 2026).
- *Pricing:* usage-based, with an ad-supported free tier *(verify)*.

**Others worth knowing.**
- *Mux* (AGPL): local, worktree or SSH workspaces.
- *Paneflow* (MIT): branch-aware panes.
- *crystl* (macOS): one approval and question surface across projects; a paid CLI lets agents read and drive each other.
- *Claude Code agent teams*: built-in.
- *Worktrunk / gwt*: worktree CLIs for agents.
- *Clash, Braidkeep, git-kura, conflict-check*: cross-agent conflict tools (§1, item 5).
- *git-ai*: AI authorship notes (§3).

### 2.4 Git GUIs with agent features

| Client | Agent-related features (2026) |
|---|---|
| **GitButler** | Virtual/parallel and stacked branches in one working directory. **Claude Code hooks** (`but claude pre-tool / post-tool / stop`) auto-sort concurrent agent edits into per-session branches and commit for the agent. Agents tab (0.16, Sep 2025) gives each branch its own assistant. The `but` CLI has JSON output so agents can split, move and squash commits and stack PRs themselves. Native GitHub stacked-PR support (nightly) and unlimited undo (oplog). The project argues worktrees are a poor fit for agents (disk use, sprawl). **The only Git client treating agents as first-class.** |
| **Tower** | Worktrees in the sidebar, AI commit messages (Tower 16 beta, Mar 2026). No agents. |
| **Fork** | Remote branch → worktree (2.68). Cursor added as an AI agent for commit messages (2.70, Sep 2026 *(third-party changelog)*). No orchestration. |
| **SmartGit** | 26.1 (May 2026) shows worktree clean/modified state in Branches and Graph, improves remove/prune, and adds "Ask AI" over commits. No orchestration. |
| **GitHub Desktop** | 3.6 (Jun 2026 *(secondary sources)*) adds worktrees, Copilot-SDK commit messages and AI conflict explanations. Agent sessions live in the separate **Copilot app**. |
| **Sublime Merge** | No AI or agent features. Forum requests for agent integration got pushback. |
| **Sourcetree** | Nothing found for 2026. |

**Reading:** apart from GitButler, Git clients have conceded agents to editors and orchestrators. The opening for GitHappens is to bring orchestrator-grade supervision **and** Git-client-grade landing together. GitButler shows the demand, but it requires adopting its branch model. Hive works on plain git worktrees in any repo.

---

## 3. Protocols and integration points

| Protocol / surface | What it gives an orchestrator | Status (Oct 2026) | Hive use |
|---|---|---|---|
| **Agent Client Protocol (ACP)** | JSON-RPC 2.0 over stdio. `initialize`, `session/new\|load\|prompt\|set_mode\|cancel`; `session/update` streams message/thought chunks, **tool calls**, **plans**, mode changes and compactions; `session/request_permission` (client answers); client-side `fs/*` and `terminal/*`; `elicitation/create`. One child process per agent with many sessions. Usage/cost is **not** in the core overview *(check extensions)*. | v1, created by Zed (Aug 2025). JetBrains co-maintains it, and the **ACP Registry** launched Jan 2026. Native in Gemini CLI (`--acp`) and OpenCode (`opencode acp`). Claude Code and Codex via adapters. Used by Zed, JetBrains IDEs, Air, and Microsoft Intelligent Terminal 0.1 (Jun 2026). ~50 agents. | Best structured source for status, plan, tool-call timeline and approvals. Build `AcpRunner` as a headless signal source first and a chat UI later (G13). |
| **Model Context Protocol (MCP)** | Tools and resources **for** the agent. Elicitation lets a server ask the user. | Universal. Governed by the Agentic AI Foundation (Linux Foundation). | Optional `githappens-hive` MCP server: read the task brief, report progress, request review, query lane conflicts (H5). Keep it read-mostly. |
| **Claude Code hooks** | ~30 events. Key ones: `SessionStart/End`, `UserPromptSubmit`, `PreToolUse`/`PermissionRequest` (allow/deny/ask/defer), `PostToolUse`, **`Notification`** (matchers `permission_prompt`, `idle_prompt`, `elicitation_dialog`, `agent_needs_input`), `Stop`/`StopFailure`, `SubagentStart/Stop`, `TaskCreated/Completed`, `TeammateIdle`, `WorktreeCreate/Remove`, `FileChanged`, `PreCompact`. Inputs include `session_id`, `transcript_path` and `cwd`. **HTTP hooks** (POST to a URL). `onFailure: "block"` (v2.1.295+). | Mature. | Primary status and approval source in H1. HTTP hooks can remove the need for a helper exe (point at the HookBridge loopback with a per-run token). `PostToolUse` on Edit/Write supplies attribution checkpoints (G4). `WorktreeCreate` lets Hive adopt agent-made worktrees (G16). |
| **Claude Code headless / Agent SDK** | `-p --output-format stream-json`, session resume, `--settings` injection, permission modes; SDK in TS/Python with in-process hooks and a permission callback; usage per result. | Mature. | Headless fan-out runs; cost capture (G9). |
| **Codex CLI** | `exec --json` JSONL: `thread.started`, `turn.started/completed/failed`, `item.*` (messages, reasoning, commands, **file changes**, MCP calls, **plan updates**), `error`. **`turn.completed.usage`** = input/cached/output/reasoning tokens. `exec resume <id>`. `--output-schema`. Sandbox `read-only\|workspace-write\|danger-full-access`. `app-server` (JSON-RPC used by IDEs). Hooks. TS SDK. | Mature. | Headless runner; token accounting; `--output-schema` for a structured "lane report" at the end of a run (G8). |
| **Gemini CLI** | `settings.json` hooks (`BeforeTool`, `AfterAgent`, `Notification`…), `--acp`, non-interactive JSON output. | Mature. | Prefer ACP. |
| **GitHub Copilot CLI** | Hooks in `.github/hooks/*.json` and `~/.copilot/hooks/` (`preToolUse`, `permissionRequest`…). Programmatic mode. | GA 2026. | Hooks adapter. |
| **A2A (Agent2Agent)** | Agent discovery (Agent Cards) and a task lifecycle between *agents* over HTTP/JSON-RPC/SSE; v1.0 with signed cards. | Linux Foundation; >150 orgs (Apr 2026); moved under the Agentic AI Foundation (Aug 2026). Rare in coding tools. | **Avoid for v1.** Relevant only if remote/cloud agents expose A2A endpoints (H6 watch item). |
| **Agent Trace** | JSON trace records linking file/line ranges to conversations and contributors (human/AI/mixed/unknown, model id), with optional content hashes. Storage is up to the implementer (files, git notes, DB). | 0.1.0-draft (Jan 2026). Backed by Cursor, Cognition, Jules, Amp, OpenCode, Vercel, Cloudflare, git-ai. ThoughtWorks Radar "Assess" (Apr 2026). | Emit and consume it for AI-line attribution (G4). |
| **git-ai** | Agents mark inserted hunks through checkpoints. On commit these become an authorship log in `refs/notes/ai` that survives rebase, squash, cherry-pick and amend. `git ai blame/stats`. | Open source, active 2026; HTTP notes backend for huge monorepos. | Read its notes if present; interoperate rather than reinvent (G4). |
| **Forge agent APIs** | GitHub: assign an issue to Copilot, `@claude`/`@codex` mentions, agent session logs, Agent Control Plane. Jules API. Codex cloud. Devin/Factory/OpenHands via APIs and webhooks. | GitHub's is the most important. | Track remote agent PRs as read-only "remote lanes" (G11). |

---

## 4. Comparison matrix

Key: **WT** = git worktree, **VB** = virtual branches, **Ctr** = container, **VM** = cloud VM/sandbox. "Attention" = a dedicated needs-you queue across sessions.

| Tool | Isolation | Status / attention | Review & land | Intake | Multi-agent | Pricing (rough) |
|---|---|---|---|---|---|---|
| VS Code + Copilot / Agent HQ | Local / WT / VM | Sessions view, unreviewed-change count | Keep/undo; draft PR (cloud) | Chat, issues, "Continue in" | Subagents, custom agents, third-party agents | Copilot plans |
| Cursor 2–3 | WT / VM / SSH | Agents Window | Editor diff; PR; Bugbot | Editor, Slack, Linear, GitHub | Multi-model fan-out + compare, `/multitask` | Sub + usage |
| Windsurf (Wave 13) | WT | Panes | Editor | Chat | Parallel sessions | Sub + credits |
| Zed | Optional WT per thread | Threads sidebar | Diff multibuffer | Chat | Mixed agents via ACP | Free + AI plan |
| JetBrains Air | Local / WT / Ctr | Task list | Per-task review | Prompt | Multi-agent, ACP | Preview free; AI sub |
| Kiro | Workspace | Task list from spec | Editor | Spec → tasks | Sequenced tasks, hooks | Credits |
| Antigravity | Workspaces | Manager + Inbox, artifacts | Comment on artifacts | Prompt | Parallel agents | Free preview |
| Visual Studio 2026 | Local / VM | Session list | Draft PR | Picker → issue+PR | Custom agents | Copilot plans |
| Cline Kanban | WT (+symlinked deps) | Board | Inline comments → agent; commit/PR via agent | Cards, Linear | Card dependencies | Free OSS |
| Roo / Kilo | Workspace | Task tree | Editor | Chat | Orchestrator subtasks | Free + BYO |
| Augment Intent | WT | Spec + task waves | Verifier agent | Spec | Coordinator/implementers/verifier | Sub |
| Claude Code (desktop/CLI) | WT optional | Panes; hooks | Diff | Prompt | Subagents, agent teams | Claude plans |
| Codex app + cloud | WT / VM | **Triage inbox + review queue** | Approve/revise/reject → PR | Prompt, automations, `@codex` | Parallel threads; cloud attempts | ChatGPT plans |
| Conductor | WT | Sidebar | Diff, checks, PR | Prompt, issue | Many Claude/Codex | Free / ~$50 Pro |
| Superset | WT (+remote) | Sidebar | Diff, editor | Prompt, schedules | Many CLI agents | Free / ~$20 |
| Nimbalyst | Optional WT | Kanban | Diff (+iOS) | Tasks | Claude/Codex/+ | Free / $20 teams |
| Claude Squad | WT + tmux | TUI list | Manual | Prompt | Many CLI agents | Free OSS |
| Vibe Kanban | WT | Kanban columns | Comments → agent; rebase/merge/PR | Cards | 10+ agents | Free OSS (unmaintained) |
| Sculptor | WT / Ctr | List; pairing | Approve before sync | Prompt | Parallel | Free |
| uzi | WT + tmux | CLI ls | Checkpoint/merge | Same prompt × N | **Best-of-N** | Free |
| Container Use | Ctr + branch | Log | `git checkout` | Agent-driven | Parallel envs | Free |
| OpenHands | Ctr / VM | Web UI | PR | Issues, Slack, Jira | Parallel | Free / $20+ |
| Devin | VM | Web/Slack | PR + Devin Review | Slack, Linear, Jira | Parallel sessions | ACU-based |
| Factory | VM / local | Web | PR | Slack, Linear, Jira | Multi-repo | Tiered |
| Copilot coding agent / Agent HQ | VM (Actions) | Mission control | Draft PR, reacts to comments | Issues, @mentions | Same task → several agents | Premium requests |
| GitHub Copilot app | WT | Session list | PR | Prompt, issues | Parallel sessions | Copilot / BYOK |
| Jules | VM | Web | Plan approval → PR | Prompt, CLI/API, labels | Parallel tasks | Free tier + plans |
| Warp + Oz | Local / VM | Notifications; Oz dashboard | PR | Prompt, schedules, API | Multi-harness, subagents | Credits |
| Amp | Local | Threads, Thread Map | Editor/CLI | Prompt | Subagents, handoff | Usage |
| **GitButler** | **VB** (one dir) | Agents tab per branch | Commit shaping, stacks, undo | Prompt | Hook-sorted parallel sessions | Free / paid tiers |
| Tower / Fork / SmartGit / GH Desktop | WT (manual) | — | Normal Git | — | — | Paid / free |
| **Hive (draft)** | **WT** (+ctr later) | Attention queue, board, graph badges | Merge/squash/rebase/PR via OperationQueue, undo journal, checkpoints | Prompt, issue, PR comment, Launchpad, graph | Fan-out + compare, deps, conflict matrix, merge queue | TBD |

---

## 5. Gap analysis

The Hive README already covers a lot: worktree lanes, signal ladder, attention queue, fan-out/compare, checkpoints, undo, conflict matrix, merge queue, shared instructions, intake from issues/PRs/Launchpad, setup steps and ports, security posture, and a remote-PR question. The gaps below are capabilities that are **missing**, **under-specified**, or **worth reconsidering**. "Covered → strengthen" means the README names the area but the list adds a concrete requirement.

Priority: **P0** = must ship in Hive v1 (H1–H4), **P1** = should ship in v1 if possible or first follow-up, **P2** = later / watch.

### P0

**G1. Review-comment → agent feedback loop.** *(Missing as an explicit flow.)*
- *What:* in the lane's Changes view, the user leaves inline comments on hunks, then sends them to the lane's agent as one structured prompt (file:line + comment + hunk). The same applies to comments on a lane's PR fetched from the forge, and to failed CI checks ("fix CI").
- *Who has it:* Vibe Kanban, Cline Kanban, Codex review queue ("revise"), Copilot coding agent (PR comments), Jules, the reference vendor's "Address feedback".
- *Why for a Git client:* review is our home ground, and without this loop review is a dead end.
- *Spec:* 06 (UI + payload), 02 (adapter `sendPrompt` for pty/headless/ACP), 05 (PR-comment/CI intake reuses it).

**G2. Commit hygiene before landing ("shape the lane").** *(Covered → strengthen.)*
- *What:* default landing turns agent WIP and checkpoint noise into reviewable history: squash-to-one, spec 12 `composeCommits` into logical commits, or keep the agent's commits. Add **agent trailers** on every lane commit: `Agent: claude-code`, `Agent-Session: <id>`, `Hive-Task: <id>`, and optionally `Co-authored-by:` with a configurable bot identity. Never sign with the user's key unless they ask. Lint conventional-commit style using spec 12 settings.
- *Who has it:* GitButler (agent commits sorted per branch and editable), Cline Kanban (agent produces a clean commit), the Codex review queue. Editors mostly do not.
- *Why:* agents produce messy history; a Git client is expected to fix it.
- *Spec:* 06; trailer/identity policy in 08 and 09.

**G3. Graph-level "Hive lens".** *(Covered → strengthen.)*
- *What:* beyond WIP badges, a graph filter that shows only the base plus all lane branches, with per-lane status chips, ahead/behind against the moving base, **conflict edges** between lanes (from the conflict matrix), fan-out siblings grouped, and dependency arrows. One click on a lane node opens the lane drawer.
- *Who has it:* nobody. SmartGit shows worktree state in its graph; GitButler shows stacks.
- *Why:* this is the most visible differentiator over editor-centric tools.
- *Spec:* 04 (UI), 07 (conflict and dependency data), spec 04 graph hooks.

**G5. Verification signals per lane.** *(Missing.)*
- *What:* a per-lane **Check** action that runs repo-defined commands (test/lint/typecheck/build) in the lane worktree, plus the lane PR's forge CI status. Results go on the card, in compare view and in landing guards ("checks failing — land anyway?"). Optionally a structured end-of-run **lane report** (summary, files touched, tests run, known gaps) through Codex `--output-schema`, Claude `Stop` `last_assistant_message`, or an MCP `report` tool.
- *Who has it:* Conductor (checks), Antigravity (test and screenshot artifacts), Codex cloud (logs), Intent (Verifier), Jules (runs tests).
- *Why:* git status alone cannot say whether a lane *works*, and compare without objective signals is guesswork.
- *Spec:* 06 (guards, compare columns), 03 (run in lane env), 05 (templates), 09 (`hive.checks` in repo config).

**G6. "Try it locally" handoff between lane and main checkout.** *(Missing.)*
- *What:* move a lane's state into the user's main worktree to run the app with full local setup, then move it back. Git forbids one branch in two worktrees, so offer: (a) detach the lane, check out its branch in main (stash main's WIP through spec 06 with an undo entry); (b) "open lane in editor/terminal" in place; (c) run the dev server in the lane with port block. Reverse handoff ("continue in a lane") turns the user's current WIP into a new lane.
- *Who has it:* Codex Hand off, Cursor "move to foreground", VS Code "Continue in".
- *Why:* agents finish, and humans still need to poke the result.
- *Spec:* 03 + 06; journal entries in spec 05.

**G7. Disk-cheap worktrees and retention caps.** *(Covered → strengthen.)*
- *What:*
  - Dependency reuse options per repo: symlink (Cline Kanban), copy-on-write clone (APFS `clonefile`, Btrfs/XFS reflink; on Windows ReFS/Dev Drive block cloning where available, otherwise copy), or run the setup step.
  - A **retention cap** (e.g. keep N most-recent closed lanes, as Codex does with 15).
  - A disk-usage readout per lane and in total.
  - Worktree root outside the repo by default. On Windows a short path to avoid MAX_PATH, plus an optional Defender exclusion *hint* (never set automatically).
- *Who has it:* Cline Kanban, Codex app, Conductor. GitButler's criticism of worktrees is about exactly this.
- *Spec:* 03, 08 (limits), 09.

**G8. Plan gate (optional).** *(Missing.)*
- *What:* a task template mode, "plan first". The agent is launched read-only, or with a planning prompt, to produce a plan. The plan shows as an attention item ("Approve plan / edit / reject"). On approval the same session continues with write permission. Use ACP `plan` updates, Claude plan mode, or Codex `plan` items where available; otherwise the plan is the agent's final message.
- *Who has it:* Jules (plan approval), Kiro (spec → tasks), Intent (living spec), Antigravity (implementation-plan artifact), Claude Code plan mode.
- *Why:* the cheapest place to stop a bad lane is before it writes code, and it pairs naturally with fan-out ("plan × 3, implement the best one").
- *Spec:* 05 (template), 04 (attention kind `plan-review`), 02 (adapter capability `planMode`).

### P1

**G4. AI line attribution and "agent blame".** *(Missing.)*
- *What:* record which hunks an agent wrote, in which session and with which model. Store as **git notes** compatible with git-ai (`refs/notes/ai`) and/or Agent Trace JSON. Inputs: Claude `PostToolUse` Edit/Write events, ACP tool-call diffs, Codex `file_change` items, falling back to "lane diff = agent" at checkpoints. Show in blame (spec 07 diff/blame) as an AI marker with session link, and in history ("% agent-authored"). Notes are rewritten on squash/rebase through the existing rewrite hooks. Push of notes is opt-in.
- *Who has it:* git-ai, Agent Trace supporters (Cursor, Cognition, Jules, Amp, OpenCode). No GUI Git client has it.
- *Why:* a Git client owns blame. Compliance and review teams increasingly ask "who wrote this". A strong differentiator.
- *Spec:* 06 (capture at checkpoint/land), new subsection in 01 (data), 10 (team sharing of notes); cross-ref spec 07.

**G9. Cost, token and time accounting.** *(Missing.)*
- *What:* per run, session, lane and task: wall time, active time, tokens (Codex `turn.completed.usage`, Claude stream-json `result` usage, ACP extensions if present), and estimated cost from a user-editable price table. Optional per-task budget that raises an attention item when exceeded, never a hard kill without asking. Fan-out compare shows cost next to the diff.
- *Who has it:* Warp Oz (credit caps), Devin (ACU), Cursor/Copilot (usage), Claude Code `/cost`.
- *Why:* fan-out multiplies spend. Users need to see it to trust N-way runs.
- *Spec:* 01 (fields), 02 (per-adapter extraction), 04 (card/compare), 08 (budgets).

**G10. Stacked lanes and stacked PRs.** *(Partially covered by dependencies.)*
- *What:* a lane can be based on another lane's branch. Landing produces a **PR stack** (each PR targeting its parent). When a parent changes, children restack through the merge queue. Integrate with spec 09/10 PR creation and native GitHub stacks where available.
- *Who has it:* GitButler (stacks + agents), Graphite-style workflows. Intent/Kiro sequence tasks but do not stack PRs.
- *Why:* big agent tasks broken into dependent steps are only reviewable as stacks; this plays directly to Git-client strengths.
- *Spec:* 07 (deps → stacks), 06 (land as stack).

**G11. Remote/cloud agent lanes (read-only first).** *(Open question 14 → answer: yes, H3.)*
- *What:* show Copilot coding agent, Codex cloud, Jules, Devin and Cursor cloud PRs as "remote lanes" next to local ones. Data: branch, PR, agent, status from forge checks/session links. Allow fetch → local review → land with the same tools. Optional "continue locally": fetch the branch into a new local lane with a local agent. Starting remote agents (assign issue to `@copilot`) is a P2 follow-up through the forge API.
- *Who has it:* Agent HQ mission control, VS Code Agent Sessions, Cursor Agents Window.
- *Why:* users mix local and cloud agents. Launchpad already knows these PRs, so the extra cost is low.
- *Spec:* 10 (§4.2), 05 (intake), 04.

**G12. Scope declarations and out-of-scope edit warnings.** *(Missing.)*
- *What:* a task may declare intended paths/globs ("owns `src/auth/**`"). Hive warns, via attention item and conflict matrix, when the lane edits outside scope or when two active lanes declare overlapping scopes *before* they start. Optionally a `PreToolUse` hook denies writes outside scope (opt-in, Claude/Copilot/Codex hooks).
- *Who has it:* git-kura (path seals), Braidkeep (file ownership).
- *Why:* prevention is cheaper than merge-tree detection after the fact.
- *Spec:* 07, 05 (field on the task), 08 (hook enforcement).

**G13. ACP earlier, as a signal runner.** *(Reconsider phasing.)*
- *What:* move a minimal `AcpRunner` (status, plan, tool-call timeline, permission requests answered from the attention queue) to **H2/H3** for agents that speak ACP natively (Gemini CLI, OpenCode) and via adapters (Claude, Codex). Keep the full chat UI in H5 or drop it.
- *Who has it:* Zed, JetBrains, Air, Intelligent Terminal, the reference vendor's agent environment.
- *Why:* ACP is now the cross-vendor standard (registry, ~50 agents). It reduces per-agent hook maintenance and gives structured plans for G8 and diffs for G4.
- *Spec:* 02, 11.

**G14. Pre-landing AI review pass.** *(Missing.)*
- *What:* optional "review this lane" before accept. Either a spec 12 AI-provider prompt over the lane diff (no agent needed), or a second agent in a **read-only review lane** (`codex review`, Claude in plan mode) whose findings appear as inline comments that can be fed back through G1.
- *Who has it:* Bugbot, Copilot code review, Codex review, Devin Review, Intent Critique/Code Review roles.
- *Spec:* 06, 05 (template "Review").

**G15. Notifications beyond the window.** *(Covered → strengthen.)*
- *What:* OS notifications with action buttons (Allow / Deny / Open), a taskbar/dock badge with the attention count, a tray icon menu listing waiting lanes, quiet hours, and per-kind sound. Mobile/remote check-in is P2.
- *Who has it:* Warp, Claude Code desktop, Conductor/Superset/Nimbalyst mobile apps.
- *Spec:* 04.

**G16. Adopt agent-created worktrees.** *(Missing.)*
- *What:* agents now create worktrees themselves (Claude `--worktree`, agent teams, Codex app, Cursor `/worktree`). Hive detects new linked worktrees (spec 02 watcher, Claude `WorktreeCreate` hook) and offers to adopt them as lanes with inferred base, instead of only listing them.
- *Spec:* 01 §6.6 (ad-hoc sessions), 03.

**G17. Automations / scheduled tasks.** *(Missing; P1-lite.)*
- *What:* a task template can run on a schedule or a trigger (new issue with label X, PR CI failed, nightly dependency bump) into a fresh lane with a strict permission preset. Runs with no changes auto-archive; runs with changes land in the attention queue as "ready for review".
- *Who has it:* Codex automations (cron/webhook), Warp Oz schedules, Superset scheduled sessions, Kiro hooks, OpenHands issue resolver.
- *Why:* recurring chores fit unattended runs. Only while GitHappens is running, and local only.
- *Spec:* 05, 08 (unattended posture: never bypass mode), 09.

### P2

- **G18. Best-of-N assist.** Ranking of fan-out lanes by objective signals: checks passed, diff size, files outside scope, cost, conflict count with other lanes. *No* automatic LLM judge choosing the winner. The human decides; an optional AI "compare summary" through spec 12. Has it: Cursor (auto-select best), uzi, Agent HQ. Spec: 06 compare view.
- **G19. Semantic conflict check.** An LLM pass over pairs of lane diffs for clashes git cannot see (renamed symbol still called elsewhere). Has it: conflict-check. Spec: 07, opt-in, uses the spec 12 provider.
- **G20. Multi-repo tasks.** One task spanning several repos, one lane per repo, landed together. Has it: Factory (linked repos), the reference vendor's agent environment. Spec: 01, 05; needs workspace support from spec 11.
- **G21. Container runner.** Devcontainer/Docker lane runtime for real isolation. Has it: Air, Sculptor, Container Use, OpenHands. Spec: 03/08 (H6). Keep the interface ready (`Runner` abstraction already exists).
- **G22. Session history and search.** Searchable archive of closed lanes with transcript excerpts, plan, report, cost and landing commit. "Why does this code exist?" from blame (G4) → session. Has it: Zed thread search, Amp Thread Map, Agent HQ logs. Spec: 01 retention, 04.
- **G23. Mobile/remote check-in.** Approve permission requests from a phone. Has it: Conductor, Superset, Nimbalyst, Claude remote, Agent HQ mobile. Depends on spec 14 cloud. Spec: 10.
- **G24. Team footprint and org policy.** Teammates' active lanes and touched paths; org rules such as allowed agents and forbidden bypass modes. Has it: Agent HQ control plane, Warp Oz permissions. Spec: 10.
- **G25. Agent-to-agent messaging and coordinator agents.** Has it: Claude agent teams, crystl, Intent coordinator. **Defer; possibly avoid.** It is the agents' own job, and Hive should only *show* subagent/teammate structure from hooks (`SubagentStart`, `TeammateIdle`, `TaskCreated`).

---

## 6. Recommendations for Hive scope

### Add to v1 (H1–H4)

1. **G1 feedback loop** and **G2 commit shaping with agent trailers**: the two biggest review gaps, both cheap given specs 06/12.
2. **G3 Hive lens in the graph**: the signature screen nobody else can build.
3. **G5 lane checks + forge CI status** as card badges and landing guards.
4. **G6 try-it-locally handoff**, built on the existing stash/undo journal.
5. **G7 disk hygiene**: dependency reuse strategy, retention cap, usage readout; Windows path care.
6. **G8 plan gate** as a template option (works with the terminal agent even without ACP).
7. **G9 cost/time accounting** in H2 alongside headless fan-out.
8. **G11 remote lanes (read-only)** in H3, reusing Launchpad data.
9. **G12 scope declarations** feeding the H4 conflict matrix.
10. **G13 minimal ACP runner** pulled forward to H3.

### Defer (H5+)

- **G4 attribution** (start capturing hunk provenance in H2 so data exists; ship blame UI in H5).
- G10 stacked PRs (H4 if the merge queue lands early, otherwise H5).
- G14 AI review pass, G15 rich notifications, G16 adoption, G17 automations.
- G18–G24 per §5.
- ACP **chat UI**: stay terminal-first. Only build it if ACP adoption keeps rising and users ask.

### Avoid

- **Permission bypass by default** and auto-approval (Vibe Kanban pattern). Keep the README's posture.
- **An LLM auto-judge that picks or lands a winner** with no human. Ranking assists only.
- **Hive as an agent or chat product** competing with Claude Code, Codex, Cursor or Copilot on agent quality. Wrappers die (Vibe Kanban, Crystal, Opcode).
- **Replacing worktrees with a custom branch model** (GitButler route): it fights plain git and our other specs. Answer the disk criticism with G7 instead.
- **A2A** and agent-to-agent orchestration in v1.
- **Cloud execution** that we host or bill. Track other vendors' cloud agents (G11) instead.
- **Silent edits to global agent config.** Keep opt-in, previewed and reversible.

### Positioning statement (for spec 00 / marketing)

"Editors run agents. GitHappens lands them." Hive works with any CLI agent on Windows, macOS and Linux. It shows every agent as a branch in the graph, predicts collisions before they happen, sends your review back to the agent, shapes the result into clean commits or stacked PRs, records which lines an agent wrote, and makes every landing undoable.

---

## 7. Sources

All pages read **2026-10-12** unless noted. Many are third-party or vendor-comparison pages; claims from them are hedged in the text. Reference-vendor sources are listed in README §Sources (URLs withheld per naming rule).

**Editors / IDEs**
- VS Code 1.106 release notes (Oct/Nov 2025) — https://code.visualstudio.com/updates/v1_106
- VS Code 1.107 coverage (Dec 2025) — https://ubuntuhandbook.org/index.php/2025/12/vs-code-1-107-released-isolated-background-agents-org-level-custom-agents/
- VS Code cloud agents docs — https://code.visualstudio.com/docs/agents/agent-types/cloud-agents ; agent sessions learn page — https://code.visualstudio.com/learn/foundations/agent-sessions-and-where-agents-run
- Cursor Agents Window worktrees forum thread (2026) — https://forum.cursor.com/t/worktrees-in-agents-window/158956
- Cursor 3.2 coverage (2026-04-24) — https://aicatchup.com/news/cursor-3-2-multitask-multi-root
- Cursor 2.0 parallel agents guide — https://medium.com/towards-data-engineering/parallel-ai-agents-in-cursor-2-0-a-practical-guide-e808f89cffb9 ; multi-model forum thread — https://forum.cursor.com/t/when-using-multiple-different-models-on-multi-model-mode-it-ended-up-repeating-the-same-model-multiple-times/146684
- Windsurf Wave 13 — https://devin.ai/blog/windsurf-wave-13 ; coverage (Dec 2025) — https://ascii.co.uk/news/article/news-20251226-ae3c8d8c/windsurf-wave-13-enables-parallel-multi-agent-coding-with-gi
- Zed Parallel Agents docs — https://zed.dev/docs/ai/parallel-agents ; blog — https://zed.dev/blog/parallel-agents
- JetBrains Air preview (2026-03-19) — https://adtmag.com/articles/2026/03/19/jetbrains-launches-air-preview-for-developers-managing-multiple-ai-agents.aspx ; Air write-up (2026-05-06) — https://recca0120.github.io/en/2026/05/06/jetbrains-air-agentic-ide/ ; Air + Junie CLI — https://devops.com/jetbrains-launches-air-and-junie-cli-to-blend-traditional-ide-with-ai-agents/
- Kiro reviews (2026) — https://pasqualepillitteri.it/en/news/6370/amazon-kiro-ide-spec-driven-review , https://noqta.tn/en/blog/kiro-aws-agentic-ide-spec-driven-development-guide-2026
- Antigravity overviews — https://www.altamira.ai/blog/antigravity-is-agent-first-coding-tool/ , https://www.gend.co/blog/google-antigravity , https://www.tooljunction.io/ai-tools/antigravity
- Visual Studio 2026 April update (2026-04-29/30) — https://github.blog/changelog/2026-04-30-github-copilot-in-visual-studio-april-update ; https://windowsreport.com/visual-studio-2026-april-update-focuses-on-cloud-agents-and-ai

**Extensions**
- Cline Kanban docs — https://docs.cline.bot/kanban/features ; launch coverage (Mar 2026) — https://www.testingcatalog.com/cline-debuts-kanban-for-local-parallel-cli-coding-agents/
- Kilo Code orchestrator — https://blog.kilo.ai/p/how-kilo-codes-orchestrator-mode
- Augment Intent — https://www.augmentcode.com/product/intent ; comparison — https://superset.sh/compare/superset-vs-augment-intent
- Codex app local environments — https://developers.openai.com/codex/app/local-environments ; automations/review queue (2026-04-08, upd. 2026-10-12) — https://codex.danielvaughan.com/2026/04/08/codex-desktop-automations/ ; worktree lifecycle (2026-04-11) — https://codex.danielvaughan.com/2026/04/11/codex-app-worktree-lifecycle-local-environments/
- Claude Code parallel/desktop/agent teams (third-party, 2026) — https://www.morphllm.com/claude-coding-agent , https://claudefa.st/blog/guide/development/worktree-guide

**Orchestrators**
- Roundup by Nimbalyst (2026-06-01, upd. 2026-07-29; vendor-authored) — https://nimbalyst.com/blog/best-agent-management-tools-2026/
- Roundup by crystl (2026-08-17; vendor-authored) — https://crystl.dev/blog/best-ai-agent-orchestration-tools/
- Conductor — https://www.conductor.build/compare/superset ; https://tooldirectory.ai/tools/conductor (reviewed 2026-08-28)
- Superset vs Vibe Kanban (vendor) — https://superset.sh/compare/superset-vs-vibe-kanban
- Multi-agent roundup — https://agentsroom.dev/it/blog/best-multi-agent-coding-tools
- uzi — https://www.mintlify.com/devflowinc/uzi/introduction ; https://pkg.go.dev/www.uzi.sh
- Container Use — https://container-use.com/introduction ; https://dagger.io/blog/agent-container-use
- Cloud agents comparisons (2026) — https://techsy.io/en/blog/background-coding-agents-compared ; https://ssojet.com/blog/best-cloud-coding-agents ; https://aiagentrank.io/compare/devin-vs-openhands
- GitHub Agent HQ / Claude + Codex (2026) — https://www.i-programmer.info/news/105-artificial-intelligence/18651-github-adds-claude-and-codex-to-agent-hq.html ; https://thenewstack.io/github-agent-hq/ ; https://codex.danielvaughan.com/2026/04/16/codex-as-github-coding-agent-agent-hq-model-selection-cloud-review/
- GitHub Copilot app (Build 2026; all plans 2026-07-07) — https://www.thurrott.com/dev/336962/build-2026-microsoft-announces-github-copilot-app ; https://news.ainauten.com/en/story/github-oeffnet-die-copilot-app-fuer-alle-tarife
- Jules — https://www.morphllm.com/comparisons/jules-google-coding-agent ; https://codex.danielvaughan.com/2026/05/19/google-jules-vs-codex-cli-async-fire-and-forget-interactive-terminal-agent-comparison/
- Codex 2026 overview — https://blog.laozhang.ai/en/posts/openai-codex-march-2026
- Warp Oz (2026-02-10) — https://warp.dev/newsroom/2026/2/10/warp-launches-oz-the-orchestration-platform-for-cloud-coding-agents ; Oz update — https://sdtimes.com/ai/warp-updates-oz-to-help-enterprises-orchestrate-coding-agents-across-any-model-or-harness/
- Amp — https://tessl.io/blog/amp-launches-thread-map-to-help-navigate-ai-coding-agent-work/ ; https://releasebot.io/updates/ampcode
- Conflict tools — https://codex.danielvaughan.com/2026/04/25/codex-cli-merge-conflict-prevention-resolution-worktrees-clash/ ; agent PR conflict study summary (2026-07-28) — https://codex.danielvaughan.com/2026/07/28/agent-pr-merge-conflicts-concurrent-coding-agents-codex-cli-worktree-isolation-coordination-defence/ ; https://pkg.go.dev/github.com/tooppoo/git-kura ; https://hunted.space/product/braidkeep

**Git clients**
- GitButler Claude Code hooks — https://docs.gitbutler.com/features/ai-integration/claude-code-hooks ; blog (Jul 2025) — https://blog.gitbutler.com/automate-your-ai-workflows-with-claude-code-hooks ; repo README mirror (2026) — https://upd.dev/gitbutlerapp/gitbutler
- Tower 16 beta (Mar 2026) — https://alternativeto.net/news/2026/3/tower-16-beta-for-mac-adds-ai-commits-new-working-copy-view-and-performance-upgrades ; Tower AI docs — https://www.git-tower.com/docs/ai/
- SmartGit 26.1 (2026-05-18) — https://blog.syntevo.com/smartgit/2026/05/18/smartgit-26-1-released.html
- Fork changelog (third-party) — https://softantenna.com/softwares/7462-fork
- GitHub Desktop 3.6 (2026-06-26, secondary) — https://kingy.ai/ai-launch-tracker/github-desktop-3-6-copilot-integration-2026-06-26/
- Sublime Merge downloads/forum — https://www.sublimemerge.com/download ; https://forum.sublimetext.com/t/allow-agents-to-post-comments-to-sublime-merge/78791
- Worktree tools roundup (2026) — https://nimbalyst.com/blog/best-git-worktree-tools-ai-coding-2026/

**Protocols**
- ACP overview — https://agentclientprotocol.com/protocol/overview ; ACP Registry (Jan 2026) — https://blog.jetbrains.com/ai/2026/01/acp-agent-registry/ ; ACP in Microsoft Intelligent Terminal (2026-06-10) — https://codex.danielvaughan.com/2026/06/10/agent-client-protocol-microsoft-intelligent-terminal-codex-cli-multi-agent-ide-ecosystem/
- Claude Code hooks reference — https://code.claude.com/docs/en/hooks
- Codex non-interactive mode — https://learn.chatgpt.com/docs/non-interactive-mode (redirected from developers.openai.com/codex/noninteractive)
- A2A at 150+ orgs (2026-04-09) — https://linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year
- Agent Trace — https://agent-trace.dev/ ; Cognition post (2026-01-29) — https://cognition.ai/blog/agent-trace ; InfoQ (Feb 2026) — https://www.infoq.com/news/2026/02/agent-trace-cursor ; ThoughtWorks Radar — https://www.thoughtworks.com/radar/platforms/agent-trace
- git-ai — https://usegitai.com/docs/how-git-ai-works ; changelog — https://usegitai.com/changelog
