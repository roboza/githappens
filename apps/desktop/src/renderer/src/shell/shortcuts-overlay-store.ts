import { create } from 'zustand';

/** Visibility of the Keyboard Shortcuts overlay (spec 01 §4.9 `view.shortcuts`, Ctrl/Cmd+/). */
export const useShortcutsOverlay = create<{ open: boolean; toggle(): void; close(): void }>((set) => ({
  open: false,
  toggle: () => set((s) => ({ open: !s.open })),
  close: () => set({ open: false }),
}));
