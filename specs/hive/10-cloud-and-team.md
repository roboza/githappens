# Hive 10 — Remote Agent Lanes, Team Visibility & Cloud (later phases)

> Owns: **remote lanes** — read-only tracking of work done by cloud coding agents (GitHub Copilot coding agent, Codex cloud, Jules, Devin, Cursor cloud agents, and similar) through their pull requests (G11, **H3**); "continue locally"; team visibility of lanes via spec 14 (H6); org policy (G24, later); mobile/remote check-in (G23, later). Hive does **not** host or bill cloud agent execution (README non-goals).

## 1. Purpose

Users mix local agents with cloud agents that work in vendor sandboxes and deliver pull requests. Hive should show those next to local lanes — same board, same inbox, same review and landing tools — without running anything in the cloud itself. Later, teams want to see which areas agents (theirs and teammates') are touching to avoid collisions.

## 2. Reference behavior

- The reference products do not track cloud-agent PRs as sessions *(as far as public docs show)*; their Launchpad already lists PRs with review/CI status.
- GitHub Agent HQ / mission control assigns, steers and tracks Copilot and third-party cloud agents; the Copilot coding agent works from issues, opens a draft PR, and reacts to PR review comments mentioning it. VS Code's Agent Sessions view and Cursor's Agents Window list local, background and cloud sessions together. Codex cloud, Jules and Devin deliver PRs from their sandboxes and respond to PR feedback (file 00).
- Team features in GitHappens (spec 14) already include backend-free target-branch conflict prediction and optional team footprints.

## 3. User stories

1. As a user who assigned an issue to a cloud agent, I want its PR to appear as a lane on my Hive board with status (working, ready, checks failing).
2. As a user I want to review a remote lane with Hive's review tools (diff, comments, checks) and land it via the forge or locally.
3. As a user I want to send review feedback to the cloud agent through the PR (the way that agent listens), drafted by Hive and posted only when I confirm.
4. As a user I want to "continue locally": take the cloud agent's branch into a new local lane and continue with my local agent.
5. (H6) As a team lead I want to see teammates' active agent lanes and the paths they touch, and get warned about collisions.
6. (Later) As a team admin I want policy: allowed agents, forbidding the auto-accept-edits preset, required checks before landing.

## 4. UI specification

### 4.1 Remote lanes on the board

- A remote lane appears as a LaneRow with a cloud icon and the agent's name ("Copilot coding agent", "Codex cloud", "Jules", "Devin", "Cursor", or "Bot: <login>"), PR number, branch, `↑a ↓b`, checks rollup, review decision, last activity.
- Column mapping: PR draft and agent recently active → *Working*; agent asked a question (PR comment mentioning the user) or checks failing → *Needs you*; PR ready for review (not draft, checks done) → *Review*; merged/closed → *Done*.
- Tasks: a remote lane belongs to a task created automatically (`source: { kind: 'remote-lane' }`-linked) titled from the PR, or to an existing task when the PR links the task's issue (closing keywords / spec 10 issue links).
- Drawer tabs: **Changes** (file 06 review on the fetched PR head; comments become *PR review comments* on send), **Checks** (forge checks), **Activity** (PR timeline: commits, reviews, agent comments), **Info** (agent, PR, links to the vendor session page when the PR body contains one). No Terminal tab.
- Actions: Open PR · Open agent session ↗ (vendor URL if present) · Send feedback via PR… · Continue locally… · Accept (merge PR via spec 10 `pr:merge`, or local accept of the fetched branch) · Hide this remote lane.

### 4.2 Sources settings (Preferences → Agents → Remote agents)

```
Remote agents (pull requests authored by cloud agents)
[x] Show remote agent lanes on the Hive board       Repos: [All with connected providers ▾]
Recognized agents: author login / branch pattern                              Feedback mention
  Copilot coding agent   author: Copilot, copilot-swe-agent[bot] · branch: copilot/*     @copilot
  Codex cloud            author: chatgpt-codex-connector[bot] · branch: codex/*          @codex
  Jules                  author: google-labs-jules[bot] · branch: jules-*                 @jules
  Devin                  author: devin-ai-integration[bot] · branch: devin/*             @devin
  Cursor                 author: cursor[bot] · branch: cursor/*                          @cursor
  [+ Add pattern]   (all logins/patterns: verify at build time; user-editable)
```

### 4.3 Team view (H6)

A "Team lanes" section on the board (workspace scope, spec 11/14): teammates' active lanes (owner avatar, agent kind, branch, touched paths summary, last update), and team conflict hints in the matrix (file 07) as a separate "teammates" row — paths only, never contents.

## 5. Data model & IPC

```ts
export interface RemoteLaneInfo {
  agent: { key: string; displayName: string; login: string };   // key from recognizer table
  pr: { repo: RepoRef; number: number; webUrl: string; state: PrState; isDraft: boolean; headRef: string; headSha: Sha; baseRef: string; isCrossRepository: boolean };
  checks: PrRollupStatus;
  reviewDecision?: PullRequest['reviewDecision'];
  lastActivityAt: string;
  agentState: 'working' | 'waiting' | 'ready' | 'done' | 'unknown';   // derived (§6.2)
  sessionUrl?: string;                     // vendor session link parsed from the PR body/comments
  fetchedRef?: string;                     // refs/githappens/hive/remote/<laneId>/head after fetch
}

export interface RemoteAgentRecognizer { key: string; displayName: string; logins: string[]; branchGlobs: string[]; feedbackMention?: string }
```

Remote lanes are `HiveLane` with `ownership: 'remote'`, `worktreePath: ''` (none), `remote` set, `adapterId: 'custom:remote-<key>'` (display only). IPC: `hive:remote:list`, `hive:remote:continueLocally` (file 01 §5.4), plus `hive:remote:sendFeedback` (`{ laneId, commentIds, mention: boolean }` → posts a PR review via spec 10 `pr:review` after confirmation) and `hive:remote:fetch` (`{ laneId }` → fetches head into `fetchedRef`).

## 6. Implementation details

### 6.1 Discovery (H3)

- Data comes from spec 10's PR index / spec 11 Launchpad fetch (no extra polling): PRs in connected repos whose author login or head branch matches a recognizer. Refresh cadence follows Launchpad (spec 11 §6.5) plus on-demand refresh from the board.
- Each matching open PR (and those merged/closed in the last 7 days) maps to one remote lane; stable id = hash of `(provider host, repo, PR number)`.

### 6.2 Status derivation

| Signal (spec 10 data) | `agentState` |
|---|---|
| PR draft and (a commit or an agent timeline event in the last 15 min) | `working` |
| Agent comment that mentions the viewer or asks a question (heuristic: ends with `?` or contains "please confirm") since the viewer's last activity | `waiting` (→ `remote` attention item) |
| Not draft, or the agent's "finished/ready" timeline event, checks not pending | `ready` (→ Review) |
| Merged / closed | `done` |
| otherwise | `unknown` |

Checks failing → `checks` attention item with "Send failure to agent via PR" (posts a comment mentioning the agent, after confirmation).

### 6.3 Review, feedback and continue locally

- **Fetch for review:** same-repo PR: `git fetch <remote> refs/heads/<headRef>:refs/githappens/hive/remote/<laneId>/head`; fork PR: `git fetch <remote> refs/pull/<n>/head:refs/githappens/hive/remote/<laneId>/head` (GitHub; provider-specific refs per spec 10 `pr:checkout`). Review diff = `merge-base(baseRef, head)..head` (no worktree, no WIP).
- **Feedback:** draft comments made in the Changes tab become a PR review with line comments (`pr:review`, event `COMMENT`), optionally prefixed with the recognizer's mention so the cloud agent picks them up; always shown for confirmation; never automatic.
- **Continue locally:** creates a task (source `remote-lane`) and a local lane **from the PR head** with `landing: push-to-pr` (file 05 §6.3), so local agent work can be pushed back to the same PR (fast-forward). The remote lane is linked and shows "Continued locally in <lane>".
- **Accept:** default = merge on the forge via spec 10 `pr:merge` with allowed methods; alternative = local accept from the fetched ref (file 06 §6.3 with `L` = fetched head) then the user pushes.

### 6.4 Team visibility (H6, via spec 14)

- Opt-in per workspace (spec 14 `team:footprintsEnabled`); Hive publishes, per active lane: lane branch name (or a hash if `team.hideBranchNames`), agent kind, owner, changed **paths** (no contents), last update, and target branch. Retention follows spec 14 footprints (TTL 14 days).
- Team conflict hints reuse spec 14 §6.5 teammate overlaps, extended with lane granularity.
- Never shared: prompts, transcripts, logs, cost, permission decisions (unless an org explicitly enables audit export, below).

### 6.5 Org policy and audit export (later, G24)

Through spec 14 orgs: allowed adapters list, forbidden presets (e.g. `accept-edits`), required lane checks before accept, required trailers, disable global integrations. Enforced client-side in main (policy fetched and cached, signed by the backend); local overrides impossible while signed in to that org. Optional audit export of `AuditEntry` subsets (no commands, or redacted commands) to the org backend.

### 6.6 Mobile / remote check-in (later, G23)

Answering permission requests from a phone requires a relay; would be built on spec 14 cloud with end-to-end encryption and explicit per-device pairing; out of scope until spec 14's backend exists. Not before H6+.

### 6.7 Cloud runners (not planned)

Hive will not host agents. If ever added, a "remote host" runner would SSH into a user-owned machine and run the same adapters there (pty over SSH, hook bridge forwarded over the SSH connection); listed only as a later idea.

## 7. Step-by-step implementation plan

1. (H3) Recognizer table + settings UI; discovery from the spec 10 PR index. Test: `msw` fixtures with Copilot/Codex/Jules-style PRs and branch patterns.
2. (H3) Remote lane mapping, status derivation, attention items, board rendering. Test: state table.
3. (H3) Fetch-for-review (same repo and fork), review diff without worktree. Test: local bare remote + fork fixture.
4. (H3) Feedback via PR review with confirmation; mention prefix. Test: payload snapshot.
5. (H3) Continue locally (push-to-pr lane). Test: local lane pushes fast-forward to the PR branch.
6. (H3) Accept via `pr:merge` / local accept. Test: both paths.
7. (H6) Team footprints publishing/consumption; team conflict row. Test against the spec 14 dev backend.
8. (Later) Org policy enforcement; audit export.

## 8. Edge cases

- **Recognizer false positives** (a human branch named `copilot/x`): match requires author login **or** branch pattern + bot-type author; users can hide a remote lane permanently.
- **Agent login changes** at the vendor: patterns are user-editable and versioned in app updates.
- **PR from a fork we can't fetch** (deleted fork): review disabled; forge link only.
- **Same PR also linked to a local lane** (continued locally): one task, two lanes (remote + local), compare available.
- **Provider rate limits:** discovery piggybacks on Launchpad caching; no extra calls.
- **GitLab/Bitbucket/Azure** cloud agents: recognizers work on any provider in spec 10; built-in entries are GitHub-centric.

## 9. Acceptance criteria

- [ ] (H3) A PR authored by a recognized cloud agent appears as a remote lane with correct column and checks within one Launchpad refresh.
- [ ] (H3) Review comments on a remote lane are posted as a PR review only after confirmation, with the agent mention when enabled.
- [ ] (H3) "Continue locally" creates a local lane from the PR head and can push back fast-forward to the PR branch.
- [ ] (H3) Accept merges via the forge with allowed methods, or locally from the fetched ref.
- [ ] (H6) With footprints enabled, teammates' lanes appear with paths only; nothing else leaves the machine.

## 10. Out of scope / later

- Starting cloud agents from Hive (assigning issues to `@copilot` etc.) — later, via spec 10 issue assignment APIs, after H3.
- Hosting or billing cloud execution (non-goal).
- Mobile check-in (G23), org policy (G24) — later phases.
- Streaming cloud agent logs/transcripts (only links to vendor pages).

## 11. Cross-spec dependencies

- **Spec 10:** PR index, `pr:get/timeline/checks/review/comment/merge/checkout`, fork refs, issue links.
- **Spec 11:** Launchpad data and refresh cadence; Launchpad PR rows show "Agent lane" badge for recognized PRs.
- **Spec 14:** footprints, team view, orgs, privacy rules (§6.8), E2E for any relay.
- **Files 01/05/06:** remote lane entity, continue-locally intake, review/accept.
