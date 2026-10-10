import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { AgentMonitor } from '../src/main/agents/agent-monitor';
import {
  markSetupRan,
  normalizeSetupCommands,
  pathGitExec,
  readSetupCommands,
  runSetupSequence,
  setupAlreadyRan,
  writeSetupCommands,
  type SetupTerminal,
} from '../src/main/agents/agent-setup';
import { createAgentsHandlers } from '../src/main/ipc/agents-handlers';
import {
  PtyService,
  type PtyModule,
  type PtyProcess,
  type PtySpawnOptions,
} from '../src/main/services/pty-service';
import type { ShellEvent } from '../src/main/terminal/osc';

const hasGit = (() => {
  try {
    execFileSync('git', ['--version']);
    return true;
  } catch {
    return false;
  }
})();

/** Fake integrated shell: records writes; tests emit OSC-derived events. */
function fakeTerminal(integrated = true) {
  const writes: string[] = [];
  const listeners = new Set<(e: ShellEvent) => void>();
  const t: SetupTerminal = {
    write: (d) => writes.push(d),
    onShellEvent: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    integrated,
  };
  const emit = (e: ShellEvent): void => {
    for (const l of [...listeners]) l(e);
  };
  return { t, writes, emit, listeners };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('runSetupSequence', () => {
  it('waits for the prompt, runs each command after the previous succeeded, then the agent', async () => {
    const f = fakeTerminal();
    const done = runSetupSequence(f.t, ['pnpm install', 'pnpm build'], 'claude --x');
    await tick();
    expect(f.writes).toEqual([]); // no prompt yet
    f.emit({ kind: 'promptStart' });
    f.emit({ kind: 'promptEnd' });
    expect(f.writes).toEqual(['pnpm install\r']);
    f.emit({ kind: 'commandStart' });
    f.emit({ kind: 'commandEnd', exitCode: 0 });
    expect(f.writes).toEqual(['pnpm install\r', 'pnpm build\r']);
    f.emit({ kind: 'promptStart' });
    f.emit({ kind: 'commandEnd', exitCode: 0 });
    expect(await done).toEqual({ ok: true });
    expect(f.writes).toEqual(['pnpm install\r', 'pnpm build\r', 'claude --x\r']);
    expect(f.listeners.size).toBe(0);
  });

  it('stops at a failing command and does not start the agent', async () => {
    const f = fakeTerminal();
    const done = runSetupSequence(f.t, ['false', 'never'], 'claude');
    f.emit({ kind: 'promptEnd' });
    f.emit({ kind: 'commandEnd', exitCode: 3 });
    expect(await done).toEqual({ ok: false, failedAt: 0, exitCode: 3 });
    expect(f.writes).toEqual(['false\r']);
  });

  it('starts typing after the prompt timeout when no prompt mark arrives', async () => {
    const f = fakeTerminal();
    const done = runSetupSequence(f.t, ['a'], 'agent', { promptTimeoutMs: 5 });
    await new Promise((r) => setTimeout(r, 20));
    expect(f.writes).toEqual(['a\r']);
    f.emit({ kind: 'commandEnd', exitCode: 0 });
    expect((await done).ok).toBe(true);
  });

  it('types everything ahead without shell integration', async () => {
    const f = fakeTerminal(false);
    expect(await runSetupSequence(f.t, ['a', 'b'], 'agent')).toEqual({ ok: true });
    expect(f.writes).toEqual(['a\r', 'b\r', 'agent\r']);
  });

  it('normalises user input', () => {
    expect(normalizeSetupCommands([' pnpm i \n\n  make ', ''])).toEqual(['pnpm i', 'make']);
  });
});

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});
function repo(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-agent-setup-'));
  tmpDirs.push(d);
  execFileSync('git', ['init', '-q', d]);
  return d;
}

describe.runIf(hasGit)('githappens.agentSetup in git config', () => {
  it('reads, writes (multi-valued) and clears', async () => {
    const r = repo();
    expect(await readSetupCommands(pathGitExec, r)).toEqual([]);
    expect(await writeSetupCommands(pathGitExec, r, ['npm ci', '', 'echo "a b"'])).toEqual([
      'npm ci',
      'echo "a b"',
    ]);
    expect(await readSetupCommands(pathGitExec, r)).toEqual(['npm ci', 'echo "a b"']);
    const raw = execFileSync('git', ['config', '--local', '--get-all', 'githappens.agentSetup'], {
      cwd: r,
      encoding: 'utf8',
    });
    expect(raw.trim().split('\n')).toEqual(['npm ci', 'echo "a b"']);
    await writeSetupCommands(pathGitExec, r, []);
    expect(await readSetupCommands(pathGitExec, r)).toEqual([]);
  });

  it('remembers per worktree that the commands ran', async () => {
    const r = repo();
    expect(await setupAlreadyRan(pathGitExec, r, ['a'])).toBe(false);
    await markSetupRan(pathGitExec, r, ['a']);
    expect(await setupAlreadyRan(pathGitExec, r, ['a'])).toBe(true);
    expect(await setupAlreadyRan(pathGitExec, r, ['a', 'b'])).toBe(false); // changed commands run again
  });

  it('agents:setup handlers round-trip', async () => {
    const r = repo();
    const ptys = new PtyService({ send: () => undefined });
    const h = createAgentsHandlers({
      ptys,
      settings: { get: (() => '') as never },
      broadcast: () => undefined,
      probe: null,
    });
    const ctx = { senderId: 1 } as never;
    expect(await h['agents:setup:set']({ repoPath: r, commands: ['make'] }, ctx)).toEqual(['make']);
    expect(await h['agents:setup:get']({ repoPath: r }, ctx)).toEqual(['make']);
    ptys.dispose();
  });
});

// ---- AgentMonitor: setup commands are typed into a visible shell session ----

class FakePty implements PtyProcess {
  readonly pid = 7;
  written: string[] = [];
  private dataL = new Set<(d: string) => void>();
  constructor(
    readonly file: string,
    readonly args: string[],
    readonly opts: PtySpawnOptions,
  ) {}
  onData(l: (d: string) => void) {
    this.dataL.add(l);
    return { dispose: () => this.dataL.delete(l) };
  }
  onExit() {
    return { dispose: () => undefined };
  }
  write(d: string) {
    this.written.push(d);
  }
  resize() {}
  kill() {}
  pause() {}
  resume() {}
  emit(d: string) {
    for (const l of this.dataL) l(d);
  }
}

describe('AgentMonitor.start with setup commands', () => {
  function setup(commands: string[], ran = false) {
    const spawned: FakePty[] = [];
    const mod: PtyModule = {
      spawn: (f, a, o) => {
        const p = new FakePty(f, a, o);
        spawned.push(p);
        return p;
      },
    };
    const ptys = new PtyService({
      loadPty: () => mod,
      send: () => undefined,
      platform: 'linux',
      env: { PATH: '/usr/bin', SHELL: '/bin/bash', HOME: '/home/me' },
      findOnPath: (e) => `/usr/bin/${e}`,
      shellIntegrationScripts: () => ({ bash: '/si/b.sh', zshDir: '/si/zsh', pwsh: '/si/p.ps1' }),
    });
    // A throwaway git dir: the once-per-worktree marker is written below it.
    const gitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-agent-gitdir-'));
    tmpDirs.push(gitDir);
    if (ran) {
      fs.mkdirSync(path.join(gitDir, 'githappens'));
      fs.writeFileSync(path.join(gitDir, 'githappens', 'agent-setup'), 'stale-hash\n');
    }
    const results: unknown[] = [];
    const monitor = new AgentMonitor({
      ptys,
      agentCommand: () => 'claude',
      agentArgs: () => ['--permission-mode', 'plan mode'],
      emit: () => undefined,
      platform: 'linux',
      isDirectory: () => true,
      onSetupDone: (_id, r) => results.push(r),
      git: async (args) => {
        if (args[0] === 'config')
          return { code: commands.length ? 0 : 1, stdout: commands.map((c) => `${c}\0`).join('') };
        if (args[0] === 'rev-parse') return { code: 0, stdout: `${gitDir}\n` };
        return { code: 1, stdout: '' };
      },
    });
    return { ptys, monitor, spawned, results, gitDir };
  }

  it('starts the agent directly when there are no setup commands', async () => {
    const s = setup([]);
    const r = await s.monitor.start(1, { cwd: '/w' });
    expect(r.setupCommands).toBeUndefined();
    expect(s.spawned[0]!.file).toBe('/bin/bash'); // POSIX login-shell launcher of createCommand
    expect(s.spawned[0]!.args).toContain('claude');
    s.monitor.dispose();
    s.ptys.dispose();
  });

  it('types the setup commands, then the quoted agent command, into an integrated shell', async () => {
    const s = setup(['pnpm install', 'pnpm build']);
    const r = await s.monitor.start(1, { cwd: '/w' });
    expect(r.setupCommands).toEqual(['pnpm install', 'pnpm build']);
    const pty = s.spawned[0]!;
    expect(pty.args).toEqual(['--rcfile', '/si/b.sh', '-i']); // interactive integrated shell
    // the session is listed as an agent (launched) and records output for the tab
    expect(s.ptys.snapshots(1)[0]!.launched).toEqual({
      command: 'claude',
      args: ['--permission-mode', 'plan mode'],
    });
    pty.emit('\x1b]133;A\x07$ \x1b]133;B\x07');
    expect(pty.written).toEqual(['pnpm install\r']);
    pty.emit('\x1b]133;C\x07done\r\n\x1b]133;D;0\x07');
    pty.emit('\x1b]133;C\x07built\r\n\x1b]133;D;0\x07');
    expect(pty.written).toEqual(['pnpm install\r', 'pnpm build\r', `claude --permission-mode 'plan mode'\r`]);
    await tick();
    expect(s.results).toEqual([{ ok: true }]);
    // once per worktree: the next session in this worktree starts the agent directly
    await new Promise((res) => setTimeout(res, 20));
    expect(fs.existsSync(path.join(s.gitDir, 'githappens', 'agent-setup'))).toBe(true);
    expect((await s.monitor.start(1, { cwd: '/w' })).setupCommands).toBeUndefined();
    s.monitor.dispose();
    s.ptys.dispose();
  });

  it('skips setup that already ran unless forced; `skip` never runs it', async () => {
    const s = setup(['make'], true);
    // marker hash only matches when the file exists; simulate "ran" via setup: 'skip' and 'force'
    const skipped = await s.monitor.start(1, { cwd: '/w', setup: 'skip' });
    expect(skipped.setupCommands).toBeUndefined();
    const forced = await s.monitor.start(1, { cwd: '/w', setup: 'force' });
    expect(forced.setupCommands).toEqual(['make']);
    s.monitor.dispose();
    s.ptys.dispose();
  });
});
