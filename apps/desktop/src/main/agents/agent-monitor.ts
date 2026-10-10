import fs from 'node:fs';
import path from 'node:path';

import type {
  AgentKind,
  AgentSession,
  AgentsEventContract,
  AgentStartRequest,
  AgentStartResult,
} from '../../shared/ipc/agents-contract';
import type { TerminalId } from '../../shared/ipc/terminal-contract';
import { quoteCommandLine, shellKindOf } from '../../shared/terminal/shell-quote';
import type { PtyService, PtySessionSnapshot } from '../services/pty-service';
import {
  markSetupRan,
  readSetupCommands,
  runSetupSequence,
  setupAlreadyRan,
  type GitExec,
  type SetupRunResult,
} from './agent-setup';
import {
  agentKindOfName,
  agentKindOfProcess,
  classifyStatus,
  descendantsOf,
  exeBase,
  findAgentProcess,
  worktreeFor,
  type ProcInfo,
} from './agent-detect';
import type { ProcessProbe } from './process-probe';

export interface AgentMonitorOptions {
  ptys: PtyService;
  /** `tools.agentCommand` (spec 13). */
  agentCommand(): string;
  /** `tools.agentArgs` (spec 13). */
  agentArgs(): string[];
  /** Deliver `agents:changed` (broadcast; renderers re-list). */
  emit(payload: AgentsEventContract['agents:changed']): void;
  /** OS process inspection (Windows child detection, external sessions); omit to disable. */
  probe?: ProcessProbe;
  platform?: NodeJS.Platform;
  now?: () => number;
  /** Minimum ms between process-table probes (default 4000). */
  probeIntervalMs?: number;
  /** Status re-evaluation period while the view is in use (default 1000). */
  tickMs?: number;
  /** Keep ticking this long after the last `list` call (default 30 s). */
  activeMs?: number;
  /** Folder check for `start` (tests). */
  isDirectory?(p: string): boolean;
  /** Reads `githappens.agentSetup` / the once-per-worktree marker; omit to never run setup commands. */
  git?: GitExec;
  /** Setup sequencing finished (tests / toasts). */
  onSetupDone?(ptyId: TerminalId, result: SetupRunResult): void;
}

interface Detected {
  kind: AgentKind;
  command: string;
  pid: number;
  since: number;
}

interface External {
  pid: number;
  kind: AgentKind;
  command: string;
  cwd: string;
  since: number;
}

const basename = (p: string): string =>
  p
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() || p;

/**
 * Agent session detection and status (spec 12 §4.12). Reads PtyService snapshots; on Windows
 * (where node-pty's foreground process is always the shell) and for interpreters such as `node`,
 * it walks the shell's child processes from a throttled OS process listing. Ticks only while a
 * renderer has listed sessions recently, emitting `agents:changed` when statuses change.
 */
export class AgentMonitor {
  private readonly detected = new Map<TerminalId, Detected>();
  /** First time a (non-launched) pty's foreground process looked like an agent. */
  private readonly fgSince = new Map<TerminalId, { kind: AgentKind; since: number }>();
  private externals: External[] = [];
  private externalPaths: string[] = [];
  private wantExternal = false;
  private lastProbe = Number.NEGATIVE_INFINITY;
  private probing: Promise<void> | null = null;
  private lastListAt = Number.NEGATIVE_INFINITY;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSig = '';
  private readonly unsub: () => void;
  private readonly platform: NodeJS.Platform;
  private readonly now: () => number;

  constructor(private readonly o: AgentMonitorOptions) {
    this.platform = o.platform ?? process.platform;
    this.now = o.now ?? Date.now;
    this.unsub = o.ptys.onChange((c) => {
      if (c.type === 'killed') {
        this.detected.delete(c.id);
        this.fgSince.delete(c.id);
      }
      this.o.emit({ reason: c.type === 'created' ? 'started' : c.type === 'exited' ? 'exited' : 'stopped' });
    });
  }

  private custom(): string {
    return this.o.agentCommand()?.trim() || 'claude';
  }

  /** Sessions of `ownerId` (plus external ones) mapped onto `worktreePaths`. */
  list(ownerId: number, worktreePaths: string[], external = false): AgentSession[] {
    this.lastListAt = this.now();
    if (external) {
      this.wantExternal = true;
      this.externalPaths = [...new Set([...this.externalPaths, ...worktreePaths])].slice(-200);
    }
    this.ensureTicker();
    void this.refresh();
    return this.compute(ownerId, worktreePaths, external);
  }

  async start(ownerId: number, req: AgentStartRequest): Promise<AgentStartResult> {
    const isDir =
      this.o.isDirectory ??
      ((p: string) => {
        try {
          return fs.statSync(p).isDirectory();
        } catch {
          return false;
        }
      });
    if (!req.cwd || !isDir(req.cwd)) throw new Error(`Folder not found: ${req.cwd}`);
    const command = req.command?.trim() || this.custom();
    const args = req.args ?? (req.command ? [] : this.o.agentArgs());
    const label = `${exeBase(command)} — ${basename(req.cwd)}`;

    // Repo agent setup commands (once per worktree unless forced): typed visibly into a shell.
    const git = this.o.git;
    if (git && req.setup !== 'skip') {
      const setup = await readSetupCommands(git, req.cwd).catch(() => [] as string[]);
      if (setup.length && (req.setup === 'force' || !(await setupAlreadyRan(git, req.cwd, setup)))) {
        const info = await this.o.ptys.createShellCommand(ownerId, {
          cwd: req.cwd,
          launched: { command, args },
          label,
          cols: req.cols,
          rows: req.rows,
        });
        const ptys = this.o.ptys;
        const line = quoteCommandLine(command, args, shellKindOf(info.shell));
        void runSetupSequence(
          {
            write: (d) => {
              try {
                ptys.write(ownerId, info.id, d);
              } catch {
                // session gone
              }
            },
            onShellEvent: (l) => ptys.onShellEvent(info.id, l),
            integrated: !!info.shellIntegration,
          },
          setup,
          line,
        ).then(async (r) => {
          if (r.ok) await markSetupRan(git, req.cwd, setup);
          this.o.onSetupDone?.(info.id, r);
        });
        return { ptyId: info.id, label, setupCommands: setup };
      }
    }

    const info = await this.o.ptys.createCommand(ownerId, {
      cwd: req.cwd,
      command,
      args,
      label,
      cols: req.cols,
      rows: req.rows,
    });
    return { ptyId: info.id, label };
  }

  /** Ctrl+C; `force` kills the process; an exited session is dismissed. */
  stop(ownerId: number, ptyId: TerminalId, force = false): void {
    const snap = this.o.ptys.snapshots(ownerId).find((s) => s.id === ptyId);
    if (!snap) throw new Error(`Unknown agent session: ${ptyId}`);
    if (snap.exited) this.o.ptys.kill(ownerId, ptyId);
    else if (force) this.o.ptys.terminateProcess(ownerId, ptyId);
    else this.o.ptys.write(ownerId, ptyId, '\x03');
  }

  dispose(): void {
    this.unsub();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ---- detection ----

  /** Agent identity of one pty snapshot, or null when it is a plain shell. */
  private identify(s: PtySessionSnapshot): Detected | null {
    if (s.launched) {
      return {
        kind: agentKindOfName(s.launched.command, this.custom()) ?? 'custom',
        command: exeBase(s.launched.command),
        pid: s.pid,
        since: s.startedAt,
      };
    }
    if (s.exited) return null;
    // node-pty's foreground process name (macOS/Linux); on Windows it is just the shell.
    if (this.platform !== 'win32' && s.process) {
      const kind = agentKindOfName(s.process, this.custom());
      if (kind) {
        let f = this.fgSince.get(s.id);
        if (!f || f.kind !== kind) {
          f = { kind, since: this.now() };
          this.fgSince.set(s.id, f);
        }
        return { kind, command: exeBase(s.process), pid: s.pid, since: f.since };
      }
      this.fgSince.delete(s.id);
    }
    return this.detected.get(s.id) ?? null;
  }

  private compute(ownerId: number, worktreePaths: string[], external: boolean): AgentSession[] {
    const now = this.now();
    const out: AgentSession[] = [];
    for (const s of this.o.ptys.snapshots(ownerId)) {
      const d = this.identify(s);
      if (!d) continue;
      const a: AgentSession = {
        id: s.id,
        ptyId: s.id,
        pid: d.pid,
        kind: d.kind,
        label: s.label ?? `${d.command} — ${basename(s.cwd)}`,
        command: d.command,
        status: classifyStatus({
          exited: !!s.exited,
          lastOutputAt: s.lastOutputAt,
          lastLine: s.lastLine,
          now,
        }),
        startedAt: d.since,
        lastOutputAt: s.lastOutputAt,
        cwd: s.cwd,
        worktreePath: worktreeFor(s.cwd, worktreePaths, this.platform),
      };
      if (s.launched) a.launched = true;
      if (s.exited) a.exitCode = s.exited.exitCode;
      out.push(a);
    }
    if (external) {
      for (const e of this.externals) {
        const wt = worktreeFor(e.cwd, worktreePaths, this.platform);
        if (!wt) continue;
        out.push({
          id: `ext-${e.pid}`,
          pid: e.pid,
          kind: e.kind,
          label: `${e.command} — ${basename(e.cwd)}`,
          command: e.command,
          status: 'running',
          startedAt: e.since,
          cwd: e.cwd,
          worktreePath: wt,
          external: true,
        });
      }
    }
    return out;
  }

  private needsProbe(snaps: PtySessionSnapshot[]): boolean {
    if (!this.o.probe) return false;
    if (this.wantExternal && this.platform !== 'win32') return true;
    return snaps.some(
      (s) =>
        !s.launched &&
        !s.exited &&
        (this.platform === 'win32' || !s.process || !agentKindOfName(s.process, this.custom())),
    );
  }

  /** Throttled OS process scan: shell children (Windows / interpreters) and external agents. */
  refresh(force = false): Promise<void> {
    if (this.probing) return this.probing;
    const snaps = this.o.ptys.snapshots();
    const now = this.now();
    if (!this.needsProbe(snaps) || (!force && now - this.lastProbe < (this.o.probeIntervalMs ?? 4000))) {
      return Promise.resolve();
    }
    this.lastProbe = now;
    this.probing = this.scan(snaps)
      .catch(() => undefined)
      .finally(() => {
        this.probing = null;
      });
    return this.probing;
  }

  private async scan(snaps: PtySessionSnapshot[]): Promise<void> {
    const probe = this.o.probe!;
    const procs = await probe.list();
    if (!procs.length) return;
    const custom = this.custom();
    let changed = false;
    const ours = new Set<number>();
    for (const s of snaps) {
      if (s.exited) continue;
      ours.add(s.pid);
      const desc = descendantsOf(procs, s.pid);
      for (const p of desc) ours.add(p.pid);
      if (s.launched) continue;
      const found = findAgentProcess(desc, custom);
      const prev = this.detected.get(s.id);
      if (!found) {
        if (prev) {
          this.detected.delete(s.id);
          changed = true;
        }
        continue;
      }
      if (prev && prev.pid === found.proc.pid && prev.kind === found.kind) continue;
      this.detected.set(s.id, {
        kind: found.kind,
        command: exeBase(found.proc.name),
        pid: found.proc.pid,
        since: this.now(),
      });
      changed = true;
    }
    if (this.wantExternal && this.platform !== 'win32') {
      changed = (await this.scanExternal(procs, ours, custom)) || changed;
    }
    if (changed) this.o.emit({ reason: 'status' });
  }

  private async scanExternal(procs: ProcInfo[], ours: Set<number>, custom: string): Promise<boolean> {
    const byPid = new Map(procs.map((p) => [p.pid, p]));
    const isAgent = (p: ProcInfo): AgentKind | null => agentKindOfProcess(p.name, p.commandLine, custom);
    const candidates: { p: ProcInfo; kind: AgentKind }[] = [];
    for (const p of procs) {
      if (ours.has(p.pid) || p.pid === process.pid) continue;
      const kind = isAgent(p);
      if (!kind) continue;
      // Skip helpers whose parent is itself an agent (count the session once).
      const parent = byPid.get(p.ppid);
      if (parent && isAgent(parent)) continue;
      candidates.push({ p, kind });
      if (candidates.length >= 50) break;
    }
    const cwds = candidates.length ? await this.o.probe!.cwds(candidates.map((c) => c.p.pid)) : new Map();
    const prev = new Map(this.externals.map((e) => [e.pid, e]));
    const next: External[] = [];
    for (const { p, kind } of candidates) {
      const cwd = cwds.get(p.pid);
      if (!cwd || !worktreeFor(cwd, this.externalPaths, this.platform)) continue;
      next.push({
        pid: p.pid,
        kind,
        command: exeBase(p.name),
        cwd: path.normalize(cwd),
        since: prev.get(p.pid)?.since ?? this.now(),
      });
    }
    const sig = (l: External[]): string => l.map((e) => `${e.pid}:${e.kind}:${e.cwd}`).join('|');
    const changed = sig(next) !== sig(this.externals);
    this.externals = next;
    return changed;
  }

  // ---- ticking ----

  private ensureTicker(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.o.tickMs ?? 1000);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Re-evaluates time-based statuses; stops when nobody has listed for `activeMs`. */
  tick(): void {
    if (this.now() - this.lastListAt > (this.o.activeMs ?? 30_000)) {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      this.wantExternal = false;
      this.externalPaths = [];
      this.externals = [];
      return;
    }
    void this.refresh();
    const now = this.now();
    const sig = this.o.ptys
      .snapshots()
      .map((s) => {
        const d = this.identify(s);
        if (!d) return '';
        const st = classifyStatus({
          exited: !!s.exited,
          lastOutputAt: s.lastOutputAt,
          lastLine: s.lastLine,
          now,
        });
        return `${s.id}:${d.kind}:${st}`;
      })
      .filter(Boolean)
      .join('|');
    if (sig !== this.lastSig) {
      const first = this.lastSig === '' && sig === '';
      this.lastSig = sig;
      if (!first) this.o.emit({ reason: 'status' });
    }
  }
}
