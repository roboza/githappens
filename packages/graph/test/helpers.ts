import {
  EdgeKind,
  GraphModel,
  type GraphCommitInput,
  type GraphEdge,
  type GraphLayoutOptions,
  type GraphStashInput,
} from '../src';

export function c(sha: string, parents: string[] = [], commitTime?: number): GraphCommitInput {
  return commitTime === undefined ? { sha, parents } : { sha, parents, commitTime };
}

/** Builds a model, feeding commits in pages of the given sizes (cycled), then `done`. */
export function build(
  commits: readonly GraphCommitInput[],
  options: GraphLayoutOptions = {},
  pages: number[] = [],
  done = true,
): GraphModel {
  const m = new GraphModel(options);
  if (!pages.length) {
    m.append(commits, done);
    return m;
  }
  let i = 0;
  let k = 0;
  while (i < commits.length) {
    const size = Math.max(1, pages[k++ % pages.length]!);
    m.append(commits.slice(i, i + size));
    i += size;
  }
  if (done) m.finish();
  return m;
}

export function cols(m: GraphModel): Record<string, number> {
  const out: Record<string, number> = {};
  for (let r = 0; r < m.rowCount; r++) out[m.shaAt(r)!] = m.columnAt(r);
  return out;
}

const KIND = ['Pass', 'MergeOut', 'BranchIn'];
export function edgeStr(e: GraphEdge): string {
  return `${KIND[e.kind]}(${e.from}→${e.to})${e.dashed ? 'd' : ''}${e.fade ? 'f' : ''}`;
}
export function gapEdges(m: GraphModel, gap: number): string[] {
  return m.edgesInRange(gap, gap).map(edgeStr);
}

export function snapshot(m: GraphModel) {
  const rows = [];
  for (let r = 0; r < m.rowCount; r++) {
    rows.push([
      m.shaAt(r),
      m.columnAt(r),
      m.colorAt(r),
      m.nodeKindAt(r),
      m.flagsAt(r),
      m.parentRows(r).join(','),
    ]);
  }
  return {
    rows,
    edges: m.edgesInRange(0, m.rowCount).map((e) => `${e.gap}:${edgeStr(e)}c${e.color}o${e.owner}`),
    maxColumn: m.maxColumn,
    complete: m.complete,
  };
}

/** Structural invariants of spec 04 §6.3.4 / §9. Returns a list of violations (empty = ok). */
export function checkInvariants(m: GraphModel): string[] {
  const errs: string[] = [];
  const n = m.rowCount;
  const gaps: GraphEdge[][] = Array.from({ length: n }, () => []);
  for (const e of m.edgesInRange(0, n - 1)) gaps[e.gap]!.push(e);
  const col = (r: number) => m.columnAt(r);

  for (let g = 0; g < n; g++) {
    const E = gaps[g]!;
    const laneFrom = new Set<number>();
    for (const e of E) {
      if (e.kind !== EdgeKind.MergeOut) {
        if (laneFrom.has(e.from)) errs.push(`gap ${g}: two lines in column ${e.from}`);
        laneFrom.add(e.from);
      }
      if (e.kind === EdgeKind.Pass && e.from !== e.to) errs.push(`gap ${g}: Pass changes column`);
      if (e.kind === EdgeKind.MergeOut && (e.from !== col(g) || e.owner !== g)) {
        errs.push(`gap ${g}: MergeOut not from node`);
      }
      if (e.kind === EdgeKind.BranchIn && (g + 1 >= n || e.to !== col(g + 1))) {
        errs.push(`gap ${g}: BranchIn not into node`);
      }
      if (e.kind !== EdgeKind.MergeOut && e.from === col(g) && e.owner !== g) {
        errs.push(`gap ${g}: line in node column ${e.from} not owned by node (owner ${e.owner})`);
      }
      if (g + 1 < n && e.to === col(g + 1) && !m.parentRows(e.owner).includes(g + 1)) {
        errs.push(`gap ${g}: line ${edgeStr(e)} enters node ${g + 1} that is not a parent of ${e.owner}`);
      }
      // continuity: a line not starting at node g must arrive from gap g-1 in the same column & owner
      if (e.kind !== EdgeKind.MergeOut && e.from !== col(g)) {
        const prev = g > 0 ? gaps[g - 1]! : [];
        if (!prev.some((p) => p.to === e.from && p.owner === e.owner && p.kind !== EdgeKind.BranchIn)) {
          errs.push(`gap ${g}: line ${edgeStr(e)} owner ${e.owner} appears from nowhere (lane shifted?)`);
        }
      }
    }
    // no dangling lines: everything arriving at row g+1 outside the node continues
    if (g + 1 < n) {
      const next = gaps[g + 1]!;
      for (const e of E) {
        if (e.to === col(g + 1) || e.kind === EdgeKind.BranchIn) continue;
        const joined =
          e.kind === EdgeKind.MergeOut && E.some((p) => p.kind === EdgeKind.Pass && p.from === e.to);
        if (!joined && !next.some((x) => x.from === e.to && x.owner === e.owner)) {
          errs.push(`gap ${g}: line ${edgeStr(e)} owner ${e.owner} dangles at row ${g + 1}`);
        }
      }
    }
  }

  // every parent link is drawn
  for (let ch = 0; ch < n; ch++) {
    for (const p of m.parentRows(ch)) {
      if (p >= 0 && p <= ch) continue; // out-of-order input (not drawable upward)
      if (!trace(m, gaps, ch, p)) errs.push(`link ${m.shaAt(ch)}(${ch}) → row ${p} not drawn`);
    }
  }
  return errs;
}

function trace(m: GraphModel, gaps: GraphEdge[][], child: number, target: number): boolean {
  const n = m.rowCount;
  let A = new Set<number>();
  for (const e of gaps[child]!)
    if (e.owner === child && (e.from === m.columnAt(child) || e.kind === EdgeKind.MergeOut)) A.add(e.to);
  for (let row = child + 1; row < n; row++) {
    if (row === target) return A.has(m.columnAt(row));
    const next = new Set<number>();
    for (const x of A) {
      if (x === m.columnAt(row)) continue;
      for (const e of gaps[row]!) if (e.from === x && e.kind !== EdgeKind.MergeOut) next.add(e.to);
    }
    A = next;
    if (!A.size) return false;
  }
  return target === -1 && A.size > 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface RandomHistory {
  commits: GraphCommitInput[];
  options: GraphLayoutOptions;
}

/** A random DAG in date order (children first), with missing parents, roots, octopus merges, stashes, WIP. */
export function randomHistory(seed: number, n: number, extras = true): RandomHistory {
  const rnd = mulberry32(seed);
  const span = 2 + Math.floor(rnd() * 25);
  const commits: GraphCommitInput[] = [];
  for (let i = 0; i < n; i++) {
    const r = rnd();
    const np = r < 0.05 ? 0 : r < 0.72 ? 1 : r < 0.95 ? 2 : 3 + Math.floor(rnd() * 3);
    const parents: string[] = [];
    for (let k = 0; k < np; k++) {
      if (rnd() < 0.03) {
        parents.push(`gone${i}_${k}`);
        continue;
      }
      const j = i + 1 + Math.floor(rnd() ** 2 * span);
      parents.push(j < n ? `c${j}` : `gone${j}`);
    }
    commits.push({ sha: `c${i}`, parents, commitTime: 10 * (n - i) });
  }
  const options: GraphLayoutOptions = {};
  if (extras && n > 0) {
    if (rnd() < 0.8) options.headSha = `c${Math.floor(rnd() * Math.min(n, 10))}`;
    const pinned: string[] = [];
    while (rnd() < 0.3) pinned.push(`c${Math.floor(rnd() * n)}`);
    options.pinnedTips = pinned;
    if (rnd() < 0.4)
      options.wip =
        rnd() < 0.8
          ? true
          : { kind: 'conflict', parents: [options.headSha ?? 'c0', `c${Math.floor(rnd() * n)}`] };
    const stashes: GraphStashInput[] = [];
    while (rnd() < 0.35) {
      const b = Math.floor(rnd() * (n + 2));
      stashes.push({
        sha: `s${stashes.length}`,
        parents: [b < n ? `c${b}` : `gone_s${b}`, `si${stashes.length}`],
        time: 10 * (n - b) + Math.floor(rnd() * 60),
        index: stashes.length,
      });
    }
    options.stashes = stashes;
    if (rnd() < 0.2) options.laneReuseCooldown = Math.floor(rnd() * 3);
    if (rnd() < 0.2) options.mergeLanePlacement = 'leftmost';
    if (rnd() < 0.2) options.colorMode = 'branch';
  }
  return { commits, options };
}
