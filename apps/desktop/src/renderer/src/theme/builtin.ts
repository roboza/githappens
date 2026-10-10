import {
  BUILTIN_THEMES,
  DEFAULT_THEME_ID,
  type ThemeScheme,
  type ThemeTokens,
} from '../../../shared/settings/builtin-themes';
import { builtinResolved, themeToCss, type ResolvedTheme } from '../../../shared/settings/theme-model';

/**
 * Theme application (spec 13 §5.3, §7 step 7). Built-in token maps live in
 * `shared/settings/builtin-themes.ts`; custom JSONC themes are resolved in main and
 * registered here. Every theme becomes `--kl-<token>` CSS variables on :root, with
 * region overrides on `[data-theme-scope="toolbar"|"tabsbar"]`.
 */
export { BUILTIN_THEMES };
export type { ThemeScheme, ThemeTokens, ResolvedTheme };

const custom = new Map<string, ResolvedTheme>();
let active: ResolvedTheme = builtinResolved(DEFAULT_THEME_ID);

/** Make a resolved custom theme available to `applyTheme(id)`. Re-applies it if it is active. */
export function registerTheme(theme: ResolvedTheme): void {
  custom.set(theme.id, theme);
  if (active.id === theme.id) applyResolvedTheme(theme);
}

export function forgetTheme(id: string): void {
  custom.delete(id);
}

export function hasTheme(id: string): boolean {
  return Object.hasOwn(BUILTIN_THEMES, id) || custom.has(id);
}

/** Resolve an id to a theme known to the renderer (unknown ids fall back to built-in dark). */
export function resolveThemeId(id: string): ResolvedTheme {
  return custom.get(id) ?? builtinResolved(id);
}

/** Inject tokens as `--kl-*` variables on :root and set the color scheme. */
export function applyTheme(id: string): void {
  applyResolvedTheme(resolveThemeId(id));
}

export function applyResolvedTheme(theme: ResolvedTheme): void {
  let el = document.getElementById('theme') as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.id = 'theme';
    document.head.appendChild(el);
  }
  el.textContent = themeToCss(theme);
  document.documentElement.dataset.theme = theme.scheme;
  active = theme;
  themeVersion++;
  for (const l of listeners) l();
}

/** The applied theme, including xterm (`terminal`) and Monaco (`monaco`) colours. */
export const getActiveTheme = (): ResolvedTheme => active;

// ---- change notifications for canvas/Monaco consumers that read tokens directly ----
let themeVersion = 0;
const listeners = new Set<() => void>();
export const subscribeTheme = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
export const getThemeVersion = (): number => themeVersion;
