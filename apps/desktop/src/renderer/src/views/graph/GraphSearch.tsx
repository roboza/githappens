import type { GraphModel } from '@githappens/graph';
import type { CommitSummary, RepoId, SearchProgress, Sha } from '@githappens/git/types';
import { ChevronDown, ChevronUp, Crosshair, Filter, Highlighter, Search, Square, X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { invoke, IpcError } from '../../lib/api';
import { useRepoUi, useRepoUiStore } from '../../stores/repo-ui';
import { useSettingsStore } from '../../stores/settings';
import styles from './GraphView.module.css';
import { filteredGraphModel } from './search-filter';
import { matchesCommit, parseQuery, toSearchQuery, type ParsedQuery } from './search-query';

export { matchesCommit, parseQuery, type ParsedQuery } from './search-query';

/** Poll interval of `graph:search:progress` while a deep search runs (partial results, spec 12 §8). */
const PROGRESS_POLL_MS = 250;

export interface SearchMatches {
  query: ParsedQuery;
  /**
   * The model the graph renders: the full model, or in filter mode the matching rows only (spec 12
   * §4.7). `rows` / `hits[].row` / `activeRow` index this model.
   */
  model: GraphModel<CommitSummary>;
  /** Loaded rows that match. */
  rows: Set<number>;
  /** Ordered hit list (row numbers; -1 for deep hits not loaded yet). */
  hits: { sha: Sha; row: number }[];
  activeRow: number;
  activeIndex: number;
  dimmed: boolean;
  deepPending: boolean;
  deepError: string | null;
  /** Progress of the running / last deep search. */
  progress: Omit<SearchProgress, 'shas'> | null;
  runDeep(): void;
  cancelDeep(): void;
  step(dir: 1 | -1): void;
}

function newSearchId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function useSearchMatches(repoId: RepoId, full: GraphModel<CommitSummary>): SearchMatches {
  const search = useRepoUi(repoId, (u) => u.search);
  const update = useRepoUiStore((s) => s.update);
  const me = useSettingsStore((s) => s.profile?.authorEmail ?? null);
  const query = useMemo(() => parseQuery(search.text, { me }), [search.text, me]);
  const [deepPending, setDeepPending] = useState(false);
  const [deepError, setDeepError] = useState<string | null>(null);
  const [progress, setProgress] = useState<SearchMatches['progress']>(null);
  /** Query text the progress belongs to. */
  const [progressFor, setProgressFor] = useState('');
  const running = useRef<string | null>(null);

  // loaded matches (full-model rows) or the deep hits
  const shas = useMemo((): Sha[] => {
    if (!query.terms.length || query.error) return [];
    if (search.deepHits) return search.deepHits;
    if (query.deep) return [];
    const out: Sha[] = [];
    for (let row = 0; row < full.rowCount; row++) {
      const c = full.commitAt(row);
      if (c && matchesCommit(c, query)) out.push(c.sha);
    }
    return out;
    // full.version captures appended pages
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, search.deepHits, full, full.version]);

  // Filter mode hides non-matching rows: re-layout of the loaded matches with collapsed edges.
  const filtering = search.mode === 'filter' && !!query.terms.length && !query.error;
  const model = useMemo(() => {
    if (!filtering) return full;
    const set = new Set(shas);
    if (!shas.some((s) => full.rowOf(s) >= 0)) return full; // nothing loaded matches: keep (dimmed) rows
    return filteredGraphModel(full, (s) => set.has(s));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtering, shas, full, full.version]);

  const hits = useMemo(() => shas.map((sha) => ({ sha, row: model.rowOf(sha) })), [shas, model]);
  const rows = useMemo(() => new Set(hits.map((h) => h.row).filter((r) => r >= 0)), [hits]);
  const activeIndex = Math.min(search.activeIndex, Math.max(0, hits.length - 1));
  const active = hits[activeIndex];

  const cancelDeep = useCallback((): void => {
    const id = running.current;
    if (id) void invoke('graph:search:cancel', { searchId: id }).catch(() => undefined);
  }, []);
  // a new query (or leaving the graph) cancels the running deep search
  useEffect(() => cancelDeep, [search.text, cancelDeep]);

  const runDeep = (): void => {
    if (!query.terms.length || query.error || deepPending) return;
    const searchId = newSearchId();
    running.current = searchId;
    setDeepPending(true);
    setDeepError(null);
    setProgress(null);
    setProgressFor(search.text);
    const own = (): boolean => running.current === searchId;
    const showPartial = (p: SearchProgress | null): void => {
      if (!p || !own()) return;
      const { shas: partial, ...rest } = p;
      setProgress(rest);
      update(repoId, (u) => ({ search: { ...u.search, deepHits: partial } }));
    };
    const poll = setInterval(() => {
      invoke('graph:search:progress', { searchId })
        .then(showPartial)
        .catch(() => undefined);
    }, PROGRESS_POLL_MS);
    invoke('graph:search', { repoId, query: toSearchQuery(query, { searchId }) })
      .then(async ({ shas: all }) => {
        if (!own()) return;
        const p = await invoke('graph:search:progress', { searchId }).catch(() => null);
        if (p) {
          const { shas: _ignored, ...rest } = p;
          void _ignored;
          setProgress(rest);
        }
        update(repoId, (u) => ({ search: { ...u.search, deepHits: all, activeIndex: 0 } }));
      })
      .catch(async (e: unknown) => {
        if (!own()) return;
        if (e instanceof IpcError && e.code === 'Cancelled') {
          // keep what was found before the cancel (partial results)
          showPartial(await invoke('graph:search:progress', { searchId }).catch(() => null));
          setProgress((p) => (p ? { ...p, done: true, cancelled: true } : p));
          return;
        }
        setDeepError(e instanceof IpcError ? e.error.message : String(e));
      })
      .finally(() => {
        clearInterval(poll);
        if (own()) {
          running.current = null;
          setDeepPending(false);
        }
      });
  };

  const step = (dir: 1 | -1): void => {
    if (hits.length === 0) return;
    const next = (activeIndex + dir + hits.length) % hits.length;
    update(repoId, (u) => ({ search: { ...u.search, activeIndex: next } }));
    const h = hits[next]!;
    // Hits outside the loaded window are loaded via reveal (spec 04 graph:revealCommit).
    useRepoUiStore.getState().reveal(repoId, h.sha);
  };

  // Stable identity across unrelated re-renders (e.g. every scroll frame of the graph), so memoized
  // consumers (search strip, canvas draw callback) only update when the search itself changes.
  const latest = useRef({ runDeep, step });
  useLayoutEffect(() => {
    latest.current = { runDeep, step };
  });
  const stableRunDeep = useCallback(() => latest.current.runDeep(), []);
  const stableStep = useCallback((dir: 1 | -1) => latest.current.step(dir), []);
  const activeRow = active && active.row >= 0 ? active.row : -1;
  const dimmed = !!query.terms.length;
  const shownError = query.error ?? deepError;
  const shownProgress = progressFor === search.text ? progress : null;
  return useMemo(
    () => ({
      query,
      model,
      rows,
      hits,
      activeRow,
      activeIndex,
      dimmed,
      deepPending,
      deepError: shownError,
      progress: shownProgress,
      runDeep: stableRunDeep,
      cancelDeep,
      step: stableStep,
    }),
    [
      query,
      model,
      rows,
      hits,
      activeRow,
      activeIndex,
      dimmed,
      deepPending,
      shownError,
      shownProgress,
      stableRunDeep,
      cancelDeep,
      stableStep,
    ],
  );
}

/** Search strip above the graph (spec 04 §4.1 GraphToolbarStrip). */
export function GraphSearchBar(props: {
  repoId: RepoId;
  search: SearchMatches;
  onJumpToHead(): void;
  /** Filter chips (hide / solo, spec 04 §4.1 `GraphFilterChips`). */
  extra?: ReactNode;
}) {
  const { repoId, search } = props;
  const state = useRepoUi(repoId, (u) => u.search);
  const update = useRepoUiStore((s) => s.update);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const focus = (): void => {
      input.current?.focus();
      input.current?.select();
    };
    window.addEventListener('kl:focus-graph-search', focus);
    return () => window.removeEventListener('kl:focus-graph-search', focus);
  }, []);

  const setText = (text: string): void =>
    update(repoId, (u) => ({ search: { ...u.search, text, deepHits: null, activeIndex: 0 } }));

  return (
    <div className={styles.searchBar}>
      <div className={styles.searchBox}>
        <Search size={14} aria-hidden />
        <input
          ref={input}
          type="text"
          value={state.text}
          placeholder='Search commits — text, "phrase", /regex/, @author, #sha, file:path, ~content, =regex'
          aria-label="Search commits"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (search.query.deep && !state.deepHits) search.runDeep();
              else search.step(e.shiftKey ? -1 : 1);
            } else if (e.key === 'Escape') {
              setText('');
              input.current?.blur();
            }
          }}
        />
        {state.text && (
          <button
            type="button"
            className={styles.iconBtn}
            aria-label="Clear search"
            onClick={() => setText('')}
          >
            <X size={13} />
          </button>
        )}
      </div>
      {state.text && (
        <>
          <span className={styles.searchCount} aria-live="polite">
            {search.deepPending
              ? searchingLabel(search)
              : search.query.deep && !state.deepHits
                ? 'Press Enter to search history'
                : search.hits.length
                  ? `${search.activeIndex + 1} / ${search.hits.length}${search.progress?.cancelled ? ' (cancelled — partial)' : ''}`
                  : 'No results'}
          </span>
          <button
            type="button"
            className={styles.iconBtn}
            aria-label="Previous result"
            onClick={() => search.step(-1)}
          >
            <ChevronUp size={14} />
          </button>
          <button
            type="button"
            className={styles.iconBtn}
            aria-label="Next result"
            onClick={() => search.step(1)}
          >
            <ChevronDown size={14} />
          </button>
          {search.deepPending && (
            <button
              type="button"
              className={styles.iconBtn}
              aria-label="Cancel search"
              title="Cancel search"
              onClick={search.cancelDeep}
            >
              <Square size={12} />
            </button>
          )}
          {!search.query.deep && !state.deepHits && !search.deepPending && (
            <button
              type="button"
              className={styles.linkBtn}
              onClick={search.runDeep}
              disabled={search.deepPending}
            >
              Search entire history
            </button>
          )}
          <button
            type="button"
            className={styles.iconBtn}
            aria-pressed={state.mode === 'filter'}
            title={state.mode === 'filter' ? 'Filter mode: only matching commits shown' : 'Highlight mode'}
            onClick={() =>
              update(repoId, (u) => ({
                search: { ...u.search, mode: u.search.mode === 'filter' ? 'highlight' : 'filter' },
              }))
            }
          >
            {state.mode === 'filter' ? <Filter size={14} /> : <Highlighter size={14} />}
          </button>
          {search.deepError && <span className={styles.searchError}>{search.deepError}</span>}
        </>
      )}
      {props.extra}
      <button
        type="button"
        className={styles.iconBtn}
        title="Jump to HEAD"
        aria-label="Jump to HEAD"
        onClick={props.onJumpToHead}
      >
        <Crosshair size={14} />
      </button>
    </div>
  );
}

function searchingLabel(search: SearchMatches): string {
  const p = search.progress;
  if (!p) return 'Searching…';
  const parts = [`${p.total} found`];
  if (p.scanned !== null) parts.push(`${p.scanned.toLocaleString()} commits scanned`);
  if (p.reachedTime) parts.push(`back to ${new Date(p.reachedTime * 1000).toLocaleDateString()}`);
  return `Searching… ${parts.join(', ')}`;
}
