import {
  DEFAULT_FILTERS,
  groupItems,
  matchesSearch,
  parseSearch,
  type ClassifiedItem,
  type LaunchpadFilters,
  type LaunchpadGroup,
  type LaunchpadGroupBy,
  type LaunchpadScope,
  type LaunchpadSourceError,
  type LaunchpadTab,
} from '@githappens/launchpad';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { useContextMenu } from '../../components/ContextMenu';
import { useClockNow } from '../../lib/relative-clock';
import { openIntegrationsPreferences } from '../../integrations/api';
import { describeProviderError } from '../../integrations/helpers';
import { checkoutItem, openInBrowser, openItem } from '../../launchpad/actions';
import {
  canMergeFromLaunchpad,
  firstItem,
  flattenGroups,
  moveSelection,
  visibleRange,
} from '../../launchpad/helpers';
import { setItemState, useLaunchpad } from '../../launchpad/queries';
import s from './Launchpad.module.css';
import { LaunchpadRow, snoozeMenu } from './LaunchpadRow';
import { MergePopover } from './MergePopover';

const isTyping = (t: EventTarget | null): boolean =>
  t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

interface ItemsProps {
  items: ClassifiedItem[];
  groupBy?: LaunchpadGroupBy;
  search?: string;
  density?: 'comfortable' | 'compact';
  /** Expand + scroll to this group when `focusNonce` changes (status-bar click-through). */
  focusGroup?: LaunchpadGroup;
  focusNonce?: number;
  /** Handle the Launchpad row shortcuts (↑/↓ Enter C O P S M) on the window (§4.2). */
  keyboard?: boolean;
  emptyMessage?: string;
}

/** Grouped, virtualized Launchpad list with selection and row actions (§4.2 LaunchpadList). */
export function LaunchpadItems({
  items,
  groupBy = 'status',
  search,
  density = 'comfortable',
  focusGroup,
  focusNonce,
  keyboard = false,
  emptyMessage = 'You’re all caught up.',
}: ItemsProps) {
  const qc = useQueryClient();
  const showMenu = useContextMenu((st) => st.show);
  const rowH = density === 'compact' ? 28 : 34;
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [selectedUid, setSelectedUid] = useState<string | null>(null);
  const [merge, setMerge] = useState<{ item: ClassifiedItem; anchor: DOMRect } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(600);
  // Shared minute clock (paused while the window is hidden) keeps "2m ago" / snooze labels current.
  const now = useClockNow();

  const filtered = useMemo(() => {
    const q = parseSearch(search);
    return q.kind === 'empty' ? items : items.filter((i) => matchesSearch(i, q));
  }, [items, search]);
  const groups = useMemo(() => groupItems(filtered, groupBy), [filtered, groupBy]);
  const rows = useMemo(() => flattenGroups(groups, collapsed), [groups, collapsed]);
  const selectedIndex = rows.findIndex((r) => r.kind === 'item' && r.item.uid === selectedUid);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    setViewport(el.clientHeight);
    const ro = new ResizeObserver(() => setViewport(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const scrollToIndex = (i: number, align: 'nearest' | 'start' = 'nearest'): void => {
    const el = scroller.current;
    if (!el || i < 0) return;
    const top = i * rowH;
    if (align === 'start') el.scrollTop = top;
    else if (top < el.scrollTop) el.scrollTop = top;
    else if (top + rowH > el.scrollTop + el.clientHeight) el.scrollTop = top + rowH - el.clientHeight;
  };

  // Status-bar click-through: expand and reveal the requested group once its rows exist.
  const pendingFocus = useRef<LaunchpadGroup | null>(null);
  useEffect(() => {
    if (focusGroup && focusNonce !== undefined) pendingFocus.current = focusGroup;
  }, [focusGroup, focusNonce]);
  useEffect(() => {
    const g = pendingFocus.current;
    if (!g) return;
    const i = rows.findIndex((r) => r.kind === 'header' && r.group === g);
    if (i < 0) return;
    if (collapsed.has(g)) {
      const n = new Set(collapsed);
      n.delete(g);
      setCollapsed(n);
      return; // runs again with the expanded rows
    }
    pendingFocus.current = null;
    const el = scroller.current;
    if (el) el.scrollTop = i * rowH;
    const first = rows[i + 1];
    if (first?.kind === 'item') setSelectedUid(first.item.uid);
  }, [rows, collapsed, rowH, focusNonce]);

  const select = (i: number): void => {
    const r = rows[i];
    if (r?.kind !== 'item') return;
    setSelectedUid(r.item.uid);
    scrollToIndex(i);
  };

  const selected = selectedIndex >= 0 ? rows[selectedIndex] : undefined;
  const selectedItem = selected?.kind === 'item' ? selected.item : undefined;
  const mergeSelected = (): void => {
    if (!selectedItem || !canMergeFromLaunchpad(selectedItem)) return;
    const el = scroller.current?.querySelector(`[data-uid="${CSS.escape(selectedItem.uid)}"]`);
    setMerge({ item: selectedItem, anchor: (el ?? scroller.current!).getBoundingClientRect() });
  };

  const handleKey = (e: KeyboardEvent): boolean => {
    const k = e.key;
    if (k === 'ArrowDown' || k === 'ArrowUp') {
      const cur = selectedIndex >= 0 ? selectedIndex : -1;
      select(cur < 0 ? firstItem(rows) : moveSelection(rows, cur, k === 'ArrowDown' ? 1 : -1));
      return true;
    }
    if (!selectedItem) return false;
    switch (k.toLowerCase()) {
      case 'enter':
        void openItem(selectedItem);
        return true;
      case 'c':
        void checkoutItem(selectedItem);
        return true;
      case 'o':
        openInBrowser(selectedItem);
        return true;
      case 'p':
        void setItemState(qc, selectedItem, { pin: !selectedItem.pinnedAt });
        return true;
      case 's': {
        const el = scroller.current?.querySelector(`[data-uid="${CSS.escape(selectedItem.uid)}"]`);
        const r = el?.getBoundingClientRect();
        showMenu(r ? r.right - 220 : 200, r ? r.bottom : 200, snoozeMenu(qc, selectedItem));
        return true;
      }
      case 'm':
        mergeSelected();
        return true;
      default:
        return false;
    }
  };
  useEffect(() => {
    if (!keyboard) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      if (document.querySelector('[role="dialog"], [role="menu"]')) return;
      // ArrowDown from the search box moves into the list.
      if (
        isTyping(e.target) &&
        !(e.key === 'ArrowDown' && (e.target as HTMLElement).getAttribute('type') === 'search')
      )
        return;
      if (handleKey(e)) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!rows.length) return <div className={s.empty}>{emptyMessage}</div>;

  const { start, end } = visibleRange(scrollTop, viewport, rowH, rows.length);
  return (
    <div className={s.listWrap}>
      <div
        ref={scroller}
        className={s.scroller}
        role="listbox"
        aria-label="Launchpad items"
        tabIndex={0}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        onKeyDown={(e) => {
          if (!keyboard && handleKey(e.nativeEvent)) e.preventDefault();
        }}
      >
        <div style={{ position: 'relative', height: rows.length * rowH }}>
          {rows.slice(start, end).map((r, k) => {
            const i = start + k;
            const style = { top: i * rowH, height: rowH };
            if (r.kind === 'header') {
              return (
                <button
                  key={r.key}
                  type="button"
                  className={s.groupHeader}
                  style={style}
                  aria-expanded={!r.collapsed}
                  onClick={() =>
                    setCollapsed((c) => {
                      const n = new Set(c);
                      if (n.has(r.group)) n.delete(r.group);
                      else n.add(r.group);
                      return n;
                    })
                  }
                >
                  {r.collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                  <span className={`${s.groupDot} ${s[`bg-${r.group}`] ?? ''}`} aria-hidden />
                  {r.label}
                  <span className={s.count}>{r.count}</span>
                </button>
              );
            }
            return (
              <LaunchpadRow
                key={r.key}
                item={r.item}
                selected={r.item.uid === selectedUid}
                style={style}
                now={now}
                onSelect={() => setSelectedUid(r.item.uid)}
                onMerge={(anchor) => setMerge({ item: r.item, anchor })}
              />
            );
          })}
        </div>
      </div>
      {merge && <MergePopover item={merge.item} anchor={merge.anchor} onClose={() => setMerge(null)} />}
    </div>
  );
}

/** Footer chips for failing sources (§4.2 "Footer: provider error chips"). */
export function ErrorChips({ errors, onRetry }: { errors: LaunchpadSourceError[]; onRetry?: () => void }) {
  const [now] = useState(() => Date.now());
  if (!errors.length) return null;
  return (
    <div className={s.footer} role="status">
      {errors.map((e) => {
        const f = describeProviderError(
          { message: e.error.message, details: { providerCode: e.error.code, retryAt: e.error.retryAt } },
          now,
        );
        return (
          <span key={e.source} className={s.errorChip} title={e.error.message}>
            <strong>{e.label}:</strong> {f.title}
            {f.action === 'reconnect' ? (
              <button type="button" onClick={openIntegrationsPreferences}>
                Reconnect
              </button>
            ) : onRetry ? (
              <button type="button" onClick={onRetry}>
                Retry
              </button>
            ) : null}
          </span>
        );
      })}
    </div>
  );
}

export interface LaunchpadListProps {
  scope: LaunchpadScope;
  tab: LaunchpadTab;
  mode?: 'personal' | 'team';
  filters?: Partial<Omit<LaunchpadFilters, 'scope' | 'mode'>>;
  groupBy?: LaunchpadGroupBy;
  search?: string;
  /** Poll while visible (default true). */
  active?: boolean;
  density?: 'comfortable' | 'compact';
}

/**
 * Self-contained Launchpad list (fetch + states), e.g. a workspace's Pull Requests / Issues tab:
 * `<LaunchpadList scope={{ kind: 'workspace', workspaceId }} tab="prs" />`.
 */
export function LaunchpadList({
  scope,
  tab,
  mode = 'personal',
  filters,
  groupBy = 'status',
  search,
  active = true,
  density,
}: LaunchpadListProps) {
  const full = useMemo<LaunchpadFilters>(
    () => ({ ...DEFAULT_FILTERS, ...filters, scope, mode }),
    [filters, scope, mode],
  );
  const q = useLaunchpad(full, tab, active);
  if (q.isPending) return <ListSkeleton />;
  if (q.isError)
    return <div className={s.empty}>Could not load the Launchpad: {String(q.error.message)}</div>;
  const d = q.data;
  return (
    <div className={s.listWrap}>
      {!d.hasIntegrations && tab !== 'wips' ? (
        <NoIntegrations />
      ) : (
        <LaunchpadItems
          items={d.items}
          groupBy={groupBy}
          search={search}
          density={density}
          emptyMessage={tab === 'issues' ? 'No issues need you here.' : 'No pull requests need you here.'}
        />
      )}
      <ErrorChips errors={d.errors} onRetry={() => void q.refetch()} />
    </div>
  );
}

export function ListSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className={s.skeleton} style={{ width: `${60 + ((i * 17) % 35)}%` }} />
      ))}
    </div>
  );
}

export function NoIntegrations() {
  return (
    <div className={s.empty}>
      <h2>Connect a provider to see pull requests and issues</h2>
      <span>
        GitHub, GitLab, Bitbucket, Azure DevOps and Jira are supported. The WIPs tab works without one.
      </span>
      <button type="button" className={s.primaryBtn} onClick={openIntegrationsPreferences}>
        Connect an account
      </button>
    </div>
  );
}
