import { create } from 'zustand';

import type { KeybindingOverride } from '../../../shared/settings/keybindings';
import { prefsInvoke, prefsOn } from '../stores/settings';
import {
  bindingsFor,
  DEFAULT_KEYBINDINGS,
  formatChord,
  resolveKeybindings,
  type ResolvedKeybinding,
} from './keybindings';

export const isMacPlatform = (): boolean => window.api.platform === 'darwin';

interface KeybindingsState {
  loaded: boolean;
  overrides: KeybindingOverride[];
  resolved: ResolvedKeybinding[];
  /** True while a KeyChordRecorder is capturing keys; the dispatcher stands down. */
  recording: boolean;
  hydrate(): Promise<void>;
  /** Persist a full override list (per profile, `profiles/<id>/keybindings.json`). */
  save(overrides: KeybindingOverride[]): Promise<void>;
  setRecording(on: boolean): void;
}

const resolve = (overrides: KeybindingOverride[]): ResolvedKeybinding[] =>
  resolveKeybindings(DEFAULT_KEYBINDINGS, overrides, isMacPlatform());

/** Keybinding service state (spec 13 §7 step 9): defaults + user overrides, resolved for this platform. */
export const useKeybindingsStore = create<KeybindingsState>((set) => ({
  loaded: false,
  overrides: [],
  resolved: resolve([]),
  recording: false,
  async hydrate() {
    try {
      const overrides = await prefsInvoke('keybindings:get', {});
      set({ loaded: true, overrides, resolved: resolve(overrides) });
    } catch (e) {
      console.warn('[keybindings] using defaults:', e);
      set({ loaded: true });
    }
  },
  async save(overrides) {
    const saved = await prefsInvoke('keybindings:set', { overrides });
    set({ overrides: saved, resolved: resolve(saved) });
  },
  setRecording(on) {
    set({ recording: on });
  },
}));

prefsOn('keybindings:changed', (overrides) =>
  useKeybindingsStore.setState({ overrides, resolved: resolve(overrides) }),
);

/** Label of a command's primary binding for the current platform, e.g. `Ctrl+B` (for menus / palette). */
export function keybindingLabel(command: string): string | undefined {
  const b = bindingsFor(useKeybindingsStore.getState().resolved, command)[0];
  return b ? formatChord(b.key, isMacPlatform()) : undefined;
}

/** React hook variant of `keybindingLabel` (re-renders when bindings change). */
export function useKeybindingLabel(command: string): string | undefined {
  return useKeybindingsStore((s) => {
    const b = bindingsFor(s.resolved, command)[0];
    return b ? formatChord(b.key, isMacPlatform()) : undefined;
  });
}
