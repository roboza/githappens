import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { getCommand, registerCommands, runCommand, type CommandDef, type KeybindingHint } from '../commands';
import {
  defaultBindingsFor,
  eventToChord,
  findMatches,
  formatChord,
  isDeferredCommand,
} from '../commands/keybindings';
import { useKeybindingsStore } from '../commands/keybindings-store';
import { usePaletteStore } from '../components/CommandPalette';
import { useSettingsStore } from '../stores/settings';
import { useTabsStore } from '../stores/tabs';
import { useMenuBridge } from './menu-bridge';
import { installWindowStateListener } from './window-state';

const isTextTarget = (t: EventTarget | null): boolean =>
  t instanceof HTMLElement &&
  (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || !!t.closest('.monaco-editor'));

/** Zoom presets (spec 01 §4.12). */
const ZOOM_STEPS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.5, 1.75, 2, 2.5, 3];

function stepZoom(dir: 1 | -1 | 0): void {
  const st = useSettingsStore.getState();
  const cur = st.values?.['ui.zoom'] ?? 1;
  const next =
    dir === 0
      ? 1
      : dir > 0
        ? (ZOOM_STEPS.find((z) => z > cur + 1e-6) ?? cur)
        : ([...ZOOM_STEPS].reverse().find((z) => z < cur - 1e-6) ?? cur);
  if (next !== cur) void st.set('ui.zoom', next);
}

function hint(id: string): KeybindingHint | undefined {
  const win = defaultBindingsFor(id, false)[0];
  const mac = defaultBindingsFor(id, true)[0];
  return win && mac ? { win: formatChord(win.key, false), mac: formatChord(mac.key, true) } : undefined;
}

const emit = (name: string, detail?: unknown): void => {
  window.dispatchEvent(new CustomEvent(name, detail === undefined ? undefined : { detail }));
};

/** Shell commands that exist so every shortcut is a rebindable command (spec 01 §4.9 ids). */
function shellCommands(actions: { openPreferences(): void; openRepo(): void }): CommandDef[] {
  const switchTab = (delta: number): void => {
    const tabs = useTabsStore.getState();
    const n = tabs.tabs.length;
    if (!n) return;
    const i = tabs.tabs.findIndex((t) => t.id === tabs.activeTabId);
    const next = tabs.tabs[(i + delta + n) % n];
    if (next) tabs.activate(next.id);
  };
  const defs: CommandDef[] = [
    {
      id: 'palette.toggle',
      title: 'Command Palette',
      category: 'View',
      run: () => usePaletteStore.getState().toggle(),
    },
    {
      id: 'repo.openFolder',
      title: 'Open Repo Folder…',
      category: 'Repo',
      run: () => actions.openRepo(),
    },
    { id: 'tab.next', title: 'Next Tab', category: 'View', run: () => switchTab(1) },
    { id: 'tab.prev', title: 'Previous Tab', category: 'View', run: () => switchTab(-1) },
    ...Array.from({ length: 9 }, (_, i): CommandDef => ({
      id: `tab.goto.${i + 1}`,
      title: `Go to Tab ${i + 1}`,
      category: 'View',
      run: () => {
        const tabs = useTabsStore.getState();
        const t = tabs.tabs[i];
        if (t) tabs.activate(t.id);
      },
    })),
    {
      id: 'graph.focusSearch',
      title: 'Focus Graph Search',
      category: 'History',
      run: () => emit('kl:focus-graph-search'),
    },
    {
      id: 'leftPanel.focusFilter',
      title: 'Focus Left Panel Filter',
      category: 'View',
      run: () => document.querySelector<HTMLInputElement>('[data-left-filter]')?.focus(),
    },
    {
      id: 'wip.commit',
      title: 'Commit Staged Changes',
      category: 'File',
      run: () => emit('kl:commit', { stageAll: false }),
    },
    {
      id: 'wip.stageAllCommit',
      title: 'Stage All and Commit',
      category: 'File',
      run: () => emit('kl:commit', { stageAll: true }),
    },
    {
      id: 'wip.focusMessage',
      title: 'Focus Commit Message',
      category: 'File',
      run: () => emit('kl:focus-commit-message'),
    },
    { id: 'view.zoomIn', title: 'Zoom In', category: 'View', run: () => stepZoom(1) },
    { id: 'view.zoomOut', title: 'Zoom Out', category: 'View', run: () => stepZoom(-1) },
    { id: 'view.zoomReset', title: 'Reset Zoom', category: 'View', run: () => stepZoom(0) },
  ];
  return defs.map((d) => {
    const h = hint(d.id);
    return h ? { ...d, keybinding: h } : d;
  });
}

/**
 * Global keyboard dispatcher (spec 01 §4.9, spec 13 §7 step 9). Key chords resolve through the
 * keybinding service (defaults + per-profile overrides) to command ids run via `runCommand`.
 * Bindings marked `!textInputFocus` (undo/redo, Ctrl+F, Ctrl+Enter) and bare keys do not fire
 * while typing in inputs or Monaco. Disabled while a KeyChordRecorder is capturing.
 */
export function useShortcuts(actions: { openPreferences(): void; openRepo(): void }): void {
  useEffect(() => registerCommands(shellCommands(actions)), [actions]);
  useMenuBridge(useQueryClient());
  useEffect(() => installWindowStateListener(), []);

  useEffect(() => {
    void useKeybindingsStore.getState().hydrate();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.isComposing) return;
      const kb = useKeybindingsStore.getState();
      if (kb.recording) return;
      const chord = eventToChord(e);
      if (!chord) return;
      const matches = findMatches(kb.resolved, chord, { textInputFocus: isTextTarget(e.target) });
      const hit = matches.find((m) => getCommand(m.command));
      if (!hit) return;
      const run = (): void => {
        runCommand(hit.command).catch((err: unknown) => console.error(`[keybindings] ${hit.command}`, err));
      };
      if (isDeferredCommand(hit.command)) {
        // Let view-local handlers (diff Esc / Ctrl+Alt+1..3, merge tool…) claim the key first.
        // …and never while a modal / dialog owns the keyboard (its Esc closes it, not the view behind).
        if (e.defaultPrevented || document.querySelector('dialog[open], [aria-modal="true"]')) return;
        setTimeout(() => {
          if (!e.defaultPrevented) run();
        }, 0);
        return;
      }
      e.preventDefault();
      run();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
