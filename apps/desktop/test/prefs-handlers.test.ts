import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPrefsHandlers, type PrefsHandlerDeps } from '../src/main/ipc/prefs-handlers';
import { createGitConfigWriter } from '../src/main/settings/git-config-writer';
import { SettingsStore } from '../src/main/settings/settings-store';
import { ThemeService } from '../src/main/settings/theme-service';
import { PREFS_EVENT_CHANNELS, PREFS_INVOKE_CHANNELS } from '../src/shared/ipc/prefs-contract';
import { expandToolCommand, splitArgs, TOOL_PRESETS } from '../src/shared/settings/external-tools';
import { signingGitConfig } from '../src/shared/settings/git-config';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-prefs-ipc-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const ctx = { senderId: 1 };

function setup(over: Partial<PrefsHandlerDeps> = {}) {
  const settings = new SettingsStore({ dir });
  settings.load();
  const deps = {
    settings,
    userDataDir: dir,
    secrets: { deleteByPrefix: vi.fn(() => 0) },
    broadcast: vi.fn(),
    setGlobalIdentity: vi.fn(),
    writeGitConfig: vi.fn(),
    openPath: vi.fn(),
    pickPath: vi.fn(async () => '/picked'),
    themes: new ThemeService({ dir: path.join(dir, 'themes') }),
    ...over,
  };
  return { settings, deps, h: createPrefsHandlers(deps) };
}

describe('prefs IPC handlers', () => {
  it('implement every prefs channel', () => {
    const { h } = setup();
    expect(Object.keys(h).sort()).toEqual([...PREFS_INVOKE_CHANNELS].sort());
    expect(PREFS_EVENT_CHANNELS).toContain('profiles:switched');
  });

  it('profile lifecycle: create, update, switch, delete clears secrets and broadcasts', async () => {
    const { h, deps } = setup();
    const list = await h['profiles:list']({}, ctx);
    const first = list.activeId;
    const p = await h['profiles:create']({ name: 'Work', authorName: 'Ada', authorEmail: 'a@w.io' }, ctx);
    expect(deps.broadcast).toHaveBeenCalledWith(
      'profiles:changed',
      expect.objectContaining({ activeId: first }),
    );
    await h['profiles:update']({ id: p.id, patch: { name: 'Job' } }, ctx);
    await h['keybindings:set']({ overrides: [{ command: 'tab.new', key: 'ctrl+n' }] }, ctx);
    await h['profiles:switch']({ id: p.id }, ctx);
    expect(deps.broadcast).toHaveBeenCalledWith(
      'profiles:switched',
      expect.objectContaining({ name: 'Job' }),
    );
    // keybindings are per profile
    expect(await h['keybindings:get']({}, ctx)).toEqual([]);
    expect(deps.broadcast).toHaveBeenCalledWith('keybindings:changed', []);
    await h['profiles:switch']({ id: first }, ctx);
    expect(await h['keybindings:get']({}, ctx)).toEqual([{ command: 'tab.new', key: 'ctrl+n' }]);
    await h['profiles:delete']({ id: p.id }, ctx);
    expect(deps.secrets.deleteByPrefix).toHaveBeenCalledWith(`${p.id}/`);
  });

  it('switch syncs the global identity through the injected callback', async () => {
    const { h, deps } = setup();
    const p = await h['profiles:create'](
      { name: 'Work', authorName: 'Ada', authorEmail: 'a@w.io', syncGitConfig: true },
      ctx,
    );
    await h['profiles:switch']({ id: p.id }, ctx);
    await vi.waitFor(() => expect(deps.setGlobalIdentity).toHaveBeenCalledWith('Ada', 'a@w.io'));
  });

  it('themes: list / get / create from current opens the new file', async () => {
    const { h, deps } = setup();
    const r = await h['themes:createFromCurrent']({ baseId: 'builtin:light' }, ctx);
    expect(deps.openPath).toHaveBeenCalledWith(r.file);
    const list = await h['themes:list']({}, ctx);
    expect(list.map((t) => t.id)).toContain(r.id);
    const t = await h['themes:get']({ id: r.id }, ctx);
    expect(t.scheme).toBe('light');
    await h['themes:openFolder']({}, ctx);
    expect(deps.openPath).toHaveBeenLastCalledWith(path.join(dir, 'themes'));
  });

  it('keybindings:set validates and broadcasts', async () => {
    const { h, deps } = setup();
    expect(() => h['keybindings:set']({ overrides: [{ command: '', key: 'x' }] }, ctx)).toThrow(/Invalid/);
    await h['keybindings:set']({ overrides: [{ command: 'tab.new', key: 'ctrl+n' }] }, ctx);
    expect(deps.broadcast).toHaveBeenCalledWith('keybindings:changed', [
      { command: 'tab.new', key: 'ctrl+n' },
    ]);
  });

  it('settings:openJson creates the file if needed and opens it', async () => {
    const { h, deps, settings } = setup();
    await h['settings:openJson']({}, ctx);
    const file = path.join(settings.profileDir(), 'settings.json');
    expect(fs.existsSync(file)).toBe(true);
    expect(deps.openPath).toHaveBeenCalledWith(file);
  });

  it('signing:apply writes git config for the chosen scope', async () => {
    const { h, deps, settings } = setup();
    settings.set('signing.format', 'ssh');
    settings.set('signing.signingKey', '~/.ssh/id_ed25519.pub');
    settings.set('signing.signCommits', true);
    const entries = await h['signing:apply']({}, ctx);
    expect(deps.writeGitConfig).toHaveBeenCalledWith(entries, 'global', undefined);
    expect(entries).toContainEqual({ key: 'gpg.format', value: 'ssh' });
    expect(entries).toContainEqual({ key: 'commit.gpgsign', value: 'true' });
    expect(entries).toContainEqual({ key: 'gpg.ssh.allowedSignersFile', value: null });
    settings.set('signing.writeScope', 'local');
    await expect(h['signing:apply']({}, ctx)).rejects.toThrow(/Open a repository/);
    await h['signing:apply']({ repoPath: '/repo' }, ctx);
    expect(deps.writeGitConfig).toHaveBeenLastCalledWith(expect.any(Array), 'local', '/repo');
    settings.set('signing.signingKey', '');
    await expect(h['signing:apply']({ repoPath: '/repo' }, ctx)).rejects.toThrow(/signing key/);
  });
});

describe('git config writer', () => {
  it('maps entries to git config set / unset and refuses unknown keys', async () => {
    const run = vi.fn(async () => ({}));
    const w = createGitConfigWriter(() => run, '/home/u');
    await w.writeGitConfig(
      [
        { key: 'commit.gpgsign', value: 'true' },
        { key: 'gpg.program', value: null },
      ],
      'global',
    );
    expect(run).toHaveBeenNthCalledWith(1, {
      cwd: '/home/u',
      args: ['config', '--global', '--replace-all', 'commit.gpgsign', 'true'],
      expectedExitCodes: [0],
    });
    expect(run).toHaveBeenNthCalledWith(2, {
      cwd: '/home/u',
      args: ['config', '--global', '--unset-all', 'gpg.program'],
      expectedExitCodes: [0, 5],
    });
    await w.setGlobalIdentity('Ada', 'a@b.c');
    expect(run).toHaveBeenLastCalledWith(
      expect.objectContaining({ args: ['config', '--global', '--replace-all', 'user.email', 'a@b.c'] }),
    );
    await expect(w.writeGitConfig([{ key: 'core.hooksPath', value: 'x' }], 'global')).rejects.toThrow(
      /Refusing/,
    );
    await expect(w.writeGitConfig([], 'local')).rejects.toThrow(/repository is required/);
  });
});

describe('signing / external tools helpers', () => {
  it('signingGitConfig per format', () => {
    const base = {
      'signing.gpgProgram': ' /usr/bin/gpg ',
      'signing.signingKey': 'ABC123',
      'signing.allowedSignersFile': '',
      'signing.signCommits': false,
      'signing.signTags': true,
    } as const;
    expect(signingGitConfig({ ...base, 'signing.format': 'openpgp' })).toEqual([
      { key: 'gpg.format', value: 'openpgp' },
      { key: 'user.signingkey', value: 'ABC123' },
      { key: 'commit.gpgsign', value: 'false' },
      { key: 'tag.gpgsign', value: 'true' },
      { key: 'gpg.program', value: '/usr/bin/gpg' },
    ]);
    expect(signingGitConfig({ ...base, 'signing.format': 'x509' }).at(-1)).toEqual({
      key: 'gpg.x509.program',
      value: '/usr/bin/gpg',
    });
  });

  it('expands $BASE $LOCAL $REMOTE $MERGED into argv without a shell', () => {
    expect(splitArgs(`--a "two words" 'single q' x`)).toEqual(['--a', 'two words', 'single q', 'x']);
    expect(
      expandToolCommand(TOOL_PRESETS.kdiff3!.merge!, {
        BASE: '/t/base',
        LOCAL: '/t/my file',
        REMOTE: '/t/theirs',
        MERGED: '/r/a.txt',
      }),
    ).toEqual(['/t/base', '/t/my file', '/t/theirs', '-o', '/r/a.txt']);
    expect(expandToolCommand('--output=$MERGED $LOCAL', { MERGED: 'm', LOCAL: 'l' })).toEqual([
      '--output=m',
      'l',
    ]);
    expect(() => expandToolCommand('$BASE', {})).toThrow(/\$BASE/);
  });
});
