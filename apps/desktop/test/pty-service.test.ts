import os from 'node:os';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTerminalHandlers } from '../src/main/ipc/terminal-handlers';
import {
  defaultArgsFor,
  lastNonEmptyLine,
  loadNodePty,
  PtyService,
  resolveCommandLaunch,
  resolveDefaultShell,
  stripAnsi,
  type PtyModule,
  type PtyProcess,
  type PtyServiceOptions,
  type PtySpawnOptions,
} from '../src/main/services/pty-service';

class FakePty implements PtyProcess {
  static nextPid = 1000;
  readonly pid = FakePty.nextPid++;
  process?: string;
  written: string[] = [];
  sizes: [number, number][] = [];
  killed = false;
  paused = false;
  private dataL = new Set<(d: string) => void>();
  private exitL = new Set<(e: { exitCode: number; signal?: number }) => void>();
  constructor(
    readonly file: string,
    readonly args: string[],
    readonly opts: PtySpawnOptions,
  ) {}
  onData(l: (d: string) => void) {
    this.dataL.add(l);
    return { dispose: () => this.dataL.delete(l) };
  }
  onExit(l: (e: { exitCode: number; signal?: number }) => void) {
    this.exitL.add(l);
    return { dispose: () => this.exitL.delete(l) };
  }
  write(d: string) {
    this.written.push(d);
  }
  resize(c: number, r: number) {
    this.sizes.push([c, r]);
  }
  kill() {
    this.killed = true;
  }
  pause() {
    this.paused = true;
  }
  resume() {
    this.paused = false;
  }
  emit(d: string) {
    for (const l of this.dataL) l(d);
  }
  exit(code: number) {
    for (const l of this.exitL) l({ exitCode: code });
  }
}

function setup(extra: Partial<PtyServiceOptions> = {}) {
  const spawned: FakePty[] = [];
  const mod: PtyModule = {
    spawn: (file, args, opts) => {
      const p = new FakePty(file, args, opts);
      spawned.push(p);
      return p;
    },
  };
  const sent: { owner: number; event: string; payload: any }[] = [];
  const goners = new Map<number, () => void>();
  const svc = new PtyService({
    loadPty: () => mod,
    send: (owner, event, payload) => sent.push({ owner, event, payload }),
    watchOwner: (owner, gone) => goners.set(owner, gone),
    platform: 'linux',
    env: { PATH: '/usr/bin', SHELL: '/bin/zsh', ELECTRON_RUN_AS_NODE: '1', HOME: '/home/u' },
    homedir: () => os.tmpdir(),
    ...extra,
  });
  return { svc, spawned, sent, goners };
}

describe('PtyService (fake pty)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('spawns with the default shell, env and clamped size', async () => {
    const { svc, spawned } = setup();
    const info = await svc.create(1, { cwd: os.tmpdir(), cols: 100.7, rows: 0 });
    const p = spawned[0]!;
    expect(p.file).toBe('/bin/zsh');
    expect(p.args).toEqual(['-l']);
    expect(p.opts.cols).toBe(100);
    expect(p.opts.rows).toBe(24);
    expect(p.opts.cwd).toBe(os.tmpdir());
    expect(p.opts.env.TERM).toBe('xterm-256color');
    expect(p.opts.env.COLORTERM).toBe('truecolor');
    expect(p.opts.env.HOME).toBe('/home/u');
    expect(p.opts.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(info).toMatchObject({ pid: p.pid, shell: '/bin/zsh', shellName: 'zsh' });
  });

  it('falls back to the home dir when cwd is missing', async () => {
    const { svc, spawned } = setup();
    await svc.create(1, { cwd: '/definitely/not/here', cols: 80, rows: 24 });
    expect(spawned[0]!.opts.cwd).toBe(os.tmpdir());
  });

  it('coalesces output within the batch window', async () => {
    const { svc, spawned, sent } = setup();
    const { id } = await svc.create(1, { cwd: os.tmpdir(), cols: 80, rows: 24 });
    const p = spawned[0]!;
    p.emit('a');
    p.emit('b');
    p.emit('c');
    expect(sent).toHaveLength(0);
    vi.advanceTimersByTime(16);
    expect(sent).toEqual([{ owner: 1, event: 'terminal:data', payload: { id, data: 'abc' } }]);
    p.emit('d');
    vi.advanceTimersByTime(16);
    expect(sent.map((s) => s.payload.data)).toEqual(['abc', 'd']);
  });

  it('flushes large batches immediately and pauses until acked', async () => {
    const { svc, spawned, sent } = setup({ maxBatchChars: 10, highWatermark: 25, lowWatermark: 5 });
    const { id } = await svc.create(1, { cwd: os.tmpdir(), cols: 80, rows: 24 });
    const p = spawned[0]!;
    p.emit('x'.repeat(12));
    p.emit('y'.repeat(12));
    expect(sent).toHaveLength(2);
    expect(p.paused).toBe(false);
    p.emit('z'.repeat(12));
    expect(p.paused).toBe(true);
    svc.ack(1, id, 20);
    expect(p.paused).toBe(true); // 16 un-acked > low
    svc.ack(1, id, 14);
    expect(p.paused).toBe(false);
  });

  it('flushes pending output before the exit event', async () => {
    const { svc, spawned, sent } = setup();
    const { id } = await svc.create(1, { cwd: os.tmpdir(), cols: 80, rows: 24 });
    spawned[0]!.emit('bye');
    spawned[0]!.exit(3);
    expect(sent.map((s) => s.event)).toEqual(['terminal:data', 'terminal:exit']);
    expect(sent[1]!.payload).toEqual({ id, exitCode: 3 });
    expect(svc.list(1)).toEqual([]);
  });

  it('writes, resizes and kills only for the owner', async () => {
    const { svc, spawned, sent } = setup();
    const { id } = await svc.create(1, { cwd: os.tmpdir(), cols: 80, rows: 24 });
    const p = spawned[0]!;
    svc.write(1, id, 'ls\r');
    svc.resize(1, id, 120, 40);
    expect(p.written).toEqual(['ls\r']);
    expect(p.sizes).toEqual([[120, 40]]);
    expect(() => svc.write(2, id, 'evil')).toThrow(/Unknown terminal/);
    svc.kill(2, id);
    expect(p.killed).toBe(false);
    p.emit('pending');
    svc.kill(1, id);
    expect(p.killed).toBe(true);
    vi.advanceTimersByTime(50);
    p.exit(0);
    expect(sent).toEqual([]); // explicit kill: no data flush, no exit event
    expect(svc.size).toBe(0);
  });

  it('kills a window’s terminals when it goes away', async () => {
    const { svc, spawned, goners } = setup();
    await svc.create(1, { cwd: os.tmpdir(), cols: 80, rows: 24 });
    await svc.create(1, { cwd: os.tmpdir(), cols: 80, rows: 24 });
    await svc.create(2, { cwd: os.tmpdir(), cols: 80, rows: 24 });
    expect(goners.size).toBe(2);
    goners.get(1)!();
    expect(spawned.map((p) => p.killed)).toEqual([true, true, false]);
    expect(svc.list(1)).toEqual([]);
    expect(svc.list(2)).toHaveLength(1);
    svc.dispose();
    expect(spawned[2]!.killed).toBe(true);
    await expect(svc.create(2, { cwd: os.tmpdir(), cols: 80, rows: 24 })).rejects.toThrow(/shut down/);
  });

  it('wraps spawn failures with the shell name', async () => {
    const svc = new PtyService({
      loadPty: () => ({
        spawn: () => {
          throw new Error('File not found');
        },
      }),
      send: () => {},
      platform: 'linux',
      env: {},
    });
    await expect(svc.create(1, { cwd: os.tmpdir(), cols: 80, rows: 24, shell: '/bin/nope' })).rejects.toThrow(
      'Could not start /bin/nope: File not found',
    );
  });

  it('handlers validate input and pass the sender id', async () => {
    const { svc, spawned } = setup();
    const h = createTerminalHandlers(svc);
    const info = await h['terminal:create'](
      { cwd: os.tmpdir(), cols: 80, rows: 24, shell: '/bin/bash' },
      { senderId: 7 },
    );
    expect(spawned[0]!.args).toEqual(['-l']);
    await h['terminal:write']({ id: info.id, data: 'x' }, { senderId: 7 });
    expect(spawned[0]!.written).toEqual(['x']);
    expect(await h['terminal:list']({}, { senderId: 7 })).toHaveLength(1);
    expect(await h['terminal:list']({}, { senderId: 8 })).toHaveLength(0);
    expect(() => h['terminal:write']({ id: info.id, data: 5 as any }, { senderId: 7 })).toThrow(
      /Invalid data/,
    );
  });
});

describe('PtyService command sessions (agents)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('spawns the command through a POSIX login shell and records output until attached', async () => {
    let now = 1000;
    const { svc, spawned, sent } = setup({ now: () => now });
    const changes: string[] = [];
    svc.onChange((c) => changes.push(`${c.type}:${c.id}`));
    const info = await svc.createCommand(1, {
      cwd: os.tmpdir(),
      command: 'claude',
      args: ['--model', 'x y'],
      label: 'claude — wt',
    });
    const p = spawned[0]!;
    expect(p.file).toBe('/bin/zsh');
    expect(p.args).toEqual(['-l', '-c', 'exec "$0" "$@"', 'claude', '--model', 'x y']);
    expect(info).toMatchObject({ label: 'claude — wt', command: 'claude', shellName: 'claude' });
    expect(changes).toEqual([`created:${info.id}`]);

    now = 5000;
    p.emit('\x1b[32mhello\x1b[0m\r\n');
    p.emit('> ');
    vi.advanceTimersByTime(20);
    expect(sent).toEqual([]); // detached: nothing streamed

    const snap = svc.snapshots(1)[0]!;
    expect(snap).toMatchObject({
      id: info.id,
      launched: { command: 'claude', args: ['--model', 'x y'] },
      startedAt: 1000,
      lastOutputAt: 5000,
      lastLine: '>',
      attached: false,
      label: 'claude — wt',
    });

    const att = svc.attach(1, info.id, 100, 30);
    expect(att.backlog).toBe('\x1b[32mhello\x1b[0m\r\n> ');
    expect(p.sizes).toEqual([[100, 30]]);
    p.emit('more');
    vi.advanceTimersByTime(20);
    expect(sent).toEqual([{ owner: 1, event: 'terminal:data', payload: { id: info.id, data: 'more' } }]);

    // Detach (view unmounted): keeps running, output only recorded; re-attach replays all.
    svc.detach(1, info.id);
    p.emit('!');
    vi.advanceTimersByTime(20);
    expect(sent).toHaveLength(1);
    expect(svc.attach(1, info.id, 80, 24).backlog).toBe('\x1b[32mhello\x1b[0m\r\n> more!');
    expect(() => svc.attach(2, info.id, 80, 24)).toThrow(/Unknown terminal/);
  });

  it('keeps exited command sessions as tombstones until dismissed', async () => {
    const { svc, spawned, sent } = setup();
    const shell = await svc.create(1, { cwd: os.tmpdir(), cols: 80, rows: 24 });
    const agent = await svc.createCommand(1, { cwd: os.tmpdir(), command: 'codex', args: [] });
    spawned[0]!.exit(0);
    spawned[1]!.exit(2);
    expect(sent.filter((s) => s.event === 'terminal:exit').map((s) => s.payload.id)).toEqual([
      shell.id,
      agent.id,
    ]);
    const snaps = svc.snapshots(1);
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatchObject({ id: agent.id, exited: { exitCode: 2 } });
    expect(svc.snapshots(2)).toEqual([]);
    svc.kill(1, agent.id);
    expect(svc.snapshots(1)).toEqual([]);
  });

  it('terminateProcess kills but still reports the exit', async () => {
    const { svc, spawned, sent } = setup();
    const agent = await svc.createCommand(1, { cwd: os.tmpdir(), command: 'gemini', args: [] });
    svc.terminateProcess(1, agent.id);
    expect(spawned[0]!.killed).toBe(true);
    expect(svc.size).toBe(1);
    spawned[0]!.exit(1);
    expect(sent.at(-1)).toMatchObject({ event: 'terminal:exit', payload: { id: agent.id, exitCode: 1 } });
  });

  it('reports the node-pty foreground process in snapshots', async () => {
    const { svc, spawned } = setup();
    await svc.create(1, { cwd: os.tmpdir(), cols: 80, rows: 24 });
    spawned[0]!.process = 'claude';
    expect(svc.snapshots(1)[0]!.process).toBe('claude');
  });

  it('attach/detach handlers validate and scope by sender', async () => {
    const { svc } = setup();
    const h = createTerminalHandlers(svc);
    const info = await svc.createCommand(7, { cwd: os.tmpdir(), command: 'claude', args: [] });
    const att = await h['terminal:attach']({ id: info.id, cols: 80, rows: 24 }, { senderId: 7 });
    expect(att.info.id).toBe(info.id);
    await h['terminal:detach']({ id: info.id }, { senderId: 8 }); // other window: ignored
    expect(svc.snapshots(7)[0]!.attached).toBe(true);
    await h['terminal:detach']({ id: info.id }, { senderId: 7 });
    expect(svc.snapshots(7)[0]!.attached).toBe(false);
  });
});

describe('resolveCommandLaunch', () => {
  const win = (found: Record<string, string>) => ({
    platform: 'win32' as const,
    env: { PATHEXT: '.COM;.EXE;.BAT;.CMD', ComSpec: 'C:\\Windows\\system32\\cmd.exe' },
    findOnPath: (e: string) => found[e.toLowerCase()] ?? null,
    isFile: (p: string) => p === 'C:\\tools\\agent.EXE',
    shell: '',
  });

  it('resolves .exe on PATH directly and .cmd shims through cmd.exe', () => {
    expect(resolveCommandLaunch('claude', ['-c'], win({ 'claude.exe': 'C:\\bin\\claude.exe' }))).toEqual({
      file: 'C:\\bin\\claude.exe',
      args: ['-c'],
    });
    expect(
      resolveCommandLaunch('codex', ['--full-auto'], win({ 'codex.cmd': 'C:\\npm\\codex.cmd' })),
    ).toEqual({
      file: 'C:\\Windows\\system32\\cmd.exe',
      args: ['/d', '/c', 'C:\\npm\\codex.cmd', '--full-auto'],
    });
    expect(resolveCommandLaunch('C:\\tools\\agent', [], win({}))).toEqual({
      file: 'C:\\tools\\agent.EXE',
      args: [],
    });
  });

  it('refuses cmd metacharacters for .cmd shims and missing commands', () => {
    expect(() =>
      resolveCommandLaunch('codex', ['a&calc'], win({ 'codex.cmd': 'C:\\npm\\codex.cmd' })),
    ).toThrow(/safely/);
    expect(() => resolveCommandLaunch('nope', [], win({}))).toThrow(/Could not find "nope"/);
    expect(() => resolveCommandLaunch('  ', [], win({}))).toThrow(/No agent command/);
  });

  it('uses argv as-is with non-POSIX shells', () => {
    expect(
      resolveCommandLaunch('gemini', ['-y'], {
        platform: 'linux',
        env: {},
        findOnPath: () => null,
        isFile: () => false,
        shell: '/usr/bin/fish',
      }),
    ).toEqual({ file: 'gemini', args: ['-y'] });
  });
});

describe('output tracking helpers', () => {
  it('strips escapes and finds the last visible line', () => {
    expect(stripAnsi('\x1b]0;title\x07\x1b[1;31mred\x1b[0m\x1b(B')).toBe('red');
    expect(lastNonEmptyLine('one\r\ntwo\r\n\x1b[2K\r\n')).toBe('two');
    expect(lastNonEmptyLine('progress 10%\rprogress 99%')).toBe('progress 99%');
    expect(lastNonEmptyLine('│ > \x1b[7m \x1b[0m')).toBe('│ >');
    expect(lastNonEmptyLine('')).toBe('');
  });
});

describe('shell resolution', () => {
  it('prefers pwsh on Windows, then powershell, then COMSPEC', () => {
    const env = { SystemRoot: 'Z:\\nowhere', COMSPEC: 'C:\\Windows\\cmd.exe' };
    expect(
      resolveDefaultShell({
        platform: 'win32',
        env,
        findOnPath: (e) => (e === 'pwsh.exe' ? 'C:\\pwsh\\pwsh.exe' : null),
      }),
    ).toEqual({ shell: 'C:\\pwsh\\pwsh.exe', args: ['-NoLogo'] });
    expect(
      resolveDefaultShell({
        platform: 'win32',
        env,
        findOnPath: (e) => (e === 'powershell.exe' ? 'P\\powershell.exe' : null),
      }).shell,
    ).toBe('P\\powershell.exe');
    expect(resolveDefaultShell({ platform: 'win32', env, findOnPath: () => null })).toEqual({
      shell: 'C:\\Windows\\cmd.exe',
      args: [],
    });
  });

  it('uses $SHELL or /bin/bash as a login shell elsewhere', () => {
    expect(
      resolveDefaultShell({ platform: 'darwin', env: { SHELL: '/bin/zsh' }, findOnPath: () => null }),
    ).toEqual({
      shell: '/bin/zsh',
      args: ['-l'],
    });
    expect(resolveDefaultShell({ platform: 'linux', env: {}, findOnPath: () => null })).toEqual({
      shell: '/bin/bash',
      args: ['-l'],
    });
    expect(defaultArgsFor('C:\\Program Files\\Git\\bin\\bash.exe', 'win32')).toEqual(['--login', '-i']);
  });
});

// ---- real pty smoke test ----

const realPty = await loadNodePty().catch(() => null);

describe.skipIf(!realPty)('PtyService (real @lydell/node-pty)', () => {
  it('spawns the default shell and echoes a marker', async () => {
    const chunks: string[] = [];
    let exited: number | null = null;
    const svc = new PtyService({
      loadPty: () => realPty!,
      send: (_o, event, payload) => {
        if (event === 'terminal:data') chunks.push((payload as { data: string }).data);
        else exited = (payload as { exitCode: number }).exitCode;
      },
    });
    try {
      const isWin = process.platform === 'win32';
      const info = await svc.create(1, {
        cwd: os.tmpdir(),
        cols: 120,
        rows: 30,
        ...(isWin ? { shell: process.env.COMSPEC ?? 'cmd.exe', args: [] } : { shell: '/bin/sh', args: [] }),
      });
      expect(info.id).toMatch(/^term-/);
      const marker = `GH_MARK_${Date.now()}`;
      // Split the marker so the echoed command line itself doesn't match.
      const half = marker.length >> 1;
      const cmd = isWin
        ? `set A=${marker.slice(0, half)}& set B=${marker.slice(half)}& call echo %A%%B%\r`
        : `A=${marker.slice(0, half)}; B=${marker.slice(half)}; echo "$A$B"\r`;
      svc.write(1, info.id, cmd);
      const deadline = Date.now() + 15_000;
      while (
        !chunks
          .join('')
          .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
          .includes(marker) &&
        Date.now() < deadline
      ) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(chunks.join('').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')).toContain(marker);
      svc.write(1, info.id, 'exit\r');
      const exitDeadline = Date.now() + 10_000;
      while (exited === null && Date.now() < exitDeadline) await new Promise((r) => setTimeout(r, 50));
      expect(exited).toBe(0);
    } finally {
      svc.dispose();
    }
  });
});
