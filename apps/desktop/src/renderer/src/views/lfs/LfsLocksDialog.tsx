import type { RepoId } from '@githappens/git/types';
import { useQueryClient } from '@tanstack/react-query';
import { Lock } from 'lucide-react';
import { useState } from 'react';

import type { LfsLockInfo } from '../../../../shared/ipc/remotes-contract';
import { confirm } from '../../components/Dialogs';
import { runOp } from '../../lib/ops';
import { Field, FormDialog, formStyles as s } from '../remotes/FormDialog';
import styles from './lfs.module.css';
import { lfsLocksKey, useLfsLocks } from './queries';

/** LFS Locks (spec 09 §6.8 "Locks", extension): list `git lfs locks`, lock a path, unlock / force unlock. */
export function LfsLocksDialog({ repoId, onClose }: { repoId: RepoId; onClose(): void }) {
  const locks = useLfsLocks(repoId);
  const qc = useQueryClient();
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = (): void => void qc.invalidateQueries({ queryKey: lfsLocksKey(repoId) });

  const lock = async (): Promise<void> => {
    const p = path.trim().replace(/\\/g, '/');
    if (!p) return;
    setBusy(true);
    try {
      await runOp(repoId, { type: 'lfs.lock', path: p }, { successToast: `Locked ${p}` });
      setPath('');
      refresh();
    } catch {
      /* toast shown */
    } finally {
      setBusy(false);
    }
  };

  const unlock = async (l: LfsLockInfo): Promise<void> => {
    const force = l.ours === false;
    if (
      force &&
      !(await confirm(
        `Force unlock ${l.path}?`,
        `This lock belongs to ${l.owner || 'someone else'}. Breaking it may cause them to lose work.`,
        'Force unlock',
        true,
      ))
    )
      return;
    setBusy(true);
    try {
      await runOp(
        repoId,
        { type: 'lfs.unlock', path: l.path, ...(force ? { force: true } : {}) },
        { successToast: `Unlocked ${l.path}` },
      );
      refresh();
    } catch {
      /* toast shown */
    } finally {
      setBusy(false);
    }
  };

  const data = locks.data;
  return (
    <FormDialog
      title="Git LFS locks"
      okLabel="Lock file"
      onCancel={onClose}
      onSubmit={() => void lock()}
      busy={busy}
      okDisabled={!path.trim() || data?.supported === false}
      wide
      footer={
        <button type="button" onClick={refresh} disabled={locks.isFetching}>
          {locks.isFetching ? 'Refreshing…' : 'Refresh'}
        </button>
      }
    >
      <div className={s.list} role="list" aria-label="Locked files">
        {locks.isLoading && <div className={s.empty}>Loading locks from the LFS server…</div>}
        {locks.error && <div className={s.empty}>Could not list locks.</div>}
        {data && !data.supported && (
          <div className={s.empty}>{data.error ?? 'Locking is not available.'}</div>
        )}
        {data?.supported && data.error && <div className={s.empty}>{data.error}</div>}
        {data?.supported && !data.error && !data.locks.length && (
          <div className={s.empty}>No files are locked.</div>
        )}
        {data?.locks.map((l) => (
          <div key={l.id || l.path} className={styles.lockRow} role="listitem">
            <Lock
              size={13}
              className={l.ours ? styles.ours : l.ours === false ? styles.theirs : undefined}
              aria-hidden
            />
            <span className={`${s.grow} ${s.mono}`} title={l.path}>
              {l.path}
            </span>
            <span className={s.muted}>
              {l.ours ? 'you' : l.owner || 'unknown'}
              {l.lockedAt ? ` · ${new Date(l.lockedAt).toLocaleString()}` : ''}
            </span>
            <button type="button" disabled={busy} onClick={() => void unlock(l)}>
              {l.ours === false ? 'Force unlock…' : 'Unlock'}
            </button>
          </div>
        ))}
      </div>
      {data?.supported !== false && (
        <Field label="Lock a file" hint="Repository-relative path, e.g. art/hero.psd">
          <input type="text" value={path} spellCheck={false} onChange={(e) => setPath(e.target.value)} />
        </Field>
      )}
    </FormDialog>
  );
}
