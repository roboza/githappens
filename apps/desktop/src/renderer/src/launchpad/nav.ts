import type { LaunchpadGroup, LaunchpadTab } from '@githappens/launchpad';
import { create } from 'zustand';

/**
 * Navigation requests into the Launchpad view (status-bar click, "See all", workspace button):
 * the view applies them when `nonce` changes.
 */
export interface LaunchpadNavRequest {
  tab?: LaunchpadTab;
  group?: LaunchpadGroup;
  workspaceId?: string;
  mode?: 'personal' | 'team';
}

interface LaunchpadNavState {
  request: LaunchpadNavRequest | null;
  nonce: number;
  go(req: LaunchpadNavRequest): void;
  /** Mark the pending request handled (so a remounted view doesn't re-apply it). */
  consume(): void;
}

export const useLaunchpadNav = create<LaunchpadNavState>((set) => ({
  request: null,
  nonce: 0,
  go: (request) => set((s) => ({ request, nonce: s.nonce + 1 })),
  consume: () => set({ request: null }),
}));
