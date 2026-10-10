import fs from 'node:fs';
import path from 'node:path';

import type { PrefsImportResult, SettingsJsonProblem } from '../../shared/ipc/prefs-contract';
import { parseKeybindingOverrides, type KeybindingOverride } from '../../shared/settings/keybindings';
import { writeFileAtomic } from './atomic-file';
import { findSecrets, looksSecret } from './secret-patterns';
import type { SettingsStore } from './settings-store';

/**
 * Settings export / import (spec 13 §4.2 Advanced, §7 step 17): one JSON bundle with the profile's
 * non-default settings, its keybinding overrides and the custom theme files. Never secrets: secrets
 * live in the SecretStore, and any value that still looks like a credential is omitted.
 */

export const BUNDLE_KIND = 'githappens-settings';
export const BUNDLE_VERSION = 1;
/** Hard cap so a huge / hostile file can't stall main. */
const MAX_BUNDLE_BYTES = 5 * 1024 * 1024;
const MAX_THEME_BYTES = 512 * 1024;

export interface SettingsBundle {
  kind: typeof BUNDLE_KIND;
  version: number;
  exportedAt: string;
  profileName?: string;
  settings: Record<string, unknown>;
  keybindings: KeybindingOverride[];
  /** Custom theme files (`themes/<file>.jsonc`), verbatim. */
  themes: { file: string; content: string }[];
}

export function buildSettingsBundle(
  store: SettingsStore,
  themesDir: string,
  now = new Date(),
): { bundle: SettingsBundle; omitted: string[] } {
  const omitted: string[] = [];
  const settings: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(store.nonDefaultValues())) {
    if (looksSecret(v)) omitted.push(k);
    else settings[k] = v;
  }
  const themes: SettingsBundle['themes'] = [];
  let files: string[] = [];
  try {
    files = fs.readdirSync(themesDir).filter((f) => f.toLowerCase().endsWith('.jsonc'));
  } catch {
    /* no themes folder */
  }
  for (const file of files.sort()) {
    try {
      const content = fs.readFileSync(path.join(themesDir, file), 'utf8');
      if (content.length > MAX_THEME_BYTES) continue;
      if (findSecrets(content).length) omitted.push(`themes/${file}`);
      else themes.push({ file, content });
    } catch {
      /* unreadable theme: skip */
    }
  }
  return {
    bundle: {
      kind: BUNDLE_KIND,
      version: BUNDLE_VERSION,
      exportedAt: now.toISOString(),
      profileName: store.activeProfile?.name,
      settings,
      keybindings: store.readKeybindings(),
      themes,
    },
    omitted,
  };
}

/** Parse + structurally validate a bundle file's text. Throws with a user-facing message. */
export function parseSettingsBundle(text: string): SettingsBundle {
  if (text.length > MAX_BUNDLE_BYTES) throw new Error('The settings file is too large.');
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`The settings file is not valid JSON: ${(e as Error).message}`, { cause: e });
  }
  const b = data as Partial<SettingsBundle> | null;
  if (!b || typeof b !== 'object' || b.kind !== BUNDLE_KIND) {
    throw new Error('This file is not a GitHappens settings export.');
  }
  if (!Number.isInteger(b.version) || (b.version as number) > BUNDLE_VERSION) {
    throw new Error('This settings export was made by a newer version of GitHappens.');
  }
  const settings =
    b.settings && typeof b.settings === 'object' && !Array.isArray(b.settings) ? b.settings : {};
  const themes = Array.isArray(b.themes)
    ? b.themes.filter(
        (t): t is { file: string; content: string } =>
          !!t && typeof t.file === 'string' && typeof t.content === 'string',
      )
    : [];
  return {
    kind: BUNDLE_KIND,
    version: b.version as number,
    exportedAt: typeof b.exportedAt === 'string' ? b.exportedAt : '',
    profileName: typeof b.profileName === 'string' ? b.profileName : undefined,
    settings,
    keybindings: Array.isArray(b.keybindings) ? (b.keybindings as KeybindingOverride[]) : [],
    themes,
  };
}

/** `my theme.jsonc` → safe file name inside the themes folder, or null. */
export function safeThemeFileName(file: string): string | null {
  const base = path.basename(file.replace(/\\/g, '/'));
  if (!/^[\w .()-]{1,80}\.jsonc$/i.test(base) || base.startsWith('.')) return null;
  return base;
}

/**
 * Apply a bundle to the active profile: settings key by key (invalid ones skipped), keybindings
 * replaced when the bundle has any, theme files written (an existing different file is kept and the
 * import saved as `<name>-imported[-N].jsonc`).
 */
export function applySettingsBundle(
  store: SettingsStore,
  themesDir: string,
  bundle: SettingsBundle,
  file: string,
): PrefsImportResult {
  const skipped: SettingsJsonProblem[] = [];
  const secretKeys = Object.entries(bundle.settings)
    .filter(([, v]) => looksSecret(v))
    .map(([k]) => k);
  const values = Object.fromEntries(Object.entries(bundle.settings).filter(([k]) => !secretKeys.includes(k)));
  for (const k of secretKeys) skipped.push({ key: k, message: 'Looks like a credential; not imported.' });
  const r = store.importValues(values);
  skipped.push(...r.skipped);

  let keybindings = 0;
  if (bundle.keybindings.length) {
    const kb = parseKeybindingOverrides(bundle.keybindings);
    if (kb.ok) keybindings = store.writeKeybindings(kb.value).length;
    else skipped.push({ key: 'keybindings', message: kb.error });
  }

  const themes: string[] = [];
  for (const t of bundle.themes) {
    const name = safeThemeFileName(t.file);
    if (!name || t.content.length > MAX_THEME_BYTES) {
      skipped.push({ key: `themes/${t.file}`, message: 'Invalid theme file name or size.' });
      continue;
    }
    let target = path.join(themesDir, name);
    for (let i = 0; fs.existsSync(target); i++) {
      if (fs.readFileSync(target, 'utf8') === t.content) break;
      const stem = name.replace(/\.jsonc$/i, '');
      target = path.join(themesDir, `${stem}-imported${i ? `-${i}` : ''}.jsonc`);
    }
    writeFileAtomic(target, t.content);
    themes.push(path.basename(target));
  }
  return { file, applied: r.applied, skipped, keybindings, themes };
}
