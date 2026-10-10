import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';

import { hasExperiment } from '../../../shared/settings/registry';
import { useSettingsStore } from '../stores/settings';
import { getActiveTheme, subscribeTheme } from '../theme/builtin';

/**
 * Local Monaco (no CDN; CSP allows only 'self'). The base editor worker serves diffs and files; the
 * JSON worker validates settings.json against the settings schema (spec 13 §4.2 Advanced).
 */
self.MonacoEnvironment = {
  getWorker: (_id: string, label: string) => (label === 'json' ? new JsonWorker() : new EditorWorker()),
};
loader.config({ monaco });

const cssVar = (name: string): string =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#000000';

/** Hex-ify `rgba(...)`/`#rgb`/named values Monaco can't parse. */
export function toHex(color: string): string {
  if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(color)) return color;
  const ctx = document.createElement('canvas').getContext('2d')!;
  ctx.fillStyle = '#000000';
  ctx.fillStyle = color;
  const v = ctx.fillStyle; // "#rrggbb" or "rgba(r, g, b, a)"
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(v);
  if (!m) return v;
  const hex = (n: number): string => n.toString(16).padStart(2, '0');
  const a = m[4] === undefined ? '' : hex(Math.round(Number(m[4]) * 255));
  return `#${hex(+m[1]!)}${hex(+m[2]!)}${hex(+m[3]!)}${a}`;
}

/** Monaco token rule colours are hex without `#`. */
const ruleColor = (c: string | undefined): string | undefined => (c ? toHex(c).replace(/^#/, '') : undefined);

const monacoName = (id: string): string => `kl-${id.replace(/[^a-zA-Z0-9-]/g, '-')}`;

/**
 * Derive a Monaco theme from the active theme (spec 13 §5.3 `editor` group): base from the theme's
 * `editor.monacoBase` / scheme, colours from the `--kl-*` tokens overlaid with the theme file's
 * `editor.colors`, and — with the `monacoTokenRules` experiment — its `editor.rules`.
 */
export function applyMonacoTheme(): string {
  const t = getActiveTheme();
  const dark = document.documentElement.dataset.theme !== 'light';
  const name = monacoName(t.id);
  const flags = useSettingsStore.getState().values?.['experimental.flags'];
  const colors: Record<string, string> = {
    'editor.background': toHex(cssVar('--kl-panel__bg0')),
    'editorGutter.background': toHex(cssVar('--kl-panel__bg0')),
    'diffEditor.insertedLineBackground': toHex(cssVar('--kl-diff-added__bg')),
    'diffEditor.removedLineBackground': toHex(cssVar('--kl-diff-deleted__bg')),
  };
  for (const [k, v] of Object.entries(t.monaco?.colors ?? {})) {
    if (/^[A-Za-z0-9.]+$/.test(k) && v) colors[k] = toHex(v);
  }
  const rules = hasExperiment(flags, 'monacoTokenRules')
    ? (t.monaco?.rules ?? []).map((r) => ({
        token: r.token,
        foreground: ruleColor(r.foreground),
        background: ruleColor(r.background),
        fontStyle: r.fontStyle,
      }))
    : [];
  monaco.editor.defineTheme(name, {
    base: t.monaco?.base ?? (dark ? 'vs-dark' : 'vs'),
    inherit: true,
    rules,
    colors,
  });
  return name;
}

// Live re-theme of open editors when the app theme (or the token-rules experiment) changes.
let lastFlags: unknown;
const retheme = (): void => {
  try {
    monaco.editor.setTheme(applyMonacoTheme());
  } catch {
    /* no editor created yet */
  }
};
subscribeTheme(retheme);
useSettingsStore.subscribe((s) => {
  const f = s.values?.['experimental.flags'];
  if (f !== lastFlags) {
    lastFlags = f;
    retheme();
  }
});

export const SETTINGS_SCHEMA_URI = 'githappens://schemas/settings.json';
export const SETTINGS_MODEL_URI = 'githappens://profile/settings.json';

/** Register the settings.json schema with Monaco's JSON language service. */
export function registerSettingsSchema(schema: Record<string, unknown>): void {
  monaco.json.jsonDefaults.setDiagnosticsOptions({
    validate: true,
    allowComments: false,
    enableSchemaRequest: false,
    schemas: [{ uri: SETTINGS_SCHEMA_URI, fileMatch: [SETTINGS_MODEL_URI], schema }],
  });
}

export function languageFor(path: string): string {
  const lower = path.toLowerCase();
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.')) : '';
  const base = lower.split('/').pop() ?? lower;
  for (const lang of monaco.languages.getLanguages()) {
    if (lang.filenames?.some((f) => f.toLowerCase() === base)) return lang.id;
    if (ext && lang.extensions?.includes(ext)) return lang.id;
  }
  return 'plaintext';
}

export { monaco };
