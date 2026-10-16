import type { BranchCleanupScan, RepoId } from '@githappens/git/types';
import { useEffect, useMemo, useRef, useState } from 'react';

import { undo } from '../../actions/git-actions';
import { invoke, IpcError } from '../../lib/api';
import { formatDate } from '../../lib/format';
import { runOp } from '../../lib/ops';
import {
  cleanupOp,
  defaultSelection,
  groupCandidates,
  REASON_LABEL,
  unmergedSelected,
  type CleanupGroup,
} from './branch-cleanup-model';
import styles from './BranchCleanup.module.css';
import { FormDialog, formStyles as s } from './FormDialog';

type Phase = 'fetching' | 'scanning' | 'ready';

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * "Clean up branches…" (spec 05 §6.13): fetch with prune, scan, then review merged and remote-deleted
 * local branches. Merged ones start checked; the delete is one undoable `branch.delete`.
 */
export function BranchCleanupDialog({ repoId, onClose }: { repoId: RepoId; onClose(): void }) {
  const [phase, setPhase] = useState<Phase>('fetching');
  const [scan, setScan] = useState<BranchCleanupScan | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      const remotes = await invoke('git:remotes', { repoId }).catch(() => []);
      if (remotes.length) {
        try {
          // Stale detection is only as good as the remote-tracking refs.
          await invoke('git:op:run', { repoId, op: { type: 'fetch', remote: 'all', prune: true } });
        } catch (e) {
          if (live) setFetchError(e instanceof IpcError ? e.message : String(e));
        }
      }
      if (!live) return;
      setPhase('scanning');
      try {
        const r = await invoke('git:branch:cleanupScan', { repoId });
        if (!live) return;
        setScan(r);
        setSelected(defaultSelection(groupCandidates(r.candidates, r.base ?? '')));
      } catch (e) {
        if (live) setError(e instanceof IpcError ? e.message : String(e));
      }
      if (live) setPhase('ready');
    })();
    return () => {
      live = false;
    };
  }, [repoId]);

  const groups = useMemo(() => (scan ? groupCandidates(scan.candidates, scan.base ?? '') : []), [scan]);
  const candidates = scan?.candidates ?? [];
  const risky = unmergedSelected(candidates, selected);
  const count = selected.size;

  const toggle = (names: string[], on: boolean): void =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const n of names) {
        if (on) next.add(n);
        else next.delete(n);
      }
      return next;
    });

  const submit = async (): Promise<void> => {
    if (!count) return onClose();
    setBusy(true);
    try {
      await runOp(repoId, cleanupOp(candidates, selected), {
        successToast: (r) => r.summary ?? `Deleted ${plural(count, 'branch', 'branches')}`,
        successActions: [{ label: 'Undo', run: () => undo(repoId) }],
      });
      onClose();
    } catch {
      setBusy(false);
    }
  };

  const empty = phase === 'ready' && !error && !candidates.length;
  return (
    <FormDialog
      title="Clean up branches"
      wide
      okLabel={
        phase !== 'ready' || empty || error
          ? 'Close'
          : count
            ? `Delete ${plural(count, 'branch', 'branches')}`
            : 'Delete'
      }
      danger={risky.length > 0}
      busy={busy || phase !== 'ready'}
      okDisabled={phase === 'ready' && !empty && !error && !count}
      onCancel={onClose}
      onSubmit={() => (empty || error ? onClose() : void submit())}
      error={error}
    >
      {phase !== 'ready' && (
        <p className={s.muted} role="status">
          {phase === 'fetching' ? 'Fetching from remotes…' : 'Looking for merged and stale branches…'}
        </p>
      )}
      {phase === 'ready' && scan && (
        <>
          <p className={s.muted}>
            {scan.base ? (
              <>
                Compared against <span className={s.mono}>{scan.base}</span>. Only local branches are deleted,
                and you can undo it.
              </>
            ) : (
              'No default branch found (origin/HEAD, main or master), so nothing can be compared.'
            )}
          </p>
          {fetchError && (
            <p className={styles.warn}>Couldn’t fetch ({fetchError}). Results use the last fetched state.</p>
          )}
          {empty && scan.base && <p className={s.empty}>No branches to clean up.</p>}
          {groups.length > 0 && (
            <div className={styles.groups}>
              {groups.map((g) => (
                <Group key={g.id} group={g} selected={selected} onToggle={toggle} />
              ))}
            </div>
          )}
          {scan.protectedBranches.length > 0 && (
            <p className={s.hint}>
              Never deleted: {scan.protectedBranches.join(', ')} (current, default or in a worktree).
            </p>
          )}
          {risky.length > 0 && (
            <p className={styles.warn} role="alert">
              {plural(risky.length, 'selected branch has', 'selected branches have')} commits that are not in{' '}
              {scan.base}.
            </p>
          )}
        </>
      )}
    </FormDialog>
  );
}

function Group({
  group,
  selected,
  onToggle,
}: {
  group: CleanupGroup;
  selected: ReadonlySet<string>;
  onToggle(names: string[], on: boolean): void;
}) {
  const names = group.items.map((c) => c.name);
  const n = names.filter((x) => selected.has(x)).length;
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (box.current) box.current.indeterminate = n > 0 && n < names.length;
  }, [n, names.length]);
  return (
    <section className={styles.group} aria-label={group.title}>
      <label className={styles.groupHead}>
        <input
          ref={box}
          type="checkbox"
          checked={n === names.length}
          onChange={(e) => onToggle(names, e.target.checked)}
        />
        <strong>
          {group.title} ({names.length})
        </strong>
        <span className={s.muted}>{group.hint}</span>
      </label>
      <ul className={styles.items}>
        {group.items.map((c) => (
          <li key={c.name}>
            <label className={styles.item} title={c.subject}>
              <input
                type="checkbox"
                checked={selected.has(c.name)}
                onChange={(e) => onToggle([c.name], e.target.checked)}
              />
              <span className={`${s.mono} ${s.grow}`}>{c.name}</span>
              <span className={styles.badge} data-reason={c.reason}>
                {REASON_LABEL[c.reason]}
              </span>
              {c.reason === 'upstream-gone' && c.aheadOfBase > 0 && (
                <span className={styles.ahead}>{plural(c.aheadOfBase, 'commit', 'commits')} not merged</span>
              )}
              <span className={s.muted}>
                {formatDate(c.committerDate)} · {c.authorName}
              </span>
            </label>
          </li>
        ))}
      </ul>
    </section>
  );
}
