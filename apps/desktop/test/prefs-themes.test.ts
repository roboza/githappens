import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ThemeService } from '../src/main/settings/theme-service';
import { BUILTIN_THEMES } from '../src/shared/settings/builtin-themes';
import {
  builtinTemplate,
  evaluateTokens,
  LESS_FUNCTIONS,
  mixColors,
  parseExpression,
  parseThemeFile,
  resolveTheme,
  themeToCss,
} from '../src/shared/settings/theme-engine';

describe('LESS colour functions', () => {
  it('lighten / darken adjust HSL lightness by absolute amounts', () => {
    expect(LESS_FUNCTIONS.lighten!(['#000000', '50%'])).toBe('#808080');
    expect(LESS_FUNCTIONS.darken!(['#ffffff', '100%'])).toBe('#000000');
    expect(LESS_FUNCTIONS.darken!(['hsl(0, 0%, 60%)', '10%'])).toBe('#808080');
  });

  it('fade sets alpha; fadein/fadeout adjust it', () => {
    expect(LESS_FUNCTIONS.fade!(['#ffffff', '8%'])).toBe('rgba(255,255,255,0.08)');
    expect(LESS_FUNCTIONS.fade!(['red', '100%'])).toBe('#ff0000');
    expect(LESS_FUNCTIONS.fadeout!(['rgba(0,0,0,0.5)', '20%'])).toBe('rgba(0,0,0,0.3)');
    expect(LESS_FUNCTIONS.fadein!(['rgba(0,0,0,0.5)', '50%'])).toBe('#000000');
  });

  it('saturate / desaturate / spin', () => {
    expect(LESS_FUNCTIONS.desaturate!(['#ff0000', '100%'])).toBe('#808080');
    expect(LESS_FUNCTIONS.saturate!(['hsl(0, 50%, 50%)', '50%'])).toBe('#ff0000');
    expect(LESS_FUNCTIONS.spin!(['#ff0000', '120'])).toBe('#00ff00');
  });

  it('mix follows the LESS weighting', () => {
    expect(mixColors('#ff0000', '#0000ff')).toBe('#800080');
    expect(mixColors('#ff0000', '#0000ff', 1)).toBe('#ff0000');
    expect(mixColors('#ffffff', '#000000', 0.25)).toBe('#404040');
    expect(LESS_FUNCTIONS.tint!(['#000000', '50%'])).toBe('#808080');
  });

  it('rejects non-colours', () => {
    expect(() => LESS_FUNCTIONS.lighten!(['calc(1px + 2px)', '10%'])).toThrow(/not a colour/);
  });
});

describe('expression evaluation', () => {
  it('parses nested calls and keeps text', () => {
    expect(parseExpression('0 6px 24px rgba(0,0,0,0.45)')).toEqual([
      { kind: 'text', value: '0 6px 24px ' },
      {
        kind: 'call',
        name: 'rgba',
        args: [
          [{ kind: 'text', value: '0' }],
          [{ kind: 'text', value: '0' }],
          [{ kind: 'text', value: '0' }],
          [{ kind: 'text', value: '0.45' }],
        ],
      },
    ]);
  });

  it('resolves var() references, nested LESS functions and passes CSS functions through', () => {
    const r = evaluateTokens({
      blue: '#4a90e2',
      accent: 'var(--blue)',
      'accent-soft': 'fade(var(--accent), 20%)',
      'accent-dark': 'darken(var(--kl-accent), 10%)',
      mixed: 'mix(var(--blue), #ffffff, 50%)',
      width: 'calc(100% - var(--gap))',
      gap: '8px',
      shadow: '0 2px 4px fade(#000, 50%)',
      fallback: 'var(--missing, #123456)',
    });
    expect(r.errors).toEqual([]);
    expect(r.tokens).toMatchObject({
      accent: '#4a90e2',
      'accent-soft': 'rgba(74,144,226,0.2)',
      'accent-dark': '#2275d7',
      mixed: '#a5c8f1',
      width: 'calc(100% - 8px)',
      shadow: '0 2px 4px rgba(0,0,0,0.5)',
      fallback: '#123456',
    });
  });

  it('detects var() cycles and falls back per key', () => {
    const r = evaluateTokens(
      { a: 'var(--b)', b: 'var(--c)', c: 'var(--a)', ok: 'lighten(var(--x), 10%)', x: '#000' },
      { fallback: { a: '#111111', b: '#222222' } },
    );
    expect(r.errors.map((e) => e.key).sort()).toEqual(['a', 'b', 'c']);
    expect(r.errors[0]!.message).toMatch(/Cycle in var\(\)/);
    expect(r.tokens.a).toBe('#111111');
    expect(r.tokens.b).toBe('#222222');
    expect(r.tokens.c).toBeUndefined();
    expect(r.tokens.ok).toBe('#1a1a1a');
  });

  it('reports unknown variables and bad arguments', () => {
    const r = evaluateTokens({ a: 'var(--nope)', b: 'fade(#fff)', c: 'lighten(#fff' });
    expect(r.errors.find((e) => e.key === 'a')!.message).toMatch(/Unknown variable --nope/);
    expect(r.errors.find((e) => e.key === 'b')!.message).toMatch(/needs 2 arguments/);
    expect(r.errors.find((e) => e.key === 'c')!.message).toMatch(/Missing "\)"/);
  });
});

const THEME = `// My theme
{
  "meta": { "name": "Ocean", "scheme": "dark", "extends": "builtin:dark", },
  "themeValues": {
    "root": {
      "blue": "#3a7bd5",
      "panel__bg1": "lighten(var(--panel__bg0), 4%)",
      "text-accent": "var(--blue)", // trailing comment
      "broken": "var(--loop)",
      "loop": "var(--broken)",
    },
    "toolbar": { "text-normal": "fade(var(--blue), 80%)" },
    "terminal": { "background": "var(--app__bg0)" },
    "editor": { "monacoBase": "vs-dark", "colors": { "editor.background": "var(--panel__bg0)" } },
  },
}`;

describe('JSONC theme files', () => {
  it('parses comments / trailing commas and resolves against the base theme', () => {
    const p = parseThemeFile(THEME);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    const t = resolveTheme(p.theme, 'user:ocean', { tree: p.tree, text: p.text });
    expect(t).toMatchObject({ name: 'Ocean', scheme: 'dark', source: 'user' });
    expect(t.tokens['text-accent']).toBe('#3a7bd5');
    expect(t.tokens['app__bg0']).toBe(BUILTIN_THEMES['builtin:dark']!.tokens['app__bg0']);
    expect(t.tokens['panel__bg1']).toMatch(/^#[0-9a-f]{6}$/);
    expect(t.scopes.toolbar!['text-normal']).toBe('rgba(58,123,213,0.8)');
    expect(t.terminal.background).toBe(BUILTIN_THEMES['builtin:dark']!.tokens['app__bg0']);
    expect(t.terminal.red).toBe(BUILTIN_THEMES['builtin:dark']!.terminal.red);
    expect(t.monaco.colors['editor.background']).toBe(BUILTIN_THEMES['builtin:dark']!.tokens['panel__bg0']);
    // cycle errors carry their source line
    const cyc = t.errors.find((e) => e.key === 'root.broken')!;
    expect(cyc.message).toMatch(/Cycle/);
    expect(cyc.line).toBe(9);
  });

  it('reports syntax errors with line/column', () => {
    const p = parseThemeFile('{\n  "meta": { "name": "x" "scheme": "dark" }\n}');
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.errors[0]).toMatchObject({ line: 2 });
    expect(p.errors[0]!.message).toMatch(/CommaExpected/);
  });

  it('reports schema errors (missing name, bad scheme)', () => {
    const p = parseThemeFile('{ "meta": { "name": "", "scheme": "blue" } }');
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.errors.map((e) => e.message).join('\n')).toMatch(/meta\.name/);
    expect(p.errors.map((e) => e.message).join('\n')).toMatch(/meta\.scheme/);
  });

  it('the shipped templates are valid themes equal to their built-in', () => {
    for (const id of Object.keys(BUILTIN_THEMES)) {
      const p = parseThemeFile(builtinTemplate(id));
      expect(p.ok, id).toBe(true);
      if (!p.ok) continue;
      const t = resolveTheme(p.theme, 'user:t');
      expect(t.errors).toEqual([]);
      expect(t.tokens).toEqual(BUILTIN_THEMES[id]!.tokens);
    }
  });

  it('emits CSS variables, scoped overrides and drops unsafe values', () => {
    const css = themeToCss({
      scheme: 'dark',
      tokens: { blue: '#00f', evil: 'red;}body{display:none' },
      scopes: { toolbar: { 'text-normal': '#fff' } },
    });
    expect(css).toContain('--kl-blue:#00f;');
    expect(css).not.toContain('evil');
    expect(css).toContain('color-scheme:dark');
    expect(css).toContain('[data-theme-scope="toolbar"]{--kl-text-normal:#fff;}');
  });
});

describe('ThemeService', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-themes-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('lists built-ins and user files, falls back for invalid ones, and creates from current', () => {
    const svc = new ThemeService({ dir });
    svc.ensureTemplates();
    expect(fs.existsSync(path.join(dir, 'dark.jsonc-default'))).toBe(true);
    fs.writeFileSync(path.join(dir, 'ocean.jsonc'), THEME);
    fs.writeFileSync(path.join(dir, 'bad.jsonc'), '{ nope');
    const list = svc.list();
    expect(list.map((t) => t.id)).toEqual(['builtin:dark', 'builtin:light', 'user:bad', 'user:ocean']);
    expect(list.find((t) => t.id === 'user:bad')!.errors![0]!.line).toBe(1);
    expect(list.find((t) => t.id === 'user:ocean')!.preview.length).toBeGreaterThan(3);

    const bad = svc.get('user:bad');
    expect(bad.tokens).toEqual(BUILTIN_THEMES['builtin:dark']!.tokens);
    expect(bad.errors.length).toBeGreaterThan(0);
    expect(svc.get('user:../../etc').id).toBe('builtin:dark');

    const created = svc.createFromCurrent('user:ocean');
    expect(created.id).toBe('user:my-theme');
    const again = svc.get(created.id);
    expect(again.errors).toEqual([]);
    expect(again.tokens['text-accent']).toBe('#3a7bd5');
    expect(svc.createFromCurrent('builtin:light').id).toBe('user:my-theme-2');
  });

  it('watches the folder and reports changed ids (debounced)', async () => {
    const onChanged = vi.fn();
    const svc = new ThemeService({ dir, debounceMs: 30, onChanged });
    svc.watch();
    try {
      // macOS FSEvents can miss writes made right after the watcher starts: keep touching the file
      // until an event arrives.
      await vi.waitFor(
        () => {
          if (!onChanged.mock.calls.length) fs.writeFileSync(path.join(dir, 'w.jsonc'), THEME);
          expect(onChanged).toHaveBeenCalled();
        },
        { timeout: 10_000, interval: 200 },
      );
      expect(onChanged.mock.calls.flat(2)).toContain('user:w');
    } finally {
      svc.dispose();
    }
  });
});
