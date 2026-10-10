import type { RepoId } from '@githappens/git/types';
import { useMemo, useState } from 'react';

import { runOp } from '../../lib/ops';
import { useRefs } from '../../repo/queries';
import { Field, FormDialog, formStyles as s } from './FormDialog';

/** "Set upstream…" (spec 09 §2 "Set Upstream"): pick a remote branch for `branch`, or unset it. */
export function UpstreamDialog({
  repoId,
  branch,
  current,
  onClose,
}: {
  repoId: RepoId;
  branch: string;
  current: string | null;
  onClose(): void;
}) {
  const refs = useRefs(repoId).data;
  const remoteBranches = useMemo(
    () =>
      (refs ?? [])
        .filter((r) => r.type === 'remote' && !r.symrefTarget)
        .map((r) => r.shortName)
        .sort((a, b) => a.localeCompare(b)),
    [refs],
  );
  const preferred =
    current ??
    remoteBranches.find((n) => n === `origin/${branch}`) ??
    remoteBranches.find((n) => n.endsWith(`/${branch}`));
  const [value, setValue] = useState(preferred ?? '');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const q = query.trim().toLowerCase();
  const shown = q ? remoteBranches.filter((n) => n.toLowerCase().includes(q)) : remoteBranches;

  const apply = async (upstream: string | null): Promise<void> => {
    setBusy(true);
    try {
      await runOp(
        repoId,
        { type: 'branch.setUpstream', localBranch: branch, upstream },
        { successToast: upstream ? `${branch} now tracks ${upstream}` : `Removed the upstream of ${branch}` },
      );
      onClose();
    } catch {
      setBusy(false);
    }
  };

  return (
    <FormDialog
      title={`Set upstream of ${branch}`}
      okLabel="Set upstream"
      onCancel={onClose}
      onSubmit={() => void apply(value)}
      busy={busy}
      okDisabled={!value || value === current}
      footer={
        current && (
          <button type="button" disabled={busy} onClick={() => void apply(null)}>
            Unset upstream
          </button>
        )
      }
    >
      <p className={s.muted}>
        {current ? (
          <>
            Currently tracking <code>{current}</code>.
          </>
        ) : (
          'This branch has no upstream.'
        )}
      </p>
      <Field label="Remote branch">
        <input
          type="text"
          autoFocus
          placeholder="Filter remote branches"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </Field>
      <div className={s.list} role="listbox" aria-label="Remote branches">
        {!shown.length && (
          <div className={s.empty}>
            {remoteBranches.length ? 'No match.' : 'No remote branches. Fetch first.'}
          </div>
        )}
        {shown.map((n) => (
          <button
            key={n}
            type="button"
            role="option"
            aria-selected={n === value}
            className={`${s.listItem} ${s.mono}`}
            onClick={() => setValue(n)}
            onDoubleClick={() => void apply(n)}
          >
            {n}
          </button>
        ))}
      </div>
    </FormDialog>
  );
}
