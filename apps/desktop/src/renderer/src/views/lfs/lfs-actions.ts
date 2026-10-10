import type { LfsStatus, RemoteInfo, RepoId } from '@githappens/git/types';

import type { CommandDef } from '../../commands/types';
import type { MenuEntry } from '../../components/ContextMenu';
import { confirm, prompt } from '../../components/Dialogs';
import { invoke } from '../../lib/api';
import { quiet, runOp } from '../../lib/ops';
import { openLfsLocks } from '../remotes/dialog-store';
import { parsePatterns } from './lfs-model';

/** Git LFS actions (spec 09 §4.2 "LFS ▾": Pull, Fetch, Push all, Prune…, Locks…, Track pattern…, Untrack…). */

export function initializeLfs(repoId: RepoId): void {
  quiet(runOp(repoId, { type: 'lfs.install' }, { successToast: 'Initialized Git LFS' }));
}

export async function trackPattern(repoId: RepoId): Promise<void> {
  const r = await prompt({
    title: 'Track with Git LFS',
    label: 'Pattern(s), comma separated',
    placeholder: '*.psd',
    okLabel: 'Track',
    checkbox: { label: 'Also convert existing matching files', initial: false },
    validate: (v) => {
      const p = parsePatterns(v);
      return 'error' in p ? p.error : null;
    },
  });
  if (!r) return;
  const p = parsePatterns(r.value);
  if ('error' in p) return;
  quiet(
    runOp(
      repoId,
      r.checked ? { type: 'lfs.convert', patterns: p.patterns } : { type: 'lfs.track', patterns: p.patterns },
      {
        successToast: (res) =>
          r.checked
            ? (res.summary ?? 'Converted')
            : `Tracking ${p.patterns.join(', ')} — stage .gitattributes to share it`,
      },
    ),
  );
}

/** "Convert existing files" (spec 09 §6.8): track + `git add --renormalize`, staged for the next commit. */
export async function convertExisting(repoId: RepoId, initial = ''): Promise<void> {
  const r = await prompt({
    title: 'Convert existing files to Git LFS',
    label: 'Pattern(s), comma separated',
    initial,
    placeholder: '*.psd',
    okLabel: 'Convert',
    validate: (v) => {
      const p = parsePatterns(v);
      return 'error' in p ? p.error : null;
    },
  });
  if (!r) return;
  const p = parsePatterns(r.value);
  if ('error' in p) return;
  quiet(
    runOp(
      repoId,
      { type: 'lfs.convert', patterns: p.patterns },
      { successToast: (res) => `${res.summary ?? 'Converted'} — commit to record` },
    ),
  );
}

export async function pruneLfs(repoId: RepoId): Promise<void> {
  const ok = await confirm(
    'Prune old LFS objects?',
    'Local copies of LFS objects that are not referenced by recent commits and were already pushed are deleted. They can be downloaded again later.',
    'Prune',
    true,
  );
  if (ok)
    quiet(runOp(repoId, { type: 'lfs.prune' }, { successToast: (r) => r.summary ?? 'Pruned LFS objects' }));
}

/** Items of the LFS menu (toolbar button / palette). Initialize is offered whenever hooks are missing. */
export function lfsMenuItems(
  repoId: RepoId,
  status: Pick<LfsStatus, 'available' | 'initialized' | 'tracked'> | undefined,
  remotes: readonly Pick<RemoteInfo, 'name'>[] | undefined,
): MenuEntry[] {
  if (!status?.available)
    return [
      { label: 'Git LFS was not found', disabled: true, title: 'Install git-lfs or use the bundled git' },
    ];
  const remote = remotes?.find((r) => r.name === 'origin')?.name ?? remotes?.[0]?.name;
  const tracked = status.tracked;
  return [
    ...(!status.initialized
      ? [{ label: 'Initialize LFS', onSelect: () => initializeLfs(repoId) }, 'separator' as const]
      : []),
    {
      label: 'Pull LFS objects',
      disabled: !remote,
      onSelect: () => quiet(runOp(repoId, { type: 'lfs.pull' }, { successToast: 'Pulled LFS objects' })),
    },
    {
      label: 'Fetch LFS objects',
      disabled: !remote,
      onSelect: () => quiet(runOp(repoId, { type: 'lfs.fetch' })),
    },
    {
      label: remote ? `Push all LFS objects to ${remote}` : 'Push LFS objects',
      disabled: !remote,
      onSelect: () => remote && quiet(runOp(repoId, { type: 'lfs.push', remote, all: true })),
    },
    'separator',
    { label: 'Track pattern…', onSelect: () => void trackPattern(repoId) },
    {
      label: 'Convert existing files…',
      onSelect: () => void convertExisting(repoId, tracked.map((t) => t.pattern).join(', ')),
    },
    ...tracked.map((t) => ({
      label: `Untrack ${t.pattern}`,
      onSelect: () => quiet(runOp(repoId, { type: 'lfs.untrack', patterns: [t.pattern] })),
    })),
    'separator',
    { label: 'Locks…', disabled: !remote, onSelect: () => openLfsLocks(repoId) },
    { label: 'Prune old LFS objects…', onSelect: () => void pruneLfs(repoId) },
  ];
}

/** Palette commands (registered while the repo's left panel is mounted). */
export function lfsCommands(repoId: RepoId): CommandDef[] {
  const kw = ['lfs', 'git lfs', 'large file'];
  const status = (): Promise<LfsStatus> => invoke('git:lfs:status', { repoId });
  // `lfs.init` / `lfs.configure` (track) live in shell-commands
  return [
    {
      id: 'lfs.convert',
      title: 'Git LFS: Convert Existing Files…',
      category: 'Repo',
      keywords: kw,
      run: () =>
        void status().then((s) => convertExisting(repoId, s.tracked.map((t) => t.pattern).join(', '))),
    },
    {
      id: 'lfs.locks',
      title: 'Git LFS: Locks…',
      category: 'Repo',
      keywords: [...kw, 'lock', 'unlock'],
      run: () => openLfsLocks(repoId),
    },
    {
      id: 'lfs.prune',
      title: 'Git LFS: Prune…',
      category: 'Repo',
      keywords: kw,
      run: () => void pruneLfs(repoId),
    },
  ];
}
