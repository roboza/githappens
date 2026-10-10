import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { findOnPath, GitLocator, parseEnvNul, pickShellEnv } from '../src';

function fakeBundle(platform: NodeJS.Platform): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-bundle-'));
  const exe = platform === 'win32' ? path.join(dir, 'cmd', 'git.exe') : path.join(dir, 'bin', 'git');
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, '');
  return dir;
}

const probeFor =
  (versions: Record<string, string>) =>
  async (gitPath: string, args: string[]): Promise<string> => {
    if (args[0] === 'lfs') return 'git-lfs/3.6.0 (GitHub; linux amd64; go 1.23)';
    const v = versions[gitPath];
    if (!v) throw new Error('ENOENT');
    return `git version ${v}\n`;
  };

describe('GitLocator', () => {
  it('uses bundled git by default', async () => {
    const dir = fakeBundle('linux');
    const exe = path.join(dir, 'bin', 'git');
    const loc = new GitLocator({
      bundledGitDir: dir,
      platform: 'linux',
      baseEnv: {},
      probe: probeFor({ [exe]: '2.47.1' }),
    });
    const r = await loc.resolve();
    expect(r.info.kind).toBe('bundled');
    expect(r.info.version).toBe('2.47.1');
    expect(r.info.lfsVersion).toBe('3.6.0');
    expect(r.context.bundled).toBe(true);
    expect(r.context.baseEnv.GIT_EXEC_PATH).toBe(path.join(dir, 'libexec', 'git-core'));
    expect(r.warnings).toEqual([]);
  });

  it('uses a custom system path when valid', async () => {
    const loc = new GitLocator({ platform: 'linux', baseEnv: {}, probe: probeFor({ '/opt/git': '2.40.0' }) });
    const r = await loc.resolve('/opt/git');
    expect(r.info.kind).toBe('system');
    expect(r.info.path).toBe('/opt/git');
  });

  it('rejects system git older than 2.36 and falls back to bundled with a warning', async () => {
    const dir = fakeBundle('linux');
    const exe = path.join(dir, 'bin', 'git');
    const loc = new GitLocator({
      bundledGitDir: dir,
      platform: 'linux',
      baseEnv: {},
      probe: probeFor({ [exe]: '2.47.1', '/old/git': '2.30.0' }),
    });
    const r = await loc.resolve('/old/git');
    expect(r.info.kind).toBe('bundled');
    expect(r.warnings[0]).toMatch(/2\.30\.0 is older than the minimum supported 2\.36\.0/);
  });

  it('falls back to git on PATH when bundled is missing', async () => {
    const real = findOnPath('git');
    if (!real) return;
    const loc = new GitLocator({ bundledGitDir: path.join(os.tmpdir(), 'nope'), baseEnv: process.env });
    const r = await loc.resolve();
    expect(r.info.kind).toBe('system');
    expect(r.warnings[0]).toMatch(/Bundled Git is missing/);
  });

  it('throws GitNotFound when nothing works', async () => {
    const loc = new GitLocator({ platform: 'linux', baseEnv: { PATH: '' }, probe: probeFor({}) });
    await expect(loc.resolve()).rejects.toMatchObject({ code: 'GitNotFound' });
  });
});

/** Fallback paths for a machine without (usable) system git (spec 15 §3 "no prerequisites"). */
describe('GitLocator fallbacks', () => {
  // Host platform, so PATH lookups (delimiter, PATHEXT) behave as on this machine.
  const plat = process.platform;
  const exe = (dir: string): string =>
    plat === 'win32' ? path.join(dir, 'cmd', 'git.exe') : path.join(dir, 'bin', 'git');
  const bundleWith = (version: string) => {
    const dir = fakeBundle(plat);
    return { dir, probe: probeFor({ [exe(dir)]: version }) };
  };
  const fakeSystemGit = (): { sysDir: string; sysGit: string } => {
    const sysDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-sys-'));
    const sysGit = path.join(sysDir, plat === 'win32' ? 'git.exe' : 'git');
    fs.writeFileSync(sysGit, '', { mode: 0o755 });
    return { sysDir, sysGit };
  };

  it('system preference with no git on PATH → bundled with a warning', async () => {
    const { dir, probe } = bundleWith('2.47.1');
    const loc = new GitLocator({ bundledGitDir: dir, platform: plat, baseEnv: { PATH: '' }, probe });
    const r = await loc.resolve('system');
    expect(r.info.kind).toBe('bundled');
    expect(r.context.bundled).toBe(true);
    expect(r.warnings).toEqual(['System Git was not found on PATH. Using bundled Git instead.']);
  });

  it('invalid custom path → bundled with a warning', async () => {
    const { dir, probe } = bundleWith('2.47.1');
    const loc = new GitLocator({ bundledGitDir: dir, platform: plat, baseEnv: {}, probe });
    const r = await loc.resolve('/no/such/git');
    expect(r.info.kind).toBe('bundled');
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(
      /^Git at \/no\/such\/git could not be run \(ENOENT\)\. Using bundled Git instead\.$/,
    );
  });

  it('a custom path that is not git (real executable) → bundled with a warning', async () => {
    // process.execPath is a real program whose `--version` isn't git's; the bundled probe stays fake.
    const { dir, probe } = bundleWith('2.47.1');
    const real = (gitPath: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> =>
      gitPath === process.execPath
        ? new Promise((resolve, reject) =>
            execFile(gitPath, args, { env, windowsHide: true }, (err, out) =>
              err ? reject(err) : resolve(out),
            ),
          )
        : probe(gitPath, args);
    const loc = new GitLocator({ bundledGitDir: dir, platform: plat, baseEnv: process.env, probe: real });
    const r = await loc.resolve(process.execPath);
    expect(r.info.kind).toBe('bundled');
    expect(r.warnings[0]).toMatch(/could not be run \(Unrecognized git version output: v\d+/);
  });

  it('system git older than 2.36 on PATH → bundled with a warning', async () => {
    const { dir } = bundleWith('2.47.1');
    const { sysDir, sysGit } = fakeSystemGit();
    const loc = new GitLocator({
      bundledGitDir: dir,
      platform: plat,
      baseEnv: { PATH: sysDir },
      probe: probeFor({ [exe(dir)]: '2.47.1', [sysGit]: '2.35.9' }),
    });
    const r = await loc.resolve('system');
    expect(r.info.kind).toBe('bundled');
    expect(r.warnings[0]).toBe(
      'System Git 2.35.9 is older than the minimum supported 2.36.0. Using bundled Git instead.',
    );
  });

  it('accepts system git at exactly the 2.36 minimum', async () => {
    const loc = new GitLocator({ platform: 'linux', baseEnv: {}, probe: probeFor({ '/opt/git': '2.36.0' }) });
    const r = await loc.resolve('/opt/git');
    expect(r.info.kind).toBe('system');
    expect(r.info.features.worktreeListZ).toBe(true);
    expect(r.info.features.mergeTreeWriteTree).toBe(false);
  });

  it('bundled missing and system too old → GitNotFound listing both reasons', async () => {
    const { sysDir, sysGit } = fakeSystemGit();
    const loc = new GitLocator({
      bundledGitDir: path.join(os.tmpdir(), 'kl-no-bundle'),
      platform: plat,
      baseEnv: { PATH: sysDir },
      probe: probeFor({ [sysGit]: '2.30.0' }),
    });
    const err = await loc.resolve().catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'GitNotFound' });
    expect(String((err as Error).message)).toMatch(/Bundled Git is missing/);
    expect(String((err as Error).message)).toMatch(/2\.30\.0 is older than the minimum/);
  });
});

/** The same chain with real (shell-script) executables and the default `execFile` probe. */
describe.skipIf(process.platform === 'win32')('GitLocator with fake git executables', () => {
  const script = (file: string, version: string): string => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      [
        '#!/bin/sh',
        'case "$1" in',
        `  --version) echo "git version ${version}" ;;`,
        '  lfs) echo "git-lfs/3.6.0 (GitHub; linux amd64; go 1.23)" ;;',
        '  *) exit 1 ;;',
        'esac',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    return file;
  };
  const setup = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-fake-git-'));
    const bundle = path.join(root, 'bundle');
    const bundledExe = script(path.join(bundle, 'bin', 'git'), '2.47.1');
    const sysDir = path.join(root, 'sys');
    const oldGit = script(path.join(sysDir, 'git'), '2.30.0');
    return { root, bundle, bundledExe, sysDir, oldGit };
  };

  it('default: bundled, no warnings', async () => {
    const t = setup();
    const r = await new GitLocator({ bundledGitDir: t.bundle, baseEnv: { PATH: t.sysDir } }).resolve();
    expect(r.info).toMatchObject({
      kind: 'bundled',
      path: t.bundledExe,
      version: '2.47.1',
      lfsVersion: '3.6.0',
    });
    expect(r.warnings).toEqual([]);
  });

  it('system preference with only an old git on PATH → bundled with a warning', async () => {
    const t = setup();
    const r = await new GitLocator({ bundledGitDir: t.bundle, baseEnv: { PATH: t.sysDir } }).resolve(
      'system',
    );
    expect(r.info.kind).toBe('bundled');
    expect(r.warnings[0]).toMatch(/System Git 2\.30\.0 is older than the minimum supported 2\.36\.0/);
  });

  it('system preference with no git on PATH → bundled with a warning', async () => {
    const t = setup();
    const empty = path.join(t.root, 'empty');
    fs.mkdirSync(empty);
    const r = await new GitLocator({ bundledGitDir: t.bundle, baseEnv: { PATH: empty } }).resolve('system');
    expect(r.info.kind).toBe('bundled');
    expect(r.warnings).toEqual(['System Git was not found on PATH. Using bundled Git instead.']);
  });

  it('custom path that is not executable → bundled with a warning', async () => {
    const t = setup();
    const bogus = path.join(t.root, 'not-git');
    fs.writeFileSync(bogus, 'not a program', { mode: 0o644 });
    const r = await new GitLocator({ bundledGitDir: t.bundle, baseEnv: { PATH: '' } }).resolve(bogus);
    expect(r.info.kind).toBe('bundled');
    expect(r.warnings[0]).toMatch(
      new RegExp(`^Git at ${bogus.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} could not be run`),
    );
  });

  it('a newer system git is used when chosen explicitly', async () => {
    const t = setup();
    const newer = script(path.join(t.root, 'new', 'git'), '2.45.0');
    const r = await new GitLocator({ bundledGitDir: t.bundle, baseEnv: { PATH: '' } }).resolve(newer);
    expect(r.info).toMatchObject({ kind: 'system', path: newer, version: '2.45.0' });
    expect(r.context.bundled).toBe(false);
  });
});

describe('shell env', () => {
  it('parses NUL-separated env and keeps only relevant keys', () => {
    const parsed = parseEnvNul(
      'PATH=/usr/local/bin:/usr/bin\0SSH_AUTH_SOCK=/tmp/agent\0FOO=bar\0GIT_SSH=ssh\0EMPTY=\0',
    );
    expect(pickShellEnv(parsed)).toEqual({
      PATH: '/usr/local/bin:/usr/bin',
      SSH_AUTH_SOCK: '/tmp/agent',
      GIT_SSH: 'ssh',
    });
  });
});
