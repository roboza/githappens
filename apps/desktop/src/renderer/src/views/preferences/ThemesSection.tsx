import { FilePlus2, FolderOpen, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { ThemeListEntry } from '../../../../shared/settings/theme-model';
import { IpcError } from '../../lib/api';
import { prefsInvoke, useSetting, useSettingsStore } from '../../stores/settings';
import { getActiveTheme } from '../../theme/builtin';
import { useThemesStore } from '../../theme/themes-store';
import s from './PreferencesView.module.css';

const errorText = (e: unknown): string =>
  e instanceof IpcError ? e.error.message : e instanceof Error ? e.message : String(e);

/** Themes section (spec 13 §4.2 Themes): gallery, follow-OS pair, custom JSONC theme actions. */
export function ThemesSection() {
  const list = useThemesStore((st) => st.list);
  const listError = useThemesStore((st) => st.error);
  const refresh = useThemesStore((st) => st.refresh);
  const setSetting = useSettingsStore((st) => st.set);
  const theme = useSetting('ui.theme') ?? 'builtin:dark';
  const followOs = useSetting('ui.themeFollowOs') ?? true;
  const themeLight = useSetting('ui.themeLight') ?? 'builtin:light';
  const themeDark = useSetting('ui.themeDark') ?? 'builtin:dark';
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const act = async (fn: () => Promise<string | void>): Promise<void> => {
    try {
      const text = await fn();
      setMessage(text ? { ok: true, text } : null);
    } catch (e) {
      setMessage({ ok: false, text: errorText(e) });
    }
  };

  const pick = (t: ThemeListEntry): Promise<void> =>
    act(async () => {
      if (followOs) await setSetting(t.scheme === 'light' ? 'ui.themeLight' : 'ui.themeDark', t.id);
      else await setSetting('ui.theme', t.id);
    });

  const selectedIds = followOs ? [themeLight, themeDark] : [theme];
  const usable = list.filter((t) => !(t.source === 'user' && t.errors?.length && !t.preview.length));

  return (
    <>
      <div className={s.row}>
        <div className={s.rowText}>
          <label htmlFor="theme-follow" className={s.rowTitle}>
            Follow OS light/dark mode
          </label>
          <p className={s.rowDesc}>
            {followOs
              ? 'Choosing a theme below sets the light or dark slot, by its scheme.'
              : 'Choosing a theme below applies it everywhere.'}
          </p>
        </div>
        <div className={s.control}>
          <input
            id="theme-follow"
            type="checkbox"
            role="switch"
            className={s.toggle}
            checked={followOs}
            onChange={(e) => void act(() => setSetting('ui.themeFollowOs', e.target.checked))}
          />
        </div>
        <span />
      </div>
      {followOs && (
        <div className={s.form}>
          <label htmlFor="theme-light">Light theme</label>
          <select
            id="theme-light"
            value={themeLight}
            onChange={(e) => void act(() => setSetting('ui.themeLight', e.target.value))}
          >
            {usable
              .filter((t) => t.scheme === 'light' || t.id === themeLight)
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
          </select>
          <label htmlFor="theme-dark">Dark theme</label>
          <select
            id="theme-dark"
            value={themeDark}
            onChange={(e) => void act(() => setSetting('ui.themeDark', e.target.value))}
          >
            {usable
              .filter((t) => t.scheme === 'dark' || t.id === themeDark)
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
          </select>
        </div>
      )}

      <div className={s.toolbar}>
        <button type="button" onClick={() => void act(() => prefsInvoke('themes:openFolder', {}))}>
          <FolderOpen size={14} /> Open themes folder
        </button>
        <button
          type="button"
          onClick={() =>
            void act(async () => {
              const r = await prefsInvoke('themes:createFromCurrent', { baseId: getActiveTheme().id });
              await refresh();
              return `Created ${r.file}. Edit and save it; changes apply instantly.`;
            })
          }
        >
          <FilePlus2 size={14} /> Create theme from current
        </button>
        <button
          type="button"
          onClick={() =>
            void act(async () => {
              await prefsInvoke('themes:reload', {});
              await refresh();
            })
          }
        >
          <RefreshCw size={14} /> Reload
        </button>
      </div>
      {message && (
        <p className={message.ok ? s.ok : s.error} role={message.ok ? 'status' : 'alert'}>
          {message.text}
        </p>
      )}
      {listError && <p className={s.error}>Custom themes are unavailable: {listError}</p>}

      <div className={s.gallery} role="list">
        {list.map((t) => {
          const broken = t.source === 'user' && !!t.errors?.length && !t.preview.length;
          return (
            <div key={t.id} role="listitem">
              <button
                type="button"
                className={`${s.themeCard} ${selectedIds.includes(t.id) ? s.themeCardActive : ''}`}
                aria-pressed={selectedIds.includes(t.id)}
                disabled={broken}
                title={t.file ?? t.name}
                onClick={() => void pick(t)}
              >
                <span className={s.swatches} aria-hidden>
                  {(t.preview.length ? t.preview : ['#888']).map((c, i) => (
                    <span key={i} style={{ background: c }} />
                  ))}
                </span>
                <span className={s.themeName}>
                  <span>{t.name}</span>
                  <span className={s.badge}>
                    {t.source === 'builtin' ? 'built-in' : 'custom'} · {t.scheme}
                  </span>
                </span>
              </button>
              {t.errors && t.errors.length > 0 && (
                <ul className={s.themeErrors}>
                  {t.errors.slice(0, 5).map((e, i) => (
                    <li key={i}>
                      {e.line ? `${e.line}:${e.column ?? 1} ` : ''}
                      {e.key ? `${e.key}: ` : ''}
                      {e.message}
                    </li>
                  ))}
                  {t.errors.length > 5 && <li>…and {t.errors.length - 5} more</li>}
                </ul>
              )}
            </div>
          );
        })}
      </div>
      <p className={s.rowDesc}>
        Custom themes are <code>.jsonc</code> files in the themes folder, shared by all profiles. Start from{' '}
        <code>dark.jsonc-default</code> or “Create theme from current”. Values support{' '}
        <code>var(--token)</code>, CSS colour functions and LESS functions such as <code>lighten()</code>,{' '}
        <code>darken()</code>, <code>fade()</code> and <code>mix()</code>.
      </p>
    </>
  );
}
