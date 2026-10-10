import type { RepoId } from '@githappens/git/types';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ListFilter } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { create } from 'zustand';

import styles from '../../components/Dialogs.module.css';
import { confirm } from '../../components/Dialogs';
import { runOp } from '../../lib/ops';
import { errorText, reposInvoke } from '../repos/api';

/**
 * Sparse checkout management (spec 03 §2, §7 step 17): a toolbar "Sparse" button while sparse checkout is
 * on, and a dialog to view / edit the patterns. Changes run as queued `sparse.*` operations.
 */

export const sparseKey = (repoId: RepoId) => ['sparse:state', repoId] as const;

export function useSparseState(repoId: RepoId) {
  return useQuery({
    queryKey: sparseKey(repoId),
    queryFn: () => reposInvoke('sparse:state', { repoId }),
    staleTime: 30_000,
    retry: false,
  });
}

export const useSparseDialog = create<{ repoId: RepoId | null; open(repoId: RepoId): void; close(): void }>(
  (set) => ({
    repoId: null,
    open: (repoId) => set({ repoId }),
    close: () => set({ repoId: null }),
  }),
);

/** Open the sparse-checkout dialog of a repo (palette `repo.sparseCheckout`). */
export const openSparseDialog = (repoId: RepoId): void => useSparseDialog.getState().open(repoId);

const toLines = (s: string): string[] =>
  s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

function SparseDialog({ repoId, onClose }: { repoId: RepoId; onClose(): void }) {
  const qc = useQueryClient();
  const state = useSparseState(repoId);
  const ref = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState<string | null>(null);
  const [cone, setCone] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (ref.current && !ref.current.open) ref.current.showModal();
  }, []);
  const s = state.data;
  const value = text ?? (s?.patterns ?? []).join('\n');
  const coneMode = s?.enabled ? s.cone : cone;

  const run = async (op: Parameters<typeof runOp>[1], toast: string): Promise<void> => {
    setBusy(true);
    try {
      const r = await runOp(repoId, op, { successToast: toast }).catch(() => null);
      if (r) {
        setText(null);
        await qc.invalidateQueries({ queryKey: sparseKey(repoId) });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      style={{ width: 'min(560px, calc(100vw - 32px))' }}
      aria-label="Sparse checkout"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <h2 className={styles.title}>Sparse checkout</h2>
      <div className={styles.body}>
        {state.isLoading && <p className={styles.message}>Loading…</p>}
        {state.error && <p className={styles.error}>{errorText(state.error)}</p>}
        {s && (
          <>
            <p className={styles.message}>
              {s.enabled
                ? `Enabled (${s.cone ? 'cone mode: directories' : 'pattern mode'}) — only these paths are checked out.`
                : 'Disabled — every file is checked out. Enter the directories to keep and apply to enable it.'}
              {s.filter ? ` Partial clone filter: ${s.filter}.` : ''}
            </p>
            <label className={styles.label}>
              {coneMode ? 'Directories (one per line)' : 'Patterns (one per line, gitignore syntax)'}
            </label>
            <textarea
              className={styles.input}
              aria-label="Sparse checkout paths"
              rows={8}
              value={value}
              onChange={(e) => setText(e.target.value)}
              disabled={busy}
            />
            {!s.enabled && (
              <label className={styles.check}>
                <input type="checkbox" checked={cone} onChange={(e) => setCone(e.target.checked)} /> Cone mode
                (directories only, faster)
              </label>
            )}
          </>
        )}
        <div className={styles.buttons}>
          {s?.enabled && (
            <>
              <button
                type="button"
                className={styles.danger}
                disabled={busy}
                onClick={() =>
                  void confirm(
                    'Disable sparse checkout?',
                    'Every file of the repository will be checked out. In a blobless clone missing file contents are downloaded.',
                    'Disable',
                    true,
                  ).then((ok) =>
                    ok ? run({ type: 'sparse.disable' }, 'Sparse checkout disabled') : undefined,
                  )
                }
              >
                Disable
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void run({ type: 'sparse.reapply' }, 'Sparse checkout reapplied')}
              >
                Reapply
              </button>
            </>
          )}
          <button type="button" onClick={onClose}>
            Close
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy || !s || !toLines(value).length}
            onClick={() =>
              void run(
                { type: 'sparse.set', patterns: toLines(value), ...(s?.enabled ? {} : { cone }) },
                'Sparse checkout updated',
              )
            }
          >
            {s?.enabled ? 'Apply' : 'Enable'}
          </button>
        </div>
      </div>
    </dialog>
  );
}

export interface SparseButtonProps {
  icon: ReactNode;
  label: string;
  busy?: boolean;
  title: string;
  onClick(): void;
}

/**
 * Toolbar slot (spec 03 §2 "toolbar Sparse button when active"): renders `renderButton` only while sparse
 * checkout is enabled, and hosts the dialog for this repo (opened from the button or the palette).
 */
export function SparseToolbarButton({
  repoId,
  busy,
  renderButton,
}: {
  repoId: RepoId;
  busy?: boolean;
  renderButton(p: SparseButtonProps): ReactNode;
}) {
  const state = useSparseState(repoId);
  const openFor = useSparseDialog((s) => s.repoId);
  const close = useSparseDialog((s) => s.close);
  const s = state.data;
  return (
    <>
      {s?.enabled &&
        renderButton({
          icon: <ListFilter size={17} />,
          label: 'Sparse',
          busy,
          title: `Sparse checkout — ${s.patterns.length} ${s.cone ? 'director' + (s.patterns.length === 1 ? 'y' : 'ies') : 'pattern' + (s.patterns.length === 1 ? '' : 's')}`,
          onClick: () => openSparseDialog(repoId),
        })}
      {openFor === repoId && <SparseDialog repoId={repoId} onClose={close} />}
    </>
  );
}
