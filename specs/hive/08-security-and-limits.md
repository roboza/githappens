# Hive 08 — Security Model, Permissions, Secrets, Limits & Audit

> Owns: Hive's threat model and security invariants; permission presets per adapter (decided 2026-10-12: ask by default, opt-in auto-accept of file edits per task/template, no bypass in v1); risk classification of permission requests and session-scoped allow rules; what Hive will never do; environment filtering and secret handling (SecretStore, redaction); commit identity/signing policy for agents (G2); trust of committed repo config; prompt-injection posture; resource limits (concurrency, runtime, idle, memory/CPU, disk, budgets — G7, G9); the audit log.

## 1. Purpose

Coding agents execute arbitrary commands with the user's privileges. Hive makes it *easier* to run more of them, for longer, with less attention per agent — which raises the stakes. Hive must therefore never be the component that widens what an agent may do, must keep GitHappens' own credentials out of reach, must make every approval an informed human decision, and must leave a record.

## 2. Reference behavior

- The reference desktop app surfaces agents' permission requests with Allow / Deny and a command preview; it does not document any auto-approval. It stopped reinstalling hooks after the user removed them and moved to installing status plugins only on explicit request.
- The vendor's separate agent environment offers allow once / for the session / always / reject and explicitly never approves on the user's behalf.
- Agent CLIs: Claude Code permission modes (`default`, `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions`) plus its own OS-level sandbox; Codex sandbox policies (`read-only`, `workspace-write`, `danger-full-access`) and approval policies; Codex hooks require hash-based trust; Copilot CLI policy hooks for administrators; ACP lets the client own file system and terminal access.
- Market anti-pattern: Vibe Kanban runs agents with permission bypass by default (file 00). GitHub Agent HQ emphasizes org-level policy and audit logs.

## 3. User stories

1. As a user I want agents to ask before risky actions, exactly as they would in my terminal, and Hive never to approve anything I didn't approve.
2. As a user I want to see, for each request, whether it touches anything outside the lane, and how risky Hive thinks it is.
3. As a user I want my GitHub/GitLab tokens, AI keys and SSH passphrases stored by GitHappens to be unreachable for agents.
4. As a user I want to give a specific agent an API key without putting it in my shell profile.
5. As a user I want a repo I just cloned to be unable to run commands via Hive config until I trust it.
6. As a user I want limits so that a runaway agent can't eat my CPU, disk or budget unnoticed.
7. As a security-minded user I want an audit trail of what Hive launched, approved and landed.

## 4. UI specification

- **Permission item** UI: file 04 §4.6 (risk badge, outside-worktree flag, full command, no single-key allow, high-risk requires click).
- **Preset selector** (New Task dialog, fan-out rows, template editor only — not in per-adapter settings): three presets with a one-line explanation and a shield icon: **Ask** (green, default), **Plan / read-only** (green), **Auto-accept file edits** (amber; "the agent may edit files inside this lane's worktree without asking; commands, network and anything outside the worktree still ask"). Choosing the amber preset shows the exact agent flags that will be passed. There is no bypass preset in v1.
- **Preferences → Agents → Security:** session allow rules (on), keyboard allow (on, never for high risk), agent signing (disable), env passthrough list, secret env per adapter (names; values write-only), redaction patterns, limits (§6.7), audit log viewer (filter by repo/kind/date; export JSONL).
- **Trust prompt** for committed repo config: file 03 §4.4.

## 5. Data model & IPC

```ts
export interface PermissionPreset {
  id: 'ask' | 'plan' | 'accept-edits';   // v1 set (decided 2026-10-12); 'bypass' is reserved for a future sandbox/container runner and not defined in v1
  label: string;
  level: 'safe' | 'elevated';
  args: string[];                       // adapter flags, e.g. ['--permission-mode','default']
  scope: 'task' | 'template';           // where it can be chosen; never a global or per-adapter default
}

export interface SessionAllowRule {     // our extension, in memory per session, never persisted
  sessionId: HiveId;
  tool: string;                         // exact tool name
  exact: string;                        // exact command text or exact file path
  createdAt: number; uses: number;
}

export type AuditKind =
  | 'run-start' | 'run-stop' | 'run-kill-limit' | 'permission-request' | 'permission-decision' | 'rule-created' | 'rule-applied'
  | 'preset-elevated' | 'integration-install' | 'integration-uninstall' | 'repo-config-trust' | 'setup-step'
  | 'secret-injected' | 'lane-create' | 'lane-discard' | 'accept' | 'accept-override' | 'push' | 'pr-create' | 'handoff'
  | 'checkpoint-restore' | 'bridge-mismatch' | 'fs-denied' | 'agent-push-detected' | 'budget-alert' | 'limit-hit' | 'internal';

export interface AuditEntry {
  ts: number; kind: AuditKind; profileId: string;
  repo?: string;                        // commonDir
  taskId?: HiveId; laneId?: HiveId; sessionId?: HiveId; runId?: HiveId;
  adapterId?: AdapterId;
  detail: Record<string, unknown>;      // redacted; never secret values; commands truncated to 4 KiB
  actor: 'user' | 'hive' | 'agent' | 'rule';
}
```

IPC: `hive:audit:list`, `hive:secrets:list|set`, `hive:repoConfig:trust` (file 01 §5.4).

## 6. Implementation details

### 6.1 Threat model

| Threat | Example | Mitigation |
|---|---|---|
| Agent does something destructive | `rm -rf ~`, `git push --force`, dropping a DB | Agent's own permission prompts stay on (default `ask` presets); Hive shows full commands and risk; no auto-approve; checkpoints; worktree isolation limits *accidental* cross-lane damage (not malicious) |
| Agent exfiltrates GitHappens secrets | reads provider tokens from IPC/env | Secrets never in agent env or renderer; askpass bridge vars stripped; SecretStore only in main (§6.4) |
| Agent forges status/approvals | calls the hook bridge to approve itself | Bridge only *receives* requests; decisions originate in the UI; per-run tokens; cwd binding; rate limits (file 02 §6.4.1) |
| Malicious repo config | committed `.githappens/hive.jsonc` runs `curl … | sh` on lane creation | Trust gate per content hash (§6.5) |
| Prompt injection from issues/PRs/CI logs | issue text says "run this script" | Framing as quoted data, redaction, and the user still approves every risky action (§6.9) |
| Runaway resource use | infinite loop, fork bomb, huge downloads | Concurrency/runtime/idle/memory/disk limits, kill tree (§6.7) |
| Global config tampering by Hive | silently editing `~/.claude/settings.json` | Opt-in, previewed, marked, backed up, reversible (file 02 §6.4.4) |
| Local attacker on the same machine talks to the bridge | another user | Socket/pipe permissions restricted to the current user; tokens |
| Supply chain of the helper binary | replaced helper | Shipped inside the signed app bundle; global integrations reference the absolute path inside the app; integrity hash checked on startup, "Repair" if changed |
| Key misuse | agent commits signed with the user's key | Agent signing disabled by default via env config (§6.4, file 06 §6.7) |

Hive is **not** a sandbox: an agent with shell access can read anything the user can. The UI says so in the Security page and next to the auto-accept-edits preset. Real isolation (containers/VMs) is a later runner (G21).

### 6.2 Permission presets (decided 2026-10-12)

**Decision:** every agent runs in its **ask** mode by default. A task (in the New Task dialog or per fan-out row) or a template may opt in to **auto-accept file edits** inside the lane worktree. **Full permission bypass is never offered** in v1; it can only be reconsidered once a sandbox/container runner exists (G21, future work), and even then only per task with explicit confirmation.

| Adapter | `ask` (default) | `plan` (read-only) | `accept-edits` (opt-in per task/template) |
|---|---|---|---|
| Claude Code | `--permission-mode default` | `--permission-mode plan` | `--permission-mode acceptEdits` |
| Codex | `--sandbox read-only --ask-for-approval on-request` (every write needs approval) *(verify: on-request in read-only prompts per write; if it cannot, Codex `ask` is shown as "edits need approval via sandbox escalation" with the same flags)* | `--sandbox read-only --ask-for-approval never` | `--sandbox workspace-write --ask-for-approval on-request` (edits inside the worktree allowed; commands needing more access still ask) |
| Copilot CLI | no allow flags | read-only tool allow-list (headless) | `--allow-tool` for its file-edit tools only *(verify tool names)* |
| Cursor CLI | no force flag | prompt-level plan only | not offered (no edits-only switch; *verify*) |
| Gemini CLI / OpenCode | defaults (agent asks) | ACP read-only mode where advertised, else prompt-level | agent's edits-only auto-approve mode where one exists *(verify)*, else not offered |
| Aider | default (asks to confirm) | prompt-level | not offered (Aider's only blanket switch, `--yes-always`, also approves non-edit prompts) |
| Custom | user's command as configured | prompt-level | not offered |

Codex note: in `workspace-write` Codex also runs shell commands inside its OS sandbox without asking (writes confined to the worktree, network off by default); only escalations ask. This is the closest Codex equivalent of "auto-accept edits", and the preset selector says so for Codex lanes.

Rules:

1. **Ask by default.** There is no global or per-adapter setting that changes the default preset; `accept-edits` is chosen per task (dialog, fan-out row) or set by a template's `defaults.preset`, and the dialog always shows it before start. Hive never changes a running session's mode to a more permissive one without a user action (the plan gate's switch from `plan` to the task's preset is such an action: the user approves the plan).
2. **Auto-accept file edits** covers only file edits **inside the lane worktree**. Shell commands, network access, MCP tools and anything outside the worktree keep asking. Adapters that cannot express "edits only" do not offer the preset (no fallback to broader modes). Choosing it records `preset-elevated` in the audit log.
3. **Never offered (v1):** Claude `bypassPermissions`, `dontAsk` and the classifier-based `auto` mode; Codex `--sandbox danger-full-access` (with any approval policy); `--yolo`, `--dangerously-skip-permissions`, `--dangerously-bypass-approvals-and-sandbox`, Cursor force flags, Copilot allow-all flags, Aider `--yes-always`, and equivalents. The adapter launch builder rejects these flags even when they appear in the user's `extraArgs` for a Hive run (the run fails with an explanation; the user can still run such agents in an ordinary terminal tab).
4. **Unattended runs** (headless, queued, fan-out) follow the task's preset and never escalate: with `ask`, Claude headless routes `PermissionRequest` to the attention queue (the run waits); Codex headless with `ask` runs `--sandbox read-only --ask-for-approval never` (useful for review/plan tasks only — write tasks need the `accept-edits` preset, which runs `--sandbox workspace-write --ask-for-approval never` headless: writes confined to the worktree, no escalation, never `danger-full-access`). Hive never uses `--permission-prompts none` for write-capable tasks.
5. `--dangerously-bypass-hook-trust` (Codex) and similar trust-skipping flags are never passed.
6. **Future (sandbox/container runner, G21):** a bypass preset may be specified then, scoped to runs inside that runner; it is not part of this spec's v1 contract.

### 6.3 Risk classification and session allow rules

Hive classifies each permission request (advisory; it never decides):

- **High:** commands matching the destructive denylist (`rm -r`/`rmdir /s`/`Remove-Item -Recurse` on paths outside the worktree or on `/`, `~`, drive roots; `git push --force`/`-f`/`--mirror`/`--delete`; `git reset --hard` outside the lane; `git clean -x`; `chmod -R 777`; `sudo`/`runas`; `curl|wget … | sh|bash|iex`; `dd of=`; `mkfs`; `format`; package publish (`npm publish`, `cargo publish`, `twine upload`); cloud CLIs with destructive verbs (`aws … delete`, `kubectl delete`, `terraform apply|destroy`); database drop statements); any path or cwd outside the lane worktree for write tools; reading known secret locations (`~/.ssh`, `~/.aws`, `~/.config/gh`, keychain CLIs, browser profiles); network uploads (`curl -T|--data @file`, `scp`, `rsync` to remotes).
- **Medium:** package installs/scripts (`npm|pnpm|yarn run/install`, `pip install`, `cargo run`), network access in general, `git push` (non-force), `git commit --no-verify`, writes to config dirs inside the worktree (`.github/workflows`, `.husky`, `.git/hooks` — the last always high).
- **Low:** reads and edits inside the worktree, tests/linters, `git status/diff/log/add/commit` in the lane.

Parsing uses a tokenizer for POSIX sh and PowerShell (`shell-quote`-style) with best-effort handling of `&&`, `;`, pipes and subshells; unparseable commands are at least **medium**. Rules are data (`resources/hive/risk-rules.json`), versioned and unit-tested.

**Session allow rules** (our extension, `hive.security.sessionAllowRules`, default on): "Allow for this session" creates an exact-match rule (same tool, byte-identical command or path) held in memory for that session only, never persisted, never written to the agent's own settings, never offered for high-risk requests, listed in the lane Info tab with Revoke. Applying a rule answers the hook with allow and writes `rule-applied` to the audit log; the attention item is shown as "allowed by your session rule" for 3 s.

**Scope enforcement** (opt-in, file 07 §6.6) denies write/edit tools outside scope via pre-tool hooks; it is a deny-only rule and never allows anything.

**What Hive will never do:**

- Approve a permission request without a user action (except an explicit, exact, session-scoped rule the user created).
- Offer or pass permission-bypass, blanket auto-approve or trust-bypass flags at all (v1), and never auto-accept anything beyond in-worktree file edits, and those only when the task or template opted in.
- Persist "always allow" decisions into an agent's own settings files.
- Give agents GitHappens' provider tokens, AI keys, cloud session, SSH/GPG passphrases or askpass access.
- Write instruction or hook files into the repository working tree.
- Push, open PRs, transition issues or post comments without an explicit user action.
- Run setup/teardown/run/check commands from a committed repo file without trust.
- Disable OS security features (Defender exclusions, Gatekeeper, SELinux) — at most it shows hints.

### 6.4 Environment, secrets and redaction

**Base environment for agent runs and lane steps** (built in main):

1. Start from the resolved login-shell environment (spec 02 §6.1) — agents need the user's normal PATH, proxies, language runtimes and their own auth (e.g. `ANTHROPIC_API_KEY` the user set in their profile remains, because it is the user's own configuration for that agent).
2. **Remove** variables GitHappens itself injects or owns: `GIT_ASKPASS`, `SSH_ASKPASS`, `SSH_ASKPASS_REQUIRE`, `GIT_TERMINAL_PROMPT` overrides, `GITHAPPENS_ASKPASS_*`, the specific internal `GH_*` variables GitHappens itself sets (an explicit list exported by the app's env module — **not** a `GH_*` wildcard, because the GitHub CLI's own `GH_TOKEN`/`GH_HOST` from the user's shell must keep working), Electron/Node internals (`ELECTRON_*`, `NODE_OPTIONS` set by the app, `ELECTRON_RUN_AS_NODE`), `GIT_INDEX_FILE`, `GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR` (so git in the agent resolves the lane worktree), and any variable whose name matches `hive.security.envDenylist` (default includes `*_TOKEN` variables that GitHappens itself set, but not ones from the user's shell).
3. **Add** Hive vars (file 02 §6.2 / file 03 §6.4.2), `GIT_CONFIG_COUNT`-based overrides for agent signing (`commit.gpgsign=false`, `tag.gpgsign=false` when `hive.commits.agentSigning = 'disable'`) — appended after any existing `GIT_CONFIG_COUNT` entries.
4. **Secret env per adapter**: values from SecretStore account `<profileId>/hive/<adapterId>/<ENV_NAME>` (new SecretStore kind; spec 13 §5.1 naming extension), resolved in main at spawn time, injected only into that adapter's processes, never logged (argv/env redaction), never returned over IPC (`hive:secrets:list` returns names and "set" flags only). Audit `secret-injected` records the name.

**Redaction** (applied to event logs, pty logs, audit details, prompt context from issues/PRs/CI, feedback prompts, toasts): regexes for common token formats (GitHub `gh[pousr]_…`, `github_pat_…`, GitLab `glpat-…`, Slack `xox[abpr]-…`, AWS `AKIA…`/secret pairs, Google `AIza…`, OpenAI/Anthropic-style `sk-…`/`sk-ant-…`, JWTs, private key blocks, `Authorization:` headers, URLs with userinfo), plus exact values of secrets Hive itself injected into that run. Replaced with `‹redacted:kind›`. Patterns are data and unit-tested; the user can add patterns.

### 6.5 Trust of committed repo config

- `trust.json`: `{ [commonDir]: { fileHash: string; decision: 'trust' | 'deny'; decidedAt: number; contentSnapshot: string } }`.
- Hash = sha256 of the file bytes at the moment of use (read from the main worktree; for lanes, from the lane base commit via `git show <base>:.githappens/hive.jsonc` so an agent editing the file inside its lane cannot change what runs for *new* lanes).
- Untrusted/changed → prompt with diff vs `contentSnapshot`; deny → repo steps skipped; local steps still run.
- Templates and instructions from the committed file are also gated (they influence prompts, not just commands).

### 6.6 Logs and retention

- `events.jsonl`, `pty.log`, `setup.log`, check logs: redacted at write time; retention `hive.retention.logsDays` (default 14) after the lane closes; `pty.log` ring-buffered to `hive.retention.ptyLogMaxMiB` (8).
- "Delete all Hive logs" button; deleting a profile deletes `hive/` (spec 13 rule).
- Logs never leave the machine (no telemetry; cloud features in file 10 are opt-in and exclude logs by default).

### 6.7 Resource limits and budgets (G7, G9)

| Limit | Setting | Default | Behavior |
|---|---|---|---|
| Concurrent live runs (all repos) | `hive.maxConcurrentRuns` | 4 | Extra starts are queued (FIFO, per-task priority); headless and pty count equally |
| Concurrent setups/checks per repo | `hive.setup.maxParallel` | 2 | Queue |
| Max run duration | `hive.limits.maxRunMinutes` | 240 | At 90 %: `limit` item; at 100 %: stop (graceful) unless the user extends (+60 min) |
| Idle run (no output, no signal) | `hive.limits.idleMinutes` | 60 | `limit` item; stop only if `needs-input` for > 24 h (prevents orphaned agents overnight) |
| Process memory (agent tree RSS) | `hive.limits.maxMemoryMiB` | 8192 | Sampled every 10 s (pidtree + pidusage); warn at 80 %, stop at 100 % after a 30 s grace and an item |
| CPU | — | — | Displayed only (no kill); runs started with lowered priority when `hive.limits.lowPriority` (default on for headless) |
| Disk free | `hive.limits.minFreeDiskGiB` | 5 | Block new lanes below threshold; warn running lanes; suggest cleanup (file 03 §6.8) |
| Lane disk usage | `hive.limits.maxLaneDiskGiB` | 20 | Warn only |
| Closed lanes with worktrees | `hive.retention.closedLanesKept` | 15 | Auto-clean beyond cap (file 03 §6.8) |
| Budget per task (cost/tokens/time) | task field | none | `budget` items at 80 %/100 %; **no automatic stop** unless `hive.budget.stopAt100` (off) |
| Daily spend alert (all repos) | `hive.budget.dailyUsd` | none | `budget` item when crossed |
| Hook bridge event rate | — | 50/s per run | Drop + notice |

Limits that stop a run always take a checkpoint first and are audited (`limit-hit`, `run-kill-limit`).

### 6.8 Audit log

- `hive/audit.jsonl`, append-only, one `AuditEntry` per line, fsync on each `permission-decision`, `accept*`, `preset-elevated`, `integration-*`, `repo-config-trust`; batched otherwise. Rotated monthly, kept 12 months (`hive.audit.retentionMonths`).
- Viewer in Preferences and per lane (Info tab "Audit").
- Export JSONL. No remote shipping (team audit later via file 10, opt-in).
- Tamper evidence *(our extension)*: each line carries `prevHash` (sha256 of the previous line) so truncation/edits are detectable by the viewer.

### 6.9 Prompt-injection posture

- External text (issues, PR bodies/comments, CI logs, web URLs in briefs) is framed as quoted data in prompts (file 05 §6.1) and redacted.
- Hive never lets content trigger actions on its own: no auto-start from new issues (automations deferred, G17), no auto-merge, no auto-push.
- Permission requests stemming from injected instructions still require the user's approval; the risk classifier flags typical exfiltration patterns (network uploads, secret paths) as high.
- Review template for others' PRs runs read-only.

### 6.10 Detecting agent actions outside Hive's control

- **Pushes:** during fetch or on `git:repo:changed` for remote-tracking refs, if a `refs/remotes/*/<lane branch>` appears or moves while the lane has a live run, record `agent-push-detected` and show a notice on the lane.
- **Writes outside the worktree:** via hook tool events with paths outside the lane (`fs-denied` for ACP, notice for hooks) — informational for pty agents.
- **Branch switches inside the lane:** file 03 §8.

## 7. Step-by-step implementation plan

1. Env builder (remove/add lists, `GIT_CONFIG_*` signing override, secret injection) with unit tests per OS.
2. Redaction library with corpus tests; wire into all log writers and prompt builders.
3. Permission presets per adapter (`ask`, `plan`, `accept-edits` where expressible); launch builder rejects bypass/blanket-approve flags including from `extraArgs`. Test: golden argv per adapter × preset; forbidden flags rejected; templates/tasks are the only way to select `accept-edits`.
4. Risk classifier (POSIX + PowerShell tokenizer, rules JSON). Test: rule corpus with expected levels, including obfuscation attempts (quotes, env indirection → medium at least).
5. Session allow rules (in memory, exact match, revoke, audit). Test: never for high risk; cleared on run end.
6. Trust store and repo config gating, including reading config from the lane base commit. Test: agent edits to the file inside a lane don't affect new lanes.
7. ResourceGovernor: queue, runtime/idle timers, memory sampling, disk checks, budgets. Test with fake agents and fake clocks.
8. Audit log with hash chain, viewer, export. Test: tamper detection.
9. Agent push detection and outside-worktree notices.

## 8. Edge cases

- **User's own shell exports secrets** (e.g. `GITHUB_TOKEN` in `.zshrc`): they reach agents as they would in the user's terminal; Hive does not strip user-owned variables (documented); the Security page lists "Variables from your shell that look like secrets: GITHUB_TOKEN" with an option to strip them for agents.
- **Agent asks for permission to run Hive's own helper** (shouldn't happen): classified high.
- **Clock skew in budgets:** time budgets use monotonic durations.
- **Memory sampling on Windows** for ConPTY trees: via `wmic`-free `Get-CimInstance Win32_Process` batch query every 10 s, or a native helper call; skipped if it takes > 1 s.
- **Disk full during lane creation:** git error surfaces as `worktree-failed`; partial worktree removed and pruned.
- **Audit log disk full:** writes fail → in-memory buffer + status bar warning; Hive refuses to start new runs until audit writes succeed *(fail closed for audit)*.

## 9. Acceptance criteria

- [ ] No Hive code path produces an "allow" without a user click/keystroke or an exact session rule the user created; verified by an e2e test that leaves a request unanswered until expiry (agent falls back to its own prompt).
- [ ] Every agent starts in its ask mode unless the task or template chose auto-accept file edits; that preset never covers commands or paths outside the worktree, and each use is audited.
- [ ] No bypass or blanket auto-approve flag can reach an agent launched by Hive, including via `extraArgs`.
- [ ] Agent processes never see `GIT_ASKPASS` pointing to GitHappens, nor any GitHappens-stored secret; secret env values configured per adapter appear only in that adapter's process.
- [ ] With `commit.gpgsign=true` globally, commits made by agents in lanes are unsigned by default.
- [ ] A committed `.githappens/hive.jsonc` never executes before trust; edits to it inside a lane don't affect new lanes.
- [ ] Runaway fake agents are stopped at the runtime and memory limits with a checkpoint taken first; budgets raise items at 80 %/100 %.
- [ ] Logs and audit entries contain no known token formats (redaction corpus test on generated logs).
- [ ] The audit log records run starts, permission decisions, overrides, integrations and landings, and tampering is detected.

## 10. Out of scope / later

- Container/VM runner for real isolation (G21), and any bypass preset scoped to it.
- Org policy (allowed agents, forbidden presets) pushed from a team backend (G24, file 10).
- Network egress control per lane.
- Hardware-key-backed signing flows for agent commits.

## 11. Cross-spec dependencies

- **Spec 13 §5.1:** SecretStore naming gains kind `hive/<adapterId>/<ENV_NAME>`; Security settings section.
- **Spec 02 §6.1 / §6.3:** login-shell env resolution; askpass bridge variables that must be stripped.
- **Spec 09 §6.6/6.7:** credentials and SSH stay with GitHappens' own git operations (push/PR from Hive go through spec 09 with askpass in main).
- **Spec 14 §6.8:** privacy rules for any later cloud/team features.
- **Files 02/03/05/06/07:** bridge security, trust prompts, redaction in prompts, signing policy, scope enforcement.
