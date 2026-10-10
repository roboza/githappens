import { shownPath } from '@githappens/git/ops';
import type { RepoId } from '@githappens/git/types';
import { History, Pencil, ScanLine, X } from 'lucide-react';

import { useRepoUiStore, type CenterView } from '../../stores/repo-ui';
import { BlameView } from './BlameView';
import { confirmLeaveEditor, FileEditor } from './FileEditor';
import { FileHistory } from './FileHistory';
import styles from './FileView.module.css';

type FileCenter = Extract<CenterView, { kind: 'file' }>;

/** File history, blame and the in-app editor for one path (spec 07 §4.9–4.11). */
export default function FileView({ repoId, view }: { repoId: RepoId; view: FileCenter }) {
  const update = useRepoUiStore((s) => s.update);
  /** Leaving the editor with unsaved edits asks Save / Discard / Cancel first. */
  const leave = async (next: CenterView): Promise<void> => {
    if (view.mode === 'edit' && view.rev === undefined && !(await confirmLeaveEditor(repoId, view.path)))
      return;
    update(repoId, () => ({ center: next }));
  };
  const setMode = (mode: FileCenter['mode']): void => {
    // history/blame of the same revision; the editor opens the working copy unless a revision is viewed
    void leave({ ...view, mode, ...(mode === 'edit' && view.mode !== 'edit' ? { rev: undefined } : {}) });
  };

  return (
    <div className={styles.view}>
      <div className={styles.toolbar}>
        <span className={styles.path} title={shownPath(view.path)}>
          {view.mode === 'history' ? 'History: ' : view.mode === 'blame' ? 'Blame: ' : ''}
          {shownPath(view.path)}
        </span>
        <div className={styles.segmented} role="tablist" aria-label="File view">
          {(
            [
              ['history', 'History', History],
              ['blame', 'Blame', ScanLine],
              ['edit', 'Edit', Pencil],
            ] as const
          ).map(([mode, label, Icon]) => (
            <button
              key={mode}
              type="button"
              role="tab"
              aria-selected={view.mode === mode}
              onClick={() => setMode(mode)}
            >
              <Icon size={13} /> {label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={styles.iconBtn}
          aria-label="Close file view"
          title={view.mode === 'edit' ? 'Close' : 'Close (Esc)'}
          onClick={() => void leave({ kind: 'graph' })}
        >
          <X size={16} />
        </button>
      </div>
      <div className={styles.body}>
        {view.mode === 'history' && <FileHistory repoId={repoId} path={view.path} />}
        {view.mode === 'blame' && (
          <BlameView key={view.rev ?? ''} repoId={repoId} path={view.path} rev={view.rev} />
        )}
        {view.mode === 'edit' && (
          <FileEditor key={view.rev ?? ''} repoId={repoId} path={view.path} rev={view.rev} />
        )}
      </div>
    </div>
  );
}
