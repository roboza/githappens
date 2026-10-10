import type { RepoId } from '@githappens/git/types';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import type { IntegrationsEventContract } from '../../../shared/ipc/integrations-contract';
import { intOn } from './api';
import type { PrPreset } from './helpers';

type OAuthProgress = IntegrationsEventContract['auth:oauthProgress'];
type RateLimit = IntegrationsEventContract['provider:rateLimit'];

/** Latest OAuth progress per flow (events may arrive before `auth:startOAuth` resolves). */
export const useOAuthProgressStore = create<{ flows: Record<string, OAuthProgress> }>(() => ({ flows: {} }));

/** Latest rate-limit snapshot per account (spec 10 §4.1 RateLimitIndicator). */
export const useRateLimitStore = create<{ limits: Record<string, RateLimit> }>(() => ({ limits: {} }));

let installed = false;
/** Module-level listeners that don't need the query client. Idempotent. */
export function installIntegrationEventStores(): void {
  if (installed || typeof window === 'undefined' || !window.api) return;
  installed = true;
  intOn('auth:oauthProgress', (p) =>
    useOAuthProgressStore.setState((s) => ({ flows: { ...s.flows, [p.flowId]: p } })),
  );
  intOn('provider:rateLimit', (p) =>
    useRateLimitStore.setState((s) => ({ limits: { ...s.limits, [p.integrationKey]: p } })),
  );
}

export interface IssueSelection {
  integrationKey?: string;
  scope?: string;
  preset: 'assigned' | 'created' | 'mentioned' | 'all-open';
}

interface IntegrationPrefs {
  prPreset: Record<RepoId, PrPreset>;
  issues: Record<RepoId, IssueSelection>;
  setPrPreset(repoId: RepoId, preset: PrPreset): void;
  setIssues(repoId: RepoId, patch: Partial<IssueSelection>): void;
}

const safeStorage = createJSONStorage(() => {
  try {
    return window.localStorage;
  } catch {
    const mem = new Map<string, string>();
    return {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
    };
  }
});

/** Per-repo UI choices for PR/issue sections, remembered across sessions. */
export const useIntegrationPrefs = create<IntegrationPrefs>()(
  persist(
    (set) => ({
      prPreset: {},
      issues: {},
      setPrPreset: (repoId, preset) => set((s) => ({ prPreset: { ...s.prPreset, [repoId]: preset } })),
      setIssues: (repoId, patch) =>
        set((s) => ({
          issues: { ...s.issues, [repoId]: { preset: 'assigned', ...s.issues[repoId], ...patch } },
        })),
    }),
    {
      name: 'kl.integrations.prefs',
      storage: safeStorage,
      partialize: (s) => ({ prPreset: s.prPreset, issues: s.issues }),
    },
  ),
);
