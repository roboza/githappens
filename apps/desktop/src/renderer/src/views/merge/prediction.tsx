import type { RefPill } from '@githappens/graph';
import type { ConflictPrediction, RepoId, Sha } from '@githappens/git/types';
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { create } from 'zustand';

import { useContextMenu, type MenuItem } from '../../components/ContextMenu';
import { invoke } from '../../lib/api';
import { useRepoInfo } from '../../repo/queries';
import { useSetting } from '../../stores/settings';
import { conflictHint, conflictHintTitle, PredictionCache, withHint } from './prediction-cache';

/**
 * Local conflict prediction beyond drag-and-drop (spec 08 §4.9): branch context menus, a 500 ms drag hover
 * and optional ⚠ badges on graph branch pills. All share one cache keyed by `(oursSha, theirsSha)`.
 */

const cache = new PredictionCache();

/** `git:conflict:predict` through the shared cache; null on failure / unsupported git. */
export function predictCached(
  repoId: RepoId,
  oursSha: Sha,
  theirsSha: Sha,
): Promise<ConflictPrediction | null> {
  return cache.get(PredictionCache.key(repoId, oursSha, theirsSha), () =>
    invoke('git:conflict:predict', { repoId, ours: oursSha, theirs: theirsSha }),
  );
}

export function peekPrediction(repoId: RepoId, oursSha: Sha, theirsSha: Sha): ConflictPrediction | undefined {
  return cache.peek(PredictionCache.key(repoId, oursSha, theirsSha));
}

/**
 * A menu item that merges/rebases `theirsSha` with HEAD (`oursSha`): labelled from the cache right away, and
 * patched in the open context menu once the prediction arrives ("Merge X into H — ⚠ will conflict in N files").
 */
export function withConflictPrediction(
  repoId: RepoId,
  item: MenuItem,
  oursSha: Sha | null | undefined,
  theirsSha: Sha | null | undefined,
): MenuItem {
  if (!oursSha || !theirsSha || oursSha === theirsSha) return item;
  const hit = peekPrediction(repoId, oursSha, theirsSha);
  if (hit) return decorate(item, hit);
  const base = item;
  void predictCached(repoId, oursSha, theirsSha).then((p) => {
    if (!conflictHint(p)) return;
    const st = useContextMenu.getState();
    const open = st.open;
    if (!open || !open.items.includes(base)) return;
    useContextMenu.setState({
      open: { ...open, items: open.items.map((i) => (i === base ? decorate(base, p) : i)) },
    });
  });
  return item;
}

function decorate(item: MenuItem, p: ConflictPrediction | null): MenuItem {
  const title = conflictHintTitle(p);
  if (!title) return item;
  return { ...item, label: withHint(item.label, p), title: item.title ? `${item.title}\n\n${title}` : title };
}

// ---- drag hover (spec 08 §4.9 / spec 04 §4.11: 500 ms over a drop target) ----

let dragSource: { sha: Sha } | null = null;
let hover: { el: HTMLElement; timer: ReturnType<typeof setTimeout>; title: string | null } | null = null;

/** Called when a ref / commit drag starts (`actions/dnd.ts`), since dragover can't read the payload. */
export function setDragSource(source: { sha?: Sha } | null): void {
  dragSource = source?.sha ? { sha: source.sha } : null;
}

/**
 * Dragging over a target for 500 ms predicts merging the dragged ref into it; the target's tooltip then
 * reads "⚠ Will conflict in N files" with the file list, and the drop menu gets the cached answer instantly.
 */
export function hoverPredict(repoId: RepoId, el: HTMLElement, targetSha: Sha | undefined): void {
  if (hover?.el === el) return;
  endHoverPredict();
  const src = dragSource?.sha;
  if (!src || !targetSha || src === targetSha) return;
  const state = {
    el,
    title: el.getAttribute('title'),
    timer: null as unknown as ReturnType<typeof setTimeout>,
  };
  state.timer = setTimeout(() => {
    void predictCached(repoId, targetSha, src).then((p) => {
      if (hover !== state) return;
      const hint = conflictHint(p);
      if (!hint) return;
      el.dataset.conflictPrediction = String(p!.conflicts.length);
      el.setAttribute('title', `⚠ ${hint}\n${conflictHintTitle(p)}`);
    });
  }, 500);
  hover = state;
}

export function endHoverPredict(): void {
  if (!hover) return;
  clearTimeout(hover.timer);
  const { el, title } = hover;
  delete el.dataset.conflictPrediction;
  if (title === null) el.removeAttribute('title');
  else el.setAttribute('title', title);
  hover = null;
}

// ---- graph pill badges (spec 08 §4.9, optional, off by default) ----

const useBadgeScope = create<{ repoId: RepoId | null }>(() => ({ repoId: null }));

/** The active repo view registers itself so graph pills can predict against its HEAD. */
export function useConflictBadgeScope(repoId: RepoId): void {
  useEffect(() => {
    useBadgeScope.setState({ repoId });
    return () => {
      if (useBadgeScope.getState().repoId === repoId) useBadgeScope.setState({ repoId: null });
    };
  }, [repoId]);
}

/** ⚠ on a branch pill that would conflict when merged into the checked-out branch (lazy, cached). */
export function PillConflictBadge({ pill }: { pill: RefPill }) {
  const enabled = useSetting('graph.conflictBadges') === true;
  const repoId = useBadgeScope((s) => s.repoId);
  if (!enabled || !repoId || pill.isCheckedOut) return null;
  if (pill.kind !== 'local' && pill.kind !== 'remote' && pill.kind !== 'head') return null;
  return <Badge repoId={repoId} sha={pill.sha} />;
}

function Badge({ repoId, sha }: { repoId: RepoId; sha: Sha }) {
  const info = useRepoInfo(repoId);
  const head = info.data?.head.sha || null;
  const q = useQuery({
    queryKey: ['conflictPredict', repoId, head, sha],
    queryFn: () => predictCached(repoId, head!, sha),
    enabled: !!head && head !== sha,
    staleTime: Infinity,
    gcTime: 5 * 60_000,
  });
  const hint = conflictHint(q.data);
  if (!hint) return null;
  return (
    <span
      role="img"
      aria-label={hint}
      title={`${hint} when merged into the checked-out branch\n${conflictHintTitle(q.data)}`}
      style={{ color: 'var(--kl-orange)', marginLeft: 2, fontSize: 10 }}
    >
      ⚠
    </span>
  );
}
