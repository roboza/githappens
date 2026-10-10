import type { StatusResult } from '@githappens/git/types';
import { useQueryClient } from '@tanstack/react-query';
import {
  ChevronDown,
  FolderGit2,
  Loader2,
  Plus,
  Rocket,
  Settings,
  TriangleAlert,
  WandSparkles,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';

import type { TabDescriptor } from '../../../shared/ipc/shell-contract';
import { useKeybindingLabel } from '../commands/keybindings-store';
import { BrandMark } from '../components/BrandLogo';
import { usePaletteStore } from '../components/CommandPalette';
import { useContextMenu, type MenuEntry } from '../components/ContextMenu';
import { invoke } from '../lib/api';
import { qk } from '../repo/queries';
import { useSession } from '../repo/sessions';
import { useOpsStore } from '../stores/ops';
import { useSetting } from '../stores/settings';
import { isPinnedTab, useTabsStore } from '../stores/tabs';
import { openInTerminal } from '../tools/actions';
import { AccountButton } from '../views/account/AccountButton';
import { ProfileMenuButton } from '../views/preferences/ProfileSwitchMenu';
import { UpdateDot, updateDotHost } from '../views/update/UpdateDot';
import { FilterDropdown } from './FilterDropdown';
import { isMissingRepoError } from './MissingRepo';
import { shellInvoke } from './shell2-api';
import { renameTab, requestCloseOthers, requestCloseTab } from './tab-actions';
import { arrangeTabs, hiddenTabIds, tabLabel, type TabView } from './tab-model';
import styles from './TitleBar.module.css';
import { useWindowState } from './window-state';

/** Live status of a repo tab: running op, dirty WIP, missing path, current branch (spec 01 §4.2). */
function useTabStatus(tab: TabDescriptor) {
  const qc = useQueryClient();
  const session = useSession(tab.repoPath);
  const repoId = session?.state === 'ready' ? session.repoId : undefined;
  const busy = useOpsStore((s) => !!repoId && Object.values(s.ops).some((o) => o.repoId === repoId));
  const subscribe = useCallback((cb: () => void) => qc.getQueryCache().subscribe(cb), [qc]);
  const status = useSyncExternalStore(subscribe, () =>
    repoId ? qc.getQueryData<StatusResult>(qk.status(repoId)) : undefined,
  );
  const dirty = !!status?.entries.some((e) => e.kind !== 'ignored');
  const missing = session?.state === 'error' && isMissingRepoError(session.code, session.message);
  const branch =
    session?.state === 'ready'
      ? session.info.head.kind === 'branch'
        ? session.info.head.name
        : 'detached HEAD'
      : undefined;
  return { busy, dirty, missing, branch };
}

function RepoTabContent({ tab }: { tab: TabDescriptor }) {
  const st = useTabStatus(tab);
  const label = tabLabel(tab);
  return (
    <>
      {tab.kind === 'repo' &&
        (st.busy ? (
          <Loader2 size={14} className={`${styles.icon} ${styles.spin}`} aria-label="Operation running" />
        ) : st.missing ? (
          <TriangleAlert size={14} className={styles.missingIcon} aria-label="Repository not found" />
        ) : (
          <FolderGit2 size={14} className={styles.icon} aria-hidden />
        ))}
      <span
        className={styles.label}
        title={tab.repoPath ? `${tab.repoPath}${st.branch ? `\n${st.branch}` : ''}` : label}
      >
        {label}
      </span>
      {st.dirty && <span className={styles.dirty} aria-label="Uncommitted changes" />}
    </>
  );
}

/** Title bar hosting the repo tab bar (spec 01 §4.2). The empty area drags the window. */
export function TitleBar({ onOpenPreferences }: { onOpenPreferences(): void }) {
  const { tabs, activeTabId, activate, newTab, move, duplicate, setAlias } = useTabsStore();
  const showMenu = useContextMenu((s) => s.show);
  const [dragId, setDragId] = useState<string | null>(null);
  const mac = window.api.platform === 'darwin';
  const fullscreen = useWindowState((s) => s.fullscreen);
  const groupWorktrees = useSetting('ui.groupWorktreeTabs') ?? true;
  const views = arrangeTabs(tabs, groupWorktrees);
  const paletteKey = useKeybindingLabel('palette.toggle');
  const newTabKey = useKeybindingLabel('tab.new');
  const closeKey = useKeybindingLabel('repo.closeTab');
  const prefsKey = useKeybindingLabel('prefs.open');

  // Overflow: which tabs are scrolled out of view (spec 01 §4.2 overflow dropdown).
  const strip = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState<string[]>([]);
  const [overflowAt, setOverflowAt] = useState<{ left: number; top: number } | null>(null);
  const measure = useCallback(() => {
    const el = strip.current;
    if (!el) return;
    const vp = el.getBoundingClientRect();
    const items = [...el.querySelectorAll<HTMLElement>('[data-tab-id]')].map((n) => {
      const r = n.getBoundingClientRect();
      return { id: n.dataset.tabId!, left: r.left, right: r.right };
    });
    const next = hiddenTabIds(items, { left: vp.left, right: vp.right });
    setHidden((h) => (h.join('\0') === next.join('\0') ? h : next));
  }, []);
  useLayoutEffect(measure, [measure, tabs, activeTabId]);
  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    el.addEventListener('scroll', measure, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener('scroll', measure);
    };
  }, [measure]);
  // Keep the active tab visible.
  useEffect(() => {
    strip.current
      ?.querySelector<HTMLElement>(`[data-tab-id="${activeTabId}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeTabId]);

  const tabMenu = (t: TabDescriptor, x: number, y: number): void => {
    const regular = tabs.filter((x) => !isPinnedTab(x));
    const idx = tabs.findIndex((x) => x.id === t.id);
    const items: MenuEntry[] = [];
    if (t.kind === 'repo') {
      items.push(
        { label: 'Alias repository…', onSelect: () => void renameTab(t.id) },
        { label: 'Remove alias', disabled: !t.alias, onSelect: () => setAlias(t.id, undefined) },
        'separator',
      );
    }
    items.push(
      { label: 'Close tab', shortcut: closeKey, onSelect: () => void requestCloseTab(t.id) },
      {
        label: 'Close other tabs',
        disabled: regular.length < 2,
        onSelect: () => void requestCloseOthers(t.id, 'others'),
      },
      {
        label: 'Close tabs to the right',
        disabled: !tabs.slice(idx + 1).some((x) => !isPinnedTab(x)),
        onSelect: () => void requestCloseOthers(t.id, 'right'),
      },
      'separator',
      { label: 'Duplicate tab', disabled: t.kind !== 'repo', onSelect: () => void duplicate(t.id) },
      'separator',
      {
        label: 'Copy path',
        disabled: !t.repoPath,
        onSelect: () => void invoke('shell:copyText', { text: t.repoPath! }),
      },
      {
        label: 'Open in file manager',
        disabled: !t.repoPath,
        onSelect: () => void invoke('shell:openPath', { path: t.repoPath! }),
      },
      {
        label: 'Open in terminal',
        disabled: !t.repoPath,
        onSelect: () => void openInTerminal(t.repoPath!),
      },
    );
    showMenu(x, y, items);
  };

  const renderTab = ({ tab: t, group }: TabView) => (
    <div
      key={t.id}
      data-tab-id={t.id}
      role="tab"
      aria-selected={t.id === activeTabId}
      tabIndex={t.id === activeTabId ? 0 : -1}
      className={[
        styles.tab,
        t.id === activeTabId ? styles.active : '',
        group ? styles.grouped : '',
        group?.position === 'first' ? styles.groupFirst : '',
        group?.position === 'last' ? styles.groupLast : '',
      ].join(' ')}
      draggable
      onDragStart={() => setDragId(t.id)}
      onDragOver={(e) => e.preventDefault()}
      onDrop={() => {
        if (dragId && dragId !== t.id)
          move(
            dragId,
            tabs.findIndex((x) => x.id === t.id),
          );
        setDragId(null);
      }}
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          void requestCloseTab(t.id);
        }
      }}
      onClick={() => activate(t.id)}
      onDoubleClick={() => t.kind === 'repo' && void renameTab(t.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') activate(t.id);
        else if (e.key === 'F2' && t.kind === 'repo') void renameTab(t.id);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        tabMenu(t, e.clientX, e.clientY);
      }}
    >
      <RepoTabContent tab={t} />
      <button
        type="button"
        className={styles.close}
        aria-label={`Close ${tabLabel(t)}`}
        onClick={(e) => {
          e.stopPropagation();
          void requestCloseTab(t.id);
        }}
      >
        <X size={12} />
      </button>
    </div>
  );

  return (
    <header
      className={`${styles.bar} ${mac && !fullscreen ? styles.mac : ''}`}
      data-theme-scope="tabsbar"
      data-focus-zone="tabs"
    >
      {!mac && (
        <button
          type="button"
          className={`${styles.iconBtn} ${updateDotHost}`}
          aria-label="Application menu"
          title="Menu (Alt)"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            void shellInvoke('menu:popup', { x: r.left, y: r.bottom }).catch(() => undefined);
          }}
        >
          <BrandMark size={18} />
          <UpdateDot />
        </button>
      )}
      {tabs.filter(isPinnedTab).map((t) => (
        <div
          key={t.id}
          role="tab"
          aria-selected={t.id === activeTabId}
          aria-label="Launchpad"
          tabIndex={t.id === activeTabId ? 0 : -1}
          title="Launchpad"
          className={`${styles.tab} ${styles.pinned} ${t.id === activeTabId ? styles.active : ''}`}
          onClick={() => activate(t.id)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') activate(t.id);
          }}
        >
          <Rocket size={15} className={styles.icon} aria-hidden />
        </div>
      ))}
      <div ref={strip} className={styles.tabs} role="tablist" aria-label="Repositories">
        {views.filter((v) => !isPinnedTab(v.tab)).map(renderTab)}
      </div>
      {hidden.length > 0 && (
        <button
          type="button"
          className={`${styles.iconBtn} ${styles.overflowBtn}`}
          aria-label={`${hidden.length} more tabs`}
          title="All tabs"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setOverflowAt({ left: r.left, top: r.bottom + 2 });
          }}
        >
          <ChevronDown size={16} />
          <span className={styles.count}>{hidden.length}</span>
        </button>
      )}
      <button
        type="button"
        className={styles.iconBtn}
        aria-label="New tab"
        title={`New tab${newTabKey ? ` (${newTabKey})` : ''}`}
        onClick={newTab}
      >
        <Plus size={16} />
      </button>
      <div className={styles.right}>
        <ProfileMenuButton onOpenPreferences={onOpenPreferences} />
        <AccountButton />
        <button
          type="button"
          className={styles.iconBtn}
          aria-label="Command palette"
          title={`Command palette${paletteKey ? ` (${paletteKey})` : ''}`}
          onClick={() => usePaletteStore.getState().toggle()}
        >
          <WandSparkles size={16} />
        </button>
        <button
          type="button"
          className={`${styles.iconBtn} ${updateDotHost}`}
          aria-label="Preferences"
          title={`Preferences${prefsKey ? ` (${prefsKey})` : ''}`}
          onClick={onOpenPreferences}
        >
          <Settings size={16} />
          <UpdateDot />
        </button>
      </div>
      {overflowAt && (
        <FilterDropdown
          anchor={overflowAt}
          label="Open tabs"
          placeholder="Filter tabs…"
          items={views.map(({ tab }) => ({
            id: tab.id,
            label: tabLabel(tab),
            detail: tab.repoPath,
            current: tab.id === activeTabId,
          }))}
          onPick={activate}
          onClose={() => setOverflowAt(null)}
        />
      )}
    </header>
  );
}
