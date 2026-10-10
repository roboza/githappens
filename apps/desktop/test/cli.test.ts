import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { findOnPath } from '@githappens/git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CliInstaller,
  parseRegQuery,
  posixLauncher,
  windowsLauncher,
  withPathEntry,
} from '../src/main/cli/install';
import { parseOpenPathArgs } from '../src/main/services/cli-args';

let dir: string;
beforeEach(() => {
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-cli-')));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('launcher scripts', () => {
  it('windows .cmd detaches with start and forwards all args', () => {
    const s = windowsLauncher('C:\\Program Files\\GitHappens\\GitHappens.exe');
    expect(s).toContain('start "" "C:\\Program Files\\GitHappens\\GitHappens.exe" %*');
    expect(s.split('\r\n')[0]).toBe('@echo off');
  });

  it('posix script quotes the executable safely', () => {
    const s = posixLauncher("/Apps/It's GitHappens/bin", ['/dev app']);
    expect(s).toContain(`'/Apps/It'\\''s GitHappens/bin' '/dev app'`);
    expect(s.startsWith('#!/bin/sh\n')).toBe(true);
  });

  const sh = process.platform === 'win32' ? null : findOnPath('sh');
  it.skipIf(!sh)('posix script makes . / relative / -p / --path= absolute and forwards flags', () => {
    const out = path.join(dir, 'args.txt');
    const fake = path.join(dir, 'fake-app');
    fs.writeFileSync(fake, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > '${out}'\n`, {
      mode: 0o755,
    });
    const script = path.join(dir, 'githappens');
    fs.writeFileSync(script, posixLauncher(fake), { mode: 0o755 });
    const cwd = path.join(dir, 'work');
    fs.mkdirSync(cwd);
    execFileSync(sh!, [script, '.', 'rel', '-p', 'other', '--path=x', '--verbose', '/abs'], {
      cwd,
      env: { ...process.env, GITHAPPENS_CLI_FOREGROUND: '1' },
    });
    const args = fs.readFileSync(out, 'utf8').trim().split('\n');
    expect(args).toEqual([
      `${cwd}/.`,
      `${cwd}/rel`,
      '-p',
      `${cwd}/other`,
      `--path=${cwd}/x`,
      '--verbose',
      '/abs',
    ]);
    // …which the app's argv parser (packaged) turns into the repos to open
    expect(parseOpenPathArgs(['exe', ...args], true, '/elsewhere')).toEqual([
      path.resolve(cwd),
      path.resolve(cwd, 'rel'),
      path.resolve(cwd, 'other'),
      path.resolve(cwd, 'x'),
      path.resolve('/abs'),
    ]);
  });

  it('forwarded Windows args resolve against the caller cwd', () => {
    expect(parseOpenPathArgs(['K.exe', '.', '-p', 'sub'], true, 'C:\\work')).toEqual([
      path.resolve('C:\\work', '.'),
      path.resolve('C:\\work', 'sub'),
    ]);
  });
});

describe('PATH helpers', () => {
  it('parses reg query output and appends once', () => {
    const out =
      '\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    %USERPROFILE%\\bin;C:\\Tools\r\n\r\n';
    expect(parseRegQuery(out)).toEqual({ type: 'REG_EXPAND_SZ', value: '%USERPROFILE%\\bin;C:\\Tools' });
    expect(parseRegQuery('ERROR: not found')).toBeNull();
    expect(withPathEntry('C:\\Tools', 'C:\\K\\bin')).toEqual({
      value: 'C:\\Tools;C:\\K\\bin',
      changed: true,
    });
    expect(withPathEntry('C:\\Tools;c:\\k\\bin\\', 'C:\\K\\bin').changed).toBe(false);
    expect(withPathEntry('', 'C:\\K\\bin').value).toBe('C:\\K\\bin');
  });
});

describe('CliInstaller', () => {
  it('windows: writes the shim and adds the bin dir to the user PATH via reg.exe argv', async () => {
    const calls: string[][] = [];
    let current = 'C:\\Tools';
    const inst = new CliInstaller({
      platform: 'win32',
      exe: 'C:\\K\\GitHappens.exe',
      userDataDir: dir,
      homeDir: dir,
      run: async (file, args) => {
        calls.push([file, ...args]);
        if (args[0] === 'query')
          return { code: 0, stdout: `    Path    REG_SZ    ${current}\r\n`, stderr: '' };
        current = args[args.indexOf('/d') + 1]!;
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    expect((await inst.status()).installed).toBe(false);
    const r = await inst.install();
    expect(r).toMatchObject({ ok: true, restartTerminals: true });
    expect(fs.readFileSync(path.join(dir, 'bin', 'githappens.cmd'), 'utf8')).toContain('GitHappens.exe');
    const add = calls.find((c) => c[1] === 'add')!;
    expect(add).toEqual([
      'reg.exe',
      'add',
      'HKCU\\Environment',
      '/v',
      'Path',
      '/t',
      'REG_SZ',
      '/d',
      `C:\\Tools;${path.join(dir, 'bin')}`,
      '/f',
    ]);
    expect((await inst.status()).installed).toBe(true);
    expect((await inst.install()).message).toMatch(/already/);
  });

  it('linux: symlinks ~/.local/bin/githappens to the shim', async () => {
    const inst = new CliInstaller({
      platform: 'linux',
      exe: '/opt/k/githappens',
      userDataDir: dir,
      homeDir: dir,
    });
    let r;
    try {
      r = await inst.install();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EPERM') return; // Windows without symlink privilege
      throw e;
    }
    if (!r.ok && r.manualCommand) {
      // Windows without symlink privilege reports EPERM as a manual command
      expect(r.manualCommand).toContain('ln -sf');
      return;
    }
    expect(r.ok).toBe(true);
    expect(fs.readlinkSync(path.join(dir, '.local', 'bin', 'githappens'))).toBe(inst.shimPath);
    expect((await inst.status()).installed).toBe(true);
  });

  it('macOS: permission denied → shows the sudo command', async () => {
    const inst = new CliInstaller({
      platform: 'darwin',
      exe: '/Applications/K.app/Contents/MacOS/K',
      userDataDir: dir,
      homeDir: dir,
    });
    const fakeTarget = path.join(dir, 'no-such-dir', 'githappens');
    Object.defineProperty(inst, 'target', { get: () => fakeTarget });
    const r = await inst.install();
    expect(r.ok).toBe(false);
    expect(r.manualCommand).toMatch(/^sudo mkdir -p \/usr\/local\/bin && sudo ln -sf /);
  });
});
