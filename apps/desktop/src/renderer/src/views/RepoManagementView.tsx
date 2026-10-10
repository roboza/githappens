import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Code2,
  DownloadCloud,
  FolderGit2,
  FolderOpen,
  FolderPlus,
  GitBranchPlus,
  GripVertical,
  House,
  Info,
  Layers,
  MoreHorizontal,
  Search,
  Star,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';

import {
  DEFAULT_COLUMN_WIDTHS,
  type RepoColumnWidths,
  type RepoGroup,
  type RepoRegistryState,
} from '../../../shared/ipc/repos2-contract';
import type { RepoRecord } from '../../../shared/ipc/shell-contract';
import type { Workspace } from '../../../shared/ipc/workspaces-contract';
import { useContextMenu, type MenuEntry } from '../components/ContextMenu';
import { prompt } from '../components/Dialogs';
import { invoke } from '../lib/api';
import { formatDate } from '../lib/format';
import { useSetting } from '../stores/settings';
import { useTabsStore } from '../stores/tabs';
import { useToastStore } from '../stores/toasts';
import { openInEditor } from '../tools/actions';
import { useWorkspaceUi } from '../workspaces/queries';
import { CloneDialog, InitDialog } from './CloneInitDialogs';
import styles from './RepoManagementView.module.css';
import { errorText, reposInvoke } from './repos/api';
import { useFolderDrop } from './repos/folder-drop';
import { browseAndOpen, openRepoWithRecovery } from './repos/open-flow';
import {
  buildGroupViews,
  GROUP_COLORS,
  moveGroup,
  normPath,
  remoteLabel,
  reorderedFavorites,
} from './repos/repo-groups';
import { RepoDetailsPane } from './repos/RepoDetailsPane';
import { refreshRepos, REPOS_QUERY_KEY, repoRowMenu } from './repos/row-menu';
import { WelcomeView } from './welcome/WelcomeView';
import { NewWorkspaceDialog } from './workspaces/NewWorkspaceDialog';
import { WorkspacesSidebar } from './workspaces/WorkspacesSidebar';
import { WorkspaceView } from './workspaces/WorkspaceView';

export interface RepoManagementViewProps {
  /** Right-hand "Focus" column (compact Launchpad); shown when `workspaces.showFocusOnHome` is on. */
  focus?: ReactNode;
  /** Pull Requests / Issues tabs of a workspace (Launchpad lists scoped to it). */
  renderWorkspacePrs?: (workspace: Workspace) => ReactNode;
  renderWorkspaceIssues?: (workspace: Workspace) => ReactNode;
}

/** Fallback when main does not serve `repos:state` yet: plain recents in the built-in groups. */
async function loadState(): Promise<RepoRegistryState> {
  try {
    return await reposInvoke('repos:state', {});
  } catch {
    const repos = await invoke('repos:list', {});
    return {
      repos,
      groups: [
        { id: 'open', kind: 'open', name: 'Open', collapsed: false, order: 0 },
        { id: 'favorites', kind: 'favorites', name: 'Favorites', collapsed: false, order: 1 },
        { id: 'recent', kind: 'recent', name: 'Recently opened', collapsed: false, order: 2 },
      ],
      columnWidths: { ...DEFAULT_COLUMN_WIDTHS },
    };
  }
}

const isMac = (): boolean => window.api?.platform === 'darwin';
const favKey = (n: number): string => (isMac() ? `⌘⌥${n}` : `Ctrl+Alt+${n}`);
const colorVar = (c?: string): string | undefined => (c ? `var(--kl-${c})` : undefined);

/**
 * New Tab page / Repository Management (spec 03 §4, spec 11 §4.1/§4.4): open / clone / init, Open /
 * Favorites / Recent / custom groups with colours and reorder, resizable persisted columns, README details
 * pane, row context menu, the WORKSPACES sidebar and the welcome screen on first run.
 */
export function RepoManagementView({
  focus,
  renderWorkspacePrs,
  renderWorkspaceIssues,
}: RepoManagementViewProps) {
  const qc = useQueryClient();
  const state = useQuery({ queryKey: REPOS_QUERY_KEY, queryFn: loadState });
  const tabs = useTabsStore((s) => s.tabs);
  const [filter, setFilter] = useState('');
  const [dialog, setDialog] = useState<'clone' | 'init' | 'workspace' | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [details, setDetails] = useState<string | null>(null);
  const [widths, setWidths] = useState<RepoColumnWidths | null>(null);
  const [dragFav, setDragFav] = useState<string | null>(null);
  const [dragGroup, setDragGroup] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const selectedWs = useWorkspaceUi((s) => s.selectedId);
  const selectWs = useWorkspaceUi((s) => s.select);
  const focusOnHome = useSetting('workspaces.showFocusOnHome') !== false;
  const showFocus = !!focus && focusOnHome && !selectedWs;
  const dropping = useFolderDrop();
  const showMenu = useContextMenu((s) => s.show);

  const refresh = useCallback((): void => refreshRepos(qc), [qc]);
  const data = state.data;
  const cols = widths ?? data?.columnWidths ?? DEFAULT_COLUMN_WIDTHS;
  const openPaths = useMemo(
    () => tabs.filter((t) => t.kind === 'repo' && t.repoPath).map((t) => t.repoPath!),
    [tabs],
  );
  const views = useMemo(
    () => (data ? buildGroupViews(data.repos, data.groups, openPaths, filter) : []),
    [data, openPaths, filter],
  );
  const favorites = useMemo(() => (data?.repos ?? []).filter((r) => r.favorite && !r.missing), [data]);

  // Ctrl/Cmd+Alt+F focuses the search box while this view is shown (spec 03 §4.4); handled in the capture
  // phase so it wins over the left panel's filter shortcut, which has nothing to focus here.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.altKey && !e.shiftKey && e.code === 'KeyF' && !selectedWs) {
        e.preventDefault();
        e.stopImmediatePropagation();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    const onFocusEvt = (): void => searchRef.current?.focus();
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('kl:repo-mgmt-search', onFocusEvt);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('kl:repo-mgmt-search', onFocusEvt);
    };
  }, [selectedWs]);

  const saveGroups = (groups: RepoGroup[]): void => {
    qc.setQueryData<RepoRegistryState>(REPOS_QUERY_KEY, (s) => (s ? { ...s, groups } : s));
    void reposInvoke('repos:groups:save', { groups }).then(refresh, (e: unknown) =>
      useToastStore.getState().push({ kind: 'error', title: 'Could not save groups', body: errorText(e) }),
    );
  };

  const newGroup = async (): Promise<void> => {
    const r = await prompt({ title: 'New group', label: 'Group name', okLabel: 'Create' });
    const name = r?.value.trim();
    if (!name || !data) return;
    saveGroups([
      ...data.groups,
      {
        id: `custom:${crypto.randomUUID()}`,
        kind: 'custom',
        name,
        collapsed: false,
        order: data.groups.length,
      },
    ]);
  };

  const groupMenu = (g: RepoGroup, e: ReactMouseEvent): void => {
    if (!data) return;
    const groups = data.groups;
    const index = [...groups].sort((a, b) => a.order - b.order).findIndex((x) => x.id === g.id);
    const update = (patch: Partial<RepoGroup>): void =>
      saveGroups(groups.map((x) => (x.id === g.id ? { ...x, ...patch } : x)));
    const items: MenuEntry[] = [
      { label: g.collapsed ? 'Expand' : 'Collapse', onSelect: () => update({ collapsed: !g.collapsed }) },
      {
        label: 'Move up',
        disabled: index <= 0,
        onSelect: () => saveGroups(moveGroup(groups, g.id, index - 1)),
      },
      {
        label: 'Move down',
        disabled: index >= groups.length - 1,
        onSelect: () => saveGroups(moveGroup(groups, g.id, index + 1)),
      },
      'separator',
      ...GROUP_COLORS.map((c): MenuEntry => ({
        label: `${g.color === c ? '● ' : ''}Colour: ${c}`,
        onSelect: () => update({ color: c }),
      })),
      { label: 'Default colour', disabled: !g.color, onSelect: () => update({ color: undefined }) },
    ];
    if (g.kind === 'custom') {
      items.push('separator', {
        label: 'Rename…',
        onSelect: () =>
          void prompt({ title: 'Rename group', initial: g.name, okLabel: 'Rename' }).then((r) => {
            if (r?.value.trim()) update({ name: r.value.trim() });
          }),
      });
      items.push({
        label: 'Delete group',
        danger: true,
        onSelect: () => saveGroups(groups.filter((x) => x.id !== g.id)),
      });
    }
    showMenu(e.clientX, e.clientY, items);
  };

  // ---- column resize (persisted, spec 03 §4.1 / 12.0) ----
  const resizeStart = (col: keyof RepoColumnWidths, e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    const startX = e.clientX;
    const base = { ...cols };
    let latest = base;
    const move = (ev: PointerEvent): void => {
      latest = { ...base, [col]: Math.max(80, Math.min(1200, base[col] + ev.clientX - startX)) };
      setWidths(latest);
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      void reposInvoke('repos:columns:save', { columnWidths: latest }).catch(() => undefined);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const gridTemplate = `20px ${cols.name}px ${cols.remote}px ${cols.branch}px minmax(90px, 1fr) auto`;

  const open = async (r: RepoRecord): Promise<void> => {
    if (r.missing) return;
    await openRepoWithRecovery(r.path);
    refresh();
  };

  const dropFavorite = (target: string | null): void => {
    if (!dragFav) return;
    const paths = reorderedFavorites(
      favorites.map((f) => f.path),
      dragFav,
      target,
    );
    setDragFav(null);
    void reposInvoke('repos:reorderFavorites', { paths }).then(refresh, (e: unknown) =>
      useToastStore
        .getState()
        .push({ kind: 'error', title: 'Could not reorder favorites', body: errorText(e) }),
    );
  };

  const row = (r: RepoRecord, g: RepoGroup): ReactNode => {
    const favIndex = r.favorite ? favorites.findIndex((f) => normPath(f.path) === normPath(r.path)) : -1;
    const isOpen = openPaths.some((p) => normPath(p) === normPath(r.path));
    const draggableFav = g.kind === 'favorites' && !filter;
    return (
      <li
        key={`${g.id}:${r.path}`}
        draggable={draggableFav}
        onDragStart={(e: ReactDragEvent) => {
          if (!draggableFav) return;
          setDragFav(r.path);
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/x-kl-favorite', r.path);
        }}
        onDragOver={(e) => {
          if (draggableFav && dragFav) e.preventDefault();
        }}
        onDrop={(e) => {
          if (!draggableFav || !dragFav) return;
          e.preventDefault();
          dropFavorite(r.path);
        }}
      >
        <div
          role="button"
          tabIndex={0}
          aria-selected={selected === r.path}
          className={`${styles.row} ${r.missing ? styles.missing : ''} ${selected === r.path ? styles.selected : ''}`}
          style={{ gridTemplateColumns: gridTemplate }}
          onClick={() => {
            setSelected(r.path);
            if (details) setDetails(r.path);
          }}
          onDoubleClick={() => void open(r)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void open(r);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            setSelected(r.path);
            showMenu(
              e.clientX,
              e.clientY,
              repoRowMenu(r, {
                qc,
                groups: data?.groups ?? [],
                isOpen,
                showDetails: () => setDetails(r.path),
              }),
            );
          }}
          title={r.missing ? 'This folder no longer exists — right-click to locate it' : r.path}
        >
          {r.missing ? (
            <AlertTriangle size={16} className={styles.warn} aria-label="Missing" />
          ) : (
            <FolderGit2 size={16} className={styles.repoIcon} aria-hidden />
          )}
          <div className={styles.meta}>
            <span className={styles.name}>
              {draggableFav && <GripVertical size={12} className={styles.grip} aria-hidden />}
              {r.alias ?? r.name}
              {r.isBare && <span className={styles.badge}>bare</span>}
              {r.missing && <span className={styles.badgeWarn}>Not found</span>}
              {isOpen && <span className={styles.badge}>open</span>}
              {favIndex >= 0 && favIndex < 9 && <span className={styles.kbd}>{favKey(favIndex + 1)}</span>}
            </span>
            <span className={styles.path}>{r.path}</span>
          </div>
          <span className={styles.remote} title={r.remoteUrl}>
            {remoteLabel(r.remoteUrl)}
          </span>
          <span className={styles.branch}>{r.lastBranch}</span>
          <span className={styles.when}>
            {r.lastOpenedAt ? formatDate(Math.floor(r.lastOpenedAt / 1000)) : ''}
          </span>
          <span className={styles.rowActions}>
            <button
              type="button"
              className={`${styles.icon} ${r.favorite ? styles.fav : ''}`}
              aria-label={r.favorite ? 'Remove from favorites' : 'Add to favorites'}
              aria-pressed={r.favorite}
              onClick={(e) => {
                e.stopPropagation();
                void invoke('repos:setFavorite', { path: r.path, favorite: !r.favorite }).then(refresh);
              }}
            >
              <Star size={15} fill={r.favorite ? 'currentColor' : 'none'} />
            </button>
            {!r.missing && (
              <button
                type="button"
                className={styles.icon}
                aria-label="Open in editor"
                title="Open in editor"
                onClick={(e) => {
                  e.stopPropagation();
                  void openInEditor(r.path);
                }}
              >
                <Code2 size={15} />
              </button>
            )}
            {!r.missing && (
              <button
                type="button"
                className={styles.icon}
                aria-label="Details"
                title="Details"
                onClick={(e) => {
                  e.stopPropagation();
                  setSelected(r.path);
                  setDetails(details === r.path ? null : r.path);
                }}
              >
                <Info size={15} />
              </button>
            )}
            <button
              type="button"
              className={styles.icon}
              aria-label="More actions"
              onClick={(e) => {
                e.stopPropagation();
                showMenu(
                  e.clientX,
                  e.clientY,
                  repoRowMenu(r, {
                    qc,
                    groups: data?.groups ?? [],
                    isOpen,
                    showDetails: () => setDetails(r.path),
                  }),
                );
              }}
            >
              <MoreHorizontal size={15} />
            </button>
          </span>
        </div>
      </li>
    );
  };

  const firstRun = !!data && data.repos.length === 0;

  return (
    <div className={`${styles.page} ${showFocus ? styles.withFocus : ''}`}>
      {dialog === 'clone' && <CloneDialog onClose={() => setDialog(null)} />}
      {dialog === 'init' && <InitDialog onClose={() => setDialog(null)} />}
      {dialog === 'workspace' && <NewWorkspaceDialog onClose={() => setDialog(null)} />}
      {dropping && (
        <div className={styles.dropOverlay} aria-hidden>
          <FolderOpen size={28} /> Drop a folder to open it
        </div>
      )}
      <aside className={styles.sidebar} aria-label="Repository management">
        <button
          type="button"
          className={`${styles.navItem} ${!selectedWs ? styles.navActive : ''}`}
          aria-current={!selectedWs ? 'page' : undefined}
          onClick={() => selectWs(null)}
        >
          <House size={15} /> Repositories
        </button>
        <WorkspacesSidebar selectedId={selectedWs} onSelect={selectWs} onNew={() => setDialog('workspace')} />
      </aside>
      <main className={styles.main}>
        {selectedWs ? (
          <WorkspaceView
            workspaceId={selectedWs}
            renderPrs={renderWorkspacePrs}
            renderIssues={renderWorkspaceIssues}
          />
        ) : firstRun ? (
          <WelcomeView
            onOpen={() => void browseAndOpen().then(refresh)}
            onClone={() => setDialog('clone')}
            onInit={() => setDialog('init')}
            onWorkspace={() => setDialog('workspace')}
          />
        ) : (
          <div className={`${styles.inner} ${details ? styles.withDetails : ''}`}>
            <div className={styles.listCol}>
              <div className={styles.header}>
                <h1 className={styles.title}>Repository Management</h1>
                <label className={styles.search}>
                  <Search size={14} aria-hidden />
                  <input
                    ref={searchRef}
                    type="search"
                    placeholder={`Search repositories (${isMac() ? '⌘⌥F' : 'Ctrl+Alt+F'})`}
                    aria-label="Search repositories"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') setFilter('');
                    }}
                  />
                </label>
              </div>
              <div className={styles.actions}>
                <button
                  type="button"
                  className={`primary ${styles.action}`}
                  onClick={() => void browseAndOpen().then(refresh)}
                >
                  <FolderOpen size={16} /> Open
                </button>
                <button type="button" className={styles.action} onClick={() => setDialog('clone')}>
                  <DownloadCloud size={16} /> Clone
                </button>
                <button type="button" className={styles.action} onClick={() => setDialog('init')}>
                  <GitBranchPlus size={16} /> Init
                </button>
                <button type="button" className={styles.action} onClick={() => setDialog('workspace')}>
                  <Layers size={16} /> New workspace
                </button>
                <button type="button" className={styles.action} onClick={() => void newGroup()}>
                  <FolderPlus size={16} /> New group
                </button>
              </div>

              {state.isLoading && <p className={styles.empty}>Loading…</p>}
              {state.error && <p className={styles.empty}>{errorText(state.error)}</p>}
              {data && (
                <div className={styles.table} role="list" aria-label="Repositories">
                  <div className={styles.colHeader} style={{ gridTemplateColumns: gridTemplate }}>
                    <span />
                    {(['name', 'remote', 'branch'] as const).map((c) => (
                      <span key={c} className={styles.colCell}>
                        {c === 'name' ? 'Repository' : c === 'remote' ? 'Remote' : 'Branch'}
                        <div
                          role="separator"
                          aria-orientation="vertical"
                          aria-label={`Resize ${c} column`}
                          className={styles.colResize}
                          onPointerDown={(e) => resizeStart(c, e)}
                          onDoubleClick={() => {
                            const next = { ...cols, [c]: DEFAULT_COLUMN_WIDTHS[c] };
                            setWidths(next);
                            void reposInvoke('repos:columns:save', { columnWidths: next }).catch(
                              () => undefined,
                            );
                          }}
                        />
                      </span>
                    ))}
                    <span>Last opened</span>
                    <span />
                  </div>
                  {views.map(({ group: g, repos }) => {
                    if (g.kind !== 'custom' && g.kind !== 'recent' && repos.length === 0) return null;
                    return (
                      <section
                        key={g.id}
                        className={`${styles.group} ${dragGroup === g.id ? styles.dragging : ''}`}
                        aria-label={g.name}
                        onDragOver={(e) => {
                          if (dragGroup && dragGroup !== g.id) e.preventDefault();
                          else if (g.kind === 'favorites' && dragFav) e.preventDefault();
                        }}
                        onDrop={(e) => {
                          if (dragGroup && dragGroup !== g.id && data) {
                            e.preventDefault();
                            saveGroups(moveGroup(data.groups, dragGroup, g.order));
                            setDragGroup(null);
                          } else if (g.kind === 'favorites' && dragFav) {
                            e.preventDefault();
                            dropFavorite(null);
                          }
                        }}
                      >
                        <header
                          className={styles.groupHeader}
                          draggable
                          onDragStart={(e) => {
                            setDragGroup(g.id);
                            e.dataTransfer.effectAllowed = 'move';
                            e.dataTransfer.setData('text/x-kl-group', g.id);
                          }}
                          onDragEnd={() => setDragGroup(null)}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            groupMenu(g, e);
                          }}
                        >
                          <button
                            type="button"
                            className={styles.groupToggle}
                            aria-expanded={!g.collapsed}
                            onClick={() =>
                              data &&
                              saveGroups(
                                data.groups.map((x) =>
                                  x.id === g.id ? { ...x, collapsed: !x.collapsed } : x,
                                ),
                              )
                            }
                          >
                            {g.collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                            <span
                              className={styles.groupDot}
                              style={{ background: colorVar(g.color) }}
                              aria-hidden
                            />
                            <span style={{ color: colorVar(g.color) }}>{g.name}</span>
                            <span className={styles.count}>{repos.length}</span>
                          </button>
                          <button
                            type="button"
                            className={styles.icon}
                            aria-label={`${g.name} group options`}
                            onClick={(e) => groupMenu(g, e)}
                          >
                            <MoreHorizontal size={15} />
                          </button>
                        </header>
                        {!g.collapsed && (
                          <ul className={styles.list}>
                            {repos.length === 0 ? (
                              <li className={styles.emptyRow}>
                                {g.kind === 'custom'
                                  ? 'Right-click a repository › Add to this group.'
                                  : filter
                                    ? 'No matches.'
                                    : 'Nothing here yet.'}
                              </li>
                            ) : (
                              repos.map((r) => row(r, g))
                            )}
                          </ul>
                        )}
                      </section>
                    );
                  })}
                </div>
              )}
            </div>
            {details && <RepoDetailsPane path={details} onClose={() => setDetails(null)} />}
          </div>
        )}
      </main>
      {showFocus && (
        <aside className={styles.focus} aria-labelledby="focus-title">
          <h2 id="focus-title">Focus</h2>
          {focus}
        </aside>
      )}
    </div>
  );
}
