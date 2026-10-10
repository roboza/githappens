/**
 * Hide / Solo / Pin (spec 04 §2.6, §6.2, §6.10; spec 01 §4.5).
 *
 * Pure helpers that turn the per-repo visibility state into
 * - the log rev-set (spec 02 `LogQuery.revs` / `hiddenRefs`, built by `buildRevSet`),
 * - the set of refs whose pills are hidden (`groupRefPills({ hidden })`),
 * - the pinned lane tips (`GraphLayoutOptions.pinnedTips`),
 * - a "visible tip key": two states with equal keys load exactly the same commits, so a ref change that
 *   keeps the key (tag created at an existing commit, branch renamed, upstream changed) only updates
 *   pills and never reloads or re-lays out history (§6.10 decision tree, case 2).
 *
 * Semantics:
 * - Hidden entries are full ref names (`refs/heads/x`) or a namespace glob ending in `/*`
 *   (`refs/remotes/origin/*` hides a whole remote). Stashes are hidden as `stash:<sha>`.
 * - Solo: when at least one soloed ref still exists, only commits reachable from soloed refs, HEAD and
 *   (non-hidden) stashes are shown. The checked-out branch is never hidden by solo (§8).
 * - Hiding affects display only. A commit reachable from a hidden ref and a visible ref stays (§6.2).
 */
import { isDisplayableRef, type RefInput } from './refs';
import type { Sha } from './types';

export interface RefVisibilityState {
  /** Full ref names or `refs/remotes/<r>/*` globs; `stash:<sha>` for stashes. */
  hidden: readonly string[];
  /** Soloed full ref names or globs. Empty = solo off. */
  solo: readonly string[];
  /** Pinned branch full names, in pin order (lanes 1..k after HEAD). */
  pinned: readonly string[];
}

export const EMPTY_VISIBILITY: Readonly<RefVisibilityState> = Object.freeze({
  hidden: [],
  solo: [],
  pinned: [],
});

export interface StashTipInput {
  sha: Sha;
  parents?: readonly Sha[];
}

export const stashKey = (sha: Sha): string => `stash:${sha}`;

/** Does `fullName` match a hide/solo entry (exact name, or `prefix/*` namespace glob)? */
export function matchesRefPattern(fullName: string, pattern: string): boolean {
  if (pattern.endsWith('/*')) return fullName.startsWith(pattern.slice(0, -1));
  return fullName === pattern;
}

const matchesAny = (fullName: string, patterns: readonly string[]): boolean =>
  patterns.some((p) => matchesRefPattern(fullName, p));

const typeOf = (r: RefInput) => r.type ?? r.kind;
const isHeadRef = (r: RefInput): boolean => !!(r.isHead || r.isCheckedOut) || typeOf(r) === 'head';

/** Refs that take part in the graph rev-set (`refs/heads|remotes|tags`, not symrefs / hidden namespaces). */
export function isGraphRef(r: RefInput): boolean {
  const t = typeOf(r);
  return (t === 'local' || t === 'head' || t === 'remote' || t === 'tag') && isDisplayableRef(r);
}

/** Soloed refs that still exist (stale names are ignored, spec 01 §8). */
export function activeSolo(refs: readonly RefInput[], vis: RefVisibilityState): RefInput[] {
  if (!vis.solo.length) return [];
  return refs.filter((r) => isGraphRef(r) && matchesAny(r.fullName, vis.solo));
}

/** True when hide or solo changes what the graph shows. */
export function isFiltered(refs: readonly RefInput[], vis: RefVisibilityState): boolean {
  return vis.hidden.length > 0 || activeSolo(refs, vis).length > 0;
}

/** Full names of refs whose pills are hidden (explicitly hidden, or not soloed while solo is on). */
export function effectiveHidden(refs: readonly RefInput[], vis: RefVisibilityState): Set<string> {
  const out = new Set<string>();
  const solo = activeSolo(refs, vis).length > 0;
  for (const r of refs) {
    if (!isGraphRef(r)) continue;
    if (matchesAny(r.fullName, vis.hidden)) out.add(r.fullName);
    else if (solo && !isHeadRef(r) && !matchesAny(r.fullName, vis.solo)) out.add(r.fullName);
  }
  return out;
}

export type GraphRevQuery = { revs: 'all'; hiddenRefs?: string[] } | { revs: string[] };

/**
 * Log rev-set for the current visibility (spec 04 §6.2 "Tips", spec 01 §8):
 * - nothing hidden or soloed → `{ revs: 'all' }` (branches, remotes, tags, HEAD, stash tips);
 * - solo → the soloed refs + HEAD + visible stash tips, as explicit revs;
 * - hide → `'all'` with `hiddenRefs` (each is passed to git as `--exclude=<ref>` before every glob).
 *   Symbolic remote refs (`refs/remotes/<r>/HEAD`) are excluded too, so hiding `origin/main` is not
 *   undone by `origin/HEAD` pointing at it.
 */
export function graphRevQuery(
  refs: readonly RefInput[],
  vis: RefVisibilityState,
  opts: { headSha: Sha | null; stashes?: readonly StashTipInput[] } = { headSha: null },
): GraphRevQuery {
  const solo = activeSolo(refs, vis);
  if (solo.length) {
    const revs: string[] = [];
    for (const r of solo) if (!revs.includes(r.fullName)) revs.push(r.fullName);
    if (opts.headSha) revs.push('HEAD');
    for (const s of opts.stashes ?? []) {
      if (!matchesAny(stashKey(s.sha), vis.hidden) && !revs.includes(s.sha)) revs.push(s.sha);
    }
    return { revs };
  }
  const hiddenRefs = vis.hidden.filter((h) => !h.startsWith('stash:'));
  if (!hiddenRefs.length) return { revs: 'all' };
  for (const r of refs) {
    const symref = !!r.symrefTarget || /^refs\/remotes\/[^/]+\/HEAD$/.test(r.fullName);
    if (symref && !hiddenRefs.includes(r.fullName)) hiddenRefs.push(r.fullName);
  }
  return { revs: 'all', hiddenRefs };
}

/**
 * Identity of the loaded commit set: the sorted visible tip SHAs + HEAD + visible stash tips.
 * Equal keys ⇒ `git log` returns the same commits, so the layout can be kept (§6.10 case 2).
 */
export function visibleTipKey(
  refs: readonly RefInput[],
  vis: RefVisibilityState,
  headSha: Sha | null,
  stashes: readonly StashTipInput[] = [],
): string {
  const t = visibleTips(refs, vis, headSha, stashes);
  return `${t.tips.join(',')}|${t.head ?? ''}|${t.stashes.join(',')}`;
}

/** The parts of `visibleTipKey`, for comparing two states (see `historyUnchanged`). */
export interface VisibleTips {
  tips: Sha[];
  head: Sha | null;
  stashes: Sha[];
}

export function visibleTips(
  refs: readonly RefInput[],
  vis: RefVisibilityState,
  headSha: Sha | null,
  stashes: readonly StashTipInput[] = [],
): VisibleTips {
  const hidden = effectiveHidden(refs, vis);
  const tips = new Set<Sha>();
  for (const r of refs) if (isGraphRef(r) && !hidden.has(r.fullName)) tips.add(r.sha);
  if (headSha) tips.add(headSha);
  return {
    tips: [...tips].sort(),
    head: headSha,
    stashes: stashes.filter((s) => !matchesAny(stashKey(s.sha), vis.hidden)).map((s) => s.sha),
  };
}

/**
 * True when moving from `prev` to `next` cannot change the loaded commit set (§6.10 case 2): HEAD and
 * the stash tips are the same, no tip disappeared, and every new tip is a commit that is already laid out
 * (so its whole ancestry was already part of the history). Examples: a tag or branch created at an
 * existing commit, a rename, an upstream change.
 */
export function historyUnchanged(
  prev: VisibleTips,
  next: VisibleTips,
  isLoaded: (sha: Sha) => boolean,
): boolean {
  if (prev.head !== next.head || prev.stashes.join(',') !== next.stashes.join(',')) return false;
  const before = new Set(prev.tips);
  const after = new Set(next.tips);
  for (const t of before) if (!after.has(t)) return false;
  for (const t of after) if (!before.has(t) && !isLoaded(t)) return false;
  return true;
}

/** SHAs of pinned branch tips in pin order, for `GraphLayoutOptions.pinnedTips` (HEAD is lane 0). */
export function pinnedTipShas(refs: readonly RefInput[], vis: RefVisibilityState): Sha[] {
  const hidden = effectiveHidden(refs, vis);
  const out: Sha[] = [];
  for (const name of vis.pinned) {
    const r = refs.find((x) => x.fullName === name);
    if (r && !hidden.has(r.fullName) && !out.includes(r.sha)) out.push(r.sha);
  }
  return out;
}

/** Stash rows to drop from the graph (hidden stashes, §6.4) and their helper commits. */
export function hiddenStashShas(stashes: readonly StashTipInput[], vis: RefVisibilityState): Sha[] {
  const out: Sha[] = [];
  for (const s of stashes) {
    if (!matchesAny(stashKey(s.sha), vis.hidden)) continue;
    out.push(s.sha, ...(s.parents ?? []).slice(1));
  }
  return out;
}

/**
 * Drops entries that no longer match any ref (deleted branches, dropped stashes; spec 01 §8 "auto-remove
 * stale refs"). Returns `null` when nothing changed. Globs are kept while their namespace has refs.
 */
export function pruneVisibility(
  vis: RefVisibilityState,
  refs: readonly RefInput[],
  stashes: readonly StashTipInput[] = [],
): RefVisibilityState | null {
  const exists = (p: string): boolean =>
    p.startsWith('stash:')
      ? stashes.some((s) => stashKey(s.sha) === p)
      : refs.some((r) => matchesRefPattern(r.fullName, p));
  const hidden = vis.hidden.filter(exists);
  const solo = vis.solo.filter(exists);
  const pinned = vis.pinned.filter(exists);
  if (
    hidden.length === vis.hidden.length &&
    solo.length === vis.solo.length &&
    pinned.length === vis.pinned.length
  )
    return null;
  return { hidden, solo, pinned };
}

const toggle = (list: readonly string[], name: string, on?: boolean): string[] => {
  const has = list.includes(name);
  const want = on ?? !has;
  if (want === has) return [...list];
  return want ? [...list, name] : list.filter((x) => x !== name);
};

/** Hide/unhide a ref (or `stash:<sha>`, or a `refs/remotes/<r>/*` glob). Hiding also un-solos it. */
export function setHidden(vis: RefVisibilityState, name: string, hidden?: boolean): RefVisibilityState {
  const h = toggle(vis.hidden, name, hidden);
  const nowHidden = h.includes(name);
  return {
    hidden: h,
    solo: nowHidden ? vis.solo.filter((s) => s !== name) : [...vis.solo],
    pinned: [...vis.pinned],
  };
}

/** Solo/unsolo a ref (or a remote glob). Soloing also unhides it. */
export function setSolo(vis: RefVisibilityState, name: string, solo?: boolean): RefVisibilityState {
  const s = toggle(vis.solo, name, solo);
  const nowSolo = s.includes(name);
  return {
    hidden: nowSolo ? vis.hidden.filter((h) => h !== name) : [...vis.hidden],
    solo: s,
    pinned: [...vis.pinned],
  };
}

export function setPinned(vis: RefVisibilityState, name: string, pinned?: boolean): RefVisibilityState {
  return { hidden: [...vis.hidden], solo: [...vis.solo], pinned: toggle(vis.pinned, name, pinned) };
}

/** "Show all": clears hide and solo (pins are kept). */
export function showAll(vis: RefVisibilityState): RefVisibilityState {
  return { hidden: [], solo: [], pinned: [...vis.pinned] };
}

export type RefVisibilityMark = 'visible' | 'hidden' | 'solo' | 'hiddenBySolo';

/** How the left panel marks a ref: gray eye when hidden, orange when soloed (spec 01 §4.5). */
export function refVisibilityMark(
  fullName: string,
  refs: readonly RefInput[],
  vis: RefVisibilityState,
): RefVisibilityMark {
  if (matchesAny(fullName, vis.hidden)) return 'hidden';
  if (matchesAny(fullName, vis.solo)) return 'solo';
  if (activeSolo(refs, vis).length) {
    const r = refs.find((x) => x.fullName === fullName);
    if (!r || !isHeadRef(r)) return 'hiddenBySolo';
  }
  return 'visible';
}
