# Hive 11 — Roadmap, Test Harness & Acceptance

> Owns: Hive's delivery phases H1–H6 and how they fit after the app roadmap (spec 15 §8); the deferred-feature schedule; the fake-agent test harness; unit/integration/e2e/perf strategy; cross-platform CI; release-level acceptance for Hive.

## 1. Purpose

Hive touches processes, ptys, sockets, git and third-party CLIs that change monthly. It can only stay reliable with a deterministic fake agent that speaks every signal dialect, fixture repos for every git path, and CI on all three OSes. This file sequences the work so each phase ships something useful and testable.

## 2. Reference behavior

Not applicable (process spec). The reference shipped its agent view incrementally over ~6 months (worktree cards + one agent's hook status first; more agents' status, permission handling, issue intake and graph integration later) — the same staircase as below.

## 3. User stories

1. As the team building Hive we want each phase to be releasable behind `hive.enabled`.
2. As a maintainer we want regressions in agent CLIs (changed hook payloads, flags) caught by fixture tests and a nightly real-agent smoke run, not by users.
3. As a Windows user I want the same quality as macOS (most competitors are macOS-only).

## 4. UI specification

Not applicable. (Feature flags are surfaced as `hive.enabled` and "Experimental" badges on H5 features in Preferences.)

## 5. Data model & IPC

Test-only additions:

```ts
// test/hive/fake-agent/scenario.ts
export interface FakeAgentScenario {
  name: string;
  dialect: 'claude' | 'codex' | 'gemini' | 'copilot' | 'cursor' | 'opencode' | 'aider' | 'generic' | 'acp';
  mode: 'pty' | 'headless' | 'acp';
  steps: FakeStep[];
}
export type FakeStep =
  | { do: 'print'; text: string; delayMs?: number }                       // TUI output (ANSI allowed)
  | { do: 'prompt'; text: string }                                        // prompt-like line, then wait for stdin line
  | { do: 'edit'; path: string; content: string } | { do: 'delete'; path: string } | { do: 'commit'; message: string }
  | { do: 'run'; argv: string[] }                                         // spawn a real command in cwd (e.g. git status)
  | { do: 'hook'; event: string; payload: object; expect?: 'allow' | 'deny' | 'none' }   // call the hook command like the real agent would
  | { do: 'osc'; text: string } | { do: 'bell' }
  | { do: 'stream'; json: object }                                        // headless JSONL line
  | { do: 'acp-update'; update: object } | { do: 'acp-permission'; toolCall: object; options: object[]; expect?: string }
  | { do: 'plan'; text: string } | { do: 'usage'; input: number; output: number; costUsd?: number }
  | { do: 'wait'; ms: number } | { do: 'waitInput' } | { do: 'exit'; code: number }
  | { do: 'cpuSpin'; ms: number } | { do: 'allocMiB'; n: number } | { do: 'hang' } | { do: 'push'; remote: string; branch: string };
```

## 6. Implementation details

### 6.1 Fake agent harness (`test/hive/fake-agent/`)

- A Node script (`fake-agent.mjs`, launched via the Electron binary with `ELECTRON_RUN_AS_NODE=1` in e2e and via plain Node in integration tests) plus thin launcher shims named like the real CLIs (`claude`, `codex`, `gemini`, `copilot`, `cursor-agent`, `opencode`, `aider` — `.cmd` shims on Windows) placed on a test PATH, so **adapter detection and launch argv are exercised unchanged**.
- The shim reads the scenario from `FAKE_AGENT_SCENARIO` (path) or picks one by the prompt text (`scenario:<name>`), validates the argv it received against the dialect's expected flags (e.g. Claude: `--session-id`, `--permission-mode`, `--plugin-dir`), and writes an argv/env report file so tests can assert the security env rules (no askpass vars, signing overrides present, secrets only for the right adapter).
- `hook` steps execute exactly what the real agent would: read the hook config from `--plugin-dir`/`--settings` (Claude), `-c notify` (Codex), `--notifications-command` (Aider), the global integration files (others), run the configured helper with the event JSON on stdin, and honor the helper's stdout decision (allow/deny/none) — so the **real helper binary and the bridge** are in the loop.
- Dialect fixtures: JSON payloads and stream lines recorded from real agent versions are checked into `test/hive/fixtures/<agent>/<version>/` and replayed by scenarios; a script `pnpm hive:record <agent>` (manual, not CI) captures new payloads from a locally installed agent using a recording helper.
- ACP mode: implements `initialize`, `session/new|load|prompt|cancel|set_mode`, emits `session/update`s, calls `session/request_permission`, and attempts `fs/write_text_file` outside the worktree in a "malicious" scenario (must be refused).

### 6.2 Test layers

| Layer | Tool | What |
|---|---|---|
| Pure core | Vitest + fast-check | `packages/hive-core`: lane/task/session reducers, status resolution, attention priority, prompt templates, risk classifier, redaction, scope globs, naming |
| Adapters | Vitest | `buildLaunch` golden argv per adapter × preset × runner × OS; signal parsers against recorded fixtures; permission response JSON |
| Bridge + helper | Vitest + real sockets/pipes | auth tokens, cwd binding, rate limits, fail-safe (server down → no output, exit 0), helper latency p95 |
| Git integration | Vitest + real git + fixture repos | lane create/discard/undo, snapshot determinism, accept matrix (file 06 §6.3), handoff, checkpoints, restack, merge queue, conflict matrix, dependency reuse fallbacks |
| Services | Vitest | HiveService with fake agents in real ptys: adoption, reconciliation after restart, limits, budgets |
| Components | Vitest + Testing Library | pinned-tab scope (all / repos / workspace / quick "This repo"), repo grouping, board column derivation, inbox keyboard rules, permission renderer (no single-key allow), drawer tabs |
| E2E | Playwright `_electron` | §6.3 scenarios on Windows, macOS, Linux |
| Visual | Playwright screenshots | board, inbox, Hive lens, compare view (light/dark) |
| Perf | bench scripts | §6.5 targets |
| Real-agent smoke | nightly, opt-in | §6.4 |

Fixture repos (spec 15 §7.2) gain: `hive-basic` (small JS project with `pnpm-lock.yaml`, tests, `.env.example`, AGENTS.md), `hive-conflicts` (base + scripted edits for overlapping lanes), `hive-committed-config` (with `.githappens/hive.jsonc`), `hive-submodules`, `hive-lfs`, `hive-bare-remote` pair for push/PR tests, and a large repo variant (100k files) for lane-creation timing.

### 6.3 E2E scenarios (each runs on all three OSes)

1. **First run:** fake `claude` on PATH → Agents page shows it as "Live"; left-panel toggle appears; pinned Hive tab present and not closable; `hive.openBoard` from a repo tab opens it scoped to that repo; New task → lane created on `hive/…` → agent starts → status `working` → `needs-permission` (hook) → Allow from inbox with `Mod+Enter` → `working` → `idle` with changes → Review column.
2. **Deny and answer-in-terminal:** deny with message reaches the agent; answer-in-terminal makes the fake agent print its own prompt; expiry path falls back without allowing.
3. **Feedback loop (G1):** comment on two lines → Send feedback → fake agent receives the exact prompt → edits → "Since last review" shows only the response.
4. **Checks guard (G5):** failing `test` check blocks Accept; override logged in audit; passing after agent fix enables Accept.
5. **Accept variants:** merge into checked-out clean `main`; squash into non-checked-out branch (CAS update-ref); conflict predicted → "Ask agent to resolve" → clean accept; Undo restores everything.
6. **Shaping & signing (G2):** global `commit.gpgsign=true` with a test GPG/SSH key → agent commits unsigned; squash with "sign" → signed; trailers present.
7. **Fan-out & compare:** 3 dialects (claude, codex, generic) on one task → compare view → take one file from lane B → accept lane A → others discarded → Undo discard restores lane C.
8. **Plan gate (G8):** Claude dialect plan mode → plan-review item → edit plan → approve → implementation continues; Codex dialect read-only → approve → resume writable; "prompt-only" dialect edits during planning → warning.
9. **Try in main (G6):** dirty main + dirty lane → to main → back → both WIPs intact; undo both directions.
10. **Coordination:** two lanes edit the same lines → conflict item ≤ 60 s → sequence (dependency) → queue lands A, restacks B with agent-resolve → B lands.
11. **Scope (G12):** overlapping scopes warned before start; out-of-scope edit flagged; enforcement denies Claude write outside scope.
12. **Issue & PR intake:** `msw` GitHub fixtures → Start agent on issue (branch name, prompt context, redaction) → Create PR (local bare remote + mocked API) → Address feedback imports threads → Push to PR fast-forward.
13. **Remote lane (G11):** fixture PR authored by `copilot-swe-agent[bot]` → remote lane in Working → becomes Review → Continue locally → push back.
14. **Security:** committed config untrusted → not executed; agent env lacks askpass/secrets; no bypass preset exists and bypass/blanket-approve flags in `extraArgs` are rejected; `accept-edits` flags appear only for tasks/templates that opted in; malicious ACP fs write refused; redaction of a planted token in logs.
15. **Limits & recovery:** runaway (`cpuSpin`, `allocMiB`) stopped at limits with checkpoint; app killed mid-run → restart → lanes reconciled, runs `lost`, resume offered.
16. **Windows specifics:** `.cmd` shim launch, named-pipe bridge, long path warning, process-tree kill, file-in-use removal retry.
17. **Disk (G7):** reuse rule → CoW clone on supported FS (macOS APFS runner; Linux Btrfs loop device; Windows ReFS/Dev Drive VHD where the runner allows), fallback elsewhere; retention cap cleans the 16th closed lane with undo toast.
18. **Migration:** profile with `tools.agentCommand`/`agentArgs` and `githappens.agentSetup` → Hive defaults and setup steps as expected; old Agents view usage works through the shim.
19. **Cross-repo board (pinned tab):** lanes in two repos → the pinned Hive tab shows both, grouped by repo; scope filter narrows to one; the repo with its tab closed still streams status and its permission request can be answered from the inbox rail; "Open repo" opens the tab.

### 6.4 Real-agent smoke tests (nightly, opt-in)

- A separate workflow with installed real CLIs (latest + previous minor) and test credentials from CI secrets (never logged; runners isolated); tiny prompts in a throwaway fixture ("create hello.txt with 'hi'"), budget-capped (`--max-budget-usd` where available), assert: detection, launch, status sequence from hooks/OSC/stream, one permission round-trip where the agent supports answerable hooks, usage parsed.
- Failures open an issue automatically with the recorded payload diff vs fixtures; adapters stay tolerant of unknown fields so users rarely see breakage.

### 6.5 Performance targets

| Metric | Target |
|---|---|
| Hook fire → board status update | p95 ≤ 500 ms (local), helper exec ≤ 10 ms native / ≤ 200 ms fallback |
| Global hook overhead when app closed | p95 ≤ 50 ms per hook |
| Lane creation (excluding setup) on 100k-file repo | ≤ 2 s (SSD) |
| Snapshot + review summary for a lane with 500 changed files | ≤ 1.5 s |
| Conflict matrix for 10 lanes (45 pairs, overlap prefilter) | ≤ 20 s time box, typical ≤ 5 s |
| Board with 50 lanes / 10 live runs | 60 fps scroll; card updates throttled 4 Hz |
| Memory overhead per live pty run in main | ≤ 15 MiB (excluding agent process) |

### 6.6 Phases

Hive phases follow the app roadmap's completed phases (spec 15 §8 Phases 0–6 and the later completion phases); each ends releasable behind `hive.enabled`.

| Phase | Scope | Exit criteria |
|---|---|---|
| **H1 — Lanes & live status** (≈4 weeks) | File 01 core (store, entities, IPC, reconciliation, adoption, `agents:*` shim); file 02 detection, PtyRunner, heuristics, OSC parser, hook bridge + native helper, Claude Code adapter (plugin-dir hooks, permissions), generic/custom adapter; file 03 lane create/setup/copy/ports/discard + undo, trust gate; file 04 left-panel Hive mode, lane drawer (Terminal/Activity/Info), inline Allow/Deny; file 05 prompt intake + split-button default; file 08 baseline (env filtering, redaction, presets, risk classifier, audit); file 09 settings + migration | E2E 1, 2, 14 (partial), 15, 16, 18 green on 3 OSes |
| **H2 — Review & land** (≈5 weeks) | Pinned Hive app tab: cross-repo board with repo filter, "This repo" quick scope and inbox rail, notifications/badges; Codex (OSC/notify/exec), Copilot, Gemini, Cursor, OpenCode, Aider adapters (pty + headless where verified); file 06 review, comments + feedback loop (G1), checks + guards (G5), accept (all cases) + undo, PR create/push-to-PR, shaping + trailers + signing policy (G2), compare, handoff (G6); plan gate (G8); usage/cost (G9); dependency reuse + retention + disk (G7); provenance capture (G4 data) | E2E 3–9, 17, 19 green |
| **H3 — Intake & ACP** (≈4 weeks) | Issue/PR/PR-thread/CI/Launchpad intake, templates manager, fan-out with queueing; minimal ACP runner (G13) for Gemini/OpenCode (+ verified bridges); remote lanes (G11); scope declarations + pre-start overlap warnings (G12) | E2E 7 (ACP variant), 12, 13, 11 (warnings) green |
| **H4 — Coordination** (≈4 weeks) | Conflict matrix + attention; dependencies (wait/stack) + restack; merge queue; shared instructions composer; checkpoints UI + restore; Hive lens in the graph (G3); scope enforcement opt-in | E2E 10, 11 green; lens visual snapshots |
| **H5 — Depth** (≈4 weeks) | Agent blame UI + git-notes export (G4, git-ai/Agent Trace compatible); Hive MCP server (opt-in); stacked lanes → stacked PRs (G10) if H4 queue landed early; pre-landing AI review pass (G14); rich notifications (G15); adopt agent-made worktrees (G16) | Feature-specific e2e |
| **H6 — Team & beyond** (scope-dependent) | Team footprints for lanes (spec 14), org policy (G24), audit export; candidates: automations (G17), best-of-N ranking assist (G18), semantic conflict check (G19), multi-repo tasks (G20), container runner (G21), session search (G22), mobile check-in (G23) | Decided per item |

Not planned (README non-goals): permission bypass by default, auto-landing winners, a native chat product, a custom branch model, A2A messaging (G25), hosting cloud agents, silent global config edits.

### 6.7 Release acceptance (Hive 1.0 = end of H4)

- [ ] All E2E scenarios 1–19 pass on Windows, macOS and Linux (x64; arm64 for macOS and Windows on a nightly cadence).
- [ ] No Hive path can approve a permission without a user action (security e2e + code review checklist).
- [ ] Every Hive git mutation is queued, journaled where specified, and undoable from the toolbar.
- [ ] Performance targets in §6.5 met on reference hardware.
- [ ] Adapter fixtures exist for the latest two minor versions of each built-in agent; nightly smoke green for 7 consecutive days before release.
- [ ] Docs: user guide for Hive, security page ("Hive is not a sandbox"), agent compatibility table with signal quality per agent and OS.
- [ ] Spec 12 §4.12, spec 13 agent settings and spec 15 Phase 5 item 5 updated to reference Hive (owner task).

## 7. Step-by-step implementation plan

1. Create `packages/hive-core` and the fake-agent harness skeleton (generic dialect) before any UI. Test: harness self-tests.
2. Add Claude and Codex dialects with recorded fixtures; wire into adapter unit tests.
3. Add fixture repos listed in §6.2 to `test/fixtures/make-*.ts`.
4. Enable the 3-OS e2e matrix for Hive scenarios (spec 15 CI), initially with scenario 1.
5. Grow scenarios per phase as listed in §6.6; nightly real-agent workflow from H2.
6. Perf benches from H2 (review/snapshot) and H4 (matrix, lens).

## 8. Edge cases

- **CI runners without CoW filesystems:** scenario 17 runs the fallback path and skips CoW with an explicit "skipped: no reflink FS" marker (not silently green).
- **Real-agent API outages** in nightly runs: retried once; repeated failures flagged as infra, not adapter regressions.
- **Pty timing flakiness:** fake agent uses explicit handshakes (`waitInput`) instead of sleeps; status assertions use eventual consistency with 5 s timeouts.
- **Windows Defender slowing fixture creation:** CI excludes the workspace dir on runners we control.

## 9. Acceptance criteria

- [ ] Fake agent covers every dialect and runner listed in file 02, including hooks through the real helper and bridge.
- [ ] The H1 exit scenarios pass on all three OSes before H2 work merges to main.
- [ ] A recorded-payload change in a new agent version produces a failing adapter fixture test or a tolerated-unknown-field log, never a crash.

## 10. Out of scope / later

- Load testing with dozens of real agents.
- Chaos testing of network filesystems.
- Automated security fuzzing of the bridge protocol (candidate for H5).

## 11. Cross-spec dependencies

- **Spec 15 §7–8:** test layers, fixture generator conventions, CI matrix (adds Hive scenarios and the nightly real-agent workflow), packaging of the native helper; Phase 5 item 5 replaced by Hive phases.
- **All Hive files:** each file's §7 steps map onto the phases above.
