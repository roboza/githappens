/**
 * fzf-like fuzzy scoring (spec 01 §4.8). Modeled on fzf's v2 algorithm: every matched char scores
 * `SCORE_MATCH` plus a positional bonus (string start, word start, path segment, camelCase), runs of
 * consecutive matches inherit the bonus of their first char, and gaps are penalized (start + extension).
 * The optimal alignment is found by dynamic programming so `positions` are the best-scoring ones.
 * DOM-free; unit-tested in node.
 */

export interface FuzzyResult {
  score: number;
  positions: number[];
}

const SCORE_MATCH = 16;
const GAP_START = -3;
const GAP_EXTENSION = -1;
const BONUS_BOUNDARY = SCORE_MATCH / 2; // 8: after a non-word char like - _ . :
const BONUS_BOUNDARY_WHITE = BONUS_BOUNDARY + 2; // 10: string start / after whitespace
const BONUS_PATH_SEGMENT = BONUS_BOUNDARY + 1; // 9: after / or \
const BONUS_NON_WORD = BONUS_BOUNDARY; // matching a non-word char itself
const BONUS_CAMEL_123 = BONUS_BOUNDARY + GAP_EXTENSION; // 7: aB, a1
const BONUS_CONSECUTIVE = -(GAP_START + GAP_EXTENSION); // 4
const FIRST_CHAR_MULTIPLIER = 2;

const C = { White: 0, Delim: 1, NonWord: 2, Lower: 3, Upper: 4, Digit: 5 } as const;
type C = (typeof C)[keyof typeof C];

function charClass(ch: string | undefined): C {
  if (ch === undefined) return C.White;
  if (ch >= 'a' && ch <= 'z') return C.Lower;
  if (ch >= 'A' && ch <= 'Z') return C.Upper;
  if (ch >= '0' && ch <= '9') return C.Digit;
  if (ch === ' ' || ch === '\t' || ch === '\n') return C.White;
  if (ch === '/' || ch === '\\') return C.Delim;
  // Treat other letters (unicode) as lowercase word chars.
  if (ch.toLowerCase() !== ch.toUpperCase()) return ch === ch.toUpperCase() ? C.Upper : C.Lower;
  return C.NonWord;
}

function bonusFor(prev: C, cur: C): number {
  if (cur === C.Lower || cur === C.Upper || cur === C.Digit) {
    if (prev === C.White) return BONUS_BOUNDARY_WHITE;
    if (prev === C.Delim) return BONUS_PATH_SEGMENT;
    if (prev === C.NonWord) return BONUS_BOUNDARY;
    if (prev === C.Lower && cur === C.Upper) return BONUS_CAMEL_123;
    if (prev !== C.Digit && cur === C.Digit) return BONUS_CAMEL_123;
    return 0;
  }
  if (cur === C.White) return BONUS_BOUNDARY_WHITE;
  return BONUS_NON_WORD;
}

const NEG = -1e9;

/**
 * Score `text` against `query` (case-insensitive; whitespace in the query is ignored).
 * Returns null when the query is not a subsequence of the text. An empty query matches with score 0.
 */
export function fuzzyScore(query: string, text: string): FuzzyResult | null {
  const q = query.replace(/\s+/g, '').toLowerCase();
  const m = q.length;
  if (m === 0) return { score: 0, positions: [] };
  const n = text.length;
  if (m > n) return null;
  const lower = text.toLowerCase();
  // toLowerCase can change length for some unicode chars; fall back to per-char lowering then.
  const lc = lower.length === n ? lower : Array.from(text, (c) => c.toLowerCase()[0] ?? c).join('');

  // Quick subsequence check + bounds: first[i] = earliest index query[i] can match.
  const first = new Int32Array(m);
  let ti = 0;
  for (let i = 0; i < m; i++) {
    const idx = lc.indexOf(q[i]!, ti);
    if (idx < 0) return null;
    first[i] = idx;
    ti = idx + 1;
  }

  const bonus = new Float64Array(n);
  let prev: C = C.White;
  for (let j = 0; j < n; j++) {
    const cur = charClass(text[j]);
    bonus[j] = bonusFor(prev, cur);
    prev = cur;
  }

  // H[i*n+j]: best score with query[0..i] matched and query[i] matched exactly at text[j].
  const H = new Float64Array(m * n).fill(NEG);
  const run = new Int32Array(m * n); // length of consecutive run ending at (i, j)
  const back = new Int32Array(m * n).fill(-1); // j of query[i-1] in the best alignment

  for (let i = 0; i < m; i++) {
    const qc = q[i]!;
    const row = i * n;
    const prow = (i - 1) * n;
    // Running best over gapped predecessors: max_k H[i-1][k] + gap penalty for (j-k-1) skipped chars.
    let gapBest = NEG;
    let gapFrom = -1;
    for (let j = i === 0 ? first[0]! : 0; j < n; j++) {
      if (i > 0 && j >= 2) {
        const cand = H[prow + j - 2]!;
        const extended = gapBest + GAP_EXTENSION;
        if (cand > NEG && cand + GAP_START >= extended) {
          gapBest = cand + GAP_START;
          gapFrom = j - 2;
        } else gapBest = extended;
      }
      if (lc[j] !== qc) continue;
      const b = bonus[j]!;
      if (i === 0) {
        H[row + j] = SCORE_MATCH + b * FIRST_CHAR_MULTIPLIER;
        run[row + j] = 1;
        continue;
      }
      let best = NEG;
      let from = -1;
      let r = 1;
      // Consecutive with previous query char.
      if (j >= 1 && H[prow + j - 1]! > NEG) {
        const pr = run[prow + j - 1]!;
        const chunkBonus = bonus[j - pr]!;
        let cb: number;
        let nr = pr + 1;
        if (b >= BONUS_BOUNDARY && b > chunkBonus) {
          cb = b; // a new word starts inside the run: restart the chunk
          nr = 1;
        } else cb = Math.max(b, BONUS_CONSECUTIVE, chunkBonus);
        best = H[prow + j - 1]! + SCORE_MATCH + cb;
        from = j - 1;
        r = nr;
      }
      if (gapBest > NEG) {
        const s = gapBest + SCORE_MATCH + b;
        if (s > best) {
          best = s;
          from = gapFrom;
          r = 1;
        }
      }
      if (best > NEG) {
        H[row + j] = best;
        back[row + j] = from;
        run[row + j] = r;
      }
    }
  }

  const last = (m - 1) * n;
  let bestJ = -1;
  let bestScore = NEG;
  for (let j = 0; j < n; j++) {
    const s = H[last + j]!;
    if (s > bestScore) {
      bestScore = s;
      bestJ = j;
    }
  }
  if (bestJ < 0) return null;

  const positions = new Array<number>(m);
  let j = bestJ;
  for (let i = m - 1; i >= 0; i--) {
    positions[i] = j;
    j = back[i * n + j]!;
  }
  return { score: bestScore, positions };
}

export interface RankedItem<T> {
  item: T;
  score: number;
  /** Indices into the primary text (`getText`) to highlight; empty when matched via alternate text. */
  positions: number[];
}

export interface RankOptions<T> {
  getText: (item: T) => string;
  /** Optional secondary text (keywords, detail) matched with a penalty when the primary text does not match. */
  getAltText?: (item: T) => string | undefined;
  /** Stable key used for MRU lookups. */
  getKey?: (item: T) => string;
  /** Most-recent-first keys; earlier entries get a larger boost. */
  mru?: readonly string[];
  limit?: number;
  /** Items sorted after all others regardless of score (e.g. disabled commands). */
  demote?: (item: T) => boolean;
}

export const MRU_MAX = 20;
/** Maximum boost for the most recent item; decays linearly over the MRU list. */
export const MRU_MAX_BOOST = 40;
const ALT_PENALTY = 12;

export function mruBoost(key: string | undefined, mru: readonly string[] | undefined): number {
  if (!key || !mru) return 0;
  const r = mru.indexOf(key);
  if (r < 0 || r >= MRU_MAX) return 0;
  return Math.round(MRU_MAX_BOOST * (1 - r / MRU_MAX));
}

/**
 * Filter and rank items by fuzzy score + MRU boost. Ties break toward shorter text, then input order.
 * With an empty query every item is kept, ordered by recency then input order.
 */
export function rankItems<T>(items: readonly T[], query: string, opts: RankOptions<T>): RankedItem<T>[] {
  const out: (RankedItem<T> & { idx: number; len: number; demoted: boolean })[] = [];
  items.forEach((item, idx) => {
    const text = opts.getText(item);
    let res = fuzzyScore(query, text);
    if (!res && opts.getAltText) {
      const alt = opts.getAltText(item);
      const altRes = alt ? fuzzyScore(query, alt) : null;
      if (altRes) res = { score: altRes.score - ALT_PENALTY, positions: [] };
    }
    if (!res) return;
    const score = res.score + mruBoost(opts.getKey?.(item), opts.mru);
    out.push({
      item,
      score,
      positions: res.positions,
      idx,
      len: text.length,
      demoted: opts.demote?.(item) ?? false,
    });
  });
  const hasQuery = query.trim().length > 0;
  out.sort(
    (a, b) =>
      Number(a.demoted) - Number(b.demoted) ||
      b.score - a.score ||
      (hasQuery ? a.len - b.len : 0) ||
      a.idx - b.idx,
  );
  const limited = opts.limit !== undefined ? out.slice(0, opts.limit) : out;
  return limited.map(({ item, score, positions }) => ({ item, score, positions }));
}
