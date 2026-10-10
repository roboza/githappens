import type { RepoId } from '@githappens/git/types';
import { useMemo, useState } from 'react';

import { invoke } from '../../lib/api';
import { runOp } from '../../lib/ops';
import { useRefs, useRepoInfo } from '../../repo/queries';
import { Field, FormDialog, formStyles as s } from '../remotes/FormDialog';
import { openWorktree } from './worktree-actions';
import {
  buildWorktreeAddOp,
  defaultWorktreePath,
  pathLabel,
  type OpenAfter,
  type WorktreeForm,
  type WorktreeMode,
} from './worktree-model';

const MODES: { id: WorktreeMode; label: string }[] = [
  { id: 'new', label: 'New branch' },
  { id: 'existing', label: 'Existing branch' },
  { id: 'detached', label: 'Detached at commit' },
];

const OPEN: { id: OpenAfter; label: string }[] = [
  { id: 'new', label: 'Open in a new tab' },
  { id: 'current', label: 'Open in this tab' },
  { id: 'none', label: "Don't open" },
];

/** Create Worktree (spec 09 §4.3): new branch / existing branch / detached, folder, open-after choice. */
export function WorktreeDialog({
  repoId,
  initial,
  onClose,
}: {
  repoId: RepoId;
  initial?: Partial<WorktreeForm>;
  onClose(): void;
}) {
  const info = useRepoInfo(repoId).data;
  const refsData = useRefs(repoId).data;
  const refs = useMemo(() => refsData ?? [], [refsData]);
  const locals = useMemo(() => refs.filter((r) => r.type === 'local'), [refs]);
  const branchNames = locals.map((r) => r.shortName);
  const checkedOut = locals.filter((r) => r.isHead || r.worktreePath).map((r) => r.shortName);
  const free = locals.filter((r) => !r.isHead && !r.worktreePath);
  const root = info?.worktreeRoot ?? null;

  const [form, setForm] = useState<WorktreeForm>(() => ({
    mode: 'new',
    branch: free[0]?.shortName ?? '',
    newBranch: '',
    startPoint: '',
    path: '',
    open: 'new',
    ...initial,
  }));
  const [pathEdited, setPathEdited] = useState(!!initial?.path);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectivePath = pathEdited ? form.path : defaultWorktreePath(root, pathLabel(form) || 'worktree');
  const set = (p: Partial<WorktreeForm>): void => {
    setForm((f) => ({ ...f, ...p }));
    setError(null);
  };

  const submit = async (): Promise<void> => {
    const built = buildWorktreeAddOp({ ...form, path: effectivePath }, branchNames, checkedOut);
    if ('error' in built) {
      setError(built.error);
      return;
    }
    if (form.mode === 'new') {
      const v = await invoke('git:branch:validateName', { repoId, name: form.newBranch.trim() });
      if (!v.valid) {
        setError(v.reason ?? 'Invalid branch name.');
        return;
      }
    }
    setBusy(true);
    try {
      const r = await runOp(repoId, built.op, { successToast: (res) => res.summary ?? 'Created worktree' });
      onClose();
      const created = (r?.data as { path?: string } | undefined)?.path ?? effectivePath;
      if (r) openWorktree(created, form.open);
    } catch {
      setBusy(false);
    }
  };

  return (
    <FormDialog
      title="Create worktree"
      okLabel="Create worktree"
      onCancel={onClose}
      onSubmit={() => void submit()}
      busy={busy}
      error={error}
      wide
    >
      <div className={s.radios} role="radiogroup" aria-label="Worktree source">
        {MODES.map((m) => (
          <label key={m.id}>
            <input
              type="radio"
              name="wt-mode"
              checked={form.mode === m.id}
              onChange={() => set({ mode: m.id })}
            />
            {m.label}
          </label>
        ))}
      </div>
      {form.mode === 'new' && (
        <div className={s.row}>
          <Field label="New branch name">
            <input
              type="text"
              autoFocus
              value={form.newBranch}
              placeholder="feature/x"
              spellCheck={false}
              onChange={(e) => set({ newBranch: e.target.value })}
            />
          </Field>
          <Field label="Start point" hint="Branch, tag or commit (default HEAD)">
            <input
              type="text"
              value={form.startPoint}
              placeholder="HEAD"
              list="kl-wt-refs"
              spellCheck={false}
              onChange={(e) => set({ startPoint: e.target.value })}
            />
          </Field>
        </div>
      )}
      {form.mode === 'existing' && (
        <Field
          label="Branch"
          hint={
            checkedOut.length
              ? `Branches checked out elsewhere are not listed (${checkedOut.join(', ')}).`
              : undefined
          }
        >
          <select value={form.branch} onChange={(e) => set({ branch: e.target.value })}>
            {!free.length && <option value="">No free local branch</option>}
            {free.map((r) => (
              <option key={r.fullName} value={r.shortName}>
                {r.shortName}
              </option>
            ))}
          </select>
        </Field>
      )}
      {form.mode === 'detached' && (
        <Field label="Commit" hint="Branch, tag or commit SHA (default HEAD)">
          <input
            type="text"
            autoFocus
            value={form.startPoint}
            placeholder="HEAD"
            list="kl-wt-refs"
            spellCheck={false}
            onChange={(e) => set({ startPoint: e.target.value })}
          />
        </Field>
      )}
      <datalist id="kl-wt-refs">
        {refs
          .filter((r) => r.type === 'local' || r.type === 'remote' || r.type === 'tag')
          .slice(0, 500)
          .map((r) => (
            <option key={r.fullName} value={r.shortName} />
          ))}
      </datalist>
      <Field label="Folder" hint="Must not exist or be empty">
        <input
          type="text"
          value={effectivePath}
          spellCheck={false}
          onChange={(e) => {
            setPathEdited(true);
            set({ path: e.target.value });
          }}
        />
      </Field>
      <div className={s.radios} role="radiogroup" aria-label="After creating">
        {OPEN.map((o) => (
          <label key={o.id}>
            <input
              type="radio"
              name="wt-open"
              checked={form.open === o.id}
              onChange={() => set({ open: o.id })}
            />
            {o.label}
          </label>
        ))}
      </div>
    </FormDialog>
  );
}
