# Hive 09 — Settings, Repo Config, Commands & Shortcuts

> Owns: the `hive.*` profile settings (registry entries for spec 13's `settingsRegistry`), the Preferences pages for Hive, the per-repo configuration surfaces (summary; storage defined in file 03 §5), the command registry entries and palette commands, default shortcuts (table in file 04 §4.10), and migration from the spec 12 §4.12 / spec 13 agent settings.

## 1. Purpose

One place listing every knob Hive adds, its default, scope and owner file, so the settings registry, JSON schema, Preferences UI and docs stay consistent.

## 2. Reference behavior

- The reference desktop app keeps agent options in Preferences: an "Agents" page (setup commands per repo; toggle for showing agent status in the graph WIP rows), an "External Tools" page (coding agent selection, custom CLI arguments, install/uninstall of per-agent status hooks/plugins), and a UI Customization option to hide the Agents toggle and to group worktree tabs.
- GitHappens' spec 13 currently has `tools.agentCommand`, `tools.agentArgs`, `ui.showAgentsToggle`, `ui.groupWorktreeTabs` and repo `agentSetupCommands`.

## 3. User stories

1. As a user I want sensible defaults so Hive works with zero configuration once an agent is installed.
2. As a user I want to find every Hive setting by searching "agent" or "hive" in Preferences.
3. As a user upgrading from the Agent Sessions view I want my agent command, args and setup commands carried over.
4. As a keyboard user I want every Hive action in the command palette.

## 4. UI specification

### 4.1 Preferences pages (spec 13 component tree)

```
Preferences
 ├─ (no setting hides the pinned Hive tab other than `hive.enabled`; it is pinned like Launchpad — decided 2026-10-12)
 ├─ … External Tools (row "Coding agent command/args" removed → link "Moved to Agents")
 ├─ Agents  (new; file 02 §4.1)
 │    General · Detected agents · Task templates · Signals & integrations · Security (file 08 §4) · Limits & budgets · Notifications · Retention
 ├─ UI Customization: "Show Hive toggle in left panel" (= hive.showLeftPanelToggle, alias ui.showAgentsToggle) · "Group worktree tabs"
 └─ Repo-specific → Hive (file 03 §4.3): worktree folder, branch prefix, default base, setup/teardown, copy/reuse, checks, ports, run command, instructions, committed-config trust
```

Every field shows its key on hover (spec 13 convention) and is searchable with keywords `agent`, `hive`, `worktree`, plus the adapter names.

### 4.2 Settings table (profile scope unless noted)

| Key | Type | Default | Meaning / owner |
|---|---|---|---|
| `hive.enabled` | boolean | `true` | Master switch. Off: no Hive service, toggle hidden, `agents:*` shim falls back to legacy behavior. |
| `hive.board.scopeFromRepo` | boolean | `true` | Opening the pinned Hive tab from a repo context (toolbar, shortcut, left panel, status bar) applies the "This repo" quick scope (file 04 §4.1). The tab itself is always pinned while `hive.enabled` (decided 2026-10-12). |
| `hive.showLeftPanelToggle` | boolean | `true` when an agent is detected, else `false` | Left-panel `List \| Hive` toggle. Alias read from `ui.showAgentsToggle` (file 04 §4.3). |
| `hive.defaultAdapter` | AdapterId | first detected in order claude-code, codex, gemini, copilot, cursor, opencode, aider | Default agent (file 02). |
| `hive.adapters.<id>.path` | path | detected | Executable override. |
| `hive.adapters.<id>.extraArgs` | string | `""` | Extra CLI args (shell-quoted string). |
| `hive.adapters.<id>.model` / `.effort` | string | adapter default | Passed via adapter flags. |
| `hive.adapters.<id>.runner` | `pty` \| `headless` \| `acp` | `pty` | Default runner. |
| `hive.adapters.<id>.envNames` | string[] | `[]` | Names of secret env vars (values in SecretStore). |
| `hive.customAdapters` | `CustomAdapterDef[]` | `[]` | File 02 §5.3. |
| `hive.maxConcurrentRuns` | number 1–16 | `4` | File 08 §6.7. |
| `hive.fanout.max` | number 2–8 | `4` | File 05 §4.3. |
| `hive.worktreeRoot` | path template | `{repoParent}/{repoName}.worktrees` | Default lane location; per-repo override in git config. |
| `hive.branchPrefix` | string | `hive/` | File 03 §6.1. |
| `hive.defaultBase` | enum | `default-branch` | `default-branch` \| `current-branch` \| `ask`. |
| `hive.lanes.initSubmodules` | boolean | `true` | File 03 §6.2. |
| `hive.lanes.removeAfterAccept` | boolean | `false` | Remove worktree immediately after accept (else retention cap applies). |
| `hive.setup.maxParallel` | number | `2` | Setup/check parallelism per repo. |
| `hive.ports.range` | `[number, number]` | `[41000, 48999]` | Port pool (file 03 §6.5). |
| `hive.ports.blockSize` | number | `10` | |
| `hive.signals.staleAfterMs` | number | `120000` | Hook silence before heuristic fallback (file 01 §6.3). |
| `hive.permissionTimeoutSec` | number 30–3600 | `300` | How long a permission request waits in Hive before the agent shows its own prompt. |
| `hive.security.sessionAllowRules` | boolean | `true` | File 08 §6.3. |
| `hive.security.keyboardAllow` | boolean | `true` | `Mod+Enter` allow (never for high risk). |
| `hive.security.envDenylist` | string[] | built-in list | File 08 §6.4. |
| `hive.security.redactionPatterns` | string[] | `[]` | Extra regexes. |
| `hive.commits.trailers` | boolean | `true` | `Agent:`/`Task:` trailers on Hive-created commits; commits are always authored by the user (decided 2026-10-12; G2, file 06 §6.7). |
| `hive.commits.agentSigning` | `disable` \| `inherit` | `disable` | Signing for commits agents make (file 08 §6.4). |
| `hive.landing.defaultMethod` | `merge` \| `squash` \| `rebase-ff` \| `ff` | `merge` | Accept default. |
| `hive.landing.defaultHistory` | `keep` \| `squash` \| `compose` | `keep` | |
| `hive.landing.requireChecks` | `required-only` \| `all` \| `off` | `required-only` | G5 guard: failing lane checks block Accept; explicit, audited "Accept anyway" override (decided 2026-10-12; file 06 §6.9). |
| `hive.landing.prDraft` | boolean | `true` | Create PRs as drafts. |
| `hive.landing.prFooter` | boolean | `true` | "Generated with … via GitHappens Hive" footer. |
| `hive.planGate.default` | boolean | `false` | Plan gate default for new tasks (G8). |
| `hive.prompt.maxChars` | number | `48000` | File 05 §6.1. |
| `hive.conflicts.maxPairs` | number | `45` | File 07 §6.1. |
| `hive.conflicts.showOverlaps` | boolean | `false` | Show clean overlaps in matrix/lens. |
| `hive.deps.autoStart` / `hive.deps.autoRestack` | boolean | `true` / `false` | File 07 §6.3. |
| `hive.checkpoints.maxPerLane` | number | `50` | File 06 §6.6. |
| `hive.graph.showLaneWipRows` | boolean | `true` | Spec 04 WIP rows show lane status (file 04 §4.8). |
| `hive.graph.lensDefault` | boolean | `false` | Open the graph with the Hive lens on. |
| `hive.notifications.permission` / `.question` / `.planReview` / `.error` / `.checks` / `.review` / `.conflict` / `.budget` | boolean | `true` except `.review` and `.conflict` `false` | OS notifications per kind (file 04 §4.7). |
| `hive.limits.maxRunMinutes` / `.idleMinutes` / `.maxMemoryMiB` / `.minFreeDiskGiB` / `.maxLaneDiskGiB` / `.lowPriority` | numbers / boolean | `240` / `60` / `8192` / `5` / `20` / `true` | File 08 §6.7. |
| `hive.budget.dailyUsd` / `hive.budget.stopAt100` | number \| null / boolean | `null` / `false` | G9. |
| `hive.pricing` | `Record<model, { inPerMTok, outPerMTok, cacheReadPerMTok? }>` | `{}` | Cost estimation table (file 01 §6.5a); empty = no estimates. |
| `hive.retention.closedLanesKept` / `.idleDays` / `.discardedDays` / `.logsDays` / `.ptyLogMaxMiB` | numbers | `15` / `14` / `30` / `14` / `8` | Files 03 §6.8, 08 §6.6. |
| `hive.audit.retentionMonths` | number | `12` | File 08 §6.8. |
| `hive.resumeOnStartup` | boolean | `false` | Offer to resume sessions after restart (file 01 §6.8). |
| `hive.mcp.enabled` (H5) | boolean | `false` | Hive MCP server for agents (file 02 §6.6). |

App-scope (`app.json`): none. Repo scope: git config keys in file 03 §5 plus the optional committed `.githappens/hive.jsonc` (schema `githappens://schemas/hive.json`, registered with Monaco like `settings.json`).

### 4.3 Commands (command registry, spec 01 `CommandDef`, category `Hive`)

| Command id | Title | Arg | When |
|---|---|---|---|
| `hive.openBoard` | Hive: Open board (this repo) — activates the pinned Hive tab scoped to the active repo | — | always (all repos when no repo tab is active) |
| `hive.openBoardAll` | Hive: Open board (all repos) — activates the pinned Hive tab with the saved scope | — | always |
| `hive.newTask` | Hive: New task… | text (prompt) | repo active |
| `hive.newTaskFromIssue` | Hive: Start agent on issue… | issue picker | integrations connected |
| `hive.fanOut` | Hive: Fan out task to several agents… | — | repo active |
| `hive.addressPrFeedback` | Hive: Address feedback on pull request… | PR picker | integrations |
| `hive.reviewPr` | Hive: Review pull request with agent… | PR picker | integrations |
| `hive.moveWipToLane` | Hive: Move my changes to a new lane | — | has WIP |
| `hive.toggleInbox` / `hive.nextAttention` | Hive: Show inbox (pinned tab, inbox rail focused) / Next item needing attention | — | always |
| `hive.attention.allow` / `.deny` / `.answerInTerminal` | Hive: Allow / Deny / Answer in terminal | — | focused permission item |
| `hive.lane.open` | Hive: Open lane… | lane picker | lanes exist |
| `hive.lane.focusTerminal` | Hive: Focus lane terminal | lane picker | lanes exist |
| `hive.lane.sendMessage` | Hive: Send message to agent… | lane picker + text | live session |
| `hive.lane.stop` / `.resume` | Hive: Stop / Resume agent | lane picker | |
| `hive.lane.runChecks` | Hive: Run checks | lane picker | checks defined |
| `hive.lane.sendFeedback` | Hive: Send review feedback | — | drafts exist |
| `hive.lane.accept` | Hive: Accept lane… | lane picker | review lanes |
| `hive.lane.createPr` | Hive: Create pull request from lane… | lane picker | |
| `hive.lane.tryInMain` / `.moveBack` | Hive: Try lane in main checkout / Move back | lane picker | |
| `hive.lane.discard` | Hive: Discard lane… | lane picker | |
| `hive.lane.checkpoint` | Hive: Create checkpoint | lane picker | |
| `hive.compare` | Hive: Compare lanes of task… | task picker | fan-out tasks |
| `hive.conflicts.show` | Hive: Show conflict matrix | — | ≥ 2 lanes |
| `hive.queue.run` | Hive: Land queue… | — | queue non-empty |
| `hive.graph.lens` | Hive: Toggle Hive lens in graph | — | graph visible |
| `hive.agents.detect` | Hive: Re-detect agents | — | always |
| `hive.agents.installIntegration` | Hive: Install status integration for… | adapter picker | |
| `hive.audit.open` | Hive: Open audit log | — | always |

Palette prefix: none (commands live in the main palette under category "Hive"); the lane picker supports fuzzy search over task title, branch and agent.

Context-menu entries contributed elsewhere: issues (spec 10/11), PRs (spec 10/11), graph branch/commit/WIP rows (spec 04), worktree rows (spec 09 left panel: "Start agent here", "Adopt into Hive"), repo tab ("Open in Hive" — pinned tab scoped to that repo).

## 5. Data model & IPC

Registry entries are `SettingDescriptor`s (spec 13 §5.2) with `section: 'Agents'` (or `'UI Customization'`), `keywords`, `min/max`. A `HiveSettings` type is derived from the registry:

```ts
export interface HiveSettings { enabled: boolean; showLeftPanelToggle: boolean; defaultAdapter: AdapterId; adapters: Record<string, AdapterConfig>; /* … one field per row in §4.2 … */ }
export interface AdapterConfig { path?: string; extraArgs: string; model?: string; effort?: string; runner: 'pty' | 'headless' | 'acp'; envNames: string[] }
// No permission-preset setting exists at profile or adapter level: presets are chosen per task or template (decided 2026-10-12, file 08 §6.2).
```

`HiveService` subscribes to `settings:changed` for `hive.*` keys; changes apply to new runs only (running sessions keep their launch config; the drawer shows "settings changed — restart session to apply").

## 6. Implementation details

### 6.1 Validation

Zod schemas generated from the registry (spec 13). Cross-field checks: `ports.range` width ≥ `blockSize × 4`; `fanout.max ≤ maxConcurrentRuns × 2`; `branchPrefix` passes `git check-ref-format --branch "<prefix>x"`; `worktreeRoot` template variables limited to `{repoParent}`, `{repoName}`, `{home}`.

### 6.2 Defaults by detection

On first Hive start: if exactly one agent is detected, it becomes `defaultAdapter`; `showLeftPanelToggle` turns on when any agent is detected (unless the user explicitly set `ui.showAgentsToggle` to false before).

### 6.3 Settings sync (spec 14)

`hive.*` settings are in the `preferences` sync category except: `hive.adapters.*.path` (machine-specific), `hive.worktreeRoot` (machine-specific), `hive.pricing` (synced), secrets (never; SecretStore). Repo git-config keys are never synced (they live in the repo).

### 6.4 Migration from Agent Sessions (spec 12 §4.12 / spec 13)

Run once per profile on first Hive start (`migrations/hive-001.ts`), recorded in `hive/index.json`:

| Old | New |
|---|---|
| `tools.agentCommand` + `tools.agentArgs` | If the command's basename matches a built-in adapter executable → `hive.defaultAdapter = <that>`, `hive.adapters.<id>.extraArgs = agentArgs`; else create `custom:legacy` with `command`/`args` and make it default. The old keys stay readable (deprecated, hidden) for one release. |
| `ui.showAgentsToggle` | `hive.showLeftPanelToggle` (alias kept). |
| git config `githappens.agentSetup` (per repo) | Unchanged storage; now shown as Hive setup steps (file 03 §5). |
| spec 13 `RepoSettings.agentSetupCommands` (if any repo JSON has it) | Migrated into git config `githappens.agentSetup` on first open of that repo; JSON field removed. |
| Agent Sessions per-pty "launched" state | Running agent tabs at upgrade time are adopted as lanes (file 01 §6.6). |
| Spec 12 IPC `agents:*` | Shim for one release (README §6). |

## 7. Step-by-step implementation plan

1. Add registry descriptors for all keys in §4.2; generate types and Zod schema. Test: registry ↔ type parity test.
2. Preferences "Agents" page skeleton with General/Security/Limits/Notifications/Retention sections. Test: component tests per section.
3. Repo-specific Hive section (file 03 §4.3) reading/writing git config. Test: round-trip of multi-value keys.
4. JSON schema for `.githappens/hive.jsonc` registered with Monaco. Test: validation errors shown.
5. Migration script with idempotency. Test: profiles with/without legacy keys.
6. Command registry entries + palette pickers. Test: every command id resolvable; `when` conditions.
7. Shortcut defaults merged into the keybinding table (spec 13). Test: no conflicts with spec 01/12 defaults (automated conflict check).

## 8. Edge cases

- **Adapter removed from disk** while set as default: board shows "Default agent not found — choose another"; tasks keep their stored adapter id.
- **Settings imported from another machine** with invalid paths: path overrides ignored with a warning; detection used.
- **Custom adapter id collision** with built-ins: rejected (`custom:` prefix enforced).
- **Repo with both git-config and committed config**: effective merge shown with origins (file 03 §5).

## 9. Acceptance criteria

- [ ] Every key in §4.2 appears in Preferences search and in the settings JSON schema.
- [ ] A profile that used `tools.agentCommand = "claude"` and `agentArgs = "--model opus"` migrates to `hive.defaultAdapter = claude-code` with those extra args; a custom command migrates to `custom:legacy`.
- [ ] All commands in §4.3 are in the palette with working pickers; default shortcuts do not conflict with spec 01/12 defaults.
- [ ] Changing a `hive.adapters.*` setting affects new runs only, with a visible notice on running sessions.

## 10. Out of scope / later

- Org-managed settings / policy (G24, file 10).
- Per-workspace (spec 11) Hive settings overrides.
- Settings for deferred features (automations G17, agent blame G4, container runner G21) — added with those features.

## 11. Cross-spec dependencies

- **Spec 13:** `settingsRegistry`, Preferences component tree (new "Agents" page; External Tools row moved), repo-specific sections, SecretStore kind `hive/…`, keybindings.
- **Spec 12:** `tools.agentCommand/agentArgs`, `ui.showAgentsToggle` deprecation; §4.12 superseded.
- **Spec 14:** settings sync categories.
- **Spec 01:** command registry and palette.
