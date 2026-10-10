import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createAboutHandlers, inspectBundledGit } from '../src/main/ipc/about-handlers';
import { formatDiagnostics } from '../src/renderer/src/components/diagnostics';
import { ABOUT_INVOKE_CHANNELS } from '../src/shared/ipc/about-contract';

function fakeBundle(): { dir: string; exe: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-about-'));
  const exe = path.join(dir, 'bin', 'git');
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, '');
  return { dir, exe };
}

describe('About: bundled git', () => {
  it('reports the bundled git version and path', async () => {
    const { dir, exe } = fakeBundle();
    const probe = vi.fn(async (_p: string, args: string[]) =>
      args[0] === '--version' ? 'git version 2.53.0\n' : 'git-lfs/3.7.0 (GitHub; linux amd64; go 1.24)',
    );
    const info = await inspectBundledGit({
      bundledGitDir: dir,
      platform: 'linux',
      arch: 'x64',
      baseEnv: {},
      probe,
    });
    expect(info).toEqual({ available: true, version: '2.53.0', path: exe });
    // Probed with the bundled environment (GIT_EXEC_PATH inside the bundle).
    expect(probe.mock.calls[0]![2].GIT_EXEC_PATH).toBe(path.join(dir, 'libexec', 'git-core'));
  });

  it('explains a missing or broken bundle', async () => {
    expect(await inspectBundledGit({ bundledGitDir: undefined })).toMatchObject({ available: false });
    const missing = await inspectBundledGit({
      bundledGitDir: path.join(os.tmpdir(), 'kl-nope'),
      platform: 'linux',
    });
    expect(missing.error).toMatch(/Bundled Git is missing/);
    const { dir } = fakeBundle();
    const broken = await inspectBundledGit({
      bundledGitDir: dir,
      platform: 'linux',
      baseEnv: {},
      probe: async () => {
        throw new Error('spawn EACCES');
      },
    });
    expect(broken).toMatchObject({ available: false, error: 'spawn EACCES' });
  });

  it('handler probes once and caches', async () => {
    const { dir } = fakeBundle();
    const probe = vi.fn(async () => 'git version 2.53.0\n');
    const h = createAboutHandlers({ bundledGitDir: dir, platform: 'linux', baseEnv: {}, probe });
    expect(Object.keys(h).sort()).toEqual([...ABOUT_INVOKE_CHANNELS].sort());
    const a = await h['app:bundledGit']({}, { senderId: 1 });
    const b = await h['app:bundledGit']({}, { senderId: 1 });
    expect(a).toEqual(b);
    expect(probe.mock.calls.filter((c) => c[1][0] === '--version')).toHaveLength(1);
  });
});

describe('About: copy diagnostics', () => {
  const versions = {
    app: '0.1.0',
    electron: '44.7.0',
    chrome: '140.0.1',
    node: '22.20.0',
    git: '2.47.1',
    gitPath: '/usr/bin/git',
  };

  it('lists app, runtime, active and bundled git, without personal data', () => {
    const text = formatDiagnostics({
      versions,
      engine: {
        kind: 'system',
        path: '/usr/bin/git',
        version: '2.47.1',
        versionTuple: [2, 47, 1],
        features: {
          worktreeListZ: true,
          statusShowStash: true,
          pathspecFromFile: true,
          forceIfIncludes: true,
          mergeTreeWriteTree: true,
          builtinFsmonitor: false,
          configShowScope: true,
        },
      },
      bundled: { available: true, version: '2.53.0', path: '/opt/GitHappens/resources/git/bin/git' },
      secrets: { available: true, backend: 'gnome_libsecret' },
      platform: 'linux',
    });
    expect(text).toBe(
      [
        'GitHappens 0.1.0',
        'Electron 44.7.0 · Chromium 140.0.1 · Node 22.20.0',
        'Platform: linux',
        'Git (active): 2.47.1 (system) /usr/bin/git',
        'Git LFS: not installed',
        'Git features missing: builtinFsmonitor',
        'Git (bundled): 2.53.0 /opt/GitHappens/resources/git/bin/git',
        'Secure storage: available (gnome_libsecret)',
        '',
      ].join('\n'),
    );
  });

  it('degrades when engine / bundled info is unavailable', () => {
    const text = formatDiagnostics({
      versions,
      bundled: { available: false, error: 'Bundled Git is missing (x).' },
      platform: 'win32',
    });
    expect(text).toContain('Git (active): 2.47.1 /usr/bin/git');
    expect(text).toContain('Git (bundled): unavailable — Bundled Git is missing (x).');
    expect(formatDiagnostics({ platform: 'darwin' })).toContain('Git (active): not found');
  });
});
