import {
  DEFAULT_FILTERS,
  facets,
  type LaunchpadFilters,
  type LaunchpadGroup,
  type LaunchpadGroupBy,
  type LaunchpadTab,
  type SavedView,
} from '@githappens/launchpad';
import { useQueryClient } from '@tanstack/react-query';
import {
  Bookmark,
  ChevronDown,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Rocket,
  Search,
  User,
  Users,
  WifiOff,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';

import { useContextMenu, type MenuEntry } from '../../components/ContextMenu';
import { prompt } from '../../components/Dialogs';
import { activeFilterCount, ago, TAB_ORDER } from '../../launchpad/helpers';
import { useClockNow } from '../../lib/relative-clock';
import { useLaunchpadNav } from '../../launchpad/nav';
import {
  refreshLaunchpad,
  useDeleteView,
  useLaunchpad,
  useLaunchpadViews,
  useSaveView,
} from '../../launchpad/queries';
import s from './Launchpad.module.css';
import { ErrorChips, LaunchpadItems, ListSkeleton, NoIntegrations } from './LaunchpadList';

type MultiKey = 'providers' | 'repos' | 'labels' | 'authors' | 'milestones';

const PROVIDER_NAMES: Record<string, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  bitbucket: 'Bitbucket',
  'bitbucket-dc': 'Bitbucket DC',
  'azure-devops': 'Azure DevOps',
  'jira-cloud': 'Jira',
  'jira-dc': 'Jira DC',
  trello: 'Trello',
  'azure-boards': 'Azure Boards',
};
const UPDATED: Array<{ id: NonNullable<LaunchpadFilters['updatedWithin']>; label: string }> = [
  { id: 'any', label: 'Any time' },
  { id: '24h', label: 'Last 24 hours' },
  { id: '7d', label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' },
];

const isTyping = (t: EventTarget | null): boolean =>
  t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

export interface LaunchpadViewProps {
  /** Workspaces for the scope selector; default scope is "All connected". */
  workspaces?: Array<{ id: string; name: string }>;
  /** Whether the Launchpad tab is the visible tab (polling + shortcuts); default true. */
  active?: boolean;
}

/** "2m ago" that stays current on the shared minute clock (re-renders only this span). */
function Ago({ at }: { at: number | null }) {
  const now = useClockNow();
  return <>{ago(at, now)}</>;
}

/** The pinned Launchpad tab (spec 11 §4.2). */
export function LaunchpadView({ workspaces = [], active = true }: LaunchpadViewProps) {
  const qc = useQueryClient();
  const showMenu = useContextMenu((st) => st.show);
  const views = useLaunchpadViews();
  const saveView = useSaveView();
  const deleteView = useDeleteView();

  const [filters, setFilters] = useState<LaunchpadFilters>(DEFAULT_FILTERS);
  const [tab, setTab] = useState<LaunchpadTab>('prs');
  const [viewId, setViewId] = useState<string | null>(null);
  const [groupBy, setGroupBy] = useState<LaunchpadGroupBy>('status');
  const [density, setDensity] = useState<'comfortable' | 'compact'>('comfortable');
  const [search, setSearch] = useState('');
  const [focus, setFocus] = useState<{ group?: LaunchpadGroup; nonce: number }>({ nonce: 0 });
  const [refreshing, setRefreshing] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  // Restore the last filters once (state adjusted during render, not in an effect).
  const [restored, setRestored] = useState(false);
  if (!restored && views.data) {
    setRestored(true);
    const last = views.data.lastFilters;
    if (last) setFilters({ ...DEFAULT_FILTERS, ...last, text: undefined });
  }

  // Navigation requests (status bar, "See all", workspace "Launchpad" button).
  const nav = useLaunchpadNav();
  const [seenNonce, setSeenNonce] = useState(-1);
  if (nav.request && nav.nonce !== seenNonce) {
    const r = nav.request;
    setSeenNonce(nav.nonce);
    setViewId(null);
    if (r.tab) setTab(r.tab);
    if (r.workspaceId || r.mode) {
      setFilters((f) => ({
        ...f,
        scope: r.workspaceId ? { kind: 'workspace', workspaceId: r.workspaceId } : f.scope,
        mode: r.mode ?? (r.workspaceId ? f.mode : 'personal'),
      }));
    }
    if (r.group) setFocus({ group: r.group, nonce: nav.nonce });
  }
  useEffect(() => {
    if (nav.request) nav.consume();
  }, [nav]);

  const q = useLaunchpad(filters, tab, active);
  const data = q.data;
  const fx = useMemo(() => facets(data?.items ?? []), [data?.items]);
  const savedViews = views.data?.views ?? [];

  const refresh = async (): Promise<void> => {
    setRefreshing(true);
    try {
      await refreshLaunchpad(qc, filters.scope.kind === 'workspace' ? filters.scope.workspaceId : undefined);
    } finally {
      setRefreshing(false);
    }
  };

  const applyView = (v: SavedView): void => {
    setViewId(v.id);
    setTab(v.tab);
    setGroupBy(v.groupBy);
    setFilters({ ...DEFAULT_FILTERS, ...v.filters });
  };
  const selectTab = (t: LaunchpadTab): void => {
    setViewId(null);
    setTab(t);
  };

  // Keyboard (§4.2): ↑/↓ Enter C O P S M are handled by the list; / R 1–5 here.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      if (document.querySelector('[role="dialog"], [role="menu"]')) return;
      if (isTyping(e.target)) {
        if (e.key === 'Escape' && e.target === searchRef.current) searchRef.current?.blur();
        return;
      }
      if (e.key === '/') {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        void refresh();
        return;
      }
      const n = Number(e.key);
      if (n >= 1 && n <= TAB_ORDER.length) {
        e.preventDefault();
        selectTab(TAB_ORDER[n - 1]!.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const toggleValue = (key: MultiKey, value: string): void =>
    setFilters((f) => {
      const cur = f[key] ?? [];
      const next = cur.includes(value) ? cur.filter((x) => x !== value) : [...cur, value];
      return { ...f, [key]: next.length ? next : undefined };
    });

  const multiMenu = (key: MultiKey, options: string[], label: (v: string) => string = (v) => v) => {
    const selected = filters[key] ?? [];
    const all = [...new Set([...selected, ...options])];
    const entries: MenuEntry[] = all.length
      ? all.slice(0, 40).map((v) => ({
          label: `${selected.includes(v) ? '✓ ' : ' '}${label(v)}`,
          onSelect: () => toggleValue(key, v),
        }))
      : [{ label: 'No values', disabled: true }];
    if (selected.length)
      entries.push('separator', {
        label: 'Clear',
        onSelect: () => setFilters((f) => ({ ...f, [key]: undefined })),
      });
    return entries;
  };

  const filterButton = (key: MultiKey, title: string, options: string[], label?: (v: string) => string) => {
    const n = filters[key]?.length ?? 0;
    return (
      <button
        type="button"
        className={`${s.filterBtn} ${n ? s.filterOn : ''}`}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          showMenu(r.left, r.bottom + 2, multiMenu(key, options, label));
        }}
      >
        {title}
        {n ? ` (${n})` : ''} <ChevronDown size={11} />
      </button>
    );
  };

  const settingsMenu = (e: MouseEvent): void => {
    const r = e.currentTarget.getBoundingClientRect();
    const mark = (on: boolean, label: string) => `${on ? '✓ ' : ' '}${label}`;
    showMenu(r.right - 220, r.bottom + 2, [
      ...(['status', 'repo', 'provider', 'none'] as const).map((g) => ({
        label: mark(groupBy === g, `Group by ${g === 'none' ? 'nothing' : g}`),
        onSelect: () => setGroupBy(g),
      })),
      'separator',
      {
        label: mark(density === 'comfortable', 'Comfortable rows'),
        onSelect: () => setDensity('comfortable'),
      },
      { label: mark(density === 'compact', 'Compact rows'), onSelect: () => setDensity('compact') },
      'separator',
      { label: 'Save as view…', onSelect: () => void saveCurrentView() },
    ]);
  };

  const saveCurrentView = async (): Promise<void> => {
    const current = savedViews.find((v) => v.id === viewId);
    const r = await prompt({
      title: current ? 'Update saved view' : 'Save view',
      label: 'Name',
      initial: current?.name ?? '',
      okLabel: 'Save',
      validate: (v) => (v.trim() ? null : 'Enter a name.'),
    });
    if (!r) return;
    const v = await saveView.mutateAsync({
      id: current?.id,
      name: r.value,
      tab: tab === 'snoozed' ? 'all' : tab,
      filters: { ...filters, text: undefined },
      groupBy,
    });
    setViewId(v.id);
  };

  const scopeValue = filters.scope.kind === 'workspace' ? filters.scope.workspaceId : '';
  const teamOk = filters.scope.kind === 'workspace';
  const nFilters = activeFilterCount(filters);
  const counts = data?.counts;

  let body: ReactNode;
  if (q.isPending) body = <ListSkeleton />;
  else if (q.isError) body = <div className={s.empty}>Could not load the Launchpad: {q.error.message}</div>;
  else if (!data!.hasIntegrations && tab !== 'wips') body = <NoIntegrations />;
  else if (data!.teamUnavailable)
    body = <div className={s.empty}>Team mode needs a workspace — pick one in the scope selector.</div>;
  else
    body = (
      <LaunchpadItems
        items={data!.items}
        groupBy={groupBy}
        search={search}
        density={density}
        focusGroup={focus.group}
        focusNonce={focus.nonce}
        keyboard={active}
        emptyMessage={search || nFilters ? 'Nothing matches the filters.' : 'You’re all caught up.'}
      />
    );

  return (
    <section className={s.view} aria-label="Launchpad">
      <header className={s.header}>
        <h1 className={s.title}>
          <Rocket size={16} aria-hidden /> Launchpad
        </h1>
        <select
          className={s.select}
          aria-label="Scope"
          value={scopeValue}
          onChange={(e) =>
            setFilters((f) => ({
              ...f,
              scope: e.target.value ? { kind: 'workspace', workspaceId: e.target.value } : { kind: 'all' },
              mode: e.target.value ? f.mode : 'personal',
            }))
          }
        >
          <option value="">All connected</option>
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
        <span className={s.segmented} role="group" aria-label="Mode">
          <button
            type="button"
            aria-pressed={filters.mode === 'personal'}
            onClick={() => setFilters((f) => ({ ...f, mode: 'personal' }))}
          >
            <User size={12} /> Personal
          </button>
          <button
            type="button"
            aria-pressed={filters.mode === 'team'}
            disabled={!teamOk}
            title={
              teamOk ? 'Everyone’s pull requests in this workspace' : 'Team mode requires a workspace scope'
            }
            onClick={() => setFilters((f) => ({ ...f, mode: 'team' }))}
          >
            <Users size={12} /> Team
          </button>
        </span>
        <label className={s.searchBox}>
          <Search size={13} aria-hidden />
          <input
            ref={searchRef}
            className={s.search}
            type="search"
            placeholder="Search title, #123, ABC-12, repo, branch, author  ( / )"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search Launchpad"
          />
        </label>
        <span className={s.spacer} />
        {data?.stale && <span className={`${s.meta} ${s.stale}`}>Cached</span>}
        <span
          className={s.meta}
          title={data?.fetchedAt ? new Date(data.fetchedAt).toLocaleString() : undefined}
        >
          Updated <Ago at={data?.fetchedAt ?? null} />
        </span>
        <button
          type="button"
          className={s.iconBtn}
          aria-label="Refresh"
          title="Refresh (R)"
          onClick={() => void refresh()}
          disabled={refreshing}
        >
          <RefreshCw size={14} className={refreshing || data?.refreshing ? s.spin : undefined} />
        </button>
        <button
          type="button"
          className={s.iconBtn}
          aria-label="View settings"
          title="View settings"
          onClick={settingsMenu}
        >
          <MoreHorizontal size={14} />
        </button>
        <div className={s.filters}>
          {filterButton('providers', 'Provider', fx.providers, (v) => PROVIDER_NAMES[v] ?? v)}
          {filterButton('repos', 'Repository', fx.repos)}
          {filterButton('labels', 'Labels', fx.labels)}
          {filterButton('authors', 'Author', fx.authors)}
          {filterButton('milestones', 'Milestone / Sprint', fx.milestones)}
          <button
            type="button"
            className={`${s.filterBtn} ${filters.updatedWithin && filters.updatedWithin !== 'any' ? s.filterOn : ''}`}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              showMenu(
                r.left,
                r.bottom + 2,
                UPDATED.map((u) => ({
                  label: `${(filters.updatedWithin ?? 'any') === u.id ? '✓ ' : ' '}${u.label}`,
                  onSelect: () =>
                    setFilters((f) => ({ ...f, updatedWithin: u.id === 'any' ? undefined : u.id })),
                })),
              );
            }}
          >
            Updated: {UPDATED.find((u) => u.id === (filters.updatedWithin ?? 'any'))!.label}{' '}
            <ChevronDown size={11} />
          </button>
          {nFilters > 0 && (
            <button
              type="button"
              className={s.linkBtn}
              onClick={() => setFilters((f) => ({ scope: f.scope, mode: f.mode }))}
            >
              Clear filters
            </button>
          )}
        </div>
      </header>
      <nav className={s.tabs} role="tablist" aria-label="Launchpad views">
        {TAB_ORDER.map((t, i) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={!viewId && tab === t.id}
            className={s.tab}
            title={`${t.label} (${i + 1})`}
            onClick={() => selectTab(t.id)}
          >
            {t.label}
            {counts && t.id !== 'all' && <span className={s.count}>{counts[t.id]}</span>}
          </button>
        ))}
        {savedViews.map((v) => (
          <button
            key={v.id}
            type="button"
            role="tab"
            aria-selected={viewId === v.id}
            className={s.tab}
            onClick={() => applyView(v)}
            onContextMenu={(e) => {
              e.preventDefault();
              showMenu(e.clientX, e.clientY, [
                { label: 'Apply', onSelect: () => applyView(v) },
                {
                  label: 'Update with current filters',
                  onSelect: () =>
                    void saveView.mutateAsync({
                      ...v,
                      tab: tab === 'snoozed' ? 'all' : tab,
                      filters,
                      groupBy,
                    }),
                },
                'separator',
                {
                  label: 'Delete view',
                  danger: true,
                  onSelect: () => {
                    if (viewId === v.id) setViewId(null);
                    deleteView.mutate(v.id);
                  },
                },
              ]);
            }}
          >
            <Bookmark size={11} aria-hidden /> {v.name}
          </button>
        ))}
        <button
          type="button"
          className={s.tab}
          aria-label="Save current filters as a view"
          title="Save current filters as a view"
          onClick={() => void saveCurrentView()}
        >
          <Plus size={13} />
        </button>
      </nav>
      {data?.offline ? (
        <div className={`${s.banner} ${s.offline}`} role="status">
          <WifiOff size={13} aria-hidden /> Offline — showing data from{' '}
          {data.fetchedAt ? new Date(data.fetchedAt).toLocaleString() : 'nowhere yet'}
        </div>
      ) : (
        data?.stale &&
        data.fetchedAt && (
          <div className={s.banner}>
            Showing data from <Ago at={data.fetchedAt} /> — refreshing…
          </div>
        )
      )}
      {body}
      {data && <ErrorChips errors={data.errors} onRetry={() => void refresh()} />}
    </section>
  );
}
