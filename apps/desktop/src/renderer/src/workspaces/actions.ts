import type { PullStrategy } from '@githappens/git/ops';

import type { BulkOp, Workspace, WorkspaceRepo } from '../../../shared/ipc/workspaces-contract';
import { confirm } from '../components/Dialogs';
import { invoke } from '../lib/api';
import { useSettingsStore } from '../stores/settings';
import { useTabsStore } from '../stores/tabs';
import { useToastStore } from '../stores/toasts';
import { openInEditor } from '../tools/actions';
import { errorMessage, wsInvoke } from './api';
import { useWorkspaceUi } from './queries';

/** Opening more than this many tabs at once asks first (spec 11 §6.3). */
export const OPEN_CAP = 15;

const toast = useToastStore.getState;

export function toastError(title: string, e: unknown): void {
  toast().push({ kind: 'error', title, body: errorMessage(e) });
}

/** Open the workspace's repos (all, or `repoIds`) as repo tabs. */
export async function openWorkspaceRepos(ws: Workspace, repoIds?: string[]): Promise<void> {
  let r;
  try {
    r = await wsInvoke('workspace:openAll', { workspaceId: ws.id, ...(repoIds ? { repoIds } : {}) });
  } catch (e) {
    return toastError('Could not open repositories', e);
  }
  if (!r.paths.length) {
    toast().push({
      kind: 'info',
      title: 'Nothing to open',
      body: 'None of these repositories are cloned yet.',
    });
    return;
  }
  if (
    r.paths.length > OPEN_CAP &&
    !(await confirm('Open repositories', `Open ${r.paths.length} repositories in new tabs?`, 'Open all'))
  ) {
    return;
  }
  for (const p of r.paths) await useTabsStore.getState().openRepo(p);
  if (r.missing.length) {
    toast().push({
      kind: 'info',
      title: `${r.missing.length} not opened`,
      body: `Not cloned: ${r.missing.slice(0, 5).join(', ')}${r.missing.length > 5 ? '…' : ''}`,
    });
  }
}

/** Bulk "Open ▾ → External editor" (spec 11 §4.1): each cloned repo folder in the configured editor. */
export async function openWorkspaceReposInEditor(ws: Workspace, repoIds?: string[]): Promise<void> {
  let r;
  try {
    r = await wsInvoke('workspace:openAll', { workspaceId: ws.id, ...(repoIds ? { repoIds } : {}) });
  } catch (e) {
    return toastError('Could not open repositories', e);
  }
  if (!r.paths.length) {
    toast().push({
      kind: 'info',
      title: 'Nothing to open',
      body: 'None of these repositories are cloned yet.',
    });
    return;
  }
  if (
    r.paths.length > OPEN_CAP &&
    !(await confirm(
      'Open in editor',
      `Open ${r.paths.length} repositories in the external editor?`,
      'Open all',
    ))
  ) {
    return;
  }
  // Sequential: editors (VS Code, …) cope badly with a burst of launches; stop at the first failure.
  for (const p of r.paths) if ((await openInEditor(p)) === null) return;
}

/** "Launchpad (scoped)" header button: the pinned Launchpad tab scoped to this workspace. */
export function openWorkspaceLaunchpad(ws: Pick<Workspace, 'id'>): void {
  useTabsStore.getState().openLaunchpad({ workspaceId: ws.id });
}

/** "Workspace: Open…" (palette / shortcut): Repo Management with the workspace selected. */
export function openWorkspaceView(workspaceId: string): void {
  useWorkspaceUi.getState().select(workspaceId);
  const tabs = useTabsStore.getState();
  const existing = tabs.tabs.find((t) => t.kind === 'newTab' || t.kind === 'repoManagement');
  if (existing) tabs.activate(existing.id);
  else tabs.newTab();
}

/** Pick a folder for a repo; asks before saving when its remote doesn't match. */
export async function locateRepo(ws: Workspace, repo: WorkspaceRepo): Promise<void> {
  const dir = await invoke('repos:pickFolder', {});
  if (!dir) return;
  try {
    let r = await wsInvoke('workspace:locate', { workspaceId: ws.id, repoId: repo.id, path: dir });
    if (r.mismatch) {
      const ok = await confirm(
        'Remote does not match',
        `“${repo.name}” expects ${r.mismatch.expected}, but that folder's remotes are ${
          r.mismatch.actual.join(', ') || '(none)'
        }. Use it anyway?`,
        'Use folder',
      );
      if (!ok) return;
      r = await wsInvoke('workspace:locate', { workspaceId: ws.id, repoId: repo.id, path: dir, force: true });
    }
    toast().push({ kind: 'success', title: `Located ${repo.name}`, body: r.repo?.localPath });
  } catch (e) {
    toastError('Could not locate repository', e);
  }
}

/** Clone root for missing repos: the workspace default, else ask (and remember it). */
async function cloneRoot(ws: Workspace): Promise<string | null> {
  if (ws.defaultCloneRoot) return ws.defaultCloneRoot;
  // spec 13 `general.defaultCloneDirectory`
  const configured = useSettingsStore.getState().values?.['general.defaultCloneDirectory']?.trim();
  if (configured) return configured;
  const dir = await invoke('repos:pickFolder', {});
  if (!dir) return null;
  await wsInvoke('workspace:update', { id: ws.id, patch: { defaultCloneRoot: dir } }).catch(() => undefined);
  return dir;
}

export async function startBulk(
  ws: Workspace,
  op: BulkOp,
  repoIds: string[],
  options: {
    pullMode?: PullStrategy;
    protocol?: 'https' | 'ssh';
    autostash?: boolean;
    setUpstream?: boolean;
  } = {},
): Promise<void> {
  if (!repoIds.length) return;
  try {
    const extra: { cloneRoot?: string } = {};
    if (op === 'clone') {
      const root = await cloneRoot(ws);
      if (!root) return;
      extra.cloneRoot = root;
    }
    await wsInvoke('workspace:bulk', { workspaceId: ws.id, repoIds, op, options: { ...options, ...extra } });
  } catch (e) {
    toastError(`Could not start ${op}`, e);
  }
}

export async function removeRepos(ws: Workspace, repos: WorkspaceRepo[]): Promise<boolean> {
  if (!repos.length) return false;
  const what = repos.length === 1 ? `“${repos[0]!.name}”` : `${repos.length} repositories`;
  if (
    !(await confirm(
      'Remove from workspace',
      `Remove ${what} from “${ws.name}”? Files on disk are kept.`,
      'Remove',
      true,
    ))
  ) {
    return false;
  }
  try {
    await wsInvoke('workspace:removeRepos', { workspaceId: ws.id, repoIds: repos.map((r) => r.id) });
    return true;
  } catch (e) {
    toastError('Could not remove repositories', e);
    return false;
  }
}

/** Hide repos from the overview (or show them again); files and the workspace's repo list are kept. */
export async function setReposHidden(
  ws: Workspace,
  repos: WorkspaceRepo[],
  hidden: boolean,
): Promise<boolean> {
  if (!repos.length) return false;
  try {
    await wsInvoke('workspace:setReposHidden', {
      workspaceId: ws.id,
      repoIds: repos.map((r) => r.id),
      hidden,
    });
    return true;
  } catch (e) {
    toastError(hidden ? 'Could not hide repositories' : 'Could not show repositories', e);
    return false;
  }
}

export async function deleteWorkspace(ws: Workspace): Promise<void> {
  if (
    !(await confirm(
      'Delete workspace',
      `Delete “${ws.name}”? Repositories on disk are not touched.`,
      'Delete',
      true,
    ))
  ) {
    return;
  }
  try {
    await wsInvoke('workspace:delete', { id: ws.id });
    if (useWorkspaceUi.getState().selectedId === ws.id) useWorkspaceUi.getState().select(null);
  } catch (e) {
    toastError('Could not delete workspace', e);
  }
}

export async function exportWorkspace(ws: Workspace): Promise<void> {
  try {
    const r = await wsInvoke('workspace:exportJson', { workspaceId: ws.id });
    if (r) toast().push({ kind: 'success', title: 'Workspace exported', body: r.path });
  } catch (e) {
    toastError('Could not export workspace', e);
  }
}

export async function importCodeWorkspace(): Promise<Workspace | null> {
  try {
    const r = await wsInvoke('workspace:importCodeWorkspace', {});
    if (!r) return null;
    const skipped = r.skipped.length
      ? ` Skipped ${r.skipped.length}: ${r.skipped
          .slice(0, 4)
          .map((s) => `${s.folder} (${s.reason})`)
          .join(', ')}${r.skipped.length > 4 ? '…' : ''}`
      : '';
    toast().push({
      kind: r.skipped.length ? 'warning' : 'success',
      title: `Imported “${r.workspace.name}”`,
      body: `${r.workspace.repos.length} repositories.${skipped}`,
    });
    useWorkspaceUi.getState().select(r.workspace.id);
    return r.workspace;
  } catch (e) {
    toastError('Could not import VS Code workspace', e);
    return null;
  }
}

export async function importWorkspaceJson(): Promise<void> {
  try {
    const r = await wsInvoke('workspace:importJson', {});
    if (!r?.length) return;
    toast().push({ kind: 'success', title: `Imported ${r.map((w) => `“${w.name}”`).join(', ')}` });
    useWorkspaceUi.getState().select(r[0]!.id);
  } catch (e) {
    toastError('Could not import workspace', e);
  }
}
