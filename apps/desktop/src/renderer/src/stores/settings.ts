import type { IpcResult } from '@githappens/git/types';
import { create } from 'zustand';

import type { ProfileMeta } from '../../../shared/ipc/app-contract';
import type {
  PrefsEventContract,
  PrefsIpcContract,
  ProfilesListResult,
} from '../../../shared/ipc/prefs-contract';
import type {
  SettingDescriptor,
  SettingKey,
  SettingsValues,
  SettingValue,
} from '../../../shared/settings/registry';
import { invoke, IpcError, on } from '../lib/api';

// ---- Preferences IPC (spec 13 §5.4) -------------------------------------------------------------------
// The prefs channels live in `prefs-contract.ts` and are merged into the main contract by main/index;
// these wrappers keep renderer code typed against the prefs contract either way.

type LooseInvoke = (channel: string, req: unknown) => Promise<IpcResult<unknown>>;
type LooseOn = (event: string, cb: (payload: unknown) => void) => () => void;

export async function prefsInvoke<C extends keyof PrefsIpcContract>(
  channel: C,
  req: PrefsIpcContract[C]['req'],
): Promise<PrefsIpcContract[C]['res']> {
  const r = await (window.api.invoke as unknown as LooseInvoke)(channel, req);
  if (r.ok) return r.data as PrefsIpcContract[C]['res'];
  throw new IpcError(r.error);
}

export function prefsOn<E extends keyof PrefsEventContract>(
  event: E,
  cb: (payload: PrefsEventContract[E]) => void,
): () => void {
  try {
    return (window.api.on as unknown as LooseOn)(event, cb as (p: unknown) => void);
  } catch (e) {
    // Channel not allowlisted by this preload build (prefs contract not merged yet).
    console.warn(`[prefs] cannot subscribe to ${event}:`, e);
    return () => undefined;
  }
}

// ---- settings store -----------------------------------------------------------------------------------

interface SettingsState {
  ready: boolean;
  values: SettingsValues | null;
  profile: ProfileMeta | null;
  registry: SettingDescriptor[];
  /** All profiles (loaded lazily by the Profiles section / profile menu). */
  profiles: ProfilesListResult | null;
  hydrate(): Promise<void>;
  set<K extends SettingKey>(key: K, value: SettingValue<K>): Promise<void>;
  reset(key?: SettingKey): Promise<void>;
  loadProfiles(): Promise<ProfilesListResult>;
}

/** Renderer settings store (spec 13 §7 step 3): hydrated once, kept live by `settings:changed`. */
export const useSettingsStore = create<SettingsState>((set) => ({
  ready: false,
  values: null,
  profile: null,
  registry: [],
  profiles: null,
  async hydrate() {
    const snap = await invoke('settings:getAll', {});
    set({ ready: true, values: snap.values, profile: snap.profile, registry: snap.registry });
  },
  async set(key, value) {
    await invoke('settings:set', { key, value });
  },
  async reset(key) {
    await invoke('settings:reset', key ? { key } : {});
  },
  async loadProfiles() {
    const profiles = await prefsInvoke('profiles:list', {});
    set((s) => ({
      profiles,
      profile: profiles.profiles.find((p) => p.id === profiles.activeId) ?? s.profile,
    }));
    return profiles;
  },
}));

on('settings:changed', ({ key, value }) => {
  useSettingsStore.setState((s) =>
    s.values ? { values: { ...s.values, [key]: value } as SettingsValues } : s,
  );
});

prefsOn('profiles:changed', (profiles) => {
  useSettingsStore.setState((s) => ({
    profiles,
    profile: profiles.profiles.find((p) => p.id === profiles.activeId) ?? s.profile,
  }));
});

/**
 * After a profile switch every per-profile store (tabs, repos, layout, query caches) must reload.
 * Reloading the window is the simplest way to guarantee no state leaks between profiles.
 */
prefsOn('profiles:switched', () => {
  window.location.reload();
});

export function useSetting<K extends SettingKey>(key: K): SettingValue<K> | undefined {
  return useSettingsStore((s) => s.values?.[key]);
}

/** Switch the active profile (spec 13 §4.3); the window reloads when main confirms. */
export async function switchProfile(id: string): Promise<void> {
  await prefsInvoke('profiles:switch', { id });
}
