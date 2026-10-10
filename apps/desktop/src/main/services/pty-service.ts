import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type {
  TerminalAttachResult,
  TerminalCompletionContext,
  TerminalCreateRequest,
  TerminalEventContract,
  TerminalId,
  TerminalInfo,
  TerminalShell,
} from '../../shared/ipc/terminal-contract';
import { createCompletionContextProvider } from '../terminal/completion-context';
import { detectShells, systemShellProbe } from '../terminal/list-shells';
import { OscScanner, type ShellEvent } from '../terminal/osc';
import { applyShellIntegration, createScriptsDir, type ScriptFiles } from '../terminal/shell-integration';

/**
 * Integrated terminal backend (spec 12 §4.2). Owns node-pty processes, batches their
 * output (~16 ms) to cut IPC chatter, applies simple ack-based flow control, and ties
 * every pty to the webContents that created it so a closed window kills its shells.
 */

// ---- minimal node-pty surface (keeps the module injectable for tests) ----

export interface PtyDisposable {
  dispose(): void;
}

export interface PtyProcess {
  readonly pid: number;
  /** Foreground process name (macOS/Linux); on Windows it is the spawned program. */
  readonly process?: string;
  onData(listener: (data: string) => void): PtyDisposable;
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): PtyDisposable;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  pause(): void;
  resume(): void;
}

export interface PtySpawnOptions {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
  useConpty?: boolean;
}

export interface PtyModule {
  spawn(file: string, args: string[], options: PtySpawnOptions): PtyProcess;
}

/** Default loader: the N-API prebuilt node-pty, loaded lazily on first terminal. */
export async function loadNodePty(): Promise<PtyModule> {
  const mod = (await import('@lydell/node-pty')) as unknown as PtyModule & { default?: PtyModule };
  return typeof mod.spawn === 'function' ? mod : mod.default!;
}

// ---- shell resolution ----

export interface ShellChoice {
  shell: string;
  args: string[];
}

export interface ShellEnv {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** Returns the absolute path of `exe` if found on PATH. */
  findOnPath(exe: string): string | null;
}

export function findOnPath(exe: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, exe);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

/**
 * Terminal env with the bundled git as a last-resort PATH entry (spec 15 §6.2: works without a
 * system git). A git already on PATH always wins; the bundled one is only appended when none is found.
 */
export function withBundledGitOnPath(
  env: NodeJS.ProcessEnv,
  bundledGitDir: string | undefined,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = (p) => fs.existsSync(p),
): NodeJS.ProcessEnv {
  if (!bundledGitDir) return env;
  const exe = platform === 'win32' ? 'git.exe' : 'git';
  const binDir = path.join(bundledGitDir, platform === 'win32' ? 'cmd' : 'bin');
  if (!exists(path.join(binDir, exe))) return env;
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const delimiter = platform === 'win32' ? ';' : ':';
  const dirs = (env[key] ?? '').split(delimiter).filter(Boolean);
  if (dirs.some((d) => exists(path.join(d, exe)))) return env;
  return { ...env, [key]: [...dirs, binDir].join(delimiter) };
}

const shellBase = (shell: string): string =>
  path
    .basename(shell.replace(/\\/g, '/'))
    .replace(/\.exe$/i, '')
    .toLowerCase();

/** Default args for a shell: login shells on Unix, no banner for PowerShell, login for Git Bash. */
export function defaultArgsFor(shell: string, platform: NodeJS.Platform): string[] {
  const base = shellBase(shell);
  if (base === 'pwsh' || base === 'powershell') return ['-NoLogo'];
  if (platform === 'win32') return base === 'bash' ? ['--login', '-i'] : [];
  if (['bash', 'zsh', 'sh', 'fish', 'ksh', 'dash'].includes(base)) return ['-l'];
  return [];
}

/** OS default shell: Windows → pwsh (if on PATH) → Windows PowerShell → COMSPEC; else $SHELL → /bin/bash. */
export function resolveDefaultShell(e: ShellEnv): ShellChoice {
  let shell: string;
  if (e.platform === 'win32') {
    const sysRoot = e.env.SystemRoot ?? e.env.SYSTEMROOT ?? 'C:\\Windows';
    const winPs = path.win32.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    shell =
      e.findOnPath('pwsh.exe') ??
      e.findOnPath('powershell.exe') ??
      (fs.existsSync(winPs) ? winPs : (e.env.COMSPEC ?? e.env.ComSpec ?? 'cmd.exe'));
  } else {
    shell = e.env.SHELL || '/bin/bash';
  }
  return { shell, args: defaultArgsFor(shell, e.platform) };
}

export const shellDisplayName = (shell: string): string => shellBase(shell);

// ---- command launch (agent sessions) ----

export interface CommandLaunchEnv {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  findOnPath(exe: string): string | null;
  isFile(p: string): boolean;
  /** The user's shell (non-Windows): POSIX shells start the command as a login shell for PATH. */
  shell: string;
}

const POSIX_SHELLS = new Set(['bash', 'zsh', 'sh', 'ksh', 'dash']);
/** cmd.exe re-parses `.cmd` / `.bat` arguments; refuse anything it would interpret. */
const CMD_UNSAFE = /[&|<>^%!"\r\n]/;

/**
 * Turns `command` + `args` into what node-pty should spawn, without ever building a shell
 * command line from user data: on Windows the command is resolved via PATH/PATHEXT (`.cmd`/`.bat`
 * shims go through `cmd.exe /d /c` with metacharacter-free args); elsewhere a POSIX login shell
 * runs the constant script `exec "$0" "$@"` so the user's PATH applies.
 */
export function resolveCommandLaunch(
  command: string,
  args: string[],
  e: CommandLaunchEnv,
): { file: string; args: string[] } {
  if (!command.trim()) throw new Error('No agent command configured');
  if (e.platform === 'win32') {
    const hasDir = /[\\/]/.test(command);
    const exts = path.win32.extname(command)
      ? ['']
      : (e.env.PATHEXT ?? e.env.PathExt ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
    let resolved: string | null = null;
    for (const ext of exts) {
      const cand = command + ext;
      resolved = hasDir ? (e.isFile(cand) ? cand : null) : e.findOnPath(cand);
      if (resolved) break;
    }
    if (!resolved) throw new Error(`Could not find "${command}" on PATH`);
    if (/\.(cmd|bat)$/i.test(resolved)) {
      if ([resolved, ...args].some((a) => CMD_UNSAFE.test(a))) {
        throw new Error(`Cannot pass these arguments safely to ${path.win32.basename(resolved)}`);
      }
      const comspec = e.env.ComSpec ?? e.env.COMSPEC ?? 'cmd.exe';
      return { file: comspec, args: ['/d', '/c', resolved, ...args] };
    }
    return { file: resolved, args };
  }
  if (POSIX_SHELLS.has(shellBase(e.shell))) {
    return { file: e.shell, args: ['-l', '-c', 'exec "$0" "$@"', command, ...args] };
  }
  return { file: command, args };
}

// ---- output tracking (agent status) ----

/** Strips CSI / OSC / other escape sequences and C0 controls (except LF / CR). */
export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC … BEL / ST
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '') // CSI
    .replace(/\x1b[PX^_][^\x1b]*\x1b\\/g, '') // DCS / SOS / PM / APC
    .replace(/\x1b[()#][0-9A-Za-z]|\x1b[@-Z\\-_]/g, '') // charset selects, two-char escapes
    .replace(/[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/g, (c) => (c === '\t' ? ' ' : ''));
}

/** Last non-empty (visible) line of a chunk of terminal output. */
export function lastNonEmptyLine(raw: string): string {
  const lines = stripAnsi(raw).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const segs = lines[i]!.split('\r');
    // After a bare CR the terminal overwrites from column 0; the last non-empty segment wins.
    for (let j = segs.length - 1; j >= 0; j--) {
      const t = segs[j]!.trim();
      if (t) return t;
    }
  }
  return '';
}

// ---- service ----

type TerminalEvent = keyof TerminalEventContract;

export interface PtyServiceOptions {
  /** Deliver an event to one window (by webContents id). */
  send<E extends TerminalEvent>(ownerId: number, event: E, payload: TerminalEventContract[E]): void;
  /** Called once per owner on its first terminal; call `onGone` when that window is destroyed/reloaded. */
  watchOwner?(ownerId: number, onGone: () => void): void;
  /** Injectable pty module (tests); defaults to `@lydell/node-pty`. */
  loadPty?: () => PtyModule | Promise<PtyModule>;
  /** User-configured default shell (spec 13 In-App Terminal); falls back to the OS default. */
  defaultShell?: () => Partial<ShellChoice> | undefined;
  /** Output coalescing window in ms (default 16). */
  batchMs?: number;
  /** Flush immediately once a batch reaches this many chars (default 64 KiB). */
  maxBatchChars?: number;
  /** Pause the pty when this many chars are un-acked by the renderer (default 512 KiB). */
  highWatermark?: number;
  /** Resume once un-acked chars drop below this (default 64 KiB). */
  lowWatermark?: number;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  findOnPath?: (exe: string) => string | null;
  homedir?: () => string;
  /** Clock (tests). */
  now?: () => number;
  /** Max chars of output kept per command session for `terminal:attach` replay (default 512 KiB). */
  historyChars?: number;
  /** Writes the shell-integration scripts (tests); default: a private temp folder per process. */
  shellIntegrationScripts?: () => ScriptFiles;
  /** Shell picker source (tests); default: probes the system. */
  listShells?: () => Promise<TerminalShell[]>;
  /** Autocomplete aliases / conflict source (tests); default: `git` on PATH + env heuristics. */
  completionContext?: (cwd: string) => Promise<TerminalCompletionContext>;
}

/** An interactive shell that runs typed commands (agent sessions with setup commands). */
export interface PtyShellCommandRequest {
  cwd: string;
  /** Agent the shell will run (for the Agents view; typed into the shell by the caller). */
  launched: { command: string; args: string[] };
  label?: string;
  cols?: number;
  rows?: number;
}

/** A command (agent) to run directly in a pty. */
export interface PtyCommandRequest {
  cwd: string;
  command: string;
  args: string[];
  /** Tab label, e.g. `claude — feature-x`. */
  label?: string;
  cols?: number;
  rows?: number;
}

/** Point-in-time view of a pty for the Agents view (spec 12 §4.12). */
export interface PtySessionSnapshot {
  id: TerminalId;
  owner: number;
  pid: number;
  cwd: string;
  label?: string;
  /** Command started directly (agent sessions), else undefined for shells. */
  launched?: { command: string; args: string[] };
  shell: string;
  /** node-pty foreground process name (meaningful on macOS/Linux only). */
  process?: string;
  startedAt: number;
  lastOutputAt: number;
  /** Last non-empty line of output (ANSI stripped), for prompt detection. */
  lastLine: string;
  /** A view is bound to this pty. */
  attached: boolean;
  exited?: { exitCode: number; at: number };
  /** Last cwd reported via OSC 7. */
  currentCwd?: string;
}

export type PtyChange =
  | { type: 'created'; id: TerminalId; owner: number }
  | { type: 'exited'; id: TerminalId; owner: number }
  | { type: 'killed'; id: TerminalId; owner: number };

interface Session {
  info: TerminalInfo;
  owner: number;
  pty: PtyProcess;
  buf: string;
  timer: ReturnType<typeof setTimeout> | null;
  unacked: number;
  paused: boolean;
  subs: PtyDisposable[];
  /** False while no view is bound: output is only recorded into `history`. */
  attached: boolean;
  /** Rolling output for re-attach (command sessions only). */
  history: string | null;
  startedAt: number;
  lastOutputAt: number;
  /** Raw tail of the output, for last-line detection. */
  tail: string;
  launched?: { command: string; args: string[] };
  scanner: OscScanner;
  shellListeners: Set<(e: ShellEvent) => void>;
}

const TAIL_CHARS = 4096;
/** How long exited command sessions stay listed (status `exited`) unless dismissed. */
const TOMBSTONE_MS = 60 * 60 * 1000;

/** Env vars from Electron that must not leak into user shells. */
const STRIP_ENV = ['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE', 'ELECTRON_ENABLE_LOGGING'];

export class PtyService {
  private readonly sessions = new Map<TerminalId, Session>();
  /** Exited command sessions, kept so the Agents view can show them as `exited`. */
  private readonly tombstones = new Map<TerminalId, PtySessionSnapshot>();
  private readonly watched = new Set<number>();
  private readonly listeners = new Set<(c: PtyChange) => void>();
  private ptyModule: Promise<PtyModule> | null = null;
  private seq = 0;
  private disposed = false;

  private readonly batchMs: number;
  private readonly maxBatch: number;
  private readonly high: number;
  private readonly low: number;
  private readonly historyChars: number;
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;
  private scripts: ScriptFiles | null = null;
  private shellsCache: { at: number; value: Promise<TerminalShell[]> } | null = null;
  private completionCtx: ((cwd: string) => Promise<TerminalCompletionContext>) | null = null;

  constructor(private readonly opts: PtyServiceOptions) {
    this.batchMs = opts.batchMs ?? 16;
    this.maxBatch = opts.maxBatchChars ?? 64 * 1024;
    this.high = opts.highWatermark ?? 512 * 1024;
    this.low = opts.lowWatermark ?? 64 * 1024;
    this.historyChars = opts.historyChars ?? 512 * 1024;
    this.platform = opts.platform ?? process.platform;
    this.env = opts.env ?? process.env;
    this.now = opts.now ?? Date.now;
  }

  private loadPty(): Promise<PtyModule> {
    this.ptyModule ??= Promise.resolve((this.opts.loadPty ?? loadNodePty)()).catch((e: unknown) => {
      this.ptyModule = null; // allow a retry
      throw e;
    });
    return this.ptyModule;
  }

  /** Subscribe to session lifecycle changes (Agents view). Returns an unsubscribe function. */
  onChange(listener: (c: PtyChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(c: PtyChange): void {
    for (const l of [...this.listeners]) safe(() => l(c));
  }

  resolveShell(req: Pick<TerminalCreateRequest, 'shell' | 'args'>): ShellChoice {
    const configured = this.opts.defaultShell?.();
    const shell = req.shell || configured?.shell;
    if (shell) {
      const args =
        req.args ?? (req.shell ? undefined : configured?.args) ?? defaultArgsFor(shell, this.platform);
      return { shell, args };
    }
    const def = resolveDefaultShell({
      platform: this.platform,
      env: this.env,
      findOnPath: this.findExe,
    });
    return req.args ? { shell: def.shell, args: req.args } : def;
  }

  private readonly findExe = (exe: string): string | null =>
    (this.opts.findOnPath ?? ((e: string) => findOnPath(e, this.env)))(exe);

  private resolveCwd(cwd: string): string {
    try {
      if (cwd && fs.statSync(cwd).isDirectory()) return cwd;
    } catch {
      // fall through
    }
    return (this.opts.homedir ?? os.homedir)();
  }

  private buildEnv(repoPath?: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.env)) if (v !== undefined) env[k] = v;
    for (const k of STRIP_ENV) delete env[k];
    env.TERM = 'xterm-256color';
    env.COLORTERM = 'truecolor';
    env.TERM_PROGRAM = 'GitHappens';
    if (repoPath) env.GITHAPPENS_REPO = repoPath;
    return env;
  }

  /** Args / env for `shell`, with the OSC 7 / 133 snippet injected when supported (spec 12 §6.1). */
  private integrate(
    shell: string,
    args: string[],
    env: Record<string, string>,
  ): { args: string[]; env: Record<string, string>; injected: boolean } {
    const defaults = defaultArgsFor(shell, this.platform);
    const isDefault = args.length === defaults.length && args.every((a, i) => a === defaults[i]);
    if (!isDefault) return { args, env, injected: false };
    try {
      this.scripts ??= (this.opts.shellIntegrationScripts ?? createScriptsDir)();
    } catch {
      return { args, env, injected: false }; // no writable temp dir: run the shell unmodified
    }
    return applyShellIntegration({
      shell,
      args,
      defaultArgs: true,
      platform: this.platform,
      env,
      scripts: this.scripts,
    });
  }

  async create(ownerId: number, req: TerminalCreateRequest): Promise<TerminalInfo> {
    if (this.disposed) throw new Error('Terminal service is shut down');
    const pty = await this.loadPty();
    const { shell, args } = this.resolveShell(req);
    const cwd = this.resolveCwd(req.cwd);
    let env = this.buildEnv(req.repoPath || cwd);
    let spawnArgs = args;
    let injected = false;
    if (req.shellIntegration) ({ args: spawnArgs, env, injected } = this.integrate(shell, args, env));
    return this.spawn(ownerId, pty, shell, spawnArgs, cwd, req.cols, req.rows, {
      attached: true,
      label: shell,
      env,
      shellIntegration: injected,
    });
  }

  /**
   * An interactive (integrated) shell for an agent session whose setup commands are typed into
   * it visibly (spec 12 §4.12). Like `createCommand`, it starts detached and records its output.
   */
  async createShellCommand(ownerId: number, req: PtyShellCommandRequest): Promise<TerminalInfo> {
    if (this.disposed) throw new Error('Terminal service is shut down');
    const pty = await this.loadPty();
    const { shell, args } = this.resolveShell({});
    const cwd = this.resolveCwd(req.cwd);
    const r = this.integrate(shell, args, this.buildEnv(cwd));
    return this.spawn(ownerId, pty, shell, r.args, cwd, req.cols ?? 80, req.rows ?? 24, {
      attached: false,
      label: shell,
      tabLabel: req.label,
      launched: { command: req.launched.command, args: [...req.launched.args] },
      env: r.env,
      shellIntegration: r.injected,
      shellName: shellDisplayName(shell),
    });
  }

  /** Shell-integration events (OSC 7 / 133) of one pty; returns an unsubscribe function. */
  onShellEvent(id: TerminalId, listener: (e: ShellEvent) => void): () => void {
    const s = this.sessions.get(id);
    if (!s) return () => undefined;
    s.shellListeners.add(listener);
    return () => s.shellListeners.delete(listener);
  }

  /** Shells for the picker (cached for a minute; WSL enumeration is slow). */
  listShells(): Promise<TerminalShell[]> {
    const now = this.now();
    if (!this.shellsCache || now - this.shellsCache.at > 60_000) {
      const probe =
        this.opts.listShells ?? (() => detectShells(systemShellProbe(this.platform, this.env, this.findExe)));
      this.shellsCache = { at: now, value: probe().catch(() => [] as TerminalShell[]) };
    }
    return this.shellsCache.value;
  }

  /** Git aliases + completion-conflict detection for the autocomplete popup. */
  completionContext(cwd: string): Promise<TerminalCompletionContext> {
    this.completionCtx ??= this.opts.completionContext ?? createCompletionContextProvider({ env: this.env });
    return this.completionCtx(cwd);
  }

  /**
   * Starts `command args` directly in a pty (an agent session, spec 12 §4.12). The pty is not
   * attached to a view: output is recorded until `attach()` and streamed afterwards.
   */
  async createCommand(ownerId: number, req: PtyCommandRequest): Promise<TerminalInfo> {
    if (this.disposed) throw new Error('Terminal service is shut down');
    const pty = await this.loadPty();
    const cwd = this.resolveCwd(req.cwd);
    const launch = resolveCommandLaunch(req.command, req.args, {
      platform: this.platform,
      env: this.env,
      findOnPath: this.findExe,
      isFile: (p) => {
        try {
          return fs.statSync(p).isFile();
        } catch {
          return false;
        }
      },
      shell: this.platform === 'win32' ? '' : this.resolveShell({}).shell,
    });
    return this.spawn(ownerId, pty, launch.file, launch.args, cwd, req.cols ?? 80, req.rows ?? 24, {
      attached: false,
      label: req.command,
      tabLabel: req.label,
      launched: { command: req.command, args: [...req.args] },
      env: this.buildEnv(cwd),
    });
  }

  private spawn(
    ownerId: number,
    pty: PtyModule,
    file: string,
    args: string[],
    cwd: string,
    reqCols: number,
    reqRows: number,
    o: {
      attached: boolean;
      label: string;
      tabLabel?: string;
      launched?: Session['launched'];
      env: Record<string, string>;
      shellIntegration?: boolean;
      /** Display name override (shell sessions running an agent). */
      shellName?: string;
    },
  ): TerminalInfo {
    const cols = clampDim(reqCols, 80);
    const rows = clampDim(reqRows, 24);
    let proc: PtyProcess;
    try {
      proc = pty.spawn(file, args, { name: 'xterm-256color', cols, rows, cwd, env: o.env });
    } catch (e) {
      throw new Error(`Could not start ${o.label}: ${e instanceof Error ? e.message : String(e)}`, {
        cause: e,
      });
    }

    const id = `term-${++this.seq}`;
    const info: TerminalInfo = {
      id,
      pid: proc.pid,
      shell: file,
      shellName: o.shellName ?? (o.launched ? shellDisplayName(o.launched.command) : shellDisplayName(file)),
      cwd,
    };
    if (o.shellIntegration) info.shellIntegration = true;
    if (o.tabLabel) info.label = o.tabLabel;
    if (o.launched) info.command = o.launched.command;
    const now = this.now();
    const s: Session = {
      info,
      owner: ownerId,
      pty: proc,
      buf: '',
      timer: null,
      unacked: 0,
      paused: false,
      subs: [],
      attached: o.attached,
      history: o.launched ? '' : null,
      startedAt: now,
      lastOutputAt: now,
      tail: '',
      launched: o.launched,
      scanner: new OscScanner(this.platform),
      shellListeners: new Set(),
    };
    this.sessions.set(id, s);
    s.subs.push(
      proc.onData((d) => this.onData(s, d)),
      proc.onExit(({ exitCode, signal }) => this.onExit(s, exitCode, signal)),
    );

    if (!this.watched.has(ownerId)) {
      this.watched.add(ownerId);
      this.opts.watchOwner?.(ownerId, () => {
        this.watched.delete(ownerId);
        this.killOwner(ownerId);
      });
    }
    this.emit({ type: 'created', id, owner: ownerId });
    return info;
  }

  private onData(s: Session, data: string): void {
    if (this.sessions.get(s.info.id) !== s) return;
    s.lastOutputAt = this.now();
    s.tail = (s.tail + (data.length > TAIL_CHARS ? data.slice(-TAIL_CHARS) : data)).slice(-TAIL_CHARS);
    for (const ev of s.scanner.feed(data)) {
      if (ev.kind === 'cwd') s.info.currentCwd = ev.cwd;
      for (const l of [...s.shellListeners]) safe(() => l(ev));
    }
    s.buf += data;
    if (s.buf.length >= this.maxBatch) this.flush(s);
    else s.timer ??= setTimeout(() => this.flush(s), this.batchMs);
  }

  private flush(s: Session): void {
    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
    if (!s.buf) return;
    const data = s.buf;
    s.buf = '';
    if (s.history !== null) s.history = trimHistory(s.history + data, this.historyChars);
    if (!s.attached) return;
    s.unacked += data.length;
    if (!s.paused && s.unacked > this.high) {
      s.paused = true;
      safe(() => s.pty.pause());
    }
    this.opts.send(s.owner, 'terminal:data', { id: s.info.id, data });
  }

  private onExit(s: Session, exitCode: number, signal?: number): void {
    if (this.sessions.get(s.info.id) !== s) return;
    this.flush(s);
    if (s.launched) {
      const snap = this.snapshotOf(s);
      snap.exited = { exitCode, at: this.now() };
      this.addTombstone(snap);
    }
    this.cleanup(s);
    this.opts.send(
      s.owner,
      'terminal:exit',
      signal ? { id: s.info.id, exitCode, signal } : { id: s.info.id, exitCode },
    );
    this.emit({ type: 'exited', id: s.info.id, owner: s.owner });
  }

  private addTombstone(snap: PtySessionSnapshot): void {
    const cutoff = this.now() - TOMBSTONE_MS;
    for (const [k, t] of this.tombstones) if ((t.exited?.at ?? 0) < cutoff) this.tombstones.delete(k);
    this.tombstones.set(snap.id, snap);
  }

  private cleanup(s: Session): void {
    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
    s.buf = '';
    for (const d of s.subs) safe(() => d.dispose());
    s.subs = [];
    s.shellListeners.clear();
    this.sessions.delete(s.info.id);
  }

  private get(ownerId: number, id: TerminalId): Session {
    const s = this.sessions.get(id);
    if (!s || s.owner !== ownerId) throw new Error(`Unknown terminal: ${id}`);
    return s;
  }

  write(ownerId: number, id: TerminalId, data: string): void {
    this.get(ownerId, id).pty.write(data);
  }

  resize(ownerId: number, id: TerminalId, cols: number, rows: number): void {
    const s = this.get(ownerId, id);
    safe(() => s.pty.resize(clampDim(cols, 80), clampDim(rows, 24)));
  }

  /** Flow control: renderer has rendered `chars` more chars of output. */
  ack(ownerId: number, id: TerminalId, chars: number): void {
    const s = this.sessions.get(id);
    if (!s || s.owner !== ownerId) return; // late ack after exit is harmless
    s.unacked = Math.max(0, s.unacked - Math.max(0, chars));
    if (s.paused && s.unacked < this.low) {
      s.paused = false;
      safe(() => s.pty.resume());
    }
  }

  /**
   * Binds a view to a running pty: returns the recorded output (command sessions) and streams
   * `terminal:data` from now on. Shell sessions have no history (their view never detaches).
   */
  attach(ownerId: number, id: TerminalId, cols: number, rows: number): TerminalAttachResult {
    const s = this.get(ownerId, id);
    this.flush(s);
    s.attached = true;
    s.unacked = 0;
    if (s.paused) {
      s.paused = false;
      safe(() => s.pty.resume());
    }
    safe(() => s.pty.resize(clampDim(cols, 80), clampDim(rows, 24)));
    return { info: { ...s.info, pid: s.pty.pid || s.info.pid }, backlog: s.history ?? '' };
  }

  /** The view went away; keep the pty running and only record its output. */
  detach(ownerId: number, id: TerminalId): void {
    const s = this.sessions.get(id);
    if (!s || s.owner !== ownerId) return;
    this.flush(s);
    s.attached = false;
    s.unacked = 0;
    if (s.paused) {
      s.paused = false;
      safe(() => s.pty.resume());
    }
  }

  /**
   * Ends the process but keeps the session until node-pty reports the exit, so views get
   * `terminal:exit` (unlike `kill`, which drops the session silently).
   */
  terminateProcess(ownerId: number, id: TerminalId): void {
    const s = this.get(ownerId, id);
    safe(() => s.pty.kill());
  }

  /** Kill one terminal (or dismiss an exited one). No `terminal:exit` is sent for explicit kills. */
  kill(ownerId: number, id: TerminalId): void {
    const t = this.tombstones.get(id);
    if (t && t.owner === ownerId) {
      this.tombstones.delete(id);
      this.emit({ type: 'killed', id, owner: ownerId });
      return;
    }
    const s = this.sessions.get(id);
    if (!s || s.owner !== ownerId) return;
    this.terminate(s);
  }

  private terminate(s: Session): void {
    this.cleanup(s);
    safe(() => s.pty.kill());
    this.emit({ type: 'killed', id: s.info.id, owner: s.owner });
  }

  list(ownerId: number): TerminalInfo[] {
    return [...this.sessions.values()]
      .filter((s) => s.owner === ownerId)
      .map((s) => ({ ...s.info, pid: s.pty.pid || s.info.pid }));
  }

  private snapshotOf(s: Session): PtySessionSnapshot {
    let fg: string | undefined;
    try {
      fg = s.pty.process || undefined;
    } catch {
      fg = undefined;
    }
    const snap: PtySessionSnapshot = {
      id: s.info.id,
      owner: s.owner,
      pid: s.pty.pid || s.info.pid,
      cwd: s.info.cwd,
      shell: s.info.shell,
      startedAt: s.startedAt,
      lastOutputAt: s.lastOutputAt,
      lastLine: lastNonEmptyLine(s.tail),
      attached: s.attached,
    };
    if (s.info.label) snap.label = s.info.label;
    if (s.info.currentCwd) snap.currentCwd = s.info.currentCwd;
    if (s.launched) snap.launched = { command: s.launched.command, args: [...s.launched.args] };
    if (fg) snap.process = fg;
    return snap;
  }

  /** Live sessions (and exited command sessions) for the Agents view; all owners when omitted. */
  snapshots(ownerId?: number): PtySessionSnapshot[] {
    const live = [...this.sessions.values()]
      .filter((s) => ownerId === undefined || s.owner === ownerId)
      .map((s) => this.snapshotOf(s));
    const dead = [...this.tombstones.values()].filter((t) => ownerId === undefined || t.owner === ownerId);
    return [...live, ...dead.map((t) => ({ ...t }))];
  }

  /** Kill every terminal owned by a window (closed, crashed, or reloaded). */
  killOwner(ownerId: number): void {
    for (const s of [...this.sessions.values()]) if (s.owner === ownerId) this.terminate(s);
    for (const [k, t] of this.tombstones) if (t.owner === ownerId) this.tombstones.delete(k);
  }

  get size(): number {
    return this.sessions.size;
  }

  /** Kill everything (app quit). The service refuses new terminals afterwards. */
  dispose(): void {
    this.disposed = true;
    for (const s of [...this.sessions.values()]) this.terminate(s);
    this.tombstones.clear();
    this.watched.clear();
    this.listeners.clear();
  }
}

/** Keeps the newest `max` chars, cutting at a line break so replay starts on a clean line. */
function trimHistory(h: string, max: number): string {
  if (h.length <= max) return h;
  const cut = h.slice(h.length - max);
  const nl = cut.indexOf('\n');
  return nl >= 0 && nl < 4096 ? cut.slice(nl + 1) : cut;
}

// ---- Electron glue (structural, so this module never imports electron) ----

export interface OwnerWebContents {
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
  once(event: 'destroyed' | 'render-process-gone' | 'did-navigate', listener: () => void): unknown;
}

/**
 * Builds `send` / `watchOwner` for Electron: pass `(id) => webContents.fromId(id)`.
 * A window that is destroyed, crashes or navigates (reload) loses its terminals.
 */
export function webContentsOwnerHooks(
  fromId: (id: number) => OwnerWebContents | undefined | null,
): Pick<PtyServiceOptions, 'send' | 'watchOwner'> {
  return {
    send(ownerId, event, payload) {
      const wc = fromId(ownerId);
      if (wc && !wc.isDestroyed()) wc.send(event, payload);
    },
    watchOwner(ownerId, onGone) {
      const wc = fromId(ownerId);
      if (!wc || wc.isDestroyed()) return onGone();
      let fired = false;
      const once = (): void => {
        if (fired) return;
        fired = true;
        onGone();
      };
      wc.once('destroyed', once);
      wc.once('render-process-gone', once);
      wc.once('did-navigate', once);
    },
  };
}

function clampDim(n: number, fallback: number): number {
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 4096) : fallback;
}

function safe(fn: () => void): void {
  try {
    fn();
  } catch {
    // pty already gone
  }
}
