import { isRawPathKey, shownPath } from '@githappens/git/ops';
import type { RepoId } from '@githappens/git/types';
import { useInfiniteQuery } from '@tanstack/react-query';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';

import { Avatar } from '../../components/Avatar';
import { useContextMenu } from '../../components/ContextMenu';
import { confirm } from '../../components/Dialogs';
import { invoke } from '../../lib/api';
import { DateText } from '../../components/DateText';
import { fullDate, shortSha } from '../../lib/format';
import { quiet, runOp } from '../../lib/ops';
import { useRepoUiStore } from '../../stores/repo-ui';
import { useSetting } from '../../stores/settings';
import { WORKTREE_TO } from '../diff/compare';
import { filesInvoke, type FileHistoryEntry } from './files-api';
import styles from './FileView.module.css';

const DiffView = lazy(() => import('../diff/DiffView'));

const PAGE = 200;

/** Client-side author / message filter (spec 07 §4.9). */
export function filterHistory(entries: FileHistoryEntry[], q: string): FileHistoryEntry[] {
  const t = q.trim().toLowerCase();
  if (!t) return entries;
  return entries.filter(
    (e) =>
      e.subject.toLowerCase().includes(t) ||
      e.authorName.toLowerCase().includes(t) ||
      e.authorEmail.toLowerCase().includes(t) ||
      e.sha.startsWith(t),
  );
}

/**
 * File history (spec 07 §4.9): commits touching the path (following renames by default), 200 per page,
 * rename markers, author/message filter, per-entry actions, and the selected entry's diff on the right.
 */
export function FileHistory({ repoId, path }: { repoId: RepoId; path: string }) {
  // `path` may be a raw key (name not valid UTF-8, spec 02 §8): entries show the decoded name, diffs of
  // that name use the key
  const shown = shownPath(path);
  const keyFor = (p: string): string => (isRawPathKey(path) && p === shown ? path : p);
  const dateFormat = useSetting('ui.dateFormat');
  const [follow, setFollow] = useState(true);
  const [filter, setFilter] = useState('');
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const showMenu = useContextMenu((s) => s.show);
  const listRef = useRef<HTMLUListElement>(null);

  const history = useInfiniteQuery({
    queryKey: ['fileHistory', repoId, path, follow],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      filesInvoke('history:file', { repoId, path, follow, skip: pageParam, limit: PAGE }),
    getNextPageParam: (last, pages) => (last.hasMore ? pages.length * PAGE : undefined),
  });
  const all = useMemo(() => history.data?.pages.flatMap((p) => p.entries) ?? [], [history.data]);
  const entries = useMemo(() => filterHistory(all, filter), [all, filter]);
  const current = entries.find((e) => e.sha === selectedSha) ?? entries[0] ?? null;

  // lazy loading: fetch the next page when the list is scrolled near the bottom
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = history;
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const onScroll = (): void => {
      if (hasNextPage && !isFetchingNextPage && el.scrollTop + el.clientHeight > el.scrollHeight - 200) {
        void fetchNextPage();
      }
    };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const openAt = (e: FileHistoryEntry): void =>
    useRepoUiStore
      .getState()
      .update(repoId, () => ({ center: { kind: 'file', path: e.path, mode: 'edit', rev: e.sha } }));
  const compareWithWorking = (e: FileHistoryEntry): void =>
    useRepoUiStore.getState().update(repoId, () => ({
      center: {
        kind: 'diff',
        spec: {
          kind: 'range',
          from: e.sha,
          to: WORKTREE_TO,
          paths: e.path === shown ? [path] : [keyFor(e.path), path],
        },
        path: shown,
        ...(e.path !== shown ? { oldPath: e.path } : {}),
        title: `${shortSha(e.sha)} ↔ Working directory · ${shown}`,
        oldRev: e.sha,
        newRev: 'WORKTREE',
      },
    }));
  const checkoutAt = async (e: FileHistoryEntry): Promise<void> => {
    if (e.status === 'D') return;
    const ok = await confirm(
      'Checkout file at this revision?',
      `${e.path} in the working tree and index is replaced with its content at ${shortSha(e.sha)}. You can undo this.`,
      'Checkout file',
    );
    if (ok)
      quiet(
        runOp(
          repoId,
          { type: 'file.checkoutAt', rev: e.sha, path: e.path },
          { successToast: `Checked out ${e.path} at ${shortSha(e.sha)}` },
        ),
      );
  };
  const menu = (e: FileHistoryEntry, x: number, y: number): void =>
    showMenu(x, y, [
      { label: 'Select in graph', onSelect: () => useRepoUiStore.getState().reveal(repoId, e.sha) },
      {
        label: 'Checkout file at this revision…',
        disabled: e.status === 'D',
        onSelect: () => void checkoutAt(e),
      },
      { label: 'Open file at this revision', disabled: e.status === 'D', onSelect: () => openAt(e) },
      { label: 'Compare with working copy', onSelect: () => compareWithWorking(e) },
      'separator',
      { label: 'Copy SHA', onSelect: () => void invoke('shell:copyText', { text: e.sha }) },
    ]);

  return (
    <div className={styles.split}>
      <div className={styles.historyPane}>
        <div className={styles.historyBar}>
          <input
            type="search"
            placeholder="Filter by author or message"
            aria-label="Filter history"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <label className={styles.check} title="git log --follow">
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow
            renames
          </label>
        </div>
        {history.isLoading && <p className={styles.message}>Loading history…</p>}
        {history.error && (
          <p className={styles.message}>Could not load history: {(history.error as Error).message}</p>
        )}
        {!history.isLoading && !history.error && entries.length === 0 && (
          <p className={styles.message}>{filter ? 'No matching commits.' : 'No commits touch this file.'}</p>
        )}
        <ul ref={listRef} className={styles.commitList} role="listbox" aria-label="File history">
          {entries.map((e) => (
            <li
              key={e.sha}
              role="option"
              tabIndex={-1}
              aria-selected={current?.sha === e.sha}
              className={current?.sha === e.sha ? styles.active : undefined}
              onClick={() => setSelectedSha(e.sha)}
              onContextMenu={(ev) => {
                ev.preventDefault();
                menu(e, ev.clientX, ev.clientY);
              }}
            >
              <Avatar name={e.authorName} email={e.authorEmail} size={22} />
              <div className={styles.commitMeta}>
                <span className={styles.subject}>{e.subject}</span>
                <span className={styles.byline} title={fullDate(e.authorTime)}>
                  {e.authorName} · <DateText unixSeconds={e.authorTime} format={dateFormat} /> ·{' '}
                  <code>{shortSha(e.sha)}</code>
                </span>
                {e.oldPath && e.oldPath !== e.path && (
                  <span className={styles.renameMarker}>
                    {e.status === 'C' ? 'copied' : 'renamed'} from <code>{e.oldPath}</code>
                  </span>
                )}
                {e.status === 'A' && !e.oldPath && <span className={styles.renameMarker}>added</span>}
                {e.status === 'D' && <span className={styles.renameMarker}>deleted</span>}
              </div>
              <button
                type="button"
                className={styles.rowMenu}
                aria-label="Actions"
                title="Actions"
                onClick={(ev) => {
                  ev.stopPropagation();
                  const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
                  menu(e, r.left, r.bottom);
                }}
              >
                ⋯
              </button>
            </li>
          ))}
          {history.hasNextPage && (
            <li>
              <button
                type="button"
                disabled={history.isFetchingNextPage}
                onClick={() => void history.fetchNextPage()}
              >
                {history.isFetchingNextPage ? 'Loading…' : 'Load more'}
              </button>
            </li>
          )}
        </ul>
      </div>
      <div className={styles.diffPane}>
        {current && (
          <Suspense fallback={<p className={styles.message}>Loading diff…</p>}>
            <DiffView
              key={current.sha}
              repoId={repoId}
              embedded
              view={{
                kind: 'diff',
                spec: {
                  kind: 'commit',
                  sha: current.sha,
                  paths:
                    current.oldPath && current.oldPath !== current.path
                      ? [keyFor(current.oldPath), keyFor(current.path)]
                      : [keyFor(current.path)],
                },
                path: current.path,
                ...(current.oldPath ? { oldPath: current.oldPath } : {}),
                title: `${shortSha(current.sha)} · ${current.path}`,
                oldRev: current.status === 'A' ? '' : (current.parents[0] ?? ''),
                newRev: current.status === 'D' ? '' : current.sha,
              }}
            />
          </Suspense>
        )}
      </div>
    </div>
  );
}
