import type { RepoId } from '@githappens/git/types';
import type { QueryClient } from '@tanstack/react-query';

import type { AgentSession } from '../../../../shared/ipc/agents-contract';
import { agentsInvoke } from '../../agents/api';
import type { MenuItem } from '../../components/ContextMenu';
import { confirm, prompt } from '../../components/Dialogs';
import { invoke, IpcError } from '../../lib/api';
import { runOp } from '../../lib/ops';
import { useSessionStore } from '../../repo/sessions';
import { useLayoutStore } from '../../stores/layout';
import { useRepoUiStore } from '../../stores/repo-ui';
import { useTabsStore } from '../../stores/tabs';
import { useToastStore } from '../../stores/toasts';
import { boundRootOf, rootKey, useTerminalStore } from '../terminal/terminal-store';
import { defaultWorktreeFolder, normPath, resolveAgainst, samePath } from './agent-helpers';

/** Renderer actions of the Agent Sessions view (spec 12 §4.12). */

const errorText = (e: unknown): string =>
  e instanceof IpcError ? e.error.message : e instanceof Error ? e.message : String(e);

/** Worktree root of an open repo session (the key of its terminal panel). */
export function repoRootOf(repoId: RepoId): string | null {
  for (const s of Object.values(useSessionStore.getState().byPath)) {
    if (s.state === 'ready' && s.repoId === repoId) return s.info.worktreeRoot;
  }
  return null;
}

function showTerminal(): void {
  if (!useLayoutStore.getState().terminalOpen) useLayoutStore.getState().patch({ terminalOpen: true });
}

/**
 * Opens / selects the terminal tab of `ptyId` in the terminal panel. Agent tabs bound to another
 * worktree's repo tab switch to that tab when it is open; otherwise they move to `repoId`'s panel.
 */
export function focusTerminalSession(repoId: RepoId, ptyId: string): void {
  const root = repoRootOf(repoId);
  const owner = boundRootOf(ptyId);
  const store = useTerminalStore.getState();
  if (owner && (!root || owner !== rootKey(root))) {
    const tabs = useTabsStore.getState();
    const tab = tabs.tabs.find((t) => t.kind === 'repo' && t.repoPath && rootKey(t.repoPath) === owner);
    if (tab) {
      tabs.activate(tab.id);
      store.request(owner, ptyId);
      showTerminal();
      return;
    }
    if (root) {
      const b = store.bound[owner]!.find((x) => x.ptyId === ptyId)!;
      store.bind(root, b);
    }
  }
  if (!root) return;
  store.request(root, ptyId);
  showTerminal();
}

/**
 * Starts `tools.agentCommand` (or `command`) in `cwd` and shows it as a tab in `repoId`'s
 * terminal panel. Returns the pty id, or null when starting failed (a toast is shown).
 */
export async function openAgentSession(
  repoId: RepoId,
  cwd: string,
  opts: { command?: string; args?: string[] } = {},
): Promise<string | null> {
  const root = repoRootOf(repoId) ?? cwd;
  try {
    const { ptyId, label, setupCommands } = await agentsInvoke('agents:start', { cwd, ...opts });
    useTerminalStore.getState().bind(root, { ptyId, label, cwd });
    useTerminalStore.getState().request(root, ptyId);
    showTerminal();
    if (setupCommands?.length) {
      useToastStore.getState().push({
        kind: 'info',
        title: `Running ${setupCommands.length} agent setup command${setupCommands.length === 1 ? '' : 's'} first`,
        body: `${setupCommands.join('\n')}\n\nThey run in the agent's terminal tab (repo setting githappens.agentSetup).`,
      });
    }
    return ptyId;
  } catch (e) {
    useToastStore.getState().push({ kind: 'error', title: 'Could not start agent', body: errorText(e) });
    return null;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Stop: Ctrl+C first; if the agent is still running shortly after, confirm and kill it.
 * On an exited session this dismisses it from the list.
 */
export async function stopAgentSession(s: AgentSession): Promise<void> {
  if (!s.ptyId) return;
  const ptyId = s.ptyId;
  try {
    if (s.status === 'exited') {
      await agentsInvoke('agents:stop', { ptyId });
      return;
    }
    await agentsInvoke('agents:stop', { ptyId });
    await sleep(1500);
    const still = (await agentsInvoke('agents:list', { worktreePaths: [] })).find(
      (x) => x.ptyId === ptyId && x.status !== 'exited',
    );
    if (!still) return;
    const ok = await confirm(
      `Stop ${s.label}?`,
      'Ctrl+C was sent but the agent is still running. Kill the process? Unsaved agent work may be lost.',
      'Kill',
      true,
    );
    if (ok) await agentsInvoke('agents:stop', { ptyId, force: true });
  } catch (e) {
    useToastStore.getState().push({ kind: 'error', title: 'Could not stop agent', body: errorText(e) });
  }
}

/** Selects the WIP node of the repo tab at `path` once its session is ready. */
function selectWipWhenReady(path: string): void {
  const key = normPath(path);
  const find = (): RepoId | null => {
    for (const [k, s] of Object.entries(useSessionStore.getState().byPath)) {
      if (normPath(k) === key && s.state === 'ready') return s.repoId;
    }
    return null;
  };
  const hit = find();
  if (hit) {
    useRepoUiStore.getState().select(hit, { kind: 'wip' });
    return;
  }
  const unsub = useSessionStore.subscribe(() => {
    const id = find();
    if (!id) return;
    unsub();
    clearTimeout(timer);
    useRepoUiStore.getState().select(id, { kind: 'wip' });
  });
  const timer = setTimeout(unsub, 30_000);
}

/** "Show changes": the worktree's WIP — in this tab, or in the worktree's own repo tab. */
export async function showWorktreeChanges(repoId: RepoId, worktreePath: string): Promise<void> {
  const root = repoRootOf(repoId);
  if (samePath(root, worktreePath)) {
    useRepoUiStore.getState().select(repoId, { kind: 'wip' });
    return;
  }
  if (await useTabsStore.getState().openRepo(worktreePath)) selectWipWhenReady(worktreePath);
}

/** "Open worktree": its repo tab. */
export function openWorktree(path: string): void {
  void useTabsStore.getState().openRepo(path);
}

/**
 * "Create worktree + agent": the Worktrees "+" flow (branch, then folder; spec 09 `worktree.add`)
 * followed by a new agent session in the created folder.
 */
export async function createWorktreeWithAgent(
  repoId: RepoId,
  repoRoot: string | null,
  qc?: QueryClient,
): Promise<string | null> {
  const branch = await prompt({
    title: 'Create worktree + agent',
    label: 'Branch (existing or new)',
    placeholder: 'feature/x',
    okLabel: 'Next',
    validate: (v) => (v.trim() ? null : 'Enter a branch name.'),
  });
  if (!branch) return null;
  const name = branch.value.trim();
  const dir = await prompt({
    title: 'Create worktree + agent',
    label: 'Folder',
    initial: defaultWorktreeFolder(repoRoot, name),
    okLabel: 'Create and start agent',
    validate: (v) => (v.trim() ? null : 'Enter a folder.'),
  });
  if (!dir) return null;
  const folder = resolveAgainst(repoRoot, dir.value);
  try {
    const refs = await invoke('git:refs', { repoId });
    const exists = refs.some((r) => r.type === 'local' && r.shortName === name);
    const r = await runOp(
      repoId,
      exists
        ? { type: 'worktree.add', path: folder, branch: name }
        : { type: 'worktree.add', path: folder, newBranch: name },
      { successToast: `Created worktree for ${name}` },
    );
    if (!r) return null;
  } catch {
    return null; // runOp already reported it
  }
  void qc?.invalidateQueries({ queryKey: ['worktrees', repoId] });
  return openAgentSession(repoId, folder);
}

/**
 * "Open in terminal" for a worktree folder: a new shell tab in this repo tab's terminal panel,
 * started in `path` (spec 12 §4.12 / spec 09 worktree rows).
 */
export function openWorktreeInTerminal(repoId: RepoId, path: string): void {
  const root = repoRootOf(repoId) ?? path;
  const layout = useLayoutStore.getState();
  const wasOpen = layout.terminalOpen;
  useTerminalStore.getState().openShell(root, path);
  if (!wasOpen) layout.patch({ terminalOpen: true });
}

/** Context-menu item for worktree rows (left panel Worktrees section, Agents view). */
export function worktreeTerminalMenuItem(repoId: RepoId, path: string): MenuItem {
  return { label: 'Open in Terminal', onSelect: () => openWorktreeInTerminal(repoId, path) };
}

/**
 * Edit the repo's agent setup commands (`githappens.agentSetup`, one per line). They run visibly in
 * a new agent session's terminal, once per worktree, before the agent command.
 */
export async function editAgentSetupCommands(repoPath: string): Promise<void> {
  let current: string[];
  try {
    current = await agentsInvoke('agents:setup:get', { repoPath });
  } catch (e) {
    useToastStore
      .getState()
      .push({ kind: 'error', title: 'Could not read setup commands', body: errorText(e) });
    return;
  }
  const r = await prompt({
    title: 'Agent setup commands',
    label:
      'One command per line. They are typed into the new agent tab’s shell and run there (visibly) once per worktree, before the agent starts — e.g. `pnpm install`. Stored in this repository’s git config (githappens.agentSetup).',
    initial: current.join('\n'),
    placeholder: 'pnpm install',
    okLabel: 'Save',
    multiline: true,
  });
  if (!r) return;
  try {
    const saved = await agentsInvoke('agents:setup:set', { repoPath, commands: r.value.split('\n') });
    useToastStore.getState().push({
      kind: 'success',
      title: saved.length
        ? `Saved ${saved.length} agent setup command${saved.length === 1 ? '' : 's'}`
        : 'Agent setup commands cleared',
    });
  } catch (e) {
    useToastStore
      .getState()
      .push({ kind: 'error', title: 'Could not save setup commands', body: errorText(e) });
  }
}
