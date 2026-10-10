import type { RepoId } from '@githappens/git/types';
import { create } from 'zustand';

import type {
  ExternalDiffRequest,
  LaunchResult,
  MergeToolResult,
  ToolPathRef,
} from '../../../shared/ipc/tools-contract';
import { confirm } from '../components/Dialogs';
import { invoke, IpcError } from '../lib/api';
import { showError, runOp } from '../lib/ops';
import { useRepoUiStore } from '../stores/repo-ui';
import { useSettingsStore } from '../stores/settings';
import { useToastStore } from '../stores/toasts';
import { openToolsPreferences, toolsInvoke } from './api';

/**
 * Renderer API for external tools / "Open in…" (spec 12 §4.10, spec 07 §4.12 / §6.9, spec 08 §4.8). Every
 * function reports failures as a toast and never throws; "not found" errors offer Preferences → External Tools.
 *
 * Paths are absolute strings, or `{ repoId, path }` with a repo-relative path (main resolves and validates it).
 */

export type RepoFile = { repoId: RepoId; path: string };
export type PathTarget = string | RepoFile;

const ref = (t: PathTarget): ToolPathRef =>
  typeof t === 'string' ? { path: t } : { repoId: t.repoId, path: t.path };

/** Toast for a failed tool call; tool-not-found errors get an "Open Preferences" button. */
export function reportToolError(e: unknown): void {
  if (e instanceof IpcError) {
    if (e.error.details?.toolNotFound) {
      useToastStore.getState().push({
        kind: 'error',
        title: e.message,
        body: 'Choose the tool in Preferences → External Tools.',
        actions: [{ label: 'Open Preferences', run: openToolsPreferences }],
      });
      return;
    }
    if (!e.error.command) {
      useToastStore.getState().push({ kind: 'error', title: e.message });
      return;
    }
    showError(e.error);
    return;
  }
  useToastStore.getState().push({ kind: 'error', title: e instanceof Error ? e.message : String(e) });
}

async function guard<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (e) {
    reportToolError(e);
    return null;
  }
}

/** Open a file (optionally at a line) or folder in the configured external editor. */
export function openInEditor(target: PathTarget, line?: number): Promise<LaunchResult | null> {
  return guard(toolsInvoke('open:editor', { ...ref(target), ...(line ? { line } : {}) }));
}

/** Open the configured external terminal in a folder (a repo root, or `{ repoId, path: '' }`). */
export function openInTerminal(cwd: PathTarget): Promise<LaunchResult | null> {
  const r = ref(cwd);
  return guard(toolsInvoke('open:terminal', { cwd: r.path, ...(r.repoId ? { repoId: r.repoId } : {}) }));
}

/** Reveal a file in Explorer / Finder / the file manager (a folder is opened). */
export function showInFolder(target: PathTarget): Promise<LaunchResult | null> {
  return guard(toolsInvoke('open:fileManager', ref(target)));
}

/** Open with the OS default application. */
export function openDefault(target: PathTarget): Promise<LaunchResult | null> {
  return guard(toolsInvoke('open:default', ref(target)));
}

/** Open one file's change in the configured external diff tool (or `git difftool`). */
export function openExternalDiff(req: ExternalDiffRequest): Promise<LaunchResult | null> {
  return guard(toolsInvoke('tools:openDiff', req));
}

/** Copy a repo file's absolute path to the clipboard. */
export async function copyFullPath(target: PathTarget): Promise<void> {
  const r = ref(target);
  const abs = r.repoId
    ? await guard(toolsInvoke('tools:resolvePath', { repoId: r.repoId, path: r.path }))
    : r;
  if (!abs) return;
  await invoke('shell:copyText', { text: abs.path });
  useToastStore
    .getState()
    .push({ kind: 'success', title: 'Copied full path', body: abs.path, timeoutMs: 2500 });
}

export const showInFolderLabel = (): string => {
  const p = typeof window !== 'undefined' ? window.api?.platform : undefined;
  return p === 'win32' ? 'Show in Explorer' : p === 'darwin' ? 'Reveal in Finder' : 'Show in folder';
};

// ---- external merge tool -------------------------------------------------------------------------------

interface MergeWait {
  waitId: string;
  /** Configured tool for the "Waiting for …" overlay. */
  tool: string;
}

/** External merge tool sessions in flight, keyed by `repoId\0path` (spec 08 §4.8 waiting overlay). */
export const useMergeToolWaits = create<{ waits: Record<string, MergeWait> }>(() => ({ waits: {} }));
export const mergeWaitKey = (repoId: RepoId, path: string): string => `${repoId}\u0000${path}`;

const setWait = (key: string, w: MergeWait | null): void =>
  useMergeToolWaits.setState((s) => {
    const waits = { ...s.waits };
    if (w) waits[key] = w;
    else delete waits[key];
    return { waits };
  });

/** Settings label of the configured merge tool ("Beyond Compare", "git mergetool"…). */
export function configuredMergeToolLabel(): string {
  const id = useSettingsStore.getState().values?.['tools.mergeTool'] ?? 'none';
  const d = useSettingsStore.getState().registry.find((x) => x.key === 'tools.mergeTool');
  return d?.enumLabels?.[id] ?? id;
}

/** Whether a merge tool is configured (so "Open in external merge tool" can be offered as enabled). */
export const mergeToolConfigured = (): boolean =>
  (useSettingsStore.getState().values?.['tools.mergeTool'] ?? 'none') !== 'none';

/**
 * Resolve one conflicted file in the external merge tool and wait for it (spec 08 §4.8). On exit 0 with
 * "trust exit code" — or when the tool changed the file and left no markers — main marks it resolved through the
 * op queue; otherwise the file stays unmerged and the user is told why.
 */
export async function openExternalMergeTool(repoId: RepoId, path: string): Promise<MergeToolResult | null> {
  const key = mergeWaitKey(repoId, path);
  if (useMergeToolWaits.getState().waits[key]) return null; // already waiting
  const waitId = `mt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  setWait(key, { waitId, tool: configuredMergeToolLabel() });
  let r: MergeToolResult | null;
  try {
    r = await guard(toolsInvoke('tools:mergeTool', { repoId, path, waitId }));
  } finally {
    setWait(key, null);
  }
  window.dispatchEvent(new CustomEvent('kl:external-merge-done', { detail: { repoId, path } }));
  if (!r) return null;
  const toast = useToastStore.getState().push;
  const name = path.split('/').pop() ?? path;
  if (r.cancelled)
    toast({ kind: 'info', title: `Stopped waiting for ${r.tool}`, body: `${name} was not marked resolved.` });
  else if (r.resolved) toast({ kind: 'success', title: `Resolved ${name} with ${r.tool}` });
  else if (r.changed && !r.hasMarkers) {
    // Output looks merged but the tool did not report success (spec 08 §4.8): ask.
    const ok = await confirm(
      'Mark as resolved?',
      `${r.tool} changed ${path}${r.exitCode !== null ? ` and exited with code ${r.exitCode}` : ''}. Mark it as resolved?`,
      'Mark resolved',
    );
    if (ok && (await runOp(repoId, { type: 'conflict.markResolved', paths: [path] }).catch(() => null))) {
      r = { ...r, resolved: true };
    }
  } else if (r.changed && r.hasMarkers) {
    toast({
      kind: 'warning',
      title: `${name} still contains conflict markers`,
      body: 'It was left unresolved.',
    });
  } else if (r.exitCode !== 0 && r.exitCode !== null) {
    toast({
      kind: 'warning',
      title: `${r.tool} exited with code ${r.exitCode}`,
      body: `${name} was left unresolved.`,
    });
  } else {
    toast({
      kind: 'info',
      title: `${r.tool} closed without changing ${name}`,
      body: 'It was left unresolved.',
    });
  }
  return r;
}

/** Stop waiting for the external merge tool (the tool itself keeps running). */
export function cancelExternalMergeTool(repoId: RepoId, path: string): void {
  const w = useMergeToolWaits.getState().waits[mergeWaitKey(repoId, path)];
  if (w) void guard(toolsInvoke('tools:mergeTool:cancel', { waitId: w.waitId }));
}

/**
 * Open a conflicted file: the external tool when "Use external merge tool by default" is on and a tool is set
 * (spec 08 §4.8), else the built-in merge tool via `openBuiltIn`.
 */
export function openConflict(repoId: RepoId, path: string, openBuiltIn: () => void): void {
  const v = useSettingsStore.getState().values;
  if (v?.['tools.useExternalMergeToolByDefault'] && mergeToolConfigured())
    void openExternalMergeTool(repoId, path);
  else openBuiltIn();
}

// ---- repo-level and "selected file" helpers (palette / shortcuts) -------------------------------------

/** The repo root folder as a path target. */
export const repoRoot = (repoId: RepoId): RepoFile => ({ repoId, path: '' });

/**
 * Ctrl+D (spec 01 §4.9 `repo.openExternalDiff`): the external diff of the file shown in the center (merge tool for
 * a conflicted file, editor for a file view).
 */
export function openExternalForSelection(repoId: RepoId): void {
  const c = useRepoUiStore.getState().get(repoId).center;
  if (c.kind === 'diff') {
    void openExternalDiff({
      repoId,
      path: c.path,
      ...(c.oldPath ? { oldPath: c.oldPath } : {}),
      oldRev: c.oldRev,
      newRev: c.newRev,
      spec: c.spec,
    });
  } else if (c.kind === 'merge') void openExternalMergeTool(repoId, c.path);
  else if (c.kind === 'file') void openInEditor({ repoId, path: c.path });
  else useToastStore.getState().push({ kind: 'info', title: 'Open a file diff first', timeoutMs: 3000 });
}
