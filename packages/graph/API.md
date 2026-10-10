# @githappens/graph — API

Pure TypeScript commit-graph engine for spec 04: lane layout, ancestry/ghost queries, ref-pill grouping
and a Canvas 2D renderer. No runtime dependencies, no React, no Electron, no `@githappens/git` import.
Inputs are structural, so spec 02 `CommitSummary`, `StashEntry` and `RefInfo` values can be passed as-is.

```ts
import {
  GraphModel,
  groupRefPills,
  ghostCandidates,
  createMetrics,
  drawGraph,
  hitTestNode,
  graphColumnWidth,
  visibleRowRange,
  WIP_SHA,
  NodeKind,
  EdgeKind,
  EdgeFlag,
  RowFlag,
} from '@githappens/graph';
```

## Layout: `GraphModel`

```ts
new GraphModel<C extends GraphCommitInput>(options?: GraphLayoutOptions, reuseFrom?: GraphModel<C>)
```

| Option                                     | Default         | Meaning                                                                                                                                                                                                                                    |
| ------------------------------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `headSha`                                  | `null`          | HEAD commit. Lane 0 is reserved for it, so HEAD's first-parent history is a straight line in lane 0.                                                                                                                                       |
| `pinnedTips`                               | `[]`            | User-pinned branch tips. They reserve lanes 1..k.                                                                                                                                                                                          |
| `wip`                                      | none            | `true`, or `{ kind: 'wip' \| 'conflict', parents? }`. Adds row 0 (sha `'WIP'`) in HEAD's lane with dashed edges. Parents default to `[headSha]`. A conflict row takes `[headSha, MERGE_HEAD]`.                                             |
| `stashes`                                  | `[]`            | spec 02 `StashEntry[]`. Each stash becomes a row placed at its time, always above its base. The only edge is a dashed one to `parents[0]`. The index and untracked helper commits never become rows, even if the log stream contains them. |
| `colorMode`                                | `'column'`      | `'branch'`: a color is assigned when a lane is created and is inherited down first parents (§6.3.6).                                                                                                                                       |
| `paletteSize`                              | 12              | Color indices are `< paletteSize`.                                                                                                                                                                                                         |
| `laneReuseCooldown`                        | 1               | Rows a freed lane stays unusable.                                                                                                                                                                                                          |
| `mergeLanePlacement`                       | `'right-first'` | or `'leftmost'`.                                                                                                                                                                                                                           |
| `omit`                                     | `[]`            | Commits that never become rows (hidden stashes and their helper commits).                                                                                                                                                                  |
| `checkpointInterval` / `convergenceVerify` | 1024 / 64       | Convergence reuse (§6.10).                                                                                                                                                                                                                 |

Input types:

```ts
interface GraphCommitInput {
  sha: string;
  parents: readonly string[];
  commitTime?: number;
}
interface GraphStashInput {
  sha: string;
  parents: readonly string[];
  time: number;
  index?: number;
  ref?: string;
  message?: string;
}
```

### Feeding data

- `append(commits, done = false)`: pass the next page in `git log --date-order` order (children before parents). Each row is laid out immediately in O(active lanes). Paging is invisible to the result: appending in pages produces the same layout as appending everything at once.
- `finish()`: same as `append([], true)`. It flushes stashes that are still pending and marks lines toward never-loaded parents as `Fade`.
- `reset(options, reuseFrom?)`: starts over.
- `GraphModel.rebuild(old, newOptions)`: re-lays out `old`'s commits under new options, for example to add or remove the WIP row or after HEAD moved, and reuses `old`'s unchanged tail.
- `new GraphModel(opts, oldModel)` followed by appending the new log stream: convergence reuse (§6.10). Once lane state matches an old checkpoint and the next `convergenceVerify` shas also match, the old suffix is copied, `model.converged` becomes `true` (you can cancel the git stream), and `complete` is inherited from the old model. Reuse requires the same stash list and layout options, and `colorMode: 'column'`. Never mutate `old` afterwards.

### Reading the layout

| Member                                                                                                | Notes                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`                                                                                             | Increments on every change. Use it as the redraw/memo key.                                                                                                                                                                                                                                                                                            |
| `rowCount`, `complete`, `converged`, `maxColumn`, `headSha`, `hasWipRow`                              |                                                                                                                                                                                                                                                                                                                                                       |
| `rowOf(sha)` → row or -1 · `shaAt(row)`                                                               | The WIP row's sha is `WIP_SHA` (`'WIP'`).                                                                                                                                                                                                                                                                                                             |
| `itemAt(row)`                                                                                         | The commit object you passed in, the stash, or `null` for the WIP row. `commitAt(row)` returns only commit rows. `commits()` lists all laid-out commits.                                                                                                                                                                                              |
| `columnAt`, `colorAt`, `nodeKindAt`, `flagsAt`                                                        | Backed by typed arrays. `views()` returns zero-copy subarrays.                                                                                                                                                                                                                                                                                        |
| `parentRows(row)` (-1 = not loaded), `firstParentRow(row)`, `childRows(row)`, `firstParentChild(row)` | For Shift+J/K navigation (§6.13).                                                                                                                                                                                                                                                                                                                     |
| `forEachEdge(firstGap, lastGap, (gap, from, to, kindFlags, color, owner) => …)`                       | Gap _g_ lies between rows _g_ and _g+1_. `kindFlags & 7` is an `EdgeKind` (Pass / MergeOut / BranchIn), and `EdgeFlag.Dashed` / `EdgeFlag.Fade` are flag bits. `owner` is the row whose parent link produced the line. The gap below the last row holds the lines still heading to unloaded parents. `edgesInRange` returns the same data as objects. |
| `maxColumnInRange(a, b)`                                                                              | Widest lane in rows a..b, including their edges. Pass it to `graphColumnWidth(metrics, max)` to autosize the column.                                                                                                                                                                                                                                  |
| `reachable(tipRowOrSha)` → `Uint8Array(rowCount)`                                                     | Ancestry highlight (§6.6): 1 = reachable. Cached per tip sha and `version` (LRU 32). An edge is highlighted when `rows[owner] === 1`.                                                                                                                                                                                                                 |
| `nearestBranch(row, candidatesAt, maxVisited = 5000)`                                                 | Ghost ref (§6.7): a BFS over children. Returns `{ row, ref, distance }`, `{ capped: true }` (then fall back to `graph:containingBranches`), or `null`.                                                                                                                                                                                                |

`RowFlag`: `Tip`, `Root`, `Head`, `Pinned`. `NodeKind`: `Commit`, `Merge`, `Wip`, `Stash`, `Conflict`.

Layout guarantees, checked by property tests on 10,000 random DAGs:

- Lanes never shift sideways.
- Lines never overlap in a gap.
- Every loaded parent link is drawn.
- HEAD's first-parent chain stays in lane 0.
- Stash rows sit above their base.
- Layout is deterministic, and paged layout equals one-shot layout.

Deliberate choices:

- A pinned tip keeps its reserved lane even when a newer branch reaches it first; that branch bends in.
- A merge line whose parent is the very next row goes straight into the node.
- Commits whose parent was already laid out (out-of-order input) end their line there instead of extending it forever.

## Ref pills: `groupRefPills(refs, { hidden?, detachedHeadSha?, stashes? })`

Returns `Map<sha, RefPill[]>`, already sorted: HEAD branch, local branches, remote-only branches, tags, then stashes, alphabetically within each group. Rules:

- A local branch absorbs its configured upstream (`RefInfo.upstream.fullName`, or the `GraphRef.upstream` string) when it points at the same commit. It then absorbs other `<remote>/<same name>` branches at that commit (`hasLocal && hasRemote` = combined pill).
- Hidden full names are dropped.
- These are never shown: `refs/githappens/*`, `refs/prefetch/*`, `refs/notes/*`, `refs/remotes/*/HEAD` (or anything with `symrefTarget`), and `type: 'other'`.
- `detachedHeadSha` adds a `HEAD` pill of kind `'detached'`.
- `stashes` adds `stash@{n}: message` pills on stash rows and replaces any `refs/stash` ref.

Show `pills[0]` and fold the rest into "+N". `ghostCandidates(pills)` turns a row's pills into `nearestBranch` candidates.

## Hide / Solo / Pin (`visibility.ts`)

State: `RefVisibilityState { hidden, solo, pinned }`. Hidden entries are full ref names, `refs/remotes/<r>/*`
globs (whole remote) or `stash:<sha>`.

| Function                                                  | Use                                                                                                                                                         |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `graphRevQuery(refs, vis, { headSha, stashes })`          | `{ revs: 'all' }`, `{ revs: 'all', hiddenRefs }` (git `--exclude`, symbolic `refs/remotes/*/HEAD` added) or solo `{ revs: [soloed…, 'HEAD', stash shas] }`. |
| `effectiveHidden(refs, vis)`                              | Full names whose pills are hidden (explicit + not soloed). The checked-out branch is never hidden by solo.                                                  |
| `visibleTips` / `visibleTipKey(refs, vis, head, stashes)` | Identity of the loaded commit set. Equal keys ⇒ no reload.                                                                                                  |
| `historyUnchanged(prev, next, isLoaded)`                  | Also no reload when only new tips appeared at commits that are already rows (tag / branch created at an existing commit, §6.10 case 2).                     |
| `pinnedTipShas(refs, vis)`                                | `GraphLayoutOptions.pinnedTips` (lanes 1..k after HEAD).                                                                                                    |
| `hiddenStashShas(stashes, vis)`                           | `GraphLayoutOptions.omit`.                                                                                                                                  |
| `pruneVisibility(vis, refs, stashes)`                     | Drops names that no longer exist (null = unchanged).                                                                                                        |
| `setHidden` / `setSolo` / `setPinned` / `showAll`         | Immutable updates (hiding un-solos, soloing un-hides, "Show all" keeps pins).                                                                               |
| `refVisibilityMark(fullName, refs, vis)`                  | `'visible' \| 'hidden' \| 'solo' \| 'hiddenBySolo'` for left-panel icons.                                                                                   |

## Scaled scroll (`scroll.ts`, §4.13)

`createScrollMapping(rowCount, rowHeight, viewportHeight)` returns `{ scaled, spacerHeight, toVirtual, toScroll, maxVirtualTop }`.
Up to `MAX_SCROLL_HEIGHT` (15M px) it is the identity; above, the native spacer is fixed at 15M px and offsets
are scaled linearly. `virtualTopForRow(row, rowH, viewportH, currentTop, 'center' | 'nearest', marginRows)`
computes scroll targets in virtual space, so keyboard navigation and jump-to-row work in both modes.

## Performance

Measured by `test/perf.test.ts` (Node 22, 2024 laptop; CI ceilings in parentheses). Layout runs on the renderer
main thread: pages arrive in ≤ 5,000-commit chunks (≈ 20–35 ms each even at 1M rows), so a layout worker is
not needed to keep frames responsive; `GraphModel` stays worker-safe should that change.

| Benchmark                                            | Measured                 | Threshold      |
| ---------------------------------------------------- | ------------------------ | -------------- |
| 100k commits, full layout                            | ≈ 250 ms                 | < 1,500 ms     |
| 200k commits: first 5,000-row page / full layout     | ≈ 36 / 520 ms            | < 100 / 3,000  |
| 1M commits: first page / full layout (`GRAPH_BENCH`) | ≈ 34 / 3,600 ms, ≈ 90 MB | < 100 / 15,000 |
| New commit on a 100k layout (convergence reuse)      | ≈ 110 ms                 | < 300 ms       |
| Regroup 10k refs into pills (ref-only change)        | ≈ 45 ms                  | < 150 ms       |
| Draw one 1200 px frame, 100k rows                    | ≈ 0.2 ms                 | < 8 ms         |

The 1M benchmark is skipped when `CI` is set unless `GRAPH_BENCH=1`; `GRAPH_BENCH=0` skips it locally.

## Rendering

```ts
const metrics = createMetrics(compact ? 'compact' : 'normal', { zoom, edgeStyle: 'rounded' | 'bezier' });
const res = drawGraph(ctx, model, {
  scrollTop, // virtual px of the viewport top (pass virtualTop in scaled-scroll mode, §4.13)
  width,
  height,
  dpr, // viewport CSS size; canvas backing store = size × dpr
  scrollX, // horizontal pan of the graph column
  metrics,
  colors, // lane palette (theme, 10–12 hues): colorIndex % colors.length
  nodeColors, // { background, accent, conflict, stash, stashBorder, hover, initialsText, transparent, wip? }
  selected, // ReadonlySet<sha | 'WIP'>
  highlight, // model.reachable(tip) or Set<row> | null → others drawn at 30% alpha
  dimmed, // Set<row> | (row) => boolean (search filter, dim merges)
  headSha,
  hoverRow,
  avatars: (sha, row) => bitmap | null, // ready ImageBitmap/HTMLImageElement (else initials are drawn)
  initials: (sha, row) => ({ text, color }) | null,
});
// res: { firstRow, lastRow, edgeCount, nodeCount, hiddenLanes } — show "N more lanes" when hiddenLanes > 0
```

`drawGraph` draws only `visibleRowRange(...)`, which is the visible rows ±1. It draws relative to the first drawn row, groups strokes by (color, dashed, dim state) so each group needs one `stroke()`, then draws nodes, then the overflow fade. A fade edge's gradient ends in `nodeColors.transparent`.

`hitTestNode(model, metrics, x, y, { scrollTop, scrollX })` returns `{ row, sha, kind }` or `null`. Coordinates are canvas-local CSS px. Leave out `scrollTop` to pass absolute content coordinates. A hit counts within `nodeRadius + hitSlop`. `rowAtY(rowCount, metrics, y, scrollTop)` is the whole-row hit used for selection.

## Integration sketch (React)

```tsx
function GraphCanvas({ model, palette, selected, highlightTip, compact }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const metrics = useMemo(() => createMetrics(compact ? 'compact' : 'normal'), [compact]);
  const frame = useRef(0);

  const draw = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const el = scrollRef.current!,
        canvas = canvasRef.current!;
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth,
        h = el.clientHeight;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      drawGraph(canvas.getContext('2d')!, model, {
        scrollTop: el.scrollTop,
        width: w,
        height: h,
        dpr,
        metrics,
        colors: palette,
        selected,
        highlight: highlightTip ? model.reachable(highlightTip) : null,
        avatars: (sha) => avatarCache.get(model.commitAt(model.rowOf(sha))?.authorEmail),
      });
    });
  }, [model, model.version, metrics, palette, selected, highlightTip]);

  useLayoutEffect(draw, [draw]);
  useEffect(() => {
    const ro = new ResizeObserver(draw);
    ro.observe(scrollRef.current!);
    return () => ro.disconnect();
  }, [draw]);

  return (
    <div ref={scrollRef} onScroll={draw} style={{ overflowY: 'auto', height: '100%' }}>
      {/* canvas covers only the viewport and stays pinned while the content scrolls */}
      <canvas
        ref={canvasRef}
        style={{ position: 'sticky', top: 0, display: 'block', width: graphWidth, height: '100%' }}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const hit = hitTestNode(model, metrics, e.clientX - r.left, e.clientY - r.top, {
            scrollTop: scrollRef.current!.scrollTop,
          });
          /* select hit?.sha (or rowAtY(...) for whole-row clicks) */
        }}
      />
      {/* spacer: total scroll height = rowCount × rowHeight */}
      <div style={{ height: `calc(${model.rowCount * metrics.rowHeight}px - 100%)` }} />
    </div>
  );
}
```

What the desktop provides:

1. **Session start (`graph:open`):** `new GraphModel({ headSha, pinnedTips, wip: head.wip ? true : null (or a conflict row), stashes }, previousModel?)`. Pass the previous model when refreshing so the unchanged tail is reused.
2. **Each `graph:chunk`:** call `model.append(commits, done)` with the `RawCommit[]` as-is, then redraw (key on `model.version`). Raise `"Loading more…"` and `loadMore` until `model.complete`.
3. **WIP appears or disappears, or HEAD moves to a commit that is already loaded:** `model = GraphModel.rebuild(model, newOptions)`.
4. **Refs changed:** `groupRefPills(refs, { hidden, detachedHeadSha, stashes })` → pills per sha, then look rows up with `model.rowOf(sha)`. A ref-only change needs no relayout.
5. **Hover on a pill:** `model.reachable(pill.sha)` gives the highlight (rows and edges). Debounce it by 60 ms.
6. **Ghost pill:** `model.nearestBranch(row, (r) => ghostCandidates(pillsBySha.get(model.shaAt(r)!)))`.
7. **Autosize the graph column:** `graphColumnWidth(metrics, model.maxColumnInRange(firstVisible, lastVisible))`.

The model is plain data plus typed arrays. It can run inside a layout worker, with only queries crossing the worker boundary, but it also runs on the main thread: about 0.25 s per 100k commits.
