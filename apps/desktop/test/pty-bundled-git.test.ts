import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { withBundledGitOnPath } from '../src/main/services/pty-service';

const bundled = path.join('opt', 'kl', 'git');
const files = (...ps: string[]) => {
  const set = new Set(ps);
  return (p: string): boolean => set.has(p);
};

describe('withBundledGitOnPath', () => {
  it('appends the bundled git when PATH has none (posix)', () => {
    const exists = files(path.join(bundled, 'bin', 'git'));
    const env = withBundledGitOnPath({ PATH: '/usr/bin:/bin' }, bundled, 'linux', exists);
    expect(env.PATH).toBe(`/usr/bin:/bin:${path.join(bundled, 'bin')}`);
  });

  it('keeps PATH untouched when a git is already on it', () => {
    const sys = path.join('usr', 'local', 'bin');
    const exists = files(path.join(bundled, 'bin', 'git'), path.join(sys, 'git'));
    const env = { PATH: `${sys}:/bin` };
    expect(withBundledGitOnPath(env, bundled, 'linux', exists)).toBe(env);
  });

  it('uses the cmd shim and the existing Path key on Windows', () => {
    const exists = files(path.join(bundled, 'cmd', 'git.exe'));
    const env = withBundledGitOnPath({ Path: 'C:\\Windows;C:\\Tools' }, bundled, 'win32', exists);
    expect(env.Path).toBe(`C:\\Windows;C:\\Tools;${path.join(bundled, 'cmd')}`);
    expect(env.PATH).toBeUndefined();
  });

  it('does nothing without a usable bundled git', () => {
    const env = { PATH: '/usr/bin' };
    expect(withBundledGitOnPath(env, undefined, 'linux', files())).toBe(env);
    expect(withBundledGitOnPath(env, bundled, 'linux', files())).toBe(env);
  });
});
