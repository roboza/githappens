/**
 * Built-in themes as token maps (spec 13 §5.3, §7 step 7). Keys mirror the theme
 * file's `themeValues.root` names and become CSS variables `--kl-<key>`.
 * Shared so main can use them as the base for custom JSONC themes (`meta.extends`)
 * and to write the `*.jsonc-default` templates.
 */
export type ThemeTokens = Record<string, string>;
export type ThemeScheme = 'dark' | 'light';

export interface BuiltinTheme {
  name: string;
  scheme: ThemeScheme;
  tokens: ThemeTokens;
  /** xterm.js `ITheme` keys. */
  terminal: ThemeTokens;
}

const palette = {
  red: '#e5534b',
  orange: '#f0a04b',
  yellow: '#e3c341',
  green: '#4fb36b',
  teal: '#2ec4b6',
  blue: '#4a90e2',
  ultramarine: '#5b6ee1',
  purple: '#9b6ad6',
  pink: '#e8618c',
  bronze: '#c08a4f',
  grey: '#8a8f98',
};

const graphColors = (order: (keyof typeof palette)[]): ThemeTokens =>
  Object.fromEntries(order.map((c, i) => [`graph-color-${i + 1}`, palette[c]]));

const GRAPH_ORDER: (keyof typeof palette)[] = [
  'teal',
  'blue',
  'purple',
  'pink',
  'orange',
  'yellow',
  'green',
  'ultramarine',
  'red',
  'bronze',
];

export const BUILTIN_THEMES: Record<string, BuiltinTheme> = {
  'builtin:dark': {
    name: 'Dark',
    scheme: 'dark',
    tokens: {
      ...palette,
      ...graphColors(GRAPH_ORDER),
      app__bg0: '#16191d',
      panel__bg0: '#1d2126',
      panel__bg1: '#23282e',
      'panel-border': 'rgba(255,255,255,0.08)',
      'default-border': 'rgba(255,255,255,0.12)',
      input__bg: '#14171b',
      'text-normal': 'rgba(255,255,255,0.86)',
      'text-secondary': 'rgba(255,255,255,0.6)',
      'text-disabled': 'rgba(255,255,255,0.38)',
      'text-selected': '#ffffff',
      'text-accent': palette.teal,
      'text-inverse': '#000000',
      'link-color': '#6cb0ff',
      'btn-bg': '#2c333b',
      'btn-bg-hover': '#353d46',
      'btn-text': 'rgba(255,255,255,0.9)',
      'primary-bg': '#1f8f86',
      'primary-bg-hover': '#23a398',
      'selected-row': 'rgba(46,196,182,0.18)',
      'hover-row': 'rgba(255,255,255,0.05)',
      'danger-row': 'rgba(229,83,75,0.18)',
      added: palette.green,
      modified: palette.orange,
      deleted: palette.red,
      renamed: palette.blue,
      'diff-added__bg': 'rgba(79,179,107,0.18)',
      'diff-deleted__bg': 'rgba(229,83,75,0.18)',
      shadow: '0 6px 24px rgba(0,0,0,0.45)',
    },
    terminal: {
      background: '#16191d',
      foreground: '#d0d4d9',
      cursor: '#2ec4b6',
      cursorAccent: '#16191d',
      selectionBackground: 'rgba(46,196,182,0.3)',
      black: '#1d2126',
      red: '#e5534b',
      green: '#4fb36b',
      yellow: '#e3c341',
      blue: '#4a90e2',
      magenta: '#9b6ad6',
      cyan: '#2ec4b6',
      white: '#d0d4d9',
      brightBlack: '#5c636b',
      brightRed: '#ff7b72',
      brightGreen: '#7ee08f',
      brightYellow: '#f2d76b',
      brightBlue: '#79b8ff',
      brightMagenta: '#c39cf0',
      brightCyan: '#6fe0d4',
      brightWhite: '#ffffff',
    },
  },
  'builtin:light': {
    name: 'Light',
    scheme: 'light',
    tokens: {
      ...palette,
      ...graphColors(GRAPH_ORDER),
      app__bg0: '#eef0f3',
      panel__bg0: '#ffffff',
      panel__bg1: '#f6f7f9',
      'panel-border': 'rgba(0,0,0,0.08)',
      'default-border': 'rgba(0,0,0,0.14)',
      input__bg: '#ffffff',
      'text-normal': 'rgba(0,0,0,0.85)',
      'text-secondary': 'rgba(0,0,0,0.58)',
      'text-disabled': 'rgba(0,0,0,0.36)',
      'text-selected': '#000000',
      'text-accent': '#138a80',
      'text-inverse': '#ffffff',
      'link-color': '#1f6fd1',
      'btn-bg': '#e6e9ed',
      'btn-bg-hover': '#dce0e5',
      'btn-text': 'rgba(0,0,0,0.85)',
      'primary-bg': '#178a80',
      'primary-bg-hover': '#139085',
      'selected-row': 'rgba(19,138,128,0.14)',
      'hover-row': 'rgba(0,0,0,0.04)',
      'danger-row': 'rgba(229,83,75,0.12)',
      added: '#2f9a50',
      modified: '#c27a1c',
      deleted: '#cf3b33',
      renamed: '#2f74c9',
      'diff-added__bg': 'rgba(47,154,80,0.14)',
      'diff-deleted__bg': 'rgba(207,59,51,0.12)',
      shadow: '0 6px 24px rgba(0,0,0,0.15)',
    },
    terminal: {
      background: '#ffffff',
      foreground: '#2b2f33',
      cursor: '#138a80',
      cursorAccent: '#ffffff',
      selectionBackground: 'rgba(19,138,128,0.25)',
      black: '#2b2f33',
      red: '#cf3b33',
      green: '#2f9a50',
      yellow: '#a87a0c',
      blue: '#2f74c9',
      magenta: '#8a4fc7',
      cyan: '#138a80',
      white: '#d7dadf',
      brightBlack: '#6a7178',
      brightRed: '#e5534b',
      brightGreen: '#3fb560',
      brightYellow: '#c99a1c',
      brightBlue: '#4a90e2',
      brightMagenta: '#9b6ad6',
      brightCyan: '#22a99c',
      brightWhite: '#ffffff',
    },
  },
};

export const DEFAULT_THEME_ID = 'builtin:dark';

export const isBuiltinThemeId = (id: string): boolean => Object.hasOwn(BUILTIN_THEMES, id);

export function builtinForScheme(scheme: ThemeScheme): string {
  return scheme === 'light' ? 'builtin:light' : 'builtin:dark';
}
