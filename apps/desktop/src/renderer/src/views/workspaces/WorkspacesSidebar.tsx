import { useQueryClient } from '@tanstack/react-query';
import { Eye, EyeOff, FileCode, Layers, Plus } from 'lucide-react';
import { useState, type MouseEvent } from 'react';

import type { Workspace, WorkspacePatch } from '../../../../shared/ipc/workspaces-contract';
import { prompt } from '../../components/Dialogs';
import { useContextMenu } from '../../components/ContextMenu';
import { wsInvoke } from '../../workspaces/api';
import {
  deleteWorkspace,
  exportWorkspace,
  importCodeWorkspace,
  importWorkspaceJson,
  openWorkspaceRepos,
  toastError,
} from '../../workspaces/actions';
import { useWorkspaces, wk } from '../../workspaces/queries';
import s from './Workspaces.module.css';
import { CloudWorkspacesButton } from '../cloud-workspaces';

export function WorkspaceSwatch({
  ws,
  size = 18,
}: {
  ws: Pick<Workspace, 'color' | 'icon' | 'name'>;
  size?: number;
}) {
  return (
    <span
      className={s.swatch}
      style={{ width: size, height: size, background: ws.color ?? 'var(--kl-panel__bg1)' }}
      aria-hidden
    >
      {ws.icon ?? <Layers size={Math.round(size * 0.66)} />}
    </span>
  );
}

/**
 * WORKSPACES section of the Repository Management sidebar (spec 11 §4.1): list, + New Workspace,
 * drag-reorder, hide/unhide, and a context menu (open all, rename, export, delete).
 */
export function WorkspacesSidebar({
  selectedId,
  onSelect,
  onNew,
}: {
  selectedId: string | null;
  onSelect(id: string | null): void;
  onNew(): void;
}) {
  const qc = useQueryClient();
  const list = useWorkspaces();
  const [showHidden, setShowHidden] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropId, setDropId] = useState<string | null>(null);
  const all = list.data ?? [];
  const hiddenCount = all.filter((w) => w.hidden).length;
  const items = all.filter((w) => showHidden || !w.hidden);

  const reorder = (from: string, to: string): void => {
    const ids = all.map((w) => w.id).filter((id) => id !== from);
    ids.splice(ids.indexOf(to), 0, from);
    qc.setQueryData<Workspace[]>(wk.list(), (old) =>
      old ? ids.map((id) => old.find((w) => w.id === id)!).filter(Boolean) : old,
    );
    void wsInvoke('workspace:reorder', { ids }).catch((e) => toastError('Could not reorder', e));
  };

  const update = (ws: Workspace, patch: WorkspacePatch) =>
    void wsInvoke('workspace:update', { id: ws.id, patch }).catch((e) => toastError('Could not update', e));

  const menu = (e: MouseEvent, ws: Workspace): void => {
    e.preventDefault();
    useContextMenu.getState().show(e.clientX, e.clientY, [
      { label: 'Open all repositories', onSelect: () => void openWorkspaceRepos(ws) },
      'separator',
      {
        label: 'Rename…',
        onSelect: async () => {
          const r = await prompt({ title: 'Rename workspace', initial: ws.name, okLabel: 'Rename' });
          if (r?.value.trim()) update(ws, { name: r.value.trim() });
        },
      },
      { label: ws.hidden ? 'Unhide' : 'Hide', onSelect: () => update(ws, { hidden: !ws.hidden }) },
      { label: 'Export as JSON…', onSelect: () => void exportWorkspace(ws) },
      'separator',
      { label: 'Delete workspace…', danger: true, onSelect: () => void deleteWorkspace(ws) },
    ]);
  };

  return (
    <section className={s.sidebarSection} aria-labelledby="ws-sidebar-title">
      <div className={s.sidebarHeader}>
        <h2 id="ws-sidebar-title">Workspaces</h2>
        <button
          type="button"
          className={s.iconBtn}
          aria-label="Import workspace"
          title="Import .code-workspace or JSON"
          onClick={(e) =>
            useContextMenu.getState().show(e.clientX, e.clientY, [
              { label: 'Import VS Code .code-workspace…', onSelect: () => void importCodeWorkspace() },
              { label: 'Import workspace JSON…', onSelect: () => void importWorkspaceJson() },
            ])
          }
        >
          <FileCode size={14} />
        </button>
        <button
          type="button"
          className={s.iconBtn}
          aria-label="New workspace"
          title="New workspace"
          onClick={onNew}
        >
          <Plus size={15} />
        </button>
      </div>
      <CloudWorkspacesButton className={s.cloudBtn} />
      {list.isLoading && <p className={s.muted}>Loading…</p>}
      {list.data && all.length === 0 && (
        <div className={s.sidebarEmpty}>
          <p className={s.muted}>Group repositories to open, fetch and pull them together.</p>
          <button type="button" className="primary" onClick={onNew}>
            Create a workspace
          </button>
          <button type="button" onClick={() => void importCodeWorkspace()}>
            Import .code-workspace
          </button>
        </div>
      )}
      <ul className={s.wsList} role="listbox" aria-label="Workspaces">
        {items.map((ws) => (
          <li
            key={ws.id}
            role="option"
            aria-selected={ws.id === selectedId}
            tabIndex={0}
            draggable
            className={`${s.wsItem} ${ws.id === selectedId ? s.selected : ''} ${ws.hidden ? s.hiddenWs : ''} ${
              dropId === ws.id && dragId !== ws.id ? s.dropTarget : ''
            }`}
            onClick={() => onSelect(ws.id)}
            onKeyDown={(e) => e.key === 'Enter' && onSelect(ws.id)}
            onDoubleClick={() => void openWorkspaceRepos(ws)}
            onContextMenu={(e) => menu(e, ws)}
            onDragStart={(e) => {
              setDragId(ws.id);
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/x-kl-workspace', ws.id);
            }}
            onDragOver={(e) => {
              if (!dragId) return;
              e.preventDefault();
              setDropId(ws.id);
            }}
            onDragLeave={() => setDropId((d) => (d === ws.id ? null : d))}
            onDrop={(e) => {
              e.preventDefault();
              if (dragId && dragId !== ws.id) reorder(dragId, ws.id);
              setDragId(null);
              setDropId(null);
            }}
            onDragEnd={() => {
              setDragId(null);
              setDropId(null);
            }}
            title={ws.description ?? ws.name}
          >
            <WorkspaceSwatch ws={ws} />
            <span className={s.wsName}>{ws.name}</span>
            <span className={s.wsCount}>{ws.repos.length}</span>
          </li>
        ))}
      </ul>
      {hiddenCount > 0 && (
        <button type="button" className={s.linkBtn} onClick={() => setShowHidden((v) => !v)}>
          {showHidden ? <EyeOff size={13} /> : <Eye size={13} />}
          {showHidden ? 'Hide hidden' : `Show hidden (${hiddenCount})`}
        </button>
      )}
    </section>
  );
}
