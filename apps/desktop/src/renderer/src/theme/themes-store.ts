import { create } from 'zustand';

import { BUILTIN_THEMES } from '../../../shared/settings/builtin-themes';
import { builtinResolved, themePreview, type ThemeListEntry } from '../../../shared/settings/theme-model';
import { prefsInvoke, prefsOn } from '../stores/settings';
import { forgetTheme, registerTheme } from './builtin';

const builtinEntries = (): ThemeListEntry[] =>
  Object.keys(BUILTIN_THEMES).map((id) => {
    const t = builtinResolved(id);
    return { id, name: t.name, scheme: t.scheme, source: 'builtin', preview: themePreview(t) };
  });

interface ThemesState {
  /** Built-in + custom themes (custom ones appear after `refresh`). */
  list: ThemeListEntry[];
  loaded: boolean;
  error: string | null;
  refresh(): Promise<void>;
  /** Fetch + register a custom theme so `applyTheme(id)` can use it. */
  load(id: string): Promise<boolean>;
}

/** Theme gallery state (spec 13 Themes section). Custom themes are resolved in main. */
export const useThemesStore = create<ThemesState>((set) => ({
  list: builtinEntries(),
  loaded: false,
  error: null,
  async refresh() {
    try {
      set({ list: await prefsInvoke('themes:list', {}), loaded: true, error: null });
    } catch (e) {
      set({ list: builtinEntries(), loaded: true, error: (e as Error).message });
    }
  },
  async load(id) {
    if (Object.hasOwn(BUILTIN_THEMES, id)) return true;
    try {
      registerTheme(await prefsInvoke('themes:get', { id }));
      return true;
    } catch {
      forgetTheme(id);
      return false;
    }
  },
}));

/** Hot reload: re-resolve changed theme files (the active one re-applies itself). */
prefsOn('themes:changed', ({ ids }) => {
  const st = useThemesStore.getState();
  void st.refresh();
  for (const id of ids) void st.load(id);
});
