import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  applyInvocationExtras,
  bundledGitEnv,
  bundledGitExecutable,
  globalArgs,
  invocationEnv,
} from '../src';

describe('invocationEnv', () => {
  const base = { PATH: '/usr/bin', LC_ALL: 'de_DE.UTF-8', GIT_OPTIONAL_LOCKS: '1' };

  it('applies the spec 02 policy', () => {
    const env = invocationEnv(base, { platform: 'linux' });
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.LC_ALL).toBeUndefined();
    expect(env.LC_MESSAGES).toBe('C');
    expect(env.LANG).toBe('en_US.UTF-8');
    expect(env.GIT_PAGER).toBe('cat');
    expect(env.GIT_MERGE_AUTOEDIT).toBe('no');
    expect(env.GIT_OPTIONAL_LOCKS).toBeUndefined();
    expect(env.GIT_ASKPASS).toBeUndefined();
  });

  it('sets GIT_OPTIONAL_LOCKS=0 for read-only runs', () => {
    expect(invocationEnv(base, { platform: 'linux', readOnly: true }).GIT_OPTIONAL_LOCKS).toBe('0');
  });

  it('wires askpass with a DISPLAY placeholder on posix', () => {
    const env = invocationEnv(base, { platform: 'darwin', askpassPath: '/a/askpass.sh' });
    expect(env.GIT_ASKPASS).toBe('/a/askpass.sh');
    expect(env.SSH_ASKPASS_REQUIRE).toBe('force');
    expect(env.DISPLAY).toBe(':0');
    expect(invocationEnv(base, { platform: 'win32', askpassPath: 'x' }).DISPLAY).toBeUndefined();
  });

  it('does not mutate the base env', () => {
    invocationEnv(base, { platform: 'linux' });
    expect(base.LC_ALL).toBe('de_DE.UTF-8');
  });
});

describe('bundled git layout', () => {
  it('resolves executables per platform', () => {
    expect(bundledGitExecutable({ dir: '/g', platform: 'linux', arch: 'x64' })).toBe(
      path.join('/g', 'bin', 'git'),
    );
    expect(bundledGitExecutable({ dir: 'C:\\g', platform: 'win32', arch: 'x64' })).toBe(
      path.join('C:\\g', 'cmd', 'git.exe'),
    );
  });

  it('prepends mingw + usr/bin to Path on Windows, preserving the key casing', () => {
    const env = bundledGitEnv({ dir: 'C:\\g', platform: 'win32', arch: 'arm64' }, { Path: 'C:\\Windows' });
    expect(env.GIT_EXEC_PATH).toBe(path.join('C:\\g', 'clangarm64', 'libexec', 'git-core'));
    expect(env.Path?.split(';')[0]).toBe(path.join('C:\\g', 'clangarm64', 'bin'));
    expect(env.Path?.endsWith('C:\\Windows')).toBe(true);
  });

  it('sets system config & CA bundle on linux', () => {
    const env = bundledGitEnv({ dir: '/g', platform: 'linux', arch: 'x64' }, {});
    expect(env.GIT_CONFIG_SYSTEM).toBe(path.join('/g', 'etc', 'gitconfig'));
    expect(env.GIT_SSL_CAINFO).toBe(path.join('/g', 'ssl', 'cacert.pem'));
    expect(env.PREFIX).toBe('/g');
  });
});

describe('globalArgs', () => {
  it('neutralizes output-shaping config', () => {
    const args = globalArgs({ platform: 'linux', bundled: true });
    expect(args[0]).toBe('--no-pager');
    expect(args).toContain('core.quotepath=false');
    expect(args).not.toContain('core.longpaths=true');
    expect(globalArgs({ platform: 'win32', bundled: true })).toContain('core.longpaths=true');
  });
});

describe('applyInvocationExtras', () => {
  it('returns the base env untouched without extras', () => {
    const base = { A: '1' };
    expect(applyInvocationExtras(base, null)).toBe(base);
  });

  it('sets and removes env vars case-insensitively', () => {
    const env = applyInvocationExtras(
      { https_proxy: 'http://old:1', HTTP_PROXY: 'http://old:2', KEEP: 'x' },
      { env: { HTTPS_PROXY: 'http://new:3', HTTP_PROXY: null, GIT_SSH_COMMAND: "ssh -i 'k'" } },
    );
    expect(env.HTTPS_PROXY).toBe('http://new:3');
    expect(env.https_proxy).toBeUndefined();
    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.GIT_SSH_COMMAND).toBe("ssh -i 'k'");
    expect(env.KEEP).toBe('x');
  });

  it('appends config through GIT_CONFIG_COUNT after existing entries', () => {
    const env = applyInvocationExtras(
      { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Me' },
      {
        config: [
          ['http.proxy', ''],
          ['http.sslBackend', 'schannel'],
        ],
      },
    );
    expect(env.GIT_CONFIG_COUNT).toBe('3');
    expect(env.GIT_CONFIG_KEY_0).toBe('user.name');
    expect([env.GIT_CONFIG_KEY_1, env.GIT_CONFIG_VALUE_1]).toEqual(['http.proxy', '']);
    expect([env.GIT_CONFIG_KEY_2, env.GIT_CONFIG_VALUE_2]).toEqual(['http.sslBackend', 'schannel']);
  });
});
