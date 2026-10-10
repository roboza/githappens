import type { AgentKind, AgentStatus } from '../../shared/ipc/agents-contract';

/**
 * Pure helpers for the Agents view (spec 12 §4.12): agent binary matching, process tree
 * parsing (Windows CIM JSON, `ps`, `lsof -F`) and status classification.
 */

export const KNOWN_AGENTS = ['claude', 'codex', 'copilot', 'gemini'] as const;

/** npm package path fragments of agents that run as `node …/cli.js` (Windows shims, nvm). */
const PACKAGE_MARKERS: [string, AgentKind][] = [
  ['@anthropic-ai/claude-code', 'claude'],
  ['@openai/codex', 'codex'],
  ['@github/copilot', 'copilot'],
  ['@google/gemini-cli', 'gemini'],
];

/** Interpreters / launchers whose arguments name the real program. */
const LAUNCHERS = new Set([
  'node',
  'nodejs',
  'bun',
  'deno',
  'npx',
  'pnpx',
  'python',
  'python3',
  'cmd',
  'sh',
  'bash',
]);

/** `C:\x\claude.exe` → `claude`; `/usr/bin/node` → `node`. */
export function exeBase(p: string): string {
  return (p.replace(/\\/g, '/').split('/').pop() ?? p)
    .replace(/\.(exe|cmd|bat|ps1|js|mjs|cjs)$/i, '')
    .toLowerCase();
}

/** Agent kind of a process / executable name, or null. `custom` is the configured agent command. */
export function agentKindOfName(name: string, customCommand?: string): AgentKind | null {
  const base = exeBase(name.trim());
  if (!base) return null;
  if ((KNOWN_AGENTS as readonly string[]).includes(base)) return base as AgentKind;
  const custom = customCommand?.trim() ? exeBase(customCommand.trim()) : '';
  if (custom && base === custom)
    return (KNOWN_AGENTS as readonly string[]).includes(custom) ? (custom as AgentKind) : 'custom';
  return null;
}

/** Splits a Windows / POSIX command line on whitespace, honouring double quotes. */
export function splitCommandLine(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  let has = false;
  for (const ch of cmd) {
    if (ch === '"') {
      quoted = !quoted;
      has = true;
    } else if (!quoted && /\s/.test(ch)) {
      if (has) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

/**
 * Agent kind of a process from its name and command line: the executable itself, or for
 * launchers (`node`, `cmd /c`, …) the script / package they run.
 */
export function agentKindOfProcess(
  name: string,
  commandLine: string | undefined,
  customCommand?: string,
): AgentKind | null {
  const direct = agentKindOfName(name, customCommand);
  if (direct) return direct;
  const tokens = commandLine ? splitCommandLine(commandLine) : [];
  const first = tokens[0] ? exeBase(tokens[0]) : exeBase(name);
  if (tokens[0]) {
    const k = agentKindOfName(tokens[0], customCommand);
    if (k) return k;
  }
  if (!LAUNCHERS.has(first) && !LAUNCHERS.has(exeBase(name))) return null;
  const norm = (commandLine ?? '').replace(/\\/g, '/').toLowerCase();
  for (const [marker, kind] of PACKAGE_MARKERS) if (norm.includes(marker)) return kind;
  for (const t of tokens.slice(1)) {
    if (t.startsWith('-')) continue;
    const k = agentKindOfName(t, customCommand);
    if (k) return k;
  }
  return null;
}

// ---- process tables ----

export interface ProcInfo {
  pid: number;
  ppid: number;
  name: string;
  commandLine?: string;
}

const toInt = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 0 ? n : null;
};

/**
 * Parses `Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine
 * | ConvertTo-Json -Compress` (a single object or an array). Bad rows are skipped.
 */
export function parseCimProcesses(json: string): ProcInfo[] {
  const text = json.trim().replace(/^\uFEFF/, '');
  if (!text) return [];
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const rows = Array.isArray(data) ? data : [data];
  const out: ProcInfo[] = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const pid = toInt(o.ProcessId);
    const ppid = toInt(o.ParentProcessId);
    if (pid === null || ppid === null || typeof o.Name !== 'string') continue;
    const p: ProcInfo = { pid, ppid, name: o.Name };
    if (typeof o.CommandLine === 'string' && o.CommandLine) p.commandLine = o.CommandLine;
    out.push(p);
  }
  return out;
}

/** Parses `ps -A -o pid=,ppid=,args=`. The name is the basename of the first argument. */
export function parsePsOutput(text: string): ProcInfo[] {
  const out: ProcInfo[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*\S)\s*$/.exec(line);
    if (!m) continue;
    const args = m[3]!;
    const first = args.split(/\s+/)[0] ?? args;
    out.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      name: first.split('/').pop() ?? first,
      commandLine: args,
    });
  }
  return out;
}

/** Parses `lsof -a -d cwd -Fn -p <pids>` field output into pid → cwd. */
export function parseLsofCwd(text: string): Map<number, string> {
  const out = new Map<number, string>();
  let pid: number | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('p')) pid = toInt(line.slice(1));
    else if (line.startsWith('n') && pid !== null && !out.has(pid)) out.set(pid, line.slice(1));
  }
  return out;
}

/** Descendants of `rootPid` (breadth-first, nearest first), up to `maxDepth` levels. */
export function descendantsOf(procs: ProcInfo[], rootPid: number, maxDepth = 4): ProcInfo[] {
  const byParent = new Map<number, ProcInfo[]>();
  for (const p of procs) {
    if (p.pid === p.ppid) continue;
    const list = byParent.get(p.ppid);
    if (list) list.push(p);
    else byParent.set(p.ppid, [p]);
  }
  const out: ProcInfo[] = [];
  const seen = new Set<number>([rootPid]);
  let level = [rootPid];
  for (let d = 0; d < maxDepth && level.length; d++) {
    const next: number[] = [];
    for (const pid of level) {
      for (const c of byParent.get(pid) ?? []) {
        if (seen.has(c.pid)) continue;
        seen.add(c.pid);
        out.push(c);
        next.push(c.pid);
      }
    }
    level = next;
  }
  return out;
}

/** First agent among `procs` (nearest first) with its kind. */
export function findAgentProcess(
  procs: ProcInfo[],
  customCommand?: string,
): { proc: ProcInfo; kind: AgentKind } | null {
  for (const p of procs) {
    const kind = agentKindOfProcess(p.name, p.commandLine, customCommand);
    if (kind) return { proc: p, kind };
  }
  return null;
}

// ---- status ----

export const RUNNING_WINDOW_MS = 2000;
export const WAITING_AFTER_MS = 10_000;

/**
 * Prompt-like last lines: shell-style prompt endings, y/n questions, agent input boxes and
 * approval menus (Claude Code "❯ 1. Yes", "Do you want to …?", "? for shortcuts", …).
 */
const PROMPT_PATTERNS: RegExp[] = [
  /[>❯›»$#%:?]\s*$/,
  /\(y\/n\)|\[y\/n\]|\[Y\/n\]|\[y\/N\]|\(yes\/no\)/i,
  /\bdo you want\b|\bwould you like\b|\bpress enter\b|\bapprove\b|\ballow\b.*\?/i,
  /\? for shortcuts|esc to cancel|type your message|enter to (send|confirm|select)/i,
  /^[│|┃]\s*[>❯›]/,
  /^[❯›>]\s*\d+\.\s/,
];

export function isPromptLike(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  return PROMPT_PATTERNS.some((r) => r.test(t));
}

export function classifyStatus(s: {
  exited: boolean;
  lastOutputAt: number;
  lastLine: string;
  now: number;
}): AgentStatus {
  if (s.exited) return 'exited';
  const quiet = s.now - s.lastOutputAt;
  if (quiet <= RUNNING_WINDOW_MS) return 'running';
  if (quiet > WAITING_AFTER_MS && isPromptLike(s.lastLine)) return 'waiting';
  return 'idle';
}

/** Longest `worktreePaths` entry that contains `cwd` (case-insensitive on Windows), or null. */
export function worktreeFor(cwd: string, worktreePaths: string[], platform: NodeJS.Platform): string | null {
  const norm = (p: string): string => {
    const n = p.replace(/\\/g, '/').replace(/\/+$/, '');
    return platform === 'win32' || platform === 'darwin' ? n.toLowerCase() : n;
  };
  const c = norm(cwd);
  let best: string | null = null;
  let bestLen = -1;
  for (const w of worktreePaths) {
    const n = norm(w);
    if (!n) continue;
    if ((c === n || c.startsWith(`${n}/`)) && n.length > bestLen) {
      best = w;
      bestLen = n.length;
    }
  }
  return best;
}
