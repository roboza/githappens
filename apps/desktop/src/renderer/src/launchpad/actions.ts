import type { RepoId } from '@githappens/git/types';
import type { ClassifiedItem } from '@githappens/launchpad';
import type { MergeMethod } from '@githappens/providers/types';
import type { QueryClient } from '@tanstack/react-query';

import type { LaunchpadQueryResult } from '../../../shared/ipc/launchpad-contract';
import { choose, confirm } from '../components/Dialogs';
import { errorLine, intInvoke, openExternal } from '../integrations/api';
import { invoke } from '../lib/api';
import { runOp } from '../lib/ops';
import { useSessionStore } from '../repo/sessions';
import { useRepoUiStore } from '../stores/repo-ui';
import { useSettingsStore } from '../stores/settings';
import { useTabsStore } from '../stores/tabs';
import { useToastStore } from '../stores/toasts';
import { createBranchFromIssue } from '../views/issues/IssuesSection';
import { checkoutPullRequest, openPullRequestView } from '../views/pr/pr-actions';

/** Launchpad row actions (spec 11 §4.2). Mutations reuse the spec 10 channels. */

const toast = () => useToastStore.getState();
const pathKey = (p: string): string => p.replace(/\\/g, '/').toLowerCase();

/** Open (or focus) the repo tab for `path` and wait for its git session. */
export async function openRepoSession(path: string): Promise<{ repoId: RepoId; base: string } | null> {
  if (!(await useTabsStore.getState().openRepo(path))) return null;
  const sessions = useSessionStore.getState();
  sessions.ensure(path);
  const k = pathKey(path);
  return new Promise((resolve) => {
    const check = (): boolean => {
      const s = useSessionStore.getState().byPath[k];
      if (s?.state === 'ready') {
        const head = s.info.head;
        resolve({ repoId: s.repoId, base: head.kind === 'branch' ? head.name : (head.sha ?? 'HEAD') });
        return true;
      }
      if (s?.state === 'error') {
        resolve(null);
        return true;
      }
      return false;
    };
    if (check()) return;
    const unsub = useSessionStore.subscribe(() => {
      if (check()) {
        unsub();
        clearTimeout(timer);
      }
    });
    const timer = setTimeout(() => {
      unsub();
      resolve(null);
    }, 30_000);
  });
}

/** Repo for an item: its mapped local path, else pick among open repo tabs. */
async function localPathFor(item: ClassifiedItem, purpose: string): Promise<string | null> {
  if (item.repo?.localPath) return item.repo.localPath;
  const open = useTabsStore
    .getState()
    .tabs.filter((t) => t.kind === 'repo' && t.repoPath)
    .map((t) => t.repoPath!);
  if (item.type === 'issue' && open.length) {
    if (open.length === 1) return open[0]!;
    const r = await choose({
      title: `Choose a repository to ${purpose}`,
      message: `${item.repo?.fullName ?? 'This item'} isn't linked to a local repository.`,
      choices: [
        { value: '', label: 'Cancel' },
        ...open
          .slice(0, 6)
          .map((p, i) => ({ value: p, label: p.split(/[\\/]/).pop() ?? p, primary: i === 0 })),
      ],
    });
    return r?.value || null;
  }
  toast().push({
    kind: 'warning',
    title: 'Repository not found locally',
    body: `Clone or open ${item.repo?.fullName ?? 'the repository'} first.`,
  });
  return null;
}

export function openInBrowser(item: ClassifiedItem): void {
  if (item.webUrl) openExternal(item.webUrl);
}

/** Enter: PR → PR view in its repo (or browser); issue → browser; WIP → repo tab. */
export async function openItem(item: ClassifiedItem): Promise<void> {
  if (item.type === 'wip') {
    await useTabsStore.getState().openRepo(item.status.path);
    return;
  }
  if (item.type === 'pr' && item.repo?.localPath) {
    const s = await openRepoSession(item.repo.localPath);
    if (s) {
      openPullRequestView(s.repoId, item.pr.repo, item.pr.number);
      return;
    }
  }
  openInBrowser(item);
}

export async function checkoutItem(item: ClassifiedItem): Promise<void> {
  if (item.type === 'wip') {
    await useTabsStore.getState().openRepo(item.status.path);
    return;
  }
  if (item.type === 'issue') {
    await createBranchForItem(item);
    return;
  }
  const path = await localPathFor(item, 'check out');
  if (!path) return;
  const s = await openRepoSession(path);
  if (s) await checkoutPullRequest(s.repoId, item.pr);
}

/**
 * "Checkout in new worktree" (spec 11 §2.2 item actions): `pr:checkout` in worktree mode adds a
 * worktree for the PR head (default `../<repo>.worktrees/pr-<n>`), then opens it as a repo tab.
 */
export async function checkoutItemInWorktree(item: ClassifiedItem): Promise<void> {
  if (item.type !== 'pr') return;
  const path = await localPathFor(item, 'check out');
  if (!path) return;
  const s = await openRepoSession(path);
  if (!s) return;
  const pr = item.pr;
  const id = toast().push({ kind: 'progress', title: `Creating a worktree for PR #${pr.number}…` });
  try {
    const r = await intInvoke('pr:checkout', { repoId: s.repoId, pr, mode: 'worktree' });
    toast().dismiss(id);
    toast().push({ kind: 'success', title: `Checked out ${r.branch} in a new worktree`, body: r.path });
    if (r.path) await useTabsStore.getState().openRepo(r.path);
  } catch (e) {
    toast().dismiss(id);
    toast().push({ kind: 'error', title: `Could not check out PR #${pr.number}`, body: errorLine(e) });
  }
}

/** Drop a WIP row from every cached list (optimistic), then refetch once main's WIP memo expired. */
function dropWipRow(qc: QueryClient | undefined, uid: string): void {
  if (!qc) return;
  qc.setQueriesData<LaunchpadQueryResult>({ queryKey: ['launchpad'] }, (prev) =>
    prev && Array.isArray(prev.items) ? { ...prev, items: prev.items.filter((i) => i.uid !== uid) } : prev,
  );
  setTimeout(() => void qc.invalidateQueries({ queryKey: ['launchpad'] }), 6_000);
}

/**
 * WIP row "Stash" (§4.2): `stash.push` on the repo without opening a tab (ref-counted repo
 * session in main, released afterwards). Honors "Include untracked files when stashing".
 */
export async function stashWip(
  item: ClassifiedItem,
  qc?: QueryClient,
  includeUntracked = useSettingsStore.getState().values?.['general.stashIncludeUntracked'] ?? true,
): Promise<boolean> {
  if (item.type !== 'wip') return false;
  const st = item.status;
  if (st.conflicted > 0) {
    toast().push({
      kind: 'warning',
      title: `${st.name} has conflicts`,
      body: 'Resolve the conflicts in the repository before stashing.',
    });
    return false;
  }
  const ok = await confirm(
    `Stash changes in ${st.name}?`,
    `${st.staged + st.unstaged + (includeUntracked ? st.untracked : 0)} file(s) on ${st.branch ?? 'HEAD'} will be stashed.`,
    'Stash',
  );
  if (!ok) return false;
  let info: { id: RepoId } | null = null;
  try {
    info = await invoke('git:repo:open', { path: st.path });
    const r = await runOp(
      info.id,
      { type: 'stash.push', message: 'Stashed from Launchpad', includeUntracked },
      { successToast: `Stashed changes in ${st.name}` },
    );
    if (r) dropWipRow(qc, item.uid);
    return !!r;
  } catch (e) {
    toast().push({ kind: 'error', title: `Could not stash ${st.name}`, body: errorLine(e) });
    return false;
  } finally {
    if (info) void invoke('git:repo:close', { repoId: info.id }).catch(() => undefined);
  }
}

/** WIP row "Commit…" (§4.2): open the repo tab with the WIP node selected and focus the message. */
export async function commitWip(item: ClassifiedItem): Promise<void> {
  if (item.type !== 'wip') return;
  const s = await openRepoSession(item.status.path);
  if (!s) return;
  useRepoUiStore.getState().select(s.repoId, { kind: 'wip' });
  // Let the right panel mount the commit composer first.
  setTimeout(() => window.dispatchEvent(new CustomEvent('kl:focus-commit-message')), 150);
}

export async function createBranchForItem(item: ClassifiedItem): Promise<void> {
  if (item.type !== 'issue' || !item.integrationKey) return;
  const path = await localPathFor(item, 'create the branch in');
  if (!path) return;
  const s = await openRepoSession(path);
  if (s) await createBranchFromIssue(s.repoId, item.issue, item.integrationKey, s.base);
}

/** Merge from the Ready to merge group (§4.2) via the existing `pr:merge` channel. */
export async function mergeItem(
  item: ClassifiedItem,
  method: MergeMethod,
  after?: () => void,
): Promise<boolean> {
  if (item.type !== 'pr') return false;
  const pr = item.pr;
  const id = toast().push({ kind: 'progress', title: `Merging #${pr.number}…` });
  try {
    const r = await intInvoke('pr:merge', {
      ref: pr.repo,
      number: pr.number,
      method,
      expectedHeadSha: pr.head.sha,
    });
    toast().dismiss(id);
    if (!r.merged) {
      toast().push({ kind: 'warning', title: `#${pr.number} was not merged`, body: r.message });
      return false;
    }
    toast().push({ kind: 'success', title: `Merged #${pr.number}`, body: pr.title });
    after?.();
    return true;
  } catch (e) {
    toast().dismiss(id);
    toast().push({ kind: 'error', title: `Could not merge #${pr.number}`, body: errorLine(e) });
    return false;
  }
}
