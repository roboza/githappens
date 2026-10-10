import { BUILTIN_THEMES, DEFAULT_THEME_ID, type ThemeScheme, type ThemeTokens } from './builtin-themes';

/** Theme data model shared by main (resolver) and renderer (applier). Dependency-free. */

export interface ThemeError {
  message: string;
  /** Token key the error belongs to (`root.panel__bg1`, `toolbar.text-normal`, …). */
  key?: string;
  line?: number;
  column?: number;
}

export interface MonacoThemeData {
  base: 'vs' | 'vs-dark' | 'hc-black' | 'hc-light';
  inherit: boolean;
  rules: { token: string; foreground?: string; background?: string; fontStyle?: string }[];
  colors: Record<string, string>;
}

export interface ResolvedTheme {
  id: string;
  name: string;
  scheme: ThemeScheme;
  source: 'builtin' | 'user';
  file?: string;
  /** Global tokens → `--kl-<key>` on :root. */
  tokens: ThemeTokens;
  /** Region overrides (`toolbar`, `tabsbar`) → re-declared on `[data-theme-scope="<name>"]`. */
  scopes: Record<string, ThemeTokens>;
  /** xterm.js ITheme. */
  terminal: ThemeTokens;
  monaco: MonacoThemeData;
  errors: ThemeError[];
}

export interface ThemeListEntry {
  id: string;
  name: string;
  scheme: ThemeScheme;
  source: 'builtin' | 'user';
  file?: string;
  errors?: ThemeError[];
  /** A few representative colours for gallery swatches. */
  preview: string[];
}

export const SCOPED_GROUPS = ['toolbar', 'tabsbar'] as const;

export const monacoBaseFor = (scheme: ThemeScheme): MonacoThemeData['base'] =>
  scheme === 'light' ? 'vs' : 'vs-dark';

export function builtinResolved(id: string): ResolvedTheme {
  const realId = Object.hasOwn(BUILTIN_THEMES, id) ? id : DEFAULT_THEME_ID;
  const t = BUILTIN_THEMES[realId]!;
  return {
    id: realId,
    name: t.name,
    scheme: t.scheme,
    source: 'builtin',
    tokens: { ...t.tokens },
    scopes: {},
    terminal: { ...t.terminal },
    monaco: { base: monacoBaseFor(t.scheme), inherit: true, rules: [], colors: {} },
    errors: [],
  };
}

export function themePreview(t: Pick<ResolvedTheme, 'tokens'>): string[] {
  return [
    'app__bg0',
    'panel__bg0',
    'text-normal',
    'text-accent',
    'graph-color-1',
    'graph-color-2',
    'graph-color-3',
  ]
    .map((k) => t.tokens[k])
    .filter((v): v is string => !!v);
}

export function themeToCss(t: Pick<ResolvedTheme, 'tokens' | 'scopes' | 'scheme'>): string {
  const vars = (m: ThemeTokens): string =>
    Object.entries(m)
      .filter(([k, v]) => /^[a-zA-Z0-9_-]+$/.test(k) && !/[;{}<>]/.test(v))
      .map(([k, v]) => `--kl-${k}:${v};`)
      .join('');
  let css = `:root{${vars(t.tokens)}color-scheme:${t.scheme};}`;
  for (const [scope, tokens] of Object.entries(t.scopes)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(scope)) continue;
    css += `[data-theme-scope="${scope}"]{${vars(tokens)}}`;
  }
  return css;
}
