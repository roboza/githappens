import { activeSolo, matchesRefPattern, refVisibilityMark, stashKey, type RefInput } from '@githappens/graph';
import type { RefInfo, RepoId, Sha } from '@githappens/git/types';
import { Crosshair, Eye, EyeOff, Pin } from 'lucide-react';
import type { MouseEvent } from 'react';

import type { MenuEntry } from '../../components/ContextMenu';
import {
  getRepoGraphState,
  hideRef,
  pinRef,
  showAllRefs,
  soloRef,
  useRepoGraphState,
} from './repo-graph-state';
import styles from './visibility.module.css';

/** Hide / Solo / Pin menu entries for a ref (spec 04 §4.10 items "Hide / Solo / Pin to left"). */
export function visibilityMenuItems(
  repoId: RepoId,
  ref: Pick<RefInfo, 'fullName' | 'shortName' | 'type'>,
): MenuEntry[] {
  const { vis } = getRepoGraphState(repoId);
  const hidden = vis.hidden.includes(ref.fullName);
  const solo = vis.solo.includes(ref.fullName);
  const pinned = vis.pinned.includes(ref.fullName);
  const items: MenuEntry[] = [
    {
      label: hidden ? `Show ${ref.shortName} in graph` : `Hide ${ref.shortName}`,
      onSelect: () => hideRef(repoId, ref.fullName, !hidden),
    },
    {
      label: solo ? `Unsolo ${ref.shortName}` : `Solo ${ref.shortName}`,
      onSelect: () => soloRef(repoId, ref.fullName, !solo),
    },
  ];
  if (ref.type === 'local' || ref.type === 'remote') {
    items.push({
      label: pinned ? `Unpin ${ref.shortName}` : 'Pin to left',
      title: 'Keep this branch in its own lane at the left of the graph',
      onSelect: () => pinRef(repoId, ref.fullName, !pinned),
    });
  }
  const remote = ref.type === 'remote' ? /^refs\/remotes\/([^/]+)\//.exec(ref.fullName)?.[1] : undefined;
  if (remote) {
    const glob = `refs/remotes/${remote}/*`;
    const remoteHidden = vis.hidden.includes(glob);
    const remoteSolo = vis.solo.includes(glob);
    items.push(
      {
        label: remoteHidden ? `Show remote ${remote}` : `Hide remote ${remote}`,
        onSelect: () => hideRef(repoId, glob, !remoteHidden),
      },
      {
        label: remoteSolo ? `Unsolo remote ${remote}` : `Solo remote ${remote}`,
        onSelect: () => soloRef(repoId, glob, !remoteSolo),
      },
    );
  }
  if (vis.hidden.length || vis.solo.length) {
    items.push({ label: 'Show all branches', onSelect: () => showAllRefs(repoId) });
  }
  return items;
}

/** Hide / show entry for a stash (stashes are hidden by sha). */
export function stashVisibilityItems(repoId: RepoId, sha: Sha): MenuEntry[] {
  const key = stashKey(sha);
  const hidden = getRepoGraphState(repoId).vis.hidden.includes(key);
  return [
    { label: hidden ? 'Show stash in graph' : 'Hide stash', onSelect: () => hideRef(repoId, key, !hidden) },
  ];
}

/** Hide / show all refs of a left-panel section (spec 01 §4.5 section header menu). */
export function sectionVisibilityItems(repoId: RepoId, names: string[]): MenuEntry[] {
  return [
    { label: 'Hide all', onSelect: () => names.forEach((n) => hideRef(repoId, n, true)) },
    { label: 'Show all', onSelect: () => names.forEach((n) => hideRef(repoId, n, false)) },
    { label: 'Unsolo all', onSelect: () => names.forEach((n) => soloRef(repoId, n, false)) },
  ];
}

/**
 * Eye (hide) and solo toggles for a left-panel ref row (spec 01 §4.5). They appear on row hover and stay
 * visible while active: a gray crossed eye when hidden, an orange crosshair when soloed.
 */
export function RefVisibilityToggle({
  repoId,
  fullName,
  refs,
}: {
  repoId: RepoId;
  fullName: string;
  /** All refs of the repo (to tell "hidden by solo" apart). */
  refs?: readonly RefInput[];
}) {
  const { vis } = useRepoGraphState(repoId);
  const mark = refVisibilityMark(fullName, refs ?? [], vis);
  const pinned = vis.pinned.includes(fullName);
  const stop = (fn: () => void) => (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    fn();
  };
  return (
    <span className={`${styles.toggles} ${mark !== 'visible' || pinned ? styles.active : ''}`}>
      {pinned && (
        <button
          type="button"
          className={`${styles.btn} ${styles.pinned}`}
          title="Pinned to the left (click to unpin)"
          aria-label="Unpin"
          onClick={stop(() => pinRef(repoId, fullName, false))}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <Pin size={12} />
        </button>
      )}
      <button
        type="button"
        className={`${styles.btn} ${mark === 'solo' ? styles.solo : ''}`}
        title={mark === 'solo' ? 'Unsolo' : 'Solo: show only soloed branches'}
        aria-label={mark === 'solo' ? 'Unsolo' : 'Solo'}
        aria-pressed={mark === 'solo'}
        onClick={stop(() => soloRef(repoId, fullName, mark !== 'solo'))}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <Crosshair size={12} />
      </button>
      <button
        type="button"
        className={`${styles.btn} ${mark === 'hidden' || mark === 'hiddenBySolo' ? styles.hidden : ''}`}
        title={
          mark === 'hidden' ? 'Show in graph' : mark === 'hiddenBySolo' ? 'Hidden by solo' : 'Hide from graph'
        }
        aria-label={mark === 'hidden' ? 'Show' : 'Hide'}
        aria-pressed={mark === 'hidden'}
        onClick={stop(() => hideRef(repoId, fullName, mark !== 'hidden'))}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        {mark === 'hidden' || mark === 'hiddenBySolo' ? <EyeOff size={12} /> : <Eye size={12} />}
      </button>
    </span>
  );
}

/** Eye toggle for a stash row in the left panel. */
export function StashVisibilityToggle({ repoId, sha }: { repoId: RepoId; sha: Sha }) {
  const { vis } = useRepoGraphState(repoId);
  const key = stashKey(sha);
  const hidden = vis.hidden.includes(key);
  return (
    <span className={`${styles.toggles} ${hidden ? styles.active : ''}`}>
      <button
        type="button"
        className={`${styles.btn} ${hidden ? styles.hidden : ''}`}
        title={hidden ? 'Show in graph' : 'Hide from graph'}
        aria-label={hidden ? 'Show' : 'Hide'}
        aria-pressed={hidden}
        onClick={(e) => {
          e.stopPropagation();
          hideRef(repoId, key, !hidden);
        }}
      >
        {hidden ? <EyeOff size={12} /> : <Eye size={12} />}
      </button>
    </span>
  );
}

/** Toolbar chip: "3 hidden · Solo: 1 · Show all" (spec 04 §4.1 `GraphFilterChips`). */
export function VisibilityChip({ repoId, refs }: { repoId: RepoId; refs: readonly RefInput[] }) {
  const { vis } = useRepoGraphState(repoId);
  const solo = activeSolo(refs, vis);
  const hiddenCount = vis.hidden.filter(
    (h) => h.startsWith('stash:') || refs.some((r) => matchesRefPattern(r.fullName, h)),
  ).length;
  if (!solo.length && !hiddenCount) return null;
  return (
    <span className={styles.chip} role="status">
      {solo.length > 0 && (
        <span className={styles.chipSolo} title={solo.map((r) => r.shortName).join('\n')}>
          <Crosshair size={11} /> Solo: {solo.length}
        </span>
      )}
      {hiddenCount > 0 && (
        <span title={vis.hidden.join('\n')}>
          <EyeOff size={11} /> {hiddenCount} hidden
        </span>
      )}
      <button type="button" className={styles.chipBtn} onClick={() => showAllRefs(repoId)}>
        Show all
      </button>
    </span>
  );
}
