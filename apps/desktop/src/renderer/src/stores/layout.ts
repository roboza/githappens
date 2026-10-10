import { create } from 'zustand';

import { DEFAULT_LAYOUT, type LayoutState } from '../../../shared/ipc/shell-contract';
import { invoke } from '../lib/api';

interface LayoutStore extends LayoutState {
  hydrated: boolean;
  hydrate(l: LayoutState): void;
  patch(p: Partial<LayoutState>): void;
  toggleLeft(): void;
  toggleRight(): void;
}

export const useLayoutStore = create<LayoutStore>((set) => ({
  ...DEFAULT_LAYOUT,
  hydrated: false,
  hydrate: (l) => set({ ...l, hydrated: true }),
  patch: (p) => set(p),
  toggleLeft: () => set((s) => ({ leftPanelCollapsed: !s.leftPanelCollapsed })),
  toggleRight: () => set((s) => ({ rightPanelCollapsed: !s.rightPanelCollapsed })),
}));

let timer: ReturnType<typeof setTimeout> | null = null;
useLayoutStore.subscribe((s) => {
  if (!s.hydrated) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    const {
      leftPanelWidth,
      leftPanelCollapsed,
      rightPanelWidth,
      rightPanelCollapsed,
      terminalHeight,
      terminalOpen,
    } = useLayoutStore.getState();
    void invoke('shell:saveLayout', {
      leftPanelWidth,
      leftPanelCollapsed,
      rightPanelWidth,
      rightPanelCollapsed,
      terminalHeight,
      terminalOpen,
    });
  }, 500);
});
