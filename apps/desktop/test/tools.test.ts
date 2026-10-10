import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { GitOperation } from '@githappens/git';
import { describe, expect, it } from 'vitest';

import { createToolsHandlers } from '../src/main/ipc/tools-handlers';
import { lineStyleForExe } from '../src/main/tools/catalog';
import { detectTools, ToolDetector } from '../src/main/tools/detect';
import { expandGlob, findExe, nodeToolEnv, type ToolEnv } from '../src/main/tools/env';
import { cleanupDiffTemp, gitDifftoolArgs, materializeDiff } from '../src/main/tools/external-diff';
import {
  customTerminalArgv,
  editorArgs,
  resolveLaunch,
  terminalArgv,
  windowsStartLaunch,
  type Launch,
} from '../src/main/tools/launch';
import { ToolsService, type ToolsServiceDeps } from '../src/main/tools/tools-service';
import { TOOLS_INVOKE_CHANNELS } from '../src/shared/ipc/tools-contract';
import { expandToolCommand } from '../src/shared/settings/external-tools';
import { defaultValues, type SettingKey, type SettingsValues } from '../src/shared/settings/registry';
import { gitPath, useTestRepos } from './ai-test-repo';

// ---- fake OS ----------------------------------------------------------------------------------------

function fakeEnv(
  platform: NodeJS.Platform,
  files: string[],
  dirs: string[] = [],
  env: NodeJS.ProcessEnv = {},
): ToolEnv {
  const P = platform === 'win32' ? path.win32 : path.posix;
  const norm = (p: string): string => (platform === 'win32' ? P.normalize(p).toLowerCase() : P.normalize(p));
  const fileSet = new Set(files.map(norm));
  const dirSet = new Set(dirs.map(norm));
  // Every parent of a file/dir is a directory.
  for (const f of [...files, ...dirs]) {
    let d = P.dirname(f);
    while (d !== P.dirname(d)) {
      dirSet.add(norm(d));
      d = P.dirname(d);
    }
  }
  const all = [...files, ...dirs];
  return {
    platform,
    env,
    homedir: platform === 'win32' ? 'C:\\Users\\u' : '/home/u',
    isFile: (p) => fileSet.has(norm(p)),
    isDir: (p) => dirSet.has(norm(p)),
    listDir: (p) => {
      const base = norm(p);
      const names = new Set<string>();
      for (const f of all) {
        const n = norm(f);
        if (n.startsWith(base.endsWith(P.sep) ? base : base + P.sep)) {
          const rest = f.slice(P.normalize(p).replace(/[\\/]$/, '').length + 1);
          names.add(rest.split(/[\\/]/)[0]!);
        }
      }
      return [...names];
    },
  };
}

const WIN_ENV = {
  Path: 'C:\\Windows\\System32;C:\\Users\\u\\AppData\\Local\\Programs\\Microsoft VS Code\\bin',
  PATHEXT: '.COM;.EXE;.BAT;.CMD',
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
  SystemRoot: 'C:\\Windows',
  ComSpec: 'C:\\Windows\\System32\\cmd.exe',
};

function winEnv(): ToolEnv {
  return fakeEnv(
    'win32',
    [
      'C:\\Windows\\System32\\cmd.exe',
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      'C:\\Users\\u\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd',
      'C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe',
      'C:\\Program Files\\Git\\git-bash.exe',
      'C:\\Program Files\\JetBrains\\IntelliJ IDEA 2024.3\\bin\\idea64.exe',
      'C:\\Program Files\\JetBrains\\IntelliJ IDEA 2025.2\\bin\\idea64.exe',
      'C:\\Program Files\\KDiff3\\kdiff3.exe',
      'C:\\Program Files\\Beyond Compare 5\\BComp.exe',
    ],
    [],
    WIN_ENV,
  );
}

const byId = <T extends { id: string }>(xs: T[], id: string): T | undefined => xs.find((x) => x.id === id);

// ---- detection --------------------------------------------------------------------------------------

describe('tool detection', () => {
  it('finds Windows tools on PATH (PATHEXT) and in install folders, with wildcard versions', () => {
    const d = detectTools(winEnv(), 1);
    expect(byId(d.editors, 'vscode')).toMatchObject({
      path: 'C:\\Users\\u\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd',
      source: 'path',
    });
    expect(byId(d.editors, 'intellij')).toMatchObject({
      path: 'C:\\Program Files\\JetBrains\\IntelliJ IDEA 2025.2\\bin\\idea64.exe',
      source: 'install',
    });
    expect(byId(d.editors, 'sublime')?.path).toBeNull();
    expect(byId(d.terminals, 'windows-terminal')?.path).toMatch(/WindowsApps\\wt\.exe$/);
    expect(byId(d.terminals, 'powershell')?.path).toMatch(/powershell\.exe$/);
    expect(byId(d.terminals, 'git-bash')?.path).toBe('C:\\Program Files\\Git\\git-bash.exe');
    expect(byId(d.terminals, 'iterm2')).toBeUndefined(); // macOS only
    expect(byId(d.diffTools, 'kdiff3')?.path).toBe('C:\\Program Files\\KDiff3\\kdiff3.exe');
    expect(byId(d.diffTools, 'beyondcompare')?.path).toBe('C:\\Program Files\\Beyond Compare 5\\BComp.exe');
    expect(byId(d.diffTools, 'vscode')?.path).toMatch(/code\.cmd$/);
    expect(byId(d.diffTools, 'filemerge')).toBeUndefined();
    expect(d.scannedAt).toBe(1);
  });

  it('finds macOS app bundles and binaries inside them', () => {
    const e = fakeEnv(
      'darwin',
      [
        '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
        '/usr/bin/opendiff',
        '/usr/bin/open',
      ],
      ['/Applications/iTerm.app', '/System/Applications/Utilities/Terminal.app'],
      { PATH: '/usr/bin:/bin' },
    );
    const d = detectTools(e);
    expect(byId(d.editors, 'vscode')).toMatchObject({ source: 'install' });
    expect(byId(d.terminals, 'iterm2')?.path).toBe('/Applications/iTerm.app');
    expect(byId(d.terminals, 'terminal-app')?.path).toBe('/System/Applications/Utilities/Terminal.app');
    expect(byId(d.terminals, 'warp')?.path).toBeNull();
    expect(byId(d.diffTools, 'filemerge')?.path).toBe('/usr/bin/opendiff');
    expect(byId(d.terminals, 'powershell')).toBeUndefined();
  });

  it('finds Linux tools on PATH and expands ~', () => {
    const e = fakeEnv(
      'linux',
      [
        '/usr/bin/gnome-terminal',
        '/usr/bin/subl',
        '/usr/bin/meld',
        '/home/u/.local/share/JetBrains/Toolbox/scripts/idea',
      ],
      [],
      { PATH: '/usr/local/bin:/usr/bin' },
    );
    const d = detectTools(e);
    expect(byId(d.terminals, 'gnome-terminal')).toMatchObject({
      path: '/usr/bin/gnome-terminal',
      source: 'path',
    });
    expect(byId(d.editors, 'sublime')?.path).toBe('/usr/bin/subl');
    expect(byId(d.editors, 'intellij')?.path).toBe('/home/u/.local/share/JetBrains/Toolbox/scripts/idea');
    expect(byId(d.diffTools, 'meld')?.path).toBe('/usr/bin/meld');
    expect(byId(d.terminals, 'konsole')?.path).toBeNull();
  });

  it('caches the scan until refresh', () => {
    let calls = 0;
    const e = winEnv();
    const counting: ToolEnv = { ...e, isFile: (p) => (calls++, e.isFile(p)) };
    const det = new ToolDetector(counting);
    det.detect();
    const after = calls;
    det.detect();
    expect(calls).toBe(after);
    det.detect(true);
    expect(calls).toBeGreaterThan(after);
  });

  it('PATH lookup honours PATHEXT and expandGlob sorts versions', () => {
    const e = winEnv();
    expect(findExe('code', e)).toMatch(/code\.cmd$/);
    expect(findExe('nope', e)).toBeNull();
    expect(expandGlob('C:\\Program Files\\JetBrains\\IntelliJ IDEA*\\bin\\idea64.exe', e)).toEqual([
      'C:\\Program Files\\JetBrains\\IntelliJ IDEA 2024.3\\bin\\idea64.exe',
      'C:\\Program Files\\JetBrains\\IntelliJ IDEA 2025.2\\bin\\idea64.exe',
    ]);
  });
});

// ---- launch construction ---------------------------------------------------------------------------

describe('launch argv construction', () => {
  const file = '/repo/src/my file.ts';

  it('builds editor line arguments per editor family', () => {
    expect(editorArgs('goto', file, 12)).toEqual(['-g', '/repo/src/my file.ts:12']);
    expect(editorArgs('colon', file, 12)).toEqual(['/repo/src/my file.ts:12']);
    expect(editorArgs('jetbrains', file, 12)).toEqual(['--line', '12', '/repo/src/my file.ts']);
    expect(editorArgs('plain', file, 12)).toEqual([file]);
    expect(editorArgs('goto', file)).toEqual([file]);
    expect(editorArgs('goto', file, 0)).toEqual([file]);
    expect(lineStyleForExe('C:\\x\\Code.exe')).toBe('goto');
    expect(lineStyleForExe('/opt/idea/bin/idea.sh')).toBe('jetbrains');
    expect(lineStyleForExe('/usr/bin/subl')).toBe('colon');
    expect(lineStyleForExe('/usr/bin/vim')).toBe('plain');
  });

  it('runs Windows .cmd shims through cmd /d /s /c with every argument quoted', () => {
    const l = resolveLaunch(['code', '-g', 'C:\\My Repo\\a b.ts:3'], winEnv(), 'editor');
    expect(l.file).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(l.verbatim).toBe(true);
    expect(l.args).toEqual([
      '/d',
      '/s',
      '/c',
      '""C:\\Users\\u\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd" "-g" "C:\\My Repo\\a b.ts:3""',
    ]);
  });

  it('refuses cmd metacharacters for .cmd shims instead of escaping them', () => {
    for (const bad of [
      'C:\\a&b\\x.ts',
      'C:\\100%\\x.ts',
      'C:\\a!b.ts',
      'C:\\a"b.ts',
      'C:\\a^b.ts',
      'C:\\a|b.ts',
    ]) {
      expect(() => resolveLaunch(['code', bad], winEnv(), 'editor'), bad).toThrow(
        /Cannot pass this path safely/,
      );
    }
    // .exe tools get the raw argv: no shell, nothing to escape
    const l = resolveLaunch(['C:\\Program Files\\KDiff3\\kdiff3.exe', 'C:\\a&b\\x.ts'], winEnv(), 'diff');
    expect(l).toEqual({ file: 'C:\\Program Files\\KDiff3\\kdiff3.exe', args: ['C:\\a&b\\x.ts'] });
  });

  it('reports a missing tool as "configure in Preferences"', () => {
    const e = fakeEnv('linux', [], [], { PATH: '/usr/bin' });
    expect(() => resolveLaunch(['code', 'x'], e, 'editor')).toThrow(
      'Editor not found — configure in Preferences',
    );
    try {
      resolveLaunch(['/opt/none/tool'], e, 'terminal');
    } catch (err) {
      expect(
        (err as { serialized: { details: Record<string, string> } }).serialized.details.toolNotFound,
      ).toBe('terminal');
    }
  });

  it('builds terminal argv per terminal without putting the folder in a command string', () => {
    const cwd = 'C:\\My Repo';
    expect(terminalArgv('windows-terminal', 'wt.exe', cwd, 'win32').argv).toEqual(['wt.exe', '-d', cwd]);
    expect(terminalArgv('git-bash', 'git-bash.exe', cwd, 'win32').argv).toEqual([
      'git-bash.exe',
      '--cd=C:\\My Repo',
    ]);
    expect(terminalArgv('powershell', 'pwsh.exe', cwd, 'win32')).toEqual({
      argv: ['pwsh.exe', '-NoExit'],
      cwd,
    });
    expect(terminalArgv('iterm2', '/Applications/iTerm.app', '/r', 'darwin').argv).toEqual([
      '/usr/bin/open',
      '-a',
      '/Applications/iTerm.app',
      '/r',
    ]);
    expect(terminalArgv('gnome-terminal', 'gnome-terminal', '/r', 'linux').argv).toEqual([
      'gnome-terminal',
      '--working-directory=/r',
    ]);
    expect(terminalArgv('konsole', 'konsole', '/r', 'linux').argv).toEqual(['konsole', '--workdir', '/r']);
    expect(terminalArgv('kitty', 'kitty', '/r', 'linux').argv).toEqual(['kitty', '--directory', '/r']);
    expect(terminalArgv('alacritty', 'alacritty', '/r', 'linux').argv).toEqual([
      'alacritty',
      '--working-directory',
      '/r',
    ]);
    expect(terminalArgv('xterm', 'xterm', '/r', 'linux')).toEqual({ argv: ['xterm'], cwd: '/r' });
  });

  it('expands custom terminal templates (%d inside words, quoted executables with spaces)', () => {
    expect(
      customTerminalArgv('"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -WorkingDirectory %d', 'C:\\a b').argv,
    ).toEqual(['C:\\Program Files\\PowerShell\\7\\pwsh.exe', '-WorkingDirectory', 'C:\\a b']);
    expect(customTerminalArgv('wezterm start --cwd=%d', "/it's here").argv).toEqual([
      'wezterm',
      'start',
      "--cwd=/it's here",
    ]);
    expect(() => customTerminalArgv('  ', '/x')).toThrow(/Terminal not found/);
  });

  it('starts Windows console terminals in their own window via start', () => {
    const l = windowsStartLaunch('C:\\Program Files\\PowerShell\\7\\pwsh.exe', ['-NoExit'], winEnv());
    expect(l).toEqual({
      file: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', '"start "" "C:\\Program Files\\PowerShell\\7\\pwsh.exe" "-NoExit""'],
      verbatim: true,
    });
    expect(() => windowsStartLaunch('C:\\x&y\\pwsh.exe', [], winEnv())).toThrow(/safely/);
  });

  it('substitutes custom diff/merge templates into single argv entries even with spaces and quotes', () => {
    const vars = {
      LOCAL: '/tmp/a b/old "x".ts',
      REMOTE: "/tmp/it's/new.ts",
      BASE: '/b',
      MERGED: '/m e/r.ts',
    };
    expect(expandToolCommand('"/opt/My Tool/tool" --diff $LOCAL $REMOTE', vars)).toEqual([
      '/opt/My Tool/tool',
      '--diff',
      '/tmp/a b/old "x".ts',
      "/tmp/it's/new.ts",
    ]);
    expect(expandToolCommand('tool -o=$MERGED $BASE', vars)).toEqual(['tool', '-o=/m e/r.ts', '/b']);
    expect(() => expandToolCommand('tool $BASE', { LOCAL: 'a' })).toThrow(/\$BASE/);
  });
});

// ---- git difftool passthrough ----------------------------------------------------------------------

describe('git difftool arguments', () => {
  const base = { repoId: 'r', path: 'a.txt' };
  it('maps the diff view to difftool arguments with the path after --', () => {
    expect(gitDifftoolArgs({ ...base, oldRev: 'INDEX', newRev: 'WORKTREE' })).toEqual([
      'difftool',
      '--no-prompt',
      '--',
      'a.txt',
    ]);
    expect(gitDifftoolArgs({ ...base, oldRev: 'HEAD', newRev: 'INDEX' })).toEqual([
      'difftool',
      '--no-prompt',
      '--cached',
      '--',
      'a.txt',
    ]);
    expect(
      gitDifftoolArgs({ ...base, oldRev: 'p', newRev: 'c', spec: { kind: 'commit', sha: 'c' } }),
    ).toEqual(['difftool', '--no-prompt', 'c^', 'c', '--', 'a.txt']);
    expect(
      gitDifftoolArgs({
        ...base,
        oldPath: 'old.txt',
        oldRev: 'x',
        newRev: 'y',
        spec: { kind: 'range', from: 'x', to: 'y' },
      }),
    ).toEqual(['difftool', '--no-prompt', 'x', 'y', '--', 'old.txt', 'a.txt']);
    expect(gitDifftoolArgs({ ...base, oldRev: 'abc', newRev: 'def' })).toEqual([
      'difftool',
      '--no-prompt',
      'abc',
      'def',
      '--',
      'a.txt',
    ]);
    expect(() => gitDifftoolArgs({ ...base, oldRev: '', newRev: 'WORKTREE' })).toThrow(/untracked/);
    expect(() => gitDifftoolArgs({ ...base, oldRev: '--output=x', newRev: 'y' })).toThrow(/Invalid revision/);
  });
});

// ---- service (fake spawner, real repos) -----------------------------------------------------------

type Spawned = { l: Launch; cwd?: string };

function makeService(
  over: Partial<SettingsValues>,
  o: {
    env?: ToolEnv;
    repos?: ToolsServiceDeps['repos'];
    spawnAndWait?: ToolsServiceDeps['spawnAndWait'];
    tmpRoot?: string;
  } = {},
) {
  const values = { ...defaultValues(), ...over } as SettingsValues;
  const spawned: Spawned[] = [];
  const opened: string[] = [];
  const revealed: string[] = [];
  const svc = new ToolsService({
    env: o.env ?? nodeToolEnv(),
    settings: { get: <K extends SettingKey>(k: K) => values[k] },
    repos:
      o.repos ??
      ({
        get: () => {
          throw new Error('no repos');
        },
        runOp: async () => ({ opId: 'x' }),
      } as ToolsServiceDeps['repos']),
    shell: {
      openPath: async (p) => (opened.push(p), ''),
      showItemInFolder: (p) => void revealed.push(p),
    },
    tmpRoot: o.tmpRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), 'kl-tools-')),
    spawnDetached: async (l, so) => void spawned.push({ l, cwd: so.cwd }),
    ...(o.spawnAndWait ? { spawnAndWait: o.spawnAndWait } : {}),
  });
  return { svc, spawned, opened, revealed, values };
}

describe('ToolsService open actions', () => {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-tools-open-')));
  const target = path.join(tmp, 'my file.txt');
  fs.writeFileSync(target, 'x\n');

  it('opens the configured editor at a line with the detected executable', async () => {
    const exe = path.join(tmp, process.platform === 'win32' ? 'subl.exe' : 'subl');
    fs.writeFileSync(exe, '');
    const { svc, spawned } = makeService({ 'tools.editor': 'sublime', 'tools.editorPath': exe });
    const r = await svc.openEditor({ path: target }, 7);
    expect(r.launched).toBe('Sublime Text');
    expect(spawned[0]!.l).toEqual({ file: exe, args: [`${target}:7`] });
    expect(spawned[0]!.cwd).toBe(tmp);
  });

  it('guesses the line style of a custom editor and falls back to the OS default with no editor', async () => {
    const exe = path.join(tmp, process.platform === 'win32' ? 'idea64.exe' : 'idea');
    fs.writeFileSync(exe, '');
    const a = makeService({ 'tools.editor': 'custom', 'tools.editorPath': exe });
    await a.svc.openEditor({ path: target }, 3);
    expect(a.spawned[0]!.l.args).toEqual(['--line', '3', target]);

    const b = makeService({ 'tools.editor': 'none' });
    expect((await b.svc.openEditor({ path: target })).launched).toBe('default program');
    expect(b.opened).toEqual([target]);
    expect(b.spawned).toEqual([]);

    const c = makeService({ 'tools.editor': 'custom', 'tools.editorPath': '' });
    await expect(c.svc.openEditor({ path: target })).rejects.toThrow(
      /Editor not found — configure in Preferences/,
    );
  });

  it('opens the OS-default terminal (first detected) and custom terminal commands', async () => {
    const e = winEnv();
    const cwd = 'C:\\repo dir';
    const env: ToolEnv = { ...e, isDir: (p) => p === cwd || e.isDir(p) };
    const a = makeService({ 'tools.terminal': 'os' }, { env });
    expect((await a.svc.openTerminal(cwd)).launched).toBe('Windows Terminal');
    expect(a.spawned[0]!.l).toEqual({
      file: 'C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe',
      args: ['-d', cwd],
    });

    const b = makeService({ 'tools.terminal': 'powershell' }, { env });
    await b.svc.openTerminal(cwd);
    expect(b.spawned[0]!.l.file).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(b.spawned[0]!.l.args[3]).toBe(
      '"start "" "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" "-NoExit""',
    );
    expect(b.spawned[0]!.cwd).toBe(cwd);

    const lin = fakeEnv('linux', ['/usr/bin/kitty'], ['/r'], { PATH: '/usr/bin' });
    const c = makeService(
      { 'tools.terminal': 'custom', 'tools.terminalCommand': 'kitty --directory=%d' },
      { env: lin },
    );
    await c.svc.openTerminal('/r');
    expect(c.spawned[0]!.l).toEqual({ file: '/usr/bin/kitty', args: ['--directory=/r'] });

    const none = fakeEnv('linux', [], ['/r'], { PATH: '/usr/bin' });
    const d = makeService({ 'tools.terminal': 'os' }, { env: none });
    await expect(d.svc.openTerminal('/r')).rejects.toThrow(/Terminal not found — configure in Preferences/);
  });

  it('reveals files, opens folders, and rejects relative paths without a repo', async () => {
    const { svc, opened, revealed } = makeService({});
    await svc.openFileManager({ path: target });
    await svc.openFileManager({ path: tmp });
    expect(revealed).toEqual([target]);
    expect(opened).toEqual([tmp]);
    await expect(svc.openDefault({ path: 'relative.txt' })).rejects.toThrow(/absolute/);
  });
});

const describeGit = gitPath ? describe : describe.skip;

describeGit('ToolsService with a repository', () => {
  const repos = useTestRepos('tools');

  const reposFor = (
    svcs: Awaited<ReturnType<typeof repos.make>>,
    ops: GitOperation[] = [],
  ): ToolsServiceDeps['repos'] => ({
    get: () => svcs.svc,
    runOp: async (_id, op) => {
      ops.push(op);
      if (op.type === 'conflict.markResolved') svcs.git('add', '--', ...op.paths);
      return { opId: 'op' };
    },
  });

  it('keeps repo-relative paths inside the working tree', async () => {
    const r = await repos.make();
    const { svc } = makeService({}, { repos: reposFor(r) });
    expect(svc.resolvePath({ repoId: 'r', path: 'README.md' })).toBe(path.join(r.dir, 'README.md'));
    expect(svc.resolvePath({ repoId: 'r', path: '' })).toBe(r.dir);
    expect(() => svc.resolvePath({ repoId: 'r', path: '../escape.txt' })).toThrow(/outside the working tree/);
  });

  it('materializes old/new revisions to read-only temp files for the diff tool', async () => {
    const r = await repos.make({ 'a.txt': 'one\n' });
    r.write('a.txt', 'two\n');
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-diff-'));
    const exe = path.join(tmpRoot, process.platform === 'win32' ? 'difftool.exe' : 'difftool');
    fs.writeFileSync(exe, '');
    const { svc, spawned } = makeService(
      { 'tools.diffTool': 'custom', 'tools.customDiffCmd': `"${exe}" --left $LOCAL --right=$REMOTE` },
      { repos: reposFor(r), tmpRoot },
    );
    const res = await svc.openDiff({ repoId: 'r', path: 'a.txt', oldRev: 'HEAD', newRev: 'WORKTREE' });
    expect(res).toEqual({ launched: 'custom diff tool', via: 'tool' });
    const [, left, right] = spawned[0]!.l.args;
    expect(spawned[0]!.l.file).toBe(exe);
    expect(fs.readFileSync(left!, 'utf8')).toBe('one\n');
    expect(left!.startsWith(path.join(tmpRoot, 'githappens'))).toBe(true);
    expect(path.basename(left!)).toBe('a.txt');
    expect(right).toBe('--right=' + path.join(r.dir, 'a.txt')); // worktree side is the real file
    expect(() => fs.writeFileSync(left!, 'nope')).toThrow(); // read-only
    // empty side for an added file, INDEX side via stage 0
    r.write('b.txt', 'new\n');
    r.git('add', 'b.txt');
    const sides = await materializeDiff(
      { repoId: 'r', path: 'b.txt', oldRev: '', newRev: 'INDEX' },
      {
        tmpRoot,
        worktreeFile: (rel) => path.join(r.dir, rel),
        readBlob: async (rev, p) => {
          const f = await r.svc.showFile(rev, p);
          return f.content == null
            ? null
            : Buffer.from(f.content, f.encoding === 'base64' ? 'base64' : 'utf8');
        },
      },
    );
    expect(fs.readFileSync(sides.oldFile, 'utf8')).toBe('');
    expect(fs.readFileSync(sides.newFile, 'utf8')).toBe('new\n');
    expect(cleanupDiffTemp(tmpRoot, 0, Date.now() + 1000)).toBeGreaterThanOrEqual(2);
    expect(fs.readdirSync(path.join(tmpRoot, 'githappens'))).toEqual([]);
  });

  it('refuses to launch when no diff tool is configured', async () => {
    const r = await repos.make();
    const { svc } = makeService({ 'tools.diffTool': 'none' }, { repos: reposFor(r) });
    await expect(
      svc.openDiff({ repoId: 'r', path: 'README.md', oldRev: 'HEAD', newRev: 'WORKTREE' }),
    ).rejects.toThrow(/Diff tool not found — configure in Preferences/);
  });

  // ---- external merge tool, strategy B with a real fake tool script ----

  async function conflicted() {
    const r = await repos.make({ 'c.txt': 'base\n' });
    r.git('checkout', '-q', '-b', 'feature');
    r.write('c.txt', 'feature\n');
    r.git('commit', '-qam', 'feature');
    r.git('checkout', '-q', 'main');
    r.write('c.txt', 'main\n');
    r.git('commit', '-qam', 'main');
    try {
      r.git('merge', 'feature');
    } catch {
      /* conflict expected */
    }
    expect(r.git('diff', '--name-only', '--diff-filter=U').trim()).toBe('c.txt');
    return r;
  }

  const script = (name: string, body: string): string => {
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-mt-')), name);
    fs.writeFileSync(p, body);
    return p;
  };
  const resolver = script(
    'resolve.cjs',
    `const fs = require('fs'); const [b, l, r, m] = process.argv.slice(2);
fs.writeFileSync(m, 'merged:' + fs.readFileSync(l, 'utf8').trim() + '+' + fs.readFileSync(r, 'utf8').trim() + '\\n');
process.exit(Number(process.env.GH_EXIT || 0));`,
  );
  const failing = script('fail.cjs', 'process.exit(2);');
  const tpl = (s: string): string => `"${process.execPath}" "${s}" $BASE $LOCAL $REMOTE $MERGED`;

  it('exit 0 → marks the file resolved through the op queue', async () => {
    const r = await conflicted();
    const ops: GitOperation[] = [];
    const { svc } = makeService(
      {
        'tools.mergeTool': 'custom',
        'tools.customMergeCmd': tpl(resolver),
        'tools.mergeToolTrustExitCode': true,
      },
      { repos: reposFor(r, ops) },
    );
    const res = await svc.mergeTool({ repoId: 'r', path: 'c.txt' });
    expect(res).toMatchObject({
      strategy: 'tool',
      exitCode: 0,
      changed: true,
      hasMarkers: false,
      resolved: true,
    });
    expect(ops).toEqual([{ type: 'conflict.markResolved', paths: ['c.txt'] }]);
    expect(fs.readFileSync(path.join(r.dir, 'c.txt'), 'utf8')).toBe('merged:main+feature\n');
    expect(r.git('diff', '--name-only', '--diff-filter=U').trim()).toBe('');
    expect(fs.existsSync(path.join(r.dir, 'c.txt.orig'))).toBe(false);
  });

  it('non-zero exit → leaves the file untouched and unmerged', async () => {
    const r = await conflicted();
    const before = fs.readFileSync(path.join(r.dir, 'c.txt'), 'utf8');
    const ops: GitOperation[] = [];
    const { svc } = makeService(
      {
        'tools.mergeTool': 'custom',
        'tools.customMergeCmd': tpl(failing),
        'tools.mergeToolTrustExitCode': true,
      },
      { repos: reposFor(r, ops) },
    );
    const res = await svc.mergeTool({ repoId: 'r', path: 'c.txt' });
    expect(res).toMatchObject({ exitCode: 2, changed: false, hasMarkers: true, resolved: false });
    expect(ops).toEqual([]);
    expect(fs.readFileSync(path.join(r.dir, 'c.txt'), 'utf8')).toBe(before);
    expect(r.git('diff', '--name-only', '--diff-filter=U').trim()).toBe('c.txt');
  });

  it('without trust-exit-code a changed, marker-free result still resolves; an unchanged one does not', async () => {
    const r = await conflicted();
    const ops: GitOperation[] = [];
    const a = makeService(
      {
        'tools.mergeTool': 'custom',
        'tools.customMergeCmd': tpl(resolver),
        'tools.mergeToolTrustExitCode': false,
      },
      { repos: reposFor(r, ops) },
    );
    expect((await a.svc.mergeTool({ repoId: 'r', path: 'c.txt' })).resolved).toBe(true);

    const r2 = await conflicted();
    const ops2: GitOperation[] = [];
    const noop = script('noop.cjs', 'process.exit(0);');
    const b = makeService(
      {
        'tools.mergeTool': 'custom',
        'tools.customMergeCmd': tpl(noop),
        'tools.mergeToolTrustExitCode': false,
      },
      { repos: reposFor(r2, ops2) },
    );
    expect(await b.svc.mergeTool({ repoId: 'r', path: 'c.txt' })).toMatchObject({
      exitCode: 0,
      changed: false,
      resolved: false,
    });
    expect(ops2).toEqual([]);
    // …while trusting the exit code marks even an unchanged file resolved
    const c = makeService(
      {
        'tools.mergeTool': 'custom',
        'tools.customMergeCmd': tpl(noop),
        'tools.mergeToolTrustExitCode': true,
      },
      { repos: reposFor(r2, ops2) },
    );
    expect((await c.svc.mergeTool({ repoId: 'r', path: 'c.txt' })).resolved).toBe(true);
  });

  it('keep-backup writes <file>.orig with the conflicted contents', async () => {
    const r = await conflicted();
    const before = fs.readFileSync(path.join(r.dir, 'c.txt'), 'utf8');
    const { svc } = makeService(
      {
        'tools.mergeTool': 'custom',
        'tools.customMergeCmd': tpl(resolver),
        'tools.mergeToolTrustExitCode': true,
        'tools.mergeToolKeepBackup': true,
      },
      { repos: reposFor(r) },
    );
    const res = await svc.mergeTool({ repoId: 'r', path: 'c.txt' });
    expect(res.backupPath).toBe(path.join(r.dir, 'c.txt.orig'));
    expect(fs.readFileSync(res.backupPath!, 'utf8')).toBe(before);
  });

  it('cancelling the wait resolves without marking anything', async () => {
    const r = await conflicted();
    const ops: GitOperation[] = [];
    const slow = script('slow.cjs', 'setTimeout(() => process.exit(0), 20000);');
    const { svc } = makeService(
      {
        'tools.mergeTool': 'custom',
        'tools.customMergeCmd': tpl(slow),
        'tools.mergeToolTrustExitCode': true,
      },
      { repos: reposFor(r, ops) },
    );
    const p = svc.mergeTool({ repoId: 'r', path: 'c.txt', waitId: 'w1' });
    await new Promise((res) => setTimeout(res, 500));
    svc.cancelMergeTool('w1');
    expect(await p).toMatchObject({ cancelled: true, resolved: false, exitCode: null });
    expect(ops).toEqual([]);
  });

  it('falls back to git mergetool (strategy A) when a preset tool is not installed', async () => {
    const r = await conflicted();
    const ops: GitOperation[] = [];
    const empty = fakeEnv(process.platform, [], [], { PATH: '' });
    const { svc } = makeService(
      {
        'tools.mergeTool': 'kdiff3',
        'tools.mergeToolTrustExitCode': true,
        'tools.mergeToolKeepBackup': false,
      },
      {
        env: { ...empty, isDir: () => true },
        repos: {
          get: () => r.svc,
          runOp: async (_id, op) => {
            ops.push(op);
            return { opId: 'op', data: { exitCode: 0, resolved: true } };
          },
        },
      },
    );
    const res = await svc.mergeTool({ repoId: 'r', path: 'c.txt' });
    expect(res).toMatchObject({ strategy: 'git', resolved: true, tool: 'KDiff3' });
    expect(ops).toEqual([
      { type: 'conflict.mergetool', path: 'c.txt', keepBackup: false, tool: 'kdiff3', trustExitCode: true },
    ]);
  });
});

describe('tools IPC', () => {
  it('has a handler for every tools channel', () => {
    const h = createToolsHandlers({} as never);
    expect(Object.keys(h).sort()).toEqual([...TOOLS_INVOKE_CHANNELS].sort());
  });
});
