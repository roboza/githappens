import type { CommitSummary, LogQuery, RepoId } from '@githappens/git/types';
import { useCallback, useEffect, useRef, useState } from 'react';

import { invoke, IpcError } from '../../lib/api';
import { useSetting } from '../../stores/settings';
import { appendInPlace, streamPages } from './history-stream';

export const FIRST_PAGE = 500;
export const NEXT_PAGE = 2000;
/** Pages fetched back to back (load all / reveal) grow up to this size: fewer round trips and renders. */
export const MAX_STREAM_PAGE = 10_000;

export interface History {
  /**
   * Loaded commits. Within one `generation` the array grows in place as pages arrive (consumers track
   * how many they have seen by length, like `GraphModelCache`); a new generation is a new array.
   */
  commits: CommitSummary[];
  /** Number of loaded commits (changes with every page, unlike the array identity). */
  count: number;
  /** Incremented when history restarts from scratch (refs changed); pages within a load keep it. */
  generation: number;
  loading: boolean;
  done: boolean;
  error: string | null;
  /** `general.lazyLoadCommits`: whether scrolling near the end should call `loadMore`. */
  autoLoad: boolean;
  loadMore(): Promise<void>;
  /** Load pages until `pred()` is true or history ends (used by reveal / jump to HEAD). */
  loadUntil(pred: () => boolean, maxCommits?: number): Promise<boolean>;
}

interface Loaded {
  /** Which request (repo|version|order) this data answers. */
  key: string;
  commits: CommitSummary[];
  count: number;
  generation: number;
  done: boolean;
  error: string | null;
}

/**
 * Streams commit history through `git:log:*` cursors (spec 02 §6.6, spec 04 §4.14).
 * A `version` change (refresh scope `graph`) restarts the stream but keeps the old rows
 * visible until the first new page arrives (spec 04 "Refreshing").
 */
export function useHistory(
  repoId: RepoId,
  version: number | string,
  /**
   * Graph rev-set (hide / solo, spec 04 §6.2) and readiness: while `enabled` is false nothing is
   * requested (the graph waits for refs + persisted visibility so it loads once, not twice).
   */
  opts: { query?: Pick<LogQuery, 'revs' | 'hiddenRefs'>; enabled?: boolean } = {},
): History {
  const revQuery = opts.query ?? { revs: 'all' };
  const revKey = JSON.stringify(revQuery);
  const enabled = opts.enabled !== false;
  const order = useSetting('graph.order') ?? 'topo';
  // spec 13 General › Commit graph: first page size, load everything, lazy loading on scroll
  const initialCount = useSetting('general.initialCommitCount') ?? FIRST_PAGE;
  const showAll = useSetting('general.showAllCommits') ?? false;
  const lazy = useSetting('general.lazyLoadCommits') ?? true;
  const requestKey = `${repoId}|${version}|${order}|${revKey}`;
  const [loaded, setLoaded] = useState<Loaded>({
    key: '',
    commits: [],
    count: 0,
    generation: 0,
    done: false,
    error: null,
  });
  const [loadingMore, setLoadingMore] = useState(false);
  const cursor = useRef<string | null>(null);
  const busy = useRef<Promise<void> | null>(null);
  const live = useRef({ commits: [] as CommitSummary[], done: false });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const query: LogQuery = { ...(JSON.parse(revKey) as Pick<LogQuery, 'revs' | 'hiddenRefs'>), order };
    // On refresh, reload as deep as the user had scrolled so the graph doesn't shrink.
    const pageSize = Math.max(initialCount, Math.min(live.current.commits.length, 50_000));
    const start = invoke('git:log:start', { repoId, query, pageSize }).then(
      (page) => {
        if (cancelled) {
          if (page.cursor) void invoke('git:log:dispose', { repoId, cursor: page.cursor });
          return;
        }
        cursor.current = page.cursor;
        live.current = { commits: page.commits, done: page.done };
        setLoaded((s) => ({
          key: requestKey,
          commits: page.commits,
          count: page.commits.length,
          generation: s.generation + 1,
          done: page.done,
          error: null,
        }));
      },
      (e: unknown) => {
        if (cancelled) return;
        const error = e instanceof IpcError ? e.error.message : String(e);
        setLoaded((s) => ({ ...s, key: requestKey, error }));
      },
    );
    busy.current = start;
    void start.finally(() => {
      if (busy.current === start) busy.current = null;
    });
    return () => {
      cancelled = true;
      const c = cursor.current;
      cursor.current = null;
      if (c) void invoke('git:log:dispose', { repoId, cursor: c });
    };
  }, [repoId, order, requestKey, initialCount, enabled, revKey]);

  /** Loads pages through `streamPages` (one stream at a time; `busy` serializes them). */
  const stream = useCallback(
    async (want: () => number, firstSize: number, maxSize = firstSize): Promise<void> => {
      if (busy.current) await busy.current;
      const c = cursor.current;
      if (!c || live.current.done) return;
      setLoadingMore(true);
      const run = (): Promise<void> =>
        streamPages({
          next: (pageSize) => invoke('git:log:next', { repoId, cursor: c, pageSize }),
          isCurrent: () => cursor.current === c,
          onPage: (page) => {
            cursor.current = page.cursor; // same id while streaming, null at the end
            const commits = live.current.commits;
            appendInPlace(commits, page.commits);
            live.current = { commits, done: page.done };
            setLoaded((s) => ({ ...s, commits, count: commits.length, done: page.done }));
          },
          want,
          firstSize,
          maxSize,
        });
      const p = run()
        .catch((e: unknown) => {
          if (cursor.current !== c) return; // the stream was disposed by a restart
          const error = e instanceof IpcError ? e.error.message : String(e);
          setLoaded((s) => ({ ...s, error }));
        })
        .finally(() => {
          busy.current = null;
          setLoadingMore(false);
        });
      busy.current = p;
      await p;
    },
    [repoId],
  );

  /**
   * Scroll-triggered / "Load more" requests. With lazy loading off, only explicit clicks (user
   * activation) load further pages; reveal / jump still use `loadUntil`.
   */
  const loadMore = useCallback(async (): Promise<void> => {
    if (!lazy && !showAll && !(navigator.userActivation?.isActive ?? true)) return;
    await stream(() => 0, NEXT_PAGE);
  }, [lazy, showAll, stream]);

  const loadUntil = useCallback(
    async (pred: () => boolean, maxCommits = 50_000): Promise<boolean> => {
      if (busy.current) await busy.current;
      const want = (): number => (pred() ? 0 : Math.max(0, maxCommits - live.current.commits.length));
      const first = want();
      if (first > 0) await stream(want, Math.min(NEXT_PAGE, first), MAX_STREAM_PAGE);
      return pred();
    },
    [stream],
  );

  // "Show all commits": stream the rest of the history in the background (pipelined, growing pages).
  const showAllRef = useRef(showAll);
  useEffect(() => {
    showAllRef.current = showAll;
  }, [showAll]);
  useEffect(() => {
    if (!showAll || loaded.key !== requestKey || loaded.done || loaded.error || loadingMore) return;
    const t = setTimeout(
      () => void stream(() => (showAllRef.current ? Number.MAX_SAFE_INTEGER : 0), NEXT_PAGE, MAX_STREAM_PAGE),
      0,
    );
    return () => clearTimeout(t);
  }, [showAll, loaded.key, loaded.done, loaded.error, loadingMore, requestKey, stream]);

  return {
    commits: loaded.commits,
    count: loaded.count,
    generation: loaded.generation,
    done: loaded.done,
    error: loaded.error,
    loading: loaded.key !== requestKey || loadingMore,
    autoLoad: lazy || showAll,
    loadMore,
    loadUntil,
  };
}
