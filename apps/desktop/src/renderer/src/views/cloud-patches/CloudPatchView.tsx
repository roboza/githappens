import type { FileDiff, RepoId } from '@githappens/git/types';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, CloudDownload, Download, GitBranch, Lock, Trash2, TriangleAlert, X } from 'lucide-react';
import { useState } from 'react';

import type { OpenedPatch, PatchApplyTarget } from '../../../../shared/ipc/patches-contract';
import { applyCloudPatch, downloadPatchFile } from '../../cloud-patches/actions';
import { errorText, patchInvoke } from '../../cloud-patches/api';
import { useOpenedPatches } from '../../cloud-patches/store';
import { prompt } from '../../components/Dialogs';
import { formatDate, shortSha } from '../../lib/format';
import { useRefs } from '../../repo/queries';
import { useRepoUiStore } from '../../stores/repo-ui';
import { useToastStore } from '../../stores/toasts';
import diffStyles from '../diff/DiffView.module.css';
import s from './CloudPatches.module.css';
import { deletePatch } from './CloudPatchesSection';

const MATCH_LABEL = {
  remote: 'Matches this repository',
  'root-commit': 'Same history as this repository (fork or mirror)',
  chosen: 'Repository chosen manually',
} as const;

const slug = (t: string): string =>
  t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'patch';

/**
 * CloudPatchView (spec 14 §4.2): header (author, base commit availability, repo match), file list with a
 * read-only diff, and Apply to working tree / new branch / existing branch, Download .patch, Delete (owner).
 */
export default function CloudPatchView({ repoId, patchId }: { repoId: RepoId; patchId: string }) {
  const opened = useOpenedPatches((st) => st.byId[patchId]);
  const close = (): void => useRepoUiStore.getState().update(repoId, () => ({ center: { kind: 'graph' } }));
  if (!opened) {
    return (
      <div className={s.view}>
        <p className={s.message}>
          This Cloud Patch is no longer loaded. Open its link again.{' '}
          <button type="button" onClick={close}>
            Close
          </button>
        </p>
      </div>
    );
  }
  return <PatchBody repoId={repoId} opened={opened} onClose={close} />;
}

function PatchBody({ repoId, opened, onClose }: { repoId: RepoId; opened: OpenedPatch; onClose(): void }) {
  const { patch, bundle } = opened;
  const qc = useQueryClient();
  const refs = useRefs(repoId);
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState(false);
  const check = useQuery({
    queryKey: ['cloudPatches', 'check', patch.id, repoId],
    queryFn: () => patchInvoke('patch:checkRepo', { patchId: patch.id, repoId }),
  });
  const candidate = check.data;
  const created = Math.floor(Date.parse(patch.createdAt) / 1000);
  const file: FileDiff | undefined = opened.diff[selected];

  const fetchBase = async (): Promise<void> => {
    setBusy(true);
    try {
      const r = await patchInvoke('patch:fetchBase', { patchId: patch.id, repoId });
      if (!r.baseAvailable)
        useToastStore.getState().push({
          kind: 'warning',
          title: 'Base commit still missing',
          body: 'A 3-way apply may still work; otherwise apply with .rej files.',
        });
      await qc.invalidateQueries({ queryKey: ['cloudPatches', 'check', patch.id, repoId] });
    } catch (e) {
      useToastStore.getState().push({ kind: 'error', title: 'Fetch failed', body: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  const apply = async (target: PatchApplyTarget, commit?: boolean): Promise<void> => {
    setBusy(true);
    try {
      const r = await applyCloudPatch({
        patchId: patch.id,
        repoId,
        target,
        ...(commit !== undefined ? { commit } : {}),
      });
      if (r && !r.conflicts.length && target.kind !== 'worktree') onClose();
      else if (r && !r.conflicts.length) useRepoUiStore.getState().select(repoId, { kind: 'wip' });
    } finally {
      setBusy(false);
    }
  };

  const localBranches = (refs.data ?? []).filter((r) => r.type === 'local').map((r) => r.shortName);

  const applyNewBranch = async (): Promise<void> => {
    const r = await prompt({
      title: 'Apply to a new branch',
      label: candidate?.baseAvailable
        ? `Branch name (starts at the patch base ${shortSha(bundle.baseSha)})`
        : 'Branch name (starts at HEAD: the patch base is not available locally)',
      initial: `cloud-patch/${slug(bundle.title)}`,
      okLabel: 'Create branch and apply',
      checkbox: {
        label: bundle.kind === 'commit' ? 'Commit (keeps the original author)' : 'Commit the changes',
        initial: true,
      },
      validate: (v) =>
        !v.trim()
          ? 'Enter a branch name.'
          : localBranches.includes(v.trim())
            ? 'That branch already exists.'
            : null,
    });
    if (r) await apply({ kind: 'new-branch', name: r.value.trim() }, r.checked);
  };

  const applyExisting = async (): Promise<void> => {
    const current = (refs.data ?? []).find((x) => x.type === 'local' && x.isHead)?.shortName;
    const r = await prompt({
      title: 'Apply to an existing branch',
      label: `Branch (${localBranches.slice(0, 5).join(', ')}${localBranches.length > 5 ? ', …' : ''})`,
      initial: current ?? '',
      okLabel: 'Apply',
      checkbox: { label: 'Commit the changes', initial: bundle.kind === 'commit' },
      validate: (v) => (localBranches.includes(v.trim()) ? null : 'Enter the name of a local branch.'),
    });
    if (r) await apply({ kind: 'existing-branch', name: r.value.trim() }, r.checked);
  };

  return (
    <div className={s.view}>
      <header className={s.header}>
        <div className={s.headerTop}>
          {patch.e2e && <Lock size={14} aria-label="End-to-end encrypted" />}
          <h2 title={bundle.title}>{bundle.title}</h2>
          <button
            type="button"
            className={s.iconBtn}
            aria-label="Close Cloud Patch"
            title="Close"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>
        <div className={s.meta}>
          <span>
            {bundle.kind === 'commit' ? 'Commit' : bundle.kind === 'stash' ? 'Stash' : 'Changes'} shared by{' '}
            {patch.author.name} · {formatDate(created)}
          </span>
          <span>
            Base <code>{shortSha(bundle.baseSha)}</code>
            {bundle.baseBranch ? ` (${bundle.baseBranch})` : ''}{' '}
            {check.isPending ? (
              '…'
            ) : candidate?.baseAvailable ? (
              <span className={s.ok}>
                <Check size={12} /> available locally
              </span>
            ) : (
              <>
                <span className={s.bad}>
                  <TriangleAlert size={12} /> not available locally
                </span>{' '}
                <button type="button" disabled={busy} onClick={() => void fetchBase()}>
                  <CloudDownload size={13} /> Fetch
                </button>
              </>
            )}
          </span>
          {candidate && <span>{MATCH_LABEL[candidate.match]}</span>}
          {patch.repo && (
            <span>
              {patch.repo.host}/{patch.repo.owner}/{patch.repo.name}
            </span>
          )}
          {check.error && <span className={s.bad}>{errorText(check.error)}</span>}
        </div>
        {bundle.description && <p className={s.description}>{bundle.description}</p>}
        {opened.warnings.map((w) => (
          <p key={w} className={s.warning}>
            <TriangleAlert size={13} /> {w}
          </p>
        ))}
        <div className={s.actions}>
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => void apply({ kind: 'worktree' })}
          >
            Apply to working tree
          </button>
          <button type="button" disabled={busy} onClick={() => void applyNewBranch()}>
            <GitBranch size={13} /> Apply to new branch…
          </button>
          <button type="button" disabled={busy || !localBranches.length} onClick={() => void applyExisting()}>
            Apply to existing branch…
          </button>
          <button type="button" onClick={() => downloadPatchFile(bundle.title, bundle.patch)}>
            <Download size={13} /> Download .patch
          </button>
          {patch.mine && (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void deletePatch(patch).then((ok) => {
                  if (!ok) return;
                  useOpenedPatches.getState().remove(patch.id);
                  onClose();
                })
              }
            >
              <Trash2 size={13} /> Delete
            </button>
          )}
        </div>
      </header>
      <div className={s.body}>
        <nav className={s.fileList} aria-label="Files in this patch">
          {bundle.files.map((f, i) => (
            <button
              key={`${f.path}-${i}`}
              type="button"
              className={s.fileRow}
              aria-current={i === selected}
              onClick={() => setSelected(i)}
              title={f.path}
            >
              <span className={s.status} data-status={f.status}>
                {f.status}
              </span>
              <span className={s.treeName}>{f.path}</span>
              {f.binary ? (
                <span className={s.stat}>bin</span>
              ) : (
                <span className={s.stat}>
                  <span className={s.add}>+{f.additions}</span> <span className={s.del}>−{f.deletions}</span>
                </span>
              )}
            </button>
          ))}
        </nav>
        <div className={s.diff}>
          {file ? <ReadOnlyDiff file={file} /> : <p className={s.message}>No changes.</p>}
        </div>
      </div>
    </div>
  );
}

/** Read-only hunk rendering with the diff view's styles. */
function ReadOnlyDiff({ file }: { file: FileDiff }) {
  if (file.binary) return <p className={diffStyles.message}>Binary file changed.</p>;
  if (file.tooLarge) return <p className={diffStyles.message}>This diff is too large to display.</p>;
  if (file.lfsPointer)
    return (
      <p className={diffStyles.message}>
        Git LFS object <code>{file.lfsPointer.oid.slice(0, 12)}</code> (only the pointer is shared).
      </p>
    );
  if (!file.hunks.length) {
    return (
      <p className={diffStyles.message}>
        {file.status === 'R' ? 'File renamed without changes.' : 'No content changes (mode change).'}
      </p>
    );
  }
  return (
    <div className={diffStyles.hunks} role="table" aria-label="Diff hunks">
      {file.hunks.map((h, hi) => (
        <section key={hi} className={diffStyles.hunk}>
          <div className={diffStyles.hunkHeader} role="row">
            <span className={diffStyles.hunkTitle}>{h.header}</span>
          </div>
          {h.lines.map((l, i) => (
            <div key={i} role="row" className={`${diffStyles.line} ${diffStyles[l.type]}`}>
              <span className={diffStyles.ln}>{l.oldLineNo ?? ''}</span>
              <span className={diffStyles.ln}>{l.newLineNo ?? ''}</span>
              <span className={diffStyles.sign}>{l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}</span>
              <span className={diffStyles.code}>
                {l.type === 'nonewline' ? '\\ No newline at end of file' : l.content}
              </span>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
