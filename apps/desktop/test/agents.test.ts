import os from 'node:os';

import type { WorktreeInfo } from '@githappens/git/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  agentKindOfName,
  agentKindOfProcess,
  classifyStatus,
  descendantsOf,
  exeBase,
  findAgentProcess,
  isPromptLike,
  parseCimProcesses,
  parseLsofCwd,
  parsePsOutput,
  splitCommandLine,
  worktreeFor,
  type ProcInfo,
} from '../src/main/agents/agent-detect';
import { AgentMonitor } from '../src/main/agents/agent-monitor';
import { CIM_SCRIPT, createProcessProbe, type ProcessProbe } from '../src/main/agents/process-probe';
import { createAgentsHandlers } from '../src/main/ipc/agents-handlers';
import {
  PtyService,
  type PtyModule,
  type PtyProcess,
  type PtySpawnOptions,
} from '../src/main/services/pty-service';
import {
  branchLabel,
  defaultWorktreeFolder,
  groupSessions,
  resolveAgainst,
  samePath,
  sortSessions,
  statusSummary,
} from '../src/renderer/src/views/agents/agent-helpers';
import type { AgentSession } from '../src/shared/ipc/agents-contract';

// ---- pure detection helpers ----

describe('agent process matching', () => {
  it('matches known agent binaries and the configured command', () => {
    expect(exeBase('C:\\Users\\me\\.local\\bin\\claude.exe')).toBe('claude');
    expect(agentKindOfName('claude')).toBe('claude');
    expect(agentKindOfName('/usr/local/bin/codex')).toBe('codex');
    expect(agentKindOfName('copilot.cmd')).toBe('copilot');
    expect(agentKindOfName('Gemini.EXE')).toBe('gemini');
    expect(agentKindOfName('aider', 'aider')).toBe('custom');
    expect(agentKindOfName('/opt/aider', '/usr/bin/aider')).toBe('custom');
    expect(agentKindOfName('zsh', 'claude')).toBeNull();
    expect(agentKindOfName('')).toBeNull();
  });

  it('looks through node / cmd launchers at the script or package', () => {
    expect(
      agentKindOfProcess(
        'node.exe',
        '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js',
      ),
    ).toBe('claude');
    expect(
      agentKindOfProcess('node', 'node /home/me/.nvm/lib/node_modules/@google/gemini-cli/dist/index.js'),
    ).toBe('gemini');
    expect(
      agentKindOfProcess('cmd.exe', 'C:\\WINDOWS\\system32\\cmd.exe /d /c C:\\npm\\codex.cmd --full-auto'),
    ).toBe('codex');
    expect(agentKindOfProcess('node', 'node --inspect /x/server.js')).toBeNull();
    // Arguments of a non-launcher are not inspected.
    expect(agentKindOfProcess('vim', 'vim claude.md')).toBeNull();
  });

  it('splits quoted command lines', () => {
    expect(splitCommandLine('"C:\\a b\\node.exe"  x "y z" ""')).toEqual([
      'C:\\a b\\node.exe',
      'x',
      'y z',
      '',
    ]);
  });
});

const SAMPLE_CIM = JSON.stringify([
  { ProcessId: 100, ParentProcessId: 4, Name: 'pwsh.exe', CommandLine: 'pwsh.exe -NoLogo' },
  {
    ProcessId: 200,
    ParentProcessId: 100,
    Name: 'node.exe',
    CommandLine: '"C:\\nodejs\\node.exe" C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js',
  },
  { ProcessId: 300, ParentProcessId: 200, Name: 'rg.exe', CommandLine: null },
  { ProcessId: 400, ParentProcessId: 4, Name: 'explorer.exe', CommandLine: 'C:\\Windows\\explorer.exe' },
  { ProcessId: 'bad', ParentProcessId: 1, Name: 'x' },
]);

describe('process table parsing', () => {
  it('parses Get-CimInstance JSON (array, single object, BOM, garbage)', () => {
    const procs = parseCimProcesses(SAMPLE_CIM);
    expect(procs).toHaveLength(4);
    expect(procs[2]).toEqual({ pid: 300, ppid: 200, name: 'rg.exe' });
    expect(
      parseCimProcesses(
        '\uFEFF{"ProcessId":5,"ParentProcessId":1,"Name":"claude.exe","CommandLine":"claude"}',
      ),
    ).toEqual([{ pid: 5, ppid: 1, name: 'claude.exe', commandLine: 'claude' }]);
    expect(parseCimProcesses('')).toEqual([]);
    expect(parseCimProcesses('not json')).toEqual([]);
  });

  it('parses ps and lsof output', () => {
    const ps = parsePsOutput(
      '    1     0 /sbin/launchd\n  501   1 /usr/local/bin/codex --full-auto\n\nbad line\n',
    );
    expect(ps).toEqual([
      { pid: 1, ppid: 0, name: 'launchd', commandLine: '/sbin/launchd' },
      { pid: 501, ppid: 1, name: 'codex', commandLine: '/usr/local/bin/codex --full-auto' },
    ]);
    expect(parseLsofCwd('p501\nfcwd\nn/Users/me/repo-wt\np77\nfcwd\nn/tmp\n')).toEqual(
      new Map([
        [501, '/Users/me/repo-wt'],
        [77, '/tmp'],
      ]),
    );
  });

  it('walks descendants nearest-first and finds the agent', () => {
    const procs = parseCimProcesses(SAMPLE_CIM);
    expect(descendantsOf(procs, 100).map((p) => p.pid)).toEqual([200, 300]);
    expect(descendantsOf(procs, 100, 1).map((p) => p.pid)).toEqual([200]);
    expect(findAgentProcess(descendantsOf(procs, 100))).toMatchObject({ kind: 'claude', proc: { pid: 200 } });
    expect(findAgentProcess(descendantsOf(procs, 400))).toBeNull();
    // Cycles do not loop forever.
    expect(
      descendantsOf(
        [
          { pid: 1, ppid: 2, name: 'a' },
          { pid: 2, ppid: 1, name: 'b' },
        ],
        1,
      ),
    ).toHaveLength(1);
  });
});

describe('status classification', () => {
  it('follows the §4.12 rules', () => {
    const base = { exited: false, lastOutputAt: 0, lastLine: 'Thinking…' };
    expect(classifyStatus({ ...base, now: 1500 })).toBe('running');
    expect(classifyStatus({ ...base, now: 2000 })).toBe('running');
    expect(classifyStatus({ ...base, now: 5000 })).toBe('idle');
    expect(classifyStatus({ ...base, lastLine: '> ', now: 5000 })).toBe('idle'); // prompt, but < 10 s
    expect(classifyStatus({ ...base, lastLine: '> ', now: 10_001 })).toBe('waiting');
    expect(classifyStatus({ ...base, now: 60_000 })).toBe('idle');
    expect(classifyStatus({ ...base, exited: true, now: 100 })).toBe('exited');
  });

  it('recognises prompt-like lines', () => {
    for (const l of [
      '>',
      '❯',
      'user@host:~/repo$',
      'Do you want to make this edit to a.ts?',
      '❯ 1. Yes',
      'Continue? [Y/n]',
      '? for shortcuts',
      '│ >',
      'Allow command `npm test`?',
    ]) {
      expect(isPromptLike(l), l).toBe(true);
    }
    for (const l of ['', 'Reading file src/a.ts', '✻ Thinking… (12s · esc to interrupt) 42 tokens']) {
      expect(isPromptLike(l), l).toBe(false);
    }
  });

  it('maps cwds to the longest containing worktree', () => {
    const wts = ['C:\\repo', 'C:\\repo\\.worktrees\\feat'];
    expect(worktreeFor('c:/Repo/.worktrees/feat/src', wts, 'win32')).toBe('C:\\repo\\.worktrees\\feat');
    expect(worktreeFor('C:\\repo', wts, 'win32')).toBe('C:\\repo');
    expect(worktreeFor('C:\\repo-other', wts, 'win32')).toBeNull();
    expect(worktreeFor('/Repo', ['/repo'], 'linux')).toBeNull();
  });
});

describe('process probe', () => {
  it('runs a constant PowerShell CIM query with an argv array on Windows', async () => {
    const calls: { file: string; args: string[] }[] = [];
    const probe = createProcessProbe('win32', async (file, args) => {
      calls.push({ file, args });
      return SAMPLE_CIM;
    });
    expect(await probe.list()).toHaveLength(4);
    expect(calls[0]!.file).toBe('powershell.exe');
    expect(calls[0]!.args.at(-1)).toBe(CIM_SCRIPT);
    expect(await probe.cwds([1, 2])).toEqual(new Map());
  });

  it('tolerates failures and reads lsof stdout of a partial failure', async () => {
    const failing = createProcessProbe('win32', async () => {
      throw new Error('powershell missing');
    });
    expect(await failing.list()).toEqual([]);
    const mac = createProcessProbe('darwin', async (file) => {
      if (file === 'lsof') throw Object.assign(new Error('exit 1'), { stdout: 'p9\nfcwd\nn/w\n' });
      return '9 1 claude\n';
    });
    expect(await mac.list()).toEqual([{ pid: 9, ppid: 1, name: 'claude', commandLine: 'claude' }]);
    expect(await mac.cwds([9])).toEqual(new Map([[9, '/w']]));
    const linux = createProcessProbe(
      'linux',
      async () => '',
      (p) => {
        if (p === '/proc/5/cwd') return '/home/me/wt';
        throw new Error('ENOENT');
      },
    );
    expect(await linux.cwds([5, 6])).toEqual(new Map([[5, '/home/me/wt']]));
  });
});

// ---- monitor with a fake pty module ----

class FakePty implements PtyProcess {
  static nextPid = 5000;
  readonly pid = FakePty.nextPid++;
  process?: string;
  written: string[] = [];
  killed = false;
  private dataL = new Set<(d: string) => void>();
  private exitL = new Set<(e: { exitCode: number }) => void>();
  constructor(
    readonly file: string,
    readonly args: string[],
    readonly opts: PtySpawnOptions,
  ) {}
  onData(l: (d: string) => void) {
    this.dataL.add(l);
    return { dispose: () => this.dataL.delete(l) };
  }
  onExit(l: (e: { exitCode: number }) => void) {
    this.exitL.add(l);
    return { dispose: () => this.exitL.delete(l) };
  }
  write(d: string) {
    this.written.push(d);
  }
  resize() {}
  kill() {
    this.killed = true;
  }
  pause() {}
  resume() {}
  emit(d: string) {
    for (const l of this.dataL) l(d);
  }
  exit(code: number) {
    for (const l of this.exitL) l({ exitCode: code });
  }
}

function setup(platform: NodeJS.Platform, probe?: ProcessProbe) {
  let now = 100_000;
  const spawned: FakePty[] = [];
  const mod: PtyModule = {
    spawn: (file, args, opts) => {
      const p = new FakePty(file, args, opts);
      spawned.push(p);
      return p;
    },
  };
  const ptys = new PtyService({
    loadPty: () => mod,
    send: () => {},
    platform,
    env: { PATH: '', SHELL: '/bin/bash', PATHEXT: '.EXE' },
    findOnPath: (e) => (e.toLowerCase() === 'claude.exe' ? 'C:\\bin\\claude.exe' : null),
    homedir: () => os.tmpdir(),
    now: () => now,
  });
  const events: string[] = [];
  const monitor = new AgentMonitor({
    ptys,
    agentCommand: () => 'claude',
    agentArgs: () => ['--verbose'],
    emit: (p) => events.push(p.reason),
    probe,
    platform,
    now: () => now,
    isDirectory: () => true,
  });
  return {
    ptys,
    monitor,
    spawned,
    events,
    advance: (ms: number) => {
      now += ms;
      vi.advanceTimersByTime(ms);
    },
    now: () => now,
  };
}

describe('AgentMonitor', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('starts the configured agent and classifies its status over time', async () => {
    const t = setup('linux');
    const wt = os.tmpdir();
    const { ptyId, label } = await t.monitor.start(1, { cwd: wt });
    expect(label).toMatch(/^claude — /);
    expect(t.spawned[0]!.args.slice(-2)).toEqual(['claude', '--verbose']);
    expect(t.events).toEqual(['started']);

    let [s] = t.monitor.list(1, [wt]);
    expect(s).toMatchObject({ ptyId, kind: 'claude', status: 'running', launched: true, worktreePath: wt });
    expect(t.monitor.list(2, [wt])).toEqual([]); // other window

    t.spawned[0]!.emit('Working…\r\n');
    t.advance(5000);
    [s] = t.monitor.list(1, [wt]);
    expect(s!.status).toBe('idle');
    t.spawned[0]!.emit('\r\n│ > \r\n');
    t.advance(11_000);
    [s] = t.monitor.list(1, [wt]);
    expect(s!.status).toBe('waiting');
    expect(t.events).toContain('status'); // ticker noticed running → idle → waiting

    t.monitor.stop(1, ptyId);
    expect(t.spawned[0]!.written).toEqual(['\x03']);
    t.monitor.stop(1, ptyId, true);
    expect(t.spawned[0]!.killed).toBe(true);
    t.spawned[0]!.exit(130);
    [s] = t.monitor.list(1, [wt]);
    expect(s).toMatchObject({ status: 'exited', exitCode: 130 });
    t.monitor.stop(1, ptyId); // dismiss
    expect(t.monitor.list(1, [wt])).toEqual([]);
    expect(() => t.monitor.stop(1, ptyId)).toThrow(/Unknown agent session/);
    t.monitor.dispose();
  });

  it('uses node-pty foreground process names on macOS/Linux', async () => {
    const t = setup('darwin');
    const info = await t.ptys.create(1, { cwd: os.tmpdir(), cols: 80, rows: 24 });
    t.spawned[0]!.process = 'zsh';
    expect(t.monitor.list(1, [])).toEqual([]);
    t.spawned[0]!.process = 'codex';
    const [s] = t.monitor.list(1, []);
    expect(s).toMatchObject({ ptyId: info.id, kind: 'codex', command: 'codex', worktreePath: null });
    expect(s!.launched).toBeUndefined();
    t.monitor.dispose();
  });

  it('detects agents among shell children on Windows (throttled probe)', async () => {
    let table: ProcInfo[] = [];
    const list = vi.fn(async () => table);
    const t = setup('win32', { list, cwds: async () => new Map() });
    await t.ptys.create(1, { cwd: os.tmpdir(), cols: 80, rows: 24 });
    const shellPid = t.spawned[0]!.pid;
    t.spawned[0]!.process = 'pwsh.exe'; // Windows: always the shell
    expect(t.monitor.list(1, [])).toEqual([]);
    await t.monitor.refresh();
    expect(list).toHaveBeenCalledTimes(1);

    table = [
      { pid: shellPid, ppid: 1, name: 'pwsh.exe' },
      { pid: 9001, ppid: shellPid, name: 'claude.exe', commandLine: 'claude' },
    ];
    await t.monitor.refresh(); // throttled: no new probe yet
    expect(list).toHaveBeenCalledTimes(1);
    t.advance(4000);
    await t.monitor.refresh();
    expect(list).toHaveBeenCalledTimes(2);
    expect(t.events).toContain('status');
    const [s] = t.monitor.list(1, []);
    expect(s).toMatchObject({ kind: 'claude', pid: 9001, command: 'claude', startedAt: t.now() });
    t.monitor.dispose();
  });

  it('lists external agents by process cwd (macOS/Linux), read-only', async () => {
    const probe: ProcessProbe = {
      list: async () => [
        { pid: 70, ppid: 1, name: 'claude', commandLine: 'claude' },
        { pid: 71, ppid: 70, name: 'claude', commandLine: 'claude --helper' },
        { pid: 80, ppid: 1, name: 'codex', commandLine: 'codex' },
      ],
      cwds: async (pids) => new Map(pids.map((p) => [p, p === 70 ? '/w/feat/src' : '/elsewhere'])),
    };
    const t = setup('linux', probe);
    expect(t.monitor.list(1, ['/w/feat'], true)).toEqual([]);
    await t.monitor.refresh(true);
    const list = t.monitor.list(1, ['/w/feat'], true);
    expect(list).toEqual([
      expect.objectContaining({ id: 'ext-70', external: true, kind: 'claude', worktreePath: '/w/feat' }),
    ]);
    expect(list[0]!.ptyId).toBeUndefined();
    // Not requested → not listed.
    expect(t.monitor.list(1, ['/w/feat'])).toEqual([]);
    t.monitor.dispose();
  });

  it('stops ticking when nobody lists', async () => {
    const t = setup('linux');
    await t.monitor.start(1, { cwd: os.tmpdir() });
    t.monitor.list(1, []);
    t.advance(31_000);
    const n = t.events.length;
    t.advance(10_000);
    expect(t.events.length).toBe(n);
    t.monitor.dispose();
  });
});

describe('agents handlers', () => {
  it('validate input, read settings and scope by sender', async () => {
    vi.useFakeTimers();
    try {
      const spawned: FakePty[] = [];
      const ptys = new PtyService({
        loadPty: () => ({
          spawn: (f, a, o) => {
            const p = new FakePty(f, a, o);
            spawned.push(p);
            return p;
          },
        }),
        send: () => {},
        platform: 'linux',
        env: { SHELL: '/bin/sh' },
      });
      const broadcasts: unknown[] = [];
      const h = createAgentsHandlers({
        ptys,
        settings: {
          get: ((k: string) => (k === 'tools.agentCommand' ? 'gemini' : ['-y'])) as never,
        },
        broadcast: (_e, p) => broadcasts.push(p),
        probe: null,
        platform: 'linux',
      });
      const { ptyId } = await h['agents:start']({ cwd: os.tmpdir() }, { senderId: 3 });
      expect(spawned[0]!.args.slice(-2)).toEqual(['gemini', '-y']);
      expect(broadcasts).toEqual([{ reason: 'started' }]);
      const custom = await h['agents:start']({ cwd: os.tmpdir(), command: 'aider' }, { senderId: 3 });
      expect(spawned[1]!.args.at(-1)).toBe('aider');
      const listed = await h['agents:list']({ worktreePaths: [os.tmpdir()] }, { senderId: 3 });
      expect(listed.map((s) => [s.ptyId, s.kind])).toEqual([
        [ptyId, 'gemini'],
        [custom.ptyId, 'custom'],
      ]);
      await expect(
        Promise.resolve().then(() => h['agents:start']({ cwd: '/definitely/missing' }, { senderId: 3 })),
      ).rejects.toThrow(/Folder not found/);
      expect(() => h['agents:stop']({ ptyId: 5 as never }, { senderId: 3 })).toThrow(/Invalid ptyId/);
      expect(() => h['agents:stop']({ ptyId }, { senderId: 4 })).toThrow(/Unknown agent session/);
      await h['agents:stop']({ ptyId }, { senderId: 3 });
      expect(spawned[0]!.written).toEqual(['\x03']);
      ptys.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---- renderer helpers ----

const wt = (path: string, extra: Partial<WorktreeInfo> = {}): WorktreeInfo => ({
  path,
  head: null,
  detached: false,
  bare: false,
  isMain: false,
  isCurrent: false,
  ...extra,
});
const sess = (id: string, extra: Partial<AgentSession>): AgentSession => ({
  id,
  kind: 'claude',
  label: id,
  command: 'claude',
  status: 'idle',
  startedAt: 0,
  cwd: '/x',
  worktreePath: null,
  ...extra,
});

describe('agent panel helpers', () => {
  it('groups sessions per worktree, current first, others last', () => {
    const groups = groupSessions(
      [
        wt('C:/r', { isMain: true, branch: 'refs/heads/main' }),
        wt('C:/r-feat', { isCurrent: true, branch: 'refs/heads/feat' }),
        wt('C:/bare', { bare: true }),
      ],
      [
        sess('a', { worktreePath: 'c:\\r', status: 'running', startedAt: 1 }),
        sess('b', { worktreePath: 'C:/r', status: 'waiting', startedAt: 2 }),
        sess('c', { worktreePath: 'C:/r', status: 'running', startedAt: 3 }),
        sess('d', { worktreePath: null }),
      ],
    );
    expect(groups.map((g) => g.worktree?.path ?? null)).toEqual(['C:/r-feat', 'C:/r', null]);
    expect(groups[1]!.sessions.map((s) => s.id)).toEqual(['b', 'c', 'a']);
    expect(groups[0]!.sessions).toEqual([]);
    expect(groups[2]!.sessions.map((s) => s.id)).toEqual(['d']);
    expect(groupSessions([wt('/a')], [])).toHaveLength(1);
  });

  it('formats and resolves', () => {
    expect(branchLabel({ branch: 'refs/heads/feature/x', detached: false })).toBe('feature/x');
    expect(branchLabel({ detached: true })).toBe('detached HEAD');
    expect(samePath('C:\\a\\b\\', 'c:/A/b')).toBe(true);
    expect(samePath(null, 'x')).toBe(false);
    expect(resolveAgainst('C:\\repo', 'wt\\x')).toBe('C:\\repo\\wt\\x');
    expect(resolveAgainst('/home/r', './wt')).toBe('/home/r/wt');
    expect(resolveAgainst('/home/r', '/abs')).toBe('/abs');
    expect(resolveAgainst('C:/r', 'D:\\abs')).toBe('D:\\abs');
    expect(defaultWorktreeFolder('C:/dev/app', 'feature/x')).toBe('C:/dev/app-feature-x');
    expect(
      statusSummary([
        sess('a', { status: 'running' }),
        sess('b', { status: 'running' }),
        sess('c', { status: 'waiting' }),
      ]),
    ).toBe('1 waiting for input · 2 running');
    expect(
      sortSessions([sess('x', { status: 'exited' }), sess('y', { status: 'waiting' })]).map((s) => s.id),
    ).toEqual(['y', 'x']);
  });
});
