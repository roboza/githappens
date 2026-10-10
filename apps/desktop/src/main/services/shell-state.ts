import path from 'node:path';

import { DEFAULT_LAYOUT, type LayoutState, type TabsState } from '../../shared/ipc/shell-contract';
import { readJson, writeFileAtomic } from '../settings/atomic-file';

/** Persists open tabs and panel layout per profile (spec 01 §5, spec 13 §5.1). */
export class ShellStateStore {
  constructor(
    private readonly profileDir: string,
    /** `general.rememberTabs`: when false, repository tabs are not restored (other tabs still are). */
    private readonly rememberTabs: () => boolean = () => true,
  ) {}

  private get tabsFile(): string {
    return path.join(this.profileDir, 'tabs.json');
  }
  private get layoutFile(): string {
    return path.join(this.profileDir, 'layout.json');
  }

  tabs(): TabsState {
    const r = readJson<TabsState>(this.tabsFile);
    if (r.kind !== 'ok' || !Array.isArray(r.value?.tabs)) return { tabs: [], activeTabId: null };
    const remember = this.rememberTabs();
    const tabs = r.value.tabs.filter(
      (t) => typeof t?.id === 'string' && typeof t.kind === 'string' && (remember || t.kind !== 'repo'),
    );
    const activeTabId = tabs.some((t) => t.id === r.value.activeTabId)
      ? r.value.activeTabId
      : (tabs[0]?.id ?? null);
    return { tabs, activeTabId };
  }

  saveTabs(s: TabsState): void {
    writeFileAtomic(this.tabsFile, `${JSON.stringify(s, null, 2)}\n`);
  }

  layout(): LayoutState {
    const r = readJson<Partial<LayoutState>>(this.layoutFile);
    return r.kind === 'ok' && r.value ? { ...DEFAULT_LAYOUT, ...r.value } : { ...DEFAULT_LAYOUT };
  }

  saveLayout(l: LayoutState): void {
    writeFileAtomic(this.layoutFile, `${JSON.stringify(l, null, 2)}\n`);
  }
}
