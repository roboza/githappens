import type { RepoId } from '@githappens/git/types';

import { confirm, prompt } from '../components/Dialogs';
import { invoke } from '../lib/api';
import { useSessionStore } from '../repo/sessions';
import { useOpsStore } from '../stores/ops';
import { isPinnedTab, useTabsStore } from '../stores/tabs';
import { closeTargets, normPath, tabLabel } from './tab-model';

/**
 * Tab actions shared by the tab bar, its context menu and commands (spec 01 §4.2, §8 "op running when
 * user closes tab").
 */

export function repoIdOfPath(path: string | undefined): RepoId | undefined {
  if (!path) return undefined;
  const s = useSessionStore.getState().byPath[normPath(path)];
  return s?.state === 'ready' ? s.repoId : undefined;
}

/** Running/queued ops of a tab's repository, unless another open tab shows the same repo. */
function runningOpsFor(tabIds: string[]): { repoId: RepoId; opId: string; label: string }[] {
  const { tabs } = useTabsStore.getState();
  const closing = new Set(tabIds);
  const stillOpen = new Set(
    tabs.filter((t) => !closing.has(t.id) && t.repoPath).map((t) => normPath(t.repoPath!)),
  );
  const repoIds = new Set<RepoId>();
  for (const t of tabs) {
    if (!closing.has(t.id) || !t.repoPath || stillOpen.has(normPath(t.repoPath))) continue;
    const id = repoIdOfPath(t.repoPath);
    if (id) repoIds.add(id);
  }
  return Object.values(useOpsStore.getState().ops)
    .filter((o) => repoIds.has(o.repoId))
    .map((o) => ({ repoId: o.repoId, opId: o.opId, label: o.label }));
}

/** Close tabs, asking first when that would abandon a running operation (which is then cancelled). */
export async function requestCloseTabs(ids: string[]): Promise<boolean> {
  const { tabs } = useTabsStore.getState();
  const targets = ids.filter((id) => tabs.some((t) => t.id === id && !isPinnedTab(t)));
  if (!targets.length) return false;
  const ops = runningOpsFor(targets);
  if (ops.length) {
    const what = ops.length === 1 ? `"${ops[0]!.label}" is` : `${ops.length} operations are`;
    const ok = await confirm(
      'Operation in progress',
      `${what} still running. Cancel and close?`,
      'Cancel operation and close',
      true,
    );
    if (!ok) return false;
    await Promise.all(
      ops.map((o) => invoke('git:op:cancel', { repoId: o.repoId, opId: o.opId }).catch(() => undefined)),
    );
  }
  if (targets.length === 1) useTabsStore.getState().close(targets[0]!);
  else useTabsStore.getState().closeMany(targets);
  return true;
}

export const requestCloseTab = (id: string): Promise<boolean> => requestCloseTabs([id]);

export function requestCloseOthers(id: string, mode: 'others' | 'right'): Promise<boolean> {
  return requestCloseTabs(closeTargets(useTabsStore.getState().tabs, id, mode));
}

/** "Alias repository…" (spec 01 §4.2 / user story 11). */
export async function renameTab(id: string): Promise<void> {
  const tab = useTabsStore.getState().tabs.find((t) => t.id === id);
  if (!tab) return;
  const r = await prompt({
    title: 'Alias repository',
    label: 'Tab name (leave empty to use the folder name)',
    initial: tab.alias ?? tabLabel(tab),
    okLabel: 'Save',
  });
  if (!r) return;
  useTabsStore.getState().setAlias(id, r.value);
}
