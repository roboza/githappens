import type { RepoId, Sha } from '@githappens/git/types';
import { CloudUpload, Link } from 'lucide-react';

import type {
  OpenedPatch,
  PatchApplyReq,
  PatchApplyRes,
  PatchRepoCandidate,
  PatchSource,
} from '../../../shared/ipc/patches-contract';
import type { CommandDef } from '../commands/types';
import type { MenuEntry } from '../components/ContextMenu';
import { choose, confirm, prompt } from '../components/Dialogs';
import { invoke, IpcError } from '../lib/api';
import { useSessionStore } from '../repo/sessions';
import { useRepoUiStore } from '../stores/repo-ui';
import { useTabsStore } from '../stores/tabs';
import { useToastStore } from '../stores/toasts';
import {
  cachedPatchAvailability,
  errorDetail,
  errorText,
  fetchPatchAvailability,
  patchInvoke,
  shareBlockedReason,
} from './api';
import { useOpenedPatches } from './store';

/** Cloud Patches actions (spec 14 §4.2): share, open links, apply. */

const toast = () => useToastStore.getState();

/** Open the Create Cloud Patch dialog for WIP / a commit / a stash. */
export async function shareAsCloudPatch(
  repoId: RepoId,
  source: PatchSource,
  defaults: { title?: string; collaborators?: string[] } = {},
): Promise<void> {
  const blocked = shareBlockedReason(await fetchPatchAvailability());
  if (blocked) {
    toast().push({ kind: 'info', title: 'Cloud Patches', body: blocked });
    return;
  }
  const m = await import('../views/cloud-patches/CreateCloudPatchDialog');
  await m.openCreateCloudPatch(repoId, source, defaults);
}

export const shareWip = (repoId: RepoId): Promise<void> =>
  shareAsCloudPatch(repoId, { kind: 'wip', stagedOnly: true }); // falls back to all changes when nothing is staged
export const shareCommit = (repoId: RepoId, sha: Sha, subject?: string): Promise<void> =>
  shareAsCloudPatch(repoId, { kind: 'commit', sha }, { title: subject });
export const shareStash = (repoId: RepoId, sha: Sha, message?: string): Promise<void> =>
  shareAsCloudPatch(repoId, { kind: 'stash', ref: sha }, { title: message });

/**
 * Context-menu entry for sharing (commit / stash / WIP menus): hidden when no server is configured,
 * disabled with the reason when signed out.
 */
export function shareMenuItem(label: string, onSelect: () => void): MenuEntry[] {
  const a = cachedPatchAvailability();
  if (!a.configured) return [];
  const blocked = shareBlockedReason(a);
  return [{ label, onSelect, disabled: !!blocked, ...(blocked ? { title: blocked } : {}) }];
}

void fetchPatchAvailability();

// ---- open ----

const samePath = (a?: string, b?: string): boolean =>
  !!a && !!b && a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();

/** Resolve the repo id of a path (opens its session like a repo tab does). */
function repoIdFor(path: string): Promise<RepoId | null> {
  const store = useSessionStore;
  const key = path.replace(/\\/g, '/').toLowerCase();
  store.getState().ensure(path);
  return new Promise((resolve) => {
    const check = (): boolean => {
      const s = store.getState().byPath[key];
      if (s?.state === 'ready') resolve(s.repoId);
      else if (s?.state === 'error') resolve(null);
      else return false;
      return true;
    };
    if (check()) return;
    const unsub = store.subscribe(() => {
      if (check()) unsub();
    });
  });
}

/** Show the patch in the repo's tab (opening the tab when needed). */
async function showInRepo(
  patchId: string,
  candidate: Pick<PatchRepoCandidate, 'repoId' | 'path'>,
): Promise<void> {
  useOpenedPatches.getState().setRepo(patchId, candidate.repoId);
  useRepoUiStore.getState().update(candidate.repoId, () => ({ center: { kind: 'patch', patchId } }));
  const tabs = useTabsStore.getState();
  const tab = tabs.tabs.find((t) => t.kind === 'repo' && samePath(t.repoPath, candidate.path));
  if (tab) tabs.activate(tab.id);
  else await tabs.openRepo(candidate.path);
}

/** Let the user choose among matches, open repo tabs, or another folder. */
async function pickRepo(opened: OpenedPatch): Promise<PatchRepoCandidate | null> {
  const { candidates } = opened.localMatch;
  const base = opened.bundle.baseSha.slice(0, 7);
  if (candidates.length > 1) {
    const r = await choose({
      title: 'Apply Cloud Patch to which repository?',
      message: `Several open repositories match "${opened.bundle.title}".`,
      choices: [
        { value: '', label: 'Cancel' },
        ...candidates.slice(0, 6).map((c, i) => ({
          value: c.repoId,
          label: `${c.name}${c.baseAvailable ? '' : ` (base ${base} missing)`}`,
          primary: i === 0,
        })),
      ],
    });
    return candidates.find((c) => c.repoId === r?.value) ?? null;
  }
  const repoTabs = useTabsStore
    .getState()
    .tabs.filter((t) => t.kind === 'repo' && t.repoPath)
    .slice(0, 6);
  const r = await choose({
    title: 'Choose a repository',
    message: `No open repository matches "${opened.bundle.title}"${
      opened.patch.repo ? ` (${opened.patch.repo.owner}/${opened.patch.repo.name})` : ''
    }. Pick the repository to preview and apply it in.`,
    choices: [
      { value: '', label: 'Cancel' },
      ...repoTabs.map((t) => ({ value: t.repoPath!, label: t.alias ?? t.repoPath!.split(/[\\/]/).pop()! })),
      { value: '\0pick', label: 'Open repository…', primary: repoTabs.length === 0 },
    ],
  });
  if (!r?.value) return null;
  let repoPath = r.value;
  if (repoPath === '\0pick') {
    const picked = await invoke('repos:pickFolder', {}).catch(() => null);
    if (!picked) return null;
    repoPath = picked;
  }
  const repoId = await repoIdFor(repoPath);
  if (!repoId) {
    toast().push({ kind: 'error', title: 'Could not open repository', body: repoPath });
    return null;
  }
  const c = await patchInvoke('patch:checkRepo', { patchId: opened.patch.id, repoId });
  return { ...c, path: repoPath };
}

/**
 * Open a Cloud Patch link (`https://<server>/p/<id>#k=…` or `githappens://patch/<id>#k=…`): download,
 * verify and decrypt in main, pick / confirm the target repo, and show the CloudPatchView in that repo's tab.
 * Resolves false when cancelled or failed (errors are toasted).
 */
export async function openPatchLink(url: string): Promise<boolean> {
  let opened: OpenedPatch;
  try {
    let res = await patchInvoke('patch:open', { url });
    if (res.status === 'server-mismatch') {
      const ok = await confirm(
        'Open link from another server?',
        `This Cloud Patch is hosted on ${res.linkServer}${
          res.configuredServer ? `, not on your server (${res.configuredServer})` : ''
        }. It will be downloaded without signing in. Only continue if you trust the sender.`,
        'Open anyway',
      );
      if (!ok) return false;
      res = await patchInvoke('patch:open', { url, allowOtherServer: true });
      if (res.status !== 'opened') return false;
    }
    opened = res.opened;
  } catch (e) {
    const needsKey = errorDetail(e, 'patchError') === 'needs-key';
    toast().push({
      kind: 'error',
      title: needsKey ? 'This Cloud Patch is encrypted' : 'Could not open Cloud Patch',
      body: needsKey ? 'The link is missing its key (#k=…). Ask the sender for the full link.' : errorText(e),
    });
    return false;
  }
  useOpenedPatches.getState().put(opened);
  const { candidates, repoId } = opened.localMatch;
  const best = repoId ? candidates.find((c) => c.repoId === repoId) : undefined;
  const target = best ?? (await pickRepo(opened));
  if (!target) return false;
  await showInRepo(opened.patch.id, target);
  return true;
}

// ---- apply ----

const applyLabel = (r: PatchApplyRes, where: string): string =>
  r.conflicts.length
    ? `Applied to ${where} with conflicts`
    : r.rejects.length
      ? `Partially applied to ${where}`
      : `Applied Cloud Patch to ${where}`;

/**
 * Apply an opened patch (the `patch.apply` op: one Undo reverts it) with the retry UX: stash local changes
 * for branch targets, ignore whitespace (CRLF) or apply with `.rej` files when it doesn't apply.
 */
export async function applyCloudPatch(req: PatchApplyReq): Promise<PatchApplyRes | null> {
  const where =
    req.target.kind === 'worktree'
      ? 'the working tree'
      : req.target.kind === 'new-branch'
        ? `new branch ${req.target.name}`
        : req.target.name;
  let current = req;
  for (;;) {
    try {
      const r = await patchInvoke('patch:apply', current);
      const t = toast();
      if (r.conflicts.length) {
        useRepoUiStore.getState().select(req.repoId, { kind: 'wip' });
        t.push({
          kind: 'warning',
          title: applyLabel(r, where),
          body: `Conflicted files:\n${r.conflicts.slice(0, 8).join('\n')}${r.conflicts.length > 8 ? '\n…' : ''}`,
        });
      } else if (r.rejects.length) {
        t.push({
          kind: 'warning',
          title: applyLabel(r, where),
          body: `Rejected hunks were written to:\n${r.rejects.slice(0, 8).join('\n')}`,
        });
      } else {
        t.push({ kind: 'success', title: applyLabel(r, where), body: r.warnings.join('\n') || undefined });
      }
      return r;
    } catch (e) {
      if (!(e instanceof IpcError)) throw e;
      const dirty = e.error.details?.dirty === 'local-changes';
      if (dirty && current.target.kind !== 'worktree') {
        const ok = await confirm(
          'You have local changes',
          'Stash them before switching branches? The stash stays in your stash list.',
          'Stash and apply',
        );
        if (!ok) return null;
        current = { ...current, target: { ...current.target, autostash: true } };
        continue;
      }
      if (errorDetail(e, 'patchApply') === 'does-not-apply') {
        const r = await choose({
          title: 'The patch does not apply',
          message: `${e.error.message}\n\nLine-ending (CRLF) differences can be ignored, or the parts that apply can be applied with the rest saved as .rej files.`,
          choices: [
            { value: 'cancel', label: 'Cancel' },
            ...(current.ignoreWhitespace
              ? []
              : [{ value: 'ws', label: 'Retry ignoring whitespace', primary: true }]),
            ...(current.reject ? [] : [{ value: 'reject', label: 'Apply with .rej files' }]),
          ],
        });
        if (r?.value === 'ws') current = { ...current, ignoreWhitespace: true };
        else if (r?.value === 'reject') current = { ...current, reject: true };
        else return null;
        continue;
      }
      toast().push({ kind: 'error', title: 'Could not apply Cloud Patch', body: e.error.message });
      return null;
    }
  }
}

/** Save the raw patch as a `.patch` file (browser download → Electron save dialog). */
export function downloadPatchFile(title: string, text: string): void {
  const name = `${
    title
      .replace(/[^\w.-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'cloud-patch'
  }.patch`;
  const url = URL.createObjectURL(new Blob([text], { type: 'text/x-diff' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ---- command palette ----

function activeRepoId(): RepoId | undefined {
  const { tabs, activeTabId } = useTabsStore.getState();
  const tab = tabs.find((t) => t.id === activeTabId);
  if (!tab?.repoPath) return undefined;
  const s = useSessionStore.getState().byPath[tab.repoPath.replace(/\\/g, '/').toLowerCase()];
  return s?.state === 'ready' ? s.repoId : undefined;
}

/** Palette commands: "Open Cloud Patch link…" and "Share working changes as Cloud Patch…". */
export function cloudPatchCommands(): CommandDef[] {
  return [
    {
      id: 'cloudPatch.openLink',
      title: 'Open Cloud Patch link…',
      category: 'Patch',
      icon: Link,
      keywords: ['cloud patch', 'share', 'link', 'apply'],
      run: async () => {
        const r = await prompt({
          title: 'Open Cloud Patch link',
          label: 'Link',
          placeholder: 'https://…/p/… or githappens://patch/…',
          okLabel: 'Open',
          validate: (v) =>
            /^(githappens:\/\/patch\/|https?:\/\/[^/]+.*\/p\/)[A-Za-z0-9]{16,32}/.test(v.trim())
              ? null
              : 'Paste a Cloud Patch link.',
        });
        if (r) await openPatchLink(r.value.trim());
      },
    },
    {
      id: 'cloudPatch.shareWip',
      title: 'Share working changes as Cloud Patch…',
      category: 'Patch',
      icon: CloudUpload,
      keywords: ['cloud patch', 'share', 'wip'],
      when: (ctx) => !!ctx.activeRepo && ctx.hasWip,
      whenReason: (ctx) => (!ctx.activeRepo ? 'Open a repository first.' : 'There are no changes to share.'),
      run: async () => {
        const repoId = activeRepoId();
        if (repoId) await shareWip(repoId);
      },
    },
  ];
}
