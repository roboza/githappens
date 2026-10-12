# Hive 02 — Agent Adapters, Runners & Status Signals

> Owns: the `AgentAdapter` contract, built-in adapters, agent detection, launch argv/env construction, runners (`pty`, `headless`, `acp`), signal sources (hooks, structured streams, terminal escape sequences, heuristics), the hook bridge and its helper executable, opt-in global integrations, ACP client and the optional Hive MCP server.

## 1. Purpose

Every agent CLI is different: how it is installed, how it takes a prompt, how it reports "I'm waiting for you", whether it can resume, how it asks for permission. Adapters hide that so that the rest of Hive deals in one vocabulary (sessions, runs, signals, permission requests). Getting status right is the single most important quality of Hive: a board that says "working" while an agent has been waiting for approval for ten minutes is worse than no board.

## 2. Reference behavior

- The reference desktop app auto-detects installed agents (Claude Code, Codex CLI, OpenCode, Copilot CLI, Gemini CLI; later Cursor CLI when `cursor-agent` is installed) and lets the user add custom CLI arguments. In WSL setups, a Windows-installed agent could shadow the Linux one (a known issue it documented).
- Live status began with Claude Code using hooks the app installs into Claude Code's configuration; the app later stopped reinstalling hooks the user removed, and since 12.6 installs per-agent status "plugins" (Claude Code, OpenCode, Codex, Copilot CLI) only when asked, from an External Tools page and a plug icon in the Agents panel that shows how many detected agents can report live status. Without a plugin, status is coarse.
- Permission requests (Claude Code first, then Codex and Copilot CLI) appear in the panel with Allow / Deny and a command preview; for Copilot CLI, dismissing hands the decision back to the CLI's own prompt.
- The vendor's separate agent environment runs agents either as rich chat over **ACP** or as the agent's own CLI in a wrapped terminal, uses agent hooks for status and to discover sessions started elsewhere, routes terminal-mode approvals through hooks, and states that it never approves on the user's behalf.
- The reference editor extension supports Claude Code via extension-managed hooks with explicit install/uninstall commands.

What the agent CLIs offer (2026, see README Sources; all *(verify)* at build time):

| Agent | Hooks (blocking permission?) | Per-run injection without touching user files | Structured mode | Resume | Notes |
|---|---|---|---|---|---|
| Claude Code | Rich: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest` (allow/deny via `decision.behavior`), `PostToolUse`, `Notification` (`permission_prompt`, `idle_prompt`, `agent_needs_input`, `agent_completed`, …), `Stop`, `StopFailure`, `SubagentStart/Stop`, `SessionEnd`, `WorktreeCreate/Remove` | `--plugin-dir <dir>` (plugin hooks are additive) or `--settings <file|json>` | `-p --output-format stream-json [--input-format stream-json] [--include-hook-events]` | `--session-id <uuid>`, `--resume <id>` | `--permission-mode default|acceptEdits|plan|auto|dontAsk|bypassPermissions`; `claude auth status` exit code; `claude agents --json` lists its own background sessions |
| Codex CLI | `hooks.json` / inline `[hooks]`: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest` (allow/deny), `PostToolUse`, `Stop`, `SessionEnd`, …; non-managed hooks need hash-based trust | `-c key=value` overrides (hooks still subject to trust); `-c notify=[…]` for turn-complete; `-c tui.notifications=… tui.notification_method=osc9` | `codex exec --json` (JSONL events), `codex app-server` (JSON-RPC) | `codex exec resume <id>`, interactive resume | `--sandbox read-only|workspace-write|danger-full-access`, `--ask-for-approval on-request|never`, `-C <dir>` |
| Gemini CLI | `settings.json` hooks: `BeforeTool` (block/rewrite), `AfterTool`, `AfterAgent`, `Notification` (advisory), session events | none confirmed (user/project/system settings files only) | `gemini --acp` (ACP over stdio); `-p` non-interactive | via ACP `session/load` if supported | project settings file lives in the repo — Hive must not write it |
| GitHub Copilot CLI | `~/.copilot/hooks/*.json`, repo `.github/hooks/*.json`: `preToolUse`, `permissionRequest`, `postToolUse`, session events | `COPILOT_HOME` exists but replaces the whole config dir — not used | `copilot -p` | (verify) | repo hooks would be committed — Hive never writes them |
| Cursor CLI (`cursor-agent`) | `~/.cursor/hooks.json`: `beforeShellExecution` (allow/deny/ask), `afterShellExecution`, `stop`, … — CLI firing reported unreliable on Linux/Windows (Aug 2026) | none confirmed | `-p --output-format stream-json [--stream-partial-output]` | `--resume` (verify) | treat hooks as best effort |
| OpenCode | JS plugins with events (`session.idle`, `permission.asked`, …); server event stream | `OPENCODE_CONFIG` (verify) | `opencode acp`; `opencode run`; `opencode serve` (HTTP + SSE) | ACP `session/load` | ACP permission handling incomplete in some builds |
| Aider | none; `--notifications` + `--notifications-command <cmd>` fires when waiting for input | yes (flag) | `--message <prompt>` (one-shot) | `--restore-chat-history` | auto-commits by default (good for lanes) |

## 3. User stories

1. As a user I want GitHappens to find the agents I have installed and tell me which ones can report live status.
2. As a user I want to start any of my agents in a lane with one click, using my own sign-in, model and flags.
3. As a user I want to see "needs permission" within a second of the agent asking, and approve or deny from the board.
4. As a user I don't want GitHappens to edit my global agent configuration unless I explicitly ask, and I want to see exactly what it will change.
5. As a user I want an unknown or homegrown agent to work too, with at least basic status.
6. As a power user I want to resume a session after restarting GitHappens.

## 4. UI specification

Adapter-facing UI (the rest is in file 04):

### 4.1 Agents preferences page (spec 13 "External Tools" → new page "Agents")

```
Agents
├─ Default agent: [Claude Code ▾]   (hive.defaultAdapter)
├─ Detected agents (table)
│   Agent        Version   Path                       Status signals            Actions
│   Claude Code  2.1.290   ~/.local/bin/claude        ● Live (per-run plugin)   Configure ▸ · Test
│   Codex CLI    0.140.0   /opt/homebrew/bin/codex    ◐ Turn + approvals (OSC)  Configure ▸ · Enable hooks… · Test
│   Gemini CLI   0.52.0    …                          ○ Heuristic               Configure ▸ · Enable global hooks…
│   Aider        0.86      …                          ◐ Waiting-for-input       Configure ▸
│   Cursor CLI   —         not found                                            Locate… · Install docs ↗
│   + Add custom agent…
├─ Global status integrations (for agents started outside GitHappens): list with Installed / Not installed, Preview & install…, Uninstall
└─ Re-detect
```

Signal quality badges: **● Live** (hooks or structured stream incl. permissions), **◐ Partial** (turn-complete / waiting only), **○ Heuristic** (terminal activity only).

### 4.2 Configure adapter (drawer)

Fields: executable path override; extra args (shell-style string, validated by `shell-quote` round-trip); default model; default effort; supported permission presets shown read-only (the preset itself is chosen per task or template, never per adapter; default Ask — file 08 §6.2); runner default (`Interactive terminal` | `Headless` | `Rich chat (ACP)` when supported); environment variables (name → value, value either plain or **secret** stored in SecretStore); "Test" button runs `--version` and the auth probe.

### 4.3 Global integration preview dialog

Shows the target file path, a unified diff of the change (JSON/TOML/JS file), the marker used to identify Hive's entries, and a "This affects every session of <agent> on this machine, including ones started outside GitHappens" note. Install requires ticking "I understand". Uninstall removes exactly the marked entries and shows the resulting diff.

## 5. Data model & IPC

### 5.1 Adapter contract (`src/main/hive/adapters/types.ts`)

```ts
export interface AgentAdapter {
  readonly id: AdapterId;
  readonly displayName: string;
  readonly detect: {
    executables: string[];                    // ['claude'] ; ['cursor-agent'] ; Windows adds .exe/.cmd via PATHEXT
    processNames: string[];                   // for terminal adoption (spec 12 detector), incl. node package entry names
    versionArgs: string[];                    // ['--version']
    parseVersion(stdout: string): string | null;
    minVersion?: string;                      // below → 'adapter-version-unsupported' with upgrade hint
    authProbe?: { args: string[]; okExitCodes: number[] };   // e.g. claude auth status
  };
  readonly capabilities: AdapterCapabilities;
  /** Build the launch for a run. Pure given inputs (unit-testable). */
  buildLaunch(input: LaunchInput): LaunchPlan;
  /** Map raw signals from this adapter's sources into HiveSignals. */
  readonly parsers: {
    hook?(event: BridgeHookEvent): HiveSignal[];          // §6.4
    stream?(line: string): HiveSignal[];                  // headless JSONL
    osc?(seq: OscSequence): HiveSignal[];                 // OSC 9 / 777 / BEL
    promptLike?(lastLine: string): boolean;               // heuristic override
  };
  /** Translate a user decision into the hook/ACP response this agent understands. */
  permissionResponse?(decision: PermissionDecision, req: PermissionRequestView): unknown;
  /** How to interrupt / stop interactively. */
  readonly controls: { interrupt: ControlAction; stop: ControlAction[] };
  /** Optional global integration for externally started sessions (§6.4.4). */
  readonly globalIntegration?: GlobalIntegrationSpec;
}

export interface AdapterCapabilities {
  runners: Array<'pty' | 'headless' | 'acp'>;
  signals: { hooks: 'per-run' | 'global-only' | 'none'; permissions: 'hook' | 'acp' | 'none'; osc: boolean; stream: boolean };
  resume: 'by-id' | 'last-in-cwd' | 'none';
  presetSessionId: boolean;                   // can we choose the agent session id up front (claude --session-id)
  promptDelivery: Array<'arg' | 'paste' | 'stdin-json' | 'acp'>;
  instructionsDelivery: Array<'system-prompt-file' | 'prompt-prefix'>;
  permissionPresets: PermissionPreset[];      // file 08 §6.2
  models?: { flag: string; known?: string[] };
  effort?: { flag: string; values: string[] };
  mcpConfig?: 'flag-file' | 'config-override' | 'acp' | 'none';
  autoCommits: boolean;                       // aider: true
  /** Plan gate support (G8): how to run a read-only planning turn and then continue with write access in the same session. */
  planMode?: { start: 'permission-mode-plan' | 'sandbox-read-only' | 'acp-mode' | 'prompt-only'; continueWith: 'switch-mode-keys' | 'restart-resume' | 'acp-set-mode' | 'prompt-only' };
  /** Where usage numbers come from (G9). */
  usage: Array<'stream-result' | 'turn-usage' | 'acp' | 'hook' | 'none'>;
  /** Can a follow-up prompt be delivered to a live run (G1 feedback)? 'restart-resume' = end run, resume with prompt. */
  followUp: 'paste' | 'stdin-json' | 'acp' | 'restart-resume' | 'none';
  /** Structured end-of-run report (G5): JSON schema flag or MCP tool. */
  report?: 'output-schema' | 'json-schema' | 'mcp-tool' | 'last-message';
}

export interface LaunchInput {
  lane: HiveLane; task: HiveTask; session: HiveSession;
  runner: 'pty' | 'headless' | 'acp';
  prompt: string | null;                      // null = start without a first prompt
  instructionsFile: string | null;            // composed shared instructions (file 07 §6.4), in userData
  resume: boolean;
  preset: PermissionPreset['id'];
  model?: string; effort?: string;
  userArgs: string[];                         // from adapter config
  bridge: { endpoint: string; token: string; helperPath: string; pluginDir?: string };
  mcp?: { configPath: string } | null;        // H5
  env: Record<string, string>;                // already-filtered base env (file 08 §6.4)
  platform: NodeJS.Platform;
}

export interface LaunchPlan {
  command: string;                            // resolved absolute executable
  args: string[];
  env: Record<string, string>;                // base env + adapter additions (secrets resolved in main only)
  cwd: string;                                // always the lane worktree (or subdir if the task says so)
  promptAfterReady?: { text: string; strategy: 'paste'; readyPattern?: RegExp; maxWaitMs: number };
  tempFiles: string[];                        // deleted when the run ends
  redactedArgs: string[];                     // for logs/audit
}

export type ControlAction =
  | { kind: 'keys'; data: string; delayMs?: number }   // e.g. '\x1b' (Esc), '\x03' (Ctrl+C)
  | { kind: 'acp-cancel' } | { kind: 'signal'; signal: 'SIGINT' | 'SIGTERM' } | { kind: 'kill-tree' };

export type PermissionDecision =
  | { kind: 'allow' } | { kind: 'deny'; message?: string } | { kind: 'defer' };   // defer = "answer in terminal"
```

### 5.2 Summary sent to the renderer

```ts
export interface AdapterSummary {
  id: AdapterId; displayName: string; builtIn: boolean;
  installed: boolean; path?: string; version?: string; versionOk: boolean;
  authenticated: 'yes' | 'no' | 'unknown';
  signalQuality: 'live' | 'partial' | 'heuristic';
  capabilities: Pick<AdapterCapabilities, 'runners' | 'resume' | 'permissionPresets' | 'models' | 'effort'>;
  globalIntegration?: IntegrationStatus;
  config: { extraArgs: string; model?: string; effort?: string; runner: 'pty' | 'headless' | 'acp'; envNames: string[] };   // no preset: chosen per task/template (file 08 §6.2)
  warnings: string[];                         // e.g. "Found Windows binary from WSL path", "hooks unreliable on Linux in this version"
}
export interface IntegrationStatus { installed: boolean; file?: string; installedVersion?: string; outdated: boolean; modifiedByUser: boolean }
export interface IntegrationPreview { file: string; before: string | null; after: string; diff: string; previewHash: string; notes: string[] }
```

### 5.3 Custom adapters

```ts
export interface CustomAdapterDef {
  id: `custom:${string}`;                     // slug
  displayName: string;
  command: string;                            // executable or absolute path
  args: string[];                             // tokens; placeholders below
  promptDelivery: 'arg' | 'paste' | 'none';
  processNames?: string[];                    // for adoption
  promptLikeRegex?: string;                   // heuristic tuning
  resumeArgs?: string[];
}
```

Placeholders in `args` (expanded in main, never by a shell): `{prompt}`, `{promptFile}`, `{instructionsFile}`, `{worktree}`, `{branch}`, `{base}`, `{taskTitle}`, `{port}`, `{model}`. The migrated `tools.agentCommand` / `tools.agentArgs` (spec 13) become `custom:legacy` (file 09 §6.4). Custom adapters always get the generic notify helper (§6.4.3), OSC parsing and heuristics.

### 5.4 Session start request

```ts
export interface SessionStartReq {
  laneId: HiveId;
  adapterId?: AdapterId;                      // default: lane.adapterId
  runner?: 'pty' | 'headless' | 'acp';        // default: adapter config
  prompt?: string;                            // default: task brief for the first session of a lane
  preset?: string; model?: string; effort?: string;
  cols?: number; rows?: number;               // pty only
  resumeSessionId?: HiveId;                   // same as hive:session:resume
}
```

## 6. Implementation details

### 6.1 Detection (`AdapterRegistry.detect()`)

1. For each adapter, resolve each executable with the user's login-shell PATH (spec 02 §6.1 resolves it once at startup) — `which`-equivalent in Node (`PATHEXT` on Windows). Also probe well-known install locations not always on GUI PATH: `~/.local/bin`, `~/.claude/local`, `~/.npm-global/bin`, `$(npm prefix -g)/bin`, Homebrew prefixes, `%APPDATA%\npm`, `%LOCALAPPDATA%\Programs\*`.
2. Run `versionArgs` with a 3 s timeout, `stdin` closed, env = filtered base env. Parse version; compare with `minVersion`.
3. Run `authProbe` if defined (5 s timeout). Unknown on timeout.
4. Cache results in `hive/adapters.json` for 24 h; re-detect on Preferences open, on "Re-detect", and when a launch fails with ENOENT.
5. **WSL:** on Windows, ignore candidates under `/mnt/c/...` style paths and `\\wsl$` unless the repo itself is a WSL path (`\\wsl.localhost\...`); for WSL repos, prefer running the agent through `wsl.exe -d <distro> --cd <linuxPath> -- <agent>` (adapter flag `wslAware`), and warn if only a Windows binary was found *(our extension; addresses the reference's documented WSL issue)*.
6. Detection never executes anything from inside a repository (no `./node_modules/.bin` lookups).

### 6.2 Built-in adapters

Common to all: `cwd` = lane worktree; env includes `GITHAPPENS_HIVE=1`, `GITHAPPENS_HIVE_ENDPOINT`, `GITHAPPENS_HIVE_TOKEN`, `GITHAPPENS_HIVE_RUN`, `GITHAPPENS_HIVE_LANE`, `GITHAPPENS_HIVE_PORT` (file 03 §6.5), `GITHAPPENS_HIVE_NOTIFY` (helper path); see file 08 §6.4 for what is removed from env.

#### 6.2.1 Claude Code (`claude-code`)

- **Launch (pty):** `claude [--session-id <uuid> | --resume <agentSessionId>] --permission-mode <preset> [--model <m>] [--effort <e>] --plugin-dir <resources>/hive/claude-plugin [--append-system-prompt-file <instructionsFile>] [--mcp-config <hiveMcp.json>] [userArgs…] [<prompt>]`.
  - Hive generates the session UUID (`presetSessionId`), so the session id is known before the first hook fires.
  - **Hooks via plugin directory** (preferred, additive to the user's own hooks): Hive ships `resources/hive/claude-plugin/` with a `hooks/hooks.json` registering the helper for `SessionStart`, `UserPromptSubmit`, `PreToolUse` (async, observe only), `PermissionRequest` (blocking), `PostToolUse` and `PostToolUseFailure` (async), `Notification`, `Stop`, `StopFailure`, `SubagentStart`, `SubagentStop`, `SessionEnd`. Each handler is the exec form `<helper> claude <event>` so no shell is involved. The plugin hooks only act when `GITHAPPENS_HIVE_TOKEN` is present; otherwise the helper exits 0 immediately.
  - **Fallback** if `--plugin-dir` is unavailable in the installed version: `--settings <tmp.json>` containing only the `hooks` key *(verify whether `--settings` merges or replaces the user's `hooks`; if it replaces, Hive reads the user's effective hooks from `~/.claude/settings.json`, `.claude/settings.json`, `.claude/settings.local.json` and merges them into the temp file, preserving order, and shows a one-time notice)*.
  - **Prompt delivery:** as the trailing positional argument when ≤ 16 KiB and no NUL/escape characters; otherwise `promptAfterReady` paste (bracketed paste, `\x1b[200~…\x1b[201~` then `\r`) after the `SessionStart` hook fires or 15 s.
- **Launch (headless):** `claude -p --output-format stream-json --verbose --include-hook-events --session-id <uuid> --permission-mode <preset> --permission-prompts host` with `--input-format stream-json` so follow-ups can be sent; permission prompts are answered by Hive through the `PermissionRequest` hook in the same plugin (the host path only exists for the SDK; when no hook answers, `--permission-prompts none` would deny — Hive never uses `none` for interactive tasks, file 08).
- **Signal mapping (hooks):**

  | Claude hook | HiveSignal |
  |---|---|
  | `SessionStart` | `session-id` (from `session_id`), `run-started` |
  | `UserPromptSubmit` | `turn-started { prompt }` → status `working` |
  | `PreToolUse` / `PostToolUse` / `PostToolUseFailure` | `tool { phase, tool: tool_name, summary from tool_input, paths }` → `working`; edit/write tools also `file-changed` |
  | `PermissionRequest` | `permission-request` (blocking; response `{ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' | 'deny', message? } } }`; on `defer` the helper prints nothing and exits 0 so Claude shows its own prompt) |
  | `Notification` `permission_prompt` | `permission-request` fallback (non-answerable, "answer in terminal") if no `PermissionRequest` event arrived for it within 500 ms |
  | `Notification` `idle_prompt` / `agent_needs_input` / `elicitation_dialog` | `needs-input { message }` |
  | `Notification` `agent_completed` | `turn-complete` (if not already from `Stop`) |
  | `Stop` | `turn-complete { summary }` (summary read from the hook input's last assistant message if present, else from the transcript tail, ≤ 2 KiB) → `idle` |
  | `StopFailure` | `error { recoverable: true }` |
  | `SubagentStart/Stop` | `subagent` |
  | `SessionEnd` | `notice` (run exit comes from the process) |

- **Controls:** interrupt = `Esc`; stop = `Ctrl+C`, 500 ms, `Ctrl+C`, then kill tree after 3 s.
- **Resume:** `by-id` (`--resume <id>`); works across app restarts because transcripts are Claude's own.
- **Presets (decided 2026-10-12, file 08 §6.2):** `ask` (default) → `--permission-mode default`; `plan` → `plan`; `accept-edits` (opt-in per task/template) → `acceptEdits`. `auto`, `dontAsk`, `bypassPermissions` and `--dangerously-skip-permissions` are never offered and are rejected if present in `extraArgs`.
- **Auth probe:** `claude auth status` (exit 0 = signed in).
- **Do not use** Claude's own `--worktree/-w` (Hive owns worktrees) or `--bg` (Hive owns supervision).

- **Plan gate (G8):** `planMode = { start: 'permission-mode-plan', continueWith: 'switch-mode-keys' }`. The planning turn runs with `--permission-mode plan`; on approval Hive pastes the approved (possibly edited) plan with "Proceed with this plan" after switching mode with the agent's mode-cycle key (`Shift+Tab`, *verify sequence per version*); if the switch cannot be confirmed by the next `UserPromptSubmit` hook's `permission_mode`, Hive ends the run and resumes with `--resume <id> --permission-mode <preset>` (`restart-resume`).
- **Usage (G9):** headless `result` event carries usage and cost; interactive runs report tokens only where hook payloads include them, otherwise time only.
- **Report (G5):** headless `--json-schema <file>` with Hive's lane-report schema when the task template asks for a report; interactive: last assistant message from `Stop`.

#### 6.2.2 Codex CLI (`codex`)

- **Launch (pty):** `codex -C <worktree> <preset flags> [-m <model>] -c tui.notifications=true -c tui.notification_method=osc9 -c 'notify=["<helper>","codex-notify"]' [userArgs…] [<prompt>]`, where `<preset flags>` = `--sandbox read-only --ask-for-approval on-request` for `ask` (default), `--sandbox read-only --ask-for-approval never` for `plan`, `--sandbox workspace-write --ask-for-approval on-request` for `accept-edits` (opt-in per task/template; file 08 §6.2). `danger-full-access`, `--yolo` and `--dangerously-bypass-approvals-and-sandbox` are never passed and are rejected in `extraArgs`.
  - `osc9` makes the TUI emit OSC 9 notifications for **approval requested** and **turn complete**, which Hive parses from the pty stream (§6.3.2) — no trust prompt needed.
  - The `notify` program receives turn-complete JSON (incl. last assistant message and, when known, thread id) → `turn-complete` + `session-id`.
  - **Answerable approvals** need Codex hooks (`PermissionRequest`). Per-run hooks via `-c hooks…` are subject to Codex's hash-based hook trust *(verify)*: Hive therefore offers "Enable Codex approvals in GitHappens" which installs a marked hook entry in `~/.codex/hooks.json` (global integration, §6.4.4) and tells the user to trust it once in Codex's `/hooks` view. Hive never passes `--dangerously-bypass-hook-trust`.
- **Launch (headless):** `codex exec --json -C <worktree> --sandbox <read-only | workspace-write> --ask-for-approval never [-m <model>] -o <lastMessageFile> <prompt>`. With `never`, Codex does not ask and simply cannot perform actions outside the sandbox policy (it does not escalate); `read-only` for `ask`/`plan` tasks (review, planning), `workspace-write` only when the task or template opted in to `accept-edits` (file 08 §6.2). Follow-up = `codex exec resume <threadId> --json …`.
- **Stream mapping:** JSONL events → `session-id` (thread started), `turn-started`, `tool` (command/patch items), `turn-complete`, `error`, `usage` (token counts). Unknown event types are logged and ignored.
- **Controls:** interrupt `Esc`; stop `Ctrl+C` ×2.
- **Resume:** `by-id` (headless) / interactive resume subcommand *(verify flag name)*.
- **Plan gate (G8):** planning turn with `--sandbox read-only` (and, headless, `--ask-for-approval never`); approval resumes the thread with the task's preset flags (`restart-resume`; `workspace-write` only if the task opted in to `accept-edits`, otherwise `read-only --ask-for-approval on-request` so each write asks).
- **Usage (G9):** `exec --json` turn-completed events carry token usage; interactive runs: time only unless the `notify` payload includes usage.
- **Report (G5):** headless `--output-schema <file>` with the lane-report schema.
- **ACP (H3, G13):** via a configured ACP bridge command (e.g. a community `codex-acp` adapter) or `codex app-server` JSON-RPC behind an internal shim; both disabled by default until verified.

#### 6.2.3 Gemini CLI (`gemini`)

- **Launch (pty):** `gemini [-m <model>] [userArgs…]` + prompt via paste (`-i <prompt>` interactive-with-initial-prompt flag where available, *verify*).
- **Signals:** heuristics + OSC by default (○). Optional global integration: marked hook entries in `~/.gemini/settings.json` for `BeforeTool` (observe), `AfterTool`, `AfterAgent` (→ `turn-complete`), `Notification` (→ `needs-input` / non-answerable permission). Hive **never** writes the repo's `.gemini/settings.json` (it is part of the working tree and would be committed).
- **ACP (H3, preferred for Gemini, G13):** `gemini --acp` (older builds `--experimental-acp`); gives full status and answerable permissions.
- **Headless:** `gemini -p <prompt>` with a structured output flag if present *(verify)*; otherwise headless is disabled for Gemini.

#### 6.2.4 GitHub Copilot CLI (`copilot`)

- **Launch (pty):** `copilot [userArgs…]` + prompt via paste (or `-i` when available, *verify*). Hive does not pass any `--allow-all-tools`-style flag.
- **Signals:** heuristics/OSC by default; optional global integration writes a marked file `~/.copilot/hooks/githappens-hive.json` (`preToolUse` observe, `permissionRequest` answerable, `postToolUse`, session end). Never `.github/hooks/` in the repo.
- **Headless:** `copilot -p <prompt>` with explicitly listed allowed tools only from the task's preset (read-only tools for `ask`/`plan`; plus file-edit tools for `accept-edits`; file 08 §6.2); no allow-all.
- Behavior on deny/dismiss mirrors the reference: "Answer in terminal" returns no decision so Copilot's own prompt appears.

#### 6.2.5 Cursor CLI (`cursor`)

- **Launch (pty):** `cursor-agent [--model <m>] [userArgs…] [<prompt>]`.
- **Headless:** `cursor-agent -p --output-format stream-json <prompt>` (always pass `--output-format` explicitly; terminal `result` event = success; non-zero exit without `result` = error). Without `--force`-style flags, write/shell actions requiring approval cannot be granted headlessly; Hive surfaces the resulting failure as `error` with "Run interactively to approve".
- **Signals:** stream (headless), heuristics/OSC (pty); optional global hooks in `~/.cursor/hooks.json` (`beforeShellExecution` answerable, `stop` → turn-complete). Adapter warning: "Cursor CLI hooks may not fire on Linux/Windows in some versions" (shown when a hook has never been received after 3 turns).

#### 6.2.6 OpenCode (`opencode`)

- **Launch (pty):** `opencode [--model <m>] [userArgs…]`, prompt via paste.
- **ACP (H3, preferred, G13):** `opencode acp`.
- **Headless:** `opencode run <prompt>` *(verify output format)*.
- **Global integration:** a marked JS plugin file in OpenCode's user plugin directory that forwards `session.idle`, `permission.asked` (answerable if the plugin API allows replying; otherwise non-answerable), tool events and errors to the helper *(verify plugin API at build time)*.

#### 6.2.7 Aider (`aider`)

- **Launch (pty):** `aider --notifications --notifications-command "<helper> aider-notify" [--model <m>] [userArgs…]`; prompt via paste after the first `>` prompt. The notify command → `needs-input` (Aider calls it when it finishes and waits for input) and implicitly `turn-complete`.
- **Headless:** `aider --message <prompt> --no-pretty` *(our choice)*; Hive never adds `--yes-always`. Aider asks for confirmation on some actions; in headless mode those prompts cannot be answered, so headless Aider is limited to edit-only tasks and marked "Partial".
- `autoCommits: true`: lanes will contain Aider's commits; review (file 06) handles commit lists natively.

#### 6.2.8 Generic / custom (`custom:*`)

PTY only (plus headless if the user marks the command as non-interactive). Signals: heuristic (existing classifier), OSC 9/777 parsing, BEL as a weak `needs-input` hint, and the notify helper: any script can call `"$GITHAPPENS_HIVE_NOTIFY" <needs-input|turn-complete|error|working> [message]`.

### 6.3 Runners

#### 6.3.1 PtyRunner

- Spawns through spec 12 `PtyService` (node-pty, ConPTY on Windows) with `command`/`args` directly (no shell) unless the adapter config says "run via login shell" (needed for shell-function launchers; then the argv is quoted with the existing `shell-quote` helpers).
- The pty is owned by Hive, not by a terminal tab: the lane drawer's Terminal tab attaches via `hive:session:attach` → spec 12 `terminal:attach` (replay buffer + live stream), so closing the drawer never kills the agent. "Pop out to terminal panel" moves the attachment to the bottom terminal dock.
- Output tap: every chunk goes to (a) the attach stream, (b) the capped `pty.log` (file 08 §6.6), (c) the OSC parser (§6.3.2), (d) the heuristic tracker (last line, byte counts → `heartbeat` every 1 s while output flows).
- `promptAfterReady`: wait for `readyPattern`, a `SessionStart` hook, or `maxWaitMs`, then paste.
- `hive:session:send` on a pty run = bracketed paste of `text`, plus `\r` when `submit`.

#### 6.3.2 OSC / escape-sequence parser

Parses, without altering the stream: `OSC 9 ; <text> BEL|ST` (iTerm-style notification), `OSC 777 ; notify ; <title> ; <body> ST` (urxvt/VTE style), `OSC 9 ; 4 ; …` (ConEmu progress → ignored), bare `BEL` outside OSC. The adapter's `parsers.osc` maps text to signals (Codex: "approval requested" → non-answerable `permission-request`, "turn complete"/"agent turn complete" → `turn-complete`; *verify exact strings and keep them in adapter fixtures*). Unknown notifications → `notice`.

#### 6.3.3 HeadlessRunner

- `child_process.spawn(command, args, { cwd, env, stdio: ['pipe','pipe','pipe'], detached: POSIX })`. stdin kept open when the adapter supports `stdin-json` follow-ups, else closed.
- stdout split by `\n` (max line 4 MiB; longer lines truncated with an `error` signal), each line → `parsers.stream`. stderr captured to the event log (last 64 KiB kept for the error item).
- Exit: code 0 and a final result → `done`; else `error` with stderr tail.
- No TTY: Hive's Terminal tab shows a read-only rendering of the event stream (Activity view) instead.

#### 6.3.4 AcpRunner (minimal in H3, G13)

Phasing: H3 ships the runner for **status, plan updates, tool-call timeline and permission requests** answered from the attention queue, for agents that speak ACP natively (Gemini CLI `--acp`, OpenCode `acp`) and through configured ACP bridges for Claude Code and Codex (off by default until verified). There is **no chat UI** in H3: the Lane drawer's Activity tab renders the structured stream read-only, prompts are sent from the existing "Send to agent" box (`hive:session:send`). A native chat surface is deferred and may never ship (README non-goals).


- Spawn the adapter's ACP command; JSON-RPC 2.0 over stdio (newline-delimited). `initialize` with protocol version 1 and client capabilities: `fs.readTextFile` + `fs.writeTextFile` (**restricted to the lane worktree**; paths outside → JSON-RPC error and an audit entry), `terminal` (Hive implements `terminal/create|output|wait_for_exit|kill|release` by spawning commands with cwd inside the worktree through a dedicated non-interactive process host; each `terminal/create` is itself subject to the agent's permission request flow).
- `session/new { cwd: worktree, mcpServers: [hive MCP if enabled] }` or `session/load` for resume when `loadSession` is advertised.
- Plan gate (G8): `session/set_mode` to the agent's read-only/plan mode when advertised for the planning turn, then back to its default mode on approval; plan `session/update`s become `plan` signals.
- `session/prompt` for prompts; `session/cancel` for interrupt.
- `session/update` kinds → signals: message chunks → `working` (+ Activity text), tool call / tool call update → `tool`, plan → Activity plan block, mode change → `notice`, end of prompt response (stop reason) → `turn-complete` or `error`.
- `session/request_permission` → `permission-request` with options mapped: ACP allow-once → `allow-once`; reject-once → `deny`; allow-always / reject-always are **not** offered by default (file 08 §6.3); Hive replies with the selected option id or `cancelled` on timeout.
- `elicitation/create` → `question` attention item with an inline form (string/enum/boolean fields only; anything else → "answer in agent").

#### 6.3.5 Follow-up prompts, feedback and plan gate across runners (G1, G8)

`hive:session:send` and the review feedback flow (file 06 §6.2) deliver text according to `capabilities.followUp`:

| `followUp` | Delivery | Used by |
|---|---|---|
| `paste` | Wait until status is `idle`/`needs-input` (never paste while `working` or `needs-permission`; queue instead), bracketed paste, `\r` | All pty runs |
| `stdin-json` | Write a user message line to the open stdin of the headless run | Claude headless (`--input-format stream-json`) |
| `acp` | `session/prompt` | ACP runs |
| `restart-resume` | Let the run finish, start a new run with the adapter's resume args and the text as prompt | Codex/Cursor headless, any run that has exited |

Queued sends are shown in the lane drawer ("1 message queued — will send when the agent is idle", with Cancel). Texts larger than 16 KiB are written to a file under the run's temp dir and the pasted prompt references it only for agents that can read files outside the worktree without a permission prompt; otherwise they are pasted in full.

Plan gate for adapters without a plan mode (`planMode.start = 'prompt-only'`: Gemini/Copilot/Cursor/OpenCode pty, Aider, custom): the planning prompt instructs the agent to only produce a plan and not edit files; Hive takes a checkpoint before the planning turn and, if the worktree changed during it, raises a `scope`-style warning ("Agent edited files during planning") with Restore checkpoint. This is advisory, not enforcement; the plan-gate UI labels it "Plan requested (not enforced by this agent)".

### 6.4 Hook bridge

#### 6.4.1 Endpoint

- POSIX: Unix domain socket `<userData>/profiles/<profileId>/hive/run/bridge.sock`, directory mode `0700`, socket `0600`.
- Windows: named pipe `\\.\pipe\githappens-hive-<sha1(userData+profileId)[0..12]>`, created with a security descriptor granting only the current user SID.
- Protocol: one JSON object per line. Request: `{ "v": 1, "token": "<run token or external token>", "agent": "claude", "event": "PermissionRequest", "pid": 1234, "cwd": "...", "payload": { …hook stdin JSON… } }`. Response (only for blocking events): `{ "v": 1, "decision": "allow" | "deny" | "defer", "message"?: "…" }` or `{ "v": 1, "decision": "defer" }` on any error.
- Tokens: per-run 256-bit random token (hex), bound to `{ runId, sessionId, laneId }`, revoked when the run ends. Signals carrying a token for a different run, or a cwd outside that lane's worktree, are dropped and audited (`bridge-mismatch`). Rate limit: 50 events/s per token, burst 200; excess dropped with one `notice`.
- `hive/run/bridge.json` (mode 0600) holds `{ endpoint, externalToken }` for global integrations; the external token can only create adopted sessions and submit signals/permission requests, never call any other API.

#### 6.4.2 Helper executable `githappens-hive-hook`

- A small native binary (Rust, statically linked, ≤ 2 MiB per platform/arch) shipped in `resources/bin/`, code-signed with the app. Startup ≤ 10 ms matters because some hooks run on every tool call. Fallback when the binary is missing: `ELECTRON_RUN_AS_NODE=1 <app executable> <resources>/hive/hook.js` (≈ 150 ms).
- Usage: `githappens-hive-hook <agent> <event>` reads stdin (hook JSON, max 1 MiB), adds env context, connects to the endpoint (from `GITHAPPENS_HIVE_ENDPOINT`, else `bridge.json` discovered via the platform's userData path for the **default** profile, else exit 0), sends, and for blocking events waits for the decision up to `GITHAPPENS_HIVE_PERMISSION_TIMEOUT_MS` (default 300 000, always below the agent's own hook timeout), then writes the agent-specific JSON to stdout via the adapter's response template (embedded in the helper per agent) and exits 0.
- **Fail-safe rule:** on any error (no endpoint, connection refused, timeout, malformed response) the helper writes **nothing** to stdout and exits 0, so the agent continues with its own behavior (its own permission prompt). It never exits 2 and never emits an allow on error.
- Also implements `codex-notify` (argv JSON → signal), `aider-notify`, `notify <kind> [msg]` (generic), and `mcp` (H5, §6.6).
- The helper never reads agent transcripts itself; `Stop` summaries are read in main from the `transcript_path` given in the hook payload, only if that path is under the agent's documented data directory.

#### 6.4.3 Per-run injection summary

| Adapter | Per-run mechanism | Writes user files? |
|---|---|---|
| Claude Code | `--plugin-dir` (fallback `--settings`) | No |
| Codex | `-c notify=…`, `-c tui.notifications…` (OSC 9) | No (answerable approvals need the opt-in global hook) |
| Aider | `--notifications-command` | No |
| Custom | `GITHAPPENS_HIVE_NOTIFY` env | No |
| Gemini, Copilot, Cursor, OpenCode | none — heuristics/OSC/stream, or ACP (H3), or opt-in global integration | Only with consent |

#### 6.4.4 Opt-in global integrations

For agents without per-run hooks and for sessions started outside GitHappens:

1. **Preview** (`hive:adapters:integration:preview`): read the target file (e.g. `~/.claude/settings.json`, `~/.codex/hooks.json`, `~/.gemini/settings.json`, `~/.copilot/hooks/githappens-hive.json`, `~/.cursor/hooks.json`, OpenCode plugin dir), parse it (JSON/JSONC/TOML preserving formatting via `jsonc-parser` edits / `@iarna/toml`-style round-trip), compute the minimal edit that adds Hive's entries, each tagged with a marker (`"_githappens": "hive/v1"` key where the schema tolerates extra keys, otherwise a dedicated file name or a `# githappens-hive v1` comment line), and return the diff + `previewHash`.
2. **Install** only with the matching `previewHash` (file unchanged since preview); back up the original to `hive/backups/<agent>-<timestamp>` (kept 90 days); write atomically; audit `integration-install`.
3. **Uninstall** removes exactly the marked entries; if the user edited them, show the diff and ask.
4. Hive **never** installs automatically, never reinstalls entries the user removed, and checks integration health on Preferences open (outdated helper path after an app move → "Repair" button, same preview flow).
5. Global hooks run for every session of that agent on the machine; the helper exits immediately when GitHappens isn't running or the session's cwd isn't inside a repo that Hive knows (bridge answers `ignore` quickly; helper p95 ≤ 50 ms).

### 6.4a Windows as a first-class platform

Most orchestrators are macOS-only; Hive treats Windows as a primary target:

- **Pty:** ConPTY via node-pty (spec 12 §6.1), resize debounce, `Ctrl+C` delivered as `\x03` through the pty (ConPTY generates the console control event); process-tree kill with `taskkill /T /F`.
- **Executables:** resolution honors `PATHEXT` and npm `.cmd` shims (spawn `.cmd` shims through `cmd.exe /d /s /c` with argv quoting from the existing `shell-quote` helpers, because `CreateProcess` cannot run batch files directly); prefer the native `.exe` when both exist.
- **Hook bridge:** named pipe with a current-user-only security descriptor; the helper is a native `.exe` (no PowerShell startup cost); exec-form hooks avoid `cmd`/PowerShell quoting issues entirely.
- **Paths:** all paths passed to agents are absolute Windows paths with forward-slash-free normalization; lane folders are short (file 03 §6.1); long-path warnings when `core.longpaths` is off.
- **WSL:** WSL repos run agents inside WSL (§6.1 step 5); Windows repos never pick a WSL-only binary.
- **Shells for setup steps:** PowerShell 7 (`pwsh`) when installed, else Windows PowerShell, else `cmd`; Git Bash only when the user chose it as terminal shell.
- **CI:** every adapter fixture test and the e2e suite run on `windows-latest` (file 11).

### 6.5 Heuristic source (kept from spec 12)

The existing `classifyStatus` (output within 2 s → working; quiet > 10 s and prompt-like last line → needs-input; else idle; exited) becomes `HeuristicTracker`, with per-adapter `promptLike` overrides (e.g. Aider `^> $`, Claude's input box border, Codex's composer line) and ANSI stripping of the last line. It runs for every pty run and is the only status source for adapters without hooks/OSC.

### 6.6 Hive MCP server (H5, our extension, off by default)

- Started per run on demand as `githappens-hive-hook mcp` (stdio MCP server) that proxies to the bridge with the run token. Registered via Claude `--mcp-config <tmp.json>`, Codex `-c mcp_servers.githappens_hive.command=…`, ACP `session/new.mcpServers`.
- Tools (read-mostly, all scoped to the run's own lane/task):
  - `hive_task_brief()` → task title, brief, linked issue/PR summary, acceptance notes.
  - `hive_report_progress(note: string, percent?: number)` → Activity entry (rate-limited 1/10 s).
  - `hive_sibling_lanes()` → for other active lanes of the same repo: branch, agent kind, changed file paths (no contents) — helps agents avoid editing the same files (file 07).
  - `hive_request_review(summary: string)` → `turn-complete` with a "ready for review" flag.
- **No** tools that mutate git, approve permissions, read other lanes' file contents, read secrets, or reach the network.

### 6.7 Stop, interrupt, kill

- Interrupt: adapter `controls.interrupt`.
- Stop: adapter `controls.stop` sequence with delays; then kill tree (Windows `taskkill /T /F /PID <pid>`; POSIX `process.kill(-pgid, 'SIGTERM')`, then `SIGKILL` after 3 s).
- After stop, a `manual` checkpoint is taken if the worktree changed since the last checkpoint (file 06 §6.6).

## 7. Step-by-step implementation plan

1. `AgentAdapter` types, `AdapterRegistry`, detection with caching and WSL rules. Test: fake PATH dirs with stub executables printing versions; WSL path filtering.
2. Generic adapter + PtyRunner on PtyService + HeuristicTracker (port of `agent-detect.ts`/`agent-monitor.ts`). Test: fake agent in pty, status transitions.
3. OSC parser. Test: golden byte streams split at every possible chunk boundary.
4. Hook bridge server (socket/pipe, tokens, rate limits) + node fallback helper. Test: unauthorized token rejected, mismatched cwd rejected, fail-safe on server down.
5. Native helper (Rust) with per-agent response templates; CI builds for win-x64/arm64, mac x64/arm64, linux x64/arm64; signed. Test: same contract tests run against both helpers.
6. Claude Code adapter (plugin dir, session id, presets, prompt delivery, signal mapping, permission response). Test with the fake agent in "claude mode" (file 11 §6.1) and one opt-in real-agent smoke test.
7. Codex adapter (OSC + notify, exec --json stream parser). Test with recorded JSONL fixtures.
8. Aider, Cursor (stream-json), Copilot, Gemini, OpenCode adapters (pty + heuristics; headless where verified). Test with recorded fixtures.
9. Global integration preview/install/uninstall with markers, backups, repair. Test: round-trip on fixture config files with comments, user-modified marked entries.
10. HeadlessRunner with follow-ups. Test: fake headless agent emitting JSONL.
11. (H3, G13) Minimal AcpRunner: status, plans, tool timeline, permissions; worktree-restricted fs and terminal capabilities; Gemini and OpenCode first. Test: fake ACP agent (file 11 §6.1) incl. path-escape attempts.
11a. (H2) Plan-mode and usage extraction per adapter (G8, G9). Test: fake agent emits plan + usage; headless `result` usage parsed for Claude, Codex turn usage parsed.
12. (H5) Hive MCP server. Test: tool calls scoped to own lane; no cross-lane contents.

## 8. Edge cases

- **Agent upgraded mid-session** changes hook payloads: parsers ignore unknown fields; unknown event names → `notice`; adapter fixture tests run against recorded payloads per supported version.
- **Agent not signed in:** the agent's own login flow runs inside the pty; Hive shows `needs-input` with a hint "Sign in to <agent> in the terminal". Headless runs with `auth-required` error and a "Sign in" button that opens an interactive run.
- **Multiple GitHappens profiles** running different agents: each profile has its own endpoint; global hooks use the default profile's `bridge.json` *(limitation; documented)*.
- **Hook fires after run ended** (async hooks): token revoked → dropped.
- **User's own hooks block or deny** (exit 2) before ours: Hive sees no permission request; status still from other events.
- **Very chatty hooks** (PreToolUse on every tool in large refactors): async + rate limits; Activity view coalesces consecutive tool events per tool.
- **Windows argv limits** (32 767 chars): prompts above 16 KiB always go via paste.
- **Prompt contains shell metacharacters:** no shell is used for spawning; arguments are passed as argv.
- **`claude` installed as an npm shim (`node …/cli.js`)**: process-name detection includes the package entry names (existing `agent-detect.ts` table).
- **Agent spawns its own worktrees** (Claude `WorktreeCreate`): Hive records a `notice`; files changed in another worktree are not part of the lane — the review screen warns if the lane worktree shows no changes but the agent reported edits elsewhere.

## 9. Acceptance criteria

- [ ] Installed agents are detected with versions within 5 s on all three OSes; missing ones show install hints; WSL/Windows confusion is flagged.
- [ ] Claude Code lanes show `working → needs-permission → working → idle` from hooks with p95 latency ≤ 500 ms from hook fire to board update, without modifying any user file.
- [ ] Allow / Deny from the board reaches Claude Code and Codex (with the opt-in Codex hook) and the agent proceeds accordingly; "Answer in terminal" makes the agent show its own prompt.
- [ ] With GitHappens closed, global hooks add ≤ 50 ms per hook and never block or change the agent's behavior.
- [ ] Any bridge failure results in the agent's default behavior, never an allow.
- [ ] Codex pty lanes show approval-requested and turn-complete from OSC 9 without any hook installed.
- [ ] Headless Claude/Codex/Cursor runs stream activity and end in `done` or `error` with the stderr tail.
- [ ] Global integration install shows an exact diff, backs up the file, and uninstall restores the file byte-for-byte when nothing else changed.
- [ ] Custom adapters work with placeholders and the notify helper.
- [ ] Plan gate works end-to-end with Claude Code (plan mode → approve → continue with write access) and Codex (read-only sandbox → approve → resume with the task's preset) (G8).
- [ ] Launches never contain bypass/blanket-approve flags; `accept-edits` flags appear only for tasks or templates that opted in (file 08 §6.2).
- [ ] Headless Claude and Codex runs report tokens (and Claude cost) into run usage; every run reports wall and active time (G9).
- [ ] The same adapter test suite passes on Windows, macOS and Linux, including `.cmd` shim launch and named-pipe bridge on Windows.

## 10. Out of scope / later

- Driving agents' GUIs or IDE extensions.
- A native ACP chat UI (G13 defers it; may never ship).
- Showing agent-team/subagent structure beyond `subagent` signals in the Activity timeline (G25: agent-to-agent messaging is the agents' job).
- Parsing agents' transcript files for full conversation replay (only last-message summaries).
- Remote/SSH agent hosts (file 10).
- Automatic adapter updates for new CLI versions (adapters ship with the app; hooks/stream parsers tolerate unknown fields).

## 11. Cross-spec dependencies

- **Spec 12 §6.1** PtyService spawn/attach/batching and shell-quote helpers; the existing agent detector (`apps/desktop/src/main/agents/agent-detect.ts`) moves into `src/main/hive/adapters/`.
- **Spec 02 §6.1** login-shell env resolution reused for detection and launch env.
- **Spec 13:** new "Agents" preferences page (replaces the "Coding agent command/args" row of External Tools); SecretStore kind `hive/<adapterId>/<envName>`.
- **Spec 15:** packaging of `githappens-hive-hook` per platform/arch (electron-builder `extraResources`, signing/notarization), the Claude plugin directory, CI build of the Rust helper.
- **File 08** owns permission presets, env filtering and risk classification used here.
