import { useEffect, useState } from 'react';

import { isBuiltinThemeId } from '../../../shared/settings/builtin-themes';
import { invoke } from '../lib/api';
import { useSetting } from '../stores/settings';
import { applyTheme, getActiveTheme, hasTheme, subscribeTheme } from './builtin';
import { useThemesStore } from './themes-store';

const darkQuery = (): MediaQueryList => window.matchMedia('(prefers-color-scheme: dark)');

/** The theme id that should be active for the given settings (spec 13 §4.2 Sync with OS). */
export function effectiveThemeId(o: {
  theme: string;
  followOs: boolean;
  osDark: boolean;
  themeLight: string;
  themeDark: string;
}): string {
  if (!o.followOs) return o.theme;
  return o.osDark ? o.themeDark : o.themeLight;
}

/**
 * Applies `ui.theme` / `ui.themeFollowOs` / `ui.themeLight` / `ui.themeDark` (spec 13), follows OS
 * changes live, loads custom JSONC themes from main, and applies `ui.reduceMotion`.
 */
export function useThemeController(): void {
  const theme = useSetting('ui.theme') ?? 'builtin:dark';
  const followOs = useSetting('ui.themeFollowOs') ?? true;
  const themeLight = useSetting('ui.themeLight') ?? 'builtin:light';
  const themeDark = useSetting('ui.themeDark') ?? 'builtin:dark';
  const reduceMotion = useSetting('ui.reduceMotion') ?? 'os';
  const [osDark, setOsDark] = useState(() => darkQuery().matches);

  useEffect(() => {
    const mq = darkQuery();
    const onChange = (e: MediaQueryListEvent): void => setOsDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    void useThemesStore.getState().refresh();
  }, []);

  const id = effectiveThemeId({ theme, followOs, osDark, themeLight, themeDark });

  useEffect(() => {
    let cancelled = false;
    if (isBuiltinThemeId(id) || hasTheme(id)) applyTheme(id);
    else {
      // Custom theme: paint the matching built-in first, then swap once resolved.
      void useThemesStore
        .getState()
        .load(id)
        .then((ok) => {
          if (!cancelled) applyTheme(ok ? id : osDark ? 'builtin:dark' : 'builtin:light');
        });
    }
    return () => {
      cancelled = true;
    };
  }, [id, osDark]);

  // Native window controls overlay follows the applied theme (Win/Linux).
  useEffect(() => {
    const sync = (): void => {
      const t = getActiveTheme();
      void invoke('shell:setTitleBarColors', {
        background: t.tokens['panel__bg0'] ?? '#1d2126',
        foreground: t.scheme === 'dark' ? '#d0d4d9' : '#3a3f45',
      }).catch(() => undefined);
    };
    sync();
    return subscribeTheme(sync);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.reduceMotion = reduceMotion;
  }, [reduceMotion]);
}
