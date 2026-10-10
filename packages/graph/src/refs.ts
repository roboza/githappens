/**
 * Ref pill grouping for the Branch/Tag column (spec 04 §4.5, §6.1).
 *
 * Accepts spec 02 `RefInfo` values (or spec 04 `GraphRef`s) structurally and returns, per commit sha,
 * the ordered list of pills to render: combined local+remote pills, then remote-only, tags and stashes.
 */
import type { GhostCandidate } from './model';
import type { Sha } from './types';

export type RefInputType = 'head' | 'local' | 'remote' | 'tag' | 'stash' | 'other';

/** Structural subset of spec 02 `RefInfo` / spec 04 `GraphRef`. */
export interface RefInput {
  fullName: string;
  shortName: string;
  /** spec 02 `RefInfo.type`. */
  type?: RefInputType;
  /** spec 04 `GraphRef.kind` (used when `type` is absent). */
  kind?: RefInputType;
  /** Peeled commit sha. */
  sha: Sha;
  /** spec 02: the checked-out branch. */
  isHead?: boolean;
  /** spec 04 `GraphRef.isCheckedOut`. */
  isCheckedOut?: boolean;
  /** Upstream full name (spec 04) or spec 02's upstream object. */
  upstream?: string | { fullName: string; ahead?: number; behind?: number; gone?: boolean } | null;
  ahead?: number;
  behind?: number;
  /** Remote name for remote branches (otherwise taken from `refs/remotes/<remote>/…`). */
  remote?: string;
  symrefTarget?: string;
  tagObjectSha?: string;
  isAnnotatedTag?: boolean;
  worktreePath?: string;
}

export type RefPillKind = 'head' | 'local' | 'remote' | 'tag' | 'stash' | 'detached';

export interface RefPill {
  kind: RefPillKind;
  /** Display text: branch / tag short name, `HEAD` (detached) or `stash@{n}: message`. */
  label: string;
  /** Full name of the primary ref (drag source, context-menu target). */
  fullName: string;
  sha: Sha;
  /** Primary ref (absent for detached HEAD and stash pills built from `stashes`). */
  ref?: RefInput;
  /** Local branch of a combined pill. */
  local?: RefInput;
  /** Remote branches shown on this pill (absorbed upstream / same-name remotes, or the remote-only ref). */
  remotes: RefInput[];
  hasLocal: boolean;
  hasRemote: boolean;
  isCheckedOut: boolean;
  isAnnotatedTag?: boolean;
  ahead?: number;
  behind?: number;
  upstreamGone?: boolean;
  worktreePath?: string;
  /** Full names of every ref merged into this pill. */
  refs: string[];
}

export interface StashPillInput {
  sha: Sha;
  index?: number;
  ref?: string;
  message?: string;
}

export interface GroupRefsOptions {
  /** Full ref names (and `stash@{n}` refs) that must not render pills. */
  hidden?: Iterable<string>;
  /** When HEAD is detached, its sha: a `HEAD` pill (kind `detached`) is added first on that row. */
  detachedHeadSha?: Sha | null;
  /** Stash entries (spec 02 `StashEntry`). When given, `type: 'stash'` refs are ignored. */
  stashes?: readonly StashPillInput[];
}

const RANK: Record<RefPillKind, number> = { detached: 0, head: 0, local: 1, remote: 2, tag: 3, stash: 4 };

/** True when a ref may ever render as a pill (§6.1 exclusions, `refs/githappens/*` never shown). */
export function isDisplayableRef(r: RefInput): boolean {
  const t = r.type ?? r.kind;
  if (t === 'other' || t === undefined) return false;
  const f = r.fullName;
  if (f.startsWith('refs/githappens/') || f.startsWith('refs/prefetch/') || f.startsWith('refs/notes/'))
    return false;
  if (
    t === 'remote' &&
    (r.symrefTarget || /^refs\/remotes\/[^/]+\/HEAD$/.test(f) || r.shortName.endsWith('/HEAD'))
  )
    return false;
  return true;
}

function remoteName(r: RefInput): string {
  if (r.remote) return r.remote;
  const m = /^refs\/remotes\/([^/]+)\//.exec(r.fullName);
  return m ? m[1]! : (r.shortName.split('/')[0] ?? '');
}

/** `origin/feature/x` → `feature/x`. */
export function remoteBranchName(r: RefInput): string {
  const rem = remoteName(r);
  return r.shortName.startsWith(rem + '/') ? r.shortName.slice(rem.length + 1) : r.shortName;
}

function upstreamOf(r: RefInput): { fullName?: string; ahead?: number; behind?: number; gone?: boolean } {
  const u = r.upstream;
  if (!u) return { ahead: r.ahead, behind: r.behind };
  if (typeof u === 'string') return { fullName: u, ahead: r.ahead, behind: r.behind };
  return { fullName: u.fullName, ahead: u.ahead ?? r.ahead, behind: u.behind ?? r.behind, gone: u.gone };
}

function compareNames(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la !== lb) return la < lb ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Pill sort order (§4.5): HEAD branch, local, remote-only, tags, stash; alphabetical within a group. */
export function comparePills(a: RefPill, b: RefPill): number {
  return (
    RANK[a.kind] - RANK[b.kind] || compareNames(a.label, b.label) || compareNames(a.fullName, b.fullName)
  );
}

/**
 * Groups refs into ordered pills per commit sha (§4.5).
 * - A local branch absorbs remote branches at the same commit that are its configured upstream, then
 *   other remote branches with the same short name (combined pill).
 * - Hidden refs never render; an absorbed remote that is hidden is simply not shown on the pill.
 * - `refs/githappens/*`, `refs/prefetch/*`, `refs/notes/*`, `refs/remotes/<r>/HEAD` and `type: 'other'`
 *   refs are never shown.
 */
export function groupRefPills(
  refs: readonly RefInput[],
  options: GroupRefsOptions = {},
): Map<Sha, RefPill[]> {
  const hidden = new Set(options.hidden ?? []);
  const useStashList = options.stashes !== undefined;
  const bySha = new Map<Sha, RefInput[]>();
  for (const r of refs) {
    if (!isDisplayableRef(r) || hidden.has(r.fullName)) continue;
    if (useStashList && (r.type ?? r.kind) === 'stash') continue;
    const list = bySha.get(r.sha);
    if (list) list.push(r);
    else bySha.set(r.sha, [r]);
  }

  const out = new Map<Sha, RefPill[]>();
  const push = (p: RefPill) => {
    const list = out.get(p.sha);
    if (list) list.push(p);
    else out.set(p.sha, [p]);
  };

  for (const [sha, list] of bySha) {
    const kindOf = (r: RefInput) => {
      const t = r.type ?? r.kind;
      return t === 'local' && (r.isHead || r.isCheckedOut) ? 'head' : t;
    };
    const locals = list
      .filter((r) => kindOf(r) === 'local' || kindOf(r) === 'head')
      .sort(
        (a, b) =>
          (kindOf(a) === 'head' ? 0 : 1) - (kindOf(b) === 'head' ? 0 : 1) ||
          compareNames(a.shortName, b.shortName),
      );
    const remotes = list.filter((r) => kindOf(r) === 'remote');
    const absorbed = new Map<RefInput, RefInput[]>(locals.map((l) => [l, []]));
    const taken = new Set<RefInput>();
    // pass 1: configured upstream at the same commit
    for (const l of locals) {
      const up = upstreamOf(l).fullName;
      const rem = up ? remotes.find((r) => !taken.has(r) && r.fullName === up) : undefined;
      if (rem) {
        absorbed.get(l)!.push(rem);
        taken.add(rem);
      }
    }
    // pass 2: other remotes with the same branch name
    for (const l of locals) {
      for (const r of remotes) {
        if (!taken.has(r) && remoteBranchName(r) === l.shortName) {
          absorbed.get(l)!.push(r);
          taken.add(r);
        }
      }
    }
    for (const l of locals) {
      const rs = absorbed.get(l)!.sort((a, b) => compareNames(a.shortName, b.shortName));
      const up = upstreamOf(l);
      push({
        kind: kindOf(l) === 'head' ? 'head' : 'local',
        label: l.shortName,
        fullName: l.fullName,
        sha,
        ref: l,
        local: l,
        remotes: rs,
        hasLocal: true,
        hasRemote: rs.length > 0,
        isCheckedOut: kindOf(l) === 'head',
        ahead: up.ahead,
        behind: up.behind,
        upstreamGone: up.gone,
        worktreePath: l.worktreePath,
        refs: [l.fullName, ...rs.map((r) => r.fullName)],
      });
    }
    for (const r of remotes) {
      if (taken.has(r)) continue;
      push({
        kind: 'remote',
        label: r.shortName,
        fullName: r.fullName,
        sha,
        ref: r,
        remotes: [r],
        hasLocal: false,
        hasRemote: true,
        isCheckedOut: false,
        refs: [r.fullName],
      });
    }
    for (const r of list) {
      const k = kindOf(r);
      if (k !== 'tag' && k !== 'stash') continue;
      push({
        kind: k,
        label: r.shortName,
        fullName: r.fullName,
        sha,
        ref: r,
        remotes: [],
        hasLocal: false,
        hasRemote: false,
        isCheckedOut: false,
        isAnnotatedTag: k === 'tag' ? !!(r.isAnnotatedTag || r.tagObjectSha) : undefined,
        refs: [r.fullName],
      });
    }
  }

  for (const s of options.stashes ?? []) {
    const ref = s.ref ?? `stash@{${s.index ?? 0}}`;
    if (hidden.has(ref)) continue;
    push({
      kind: 'stash',
      label: s.message ? `${ref}: ${s.message}` : ref,
      fullName: ref,
      sha: s.sha,
      remotes: [],
      hasLocal: false,
      hasRemote: false,
      isCheckedOut: false,
      refs: [ref],
    });
  }

  if (options.detachedHeadSha) {
    push({
      kind: 'detached',
      label: 'HEAD',
      fullName: 'HEAD',
      sha: options.detachedHeadSha,
      remotes: [],
      hasLocal: false,
      hasRemote: false,
      isCheckedOut: true,
      refs: ['HEAD'],
    });
  }

  for (const list of out.values()) list.sort(comparePills);
  return out;
}

/** Branch candidates of a row's pills for `GraphModel.nearestBranch` (ghost ref, §6.7). */
export function ghostCandidates(pills: readonly RefPill[] | undefined): GhostCandidate[] {
  const out: GhostCandidate[] = [];
  for (const p of pills ?? []) {
    if (p.kind === 'head' || p.kind === 'local') {
      out.push({ name: p.label, fullName: p.fullName, head: p.kind === 'head' });
    } else if (p.kind === 'remote') {
      out.push({ name: p.label, fullName: p.fullName, remote: true });
    }
  }
  return out;
}
