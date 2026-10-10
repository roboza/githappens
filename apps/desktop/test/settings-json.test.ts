import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPrefsHandlers } from '../src/main/ipc/prefs-handlers';
import { findSecrets } from '../src/main/settings/secret-patterns';
import { parseSettingsBundle, safeThemeFileName } from '../src/main/settings/settings-bundle';
import { SettingsStore, validateSettingsDocument } from '../src/main/settings/settings-store';
import { ThemeService } from '../src/main/settings/theme-service';
import { scopeBadge } from '../src/renderer/src/views/preferences/scope-badge';
import { descriptors, EXPERIMENTS, hasExperiment, settingsJsonSchema } from '../src/shared/settings/registry';
import { scanUserDataForSecrets } from './settings-secret-scan';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-settings-json-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const ctx = { senderId: 1 };

function setup(userData = dir) {
  const warnings: string[] = [];
  const settings = new SettingsStore({ dir: userData, onWarning: (m) => warnings.push(m) });
  settings.load();
  const deps = {
    settings,
    userDataDir: userData,
    secrets: { deleteByPrefix: vi.fn(() => 0) },
    broadcast: vi.fn(),
    setGlobalIdentity: vi.fn(),
    writeGitConfig: vi.fn(),
    openPath: vi.fn(),
    pickPath: vi.fn(async () => null as string | null),
    themes: new ThemeService({ dir: path.join(userData, 'themes') }),
    homeDir: path.join(userData, 'home'),
    pickSavePath: vi.fn(async () => path.join(userData, 'export.json') as string | null),
  };
  return { settings, deps, warnings, h: createPrefsHandlers(deps) };
}

describe('settings.json validation', () => {
  it('reports JSON syntax, shape, unknown / app-scope keys and invalid values', () => {
    expect(validateSettingsDocument('{ "values": { ').problems[0]!.message).toMatch(/Invalid JSON/);
    expect(validateSettingsDocument('[]').problems[0]!.message).toMatch(/object/);
    const r = validateSettingsDocument(
      JSON.stringify({
        version: 1,
        values: { 'ui.zoom': 9, 'nope.key': 1, 'updates.channel': 'preview', 'graph.order': 'date' },
      }),
    );
    expect(r.problems.map((p) => p.key).sort()).toEqual(['nope.key', 'ui.zoom', 'updates.channel']);
    expect(r.values).toEqual({ 'graph.order': 'date' });
    expect(validateSettingsDocument('{"version": 99, "values": {}}').problems[0]!.message).toMatch(/newer/);
    expect(validateSettingsDocument('{"values": {"general.conflictDetection": true}}').values).toEqual({
      'conflicts.detectTarget': true,
    });
  });

  it('readJson exposes a schema for the whole file; writeJson saves only valid documents', async () => {
    const { h, settings, deps } = setup();
    const doc = await h['settings:readJson']({}, ctx);
    expect(doc.readOnly).toBe(false);
    expect((doc.schema.properties as Record<string, unknown>).values).toEqual(settingsJsonSchema());
    const bad = await h['settings:writeJson']({ text: '{"values":{"ui.zoom":"big"}}' }, ctx);
    expect(bad.ok).toBe(false);
    expect(settings.get('ui.zoom')).toBe(1);
    const changed = vi.fn();
    settings.on('changed', changed);
    const ok = await h['settings:writeJson'](
      { text: JSON.stringify({ version: 1, values: { 'ui.zoom': 1.5, 'graph.order': 'topo' } }) },
      ctx,
    );
    expect(ok).toEqual({ ok: true, problems: [] });
    expect(settings.get('ui.zoom')).toBe(1.5);
    expect(changed).toHaveBeenCalledWith({ key: 'ui.zoom', value: 1.5, scope: 'profile' });
    // defaults are not stored (sparse file)
    expect(JSON.parse(fs.readFileSync(settings.settingsFilePath(), 'utf8')).values).toEqual({
      'ui.zoom': 1.5,
    });
    expect(deps.broadcast).not.toHaveBeenCalledWith('profiles:switched', expect.anything());
  });
});

describe('external edit watcher', () => {
  it('reloads valid external edits, ignores invalid files with a warning and ignores own writes', async () => {
    const { settings, warnings } = setup();
    settings.set('ui.zoom', 1.2);
    const changed = vi.fn();
    settings.on('changed', changed);
    settings.watch(30);
    try {
      const file = settings.settingsFilePath();
      await new Promise((r) => setTimeout(r, 100));
      expect(changed).not.toHaveBeenCalled(); // our own write
      fs.writeFileSync(file, JSON.stringify({ version: 1, values: { 'ui.zoom': 2 } }));
      await vi.waitFor(() => expect(settings.get('ui.zoom')).toBe(2), { timeout: 5000 });
      expect(changed).toHaveBeenCalledWith({ key: 'ui.zoom', value: 2, scope: 'profile' });
      fs.writeFileSync(file, '{ broken');
      await vi.waitFor(() => expect(warnings.some((w) => /not valid/.test(w))).toBe(true), { timeout: 5000 });
      expect(settings.get('ui.zoom')).toBe(2);
      expect(fs.readFileSync(file, 'utf8')).toBe('{ broken'); // never reset / backed up by the watcher
    } finally {
      settings.unwatch();
    }
  });
});

describe('newer settings version → read-only', () => {
  it('loads values but refuses every write and reports why', async () => {
    const first = setup();
    first.settings.set('graph.order', 'date');
    const file = first.settings.settingsFilePath();
    const newer = { version: 7, values: { 'graph.order': 'date', 'future.key': 1 } };
    fs.writeFileSync(file, JSON.stringify(newer));
    const { settings, h } = setup();
    expect(settings.get('graph.order')).toBe('date');
    expect(settings.readOnlyReason).toMatch(/newer version/);
    expect(() => settings.set('ui.zoom', 2)).toThrow(/newer version/);
    expect(() => settings.createProfile({ name: 'X' })).toThrow(/newer version/);
    expect(() => settings.writeKeybindings([])).toThrow(/newer version/);
    expect((await h['settings:status']({}, ctx)).readOnly).toBe(true);
    expect((await h['settings:readJson']({}, ctx)).readOnly).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(newer); // not downgraded
  });
});

describe('settings export / import', () => {
  it('round-trips settings, keybindings and themes without secrets', async () => {
    const a = setup();
    a.settings.set('graph.order', 'date');
    const token = `ghp_${'Z'.repeat(36)}`;
    a.settings.set('ai.instructions', `Use the token ${token} for everything`);
    a.settings.set('updates.channel', 'preview');
    a.settings.writeKeybindings([{ command: 'tab.new', key: 'ctrl+alt+n' }]);
    fs.mkdirSync(path.join(dir, 'themes'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'themes', 'ocean.jsonc'),
      '{ "meta": { "name": "Ocean", "scheme": "dark" } }',
    );
    const ex = await a.h['prefs:export']({}, ctx);
    expect(ex).toMatchObject({ settings: 2, keybindings: 1, themes: 1, omitted: ['ai.instructions'] });
    const text = fs.readFileSync(ex!.file, 'utf8');
    expect(text).not.toContain(token);
    expect(findSecrets(text)).toEqual([]);

    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-settings-import-'));
    try {
      const b = setup(otherDir);
      fs.mkdirSync(path.join(otherDir, 'themes'), { recursive: true });
      fs.writeFileSync(path.join(otherDir, 'themes', 'ocean.jsonc'), '{ "different": true }');
      const im = await b.h['prefs:import']({ file: ex!.file }, ctx);
      expect(im).toMatchObject({ applied: 2, keybindings: 1, skipped: [], themes: ['ocean-imported.jsonc'] });
      expect(b.settings.get('graph.order')).toBe('date');
      expect(b.settings.get('updates.channel')).toBe('preview');
      expect(b.settings.get('ai.instructions')).toBe('');
      expect(b.settings.readKeybindings()).toEqual([{ command: 'tab.new', key: 'ctrl+alt+n' }]);
      expect(b.deps.broadcast).toHaveBeenCalledWith('themes:changed', { ids: ['user:ocean-imported'] });
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it('rejects foreign / newer bundles and unsafe theme names; cancel returns null', async () => {
    expect(() => parseSettingsBundle('{"kind":"other"}')).toThrow(/not a GitHappens/);
    expect(() => parseSettingsBundle('{"kind":"githappens-settings","version":9}')).toThrow(/newer/);
    expect(safeThemeFileName('../../evil.jsonc')).toBe('evil.jsonc');
    expect(safeThemeFileName('x.js')).toBeNull();
    const { h } = setup();
    expect(await h['prefs:import']({}, ctx)).toBeNull();
  });
});

describe('userData secret scan helper', () => {
  it('finds credential patterns and planted secrets, skipping the encrypted store', () => {
    const { settings } = setup();
    settings.set('graph.order', 'date');
    expect(scanUserDataForSecrets(dir)).toEqual([]);
    fs.writeFileSync(path.join(dir, 'leak.json'), `{\n"token": "ghp_${'a'.repeat(36)}"\n}`);
    fs.writeFileSync(path.join(dir, 'secrets.bin'), `ghp_${'b'.repeat(36)}`);
    fs.writeFileSync(path.join(dir, 'notes.log'), 'pass=my-planted-passphrase');
    const hits = scanUserDataForSecrets(dir, { known: ['my-planted-passphrase'] });
    expect(hits.map((x) => [x.file, x.line, x.pattern])).toEqual([
      ['leak.json', 2, 'github-token'],
      ['notes.log', 1, 'known-secret'],
    ]);
    expect(hits[0]!.excerpt).not.toContain('a'.repeat(36));
  });
});

describe('registry: scope badges, sections, experiments', () => {
  it('every setting row gets a scope badge', () => {
    for (const d of descriptors())
      expect(scopeBadge(d.scope).label).toMatch(/^(App|Profile|Repo|Git config)$/);
    expect(scopeBadge('profile')).toMatchObject({ label: 'Profile', accent: false });
    expect(scopeBadge('gitLocal').label).toBe('Git config');
    expect(scopeBadge('repo').label).toBe('Repo');
  });

  it('notifications have their own section; experiments are stored in experimental.flags', () => {
    const ds = descriptors();
    expect(
      ds.filter((d) => d.key.startsWith('notifications.')).every((d) => d.section === 'Notifications'),
    ).toBe(true);
    expect(ds.find((d) => d.key === 'experimental.flags')).toMatchObject({
      scope: 'app',
      section: 'Experimental',
    });
    expect(hasExperiment(['monacoTokenRules'], 'monacoTokenRules')).toBe(true);
    expect(hasExperiment(undefined, 'repoDisplayEncoding')).toBe(false);
    expect(EXPERIMENTS.map((x) => x.id)).toEqual(['monacoTokenRules', 'repoDisplayEncoding']);
  });

  it('no setting is still planned (notifications.prEvents now drives Launchpad PR notifications)', () => {
    expect(
      descriptors()
        .filter((d) => d.planned)
        .map((d) => d.key),
    ).toEqual([]);
  });
});
