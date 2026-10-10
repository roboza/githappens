import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SettingsStore, type SettingsStoreOptions } from '../src/main/settings/settings-store';
import { descriptors, settingsJsonSchema } from '../src/shared/settings/registry';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-prefs-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const readJson = (rel: string): any => JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));
const fresh = (opts: Partial<SettingsStoreOptions> = {}): SettingsStore => {
  const s = new SettingsStore({ dir, ...opts });
  s.load();
  return s;
};
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('registry expansion', () => {
  it('covers every Preferences section that holds settings', () => {
    const sections = new Set(descriptors().map((d) => d.section));
    for (const s of [
      'General',
      'Git',
      'UI Customization',
      'Themes',
      'Editor & Diff',
      'In-App Terminal',
      'External Tools',
      'Commit Signing',
      'SSH',
      'Network',
    ] as const) {
      expect(sections.has(s), s).toBe(true);
    }
  });

  it('marks settings without a consumer as not applied yet in their description', () => {
    // Any still-planned key carries the note (the set shrinks as features land).
    for (const d of descriptors().filter((x) => x.planned)) expect(d.description).toMatch(/Not applied yet/);
    expect(descriptors().find((x) => x.key === 'tools.mergeTool')!.description).not.toMatch(/Not applied/);
    expect(descriptors().find((x) => x.key === 'graph.order')!.description).not.toMatch(/Not applied/);
  });

  it('validates list and url settings', () => {
    const s = fresh();
    s.set('network.noProxy', ['localhost', '*.corp.example']);
    s.set('terminal.shellArgs', ['-NoLogo']);
    expect(s.get('network.noProxy')).toEqual(['localhost', '*.corp.example']);
    expect(() => s.set('network.proxyUrl', 'not a url')).toThrow(/Invalid value/);
    s.set('network.proxyUrl', 'http://proxy.example.com:8080');
    expect(() => s.set('network.noProxy', 'localhost')).toThrow(/Invalid value/);
  });

  it('exposes a JSON schema for settings.json', () => {
    const schema = settingsJsonSchema() as { properties: Record<string, any> };
    expect(schema.properties['graph.order'].enum).toEqual(['date', 'topo']);
    expect(schema.properties['ui.zoom']).toMatchObject({ minimum: 0.5, maximum: 3 });
  });
});

describe('profiles', () => {
  it('creates a profile with its own folder and validates identity', () => {
    const s = fresh();
    const p = s.createProfile({ name: 'Work', authorName: 'Ada', authorEmail: 'ada@work.example' });
    expect(s.listProfiles().map((x) => x.name)).toEqual(['Default', 'Work']);
    expect(readJson('profiles/index.json')).toHaveLength(2);
    expect(fs.existsSync(path.join(dir, 'profiles', p.id))).toBe(true);
    expect(() => s.createProfile({ name: 'work' })).toThrow(/already exists/);
    expect(() => s.createProfile({ name: '  ' })).toThrow(/required/);
    expect(() => s.createProfile({ name: 'X', authorEmail: 'nope' })).toThrow(/email/);
  });

  it('renames and edits identity', () => {
    const s = fresh();
    const p = s.createProfile({ name: 'Work' });
    const changed = vi.fn();
    s.on('profilesChanged', changed);
    const u = s.updateProfile(p.id, { name: 'Job', authorName: 'Ada', authorEmail: 'ada@job.example' });
    expect(u).toMatchObject({ name: 'Job', authorName: 'Ada', authorEmail: 'ada@job.example' });
    expect(readJson('profiles/index.json')[1].name).toBe('Job');
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ activeId: s.activeProfile.id }));
    expect(() => s.updateProfile(p.id, { name: 'default' })).toThrow(/already exists/);
  });

  it('duplicates settings, keybindings and tabs', () => {
    const s = fresh();
    s.set('graph.order', 'date');
    s.writeKeybindings([{ command: 'branch.create', key: 'ctrl+shift+b' }]);
    fs.writeFileSync(path.join(s.profileDir(), 'tabs.json'), '{"tabs":[]}');
    const copy = s.createProfile({ name: 'Copy', duplicateFrom: s.activeProfile.id });
    expect(copy.authorEmail).toBe(s.activeProfile.authorEmail);
    expect(readJson(`profiles/${copy.id}/settings.json`).values).toEqual({ 'graph.order': 'date' });
    expect(s.readKeybindings(copy.id)).toEqual([{ command: 'branch.create', key: 'ctrl+shift+b' }]);
    expect(fs.existsSync(path.join(dir, 'profiles', copy.id, 'tabs.json'))).toBe(true);
  });

  it('switches profile: reloads settings, emits changes and profileSwitched, persists active id', () => {
    const s = fresh();
    const first = s.activeProfile.id;
    s.set('graph.order', 'date');
    const work = s.createProfile({ name: 'Work' });
    const changed = vi.fn();
    const switched = vi.fn();
    s.on('changed', changed);
    s.on('profileSwitched', switched);
    s.switchProfile(work.id);
    expect(s.activeProfile.id).toBe(work.id);
    expect(s.get('graph.order')).toBe('topo');
    expect(changed).toHaveBeenCalledWith({ key: 'graph.order', value: 'topo', scope: 'profile' });
    expect(switched).toHaveBeenCalledWith(expect.objectContaining({ id: work.id }));
    expect(readJson('app.json').activeProfileId).toBe(work.id);
    // writes now go to the new profile
    s.set('ui.zoom', 1.5);
    expect(readJson(`profiles/${work.id}/settings.json`).values).toEqual({ 'ui.zoom': 1.5 });
    expect(readJson(`profiles/${first}/settings.json`).values).toEqual({ 'graph.order': 'date' });
    // app-scope values survive switches
    s.set('updates.channel', 'preview');
    s.switchProfile(first);
    expect(s.get('updates.channel')).toBe('preview');
    expect(s.get('graph.order')).toBe('date');
    // and a fresh store opens the last active profile
    const again = fresh();
    expect(again.activeProfile.id).toBe(first);
    expect(() => s.switchProfile('nope')).toThrow(/Unknown profile/);
  });

  it('syncs the global git identity on switch and edit when enabled', async () => {
    const setGlobalIdentity = vi.fn();
    const s = fresh({ setGlobalIdentity });
    const work = s.createProfile({
      name: 'Work',
      authorName: 'Ada',
      authorEmail: 'ada@work.example',
      syncGitConfig: true,
    });
    const home = s.createProfile({ name: 'Home', authorName: 'Ada L', authorEmail: 'ada@home.example' });
    s.switchProfile(work.id);
    await flush();
    expect(setGlobalIdentity).toHaveBeenCalledWith('Ada', 'ada@work.example');
    s.updateProfile(work.id, { authorEmail: 'ada@new.example' });
    await flush();
    expect(setGlobalIdentity).toHaveBeenLastCalledWith('Ada', 'ada@new.example');
    setGlobalIdentity.mockClear();
    s.switchProfile(home.id); // sync off for this profile
    s.updateProfile(home.id, { authorName: 'Ada Lovelace' });
    await flush();
    expect(setGlobalIdentity).not.toHaveBeenCalled();
  });

  it('reports identity sync failures as warnings', async () => {
    const warn = vi.fn();
    const s = fresh({
      onWarning: warn,
      setGlobalIdentity: () => Promise.reject(new Error('git missing')),
    });
    const p = s.createProfile({ name: 'W', authorName: 'A', authorEmail: 'a@b.c', syncGitConfig: true });
    s.switchProfile(p.id);
    await flush();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/git missing/));
  });

  it('deletes a profile into the trash and reports it; refuses active/last', async () => {
    const onProfileDeleted = vi.fn();
    const s = fresh({ onProfileDeleted });
    await expect(s.deleteProfile(s.activeProfile.id)).rejects.toThrow(/last profile/);
    const work = s.createProfile({ name: 'Work' });
    await expect(s.deleteProfile(s.activeProfile.id)).rejects.toThrow(/Switch to another/);
    s.writeKeybindings([], work.id);
    s.setDefaultProfile(work.id);
    await s.deleteProfile(work.id);
    expect(onProfileDeleted).toHaveBeenCalledWith(work.id);
    expect(s.listProfiles()).toHaveLength(1);
    expect(fs.existsSync(path.join(dir, 'profiles', work.id))).toBe(false);
    expect(fs.readdirSync(path.join(dir, 'profiles', '.trash'))[0]).toMatch(new RegExp(`^${work.id}-`));
    expect(s.profilesState().defaultId).toBe(s.activeProfile.id);
    await expect(s.deleteProfile('missing')).rejects.toThrow(/Unknown profile/);
  });

  it('setHooks installs callbacks after construction', async () => {
    const s = fresh();
    const onProfileDeleted = vi.fn();
    s.setHooks({ onProfileDeleted });
    const p = s.createProfile({ name: 'Tmp' });
    await s.deleteProfile(p.id);
    expect(onProfileDeleted).toHaveBeenCalledWith(p.id);
  });

  it('reads and writes keybinding overrides, recovering from invalid files', () => {
    const warn = vi.fn();
    const s = fresh({ onWarning: warn });
    expect(s.readKeybindings()).toEqual([]);
    s.writeKeybindings([
      { command: 'tab.new', key: 'ctrl+n' },
      { command: 'core.undo', key: '' },
    ]);
    expect(s.readKeybindings()).toEqual([
      { command: 'tab.new', key: 'ctrl+n' },
      { command: 'core.undo', key: '' },
    ]);
    expect(() => s.writeKeybindings([{ command: '', key: 'x' }])).toThrow(/Invalid keybindings/);
    fs.writeFileSync(path.join(s.profileDir(), 'keybindings.json'), '{ broken');
    expect(s.readKeybindings()).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/Keybindings file/));
  });
});
