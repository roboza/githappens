import {
  createMetrics,
  createScrollMapping,
  drawGraph,
  effectiveHidden,
  ghostCandidates,
  graphColumnWidth,
  graphRevQuery,
  groupRefPills,
  hiddenStashShas,
  hitTestNode,
  laneX,
  pinnedTipShas,
  pruneVisibility,
  stashKey,
  virtualTopForRow,
  visibleTipKey,
  visibleTips,
  WIP_SHA,
  type GhostCandidate,
  type GraphModel,
  type RefPill,
  type RefVisibilityState,
} from '@githappens/graph';
import type {
  CommitSummary,
  RefInfo,
  RepoId,
  RepoInfo,
  Sha,
  StashEntry,
  StatusResult,
} from '@githappens/git/types';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Crosshair, RotateCw } from 'lucide-react';
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import type { GraphColumnId } from '../../../../shared/ipc/graph-contract';
import { refTarget } from '../../actions/dnd';
import { checkout, createBranch } from '../../actions/git-actions';
import { checkoutTargetFor, commitMenu, refMenu, stashMenu, wipMenu } from '../../actions/menus';
import { registerCommands } from '../../commands/registry';
import { getAvatarVersion, subscribeAvatars, useAvatarPolicy } from '../../components/Avatar';
import { useContextMenu, type MenuEntry } from '../../components/ContextMenu';
import { choose, confirm } from '../../components/Dialogs';
import { invoke } from '../../lib/api';
import { authorInitials, formatDate, fullDate, shortSha } from '../../lib/format';
import { usePrIndex } from '../../integrations/queries';
import { useRefs, useStashes, useStatus } from '../../repo/queries';
import { useRepoUi, useRepoUiStore, type Selection } from '../../stores/repo-ui';
import { useSetting, useSettingsStore } from '../../stores/settings';
import { getThemeVersion, subscribeTheme } from '../../theme/builtin';
import { multiCommitMenu } from '../ops/multi-commit-menu';
import { CanvasAvatarCache } from './avatar-canvas';
import {
  columnWidths,
  COLUMN_SPECS,
  legacyLayout,
  moveColumn,
  resizeColumn,
  resolveColumns,
  toggleColumn,
} from './graph-columns';
import { graphInvoke } from './graph-ipc';
import { navTarget } from './graph-nav';
import { GraphHeader } from './GraphHeader';
import { AVATAR_PX, GraphRow, type RowApi, type WipInfo } from './GraphRow';
import { GraphSearchBar, useSearchMatches } from './GraphSearch';
import styles from './GraphView.module.css';
import { PopoverEntry, RefsPopover, type PillHandlers } from './RefCell';
import { hideRef, soloRef, updateColumns, updateVisibility, useRepoGraphState } from './repo-graph-state';
import { VisibilityChip } from './visibility-ui';
import { HistoryKeyTracker, useGraphModel, wipKind } from './useGraphModel';
import { useHistory } from './useHistory';

/** Loads beyond this many commits ask first (spec 04 §6.8 / §11 `graph:revealCommit`). */
const CONFIRM_LOAD = 50_000;
const SKELETON_ROWS = 20;
/**
 * Rows are positioned inside a layer that is re-based every CHUNK rows, so row offsets (and therefore the
 * memoized rows) stay unchanged while scrolling; only the layer's transform follows the scroll position.
 */
const CHUNK = 256;
const NO_PILLS: readonly RefPill[] = Object.freeze([]);
const MemoGraphHeader = memo(GraphHeader);
const MemoSearchBar = memo(GraphSearchBar);

/** A stable object whose methods always call the latest handlers (row callbacks for memoized rows). */
function useLatestApi(api: RowApi): RowApi {
  const ref = useRef(api);
  useLayoutEffect(() => {
    ref.current = api;
  });
  return useMemo(
    (): RowApi => ({
      mouseDown: (row, e) => ref.current.mouseDown(row, e),
      enter: (row) => ref.current.enter(row),
      doubleClick: (row) => ref.current.doubleClick(row),
      contextMenu: (row, e) => ref.current.contextMenu(row, e),
      more: (row, e) => ref.current.more(row, e),
      showHidden: (pills) => ref.current.showHidden(pills),
      copy: (text) => ref.current.copy(text),
      pillHandlers: (pill) => ref.current.pillHandlers(pill),
    }),
    [],
  );
}

/** A stable function that always calls the latest `fn` (handlers for memoized children). */
function useLatest<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  useLayoutEffect(() => {
    ref.current = fn;
  });
  return useCallback((...args: A) => ref.current(...args), []);
}

/** Lane palette + node colors from the active theme tokens (spec 13). */
function readPalette(_version: number): { colors: string[]; background: string; accent: string } {
  const cs = getComputedStyle(document.documentElement);
  const colors = Array.from({ length: 10 }, (_, i) =>
    cs.getPropertyValue(`--kl-graph-color-${i + 1}`).trim(),
  );
  return {
    colors: colors.filter(Boolean).length ? colors : ['#2ec4b6'],
    background: cs.getPropertyValue('--kl-panel__bg0').trim() || '#1d2126',
    accent: cs.getPropertyValue('--kl-text-accent').trim() || '#2ec4b6',
  };
}

export function GraphView({ repoId, info }: { repoId: RepoId; info: RepoInfo }) {
  const graphState = useRepoGraphState(repoId);
  const vis = graphState.vis;
  const version = useRepoUi(repoId, (u) => u.graphVersion);
  const status = useStatus(repoId, !info.isBare);
  const stashes = useStashes(repoId);
  const refs = useRefs(repoId);
  const reuse = useSetting('graph.convergenceReuse') ?? true;
  const mergeHead = useQuery({
    queryKey: ['mergeHead', repoId, info.state],
    queryFn: () => invoke('git:revParse', { repoId, rev: 'MERGE_HEAD' }),
    enabled: info.state === 'merging',
  });

  const refList = refs.data;
  const stashList = stashes.data;
  // Stale hide / solo / pin names (deleted branches, dropped stashes) are dropped (spec 01 §8).
  useEffect(() => {
    if (!graphState.loaded || !refList || !stashList) return;
    const pruned = pruneVisibility(vis, refList, stashList);
    if (pruned) updateVisibility(repoId, () => pruned);
  }, [graphState.loaded, refList, stashList, vis, repoId]);

  const headSha = info.head.sha;
  const refsReady = refs.isFetched && stashes.isFetched;
  const ready = graphState.loaded && refsReady;
  // Without hide / solo the rev query is `--all` whatever the refs are, so history starts loading in
  // parallel with refs / stashes (rows still wait for them, so pills and stash rows appear together).
  const queryNeedsRefs = vis.solo.length > 0 || vis.hidden.some((h) => !h.startsWith('stash:'));
  const historyReady = graphState.loaded && (refsReady || !queryNeedsRefs);
  const refsArr = useMemo(() => refList ?? [], [refList]);
  const stashArr = useMemo(() => stashList ?? [], [stashList]);
  const revQuery = useMemo(
    () => graphRevQuery(refsArr, vis, { headSha, stashes: stashArr }),
    [refsArr, vis, headSha, stashArr],
  );
  // History reloads only when the loaded commit set can change (spec 04 §6.10): a tag or branch created
  // at an existing commit, a rename or an upstream change keep the key, so only the pills update.
  const tips = useMemo(() => visibleTips(refsArr, vis, headSha, stashArr), [refsArr, vis, headSha, stashArr]);
  const tipKey = useMemo(
    () => visibleTipKey(refsArr, vis, headSha, stashArr),
    [refsArr, vis, headSha, stashArr],
  );
  const [keys] = useState(() => new HistoryKeyTracker());
  const historyKey = refsReady ? keys.resolve(tipKey, tips) : keys.pending();
  const history = useHistory(repoId, `${version}|${historyKey}`, { query: revQuery, enabled: historyReady });

  const visibleStashes = useMemo(
    () => stashArr.filter((s) => !vis.hidden.includes(stashKey(s.sha))),
    [stashArr, vis],
  );
  const omit = useMemo(() => hiddenStashShas(stashArr, vis), [stashArr, vis]);
  const pinnedTips = useMemo(() => pinnedTipShas(refsArr, vis), [refsArr, vis]);
  const model = useGraphModel({
    history,
    info,
    status: status.data,
    stashes: visibleStashes,
    mergeHead: mergeHead.data,
    pinnedTips,
    omit,
    reuse,
  });
  keys.observe(model);

  const retry = (): void => {
    void refs.refetch();
    void stashes.refetch();
    useRepoUiStore.getState().bumpGraph(repoId);
  };

  const fatal =
    (history.error && model.rowCount === 0 ? history.error : null) ??
    (refs.error && !refList ? String((refs.error as Error).message ?? refs.error) : null);
  if (fatal) {
    return (
      <div className={styles.state} role="alert">
        <div className={styles.errorCard}>
          <p className={styles.errorTitle}>
            <AlertTriangle size={16} /> Could not load history
          </p>
          <pre className={styles.errorText}>{fatal}</pre>
          <button type="button" className={styles.retryBtn} onClick={retry}>
            <RotateCw size={12} /> Retry
          </button>
        </div>
      </div>
    );
  }
  if (!ready || (model.rowCount === 0 && !history.done)) return <GraphSkeleton />;
  if (model.rowCount === 0) {
    return (
      <div className={styles.state}>
        <p>This repository has no commits yet.</p>
      </div>
    );
  }
  return (
    <GraphCanvasView
      repoId={repoId}
      info={info}
      model={model}
      history={history}
      refsData={refsArr}
      stashes={stashArr}
      visibleStashes={visibleStashes}
      vis={vis}
      status={status.data}
      revQuery={revQuery}
      tipKey={tipKey}
      onRetry={retry}
    />
  );
}

/** Loading skeleton: 20 gray rows (spec 04 §4.14). */
function GraphSkeleton() {
  return (
    <div className={styles.view} aria-busy="true" aria-label="Loading commit graph">
      <div className={styles.skeleton}>
        {Array.from({ length: SKELETON_ROWS }, (_, i) => (
          <div key={i} className={styles.skeletonRow}>
            <span className={styles.skeletonDot} style={{ marginLeft: 180 + (i % 3) * 14 }} />
            <span className={styles.skeletonBar} style={{ width: `${30 + ((i * 37) % 45)}%` }} />
          </div>
        ))}
      </div>
    </div>
  );
}

interface CanvasProps {
  repoId: RepoId;
  info: RepoInfo;
  model: GraphModel<CommitSummary>;
  history: ReturnType<typeof useHistory>;
  refsData: RefInfo[];
  stashes: StashEntry[];
  visibleStashes: StashEntry[];
  vis: RefVisibilityState;
  status: StatusResult | undefined;
  revQuery: ReturnType<typeof graphRevQuery>;
  tipKey: string;
  onRetry(): void;
}

function GraphCanvasView(props: CanvasProps) {
  const { repoId, info, history, refsData, stashes, visibleStashes, vis, status } = props;
  // Search runs on the full model; in filter mode `search.model` holds only the matching rows (spec 12 §4.7).
  const search = useSearchMatches(repoId, props.model);
  const model = search.model;
  // Branch → open pull request, for the PR badge next to ref pills (spec 10 §6.5).
  const prIndex = usePrIndex(repoId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [virtualTop, setVirtualTop] = useState(0);
  const virtualRef = useRef(0);
  const [viewport, setViewport] = useState({ w: 900, h: 600 });
  const [hoverTip, setHoverTip] = useState<Sha | null>(null);
  const [hoverRow, setHoverRow] = useState(-1);
  const [focusRow, setFocusRow] = useState(-1);
  const [tooltip, setTooltip] = useState<{ row: number; x: number; y: number } | null>(null);
  const [popover, setPopover] = useState<{ row: number; x: number; y: number } | null>(null);
  const [graphScrollX, setGraphScrollX] = useState(0);
  const [liveWidth, setLiveWidth] = useState<{ id: GraphColumnId; width: number } | null>(null);
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1);
  const anchor = useRef<number>(-1);
  const tipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingTipRow = useRef(-1);

  const graphState = useRepoGraphState(repoId);
  const dateFormat = useSetting('ui.dateFormat');
  const density = useSetting('ui.graphRowHeight') ?? 'normal';
  const edgeStyle = useSetting('ui.graphEdgeStyle') ?? 'rounded';
  const hoverHighlight = useSetting('ui.graphHoverHighlight') ?? true;
  const avatarsOn = useAvatarPolicy();
  const avatarVersion = useSyncExternalStore(subscribeAvatars, getAvatarVersion);
  const draft = useRepoUi(repoId, (u) => u.draft.summary);
  const selection = useRepoUi(repoId, (u) => u.selection);
  const reveal = useRepoUi(repoId, (u) => u.reveal);
  const update = useRepoUiStore((s) => s.update);
  const showMenu = useContextMenu((s) => s.show);
  const metrics = useMemo(() => createMetrics(density, { edgeStyle }), [density, edgeStyle]);
  const rowH = metrics.rowHeight;

  const themeVersion = useSyncExternalStore(subscribeTheme, getThemeVersion);
  const palette = useMemo(() => readPalette(themeVersion), [themeVersion]);

  // ---- refs → pills (ref-only changes end here: no relayout, spec 04 §6.10 case 2) ----
  const hiddenSet = useMemo(() => effectiveHidden(refsData, vis), [refsData, vis]);
  const detachedHeadSha = info.head.kind === 'detached' ? info.head.sha : null;
  const pills = useMemo(
    () => groupRefPills(refsData, { hidden: hiddenSet, detachedHeadSha, stashes: visibleStashes }),
    [refsData, hiddenSet, detachedHeadSha, visibleStashes],
  );
  const hiddenPills = useMemo(
    () => groupRefPills(refsData.filter((r) => hiddenSet.has(r.fullName))),
    [refsData, hiddenSet],
  );
  const stashBySha = useMemo(() => new Map(stashes.map((s) => [s.sha, s])), [stashes]);
  const refByName = useMemo(() => new Map(refsData.map((r) => [r.fullName, r])), [refsData]);

  const searchMode = useRepoUi(repoId, (u) => u.search.mode);
  const selectedShas = useMemo(() => selectionShas(selection), [selection]);

  // ---- scrolling (scaled mode above 15M px, spec 04 §4.13) ----
  const mapping = createScrollMapping(model.rowCount, rowH, viewport.h);
  const mappingRef = useRef(mapping);
  useLayoutEffect(() => {
    mappingRef.current = mapping;
  });
  const setVirtual = useCallback((v: number) => {
    const m = mappingRef.current;
    const clamped = Math.max(0, Math.min(m.maxVirtualTop, v));
    virtualRef.current = clamped;
    setVirtualTop(clamped);
    const el = scrollRef.current;
    if (el) el.scrollTop = m.toScroll(clamped);
  }, []);
  // Pooled rows (spec 04 §4.13 / §7.10): a fixed-size window (visible rows ± 1) whose DOM rows are recycled
  // by `row % pool`, so scrolling updates the rows that changed instead of remounting every row.
  const pool = Math.max(1, Math.ceil(Math.max(0, viewport.h) / rowH) + 3);
  const firstRow = Math.max(0, Math.min(Math.floor(virtualTop / rowH) - 1, model.rowCount - pool));
  const lastRow = Math.min(model.rowCount, firstRow + pool) - 1;
  const maxColInRange = model.maxColumnInRange(firstRow, Math.max(firstRow, lastRow));

  // ---- columns (per repo, spec 04 §4.2) ----
  const layout = graphState.columns ?? legacyLayout();
  const graphAuto = graphColumnWidth(metrics, maxColInRange, 48, 360);
  const cols = useMemo(() => {
    const resolved = resolveColumns(layout);
    return liveWidth
      ? resolved.map((c) => (c.id === liveWidth.id ? { ...c, width: liveWidth.width } : c))
      : resolved;
  }, [layout, liveWidth]);
  const placed = useMemo(() => columnWidths(cols, viewport.w, graphAuto), [cols, viewport.w, graphAuto]);
  const graphCol = placed.find((c) => c.id === 'graph');
  const graphWidth = graphCol?.width ?? 0;
  const graphLeft = graphCol?.left ?? 0;
  const lanesRight = laneX(metrics, Math.max(0, maxColInRange)) + metrics.laneWidth / 2 + metrics.paddingLeft;
  const maxScrollX = Math.max(0, Math.ceil(lanesRight - graphWidth));
  const scrollX = Math.min(graphScrollX, maxScrollX);

  // ---- canvas drawing ----
  const frame = useRef(0);
  const [avatarCache] = useState(() => new CanvasAvatarCache());
  const draw = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const canvas = canvasRef.current;
      const el = scrollRef.current;
      if (!canvas || !el || graphWidth <= 0) return;
      const w = graphWidth;
      const h = el.clientHeight;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const tipRow = hoverTip ? model.rowOf(hoverTip) : -1;
      drawGraph(ctx, model, {
        scrollTop: virtualRef.current,
        width: w,
        height: h,
        dpr,
        scrollX,
        metrics,
        colors: palette.colors,
        nodeColors: { background: palette.background, accent: palette.accent, transparent: 'rgba(0,0,0,0)' },
        selected: selectedShas,
        highlight: tipRow >= 0 ? model.reachable(tipRow) : null,
        dimmed: search.dimmed && searchMode === 'filter' ? (row: number) => !search.rows.has(row) : undefined,
        headSha: info.head.sha,
        hoverRow,
        avatars: avatarsOn
          ? (_sha, row) => {
              const c = model.commitAt(row);
              return c ? avatarCache.get(c.authorEmail, AVATAR_PX) : null;
            }
          : undefined,
        initials: (_sha, row) => {
          const c = model.commitAt(row);
          return c ? authorInitials(c.authorName, c.authorEmail) : null;
        },
      });
    });
  }, [
    model,
    graphWidth,
    dpr,
    scrollX,
    metrics,
    palette,
    selectedShas,
    hoverTip,
    hoverRow,
    search,
    searchMode,
    info.head.sha,
    avatarsOn,
    avatarCache,
  ]);
  useEffect(() => avatarCache.setOnReady(draw), [avatarCache, draw]);

  // The model mutates in place as pages arrive; its version drives redraws.
  const modelVersion = model.version;
  // viewport.h: a height-only resize must resize the canvas backing store too (else it is stretched).
  useLayoutEffect(draw, [draw, virtualTop, modelVersion, avatarVersion, viewport.h]);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewport({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setViewport({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);
  // Moving between monitors changes the DPR: resize the backing store and redraw (spec 04 §6.11).
  useEffect(() => {
    const mq = window.matchMedia(`(resolution: ${dpr}dppx)`);
    const onChange = (): void => setDpr(window.devicePixelRatio || 1);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [dpr]);

  // Scaled mode: wheel deltas are applied in virtual space so per-pixel scrolling stays smooth.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !mapping.scaled) return;
    const onWheel = (e: WheelEvent): void => {
      if (e.shiftKey || e.ctrlKey) return;
      e.preventDefault();
      const dy =
        e.deltaMode === 1 ? e.deltaY * rowH : e.deltaMode === 2 ? e.deltaY * el.clientHeight : e.deltaY;
      setVirtual(virtualRef.current + dy);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [mapping.scaled, rowH, setVirtual]);

  // ---- model swap: keep the scroll anchored and carry the selection (spec 04 §6.10 steps 4–5) ----
  const prevModel = useRef(model);
  const scrollAnchor = useRef<{ sha: Sha; offset: number; atTop: boolean } | null>(null);
  useLayoutEffect(() => {
    if (prevModel.current !== model) {
      const old = prevModel.current;
      prevModel.current = model;
      const a = scrollAnchor.current;
      if (a && !a.atTop) {
        let row = model.rowOf(a.sha);
        // anchor rewritten (rebase / amend): nearest surviving first-parent ancestor
        for (let r = old.rowOf(a.sha), guard = 0; row < 0 && r >= 0 && guard < 10_000; guard++) {
          r = old.firstParentRow(r);
          if (r >= 0) row = model.rowOf(old.shaAt(r)!);
        }
        if (row >= 0) setVirtual(row * rowH - a.offset);
      }
      const sel = useRepoUiStore.getState().get(repoId).selection;
      if (
        sel.kind === 'commit' &&
        model.rowCount > 1 &&
        model.rowOf(sel.sha) < 0 &&
        sel.sha === old.headSha
      ) {
        const head = model.headSha;
        if (head && model.rowOf(head) >= 0)
          update(repoId, () => ({ selection: { kind: 'commit', sha: head } }));
      }
    }
    const top = virtualRef.current;
    const first = Math.min(model.rowCount - 1, Math.floor(top / rowH));
    const sha = first >= 0 ? model.shaAt(first) : undefined;
    scrollAnchor.current = sha ? { sha, offset: first * rowH - top, atTop: top < rowH } : null;
  });

  // ---- infinite loading near the bottom (spec 04 §4.14, §7 step 20) ----
  useEffect(() => {
    if (history.autoLoad && !history.done && !history.loading && lastRow >= model.rowCount - 200)
      void history.loadMore();
  }, [lastRow, model.rowCount, history]);

  // ---- selection helpers ----
  const selectRange = useCallback(
    (a: number, b: number) => {
      const shas: Sha[] = [];
      for (let r = Math.min(a, b); r <= Math.max(a, b); r++) {
        const s = model.shaAt(r);
        if (s && s !== WIP_SHA) shas.push(s);
      }
      update(repoId, () => ({
        selection: shas.length === 1 ? { kind: 'commit', sha: shas[0]! } : { kind: 'commits', shas },
        center: { kind: 'graph' },
      }));
    },
    [model, repoId, update],
  );

  const toggleRow = useCallback(
    (row: number) => {
      const sha = model.shaAt(row);
      if (!sha || sha === WIP_SHA) return;
      const cur = selectionShas(useRepoUiStore.getState().get(repoId).selection);
      if (cur.has(sha)) cur.delete(sha);
      else cur.add(sha);
      cur.delete(WIP_SHA);
      const shas = [...cur];
      const next: Selection =
        shas.length === 0
          ? { kind: 'none' }
          : shas.length === 1
            ? { kind: 'commit', sha: shas[0]! }
            : { kind: 'commits', shas };
      update(repoId, () => ({ selection: next, center: { kind: 'graph' } }));
    },
    [model, repoId, update],
  );

  const selectRow = useCallback(
    (row: number, e?: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => {
      const sha = model.shaAt(row);
      if (!sha) return;
      setFocusRow(row);
      if (e?.shiftKey && anchor.current >= 0) {
        selectRange(anchor.current, row);
        return;
      }
      anchor.current = row;
      if (e && (e.ctrlKey || e.metaKey) && sha !== WIP_SHA) {
        toggleRow(row);
        return;
      }
      update(repoId, () => ({ selection: selectionFor(model, row, stashBySha), center: { kind: 'graph' } }));
    },
    [model, repoId, stashBySha, update, selectRange, toggleRow],
  );

  const scrollToRow = useCallback(
    (row: number, center = true) => {
      const el = scrollRef.current;
      if (!el) return;
      setVirtual(
        virtualTopForRow(row, rowH, el.clientHeight, virtualRef.current, center ? 'center' : 'nearest', 3),
      );
    },
    [rowH, setVirtual],
  );

  // ---- reveal requests (left panel click, parent links, jump to HEAD; spec 04 graph:revealCommit) ----
  useEffect(() => {
    if (!reveal) return;
    let cancelled = false;
    void (async () => {
      const pred = (): boolean => model.rowOf(reveal.sha) >= 0;
      let found = await history.loadUntil(pred, history.count + CONFIRM_LOAD);
      if (cancelled) return;
      if (!found && !history.done && !pred()) {
        // the commit is deeper than 50k more commits (or hidden): ask before loading everything
        const ok = await confirm(
          'Load more history?',
          `This commit is not among the ${history.count.toLocaleString()} loaded commits. Load the rest of the history to show it?`,
          'Load history',
        );
        if (!ok || cancelled) return;
        found = await history.loadUntil(pred, Number.MAX_SAFE_INTEGER);
      }
      const row = model.rowOf(reveal.sha);
      if (!cancelled && found && row >= 0) {
        anchor.current = row;
        setFocusRow(row);
        scrollToRow(row);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on a new reveal request
  }, [reveal?.nonce]);

  // Search navigation scrolls to the active hit.
  useEffect(() => {
    if (search.activeRow >= 0) scrollToRow(search.activeRow);
  }, [search.activeRow, scrollToRow]);

  const jumpToHead = useCallback((): void => {
    if (model.hasWipRow) {
      update(repoId, () => ({ selection: { kind: 'wip' }, center: { kind: 'graph' } }));
      setFocusRow(0);
      scrollToRow(0);
    } else if (info.head.sha) useRepoUiStore.getState().reveal(repoId, info.head.sha);
  }, [model, repoId, update, scrollToRow, info.head.sha]);

  // ---- commit-count estimate for the footer and "Load all" (graph:countCommits) ----
  const revKey = JSON.stringify(props.revQuery);
  const total = useQuery({
    queryKey: ['graphCount', repoId, props.tipKey, revKey],
    queryFn: () =>
      graphInvoke('graph:countCommits', {
        repoId,
        revs: props.revQuery.revs,
        hiddenRefs: 'hiddenRefs' in props.revQuery ? props.revQuery.hiddenRefs : undefined,
      }),
    enabled: !history.done,
    staleTime: 60_000,
    retry: false,
  });
  const loadedCommits = history.count;

  const loadAll = async (): Promise<void> => {
    const remaining = (total.data ?? 0) - loadedCommits;
    if (remaining > CONFIRM_LOAD) {
      const ok = await confirm(
        'Load all commits?',
        `This loads ${remaining.toLocaleString()} more commits. Large histories take a while and use more memory.`,
        'Load all',
      );
      if (!ok) return;
    }
    await history.loadUntil(() => false, Number.MAX_SAFE_INTEGER);
  };

  // ---- palette commands for this graph ----
  useEffect(
    () =>
      registerCommands([
        {
          id: 'graph.showAllRefs',
          title: 'Graph: Show all branches (clear hide / solo)',
          category: 'View',
          run: () => updateVisibility(repoId, (v) => ({ hidden: [], solo: [], pinned: [...v.pinned] })),
          keywords: ['unhide', 'unsolo', 'hidden', 'solo'],
        },
        {
          id: 'graph.resetColumns',
          title: 'Graph: Reset columns to default',
          category: 'View',
          run: () => updateColumns(repoId, null),
        },
      ]),
    [repoId],
  );

  // ---- menus ----
  const copy = (text: string): void => void invoke('shell:copyText', { text });

  const rowMenu = (row: number, x: number, y: number): void => {
    const sha = model.shaAt(row);
    if (!sha) return;
    if (sha === WIP_SHA) {
      showMenu(
        x,
        y,
        wipMenu(repoId, () => selectRow(row)),
      );
      return;
    }
    const stash = stashBySha.get(sha);
    if (stash) {
      showMenu(x, y, stashMenu(repoId, stash));
      return;
    }
    // multi-commit selection (spec 04 §4.10, spec 05 §4.2): one menu for the whole selection, graph order
    if (selection.kind === 'commits' && selection.shas.includes(sha)) {
      const commits = selection.shas
        .map((s) => ({ s, row: model.rowOf(s) }))
        .filter((x) => x.row >= 0)
        .sort((a, b) => a.row - b.row)
        .map(({ s, row: r }) => ({
          sha: s,
          parents: model.commitAt(r)?.parents ?? [],
          subject: model.commitAt(r)?.subject,
        }));
      showMenu(
        x,
        y,
        multiCommitMenu(repoId, commits, {
          headSha: info.head.sha,
          headBranch: info.head.kind === 'branch' ? info.head.name : null,
        }),
      );
      return;
    }
    const c = model.commitAt(row);
    const compare: MenuEntry = {
      label: 'Compare with selected commit',
      disabled: selection.kind !== 'commit' || selection.sha === sha,
      onSelect: () =>
        selection.kind === 'commit' &&
        update(repoId, () => ({
          selection: { kind: 'commits', shas: [sha, selection.sha] },
          center: { kind: 'graph' },
        })),
    };
    showMenu(x, y, [
      ...commitMenu(repoId, sha, c?.subject, info.head.sha, {
        headBranch: info.head.kind === 'branch' ? info.head.name : null,
        isMerge: (c?.parents.length ?? 0) > 1,
      }),
      'separator',
      compare,
    ]);
  };

  const refInfoFor = (pill: RefPill): RefInfo | undefined => {
    const name = (pill.local ?? pill.ref)?.fullName;
    return name ? refByName.get(name) : undefined;
  };

  const pillMenu = (pill: RefPill, x: number, y: number): void => {
    const ref = refInfoFor(pill);
    if (ref) showMenu(x, y, refMenu(repoId, ref, refsData));
    else if (pill.kind === 'stash') {
      const st = stashBySha.get(pill.sha);
      if (st) showMenu(x, y, stashMenu(repoId, st));
    }
  };

  /** Double-click a pill: check out that ref (remote-only → tracking branch; spec 04 §4.7). */
  const pillCheckout = (pill: RefPill): void => {
    const ref = refInfoFor(pill);
    if (!ref || pill.isCheckedOut) return;
    void checkout(repoId, checkoutTargetFor(ref));
  };

  const hidePill = (pill: RefPill): void => {
    if (pill.kind === 'stash') hideRef(repoId, stashKey(pill.sha), true);
    else for (const name of pill.refs) hideRef(repoId, name, true);
  };

  const pillHandlers = (pill: RefPill): PillHandlers => ({
    onHover: (tip) => setHoverTip(hoverHighlight ? tip : null),
    onMenu: (x, y) => pillMenu(pill, x, y),
    onDoubleClick: () => pillCheckout(pill),
    onHide: pill.kind === 'detached' || pill.isCheckedOut ? undefined : () => hidePill(pill),
    onSolo:
      pill.kind === 'stash' || pill.kind === 'detached'
        ? undefined
        : () => soloRef(repoId, pill.fullName, !vis.solo.includes(pill.fullName)),
    onMiddleClick: pill.kind === 'detached' || pill.isCheckedOut ? undefined : () => hidePill(pill),
  });

  /** Double-click resolution (spec 04 §6.9). */
  const rowDoubleClick = async (row: number): Promise<void> => {
    const sha = model.shaAt(row);
    if (!sha || sha === WIP_SHA || stashBySha.has(sha)) return;
    const rowPills = pills.get(sha) ?? [];
    const local = rowPills.find((p) => p.kind === 'head' || p.kind === 'local');
    const remote = rowPills.find((p) => p.kind === 'remote');
    const tag = rowPills.find((p) => p.kind === 'tag');
    const short = shortSha(sha);
    if (local) {
      if (!local.isCheckedOut) pillCheckout(local);
      return;
    }
    if (remote) {
      pillCheckout(remote);
      return;
    }
    if (sha === info.head.sha) return;
    if (tag) {
      const ok = await confirm(
        'Checkout tag?',
        `Check out ${tag.label}? HEAD will be detached at ${short}.`,
        'Checkout',
      );
      if (ok) pillCheckout(tag);
      return;
    }
    const r = await choose({
      title: 'Checkout detached HEAD?',
      message: `No branch points at ${short}. Check it out as a detached HEAD, or create a branch here?`,
      choices: [
        { value: 'cancel', label: 'Cancel' },
        { value: 'branch', label: 'Create branch here' },
        { value: 'checkout', label: 'Checkout', primary: true },
      ],
    });
    if (r?.value === 'checkout') void checkout(repoId, { kind: 'commit', sha });
    else if (r?.value === 'branch') void createBranch(repoId, sha, short);
  };

  // ---- keyboard (spec 04 §2.5, §6.13) ----
  const onKeyDown = (e: React.KeyboardEvent): void => {
    const cur = focusRow >= 0 && focusRow < model.rowCount ? focusRow : focusRowOf(model, selection);
    const k = e.key;
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'c') {
      e.preventDefault();
      const shas = [...selectedShas].filter((s) => s !== WIP_SHA);
      if (e.shiftKey) {
        const subjects = shas.map((s) => model.commitAt(model.rowOf(s))?.subject).filter(Boolean);
        if (subjects.length) copy(subjects.join('\n'));
      } else if (shas.length) {
        shas.sort((a, b) => model.rowOf(a) - model.rowOf(b));
        copy(shas.join('\n'));
      }
      return;
    }
    if ((k === 'F10' && e.shiftKey) || k === 'ContextMenu') {
      e.preventDefault();
      if (cur < 0) return;
      const rect = scrollRef.current!.getBoundingClientRect();
      rowMenu(
        cur,
        rect.left + graphLeft + graphWidth + 24,
        rect.top + cur * rowH - virtualRef.current + rowH,
      );
      return;
    }
    if (k === ' ' && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      if (cur >= 0) {
        anchor.current = cur;
        toggleRow(cur);
      }
      return;
    }
    if (k === 'Enter') {
      e.preventDefault();
      if (cur >= 0) selectRow(cur);
      return;
    }
    if (k === 'Escape') {
      setHoverTip(null);
      setPopover(null);
      if (selection.kind !== 'none') update(repoId, () => ({ selection: { kind: 'none' } }));
      return;
    }
    const nav = navTarget(model, cur, e, Math.max(1, Math.floor(viewport.h / rowH) - 1));
    if (!nav) return;
    e.preventDefault();
    if (nav.kind === 'extend') {
      if (anchor.current < 0) anchor.current = Math.max(0, cur);
      selectRange(anchor.current, nav.row);
      setFocusRow(nav.row);
    } else {
      selectRow(nav.row);
    }
    scrollToRow(nav.row, false);
  };

  // ---- node hover tooltip (400 ms, spec 04 §4.7) ----
  const onMouseMove = (e: React.MouseEvent): void => {
    const rect = scrollRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left - graphLeft;
    const y = e.clientY - rect.top;
    const hit =
      x >= 0 && x <= graphWidth
        ? hitTestNode(model, metrics, x, y, { scrollTop: virtualRef.current, scrollX })
        : null;
    if (!hit) {
      if (tipTimer.current) clearTimeout(tipTimer.current);
      pendingTipRow.current = -1;
      if (tooltip) setTooltip(null);
      return;
    }
    if (tooltip?.row === hit.row || pendingTipRow.current === hit.row) return;
    if (tipTimer.current) clearTimeout(tipTimer.current);
    pendingTipRow.current = hit.row;
    const pos = { x: e.clientX, y: e.clientY };
    tipTimer.current = setTimeout(() => setTooltip({ row: hit.row, ...pos }), 400);
  };
  useEffect(
    () => () => {
      if (tipTimer.current) clearTimeout(tipTimer.current);
    },
    [],
  );

  // ---- ghost branch for the hovered / focused commit without refs (§4.5, §6.7) ----
  const ghostRow = hoverRow >= 0 ? hoverRow : focusRow;
  const ghost = useMemo((): { row: number; ref: GhostCandidate } | null => {
    if (ghostRow < 0 || ghostRow >= model.rowCount) return null;
    const sha = model.shaAt(ghostRow);
    if (!sha || sha === WIP_SHA || pills.get(sha)?.length || hiddenPills.get(sha)?.length) return null;
    if (stashBySha.has(sha)) return null;
    const r = model.nearestBranch(ghostRow, (row) => ghostCandidates(pills.get(model.shaAt(row) ?? '')));
    return r && 'ref' in r && r.distance > 0 ? { row: ghostRow, ref: r.ref } : null;
    // model.version: appended pages can add children
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ghostRow, model, model.version, pills, hiddenPills, stashBySha]);

  // ---- columns: resize / reorder / autosize / menu ----
  const autosize = (id: GraphColumnId): void => {
    if (id === 'graph') return updateColumns(repoId, resizeColumn(layout, 'graph', null));
    let w = COLUMN_SPECS[id].width;
    const from = Math.max(0, firstRow);
    const to = Math.min(model.rowCount - 1, lastRow);
    let max = 0;
    for (let r = from; r <= to; r++) {
      const sha = model.shaAt(r)!;
      const c = model.commitAt(r);
      if (id === 'refs') {
        const p = pills.get(sha)?.[0];
        if (p) max = Math.max(max, measure(p.label) + 48 + ((pills.get(sha)?.length ?? 0) > 1 ? 28 : 0));
      } else if (id === 'author' && c) max = Math.max(max, measure(c.authorName) + 46);
      else if (id === 'date' && c) max = Math.max(max, measure(formatDate(c.authorTime, dateFormat)) + 20);
      else if (id === 'sha' && c) max = Math.max(max, measure(shortSha(c.sha), '12px monospace') + 20);
    }
    if (max > 0) w = max;
    updateColumns(repoId, resizeColumn(layout, id, w));
  };

  const setSetting = useSettingsStore((s) => s.set);
  const headerMenu = (x: number, y: number): void => {
    const visible = new Set(cols.filter((c) => c.visible).map((c) => c.id));
    showMenu(x, y, [
      ...(['refs', 'graph', 'author', 'date', 'sha'] as const).map((id) => ({
        label: `${visible.has(id) ? '✓ ' : '   '}${COLUMN_SPECS[id].title}`,
        onSelect: () => updateColumns(repoId, toggleColumn(layout, id)),
      })),
      { label: 'Reset columns to default', onSelect: () => updateColumns(repoId, null) },
      'separator',
      {
        label: `${density === 'compact' ? '✓ ' : '   '}Compact graph`,
        onSelect: () => void setSetting('ui.graphRowHeight', density === 'compact' ? 'normal' : 'compact'),
      },
      {
        label: `${avatarsOn ? '✓ ' : '   '}Show avatars (off: initials only)`,
        onSelect: () => void setSetting('ui.authorDisplay', avatarsOn ? 'initials' : 'avatar'),
      },
      {
        label: `${hoverHighlight ? '✓ ' : '   '}Highlight branch on hover`,
        onSelect: () => void setSetting('ui.graphHoverHighlight', !hoverHighlight),
      },
      {
        label: `Edges: ${edgeStyle === 'bezier' ? 'bezier' : 'rounded'} (switch)`,
        onSelect: () => void setSetting('ui.graphEdgeStyle', edgeStyle === 'bezier' ? 'rounded' : 'bezier'),
      },
    ]);
  };

  // Header / search strip only re-render when their own inputs change, not on every scroll frame.
  const chips = useMemo(() => <VisibilityChip repoId={repoId} refs={refsData} />, [repoId, refsData]);
  const onColumnMove = useLatest((id: GraphColumnId, before: GraphColumnId | null) =>
    updateColumns(repoId, moveColumn(layout, id, before)),
  );
  const onColumnResize = useLatest((id: GraphColumnId, width: number, commit: boolean) => {
    if (commit) {
      setLiveWidth(null);
      updateColumns(repoId, resizeColumn(layout, id, width));
    } else setLiveWidth({ id, width: Math.max(COLUMN_SPECS[id].min, width) });
  });
  const onAutosize = useLatest(autosize);
  const onHeaderMenu = useLatest(headerMenu);

  // ---- rows (pooled, memoized DOM rows; spec 04 §7.10) ----
  const rowApi = useLatestApi({
    mouseDown: (row, e) => selectRow(row, e),
    enter: (row) => setHoverRow(row),
    doubleClick: (row) => void rowDoubleClick(row),
    contextMenu: (row, e) => {
      const sha = model.shaAt(row);
      if (sha && !selectedShas.has(sha)) selectRow(row);
      rowMenu(row, e.clientX, e.clientY);
    },
    more: (row, e) => setPopover({ row, x: e.clientX, y: e.clientY + 8 }),
    showHidden: (hiddenHere) => {
      // explicitly hidden → unhide; hidden because another ref is soloed → solo it too
      for (const p of hiddenHere) {
        for (const n of p.refs) {
          if (vis.hidden.includes(n)) hideRef(repoId, n, false);
          else soloRef(repoId, n, true);
        }
      }
    },
    copy,
    pillHandlers,
  });
  const status0 = wipKind(status);
  const wipInfo = useMemo(
    (): WipInfo => ({ status, kind: status0, state: info.state, draft }),
    [status, status0, info.state, draft],
  );
  const filterDim = search.dimmed && searchMode === 'filter';
  const base = Math.floor(firstRow / CHUNK) * CHUNK;
  const rows = [];
  for (let slot = 0; slot < pool; slot++) {
    // slot order is stable: a row keeps its DOM node while it stays in the window
    const row = firstRow + ((slot - (firstRow % pool) + pool) % pool);
    if (row > lastRow) continue;
    const sha = model.shaAt(row)!;
    const rowPills = pills.get(sha) ?? NO_PILLS;
    const first = rowPills[0];
    const isMatch = search.rows.has(row);
    const prName =
      first && (first.kind === 'local' || first.kind === 'head' || first.kind === 'remote')
        ? (first.local ?? first.ref)?.shortName
        : undefined;
    const firstRef = first ? (first.local ?? first.ref)?.fullName : undefined;
    rows.push(
      <GraphRow
        key={slot}
        api={rowApi}
        repoId={repoId}
        model={model}
        row={row}
        y={(row - base) * rowH}
        height={rowH}
        columns={placed}
        pills={rowPills}
        hidden={rowPills.length ? NO_PILLS : (hiddenPills.get(sha) ?? NO_PILLS)}
        color={palette.colors[model.colorAt(row) % palette.colors.length]!}
        selected={selectedShas.has(sha)}
        match={isMatch}
        activeMatch={row === search.activeRow}
        dim={filterDim && !isMatch}
        focused={row === focusRow}
        dateFormat={dateFormat}
        pillRef={firstRef ? refByName.get(firstRef) : undefined}
        stash={stashBySha.get(sha)}
        soloed={!!first && vis.solo.includes(first.fullName)}
        pr={prName ? prIndex.get(prName) : undefined}
        ghost={ghost?.row === row ? ghost.ref : null}
        wip={sha === WIP_SHA ? wipInfo : null}
        avatars={avatarsOn}
        avatarVersion={avatarVersion}
      />,
    );
  }

  // ---- "+N" popover content ----
  const popoverPills = popover ? (pills.get(model.shaAt(popover.row) ?? '') ?? []) : [];
  const popoverHidden = popover ? (hiddenPills.get(model.shaAt(popover.row) ?? '') ?? []) : [];

  // ---- tooltip content ----
  const tip =
    tooltip && tooltip.row < model.rowCount ? tooltipFor(model, tooltip.row, pills, stashBySha) : null;

  const commitsShown = loadedCommits.toLocaleString();
  return (
    <div className={styles.view}>
      <MemoSearchBar repoId={repoId} search={search} onJumpToHead={jumpToHead} extra={chips} />
      <MemoGraphHeader
        columns={placed}
        onMove={onColumnMove}
        onResize={onColumnResize}
        onAutosize={onAutosize}
        onMenu={onHeaderMenu}
      />
      {history.loading && model.rowCount > 0 && <div className={styles.progress} aria-hidden />}
      <div
        ref={scrollRef}
        className={styles.scroll}
        tabIndex={0}
        role="grid"
        aria-label="Commit graph"
        aria-rowcount={history.done ? model.rowCount : -1}
        aria-multiselectable
        onScroll={(e) => {
          const v = mappingRef.current.toVirtual(e.currentTarget.scrollTop);
          if (Math.abs(v - virtualRef.current) >= 0.5) {
            virtualRef.current = v;
            setVirtualTop(v);
          }
          if (tooltip) setTooltip(null);
        }}
        onWheel={(e) => {
          if (!e.shiftKey || maxScrollX <= 0) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const x = e.clientX - rect.left;
          if (x < graphLeft || x > graphLeft + graphWidth) return;
          setGraphScrollX(Math.max(0, Math.min(maxScrollX, scrollX + (e.deltaX || e.deltaY))));
        }}
        onKeyDown={onKeyDown}
        onMouseMove={onMouseMove}
        onMouseLeave={() => {
          setHoverRow(-1);
          setHoverTip(null);
          if (tipTimer.current) clearTimeout(tipTimer.current);
          pendingTipRow.current = -1;
          setTooltip(null);
        }}
      >
        <div className={styles.viewport} style={{ height: viewport.h }}>
          <canvas
            ref={canvasRef}
            className={styles.canvas}
            style={{ left: graphLeft, width: graphWidth, height: viewport.h }}
            aria-hidden
          />
          {maxScrollX > 0 && scrollX < maxScrollX && (
            <div
              className={styles.laneOverflow}
              style={{ left: graphLeft + graphWidth - 14, height: viewport.h }}
              title="More lanes — widen the graph column or Shift+scroll"
            />
          )}
          <div
            className={styles.rows}
            style={{
              transform: `translateY(${base * rowH - virtualTop}px)`,
              height: Math.max(0, lastRow + 1 - base) * rowH,
            }}
          >
            {rows}
          </div>
        </div>
        <div style={{ height: Math.max(0, mapping.spacerHeight - viewport.h) }} />
      </div>
      <div className={styles.footer}>
        <span>
          {history.done
            ? `${commitsShown} commits`
            : `Showing ${commitsShown}${total.data ? ` of ~${total.data.toLocaleString()}` : ''} commits`}
        </span>
        {history.error && (
          <span className={styles.footerError}>
            History incomplete —{' '}
            <button type="button" className={styles.linkBtn} onClick={props.onRetry}>
              Retry
            </button>
          </span>
        )}
        {history.loading && <span className={styles.loading}>Loading…</span>}
        {!history.done && !history.loading && (
          <>
            <button type="button" className={styles.linkBtn} onClick={() => void history.loadMore()}>
              Load more
            </button>
            <button type="button" className={styles.linkBtn} onClick={() => void loadAll()}>
              Load all
            </button>
          </>
        )}
        <button
          type="button"
          className={styles.linkBtn}
          onClick={jumpToHead}
          title="Jump to HEAD (Ctrl+Shift+0)"
        >
          <Crosshair size={12} /> HEAD
        </button>
      </div>
      {popover && (popoverPills.length > 0 || popoverHidden.length > 0) && (
        <RefsPopover x={popover.x} y={popover.y} onClose={() => setPopover(null)}>
          {popoverPills.map((p) => {
            const ri = refInfoFor(p);
            return (
              <PopoverEntry
                key={p.fullName}
                pill={p}
                drag={ri ? refTarget(ri) : undefined}
                onMenu={(x, y) => pillMenu(p, x, y)}
                onDoubleClick={() => pillCheckout(p)}
                onToggleHidden={p.kind === 'detached' || p.isCheckedOut ? undefined : () => hidePill(p)}
              />
            );
          })}
          {popoverHidden.map((p) => (
            <PopoverEntry
              key={`hidden:${p.fullName}`}
              pill={p}
              hidden
              onMenu={(x, y) => pillMenu(p, x, y)}
              onDoubleClick={() => pillCheckout(p)}
              onToggleHidden={() => p.refs.forEach((n) => hideRef(repoId, n, false))}
            />
          ))}
        </RefsPopover>
      )}
      {tooltip && tip && (
        <div
          className={styles.tooltip}
          role="tooltip"
          style={{
            left: Math.min(tooltip.x + 14, window.innerWidth - 340),
            top: Math.min(tooltip.y + 14, window.innerHeight - 140),
          }}
        >
          {tip}
        </div>
      )}
    </div>
  );
}

let measureCtx: CanvasRenderingContext2D | null | undefined;
/** Text width for column autosize. */
function measure(text: string, font = '12px system-ui, sans-serif'): number {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  if (!measureCtx) return text.length * 7;
  measureCtx.font = font;
  return measureCtx.measureText(text).width;
}

function tooltipFor(
  model: GraphModel<CommitSummary>,
  row: number,
  pills: Map<Sha, RefPill[]>,
  stashes: Map<Sha, StashEntry>,
) {
  const sha = model.shaAt(row);
  if (!sha) return null;
  if (sha === WIP_SHA) return <div>Work in progress</div>;
  const st = stashes.get(sha);
  if (st) return <div>{`stash@{${st.index}}: ${st.message}`}</div>;
  const c = model.commitAt(row);
  if (!c) return null;
  const refs = (pills.get(sha) ?? []).map((p) => p.label);
  return (
    <>
      <div className={styles.tooltipTitle}>{c.subject}</div>
      <div className="mono">{shortSha(c.sha, 10)}</div>
      <div>
        {c.authorName} &lt;{c.authorEmail}&gt;
      </div>
      <div>{fullDate(c.authorTime)}</div>
      {refs.length > 0 && <div className={styles.tooltipRefs}>{refs.join(' · ')}</div>}
    </>
  );
}

function selectionShas(sel: Selection): Set<Sha> {
  switch (sel.kind) {
    case 'commit':
    case 'stash':
      return new Set([sel.sha]);
    case 'commits':
      return new Set(sel.shas);
    case 'wip':
      return new Set([WIP_SHA]);
    default:
      return new Set();
  }
}

function selectionFor(
  model: GraphModel<CommitSummary>,
  row: number,
  stashes: Map<Sha, StashEntry>,
): Selection {
  const sha = model.shaAt(row)!;
  if (sha === WIP_SHA) return { kind: 'wip' };
  const stash = stashes.get(sha);
  if (stash) return { kind: 'stash', sha, index: stash.index };
  return { kind: 'commit', sha };
}

function focusRowOf(model: GraphModel<CommitSummary>, sel: Selection): number {
  if (sel.kind === 'wip') return 0;
  if (sel.kind === 'commit' || sel.kind === 'stash') return model.rowOf(sel.sha);
  if (sel.kind === 'commits' && sel.shas[0]) return model.rowOf(sel.shas[0]);
  return -1;
}
