import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { findOnPath } from '@githappens/git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PACKAGED_SHIMS, packagedPosixLauncher, packagedWindowsLauncher } from '../src/main/cli/install';
import { parseOpenPathArgs } from '../src/main/services/cli-args';

/**
 * The `githappens` command as shipped by the installers (spec 15 §6.4):
 *  - build/bin/githappens(.cmd) → resources/bin (electron-builder extraResources), generated from
 *    src/main/cli/install.ts — `GH_WRITE_SHIMS=1 pnpm vitest run test/cli-shims.test.ts` rewrites them;
 *  - build/installer.nsh adds resources\bin to the user PATH (NSIS);
 *  - build/linux/after-install.sh / after-remove.sh link /usr/bin/githappens (deb/rpm).
 */

// js-yaml comes with electron-updater (not a direct dependency under pnpm).
const yaml = createRequire(createRequire(import.meta.url).resolve('electron-updater'))('js-yaml') as {
  load(text: string): unknown;
};
const parseYaml = (text: string): unknown => yaml.load(text);

const appDir = path.resolve(__dirname, '..');
const buildDir = path.join(appDir, 'build');

let dir: string;
beforeEach(() => {
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-shims-')));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('packaged CLI shims', () => {
  it('build/bin files match their generators', () => {
    for (const [name, gen] of Object.entries(PACKAGED_SHIMS)) {
      const file = path.join(buildDir, 'bin', name);
      if (process.env.GH_WRITE_SHIMS === '1') fs.writeFileSync(file, gen());
      expect(fs.readFileSync(file, 'utf8'), `${file} is stale — rerun with GH_WRITE_SHIMS=1`).toBe(gen());
    }
  });

  it('windows shim forwards every argument to the installed exe, detached', () => {
    const s = packagedWindowsLauncher();
    expect(s.split('\r\n')[0]).toBe('@echo off');
    expect(s).not.toMatch(/[^\r]\n/); // CRLF only
    expect(s).toContain('start "" "%~dp0..\\..\\GitHappens.exe" %*');
  });

  it('posix shim locates the binary relative to itself', () => {
    const s = packagedPosixLauncher();
    expect(s.startsWith('#!/bin/sh\n')).toBe(true);
    expect(s).toContain('readlink -f "$0"');
    expect(s).toContain('exe="$(cd "$(dirname "$self")/../.." && pwd)/githappens"');
    expect(s).toContain('nohup "$exe" "$@"');
  });

  const sh = process.platform === 'win32' ? null : findOnPath('sh');
  it.skipIf(!sh)('posix shim (via a /usr/bin-style symlink) opens absolute paths in the app', () => {
    // Layout of the deb/rpm install: /opt/GitHappens/{githappens, resources/bin/githappens}.
    const opt = path.join(dir, 'opt', 'GitHappens');
    const out = path.join(dir, 'args.txt');
    fs.mkdirSync(path.join(opt, 'resources', 'bin'), { recursive: true });
    fs.writeFileSync(
      path.join(opt, 'githappens'),
      `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > '${out}'\n`,
      { mode: 0o755 },
    );
    const shim = path.join(opt, 'resources', 'bin', 'githappens');
    fs.copyFileSync(path.join(buildDir, 'bin', 'githappens'), shim);
    fs.chmodSync(shim, 0o755);
    const usrBin = path.join(dir, 'usr', 'bin');
    fs.mkdirSync(usrBin, { recursive: true });
    fs.symlinkSync(shim, path.join(usrBin, 'githappens'));
    const cwd = path.join(dir, 'work');
    fs.mkdirSync(cwd);
    execFileSync(path.join(usrBin, 'githappens'), ['.', '-p', 'sub', '--path=x'], {
      cwd,
      env: { ...process.env, GITHAPPENS_CLI_FOREGROUND: '1' },
    });
    const args = fs.readFileSync(out, 'utf8').trim().split('\n');
    expect(args).toEqual([`${cwd}/.`, '-p', `${cwd}/sub`, `--path=${cwd}/x`]);
    expect(parseOpenPathArgs(['githappens', ...args], true, '/')).toEqual([
      path.resolve(cwd),
      path.resolve(cwd, 'sub'),
      path.resolve(cwd, 'x'),
    ]);
  });
});

describe('electron-builder wiring', () => {
  const config = parseYaml(fs.readFileSync(path.join(appDir, 'electron-builder.yml'), 'utf8')) as {
    win: { extraResources?: { from: string; to: string }[]; target: { target: string; arch: string[] }[] };
    linux: { extraResources?: { from: string; to: string }[]; target: { target: string; arch: string[] }[] };
    nsis: { include?: string; perMachine?: boolean };
    deb: { afterInstall?: string; afterRemove?: string };
    rpm: { afterInstall?: string; afterRemove?: string };
    mac: { target: { target: string; arch: string[] }[] };
  };

  it('ships the shims per platform and hooks the installers', () => {
    expect(config.win.extraResources).toContainEqual({
      from: 'build/bin/githappens.cmd',
      to: 'bin/githappens.cmd',
    });
    expect(config.linux.extraResources).toContainEqual({
      from: 'build/bin/githappens',
      to: 'bin/githappens',
    });
    expect(config.nsis.include).toBe('build/installer.nsh');
    expect(config.nsis.perMachine).toBe(false); // the PATH edit is per-user (HKCU)
    for (const t of [config.deb, config.rpm]) {
      expect(t.afterInstall).toBe('build/linux/after-install.sh');
      expect(t.afterRemove).toBe('build/linux/after-remove.sh');
    }
    for (const f of ['installer.nsh', 'linux/after-install.sh', 'linux/after-remove.sh', 'bin/githappens']) {
      expect(fs.existsSync(path.join(buildDir, f)), f).toBe(true);
    }
  });

  it('targets x64 + arm64 on every OS (spec 15 §6.4)', () => {
    for (const t of [...config.win.target, ...config.mac.target, ...config.linux.target]) {
      expect(t.arch, t.target).toEqual(['x64', 'arm64']);
    }
    expect(config.linux.target.map((t) => t.target)).toEqual(['AppImage', 'deb', 'rpm', 'tar.gz']);
  });

  it('linux scripts only use the macros electron-builder defines', () => {
    // FpmTarget replaces every dollar-brace macro and throws on unknown ones at package time.
    const allowed = new Set(['executable', 'sanitizedProductName', 'productFilename']);
    for (const f of ['after-install.sh', 'after-remove.sh']) {
      const text = fs.readFileSync(path.join(buildDir, 'linux', f), 'utf8');
      expect(text.startsWith('#!/bin/bash\n'), f).toBe(true);
      expect(text, f).not.toContain('\r');
      const macros = [...text.matchAll(/\$\{([a-zA-Z]+)\}/g)].map((m) => m[1]!);
      expect(
        macros.filter((m) => !allowed.has(m)),
        f,
      ).toEqual([]);
      // Anything else that looks like ${…} (e.g. ${a#b}) would break the substitution.
      expect(text.match(/\$\{(?![a-zA-Z]+\})/g), f).toBeNull();
    }
    const install = fs.readFileSync(path.join(buildDir, 'linux', 'after-install.sh'), 'utf8');
    expect(install).toContain(`CLI='/opt/\${sanitizedProductName}/resources/bin/\${executable}'`);
    expect(install).toContain('update-alternatives --install "$LINK"');
    const remove = fs.readFileSync(path.join(buildDir, 'linux', 'after-remove.sh'), 'utf8');
    expect(remove).toMatch(/case "\$1" in\n\s+upgrade \| 1 \| 2 \| 3\) exit 0 ;;/);
  });

  const bash = process.platform === 'win32' ? null : findOnPath('bash');
  it.skipIf(!bash)('linux scripts parse (bash -n) after macro substitution', () => {
    for (const f of ['after-install.sh', 'after-remove.sh']) {
      const text = fs
        .readFileSync(path.join(buildDir, 'linux', f), 'utf8')
        .replace(/\$\{executable\}/g, 'githappens')
        .replace(/\$\{sanitizedProductName\}/g, 'GitHappens');
      const out = path.join(dir, f);
      fs.writeFileSync(out, text);
      execFileSync(bash!, ['-n', out]);
    }
  });
});

/**
 * Compiles build/installer.nsh with electron-builder's cached makensis (-WX, like electron-builder) and
 * runs the PATH logic against a scratch registry key (never HKCU\Environment). Windows only, and only
 * when makensis is available (GH_MAKENSIS or a previous electron-builder run's cache).
 */
function findMakensis(): string | null {
  if (process.env.GH_MAKENSIS) return process.env.GH_MAKENSIS;
  const cache = path.join(process.env.LOCALAPPDATA ?? '', 'electron-builder', 'Cache');
  try {
    for (const v of fs.readdirSync(cache).filter((d) => d.startsWith('nsis-3'))) {
      for (const sub of fs.readdirSync(path.join(cache, v))) {
        const exe = path.join(cache, v, sub, 'makensis.exe');
        if (fs.existsSync(exe)) return exe;
      }
    }
  } catch {
    /* no cache */
  }
  return null;
}

const makensis = process.platform === 'win32' ? findMakensis() : null;
describe.skipIf(!makensis)('NSIS user-PATH hook (scratch registry key)', () => {
  const key = `Software\\GitHappensNsisTest-${process.pid}`;
  const regKey = `HKCU\\${key}`;
  const cliDir = 'C:\\GitHappens Test\\resources\\bin';
  let harness: string;

  const reg = (...args: string[]): string =>
    execFileSync('reg.exe', args, { encoding: 'utf8', windowsHide: true });
  const readPath = (): string | null => {
    try {
      const m = /Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/m.exec(reg('query', regKey, '/v', 'Path'));
      return m ? m[1]!.trim() : '';
    } catch {
      return null;
    }
  };
  const run = (mode: 'add' | 'remove', initial: string | null): string | null => {
    try {
      reg('delete', regKey, '/f');
    } catch {
      /* absent */
    }
    reg('add', regKey, '/v', 'Mode', '/t', 'REG_SZ', '/d', mode, '/f');
    if (initial !== null) reg('add', regKey, '/v', 'Path', '/t', 'REG_EXPAND_SZ', '/d', initial, '/f');
    execFileSync(harness, ['/S'], { windowsHide: true });
    return readPath();
  };

  beforeEach(() => {
    const nsi = path.join(dir, 'harness.nsi');
    harness = path.join(dir, 'harness.exe');
    fs.writeFileSync(
      nsi,
      [
        'Unicode true',
        `!define GH_ENV_KEY "${key}"`,
        `!define GH_CLI_DIR "${cliDir}"`,
        '!define GH_NO_BROADCAST',
        `!addincludedir "${buildDir}"`,
        '!include "installer.nsh"',
        `OutFile "${harness}"`,
        'RequestExecutionLevel user',
        'SilentInstall silent',
        'Function KLTestRemove',
        '  !insertmacro GH_UPDATE_USER_PATH 0',
        'FunctionEnd',
        'Section',
        `  ReadRegStr $0 HKCU "${key}" "Mode"`,
        '  StrCmp $0 "add" 0 +3',
        '  Call KLAddCliToUserPath',
        '  Goto +2',
        '  Call KLTestRemove',
        'SectionEnd',
        '',
      ].join('\r\n'),
    );
    execFileSync(makensis!, ['-WX', '-V2', nsi], { windowsHide: true });
  });

  afterEach(() => {
    try {
      reg('delete', regKey, '/f');
    } catch {
      /* already gone */
    }
  });

  it('appends once, keeps %VARS%, and removes case-insensitively', () => {
    expect(run('add', 'C:\\A;%USERPROFILE%\\bin')).toBe(`C:\\A;%USERPROFILE%\\bin;${cliDir}`);
    expect(run('add', `C:\\A;${cliDir.toLowerCase()}\\`)).toBe(`C:\\A;${cliDir.toLowerCase()}\\`);
    expect(run('add', null)).toBe(cliDir);
    expect(run('remove', `C:\\a;${cliDir.toUpperCase()}\\;C:\\B;${cliDir}`)).toBe('C:\\a;C:\\B');
    expect(run('remove', cliDir)).toBe(null);
    expect(run('remove', 'C:\\A;C:\\B')).toBe('C:\\A;C:\\B');
  });

  it('leaves an over-long PATH untouched instead of truncating it', () => {
    const long = Array.from({ length: 400 }, (_, i) => `C:\\very\\long\\path\\segment${i}`).join(';');
    expect(run('add', long)).toBe(long);
  });
});
