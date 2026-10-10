import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { completionTable } from '@githappens/git/completions';

import {
  createCompletionContextProvider,
  detectCompletionConflict,
  parseAliases,
} from '../src/main/terminal/completion-context';
import { detectShells, parseWslList, type ShellProbeEnv } from '../src/main/terminal/list-shells';
import { fileUrlToPath, OscScanner, parseOscPayload } from '../src/main/terminal/osc';
import {
  applyShellIntegration,
  BASH_SCRIPT,
  createScriptsDir,
  PWSH_SCRIPT,
  ZSH_RC,
  type ScriptFiles,
} from '../src/main/terminal/shell-integration';
import {
  PtyService,
  type PtyModule,
  type PtyProcess,
  type PtySpawnOptions,
} from '../src/main/services/pty-service';

const scripts: ScriptFiles = {
  bash: '/si/bash-integration.sh',
  zshDir: '/si/zsh',
  pwsh: "C:\\si\\it's\\pwsh.ps1",
};
const env = { HOME: '/home/me', PATH: '/usr/bin' };

describe('applyShellIntegration', () => {
  it('bash: --rcfile + emulated login', () => {
    const r = applyShellIntegration({
      shell: '/bin/bash',
      args: ['-l'],
      defaultArgs: true,
      platform: 'linux',
      env,
      scripts,
    });
    expect(r).toMatchObject({
      injected: true,
      kind: 'bash',
      args: ['--rcfile', '/si/bash-integration.sh', '-i'],
    });
    expect(r.env.GITHAPPENS_SHELL_LOGIN).toBe('1');
    // Git Bash on Windows gets a forward-slash path
    const w = applyShellIntegration({
      shell: 'C:\\Program Files\\Git\\bin\\bash.exe',
      args: ['--login', '-i'],
      defaultArgs: true,
      platform: 'win32',
      env,
      scripts: { ...scripts, bash: 'C:\\Temp\\si\\bash-integration.sh' },
    });
    expect(w.args).toEqual(['--rcfile', 'C:/Temp/si/bash-integration.sh', '-i']);
  });

  it('zsh: ZDOTDIR shim remembering the user ZDOTDIR', () => {
    const r = applyShellIntegration({
      shell: '/bin/zsh',
      args: ['-l'],
      defaultArgs: true,
      platform: 'darwin',
      env: { ...env, ZDOTDIR: '/cfg/zsh' },
      scripts,
    });
    expect(r.args).toEqual(['-l']);
    expect(r.env).toMatchObject({ ZDOTDIR: '/si/zsh', GITHAPPENS_USER_ZDOTDIR: '/cfg/zsh' });
    const h = applyShellIntegration({
      shell: '/bin/zsh',
      args: ['-l'],
      defaultArgs: true,
      platform: 'linux',
      env,
      scripts,
    });
    expect(h.env.GITHAPPENS_USER_ZDOTDIR).toBe('/home/me');
  });

  it('pwsh: -NoExit -Command with a policy-proof script block and quoted path', () => {
    const r = applyShellIntegration({
      shell: 'C:\\x\\pwsh.exe',
      args: ['-NoLogo'],
      defaultArgs: true,
      platform: 'win32',
      env,
      scripts,
    });
    expect(r.injected).toBe(true);
    expect(r.args.slice(0, 3)).toEqual(['-NoLogo', '-NoExit', '-Command']);
    expect(r.args[3]).toContain("ReadAllText('C:\\si\\it''s\\pwsh.ps1')");
  });

  it('falls back for custom args and unsupported shells', () => {
    for (const shell of [
      'cmd.exe',
      'C:\\Windows\\System32\\wsl.exe',
      '/usr/bin/fish',
      'C:\\Windows\\System32\\bash.exe',
    ]) {
      expect(
        applyShellIntegration({ shell, args: [], defaultArgs: true, platform: 'win32', env, scripts })
          .injected,
      ).toBe(false);
    }
    const custom = applyShellIntegration({
      shell: '/bin/bash',
      args: ['--norc'],
      defaultArgs: false,
      platform: 'linux',
      env,
      scripts,
    });
    expect(custom).toMatchObject({ injected: false, args: ['--norc'] });
  });

  it('scripts emit OSC 7 and OSC 133 A/B/C/D', () => {
    for (const s of [BASH_SCRIPT, ZSH_RC]) {
      expect(s).toContain(String.raw`\033]133;D;%s\007`);
      expect(s).toContain(String.raw`\033]133;C\007`);
      expect(s).toContain('133;A');
      expect(s).toContain('133;B');
      expect(s).toContain(String.raw`\033]7;file://`);
    }
    expect(BASH_SCRIPT).toContain('.bash_profile');
    expect(BASH_SCRIPT).toContain('.bashrc');
    expect(PWSH_SCRIPT).toContain('133;D;$code');
    expect(PWSH_SCRIPT).toContain('7;file://');
  });

  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });
  it('writes the scripts into a private temp folder', () => {
    const r = createScriptsDir();
    dirs.push(r.dir);
    expect(fs.readFileSync(r.bash, 'utf8')).toBe(BASH_SCRIPT);
    expect(fs.existsSync(path.join(r.zshDir, '.zshenv'))).toBe(true);
    expect(fs.existsSync(path.join(r.zshDir, '.zshrc'))).toBe(true);
    expect(fs.existsSync(r.pwsh)).toBe(true);
    expect(path.dirname(r.dir)).toBe(path.resolve(os.tmpdir()));
  });
});

describe('OSC parsing', () => {
  it('parses payloads', () => {
    expect(parseOscPayload('133;A', 'linux')).toEqual({ kind: 'promptStart' });
    expect(parseOscPayload('133;B', 'linux')).toEqual({ kind: 'promptEnd' });
    expect(parseOscPayload('133;C', 'linux')).toEqual({ kind: 'commandStart' });
    expect(parseOscPayload('133;D;127', 'linux')).toEqual({ kind: 'commandEnd', exitCode: 127 });
    expect(parseOscPayload('133;D', 'linux')).toEqual({ kind: 'commandEnd' });
    expect(parseOscPayload('0;title', 'linux')).toBeNull();
    expect(parseOscPayload('7;file://host/home/me/my%20repo', 'linux')).toEqual({
      kind: 'cwd',
      cwd: '/home/me/my repo',
    });
  });

  it('maps file URLs to Windows paths', () => {
    expect(fileUrlToPath('file://PC/c/Users/me', 'win32')).toBe('C:\\Users\\me');
    expect(fileUrlToPath('file://PC/C:/Users/me/a b', 'win32')).toBe('C:\\Users\\me\\a b');
    expect(fileUrlToPath('file://PC//server/share/x', 'win32')).toBe('\\\\server\\share\\x');
    expect(fileUrlToPath('file://PC/d', 'win32')).toBe('D:\\');
    expect(fileUrlToPath('file://host/home/me', 'win32')).toBeNull();
    expect(fileUrlToPath('nonsense', 'linux')).toBeNull();
  });

  it('scans sequences split across chunks, BEL and ST terminators', () => {
    const sc = new OscScanner('linux');
    expect(sc.feed('out\x1b]133;D;0\x07\x1b]7;file://h/tmp')).toEqual([{ kind: 'commandEnd', exitCode: 0 }]);
    expect(sc.feed('/x\x1b\\prompt \x1b')).toEqual([{ kind: 'cwd', cwd: '/tmp/x' }]);
    expect(sc.feed(']133;B\x07')).toEqual([{ kind: 'promptEnd' }]);
    expect(sc.feed('plain text')).toEqual([]);
  });
});

describe('shell detection', () => {
  it('parses wsl -l -q (UTF-16LE)', () => {
    expect(parseWslList(Buffer.from('Ubuntu\r\nDebian\r\n', 'utf16le'))).toEqual(['Ubuntu', 'Debian']);
    expect(parseWslList('')).toEqual([]);
  });

  const probe = (o: Partial<ShellProbeEnv> & { files: string[] }): ShellProbeEnv => ({
    platform: 'win32',
    env: {},
    findOnPath: () => null,
    isFile: (p) => o.files.includes(p),
    readFile: () => null,
    wslDistros: async () => [],
    ...o,
  });

  it('lists Windows shells incl. Git Bash next to git and WSL distros', async () => {
    const shells = await detectShells(
      probe({
        env: { SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\System32\\cmd.exe', ProgramFiles: 'C:\\PF' },
        files: [
          'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
          'C:\\Windows\\System32\\cmd.exe',
          'C:\\Windows\\System32\\wsl.exe',
          'D:\\Git\\bin\\bash.exe',
          'C:\\PF\\PowerShell\\7\\pwsh.exe',
        ],
        findOnPath: (e) => (e === 'git.exe' ? 'D:\\Git\\cmd\\git.exe' : null),
        wslDistros: async () => ['Ubuntu'],
      }),
    );
    expect(shells.map((s) => s.id)).toEqual(['pwsh', 'powershell', 'cmd', 'git-bash', 'wsl:Ubuntu']);
    expect(shells.find((s) => s.id === 'wsl:Ubuntu')).toMatchObject({
      args: ['-d', 'Ubuntu'],
      name: 'WSL: Ubuntu',
    });
    expect(shells.find((s) => s.id === 'git-bash')!.path).toBe('D:\\Git\\bin\\bash.exe');
  });

  it('lists /etc/shells + $SHELL on Unix', async () => {
    const shells = await detectShells(
      probe({
        platform: 'linux',
        env: { SHELL: '/usr/bin/zsh' },
        files: ['/usr/bin/zsh', '/bin/bash', '/usr/sbin/nologin'],
        readFile: () => '# comment\n/bin/bash\n/usr/bin/zsh\n/usr/sbin/nologin\n/bin/missing\n',
      }),
    );
    expect(shells.map((s) => s.name)).toEqual(['zsh', 'bash']);
  });
});

describe('completion context', () => {
  it('parses aliases and detects conflicting completion tools', async () => {
    expect(parseAliases('alias.st\nstatus -sb\0alias.sync\n!git pull && git push\0')).toEqual([
      { name: 'st', expansion: 'status -sb' },
      { name: 'sync', expansion: '!git pull && git push' },
    ]);
    const none = { env: {}, home: '/h', exists: () => false };
    expect(detectCompletionConflict(none)).toBeNull();
    expect(detectCompletionConflict({ ...none, env: { Q_TERM: '1' } })).toMatch(/Amazon Q/);
    expect(
      detectCompletionConflict({ ...none, exists: (p) => p.replace(/\\/g, '/') === '/h/.fig/bin' }),
    ).toMatch(/Fig/);

    let calls = 0;
    const get = createCompletionContextProvider({
      env: {},
      exists: () => false,
      git: async (args) => {
        calls++;
        expect(args).toEqual(['config', '-z', '--get-regexp', '^alias\\.']);
        return 'alias.co\ncheckout\0';
      },
    });
    expect(await get('/r')).toEqual({ aliases: [{ name: 'co', expansion: 'checkout' }], conflict: null });
    await get('/r');
    expect(calls).toBe(1); // cached
  });

  it('ships a generated completion table', () => {
    expect(completionTable.commands.commit?.flags).toContain('--amend');
  });
});

// ---- PtyService wiring ----

class FakePty implements PtyProcess {
  readonly pid = 4242;
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

function service(platform: NodeJS.Platform = 'linux') {
  const spawned: FakePty[] = [];
  const mod: PtyModule = {
    spawn: (f, a, o) => {
      const p = new FakePty(f, a, o);
      spawned.push(p);
      return p;
    },
  };
  const svc = new PtyService({
    loadPty: () => mod,
    send: () => undefined,
    platform,
    env: { PATH: '/usr/bin', HOME: os.homedir(), SHELL: '/bin/bash' },
    findOnPath: () => null,
    homedir: () => os.tmpdir(),
    shellIntegrationScripts: () => scripts,
    batchMs: 1,
  });
  return { svc, spawned };
}

describe('PtyService shell integration', () => {
  it('injects integration on request and exports GITHAPPENS_REPO / TERM_PROGRAM', async () => {
    const { svc, spawned } = service();
    const info = await svc.create(1, {
      cwd: os.tmpdir(),
      cols: 80,
      rows: 24,
      repoPath: '/repo',
      shellIntegration: true,
    });
    expect(info.shellIntegration).toBe(true);
    expect(spawned[0]!.args).toEqual(['--rcfile', '/si/bash-integration.sh', '-i']);
    expect(spawned[0]!.opts.env).toMatchObject({
      GITHAPPENS_REPO: '/repo',
      TERM_PROGRAM: 'GitHappens',
      GITHAPPENS_SHELL_LOGIN: '1',
    });

    const plain = await svc.create(1, { cwd: os.tmpdir(), cols: 80, rows: 24 });
    expect(plain.shellIntegration).toBeUndefined();
    expect(spawned[1]!.args).toEqual(['-l']);
    expect(spawned[1]!.opts.env.GITHAPPENS_REPO).toBe(os.tmpdir());
    svc.dispose();
  });

  it('tracks OSC 7 cwd and forwards shell events', async () => {
    const { svc, spawned } = service();
    const info = await svc.create(1, { cwd: os.tmpdir(), cols: 80, rows: 24, shellIntegration: true });
    const events: string[] = [];
    svc.onShellEvent(info.id, (e) => events.push(e.kind === 'commandEnd' ? `D${e.exitCode}` : e.kind));
    spawned[0]!.emit('x\x1b]7;file://h/work/repo\x07\x1b]133;A\x07$ \x1b]133;');
    spawned[0]!.emit('B\x07');
    spawned[0]!.emit('\x1b]133;C\x07ok\r\n\x1b]133;D;2\x07');
    expect(events).toEqual(['cwd', 'promptStart', 'promptEnd', 'commandStart', 'D2']);
    expect(svc.list(1)[0]!.currentCwd).toBe('/work/repo');
    svc.dispose();
  });

  it('lists shells through the injected source (cached)', async () => {
    let n = 0;
    const svc = new PtyService({
      send: () => undefined,
      listShells: async () => {
        n++;
        return [{ id: 'bash', name: 'bash', path: '/bin/bash' }];
      },
    });
    expect(await svc.listShells()).toHaveLength(1);
    await svc.listShells();
    expect(n).toBe(1);
  });
});
