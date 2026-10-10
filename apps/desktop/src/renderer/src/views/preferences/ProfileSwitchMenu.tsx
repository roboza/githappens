import { Check, ChevronDown, Settings, UserRound } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { confirm } from '../../components/Dialogs';
import { IpcError } from '../../lib/api';
import { useOpsStore } from '../../stores/ops';
import { switchProfile, useSettingsStore } from '../../stores/settings';
import { useToastStore } from '../../stores/toasts';
import { usePrefsNavStore } from './prefs-nav';
import s from './PreferencesView.module.css';

/**
 * Switch profile with the spec 13 §4.3 guard: confirm when git operations are queued or running
 * (they keep their environment, but the window reloads into the other profile). Returns false when
 * the user cancelled.
 */
export async function confirmAndSwitchProfile(id: string): Promise<boolean> {
  const st = useSettingsStore.getState();
  if (st.profile?.id === id) return true;
  const running = Object.values(useOpsStore.getState().ops);
  if (running.length > 0) {
    const ok = await confirm(
      'Switch profile while operations run?',
      `${running.length} git operation${running.length === 1 ? ' is' : 's are'} still running (${running
        .slice(0, 3)
        .map((o) => o.label)
        .join(', ')}). They finish in the background, but this window reloads into the other profile.`,
      'Switch anyway',
    );
    if (!ok) return false;
  }
  try {
    await switchProfile(id);
    return true;
  } catch (e) {
    useToastStore.getState().push({
      kind: 'error',
      title: 'Could not switch profile',
      body: e instanceof IpcError ? e.error.message : e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}

/**
 * Profile entries for an account / avatar menu (spec 13 §4.3): one radio item per profile plus
 * "Manage Profiles…". `onDone` closes the hosting menu.
 */
export function ProfileSwitchMenuItems({
  onDone,
  itemClassName,
  openPreferences,
}: {
  onDone?(): void;
  itemClassName?: string;
  /** Opens the Preferences dialog (the host decides how); the section is pre-selected. */
  openPreferences?(): void;
}) {
  const profiles = useSettingsStore((st) => st.profiles);
  const active = useSettingsStore((st) => st.profile);
  const loadProfiles = useSettingsStore((st) => st.loadProfiles);
  useEffect(() => {
    if (!profiles) void loadProfiles().catch(() => undefined);
  }, [profiles, loadProfiles]);
  const list = profiles?.profiles ?? (active ? [active] : []);
  return (
    <>
      {list.map((p) => (
        <button
          key={p.id}
          type="button"
          role="menuitemradio"
          aria-checked={p.id === active?.id}
          className={itemClassName}
          title={p.authorEmail ? `${p.authorName} <${p.authorEmail}>` : p.name}
          onClick={() => {
            onDone?.();
            void confirmAndSwitchProfile(p.id);
          }}
        >
          <UserRound size={14} aria-hidden />
          <span style={{ flex: 1 }}>{p.name}</span>
          {p.id === active?.id && <Check size={14} aria-hidden />}
        </button>
      ))}
      {openPreferences && (
        <button
          type="button"
          role="menuitem"
          className={itemClassName}
          onClick={() => {
            onDone?.();
            usePrefsNavStore.getState().go('Profiles');
            openPreferences();
          }}
        >
          <Settings size={14} aria-hidden />
          <span>Manage Profiles…</span>
        </button>
      )}
    </>
  );
}

/**
 * Title-bar profile switcher: shown only when there is more than one profile (one profile needs no
 * switcher). Opens a small menu with `ProfileSwitchMenuItems`.
 */
export function ProfileMenuButton({ onOpenPreferences }: { onOpenPreferences(): void }) {
  const profiles = useSettingsStore((st) => st.profiles);
  const active = useSettingsStore((st) => st.profile);
  const loadProfiles = useSettingsStore((st) => st.loadProfiles);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!profiles) void loadProfiles().catch(() => undefined);
  }, [profiles, loadProfiles]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  if (!profiles || profiles.profiles.length < 2 || !active) return null;
  return (
    <div className={s.profileMenuAnchor} ref={ref}>
      <button
        type="button"
        className={s.profileMenuTrigger}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Profile: ${active.name}`}
        title="Switch profile"
        onClick={() => setOpen((o) => !o)}
        data-testid="profile-menu"
      >
        <UserRound size={14} aria-hidden />
        <span>{active.name}</span>
        <ChevronDown size={12} aria-hidden />
      </button>
      {open && (
        <div className={s.profileMenu} role="menu" aria-label="Profiles">
          <ProfileSwitchMenuItems
            itemClassName={s.profileMenuItem}
            onDone={() => setOpen(false)}
            openPreferences={onOpenPreferences}
          />
        </div>
      )}
    </div>
  );
}
