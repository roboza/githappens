import { useEffect } from 'react';

import { useSetting, useSettingsStore } from '../stores/settings';
import { useThemesStore } from '../theme/themes-store';
import s from './Card.module.css';

/** Theme picker writing `ui.themeFollowOs` + `ui.theme` (spec 13 UI Customization), incl. custom themes. */
export function AppearanceCard() {
  const followOs = useSetting('ui.themeFollowOs') ?? true;
  const theme = useSetting('ui.theme') ?? 'builtin:dark';
  const setSetting = useSettingsStore((st) => st.set);
  const themes = useThemesStore((st) => st.list);
  const refresh = useThemesStore((st) => st.refresh);
  const value = followOs ? 'system' : theme;

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onChange = async (v: string): Promise<void> => {
    if (v === 'system') await setSetting('ui.themeFollowOs', true);
    else {
      await setSetting('ui.theme', v);
      await setSetting('ui.themeFollowOs', false);
    }
  };

  return (
    <section className={s.card} aria-labelledby="appearance-title">
      <h2 id="appearance-title" className={s.title}>
        Appearance
      </h2>
      <div className={s.controls}>
        <label htmlFor="theme-select">Theme</label>
        <select id="theme-select" value={value} onChange={(e) => void onChange(e.target.value)}>
          <option value="system">Match system</option>
          {themes.map((t) => (
            <option key={t.id} value={t.id} disabled={t.source === 'user' && !t.preview.length}>
              {t.name}
              {t.source === 'user' ? ' (custom)' : ''}
            </option>
          ))}
          {!followOs && !themes.some((t) => t.id === theme) && <option value={theme}>{theme}</option>}
        </select>
      </div>
      <p className={s.muted}>Saved to your profile settings and applied instantly in every window.</p>
    </section>
  );
}
