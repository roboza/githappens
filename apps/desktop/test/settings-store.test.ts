import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SettingsStore } from '../src/main/settings/settings-store';
import { defaultValues, descriptors, SETTING_KEYS, SETTINGS } from '../src/shared/settings/registry';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-settings-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const readJson = (rel: string): any => JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));
const profileSettingsPath = (store: SettingsStore): string =>
  `profiles/${store.activeProfile.id}/settings.json`;

describe('settings registry', () => {
  it('every default validates against its schema', () => {
    for (const k of SETTING_KEYS)
      expect(SETTINGS[k].schema.safeParse(SETTINGS[k].default).success, k).toBe(true);
  });

  it('exports serializable descriptors with enums and bounds', () => {
    const d = descriptors();
    expect(JSON.parse(JSON.stringify(d))).toEqual(d);
    expect(d.find((x) => x.key === 'graph.order')?.enum).toEqual(['date', 'topo']);
    expect(d.find((x) => x.key === 'ui.zoom')).toMatchObject({ min: 0.5, max: 3 });
  });
});

describe('SettingsStore', () => {
  it('first run creates a Default profile from the global git identity', () => {
    const s = new SettingsStore({ dir, defaultIdentity: () => ({ name: 'Ada', email: 'ada@example.com' }) });
    s.load();
    expect(s.activeProfile).toMatchObject({
      name: 'Default',
      authorName: 'Ada',
      authorEmail: 'ada@example.com',
    });
    expect(readJson('profiles/index.json')).toHaveLength(1);
    expect(readJson('app.json').activeProfileId).toBe(s.activeProfile.id);
    expect(s.snapshot().values).toEqual(defaultValues());
  });

  it('writes only non-default values, to the right scope file', () => {
    const s = new SettingsStore({ dir });
    s.load();
    s.set('graph.order', 'date');
    s.set('updates.channel', 'preview');
    expect(readJson(profileSettingsPath(s)).values).toEqual({ 'graph.order': 'date' });
    expect(readJson('app.json').values).toEqual({ 'updates.channel': 'preview' });
    s.set('graph.order', 'topo'); // back to default → removed
    expect(readJson(profileSettingsPath(s)).values).toEqual({});
  });

  it('persists across reloads', () => {
    const a = new SettingsStore({ dir });
    a.load();
    a.set('ui.zoom', 1.25);
    a.set('git.executable', '/opt/git/bin/git');
    const b = new SettingsStore({ dir });
    b.load();
    expect(b.get('ui.zoom')).toBe(1.25);
    expect(b.get('git.executable')).toBe('/opt/git/bin/git');
    expect(b.activeProfile.id).toBe(a.activeProfile.id);
  });

  it('validates values and rejects unknown keys', () => {
    const s = new SettingsStore({ dir });
    s.load();
    expect(() => s.set('ui.zoom', 10)).toThrow(/Invalid value/);
    expect(() => s.set('general.defaultBranchName', 'has space')).toThrow(/Invalid value/);
    expect(() => s.set('nope.key', 1)).toThrow(/Unknown setting/);
  });

  it('emits change events only for real changes', () => {
    const s = new SettingsStore({ dir });
    s.load();
    const spy = vi.fn();
    s.on('changed', spy);
    s.set('diff.defaultView', 'split');
    s.set('diff.defaultView', 'split');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ key: 'diff.defaultView', value: 'split', scope: 'profile' });
  });

  it('reset restores defaults', () => {
    const s = new SettingsStore({ dir });
    s.load();
    s.set('editor.fontSize', 16);
    s.set('ui.dateFormat', 'iso');
    s.reset('editor.fontSize');
    expect(s.get('editor.fontSize')).toBe(12);
    s.reset();
    expect(s.snapshot().values).toEqual(defaultValues());
    expect(readJson(profileSettingsPath(s)).values).toEqual({});
  });

  it('backs up a corrupt file, falls back to defaults and warns', () => {
    const a = new SettingsStore({ dir });
    a.load();
    a.set('graph.order', 'date');
    const file = path.join(dir, profileSettingsPath(a));
    fs.writeFileSync(file, '{ not json');
    const warn = vi.fn();
    const b = new SettingsStore({ dir, onWarning: warn });
    b.load();
    expect(b.get('graph.order')).toBe('topo');
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/backup was saved/));
    expect(fs.readdirSync(path.dirname(file)).some((f) => f.startsWith('settings.json.bak-'))).toBe(true);
  });

  it('drops invalid stored values with a warning and keeps unknown keys on write', () => {
    const a = new SettingsStore({ dir });
    a.load();
    const file = path.join(dir, profileSettingsPath(a));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, values: { 'ui.zoom': 'huge', 'future.key': 42 } }));
    const warn = vi.fn();
    const b = new SettingsStore({ dir, onWarning: warn });
    b.load();
    expect(b.get('ui.zoom')).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/ui\.zoom/));
    b.set('graph.order', 'date');
    expect(readJson(profileSettingsPath(b)).values).toEqual({ 'future.key': 42, 'graph.order': 'date' });
  });

  it('runs migrations for older file versions and rewrites at the current version', () => {
    fs.writeFileSync(
      path.join(dir, 'app.json'),
      JSON.stringify({ version: 1, values: { channel: 'preview' } }),
    );
    const s = new SettingsStore({
      dir,
      fileVersion: 2,
      migrations: [({ channel, ...rest }) => ({ ...rest, 'updates.channel': channel })], // v1 → v2
    });
    s.load();
    expect(s.get('updates.channel')).toBe('preview');
    expect(readJson('app.json').version).toBe(2);
  });
});
