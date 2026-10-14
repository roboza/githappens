import { useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  DownloadCloud,
  Eye,
  EyeOff,
  FolderGit2,
  FolderOpen,
  FolderSearch,
  Loader2,
  MapPin,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Rocket,
  Trash2,
  X,
} from 'lucide-react';
import { Fragment, useEffect, useMemo, useState, type MouseEvent, type ReactNode } from 'react';

import {
  isRepoHidden,
  type BulkOpProgress,
  type RepoStatusSummary,
  type Workspace,
  type WorkspacePatch,
  type WorkspaceRepo,
} from '../../../../shared/ipc/workspaces-contract';
import { confirm, prompt } from '../../components/Dialogs';
import { useContextMenu, type MenuEntry } from '../../components/ContextMenu';
import { useWorkspacePrCounts } from '../../launchpad/queries';
import { invoke } from '../../lib/api';
import { formatDate, shortSha } from '../../lib/format';
import { openInEditor } from '../../tools/actions';
import { useSetting } from '../../stores/settings';
import { useTabsStore } from '../../stores/tabs';
import { useToastStore } from '../../stores/toasts';
import { errorMessage, wsInvoke } from '../../workspaces/api';
import {
  deleteWorkspace,
  exportWorkspace,
  locateRepo,
  openWorkspaceLaunchpad,
  openWorkspaceRepos,
  openWorkspaceReposInEditor,
  removeRepos,
  setReposHidden,
  startBulk,
  toastError,
} from '../../workspaces/actions';
import { planPush } from '../../workspaces/push-plan';
import { nextSort, sortRepos, useRepoSort, wipTotal, type RepoSortKey } from '../../workspaces/repo-sort';
import {
  useBranchMatrix,
  useBulkStore,
  useRepoDetails,
  useWorkspace,
  useWorkspaceStatus,
  wk,
} from '../../workspaces/queries';
import { openPrsChip, prCell, withPrCounts } from '../../workspaces/pr-counts';
import { WorkspaceSwatch } from './WorkspacesSidebar';
import s from './Workspaces.module.css';
import { ShareWorkspaceButton } from '../cloud-workspaces';
import { InsightsButton } from '../insights';

type Tab = 'repos' | 'prs' | 'issues' | 'branches';

export interface WorkspaceViewProps {
  workspaceId: string;
  /** Pull Requests tab content (Launchpad list scoped to the workspace). */
  renderPrs?: (workspace: Workspace) => ReactNode;
  /** Issues tab content. */
  renderIssues?: (workspace: Workspace) => ReactNode;
}

const KIND_LABEL: Record<Workspace['kind'], string> = {
  local: 'Local',
  directory: 'Directory-synced',
  cloud: 'Provider',
};

const isoSecs = (iso?: string): number | null => (iso ? Math.floor(Date.parse(iso) / 1000) : null);

function showMenu(e: MouseEvent, items: MenuEntry[]): void {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  useContextMenu.getState().show(r.left, r.bottom + 2, items);
}

/** Bulk push after confirming which branches go where (the one bulk action others can see). */
async function pushRepos(
  ws: Workspace,
  repos: WorkspaceRepo[],
  statuses: Map<string, RepoStatusSummary>,
  setUpstream: boolean,
): Promise<void> {
  const { items, skipped } = planPush(repos, statuses, setUpstream);
  if (!items.length) {
    useToastStore.getState().push({
      kind: 'info',
      title: 'Nothing to push',
      body: setUpstream
        ? 'None of the selected repositories have commits to push.'
        : 'None of the selected repositories have commits to push. Branches without an upstream need “Push and publish new branches”.',
    });
    return;
  }
  const ok = await confirm(
    `Push ${items.length} ${items.length === 1 ? 'branch' : 'branches'}?`,
    <div className={s.pushPlan}>
      <ul>
        {items.map((i) => (
          <li key={i.repo.id}>
            <span className={s.repoName}>{i.repo.name}</span>{' '}
            <span className={s.mono}>
              {i.branch} → {i.target}
            </span>{' '}
            <span className={s.muted}>{i.commits === null ? 'new branch' : `↑${i.commits}`}</span>
          </li>
        ))}
      </ul>
      {skipped > 0 && (
        <p className={s.muted}>
          {skipped} other selected {skipped === 1 ? 'repository' : 'repositories'} will be skipped (nothing to
          push, behind their upstream, or no upstream branch).
        </p>
      )}
    </div>,
    'Push',
  );
  if (ok)
    void startBulk(
      ws,
      'push',
      repos.map((r) => r.id),
      setUpstream ? { setUpstream: true } : {},
    );
}

/** Workspace overview (spec 11 §4.1): header, summary chips, bulk toolbar and the tabs. */
export function WorkspaceView({ workspaceId, renderPrs, renderIssues }: WorkspaceViewProps) {
  const ws = useWorkspace(workspaceId);
  if (!ws) return <p className={s.muted}>This workspace no longer exists.</p>;
  return <WorkspaceBody key={ws.id} ws={ws} renderPrs={renderPrs} renderIssues={renderIssues} />;
}

function WorkspaceBody({
  ws,
  renderPrs,
  renderIssues,
}: {
  ws: Workspace;
  renderPrs?: WorkspaceViewProps['renderPrs'];
  renderIssues?: WorkspaceViewProps['renderIssues'];
}) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('repos');
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [showHidden, setShowHidden] = useState(false);
  const status = useWorkspaceStatus(ws.id);
  const run = useBulkStore((st) => st.runs[ws.id]);
  // Open PRs per repo come from the Launchpad layer (spec 11 §4.1 `RepoStatusSummary.openPrs`).
  const prCounts = useWorkspacePrCounts(ws.id);
  const byId = useMemo(
    () =>
      new Map(
        withPrCounts(status.data ?? [], prCounts.data?.counts, prCounts.data?.complete).map((x) => [
          x.workspaceRepoId,
          x,
        ]),
      ),
    [status.data, prCounts.data],
  );

  useEffect(() => {
    if (run?.finished) {
      void qc.invalidateQueries({ queryKey: wk.status(ws.id) });
      void qc.invalidateQueries({ queryKey: wk.branches(ws.id) });
    }
  }, [run?.finished, run?.bulkId, qc, ws.id]);

  const running = !!run && !run.finished;
  const visible = ws.repos.filter((r) => !isRepoHidden(ws, r));
  const hiddenCount = ws.repos.length - visible.length;
  // Hidden repos are never part of a selection.
  const selected = visible.filter((r) => checked.has(r.id));
  const ids = selected.map((r) => r.id);
  const preferSsh = useSetting('ssh.preferSshForProviders') === true;
  const missingSel = selected.filter((r) => {
    const st = byId.get(r.id);
    return st ? !st.exists : !r.localPath;
  });

  const chips = useMemo(() => {
    const sums = ws.repos.filter((r) => !isRepoHidden(ws, r)).map((r) => byId.get(r.id));
    return {
      missing: sums.filter((x) => x && !x.exists).length,
      changes: sums.filter((x) => wipTotal(x) > 0).length,
      behind: sums.filter((x) => (x?.behind ?? 0) > 0).length,
      problems: sums.filter((x) => x?.operationInProgress || (x?.exists && x.error)).length,
      prs: openPrsChip(
        sums.reduce((n, x) => n + (x?.openPrs?.total ?? 0), 0),
        sums.reduce((n, x) => n + (x?.openPrs?.needsMyReview ?? 0), 0),
      ),
    };
  }, [ws, byId]);

  const refresh = (): void => {
    void wsInvoke('workspace:status', { workspaceId: ws.id, force: true })
      .then((data) => qc.setQueryData(wk.status(ws.id), data))
      .catch((e) => toastError('Could not refresh', e));
    void qc.invalidateQueries({ queryKey: wk.branches(ws.id) });
  };

  const update = (patch: WorkspacePatch) => void updateWs(ws, patch);

  const addMenu = (e: MouseEvent): void =>
    showMenu(e, [
      {
        label: 'Add repository folder…',
        onSelect: async () => {
          const dir = await invoke('repos:pickFolder', {});
          if (!dir) return;
          await wsInvoke('workspace:addRepos', { workspaceId: ws.id, repos: [{ localPath: dir }] }).catch(
            (err) => toastError('Could not add repository', err),
          );
        },
      },
      {
        label: 'Scan a folder for repositories…',
        onSelect: async () => {
          const dir = await invoke('repos:pickFolder', {});
          if (!dir) return;
          try {
            const r = await wsInvoke('workspace:scanDirectory', { root: dir });
            if (!r.repos.length) return toastError('No repositories found', new Error(dir));
            await wsInvoke('workspace:addRepos', {
              workspaceId: ws.id,
              repos: r.repos.map((x) => ({ localPath: x.path, name: x.name })),
            });
          } catch (err) {
            toastError('Could not add repositories', err);
          }
        },
      },
    ]);

  const moreMenu = (e: MouseEvent): void =>
    showMenu(e, [
      {
        label: 'Edit description…',
        onSelect: async () => {
          const r = await prompt({ title: 'Description', initial: ws.description ?? '', okLabel: 'Save' });
          if (r) update({ description: r.value });
        },
      },
      {
        label: ws.defaultCloneRoot ? `Clone folder: ${ws.defaultCloneRoot}` : 'Set clone folder…',
        onSelect: async () => {
          const dir = await invoke('repos:pickFolder', {});
          if (dir) update({ defaultCloneRoot: dir });
        },
      },
      {
        label: ws.hidden ? 'Unhide in sidebar' : 'Hide in sidebar',
        onSelect: () => update({ hidden: !ws.hidden }),
      },
      { label: 'Export as JSON…', onSelect: () => void exportWorkspace(ws) },
      'separator',
      { label: 'Delete workspace…', danger: true, onSelect: () => void deleteWorkspace(ws) },
    ]);

  return (
    <div className={s.view}>
      <header className={s.header}>
        <WorkspaceSwatch ws={ws} size={32} />
        <div className={s.headerText}>
          <InlineName ws={ws} />
          {ws.description && <p className={s.description}>{ws.description}</p>}
          {ws.directory && <p className={s.description}>Synced with {ws.directory.root}</p>}
        </div>
        <span className={s.kindBadge}>{KIND_LABEL[ws.kind]}</span>
        <div className={s.headerButtons}>
          <button type="button" onClick={() => void openWorkspaceRepos(ws)} disabled={!ws.repos.length}>
            <FolderGit2 size={14} /> Open all
          </button>
          <button
            type="button"
            title="Open the Launchpad scoped to this workspace"
            onClick={() => openWorkspaceLaunchpad(ws)}
          >
            <Rocket size={14} /> Launchpad
          </button>
          <InsightsButton workspaceId={ws.id} />
          <ShareWorkspaceButton workspaceId={ws.id} />
          <button type="button" aria-label="Refresh" title="Refresh status" onClick={refresh}>
            <RefreshCw size={14} className={status.isFetching ? s.spin : undefined} />
          </button>
          <button type="button" aria-label="More actions" title="More actions" onClick={moreMenu}>
            <MoreHorizontal size={14} />
          </button>
        </div>
      </header>

      <div className={s.chips} aria-label="Summary">
        <span className={s.chip}>{visible.length} repos</span>
        {chips.missing > 0 && <span className={`${s.chip} ${s.chipWarn}`}>{chips.missing} missing</span>}
        {chips.changes > 0 && <span className={s.chip}>{chips.changes} with changes</span>}
        {chips.behind > 0 && <span className={s.chip}>{chips.behind} behind</span>}
        {chips.prs && (
          <button
            type="button"
            className={`${s.chip} ${s.chipLink}`}
            title="Show the workspace's pull requests"
            onClick={() => setTab('prs')}
          >
            {chips.prs}
          </button>
        )}
        {chips.problems > 0 && (
          <span className={`${s.chip} ${s.chipWarn}`}>{chips.problems} need attention</span>
        )}
      </div>

      <div className={s.toolbar} role="toolbar" aria-label="Bulk actions">
        <button
          type="button"
          disabled={!missingSel.length || running}
          title="Clone the selected repositories that are not on this machine"
          onClick={(e) =>
            showMenu(
              e,
              // Preferred protocol first (Preferences → SSH "Prefer SSH URLs when cloning from providers").
              ((preferSsh ? ['ssh', 'https'] : ['https', 'ssh']) as Array<'https' | 'ssh'>).map(
                (protocol, i) => ({
                  label: `Clone via ${protocol === 'ssh' ? 'SSH' : 'HTTPS'}${i === 0 ? ' (preferred)' : ''}`,
                  onSelect: () =>
                    void startBulk(
                      ws,
                      'clone',
                      missingSel.map((r) => r.id),
                      { protocol },
                    ),
                }),
              ),
            )
          }
        >
          <DownloadCloud size={14} /> Clone <ChevronDown size={12} />
        </button>
        <button
          type="button"
          disabled={!ids.length || running}
          onClick={() => void startBulk(ws, 'fetch', ids)}
        >
          <ArrowDown size={14} /> Fetch
        </button>
        <button
          type="button"
          disabled={!ids.length || running}
          onClick={(e) =>
            showMenu(e, [
              {
                label: 'Pull (fast-forward if possible)',
                onSelect: () => void startBulk(ws, 'pull', ids, { pullMode: 'ff-if-possible' }),
              },
              {
                label: 'Pull (fast-forward only)',
                onSelect: () => void startBulk(ws, 'pull', ids, { pullMode: 'ff-only' }),
              },
              {
                label: 'Pull (rebase)',
                onSelect: () => void startBulk(ws, 'pull', ids, { pullMode: 'rebase' }),
              },
              {
                label: 'Pull (rebase, autostash)',
                onSelect: () => void startBulk(ws, 'pull', ids, { pullMode: 'rebase', autostash: true }),
              },
            ])
          }
        >
          <ArrowDown size={14} /> Pull <ChevronDown size={12} />
        </button>
        <button
          type="button"
          disabled={!ids.length || running}
          title="Push the current branch of the selected repositories"
          onClick={(e) =>
            showMenu(e, [
              { label: 'Push', onSelect: () => void pushRepos(ws, selected, byId, false) },
              {
                label: 'Push and publish new branches to origin',
                onSelect: () => void pushRepos(ws, selected, byId, true),
              },
            ])
          }
        >
          <ArrowUp size={14} /> Push <ChevronDown size={12} />
        </button>
        <button
          type="button"
          disabled={!ids.length}
          onClick={(e) =>
            showMenu(e, [
              { label: 'Open in GitHappens', onSelect: () => void openWorkspaceRepos(ws, ids) },
              { label: 'Open in external editor', onSelect: () => void openWorkspaceReposInEditor(ws, ids) },
            ])
          }
        >
          <FolderOpen size={14} /> Open <ChevronDown size={12} />
        </button>
        <button
          type="button"
          disabled={selected.length !== 1}
          title="Choose where this repository is on disk"
          onClick={() => void locateRepo(ws, selected[0]!)}
        >
          <MapPin size={14} /> Locate
        </button>
        <button
          type="button"
          disabled={!selected.length}
          title="Hide the selected repositories from this list"
          onClick={() => void setReposHidden(ws, selected, true).then((ok) => ok && setChecked(new Set()))}
        >
          <EyeOff size={14} /> Hide
        </button>
        {ws.kind !== 'directory' && (
          <button
            type="button"
            disabled={!selected.length}
            onClick={() => void removeRepos(ws, selected).then((ok) => ok && setChecked(new Set()))}
          >
            <Trash2 size={14} /> Remove
          </button>
        )}
        <span style={{ flex: 1 }} />
        {hiddenCount > 0 && (
          <label className={s.showHidden}>
            <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
            Show hidden ({hiddenCount})
          </label>
        )}
        {running && (
          <button type="button" onClick={() => void wsInvoke('workspace:bulkCancel', { bulkId: run.bulkId })}>
            <X size={14} /> Cancel {run.op}
          </button>
        )}
        {ws.kind !== 'directory' && (
          <button type="button" onClick={addMenu}>
            <Plus size={14} /> Add repositories <ChevronDown size={12} />
          </button>
        )}
      </div>

      <div className={s.tabs} role="tablist">
        {(
          [
            ['repos', 'Repositories'],
            ['prs', 'Pull Requests'],
            ['issues', 'Issues'],
            ['branches', 'Branches'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={s.tab}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className={s.tabBody}>
        {tab === 'repos' &&
          (ws.repos.length === 0 ? (
            <div className={s.emptyState}>
              <p className={s.muted}>
                {ws.kind === 'directory'
                  ? 'No repositories under this folder yet.'
                  : 'This workspace has no repositories.'}
              </p>
              {ws.kind !== 'directory' && (
                <button type="button" className="primary" onClick={addMenu}>
                  <FolderSearch size={14} /> Add repositories
                </button>
              )}
            </div>
          ) : !visible.length && !showHidden ? (
            <div className={s.emptyState}>
              <p className={s.muted}>All repositories in this workspace are hidden.</p>
              <button type="button" onClick={() => setShowHidden(true)}>
                <Eye size={14} /> Show hidden
              </button>
            </div>
          ) : (
            <RepoOverviewTable
              ws={ws}
              repos={showHidden ? ws.repos : visible}
              statuses={byId}
              loading={status.isPending}
              rows={run?.rows ?? {}}
              checked={checked}
              setChecked={setChecked}
            />
          ))}
        {tab === 'prs' &&
          (renderPrs?.(ws) ?? (
            <p className={s.muted}>
              Pull requests for this workspace appear here once Launchpad is available.
            </p>
          ))}
        {tab === 'issues' &&
          (renderIssues?.(ws) ?? (
            <p className={s.muted}>Issues for this workspace appear here once Launchpad is available.</p>
          ))}
        {tab === 'branches' && <BranchMatrixTab ws={ws} />}
      </div>
    </div>
  );
}

function updateWs(ws: Workspace, patch: WorkspacePatch) {
  return wsInvoke('workspace:update', { id: ws.id, patch }).catch((e) =>
    toastError('Could not update workspace', e),
  );
}

function InlineName({ ws }: { ws: Workspace }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(ws.name);
  if (!editing) {
    return (
      <h1 className={s.wsTitle} title="Click to rename" onClick={() => (setValue(ws.name), setEditing(true))}>
        {ws.name}
      </h1>
    );
  }
  const commit = (): void => {
    setEditing(false);
    if (value.trim() && value.trim() !== ws.name) void updateWs(ws, { name: value.trim() });
  };
  return (
    <input
      className={s.nameInput}
      aria-label="Workspace name"
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') setEditing(false);
      }}
    />
  );
}

function RowState({ st, row }: { st?: RepoStatusSummary; row?: BulkOpProgress }) {
  if (row && (row.state === 'running' || row.state === 'queued')) {
    const pct = row.progress !== undefined ? ` ${Math.round(row.progress * 100)}%` : '';
    return (
      <span className={s.state} title={row.message}>
        <Loader2 size={14} className={row.state === 'running' ? s.spin : s.muted} />
        <span className={s.stateText}>
          {row.state === 'queued' ? 'Queued' : `${row.message ?? 'Running'}${pct}`}
        </span>
      </span>
    );
  }
  if (row?.state === 'failed') {
    return (
      <span className={`${s.state} ${s.bad}`} title={row.message}>
        <AlertTriangle size={14} /> <span className={s.stateText}>{row.message}</span>
      </span>
    );
  }
  if (row && (row.state === 'done' || row.state === 'skipped')) {
    return (
      <span className={`${s.state} ${row.state === 'done' ? s.good : s.muted}`} title={row.message}>
        {row.state === 'done' ? <Check size={14} /> : <X size={14} />}
        <span className={s.stateText}>{row.message}</span>
      </span>
    );
  }
  if (!st) return null;
  if (st.operationInProgress) {
    return (
      <span className={`${s.state} ${s.warn}`}>
        <AlertTriangle size={14} /> <span className={s.stateText}>{st.operationInProgress} in progress</span>
      </span>
    );
  }
  if (st.error && st.exists) {
    return (
      <span className={`${s.state} ${s.warn}`} title={st.error}>
        <AlertTriangle size={14} />{' '}
        <span className={s.stateText}>{st.error === 'Status timed out' ? 'Unavailable' : st.error}</span>
      </span>
    );
  }
  return st.exists ? <Check size={14} className={s.good} aria-label="OK" /> : null;
}

/** Sortable column heading; clicking cycles first direction → other direction → workspace order. */
function SortTh({ k, label, title }: { k: RepoSortKey; label: string; title?: string }) {
  const sort = useRepoSort((st) => st.sort);
  const active = sort?.key === k ? sort.dir : null;
  return (
    <th title={title} aria-sort={active === 'asc' ? 'ascending' : active === 'desc' ? 'descending' : 'none'}>
      <button
        type="button"
        className={`${s.sortBtn} ${active ? s.sortActive : ''}`}
        onClick={() => useRepoSort.getState().setSort(nextSort(sort, k))}
      >
        {label}
        {active === 'asc' ? <ChevronUp size={12} /> : active === 'desc' ? <ChevronDown size={12} /> : null}
      </button>
    </th>
  );
}

function RepoOverviewTable({
  ws,
  repos,
  statuses,
  loading,
  rows,
  checked,
  setChecked,
}: {
  ws: Workspace;
  /** Rows to show (hidden repos only when "Show hidden" is on). */
  repos: WorkspaceRepo[];
  statuses: Map<string, RepoStatusSummary>;
  loading: boolean;
  rows: Record<string, BulkOpProgress>;
  checked: Set<string>;
  setChecked(fn: (c: Set<string>) => Set<string>): void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const sort = useRepoSort((st) => st.sort);
  const rowsInOrder = useMemo(() => sortRepos(repos, statuses, sort), [repos, statuses, sort]);
  const selectable = repos.filter((r) => !isRepoHidden(ws, r));
  const allChecked = selectable.length > 0 && selectable.every((r) => checked.has(r.id));
  const toggle = (id: string, on: boolean): void =>
    setChecked((c) => {
      const next = new Set(c);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const open = (r: WorkspaceRepo): void => {
    if (r.localPath && statuses.get(r.id)?.exists) void useTabsStore.getState().openRepo(r.localPath);
  };

  const rowMenu = (e: MouseEvent, r: WorkspaceRepo, st?: RepoStatusSummary): void => {
    e.preventDefault();
    if (isRepoHidden(ws, r)) {
      useContextMenu.getState().show(e.clientX, e.clientY, [
        { label: 'Unhide', onSelect: () => void setReposHidden(ws, [r], false) },
        { label: 'Locate…', onSelect: () => void locateRepo(ws, r) },
      ]);
      return;
    }
    useContextMenu.getState().show(e.clientX, e.clientY, [
      { label: 'Open', disabled: !st?.exists, onSelect: () => open(r) },
      {
        label: 'Open in external editor',
        disabled: !st?.exists,
        onSelect: () => r.localPath && void openInEditor(r.localPath),
      },
      { label: 'Fetch', disabled: !st?.exists, onSelect: () => void startBulk(ws, 'fetch', [r.id]) },
      { label: 'Pull', disabled: !st?.exists, onSelect: () => void startBulk(ws, 'pull', [r.id]) },
      {
        label: 'Push',
        disabled: !st?.exists,
        // A single repo without an upstream is published (the confirmation says so).
        onSelect: () => void pushRepos(ws, [r], statuses, !st?.upstream),
      },
      { label: 'Clone…', disabled: !!st?.exists, onSelect: () => void startBulk(ws, 'clone', [r.id]) },
      { label: 'Locate…', onSelect: () => void locateRepo(ws, r) },
      {
        label: 'Show in folder',
        disabled: !st?.exists,
        onSelect: () => r.localPath && void invoke('shell:openPath', { path: r.localPath }),
      },
      ...(r.provider?.webUrl
        ? [
            {
              label: 'Open on provider',
              onSelect: () => void invoke('shell:openExternal', { url: r.provider!.webUrl }),
            },
          ]
        : []),
      'separator',
      {
        label: 'Hide from this list',
        onSelect: () =>
          void setReposHidden(ws, [r], true).then((ok) => ok && checked.has(r.id) && toggle(r.id, false)),
      },
      ...(ws.kind !== 'directory'
        ? [{ label: 'Remove from workspace', danger: true, onSelect: () => void removeRepos(ws, [r]) }]
        : []),
    ]);
  };

  return (
    <div className={s.tableWrap}>
      <table className={s.table}>
        <thead>
          <tr>
            <th className={s.checkCol}>
              <input
                type="checkbox"
                aria-label="Select all repositories"
                checked={allChecked}
                onChange={(e) =>
                  setChecked(() => (e.target.checked ? new Set(selectable.map((r) => r.id)) : new Set()))
                }
              />
            </th>
            <SortTh k="name" label="Repository" />
            <SortTh k="branch" label="Branch" />
            <SortTh k="sync" label="↑↓" title="Ahead / behind upstream (sorts by behind, then ahead)" />
            <SortTh k="wip" label="WIP" title="Files changed" />
            <SortTh k="stash" label="Stash" title="Stashes" />
            <SortTh k="prs" label="PRs" title="Open pull requests: mine / total" />
            <SortTh k="fetched" label="Fetched" />
            <SortTh k="status" label="Status" title="Sorts the repos that need attention first" />
          </tr>
        </thead>
        <tbody>
          {rowsInOrder.map((r) => {
            const hidden = isRepoHidden(ws, r);
            const st = statuses.get(r.id);
            const row = rows[r.id];
            const missing = st && !st.exists;
            const isOpen = expanded === r.id;
            const wip = wipTotal(st);
            const fetched = isoSecs(st?.lastFetchAt);
            return (
              <Fragment key={r.id}>
                <tr
                  className={`${s.row} ${checked.has(r.id) ? s.rowChecked : ''} ${hidden ? s.rowHidden : ''}`}
                  onClick={() => setExpanded(isOpen ? null : r.id)}
                  onDoubleClick={() => open(r)}
                  onContextMenu={(e) => rowMenu(e, r, st)}
                >
                  <td className={s.checkCol} onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      aria-label={`Select ${r.name}`}
                      disabled={hidden}
                      title={hidden ? 'Unhide this repository to select it' : undefined}
                      checked={!hidden && checked.has(r.id)}
                      onChange={(e) => toggle(r.id, e.target.checked)}
                    />
                  </td>
                  <td>
                    <div className={s.nameCell}>
                      <span className={s.expander} aria-hidden>
                        {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                      </span>
                      <span className={s.repoMeta}>
                        <span className={s.repoName}>
                          {r.name}
                          {r.provider && (
                            <span className={s.providerTag}>{r.provider.integrationKey.split(':')[0]}</span>
                          )}
                        </span>
                        {missing ? (
                          <span className={s.notCloned}>
                            {r.localPath ? 'Folder missing' : 'Not cloned'}
                            <button
                              type="button"
                              className={s.inlineBtn}
                              onClick={(e) => {
                                e.stopPropagation();
                                void startBulk(ws, 'clone', [r.id]);
                              }}
                            >
                              Clone
                            </button>
                            <button
                              type="button"
                              className={s.inlineBtn}
                              onClick={(e) => {
                                e.stopPropagation();
                                void locateRepo(ws, r);
                              }}
                            >
                              Locate…
                            </button>
                          </span>
                        ) : (
                          <span className={s.repoPath}>{r.localPath}</span>
                        )}
                      </span>
                    </div>
                  </td>
                  <td className={s.mono}>
                    {st?.head
                      ? st.head.detached
                        ? `(${shortSha(st.head.sha) || 'detached'})`
                        : st.head.branch
                      : ''}
                  </td>
                  <td className={s.ab}>
                    {st?.upstream ? (
                      <>
                        {st.ahead > 0 && (
                          <span>
                            <ArrowUp size={11} />
                            {st.ahead}
                          </span>
                        )}
                        {st.behind > 0 && (
                          <span className={s.behind}>
                            <ArrowDown size={11} />
                            {st.behind}
                          </span>
                        )}
                        {!st.ahead && !st.behind && <span className={s.muted}>✓</span>}
                      </>
                    ) : st?.isRepo ? (
                      <span className={s.muted} title="No upstream">
                        —
                      </span>
                    ) : null}
                  </td>
                  <td
                    title={
                      st
                        ? `${st.wip.staged} staged · ${st.wip.unstaged} unstaged · ${st.wip.untracked} untracked · ${st.wip.conflicted} conflicted`
                        : undefined
                    }
                  >
                    {wip > 0 ? (
                      <span className={st!.wip.conflicted ? s.bad : s.wip}>{wip}</span>
                    ) : st?.isRepo ? (
                      <span className={s.muted}>0</span>
                    ) : null}
                  </td>
                  <td>{st?.stashCount ? st.stashCount : ''}</td>
                  <td title={prCell(st?.openPrs).title}>
                    {st?.openPrs ? (
                      <span className={st.openPrs.needsMyReview ? s.wip : undefined}>
                        {prCell(st.openPrs).text}
                      </span>
                    ) : (
                      <span className={s.muted}>—</span>
                    )}
                  </td>
                  <td className={s.muted}>{fetched ? formatDate(fetched) : st?.isRepo ? 'never' : ''}</td>
                  <td>
                    {hidden ? (
                      <span className={`${s.state} ${s.muted}`}>
                        <EyeOff size={14} /> <span className={s.stateText}>Hidden</span>
                        <button
                          type="button"
                          className={s.inlineBtn}
                          onClick={(e) => {
                            e.stopPropagation();
                            void setReposHidden(ws, [r], false);
                          }}
                        >
                          Unhide
                        </button>
                      </span>
                    ) : loading && !st ? (
                      <Loader2 size={14} className={s.spin} />
                    ) : (
                      <RowState st={st} row={row} />
                    )}
                  </td>
                </tr>
                {isOpen && (
                  <tr className={s.detailRow}>
                    <td />
                    <td colSpan={8}>
                      <RepoDetails ws={ws} repo={r} exists={!!st?.exists} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function RepoDetails({ ws, repo, exists }: { ws: Workspace; repo: WorkspaceRepo; exists: boolean }) {
  const q = useRepoDetails(ws.id, repo.id, exists);
  if (!exists) return <p className={s.muted}>Clone or locate this repository to see its branches.</p>;
  if (q.isPending) return <p className={s.muted}>Loading…</p>;
  if (q.error) return <p className={s.bad}>{errorMessage(q.error)}</p>;
  return (
    <div className={s.details}>
      <div>
        <h4>Local branches</h4>
        <ul>
          {q.data.branches.map((b) => (
            <li key={b.name} className={b.current ? s.current : undefined}>
              <span className={s.mono}>{b.name}</span>
              {b.upstream ? (
                <span className={s.muted}>
                  {' '}
                  → {b.upstream}
                  {b.gone ? ' (gone)' : `${b.ahead ? ` ↑${b.ahead}` : ''}${b.behind ? ` ↓${b.behind}` : ''}`}
                </span>
              ) : (
                <span className={s.muted}> (local only)</span>
              )}
            </li>
          ))}
        </ul>
      </div>
      <div>
        <h4>Recent commits</h4>
        <ul>
          {q.data.commits.map((c) => (
            <li key={c.sha}>
              <span className={s.mono}>{shortSha(c.sha)}</span> {c.subject}{' '}
              <span className={s.muted}>
                — {c.author}, {formatDate(c.date)}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function BranchMatrixTab({ ws }: { ws: Workspace }) {
  const q = useBranchMatrix(ws.id);
  if (q.isPending) return <p className={s.muted}>Loading branches…</p>;
  if (q.error) return <p className={s.bad}>{errorMessage(q.error)}</p>;
  if (!q.data.rows.length) {
    return <p className={s.muted}>No branch name is shared by two or more cloned repositories.</p>;
  }
  return (
    <div className={s.tableWrap}>
      <table className={`${s.table} ${s.matrix}`}>
        <thead>
          <tr>
            <th>Branch</th>
            {q.data.repos.map((r) => (
              <th key={r.repoId}>{r.name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {q.data.rows.map((row) => (
            <tr key={row.branch}>
              <td className={s.mono}>{row.branch}</td>
              {q.data.repos.map((r) => {
                const c = row.cells[r.repoId];
                return (
                  <td key={r.repoId} title={c?.upstream}>
                    {!c ? (
                      <span className={s.muted}>—</span>
                    ) : c.gone ? (
                      <span className={s.warn}>gone</span>
                    ) : !c.upstream ? (
                      <span className={s.muted}>local</span>
                    ) : c.ahead || c.behind ? (
                      <span>
                        {c.ahead ? `↑${c.ahead}` : ''}{' '}
                        {c.behind ? <span className={s.behind}>↓{c.behind}</span> : ''}
                      </span>
                    ) : (
                      <span className={s.good}>✓</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
