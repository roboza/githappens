import { create } from 'zustand';

import type { TabDescriptor, TabsState } from '../../../shared/ipc/shell-contract';
import { useLaunchpadNav, type LaunchpadNavRequest } from '../launchpad/nav';
import { invoke, IpcError } from '../lib/api';
import { useToastStore } from './toasts';

interface TabsStore extends TabsState {
  hydrated: boolean;
  hydrate(state: TabsState): void;
  newTab(): string;
  activate(id: string): void;
  close(id: string): void;
  closeOthers(id: string): void;
  /** Close several tabs at once (context menu "Close tabs to the right", spec 01 §4.2). */
  closeMany(ids: string[]): void;
  /** Set (or with an empty/undefined alias remove) a tab's display name; repo aliases persist in recents. */
  setAlias(id: string, alias: string | undefined): void;
  /** Open a second tab for the same repository (context menu "Duplicate tab"). */
  duplicate(id: string): string | null;
  /** Point a tab whose repository moved at its new location ("Repository not found" → Locate…). */
  relocate(id: string, path: string): Promise<boolean>;
  move(id: string, toIndex: number): void;
  /** Open a repo (validates + records in recents); reuses an existing tab for the same path. */
  openRepo(path: string): Promise<boolean>;
  /** Activate the pinned Launchpad tab, optionally at a view tab / group (spec 11 §4.2–4.3). */
  openLaunchpad(opts?: LaunchpadNavRequest): void;
}

export const LAUNCHPAD_TAB_ID = 'launchpad';
const launchpadTab = (): TabDescriptor => ({ id: LAUNCHPAD_TAB_ID, kind: 'launchpad' });
export const isPinnedTab = (t: Pick<TabDescriptor, 'kind'>): boolean => t.kind === 'launchpad';

/**
 * The Launchpad tab is pinned leftmost and can't be closed (spec 11 §4.2): exactly one, at index 0,
 * plus at least one regular tab.
 */
export function normalizeTabs(tabs: TabDescriptor[]): TabDescriptor[] {
  const lp = tabs.find(isPinnedTab);
  const rest = tabs.filter((t) => !isPinnedTab(t));
  if (rest.length === 0) rest.push({ id: uid(), kind: 'newTab' });
  return [lp ? { ...lp, id: lp.id || LAUNCHPAD_TAB_ID } : launchpadTab(), ...rest];
}

const uid = (): string => crypto.randomUUID();
const samePath = (a?: string, b?: string): boolean =>
  !!a && !!b && a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();

export const useTabsStore = create<TabsStore>((set, get) => ({
  tabs: [],
  activeTabId: null,
  hydrated: false,

  hydrate(state) {
    const tabs = normalizeTabs(state.tabs);
    const active = tabs.some((t) => t.id === state.activeTabId)
      ? state.activeTabId!
      : (tabs.find((t) => !isPinnedTab(t)) ?? tabs[0]!).id;
    set({ tabs, activeTabId: active, hydrated: true });
  },

  newTab() {
    const tab: TabDescriptor = { id: uid(), kind: 'newTab' };
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }));
    return tab.id;
  },

  activate(id) {
    if (get().tabs.some((t) => t.id === id)) set({ activeTabId: id });
  },

  close(id) {
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id);
      if (idx < 0 || isPinnedTab(s.tabs[idx]!)) return s;
      const tabs = s.tabs.filter((t) => t.id !== id);
      if (!tabs.some((t) => !isPinnedTab(t))) {
        const fresh: TabDescriptor = { id: uid(), kind: 'newTab' };
        return { tabs: [...tabs, fresh], activeTabId: fresh.id };
      }
      const activeTabId =
        s.activeTabId === id ? (tabs[Math.min(idx, tabs.length - 1)]?.id ?? null) : s.activeTabId;
      return { tabs, activeTabId };
    });
  },

  closeOthers(id) {
    set((s) => {
      const keep = s.tabs.filter((t) => t.id === id || isPinnedTab(t));
      return { tabs: normalizeTabs(keep), activeTabId: id };
    });
  },

  closeMany(ids) {
    const drop = new Set(ids);
    set((s) => {
      const tabs = s.tabs.filter((t) => isPinnedTab(t) || !drop.has(t.id));
      const normalized = normalizeTabs(tabs);
      const activeTabId = normalized.some((t) => t.id === s.activeTabId)
        ? s.activeTabId
        : (normalized.find((t) => !isPinnedTab(t)) ?? normalized[0]!).id;
      return { tabs: normalized, activeTabId };
    });
  },

  setAlias(id, alias) {
    const a = alias?.trim() || undefined;
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab) return;
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== id) return t;
        const next = { ...t, alias: a };
        if (!a) delete next.alias;
        return next;
      }),
    }));
    if (tab.kind === 'repo' && tab.repoPath) {
      // Best effort: older mains do not know the channel yet.
      void (window.api.invoke as unknown as (c: string, r: unknown) => Promise<unknown>)('repos:setAlias', {
        path: tab.repoPath,
        alias: a ?? null,
      }).catch(() => undefined);
    }
  },

  duplicate(id) {
    const { tabs } = get();
    const i = tabs.findIndex((t) => t.id === id);
    const src = tabs[i];
    if (!src || isPinnedTab(src)) return null;
    const copy: TabDescriptor = { ...src, id: uid() };
    set({ tabs: [...tabs.slice(0, i + 1), copy, ...tabs.slice(i + 1)], activeTabId: copy.id });
    return copy.id;
  },

  async relocate(id, path) {
    let result;
    try {
      result = await invoke('repos:open', { path });
    } catch (e) {
      const msg = e instanceof IpcError ? e.error.message : (e as Error).message;
      useToastStore.getState().push({ kind: 'error', title: 'Could not open repository', body: msg });
      return false;
    }
    if (!result.ok) {
      useToastStore.getState().push({ kind: 'error', title: 'Not a repository', body: result.message });
      return false;
    }
    const repo = result.repo;
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === id
          ? {
              ...t,
              kind: 'repo' as const,
              repoPath: repo.path,
              worktreeOf: repo.commonDir,
              alias: t.alias ?? repo.alias,
            }
          : t,
      ),
      activeTabId: id,
    }));
    return true;
  },

  move(id, toIndex) {
    set((s) => {
      const tabs = [...s.tabs];
      const from = tabs.findIndex((t) => t.id === id);
      if (from < 0 || isPinnedTab(tabs[from]!)) return s;
      const [tab] = tabs.splice(from, 1);
      const pinned = tabs.filter(isPinnedTab).length;
      tabs.splice(Math.max(pinned, Math.min(toIndex, tabs.length)), 0, tab!);
      return { tabs };
    });
  },

  async openRepo(path) {
    let result;
    try {
      result = await invoke('repos:open', { path });
    } catch (e) {
      const msg = e instanceof IpcError ? e.error.message : (e as Error).message;
      useToastStore.getState().push({ kind: 'error', title: 'Could not open repository', body: msg });
      return false;
    }
    if (!result.ok) {
      useToastStore
        .getState()
        .push({ kind: 'error', title: 'Could not open repository', body: result.message });
      return false;
    }
    const repo = result.repo;
    const { tabs, activeTabId } = get();
    const existing = tabs.find((t) => t.kind === 'repo' && samePath(t.repoPath, repo.path));
    if (existing) {
      set({ activeTabId: existing.id });
      return true;
    }
    const tab: TabDescriptor = { id: uid(), kind: 'repo', repoPath: repo.path, worktreeOf: repo.commonDir };
    if (repo.alias) tab.alias = repo.alias;
    const active = tabs.find((t) => t.id === activeTabId);
    if (active && active.kind === 'newTab') {
      // The New Tab page turns into the repo tab (spec 03).
      set({
        tabs: tabs.map((t) => (t.id === active.id ? { ...tab, id: active.id } : t)),
        activeTabId: active.id,
      });
    } else {
      set({ tabs: [...tabs, tab], activeTabId: tab.id });
    }
    return true;
  },

  openLaunchpad(opts) {
    const { tabs } = get();
    let lp = tabs.find(isPinnedTab);
    if (!lp) {
      lp = launchpadTab();
      set({ tabs: normalizeTabs([lp, ...tabs]) });
    }
    set({ activeTabId: lp.id });
    if (opts) useLaunchpadNav.getState().go(opts);
  },
}));

// Persist (debounced 500 ms, spec 01 `shell:saveTabs`).
let saveTimer: ReturnType<typeof setTimeout> | null = null;
useTabsStore.subscribe((s, prev) => {
  if (!s.hydrated || (s.tabs === prev.tabs && s.activeTabId === prev.activeTabId)) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const { tabs, activeTabId } = useTabsStore.getState();
    void invoke('shell:saveTabs', { tabs, activeTabId });
  }, 500);
});
