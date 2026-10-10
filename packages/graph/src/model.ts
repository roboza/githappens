/**
 * Incremental lane layout + renderer-side graph model (spec 04 §5.2, §6.3, §6.4, §6.6, §6.7, §6.10).
 *
 * Pure TypeScript, no DOM. Rows are appended in `git log --date-order` order (children before
 * parents); each row is laid out as soon as it arrives, in O(active lanes).
 */
import { grow } from './typed';
import {
  EdgeFlag,
  EdgeKind,
  NodeKind,
  RowFlag,
  WIP_SHA,
  type EdgeVisitor,
  type GraphCommitInput,
  type GraphEdge,
  type GraphLayoutOptions,
  type GraphStashInput,
  type Sha,
  type WipRowOptions,
} from './types';

interface Slot {
  /** Commit this line is heading to. */
  expect: Sha;
  /** Created by a first-parent edge. */
  fp: boolean;
  color: number;
  /** Pin rank (0 = HEAD lane); NO_PIN when not pinned. Inherited down first-parent edges. */
  pin: number;
  /** Row that created the expectation. */
  owner: number;
  dashed: boolean;
}

interface PendingMerge {
  from: number;
  to: number;
  color: number;
  owner: number;
  dashed: boolean;
  /** The merge allocated lane `to` (so its Pass edge in this gap is redundant). */
  created: boolean;
}

const RESERVED = Object.freeze({ reserved: true as const });
type LaneCell = Slot | typeof RESERVED | null | undefined;
const NO_PIN = 0xffff;
const isSlot = (c: LaneCell): c is Slot => c !== null && c !== undefined && c !== RESERVED;

export type GraphRowItem<C> = C | GraphStashInput | null;

/** Candidate ref for the ghost-branch search (§6.7). */
export interface GhostCandidate {
  name: string;
  fullName?: string;
  /** Remote-tracking branch (ranked after local branches). */
  remote?: boolean;
  /** The checked-out branch. */
  head?: boolean;
}

export type GhostResult = { row: number; ref: GhostCandidate; distance: number } | { capped: true } | null;

interface ReuseState<C extends GraphCommitInput> {
  old: GraphModel<C>;
  cand: { old: number; matched: number } | null;
}

interface ResolvedOptions {
  headSha: Sha | null;
  pinnedTips: readonly Sha[];
  wip: WipRowOptions | null;
  stashes: readonly GraphStashInput[];
  colorMode: 'column' | 'branch';
  paletteSize: number;
  cooldown: number;
  rightFirst: boolean;
  interval: number;
  verify: number;
  omit: readonly Sha[];
}

function resolve(o: GraphLayoutOptions): ResolvedOptions {
  const wip = o.wip ? (o.wip === true ? {} : o.wip) : null;
  return {
    headSha: o.headSha ?? null,
    pinnedTips: o.pinnedTips ?? [],
    wip,
    stashes: o.stashes ?? [],
    colorMode: o.colorMode ?? 'column',
    paletteSize: Math.max(1, Math.min(256, o.paletteSize ?? 12)),
    cooldown: Math.max(0, o.laneReuseCooldown ?? 1),
    rightFirst: (o.mergeLanePlacement ?? 'right-first') === 'right-first',
    interval: Math.max(1, o.checkpointInterval ?? 1024),
    verify: Math.max(1, o.convergenceVerify ?? 64),
    omit: o.omit ?? [],
  };
}

function dedupe(parents: readonly Sha[], self: Sha): Sha[] {
  const out: Sha[] = [];
  for (const p of parents) if (p !== self && !out.includes(p)) out.push(p);
  return out;
}

/**
 * The graph model: per-row typed arrays (column, color, node kind, flags), per-gap edges in CSR form,
 * parent links, plus the live lane state so more pages can be appended.
 *
 * Row `i` is in display order; row 0 is the WIP / conflict row when enabled.
 */
export class GraphModel<C extends GraphCommitInput = GraphCommitInput> {
  private o!: ResolvedOptions;
  private n = 0;
  private _version = 0;
  private _complete = false;
  private _converged = false;
  private _maxColumn = -1;

  private shas: Sha[] = [];
  private rowIndex = new Map<Sha, number>();
  private items: GraphRowItem<C>[] = [];

  private col = new Uint16Array(64);
  private colorArr = new Uint8Array(64);
  private kindArr = new Uint8Array(64);
  private flagArr = new Uint8Array(64);
  /** Widest column touched by row r's node or the edges of gaps r-1 and r. */
  private rowMax = new Uint16Array(64);

  private parentStart = new Uint32Array(65);
  private parentRowArr = new Int32Array(64);
  private parentLen = 0;
  /** parent sha → indices into parentRowArr waiting for that row. */
  private pendingParents = new Map<Sha, number[]>();

  /** gapStart[g]..gapStart[g+1] are the edges of gap g (between rows g and g+1). */
  private gapStart = new Uint32Array(65);
  private eFrom = new Uint16Array(256);
  private eTo = new Uint16Array(256);
  private eKind = new Uint8Array(256);
  private eColor = new Uint8Array(256);
  private eOwner = new Int32Array(256);
  private edgeLen = 0;

  // ---- live lane state (§6.3.2) ----
  private lanes: LaneCell[] = [];
  private waiting = new Map<Sha, number[]>();
  private freedAt: number[] = [];
  private reserved = new Map<Sha, number>();
  private pendingMergeOut: PendingMerge[] = [];
  private stashQueue: GraphStashInput[] = [];
  private skip = new Set<Sha>();
  private colorUse = new Int32Array(0);
  private colorFreed = new Float64Array(0);

  // ---- convergence reuse (§6.10) ----
  private checkpoints = new Map<number, string>();
  private reuse: ReuseState<C> | null = null;

  // ---- caches ----
  private openGapCache: { version: number; edges: number[] } | null = null;
  private childCache: { version: number; start: Uint32Array; rows: Int32Array } | null = null;
  private reachCache = new Map<Sha, { version: number; rows: Uint8Array }>();

  constructor(options: GraphLayoutOptions = {}, reuseFrom?: GraphModel<C>) {
    this.reset(options, reuseFrom);
  }

  /**
   * Re-lays out `old`'s loaded commits under new options (e.g. WIP row added/removed, HEAD moved),
   * adopting `old`'s unchanged tail via convergence reuse (§6.10).
   */
  static rebuild<C extends GraphCommitInput>(old: GraphModel<C>, options: GraphLayoutOptions): GraphModel<C> {
    const m = new GraphModel<C>(options, old);
    m.append(old.commits(), old.complete);
    return m;
  }

  // ------------------------------------------------------------------ public: lifecycle

  /**
   * Clears the model and starts a new layout. When `reuseFrom` is given (the previous model of the same
   * repo, left untouched afterwards), rows whose lane state converges with it are copied instead of
   * recomputed (§6.10). Reuse requires the same stash list and layout options and `colorMode: 'column'`.
   */
  reset(options: GraphLayoutOptions = {}, reuseFrom?: GraphModel<C>): void {
    const o = resolve(options);
    this.o = o;
    this.n = 0;
    this._complete = false;
    this._converged = false;
    this._maxColumn = -1;
    this.shas = [];
    this.rowIndex = new Map();
    this.items = [];
    this.parentLen = 0;
    this.parentStart[0] = 0;
    this.pendingParents = new Map();
    this.edgeLen = 0;
    this.gapStart[0] = 0;
    this.lanes = [];
    this.waiting = new Map();
    this.freedAt = [];
    this.reserved = new Map();
    this.pendingMergeOut = [];
    this.checkpoints = new Map();
    this.openGapCache = null;
    this.childCache = null;
    this.reachCache = new Map();
    this.colorUse = new Int32Array(o.paletteSize);
    this.colorFreed = new Float64Array(o.paletteSize).fill(-1);

    const tips: Sha[] = [];
    for (const t of [o.headSha, ...o.pinnedTips]) if (t && !tips.includes(t)) tips.push(t);
    tips.forEach((sha, i) => {
      this.reserved.set(sha, i);
      this.lanes[i] = RESERVED;
    });

    const seen = new Set<Sha>();
    const stashes = o.stashes.filter((s) => !seen.has(s.sha) && !!seen.add(s.sha));
    this.stashQueue = stashes.sort(
      (a, b) => b.time - a.time || (a.index ?? 0) - (b.index ?? 0) || (a.sha < b.sha ? -1 : 1),
    );
    this.skip = new Set(o.omit);
    for (const s of stashes) {
      this.skip.add(s.sha);
      for (const p of s.parents.slice(1)) this.skip.add(p);
    }

    this.reuse = reuseFrom && this.compatible(reuseFrom) ? { old: reuseFrom, cand: null } : null;

    if (o.wip) {
      const parents = o.wip.parents ?? (o.headSha ? [o.headSha] : []);
      this.row(WIP_SHA, parents, o.wip.kind === 'conflict' ? NodeKind.Conflict : NodeKind.Wip, null);
    }
    this._version++;
  }

  /**
   * Appends the next page of commits (date order: children before parents). `done` marks the end of
   * history: pending stash rows are flushed and lines toward never-loaded parents fade out.
   */
  append(commits: readonly C[], done = false): void {
    for (const c of commits) {
      if (this.rowIndex.has(c.sha) || this.skip.has(c.sha)) continue;
      if (this.stashQueue.length) this.flushStashes(c);
      this.row(c.sha, c.parents, NodeKind.Commit, c);
    }
    if (done) {
      while (this.stashQueue.length) this.layoutStash(this.stashQueue.shift()!);
      this._complete = true;
    }
    this._version++;
  }

  /** Marks history complete (same as `append([], true)`). */
  finish(): void {
    this.append([], true);
  }

  // ------------------------------------------------------------------ public: accessors

  /** Bumps on every change; use it to invalidate renderer-side caches. */
  get version(): number {
    return this._version;
  }
  get rowCount(): number {
    return this.n;
  }
  /** True once `append(…, true)` was called (or a converged old model was complete). */
  get complete(): boolean {
    return this._complete;
  }
  /** True when the tail of a previous model was adopted (§6.10); the caller may cancel its log stream. */
  get converged(): boolean {
    return this._converged;
  }
  /** Widest column used by any row or edge (-1 when empty). */
  get maxColumn(): number {
    return Math.max(this._maxColumn, this.openGapMax());
  }
  get headSha(): Sha | null {
    return this.o.headSha;
  }
  get hasWipRow(): boolean {
    return this.n > 0 && this.shas[0] === WIP_SHA;
  }

  rowOf(sha: Sha): number {
    return this.rowIndex.get(sha) ?? -1;
  }
  shaAt(row: number): Sha | undefined {
    return this.shas[row];
  }
  /** The input object of a row: the commit, the stash, or `null` for the WIP / conflict row. */
  itemAt(row: number): GraphRowItem<C> | undefined {
    return this.items[row];
  }
  commitAt(row: number): C | undefined {
    const k = this.kindArr[row];
    return row < this.n && (k === NodeKind.Commit || k === NodeKind.Merge)
      ? (this.items[row] as C)
      : undefined;
  }
  /** All laid-out commits (no WIP / stash rows) in row order. */
  commits(): C[] {
    const out: C[] = [];
    for (let r = 0; r < this.n; r++) {
      const k = this.kindArr[r];
      if (k === NodeKind.Commit || k === NodeKind.Merge) out.push(this.items[r] as C);
    }
    return out;
  }
  columnAt(row: number): number {
    return this.col[row] ?? 0;
  }
  colorAt(row: number): number {
    return this.colorArr[row] ?? 0;
  }
  nodeKindAt(row: number): NodeKind {
    return (this.kindArr[row] ?? 0) as NodeKind;
  }
  flagsAt(row: number): number {
    return this.flagArr[row] ?? 0;
  }
  /** Zero-copy views of the per-row arrays (valid until the next append/reset). */
  views(): { column: Uint16Array; color: Uint8Array; nodeKind: Uint8Array; flags: Uint8Array } {
    return {
      column: this.col.subarray(0, this.n),
      color: this.colorArr.subarray(0, this.n),
      nodeKind: this.kindArr.subarray(0, this.n),
      flags: this.flagArr.subarray(0, this.n),
    };
  }
  /** Parent rows of `row` in parent order; -1 = parent not loaded. */
  parentRows(row: number): number[] {
    if (row < 0 || row >= this.n) return [];
    return Array.from(this.parentRowArr.subarray(this.parentStart[row], this.parentStart[row + 1]));
  }
  firstParentRow(row: number): number {
    if (row < 0 || row >= this.n || this.parentStart[row] === this.parentStart[row + 1]) return -1;
    return this.parentRowArr[this.parentStart[row]!]!;
  }
  /** Loaded children of `row` (ascending). Built lazily per version. */
  childRows(row: number): number[] {
    if (row < 0 || row >= this.n) return [];
    const c = this.children();
    return Array.from(c.rows.subarray(c.start[row], c.start[row + 1]));
  }

  /**
   * Shift+K target (§6.13): the nearest loaded row above `row` whose first parent is `row`
   * (-1 when none, e.g. a branch tip).
   */
  firstParentChild(row: number): number {
    if (row < 0 || row >= this.n) return -1;
    const c = this.children();
    let best = -1;
    for (let k = c.start[row]!, end = c.start[row + 1]!; k < end; k++) {
      const ch = c.rows[k]!;
      if (ch > best && this.firstParentRow(ch) === row) best = ch;
    }
    return best;
  }

  /** Widest column in rows `[a, b]` including the edges touching them (for autosizing, §4.2). */
  maxColumnInRange(a: number, b: number): number {
    const lo = Math.max(0, Math.floor(a));
    const hi = Math.min(this.n - 1, Math.floor(b));
    let m = -1;
    for (let r = lo; r <= hi; r++) if (this.rowMax[r]! > m) m = this.rowMax[r]!;
    if (hi === this.n - 1 && hi >= lo) m = Math.max(m, this.openGapMax());
    return m;
  }

  /**
   * Visits the edges of gaps `[firstGap, lastGap]` (gap g lies between rows g and g+1). The last
   * row's gap is the "open" gap: lines continuing toward parents not loaded yet (flagged Fade once
   * the history is complete).
   */
  forEachEdge(firstGap: number, lastGap: number, visit: EdgeVisitor): void {
    const lo = Math.max(0, firstGap);
    const hi = Math.min(this.n - 1, lastGap);
    for (let g = lo; g <= hi; g++) {
      if (g < this.n - 1) {
        for (let e = this.gapStart[g]!, end = this.gapStart[g + 1]!; e < end; e++) {
          visit(g, this.eFrom[e]!, this.eTo[e]!, this.eKind[e]!, this.eColor[e]!, this.eOwner[e]!);
        }
      } else {
        const og = this.openGap();
        for (let i = 0; i < og.length; i += 5)
          visit(g, og[i]!, og[i + 1]!, og[i + 2]!, og[i + 3]!, og[i + 4]!);
      }
    }
  }

  /** Convenience object form of `forEachEdge` (allocates; prefer `forEachEdge` in hot paths). */
  edgesInRange(firstGap: number, lastGap: number): GraphEdge[] {
    const out: GraphEdge[] = [];
    this.forEachEdge(firstGap, lastGap, (gap, from, to, kf, color, owner) =>
      out.push({
        gap,
        from,
        to,
        kind: (kf & 7) as GraphEdge['kind'],
        dashed: (kf & EdgeFlag.Dashed) !== 0,
        fade: (kf & EdgeFlag.Fade) !== 0,
        color,
        owner,
      }),
    );
    return out;
  }

  // ------------------------------------------------------------------ public: ancestry & ghost

  /**
   * Rows reachable from `tip` (row index or sha) among loaded rows: `rows[r] === 1` (§6.6).
   * Cached per tip sha and model version (LRU of 32). An edge is highlighted when `rows[owner] === 1`.
   */
  reachable(tip: number | Sha): Uint8Array {
    const row = typeof tip === 'number' ? tip : this.rowOf(tip);
    if (row < 0 || row >= this.n) return new Uint8Array(this.n);
    const key = this.shas[row]!;
    const hit = this.reachCache.get(key);
    if (hit && hit.version === this._version) {
      this.reachCache.delete(key);
      this.reachCache.set(key, hit);
      return hit.rows;
    }
    const mark = new Uint8Array(this.n);
    const stack = new Int32Array(this.n);
    let sp = 0;
    mark[row] = 1;
    stack[sp++] = row;
    while (sp > 0) {
      const r = stack[--sp]!;
      for (let k = this.parentStart[r]!, end = this.parentStart[r + 1]!; k < end; k++) {
        const p = this.parentRowArr[k]!;
        if (p >= 0 && mark[p] === 0) {
          mark[p] = 1;
          stack[sp++] = p;
        }
      }
    }
    this.reachCache.set(key, { version: this._version, rows: mark });
    if (this.reachCache.size > 32) this.reachCache.delete(this.reachCache.keys().next().value!);
    return mark;
  }

  /**
   * Ghost branch (§6.7): BFS upward over children from `row` (inclusive) to the nearest row carrying a
   * branch. Ties at equal distance: local before remote, HEAD branch first, then alphabetical.
   * Returns `{ capped: true }` after visiting `maxVisited` rows (caller falls back to
   * `git branch --contains`).
   */
  nearestBranch(
    row: number,
    candidatesAt: (row: number) => readonly GhostCandidate[] | null | undefined,
    maxVisited = 5000,
  ): GhostResult {
    if (row < 0 || row >= this.n) return null;
    const ch = this.children();
    const seen = new Uint8Array(this.n);
    let level = [row];
    seen[row] = 1;
    let visited = 1;
    for (let dist = 0; level.length; dist++) {
      let best: { row: number; ref: GhostCandidate } | null = null;
      for (const r of level) {
        for (const c of candidatesAt(r) ?? []) {
          if (!best || compareGhost(c, best.ref) < 0) best = { row: r, ref: c };
        }
      }
      if (best) return { ...best, distance: dist };
      const next: number[] = [];
      for (const r of level) {
        for (let k = ch.start[r]!, end = ch.start[r + 1]!; k < end; k++) {
          const c = ch.rows[k]!;
          if (seen[c]) continue;
          seen[c] = 1;
          if (++visited > maxVisited) return { capped: true };
          next.push(c);
        }
      }
      level = next;
    }
    return null;
  }

  // ------------------------------------------------------------------ layout core (§6.3.3)

  private row(sha: Sha, parents: readonly Sha[], kind: NodeKind, item: GraphRowItem<C>): void {
    if (this.rowIndex.has(sha)) return;
    if (this.reuse && this.tryAdopt(sha)) return;
    this.layoutRow(sha, parents, kind, item);
    if (this.reuse?.cand) this.reuse.cand.matched++;
  }

  private layoutRow(sha: Sha, rawParents: readonly Sha[], kind: NodeKind, item: GraphRowItem<C>): void {
    const r = this.n;
    const o = this.o;
    if (r % o.interval === 0 && o.colorMode === 'column') this.checkpoints.set(r, this.stateKey(sha));
    const parents = dedupe(rawParents, sha);
    const synthetic = kind === NodeKind.Wip || kind === NodeKind.Conflict;
    const dashed = synthetic || kind === NodeKind.Stash;
    let flags = 0;

    // 1) choose the column
    const W = this.waiting.get(sha);
    let resKey: Sha = sha;
    let res = this.reserved.get(sha);
    if (res === undefined && synthetic && parents.length > 0) {
      // WIP lands in HEAD's reserved lane and takes over the reservation (§6.3.3 init).
      resKey = parents[0]!;
      res = this.reserved.get(resKey);
    }
    if (res !== undefined && W && W.some((i) => (this.lanes[i] as Slot).pin < res!)) {
      // A higher-priority pinned line (e.g. HEAD's) already reaches this pinned tip: it keeps going
      // straight and the lower-priority reservation is dropped.
      this.reserved.delete(resKey);
      if (!isSlot(this.lanes[res])) this.lanes[res] = null;
      res = undefined;
    }
    let col: number;
    let color: number;
    let pin = NO_PIN;
    if (res !== undefined) {
      // Pinned tips keep their reserved lane even if a loaded child expects them (other lines bend in),
      // so HEAD's first-parent history is always lane 0 (§9).
      this.reserved.delete(resKey);
      col = res;
      this.lanes[col] = null;
      pin = res;
      color = this.acquireColor(col);
      flags |= RowFlag.Pinned;
      if (!W) flags |= RowFlag.Tip;
    } else if (W) {
      col = this.pick(W);
      const s = this.lanes[col] as Slot;
      pin = s.pin;
      color = s.color;
      if (pin !== NO_PIN) flags |= RowFlag.Pinned;
    } else {
      col = this.allocate(r, -1);
      color = this.acquireColor(col);
      flags |= RowFlag.Tip;
    }

    // 2) edges of gap r-1 (lines arriving at row r)
    let rowMax = col;
    if (r > 0) {
      const pm = this.pendingMergeOut;
      let gmax = -1;
      const lanes = this.lanes;
      // Lanes opened by the merge on the previous row: their vertical part is drawn by the MergeOut.
      let created: number[] | null = null;
      let skip: number[] | null = null;
      for (const m of pm) {
        if (m.created) (created ??= []).push(m.to);
        const s = lanes[m.to];
        if (m.to !== col && isSlot(s) && s.expect === sha) {
          // The merge parent is this very row but the node sits in another column: route the
          // merge line straight into the node instead of into a lane that bends away.
          if (m.created) (skip ??= []).push(m.to);
          m.to = col;
        }
      }
      for (let i = 0; i < lanes.length; i++) {
        const s = lanes[i];
        if (!isSlot(s)) continue;
        if (skip?.includes(i)) continue;
        const df = s.dashed ? EdgeFlag.Dashed : 0;
        if (s.expect === sha && i !== col) {
          this.pushEdge(i, col, EdgeKind.BranchIn | df, s.color, s.owner);
        } else if (!created?.includes(i)) {
          this.pushEdge(i, i, EdgeKind.Pass | df, s.color, s.owner);
        }
        if (i > gmax) gmax = i;
      }
      for (const m of pm) {
        this.pushEdge(m.from, m.to, EdgeKind.MergeOut | (m.dashed ? EdgeFlag.Dashed : 0), m.color, m.owner);
        gmax = Math.max(gmax, m.from, m.to);
      }
      this.closeGap(r - 1, gmax);
      rowMax = Math.max(rowMax, gmax);
      this.pendingMergeOut = [];
    }

    // 3) lines that end at this node (all of W except col)
    if (W) {
      for (const i of W) {
        if (i === col) continue;
        this.releaseColor((this.lanes[i] as Slot).color, r);
        this.lanes[i] = null;
        this.freedAt[i] = r;
      }
      this.waiting.delete(sha);
    }

    // 4) first parent continues in col
    const p0 = parents[0];
    if (p0 === undefined || this.rowIndex.has(p0)) {
      // root (or out-of-order parent that is already laid out): the line ends here
      this.lanes[col] = null;
      this.freedAt[col] = r;
      this.releaseColor(color, r);
      if (p0 === undefined) flags |= RowFlag.Root;
    } else {
      this.setExpect(col, p0, true, color, pin, r, dashed);
    }

    // 5) additional parents (merges, octopus)
    for (let k = 1; k < parents.length; k++) {
      const p = parents[k]!;
      if (this.rowIndex.has(p)) continue;
      const ws = this.waiting.get(p);
      if (ws && ws.length) {
        const j = Math.min(...ws);
        this.pendingMergeOut.push({
          from: col,
          to: j,
          color: (this.lanes[j] as Slot).color,
          owner: r,
          dashed,
          created: false,
        });
      } else {
        const lane = this.allocate(r, col);
        const c = this.acquireColor(lane);
        this.setExpect(lane, p, false, c, NO_PIN, r, dashed);
        this.pendingMergeOut.push({ from: col, to: lane, color: c, owner: r, dashed, created: true });
      }
    }

    // 6) trim trailing free lanes so the width shrinks when branches end
    const lanes = this.lanes;
    while (lanes.length > 0 && (lanes[lanes.length - 1] === null || lanes[lanes.length - 1] === undefined)) {
      lanes.pop();
    }

    // record the row
    if (kind === NodeKind.Commit && parents.length > 1) kind = NodeKind.Merge;
    if (sha === o.headSha) flags |= RowFlag.Head;
    this.ensureRows(r + 1);
    this.col[r] = col;
    this.colorArr[r] = color;
    this.kindArr[r] = kind;
    this.flagArr[r] = flags;
    this.rowMax[r] = rowMax;
    if (rowMax > this._maxColumn) this._maxColumn = rowMax;

    this.parentRowArr = grow(this.parentRowArr, this.parentLen + parents.length);
    for (const p of parents) {
      const pr = this.rowIndex.get(p);
      if (pr === undefined) {
        const list = this.pendingParents.get(p);
        if (list) list.push(this.parentLen);
        else this.pendingParents.set(p, [this.parentLen]);
        this.parentRowArr[this.parentLen++] = -1;
      } else {
        this.parentRowArr[this.parentLen++] = pr;
      }
    }
    this.parentStart[r + 1] = this.parentLen;
    const waiters = this.pendingParents.get(sha);
    if (waiters) {
      for (const idx of waiters) this.parentRowArr[idx] = r;
      this.pendingParents.delete(sha);
    }

    this.rowIndex.set(sha, r);
    this.shas.push(sha);
    this.items.push(item);
    this.n = r + 1;
  }

  private layoutStash(s: GraphStashInput): void {
    const base = s.parents[0];
    this.row(s.sha, base === undefined ? [] : [base], NodeKind.Stash, s);
  }

  /** §6.4: emit stashes newer than `c`, and stashes based on `c`, right before `c`. */
  private flushStashes(c: C): void {
    const t = c.commitTime;
    const due: GraphStashInput[] = [];
    this.stashQueue = this.stashQueue.filter((s) => {
      const hit = (t !== undefined && s.time > t) || s.parents[0] === c.sha;
      if (hit) due.push(s);
      return !hit;
    });
    for (const s of due) this.layoutStash(s);
  }

  /** pickContinuation (§6.3.3): first-parent lanes first, then pinned, then leftmost. */
  private pick(W: number[]): number {
    let best = -1;
    let bFp = false;
    let bPin = 0;
    for (const i of W) {
      const s = this.lanes[i] as Slot;
      if (best < 0 || (s.fp && !bFp) || (s.fp === bFp && (s.pin < bPin || (s.pin === bPin && i < best)))) {
        best = i;
        bFp = s.fp;
        bPin = s.pin;
      }
    }
    return best;
  }

  private isFree(i: number, r: number): boolean {
    const c = this.lanes[i];
    if (c !== null && c !== undefined) return false;
    const f = this.freedAt[i];
    return f === undefined || r - f > this.o.cooldown;
  }

  private allocate(r: number, near: number): number {
    if (near >= 0 && this.o.rightFirst) {
      for (let i = near + 1; ; i++) if (this.isFree(i, r)) return i;
    }
    for (let i = 0; ; i++) if (this.isFree(i, r)) return i;
  }

  private setExpect(
    i: number,
    sha: Sha,
    fp: boolean,
    color: number,
    pin: number,
    owner: number,
    dashed: boolean,
  ) {
    this.lanes[i] = { expect: sha, fp, color, pin, owner, dashed };
    const w = this.waiting.get(sha);
    if (w) w.push(i);
    else this.waiting.set(sha, [i]);
  }

  private acquireColor(lane: number): number {
    const P = this.o.paletteSize;
    if (this.o.colorMode === 'column') return lane % P;
    // 'branch' (§6.3.6): least-used, then least-recently-freed palette index
    let best = 0;
    for (let i = 1; i < P; i++) {
      const u = this.colorUse[i]!;
      const bu = this.colorUse[best]!;
      if (u < bu || (u === bu && this.colorFreed[i]! < this.colorFreed[best]!)) best = i;
    }
    this.colorUse[best]!++;
    return best;
  }

  private releaseColor(color: number, r: number): void {
    if (this.o.colorMode === 'column') return;
    if (this.colorUse[color]! > 0) this.colorUse[color]!--;
    this.colorFreed[color] = r;
  }

  private pushEdge(from: number, to: number, kindFlags: number, color: number, owner: number): void {
    const e = this.edgeLen;
    if (e >= this.eFrom.length) {
      const need = e + 1;
      this.eFrom = grow(this.eFrom, need);
      this.eTo = grow(this.eTo, need);
      this.eKind = grow(this.eKind, need);
      this.eColor = grow(this.eColor, need);
      this.eOwner = grow(this.eOwner, need);
    }
    this.eFrom[e] = from;
    this.eTo[e] = to;
    this.eKind[e] = kindFlags;
    this.eColor[e] = color;
    this.eOwner[e] = owner;
    this.edgeLen = e + 1;
  }

  private closeGap(g: number, gmax: number): void {
    this.gapStart = grow(this.gapStart, g + 2);
    this.gapStart[g + 1] = this.edgeLen;
    if (gmax > this.rowMax[g]!) this.rowMax[g] = gmax;
    if (gmax > this._maxColumn) this._maxColumn = gmax;
  }

  private ensureRows(need: number): void {
    this.col = grow(this.col, need);
    this.colorArr = grow(this.colorArr, need);
    this.kindArr = grow(this.kindArr, need);
    this.flagArr = grow(this.flagArr, need);
    this.rowMax = grow(this.rowMax, need);
    this.parentStart = grow(this.parentStart, need + 1);
  }

  /** Edges below the last row, derived from the live lane state: [from, to, kindFlags, color, owner]*. */
  private openGap(): number[] {
    if (this.openGapCache && this.openGapCache.version === this._version) return this.openGapCache.edges;
    const out: number[] = [];
    const fade = this._complete ? EdgeFlag.Fade : 0;
    const pm = this.pendingMergeOut;
    this.lanes.forEach((s, i) => {
      if (!isSlot(s) || pm.some((m) => m.created && m.to === i)) return;
      out.push(i, i, EdgeKind.Pass | fade | (s.dashed ? EdgeFlag.Dashed : 0), s.color, s.owner);
    });
    for (const m of pm) {
      out.push(m.from, m.to, EdgeKind.MergeOut | fade | (m.dashed ? EdgeFlag.Dashed : 0), m.color, m.owner);
    }
    this.openGapCache = { version: this._version, edges: out };
    return out;
  }

  private openGapMax(): number {
    if (this.n === 0) return -1;
    const og = this.openGap();
    let m = -1;
    for (let i = 0; i < og.length; i += 5) m = Math.max(m, og[i]!, og[i + 1]!);
    return m;
  }

  private children(): { start: Uint32Array; rows: Int32Array } {
    if (this.childCache && this.childCache.version === this._version) return this.childCache;
    const n = this.n;
    const start = new Uint32Array(n + 1);
    for (let k = 0; k < this.parentLen; k++) {
      const p = this.parentRowArr[k]!;
      if (p >= 0) start[p + 1]!++;
    }
    for (let i = 0; i < n; i++) start[i + 1]! += start[i]!;
    const fill = start.slice(0, n);
    const rows = new Int32Array(start[n]!);
    for (let r = 0; r < n; r++) {
      for (let k = this.parentStart[r]!, end = this.parentStart[r + 1]!; k < end; k++) {
        const p = this.parentRowArr[k]!;
        if (p >= 0) rows[fill[p]!++] = r;
      }
    }
    this.childCache = { version: this._version, start, rows };
    return this.childCache;
  }

  // ------------------------------------------------------------------ convergence reuse (§6.10)

  private compatible(old: GraphModel<C>): boolean {
    const a = this.o;
    const b = old.o;
    if (a.colorMode !== 'column' || b.colorMode !== 'column') return false;
    if (a.paletteSize !== b.paletteSize || a.cooldown !== b.cooldown || a.rightFirst !== b.rightFirst)
      return false;
    if (a.interval !== b.interval) return false;
    if ([...a.omit].sort().join(',') !== [...b.omit].sort().join(',')) return false;
    const key = (s: readonly GraphStashInput[]) =>
      s.map((x) => `${x.sha}:${x.time}:${x.parents[0] ?? ''}`).join(',');
    return key(a.stashes) === key(b.stashes);
  }

  /** Everything that influences the layout of the rows after `r` (owner rows by sha, rows relative). */
  private stateKey(sha: Sha): string {
    const r = this.n;
    const parts: string[] = [sha];
    for (const c of this.lanes) {
      if (c === null || c === undefined) parts.push('-');
      else if (!isSlot(c)) parts.push('R');
      else parts.push(`${c.expect} ${+c.fp} ${c.color} ${c.pin} ${+c.dashed} ${this.shas[c.owner]}`);
    }
    parts.push('|');
    for (const [s, lane] of [...this.reserved].sort((x, y) => x[1] - y[1])) parts.push(`${s}@${lane}`);
    parts.push('|');
    this.freedAt.forEach((f, i) => {
      if (r - f <= this.o.cooldown) parts.push(`${i}:${r - f}`);
    });
    parts.push('|');
    for (const m of this.pendingMergeOut) {
      parts.push(`${m.from}>${m.to} ${m.color} ${this.shas[m.owner]} ${+m.dashed} ${+m.created}`);
    }
    parts.push('|');
    for (const s of this.stashQueue) parts.push(s.sha);
    return parts.join('\n');
  }

  /** Returns true when the old suffix was adopted (the row `sha` is then already present). */
  private tryAdopt(sha: Sha): boolean {
    const ru = this.reuse!;
    const old = ru.old;
    if (ru.cand) {
      const at = ru.cand.old + ru.cand.matched;
      if (at < old.n && old.shas[at] === sha) {
        if (ru.cand.matched >= this.o.verify) {
          if (this.adopt(at)) return true;
          ru.cand = null;
        }
        return false;
      }
      ru.cand = null;
    }
    const o = old.rowIndex.get(sha);
    if (o !== undefined) {
      const key = old.checkpoints.get(o);
      if (key !== undefined && key === this.stateKey(sha)) ru.cand = { old: o, matched: 0 };
    }
    return false;
  }

  /** Copies old rows `[bOld, old.n)` and old's final lane state after the current last row. */
  private adopt(bOld: number): boolean {
    const old = this.reuse!.old;
    const oldN = old.n;
    for (let ro = bOld; ro < oldN; ro++) if (this.rowIndex.has(old.shas[ro]!)) return false;
    const bNew = this.n;
    const delta = bNew - bOld;
    const remapOwner = (o: number) => (o >= bOld ? o + delta : (this.rowIndex.get(old.shas[o]!) ?? -1));

    // rows
    this.ensureRows(oldN + delta);
    const head = this.o.headSha;
    let maxc = this._maxColumn;
    for (let ro = bOld; ro < oldN; ro++) {
      const rn = ro + delta;
      const sha = old.shas[ro]!;
      this.col[rn] = old.col[ro]!;
      this.colorArr[rn] = old.colorArr[ro]!;
      this.kindArr[rn] = old.kindArr[ro]!;
      this.flagArr[rn] = (old.flagArr[ro]! & ~RowFlag.Head) | (sha === head ? RowFlag.Head : 0);
      this.rowMax[rn] = old.rowMax[ro]!;
      if (old.rowMax[ro]! > maxc) maxc = old.rowMax[ro]!;
      this.parentRowArr = grow(
        this.parentRowArr,
        this.parentLen + old.parentStart[ro + 1]! - old.parentStart[ro]!,
      );
      for (let k = old.parentStart[ro]!; k < old.parentStart[ro + 1]!; k++) {
        const v = old.parentRowArr[k]!;
        this.parentRowArr[this.parentLen++] = v >= 0 ? v + delta : -1;
      }
      this.parentStart[rn + 1] = this.parentLen;
      this.rowIndex.set(sha, rn);
      this.shas.push(sha);
      this.items.push(old.items[ro]!);
    }

    // parent links: prefix children whose parents are in the suffix, then old pending links of suffix rows
    for (const [sha, idxs] of this.pendingParents) {
      const o = old.rowIndex.get(sha);
      if (o !== undefined && o >= bOld) {
        for (const i of idxs) this.parentRowArr[i] = o + delta;
        this.pendingParents.delete(sha);
      }
    }
    const oldBase = old.parentStart[bOld]!;
    const newBase = this.parentStart[bNew]!;
    for (const [sha, idxs] of old.pendingParents) {
      for (const i of idxs) {
        if (i < oldBase) continue;
        const list = this.pendingParents.get(sha);
        if (list) list.push(i - oldBase + newBase);
        else this.pendingParents.set(sha, [i - oldBase + newBase]);
      }
    }

    // edges
    if (bOld === 0 && bNew > 0) this.closeGap(bNew - 1, -1);
    const g0 = bOld === 0 ? 0 : bOld - 1;
    for (let g = g0; g <= oldN - 2; g++) {
      for (let e = old.gapStart[g]!; e < old.gapStart[g + 1]!; e++) {
        this.pushEdge(old.eFrom[e]!, old.eTo[e]!, old.eKind[e]!, old.eColor[e]!, remapOwner(old.eOwner[e]!));
      }
      this.gapStart = grow(this.gapStart, g + delta + 2);
      this.gapStart[g + delta + 1] = this.edgeLen;
    }
    if (bOld > 0 && bNew > 0) {
      // row bNew-1's max must include gap bNew-1 (copied from old gap bOld-1)
      this.rowMax[bNew - 1] = Math.max(this.rowMax[bNew - 1]!, old.rowMax[bOld - 1]!);
      maxc = Math.max(maxc, this.rowMax[bNew - 1]!);
    }

    // lane state at old's end
    this.lanes = old.lanes.map((c) => (isSlot(c) ? { ...c, owner: remapOwner(c.owner) } : c));
    this.waiting = new Map();
    for (const [s, w] of old.waiting) this.waiting.set(s, w.slice());
    this.freedAt = [];
    old.freedAt.forEach((f, i) => (this.freedAt[i] = f + delta));
    this.reserved = new Map(old.reserved);
    this.pendingMergeOut = old.pendingMergeOut.map((m) => ({ ...m, owner: remapOwner(m.owner) }));
    this.stashQueue = old.stashQueue.slice();
    for (const [ro, key] of old.checkpoints) if (ro >= bOld) this.checkpoints.set(ro + delta, key);

    this.n = oldN + delta;
    this._maxColumn = maxc;
    this._complete = old._complete;
    this._converged = true;
    this.reuse = null;
    return true;
  }
}

function compareGhost(a: GhostCandidate, b: GhostCandidate): number {
  if (!!a.remote !== !!b.remote) return a.remote ? 1 : -1;
  if (!!a.head !== !!b.head) return a.head ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}
