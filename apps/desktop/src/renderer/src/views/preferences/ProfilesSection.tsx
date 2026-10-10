import { Check, Copy, Plus, Star, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { ProfileMeta } from '../../../../shared/ipc/app-contract';
import { IpcError } from '../../lib/api';
import { authorInitials } from '../../lib/format';
import { prefsInvoke, useSettingsStore } from '../../stores/settings';
import { confirmAndSwitchProfile } from './ProfileSwitchMenu';
import s from './PreferencesView.module.css';

const errorText = (e: unknown): string =>
  e instanceof IpcError ? e.error.message : e instanceof Error ? e.message : String(e);

function ProfileAvatar({ p }: { p: Pick<ProfileMeta, 'name' | 'authorName' | 'authorEmail'> }) {
  const a = authorInitials(p.authorName || p.name, p.authorEmail || p.name);
  return (
    <span className={s.avatar} style={{ background: a.color }} aria-hidden>
      {a.text}
    </span>
  );
}

/** Profiles section (spec 13 §4.2 Profiles, §4.3): list, edit identity, add / duplicate / delete / switch. */
export function ProfilesSection() {
  const state = useSettingsStore((st) => st.profiles);
  const loadProfiles = useSettingsStore((st) => st.loadProfiles);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    loadProfiles().catch((e: unknown) => setLoadError(errorText(e)));
  }, [loadProfiles]);

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      setError(null);
      await fn();
    } catch (e) {
      setError(errorText(e));
    }
  };

  if (loadError) {
    return (
      <p className={s.error} role="alert">
        Profiles are unavailable: {loadError}
      </p>
    );
  }
  if (!state) return <p className={s.muted}>Loading profiles…</p>;

  const selected =
    state.profiles.find((p) => p.id === selectedId) ?? state.profiles.find((p) => p.id === state.activeId);

  const uniqueName = (base: string): string => {
    const names = new Set(state.profiles.map((p) => p.name.toLowerCase()));
    if (!names.has(base.toLowerCase())) return base;
    for (let i = 2; ; i++) if (!names.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
  };

  return (
    <>
      <p className={s.intro}>
        Each profile has its own Git identity, settings, keybindings, open tabs, repository list and
        integrations. Switching reloads the window.
      </p>
      <div className={s.toolbar}>
        <button
          type="button"
          onClick={() =>
            void run(async () => {
              const p = await prefsInvoke('profiles:create', { name: uniqueName('New Profile') });
              setSelectedId(p.id);
            })
          }
        >
          <Plus size={14} /> Add profile
        </button>
        {selected && (
          <button
            type="button"
            onClick={() =>
              void run(async () => {
                const p = await prefsInvoke('profiles:create', {
                  name: uniqueName(`${selected.name} copy`),
                  duplicateFrom: selected.id,
                });
                setSelectedId(p.id);
              })
            }
          >
            <Copy size={14} /> Duplicate
          </button>
        )}
      </div>
      {error && (
        <p className={s.error} role="alert">
          {error}
        </p>
      )}
      <div className={s.profiles}>
        <ul className={s.profileList} aria-label="Profiles">
          {state.profiles.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className={`${s.profileItem} ${p.id === selected?.id ? s.profileItemSelected : ''}`}
                aria-current={p.id === selected?.id}
                onClick={() => setSelectedId(p.id)}
              >
                <ProfileAvatar p={p} />
                <span className={s.profileMeta}>
                  <span>
                    {p.name} {p.id === state.activeId && <span className={s.badgeAccent}>active</span>}{' '}
                    {p.id === state.defaultId && <span className={s.badge}>default</span>}
                  </span>
                  <span>{p.authorEmail || 'No email set'}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        {selected && (
          <ProfileForm
            key={`${selected.id}:${selected.name}:${selected.authorName}:${selected.authorEmail}:${selected.syncGitConfig}`}
            profile={selected}
            isActive={selected.id === state.activeId}
            isDefault={selected.id === state.defaultId}
            canDelete={state.profiles.length > 1 && selected.id !== state.activeId}
            run={run}
          />
        )}
      </div>
    </>
  );
}

function ProfileForm({
  profile,
  isActive,
  isDefault,
  canDelete,
  run,
}: {
  profile: ProfileMeta;
  isActive: boolean;
  isDefault: boolean;
  canDelete: boolean;
  run(fn: () => Promise<unknown>): Promise<void>;
}) {
  const [name, setName] = useState(profile.name);
  const [authorName, setAuthorName] = useState(profile.authorName);
  const [authorEmail, setAuthorEmail] = useState(profile.authorEmail);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const dirty =
    name !== profile.name || authorName !== profile.authorName || authorEmail !== profile.authorEmail;

  const save = (): Promise<void> =>
    run(() => prefsInvoke('profiles:update', { id: profile.id, patch: { name, authorName, authorEmail } }));

  return (
    <form
      className={s.group}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className={s.form}>
        <label htmlFor="profile-name">Profile name</label>
        <input id="profile-name" type="text" value={name} onChange={(e) => setName(e.target.value)} />
        <label htmlFor="profile-author">Author name</label>
        <input
          id="profile-author"
          type="text"
          value={authorName}
          placeholder="Ada Lovelace"
          onChange={(e) => setAuthorName(e.target.value)}
        />
        <label htmlFor="profile-email">Author email</label>
        <input
          id="profile-email"
          type="text"
          value={authorEmail}
          placeholder="ada@example.com"
          onChange={(e) => setAuthorEmail(e.target.value)}
        />
        <label htmlFor="profile-sync">Keep global .gitconfig updated</label>
        <span className={s.control}>
          <input
            id="profile-sync"
            type="checkbox"
            role="switch"
            className={s.toggle}
            checked={profile.syncGitConfig}
            onChange={(e) =>
              void run(() =>
                prefsInvoke('profiles:update', {
                  id: profile.id,
                  patch: { syncGitConfig: e.target.checked },
                }),
              )
            }
          />
          <span className={s.badgeAccent}>writes ~/.gitconfig user.name / user.email</span>
        </span>
      </div>
      <p className={s.rowDesc}>
        Without sync, commits made in GitHappens still use this identity; your global git config is left
        untouched.
      </p>
      <div className={s.toolbar} style={{ marginTop: 12 }}>
        <button type="submit" className="primary" disabled={!dirty}>
          Save
        </button>
        {!isActive && (
          <button type="button" onClick={() => void run(() => confirmAndSwitchProfile(profile.id))}>
            <Check size={14} /> Switch to this profile
          </button>
        )}
        {!isDefault && (
          <button
            type="button"
            onClick={() => void run(() => prefsInvoke('profiles:setDefault', { id: profile.id }))}
          >
            <Star size={14} /> Open on startup
          </button>
        )}
        <span className={s.spacer} />
        {canDelete &&
          (confirmDelete ? (
            <>
              <span className={s.danger}>Delete “{profile.name}” and its saved credentials?</span>
              <button
                type="button"
                className={s.danger}
                onClick={() => void run(() => prefsInvoke('profiles:delete', { id: profile.id }))}
              >
                Delete
              </button>
              <button type="button" onClick={() => setConfirmDelete(false)}>
                Cancel
              </button>
            </>
          ) : (
            <button type="button" onClick={() => setConfirmDelete(true)}>
              <Trash2 size={14} /> Delete…
            </button>
          ))}
      </div>
      {!canDelete && (
        <p className={s.rowDesc}>
          {isActive ? 'The active profile cannot be deleted.' : 'The last profile cannot be deleted.'}
        </p>
      )}
    </form>
  );
}
