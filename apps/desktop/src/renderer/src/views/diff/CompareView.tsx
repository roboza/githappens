import type { DiffSpec, RepoId } from '@githappens/git/types';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeftRight, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { invoke } from '../../lib/api';
import { qk } from '../../repo/queries';
import { useRepoUiStore, type CenterView } from '../../stores/repo-ui';
import { FileList, type FileEntry } from '../right/FileList';
import { WORKTREE_TO } from './compare';
import { FileDiffView } from './DiffView';
import { useDiffNavStore } from './nav-store';
import styles from './DiffView.module.css';

type DiffCenter = Extract<CenterView, { kind: 'diff' }>;

const label = (rev: string): string =>
  rev === WORKTREE_TO ? 'Working directory' : /^[0-9a-f]{40,64}$/i.test(rev) ? rev.slice(0, 7) : rev;

/**
 * Comparison of two refs / commits (spec 07 §4.8): file list + diff, swap, two-dot vs three-dot (default
 * three-dot: what B has that A doesn't). Unrelated histories fall back to two-dot with a notice.
 */
export function CompareView({ repoId, view }: { repoId: RepoId; view: DiffCenter }) {
  const base = view.spec.kind === 'range' ? view.spec : null;
  const [swapped, setSwapped] = useState(false);
  const [threeDot, setThreeDot] = useState(!!base?.threeDot);
  const [selected, setSelected] = useState<string | null>(null);
  const worktree = base?.to === WORKTREE_TO;
  const from = base ? (swapped && !worktree ? base.to : base.from) : '';
  const to = base ? (swapped && !worktree ? base.from : base.to) : '';
  const spec: DiffSpec = { kind: 'range', from, to, threeDot: threeDot && !worktree };
  const files = useQuery({
    queryKey: qk.numstat(repoId, JSON.stringify(spec)),
    queryFn: async () => {
      try {
        return { files: await invoke('git:diff:numstat', { repoId, spec }), fallback: false };
      } catch (e) {
        // unrelated histories: no merge base for `A...B`
        if (spec.threeDot) {
          return {
            files: await invoke('git:diff:numstat', { repoId, spec: { ...spec, threeDot: false } }),
            fallback: true,
          };
        }
        throw e;
      }
    },
    enabled: !!base,
  });
  const list: FileEntry[] = useMemo(() => files.data?.files.map((f) => ({ ...f })) ?? [], [files.data]);
  const current = list.find((f) => f.path === selected) ?? list[0];

  // next/previous file navigation from the diff (Ctrl+↓/↑, past the last change)
  useEffect(
    () => useDiffNavStore.getState().register(repoId, { paths: list.map((f) => f.path), open: setSelected }),
    [repoId, list],
  );

  if (!base) return <p className={styles.message}>Nothing to compare.</p>;
  const close = (): void => useRepoUiStore.getState().update(repoId, () => ({ center: { kind: 'graph' } }));
  const effectiveThreeDot = spec.threeDot && !files.data?.fallback;

  return (
    <div className={styles.view}>
      <div className={styles.toolbar}>
        <span className={styles.compareTitle}>
          Comparing <code>{label(from)}</code> ↔ <code>{label(to)}</code>
          {files.data && ` · ${list.length} file${list.length === 1 ? '' : 's'}`}
        </span>
        {!worktree && (
          <>
            <button
              type="button"
              className={styles.iconBtn}
              title="Swap sides"
              aria-label="Swap sides"
              onClick={() => setSwapped((s) => !s)}
            >
              <ArrowLeftRight size={14} />
            </button>
            <div className={styles.segmented} role="group" aria-label="Comparison mode">
              <button
                type="button"
                aria-pressed={!threeDot}
                title={`${label(from)}..${label(to)}: the difference between the two tips`}
                onClick={() => setThreeDot(false)}
              >
                Two-dot
              </button>
              <button
                type="button"
                aria-pressed={threeDot}
                title={`${label(from)}...${label(to)}: what ${label(to)} has since the merge base`}
                onClick={() => setThreeDot(true)}
              >
                Three-dot
              </button>
            </div>
          </>
        )}
        <button
          type="button"
          className={styles.close}
          aria-label="Close comparison"
          title="Close (Esc)"
          onClick={close}
        >
          <X size={16} />
        </button>
      </div>
      {files.data?.fallback && (
        <div className={`${styles.banner} ${styles.bannerWarn}`} role="status">
          These histories have no merge base; showing a two-dot comparison.
        </div>
      )}
      <div className={styles.compareBody}>
        <div className={styles.compareList}>
          {files.isLoading && <p className={styles.message}>Loading files…</p>}
          {files.error && (
            <p className={styles.message}>Could not compare: {(files.error as Error).message}</p>
          )}
          {files.data && list.length === 0 && <p className={styles.message}>No differences.</p>}
          {list.length > 0 && (
            <FileList
              viewKey="compare"
              files={list}
              activePath={current?.path}
              onOpen={(f) => setSelected(f.path)}
            />
          )}
        </div>
        <div className={styles.compareDiff}>
          {current && (
            <FileDiffView
              key={`${current.path}\0${JSON.stringify(spec)}\0${effectiveThreeDot}`}
              repoId={repoId}
              embedded
              view={{
                kind: 'diff',
                spec: {
                  kind: 'range',
                  from,
                  to,
                  threeDot: effectiveThreeDot,
                  paths: current.oldPath ? [current.oldPath, current.path] : [current.path],
                },
                path: current.path,
                ...(current.oldPath ? { oldPath: current.oldPath } : {}),
                title: `${label(from)} ↔ ${label(to)} · ${current.path}`,
                oldRev: from,
                newRev: worktree ? 'WORKTREE' : to,
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
