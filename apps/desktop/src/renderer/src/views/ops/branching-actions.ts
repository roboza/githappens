import type { CheckoutPreflight, CheckoutTarget, MergeMode } from '@githappens/git/ops';
import type { RefInfo, RepoId, Sha, StashEntry } from '@githappens/git/types';

import type { MenuEntry } from '../../components/ContextMenu';
import { choose, confirm, prompt } from '../../components/Dialogs';
import { intInvoke } from '../../integrations/api';
import { invoke, IpcError } from '../../lib/api';
import { shortSha } from '../../lib/format';
import { quiet, runOp, showError } from '../../lib/ops';
import type { SettingKey, SettingValue } from '../../../../shared/settings/registry';
import { useSettingsStore } from '../../stores/settings';
import { useToastStore } from '../../stores/toasts';
import { undoInvoke } from '../undo/api';
import { openSquashDialog, openStashDialog } from './OpsDialogs';
import { caseOnlyWarning, refNameProblem } from './ref-names';

/**
 * Phase 8 branching actions (spec 05): merge modes, multi-commit cherry-pick / revert / squash, range rebase,
 * non-HEAD reset, remote checkout conflicts, detached-HEAD guard, stash extras, copy link. Shared by the graph,
 * the left panel, drag & drop and the command palette.
 */

const setting = <K extends SettingKey>(k: K): SettingValue<K> | undefined =>
  useSettingsStore.getState().values?.[k];

const shortRef = (r: string): string => r.replace(/^refs\/(heads|remotes|tags)\//, '');
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const caseInsensitiveFs = (): boolean =>
  typeof window !== 'undefined' && (window.api?.platform === 'win32' || window.api?.platform === 'darwin');

/** A commit as the graph knows it (enough to decide on mainline prompts). */
export interface CommitLite {
  sha: Sha;
  parents: Sha[];
  subject?: string;
}

// ---------------------------------------------------------------------------
// branch names (spec 05 §4.3, §8)

/** Validation for create/rename prompts: git's rules + existence + case-only clashes. */
export async function validateBranchName(
  repoId: RepoId,
  raw: string,
  current?: string,
): Promise<string | null> {
  const name = raw.trim();
  const refs = await invoke('git:refs', { repoId });
  const existing = refs.filter((r) => r.type === 'local' && r.shortName !== current).map((r) => r.shortName);
  const local = refNameProblem(name, existing, { caseInsensitive: caseInsensitiveFs() });
  if (local) return local;
  const v = await invoke('git:branch:validateName', { repoId, name });
  return v.valid ? null : (v.reason ?? 'That is not a valid branch name.');
}

/** Toast for a case-only clash on case-sensitive systems (the prompt already blocks it on Windows/macOS). */
export async function warnCaseOnly(repoId: RepoId, name: string): Promise<void> {
  if (caseInsensitiveFs()) return;
  const refs = await invoke('git:refs', { repoId }).catch(() => [] as RefInfo[]);
  const w = caseOnlyWarning(
    name,
    refs.filter((r) => r.type === 'local').map((r) => r.shortName),
  );
  if (w)
    useToastStore.getState().push({ kind: 'warning', title: 'Branch names differ only in case', body: w });
}

// ---------------------------------------------------------------------------
// checkout guards (spec 05 §4.5, §8)

/**
 * RemoteCheckoutConflictDialog (spec 05 §4.5): double-click `origin/X` when local `X` exists. Same / ahead →
 * check out the local branch; behind and tracking → check out + fast-forward; otherwise ask: checkout local,
 * reset local to the remote, or create a new branch. Resolves null on cancel.
 */
export async function resolveRemoteCheckout(
  repoId: RepoId,
  target: Extract<CheckoutTarget, { kind: 'remoteBranch' }>,
  pre: CheckoutPreflight,
): Promise<CheckoutTarget | null> {
  const local = pre.localExists;
  if (!local) return target;
  const remoteName = `${target.remote}/${target.name}`;
  const tracks = local.upstream === remoteName;
  if (local.relation === 'same' || (tracks && local.relation === 'ahead')) {
    return { kind: 'branch', name: local.name };
  }
  if (tracks && local.relation === 'behind') return { ...target, localName: local.name, onExisting: 'ff' };

  const why =
    local.relation === 'behind'
      ? `is behind ${remoteName} but tracks ${local.upstream ?? 'nothing'}`
      : local.relation === 'ahead'
        ? `is ahead of ${remoteName}${tracks ? '' : ` and tracks ${local.upstream ?? 'nothing'}`}`
        : local.relation === 'diverged'
          ? `has diverged from ${remoteName}`
          : `has no history in common with ${remoteName}`;
  const pick = await choose({
    title: `A local branch ${local.name} already exists`,
    message: `${local.name} ${why}. What do you want to do?`,
    choices: [
      { value: 'cancel', label: 'Cancel' },
      { value: 'new', label: 'Create new branch…' },
      { value: 'reset', label: `Reset ${local.name} to ${remoteName}`, danger: true },
      { value: 'local', label: `Checkout local ${local.name}`, primary: true },
    ],
  });
  if (!pick || pick.value === 'cancel') return null;
  if (pick.value === 'local') {
    return local.relation === 'behind'
      ? { ...target, localName: local.name, onExisting: 'ff' }
      : { kind: 'branch', name: local.name };
  }
  if (pick.value === 'reset') {
    const ok = await confirm(
      `Reset ${local.name} to ${remoteName}?`,
      `Commits only on the local ${local.name} will no longer be on a branch. Local changes are kept. You can undo this.`,
      'Reset & checkout',
      true,
    );
    return ok ? { ...target, localName: local.name, onExisting: 'reset' } : null;
  }
  const refs = await invoke('git:refs', { repoId });
  let n = 1;
  while (refs.some((r) => r.type === 'local' && r.shortName === `${local.name}-${n}`)) n++;
  const r = await prompt({
    title: `New branch tracking ${remoteName}`,
    initial: `${local.name}-${n}`,
    okLabel: 'Create & checkout',
    validate: (v) => validateBranchName(repoId, v),
  });
  return r ? { ...target, localName: r.value.trim().replace(/\s/g, '-') } : null;
}

/**
 * Leaving a detached HEAD whose commits are on no branch (spec 05 §8): "N commits will become unreachable —
 * create a branch?". Resolves false to cancel the checkout.
 */
export async function guardDetachedHead(repoId: RepoId, target: CheckoutTarget): Promise<boolean> {
  const o = await undoInvoke('branching:orphans', { repoId }).catch(() => ({ count: 0, sha: null }));
  if (!o.count || !o.sha) return true;
  if (target.kind === 'commit' && target.sha === o.sha) return true;
  const pick = await choose({
    title: `${plural(o.count, 'commit')} will become unreachable`,
    message: `HEAD is detached at ${shortSha(o.sha)} and ${o.count === 1 ? 'its commit is' : `${o.count} of its commits are`} not on any branch or tag. Create a branch to keep ${o.count === 1 ? 'it' : 'them'}? (GitHappens' undo journal keeps them alive for a while either way.)`,
    choices: [
      { value: 'cancel', label: 'Cancel' },
      { value: 'leave', label: 'Checkout anyway', danger: true },
      { value: 'branch', label: 'Create branch first…', primary: true },
    ],
  });
  if (!pick || pick.value === 'cancel') return false;
  if (pick.value === 'leave') return true;
  const r = await prompt({
    title: 'Create branch for the detached commits',
    label: `At ${shortSha(o.sha)}`,
    placeholder: 'feature/my-work',
    okLabel: 'Create branch',
    validate: (v) => validateBranchName(repoId, v),
  });
  if (!r) return false;
  const ok = await runOp(
    repoId,
    { type: 'branch.create', name: r.value.trim(), startPoint: o.sha, checkout: false },
    { successToast: `Created branch ${r.value.trim()}` },
  ).catch(() => null);
  return !!ok;
}

// ---------------------------------------------------------------------------
// reset (spec 05 §4.8, §6.9)

/**
 * Hard reset confirmation (spec 05 §4.8): number of modified files that will be lost, untracked files are not
 * removed, "Don't ask again" (setting `git.confirmHardReset`).
 */
export async function confirmHardReset(repoId: RepoId, branch: string, label: string): Promise<boolean> {
  if (setting('git.confirmHardReset') === false) return true;
  const st = await invoke('git:status', { repoId, untracked: 'all' }).catch(() => null);
  const entries = st?.entries.filter((e) => e.kind !== 'ignored') ?? [];
  const modified = entries.filter((e) => e.kind !== 'untracked').length;
  const untracked = entries.length - modified;
  const lines = [
    `${branch} will be moved to ${label}.`,
    modified
      ? `${plural(modified, 'modified file')} will be reset — their uncommitted changes are discarded.`
      : 'There are no uncommitted changes to tracked files.',
    untracked ? `${plural(untracked, 'untracked file')} ${untracked === 1 ? 'is' : 'are'} not removed.` : '',
    'You can undo this.',
  ].filter(Boolean);
  const pick = await choose({
    title: 'Hard reset?',
    message: lines.join('\n'),
    checkbox: { label: "Don't ask again", initial: false },
    choices: [
      { value: 'cancel', label: 'Cancel' },
      { value: 'ok', label: 'Reset hard', danger: true },
    ],
  });
  if (pick?.value !== 'ok') return false;
  if (pick.checked) void useSettingsStore.getState().set('git.confirmHardReset', false);
  return true;
}

/** Move a branch that is not checked out (spec 05 §6.9 `update-ref`, soft/mixed only). */
export function resetOtherBranch(
  repoId: RepoId,
  branch: string,
  target: string,
  label = shortSha(target),
): void {
  quiet(
    runOp(
      repoId,
      { type: 'reset.branch', branch, target, mode: 'soft' },
      { successToast: `Moved ${branch} to ${label}` },
    ),
  );
}

/** "Move a branch here…" on a commit: pick a local branch that is not checked out. */
export async function moveBranchHere(repoId: RepoId, sha: Sha): Promise<void> {
  const refs = await invoke('git:refs', { repoId });
  const candidates = refs.filter((r) => r.type === 'local' && !r.isHead && !r.worktreePath && r.sha !== sha);
  if (!candidates.length) {
    await confirm(
      'No branch to move',
      'Every other local branch is checked out somewhere or already here.',
      'OK',
    );
    return;
  }
  const r = await prompt({
    title: `Move a branch to ${shortSha(sha)}`,
    label: `Branch (not checked out): ${candidates
      .slice(0, 8)
      .map((c) => c.shortName)
      .join(', ')}${candidates.length > 8 ? ', …' : ''}`,
    initial: candidates.length === 1 ? candidates[0]!.shortName : '',
    okLabel: 'Move branch',
    validate: (v) =>
      candidates.some((c) => c.shortName === v.trim())
        ? null
        : 'Pick a local branch that is not checked out.',
  });
  if (r) resetOtherBranch(repoId, r.value.trim(), sha);
}

// ---------------------------------------------------------------------------
// merge (spec 05 §6.5)

const MODE_LABEL: Record<MergeMode, string> = {
  default: 'Merge (fast-forward if possible)',
  'no-ff': 'Always create a merge commit (--no-ff)',
  'ff-only': 'Fast-forward only (--ff-only)',
  squash: 'Squash (stage the result, commit yourself)',
};

/** The `git.mergeBehavior` preference (spec 05 §2.4 "Merge behavior"). */
export const defaultMergeMode = (): MergeMode => setting('git.mergeBehavior') ?? 'default';

export function runMerge(repoId: RepoId, source: string, mode: MergeMode = defaultMergeMode()): void {
  const name = shortRef(source);
  quiet(
    runOp(
      repoId,
      { type: 'merge.run', source, mode },
      {
        successToast: (r) =>
          mode === 'squash'
            ? `Squashed ${name} — the result is staged; commit it to finish`
            : (r.summary ?? `Merged ${name}`),
      },
    ),
  );
}

/** "Merge X into H…": choose the mode (spec 05 §4.2/§4.4 with the four modes of §6.5). */
export async function mergeWithOptions(
  repoId: RepoId,
  source: string,
  into = 'the current branch',
): Promise<void> {
  const def = defaultMergeMode();
  const pick = await choose<MergeMode | 'cancel'>({
    title: `Merge ${shortRef(source)} into ${into}`,
    message: 'How should the branches be combined?',
    choices: [
      { value: 'cancel', label: 'Cancel' },
      ...(['squash', 'ff-only', 'no-ff', 'default'] as const).map((m) => ({
        value: m,
        label: MODE_LABEL[m] + (m === def ? ' — default' : ''),
        primary: m === def,
      })),
    ],
  });
  if (!pick || pick.value === 'cancel') return;
  runMerge(repoId, source, pick.value);
}

/** `.git/SQUASH_MSG` (comments stripped) for the commit composer after a squash merge (spec 05 §6.5). */
export function squashMergeMessage(repoId: RepoId): Promise<string | null> {
  return undoInvoke('branching:squashMsg', { repoId }).catch(() => null);
}

// ---------------------------------------------------------------------------
// cherry-pick / revert (spec 05 §6.9)

/** Parent prompt for merge commits; undefined = no merge involved, null = cancelled. */
export async function pickMainline(
  verb: 'Cherry-pick' | 'Revert',
  commits: CommitLite[],
): Promise<number | undefined | null> {
  const merges = commits.filter((c) => c.parents.length > 1);
  if (!merges.length) return undefined;
  const pick = await choose({
    title: `${verb} merge commit${merges.length > 1 ? 's' : ''}`,
    message:
      verb === 'Revert'
        ? 'Which parent is the mainline (the side whose changes are kept)?'
        : `Which parent is the mainline? The changes ${merges.length > 1 ? 'the merges' : 'the merge'} brought in relative to it are picked.`,
    choices: [
      { value: 'cancel', label: 'Cancel' },
      { value: '2', label: 'Parent 2 (merged branch)' },
      { value: '1', label: 'Parent 1 (target branch)', primary: true },
    ],
  });
  if (!pick || pick.value === 'cancel') return null;
  return Number(pick.value);
}

/** Cherry-pick one or more commits (main sorts them topologically, oldest first). */
export async function cherryPickCommits(repoId: RepoId, commits: CommitLite[]): Promise<void> {
  const mainline = await pickMainline('Cherry-pick', commits);
  if (mainline === null) return;
  const shas = commits.map((c) => c.sha);
  quiet(
    runOp(
      repoId,
      { type: 'cherryPick.run', shas, ...(mainline ? { mainline } : {}) },
      {
        successToast:
          shas.length === 1 ? `Cherry-picked ${shortSha(shas[0]!)}` : `Cherry-picked ${shas.length} commits`,
      },
    ),
  );
}

/** Revert one or more commits (main applies them newest first). */
export async function revertCommits(repoId: RepoId, commits: CommitLite[]): Promise<void> {
  const mainline = await pickMainline('Revert', commits);
  if (mainline === null) return;
  const shas = commits.map((c) => c.sha);
  quiet(
    runOp(
      repoId,
      { type: 'revert.run', shas, ...(mainline ? { mainline } : {}) },
      {
        successToast:
          shas.length === 1 ? `Reverted ${shortSha(shas[0]!)}` : `Reverted ${shas.length} commits`,
      },
    ),
  );
}

// ---------------------------------------------------------------------------
// squash (spec 05 §4.2, §6.9)

/** Oldest first by commit time (the op re-checks topology); combined message pre-filled. */
export async function squashCommits(repoId: RepoId, shas: Sha[]): Promise<void> {
  const details = await Promise.all(shas.map((sha) => invoke('git:commit:detail', { repoId, sha })));
  details.sort((a, b) => a.commitTime - b.commitTime);
  const message = details.map((d) => [d.subject, d.body?.trim()].filter(Boolean).join('\n\n')).join('\n\n');
  const text = await openSquashDialog({ count: shas.length, message });
  if (text === null) return;
  quiet(
    runOp(
      repoId,
      { type: 'squash.run', shas, message: text },
      { successToast: `Squashed ${shas.length} commits. Undo with Ctrl+Z.` },
    ),
  );
}

// ---------------------------------------------------------------------------
// range / pivot rebase (spec 05 §6.7)

/**
 * "Rebase N commits onto…" / "Rebase from this commit onto…": `git rebase --onto <target> <oldest>^ <branch>`.
 * `branch` must be the branch whose tip the range ends at (the checked-out one in practice).
 */
export async function rebaseCommitsOnto(
  repoId: RepoId,
  oldest: Sha,
  branch: string,
  count?: number,
): Promise<void> {
  const what = count ? plural(count, 'commit') : `${branch} from ${shortSha(oldest)}`;
  const r = await prompt({
    title: `Rebase ${what} onto…`,
    label: 'Target branch, tag or commit',
    placeholder: 'main',
    okLabel: 'Rebase',
    validate: async (v) => {
      if (!v.trim()) return 'Enter a branch, tag or commit.';
      const sha = await invoke('git:revParse', { repoId, rev: v.trim() }).catch(() => null);
      if (!sha) return `"${v.trim()}" does not exist.`;
      const rel = await undoInvoke('branching:relation', { repoId, a: v.trim(), b: oldest }).catch(
        () => null,
      );
      if (rel && !rel.mergeBase) return rel.shallow ? 'History is shallow.' : 'No common ancestor.';
      return null;
    },
  });
  if (!r) return;
  const onto = r.value.trim();
  quiet(
    runOp(
      repoId,
      { type: 'rebase.run', onto, upstream: `${oldest}^`, branch },
      { successToast: `Rebased ${what} onto ${onto}` },
    ),
  );
}

// ---------------------------------------------------------------------------
// copy link, patches, remote branches (spec 05 §2.1, §6.1, §6.2)

/** "Copy link to commit/branch" (provider web URL, spec 05 §6.2; falls back to a toast when unknown). */
export async function copyLink(
  repoId: RepoId,
  target: { kind: 'commit'; sha: Sha } | { kind: 'branch'; name: string },
): Promise<void> {
  const url = await intInvoke('provider:webUrl', { repoId, target }).catch(() => null);
  if (!url) {
    useToastStore.getState().push({
      kind: 'warning',
      title: 'No web link available',
      body: 'None of the remotes points to a known hosting provider.',
    });
    return;
  }
  await invoke('shell:copyText', { text: url });
  useToastStore.getState().push({ kind: 'success', title: 'Link copied', body: url });
}

/** "Create patch" for a commit selection: one mbox, oldest first. */
export async function saveCommitsPatch(repoId: RepoId, shas: Sha[]): Promise<void> {
  try {
    const r = await undoInvoke('branching:savePatch', { repoId, shas });
    if (r.saved) useToastStore.getState().push({ kind: 'success', title: 'Patch saved', body: r.path });
  } catch (e) {
    if (e instanceof IpcError) showError(e.error);
  }
}

/** Rename a remote branch: push the new name, delete the old one, relink local upstreams (spec 05 §6.1). */
export async function renameRemoteBranch(repoId: RepoId, ref: RefInfo): Promise<void> {
  const [remote, ...rest] = ref.shortName.split('/');
  const from = rest.join('/');
  if (!remote || !from) return;
  const r = await prompt({
    title: `Rename ${ref.shortName} on ${remote}`,
    label: 'Pushes the branch under the new name, deletes the old one and updates local upstreams.',
    initial: from,
    okLabel: 'Rename on remote',
    validate: async (v) => {
      const name = v.trim();
      if (name === from) return 'Choose a different name.';
      const refs = await invoke('git:refs', { repoId });
      if (refs.some((x) => x.type === 'remote' && x.shortName === `${remote}/${name}`))
        return `${remote}/${name} already exists.`;
      const ok = await invoke('git:branch:validateName', { repoId, name });
      return ok.valid ? null : (ok.reason ?? 'That is not a valid branch name.');
    },
  });
  if (!r) return;
  quiet(
    runOp(
      repoId,
      { type: 'branch.renameRemote', remote, from, to: r.value.trim() },
      { successToast: `Renamed ${ref.shortName} to ${remote}/${r.value.trim()}` },
    ),
  );
}

// ---------------------------------------------------------------------------
// stash extras (spec 05 §4.9, §6.10)

async function stagedStashSupported(): Promise<boolean> {
  const info = await invoke('git:engine:info', {}).catch(() => null);
  // `--staged` and `status --show-stash` both arrived in git 2.35
  return !!info?.features.statusShowStash;
}

/** StashDialog: message, include untracked, keep index, staged only, paths (Shift+click Stash, spec 05 §4.9). */
export async function stashWithOptions(repoId: RepoId, paths?: string[], message?: string): Promise<void> {
  const r = await openStashDialog({
    message,
    paths,
    includeUntracked: setting('general.stashIncludeUntracked') ?? true,
    stagedSupported: await stagedStashSupported(),
  });
  if (!r) return;
  quiet(
    runOp(
      repoId,
      {
        type: 'stash.push',
        ...(r.message ? { message: r.message } : {}),
        includeUntracked: r.includeUntracked,
        keepIndex: r.keepIndex,
        ...(r.stagedOnly ? { stagedOnly: true } : {}),
        ...(r.paths.length ? { paths: r.paths } : {}),
      },
      { successToast: r.paths.length ? `Stashed ${plural(r.paths.length, 'file')}` : 'Changes stashed' },
    ),
  );
}

/** "Stash file(s)" for file context menus (staged / unstaged lists): `git stash push -- <paths>`. */
export function stashFiles(repoId: RepoId, paths: string[], message?: string): void {
  if (!paths.length) return;
  quiet(
    runOp(
      repoId,
      {
        type: 'stash.push',
        ...(message ? { message } : {}),
        includeUntracked: true,
        paths,
      },
      { successToast: `Stashed ${paths.length === 1 ? paths[0] : plural(paths.length, 'file')}` },
    ),
  );
}

/** Menu entries "Stash file" / "Stash file with options…" for a file context menu. */
export function stashFileMenuItems(repoId: RepoId, paths: string[]): MenuEntry[] {
  const label = paths.length === 1 ? 'Stash file' : `Stash ${paths.length} files`;
  return [
    { label, onSelect: () => stashFiles(repoId, paths) },
    { label: `${label} with options…`, onSelect: () => void stashWithOptions(repoId, paths) },
  ];
}

/** Alt+S: stash everything (message optional, untracked per preference). */
export function quickStash(repoId: RepoId, message?: string): void {
  quiet(
    runOp(
      repoId,
      {
        type: 'stash.push',
        ...(message?.trim() ? { message: message.trim() } : {}),
        includeUntracked: setting('general.stashIncludeUntracked') ?? true,
      },
      { successToast: 'Changes stashed' },
    ),
  );
}

/** Alt+Shift+S: pop the newest stash. */
export async function popLatestStash(repoId: RepoId): Promise<void> {
  const top = (await invoke('git:stash:list', { repoId }))[0];
  if (!top) {
    useToastStore.getState().push({ kind: 'info', title: 'No stashes to pop' });
    return;
  }
  quiet(
    runOp(repoId, { type: 'stash.pop', index: top.index, sha: top.sha }, { successToast: 'Popped stash' }),
  );
}

const stashText = (m: string): string => m.replace(/^(?:WIP on|On) [^:]+: /, '');

export async function renameStash(
  repoId: RepoId,
  s: Pick<StashEntry, 'index' | 'sha' | 'message'>,
): Promise<void> {
  const r = await prompt({
    title: `Edit message of stash@{${s.index}}`,
    initial: stashText(s.message),
    okLabel: 'Save',
    validate: (v) => (v.trim() ? null : 'Enter a message.'),
  });
  if (!r) return;
  quiet(runOp(repoId, { type: 'stash.rename', index: s.index, sha: s.sha, message: r.value.trim() }));
}

export function applyStashFile(repoId: RepoId, s: Pick<StashEntry, 'index' | 'sha'>, path: string): void {
  quiet(
    runOp(
      repoId,
      { type: 'stash.applyFile', index: s.index, sha: s.sha, path },
      { successToast: `Applied ${path} from stash@{${s.index}}` },
    ),
  );
}

export async function branchFromStash(repoId: RepoId, s: Pick<StashEntry, 'index' | 'sha'>): Promise<void> {
  const r = await prompt({
    title: `Create branch from stash@{${s.index}}`,
    label: 'Checks out the commit the stash was made on, applies it and drops the stash (git stash branch).',
    placeholder: 'feature/from-stash',
    okLabel: 'Create branch',
    validate: (v) => validateBranchName(repoId, v),
  });
  if (!r) return;
  quiet(
    runOp(
      repoId,
      { type: 'stash.branch', index: s.index, sha: s.sha, name: r.value.trim() },
      { successToast: `Created branch ${r.value.trim()}` },
    ),
  );
}

/** Stash context-menu additions (spec 05 §4.2 "Stash": Edit message, Create branch from stash). */
export function stashExtraMenuItems(repoId: RepoId, s: StashEntry): MenuEntry[] {
  return [
    { label: 'Edit stash message…', onSelect: () => void renameStash(repoId, s) },
    { label: 'Create branch from stash…', onSelect: () => void branchFromStash(repoId, s) },
  ];
}

/** "Apply this file from stash" for a file of a selected stash (spec 05 §4.9). */
export function stashFileApplyItem(
  repoId: RepoId,
  s: Pick<StashEntry, 'index' | 'sha'>,
  path: string,
): MenuEntry {
  return { label: 'Apply this file from stash', onSelect: () => applyStashFile(repoId, s, path) };
}
