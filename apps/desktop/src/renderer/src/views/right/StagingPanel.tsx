import type { RepoId } from '@githappens/git/types';
import {
  Archive,
  ArrowDownUp,
  ChevronDown,
  ChevronRight,
  Folder,
  List,
  ListTree,
  Minus,
  Plus,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';

import { discardAll } from '../../actions/git-actions';
import { fileMenu } from '../../actions/menus';
import { useContextMenu, type MenuEntry } from '../../components/ContextMenu';
import { basename, dirname } from '../../lib/format';
import { quiet, runOp } from '../../lib/ops';
import { useStatus } from '../../repo/queries';
import { useIsRunning } from '../../stores/ops';
import { useRepoUi, useRepoUiStore, type CenterView } from '../../stores/repo-ui';
import { wipDiffContext } from '../../tools/menus';
import { ShareCloudPatchButton } from '../cloud-patches/ShareCloudPatchButton';
import { discardRows, ignoreRows, stageAll, stageFiles, stashRows, unstageFiles } from '../composer/actions';
import { useComposer, useComposerStore } from '../composer/composer-store';
import {
  actionPaths,
  clickSelect,
  decodeDrag,
  emptySelection,
  encodeDrag,
  filesUnder,
  flattenRows,
  LARGE_CHANGESET,
  loadViewPrefs,
  opKeyMapper,
  opPathOf,
  pruneSelection,
  saveViewPrefs,
  visibleRange,
  wipDiffSpec,
  wipRows,
  WIP_DRAG_MIME,
  type FlatRow,
  type Selection,
  type SortKey,
  type ViewPrefs,
  type WipRow,
} from '../composer/staging-helpers';
import { LfsBadge } from '../lfs/LfsBadge';
import { useLfsLockMap, useLfsMatcher } from '../lfs/queries';
import { ConflictList } from '../merge/ConflictList';
import { stashFileMenuItems } from '../ops/branching-actions';
import { CommitComposer } from './CommitComposer';
import { PerfAdviceBanner } from './PerfAdviceBanner';
import styles from './RightPanel.module.css';
import s2 from './StagingPanel.module.css';

type Side = 'unstaged' | 'staged';

/** Fixed row height (px) used by the virtualized lists. */
const ROW_HEIGHT = 24;
/** Lists longer than this render only the visible window. */
const VIRTUALIZE_AT = 300;

const SORT_LABEL: Record<SortKey, string> = {
  path: 'Path',
  name: 'File name',
  status: 'Status',
  extension: 'Extension',
};

/** WIP panel (spec 06 §4): unstaged / staged / conflicted lists + commit composer. */
export function StagingPanel({ repoId }: { repoId: RepoId }) {
  const status = useStatus(repoId);
  const update = useRepoUiStore((s) => s.update);
  const showMenu = useContextMenu((s) => s.show);
  const activePath = useRepoUi(repoId, (u) => (u.center.kind === 'diff' ? u.center.path : undefined));
  const activeSide = useRepoUi(repoId, (u) => (u.center.kind === 'diff' ? u.center.stage?.side : undefined));
  const busy = useIsRunning(repoId, ['commit.create', 'wip.stageAll', 'wip.unstageAll']);
  const [view, setViewState] = useState<ViewPrefs>(() => loadViewPrefs(repoId));
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const eolWarnings = useComposer(repoId, (c) => c.eolWarnings);

  const setView = (patch: Partial<ViewPrefs>): void =>
    setViewState((v) => {
      const next = { ...v, ...patch };
      saveViewPrefs(repoId, next);
      return next;
    });

  const { unstaged, staged } = useMemo(() => wipRows(status.data?.entries ?? []), [status.data]);
  // selection / drag & drop work with shown paths; ops get raw keys where there are any
  const opKeys = useMemo(() => opKeyMapper([...unstaged, ...staged]), [unstaged, staged]);
  const conflictedCount = useMemo(
    () => (status.data?.entries ?? []).filter((e) => e.kind === 'unmerged').length,
    [status.data],
  );

  // EOL warnings only matter while the file still has changes
  useEffect(() => {
    const present = new Set([...unstaged, ...staged].map((r) => r.path));
    const cur = useComposerStore.getState().get(repoId).eolWarnings;
    const kept = Object.fromEntries(Object.entries(cur).filter(([p]) => present.has(p)));
    if (Object.keys(kept).length !== Object.keys(cur).length)
      useComposerStore.getState().update(repoId, () => ({ eolWarnings: kept }));
  }, [repoId, unstaged, staged]);

  const openDiff = useCallback(
    (f: WipRow, side: Side): void => {
      const center: CenterView =
        side === 'unstaged'
          ? {
              kind: 'diff',
              spec: wipDiffSpec(f, side),
              path: f.path,
              title: `Unstaged · ${f.path}`,
              oldRev: f.untracked ? '' : 'INDEX',
              newRev: f.status === 'D' ? '' : 'WORKTREE',
              stage: { side: 'unstaged', untracked: f.untracked, ...(f.rawKey ? { key: f.rawKey } : {}) },
            }
          : {
              kind: 'diff',
              spec: wipDiffSpec(f, side),
              path: f.path,
              oldPath: f.oldPath,
              title: `Staged · ${f.path}`,
              oldRev: f.status === 'A' ? '' : 'HEAD',
              newRev: f.status === 'D' ? '' : 'INDEX',
              stage: { side: 'staged', untracked: false, ...(f.rawKey ? { key: f.rawKey } : {}) },
            };
      update(repoId, () => ({ center }));
    },
    [repoId, update],
  );

  if (status.isLoading) return <SkeletonPanel />;
  const branch = status.data?.branch.head;
  const total = new Set([...unstaged, ...staged].map((f) => f.path)).size + conflictedCount;
  const large = unstaged.length + staged.length > LARGE_CHANGESET;
  const eolCount = Object.keys(eolWarnings).length;

  const sortMenu = (x: number, y: number): void =>
    showMenu(x, y, [
      ...(Object.keys(SORT_LABEL) as SortKey[]).map((k) => ({
        label: `${view.sort === k ? '✓ ' : ''}Sort by ${SORT_LABEL[k].toLowerCase()}`,
        onSelect: () => setView({ sort: k }),
      })),
      'separator' as const,
      {
        label: `${view.dir === 'asc' ? '✓ ' : ''}Ascending`,
        onSelect: () => setView({ dir: 'asc' }),
      },
      {
        label: `${view.dir === 'desc' ? '✓ ' : ''}Descending`,
        onSelect: () => setView({ dir: 'desc' }),
      },
    ]);

  return (
    <div className={`${styles.panel} ${s2.panel}`}>
      <div className={s2.scroll} ref={setScrollEl}>
        <div className={styles.header}>
          <div className={s2.headerRow}>
            <h2 className={styles.subject} style={{ flex: 1, minWidth: 0 }}>
              {total} file change{total === 1 ? '' : 's'}
              {branch && branch !== '(detached)' ? ` on ${branch}` : ''}
            </h2>
            <ShareCloudPatchButton repoId={repoId} hasChanges={total > 0} className={s2.iconBtn} />
          </div>
          <div className={s2.toolbar}>
            <div className={styles.segmented} role="group" aria-label="File view">
              <button
                type="button"
                aria-pressed={view.mode === 'path'}
                title="Path view"
                onClick={() => setView({ mode: 'path' })}
              >
                <List size={14} />
              </button>
              <button
                type="button"
                aria-pressed={view.mode === 'tree'}
                title="Tree view"
                onClick={() => setView({ mode: 'tree' })}
              >
                <ListTree size={14} />
              </button>
            </div>
            <button
              type="button"
              className={s2.iconBtn}
              aria-label="Sort files"
              title={`Sorted by ${SORT_LABEL[view.sort].toLowerCase()} (${view.dir === 'asc' ? 'ascending' : 'descending'})`}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                sortMenu(r.left, r.bottom + 2);
              }}
            >
              <ArrowDownUp size={14} />
            </button>
            <span style={{ flex: 1 }} />
            <button
              type="button"
              className={s2.iconBtn}
              disabled={total === 0}
              aria-label="Stash all changes"
              title="Stash all changes"
              onClick={() => void stashRows(repoId, [...unstaged, ...staged])}
            >
              <Archive size={14} />
            </button>
            <button
              type="button"
              className={s2.iconBtn}
              disabled={total === 0}
              onClick={() => void discardAll(repoId)}
              aria-label="Discard all changes"
              title="Discard all changes"
            >
              <Trash2 size={14} />
            </button>
          </div>
          {status.data?.truncatedUntracked && (
            <p className={styles.note}>Large number of untracked files; showing folders.</p>
          )}
          {large && (
            <p className={s2.banner} role="status">
              Large number of changes — tree view collapsed by default.
            </p>
          )}
          {eolCount > 0 && <EolBanner repoId={repoId} count={eolCount} />}
          <PerfAdviceBanner repoId={repoId} />
        </div>

        <ConflictList repoId={repoId} />

        <WipSection
          repoId={repoId}
          side="unstaged"
          title={`Unstaged Files (${unstaged.length})`}
          rows={unstaged}
          view={view}
          large={large}
          scrollEl={scrollEl}
          activePath={activeSide !== 'staged' ? activePath : undefined}
          eolWarnings={eolWarnings}
          opKeys={opKeys}
          onOpen={(f) => openDiff(f, 'unstaged')}
          actions={
            <button
              type="button"
              className={s2.headerBtn}
              disabled={unstaged.length === 0 || busy}
              onClick={() => void stageAll(repoId)}
              title="Stage all changes (Ctrl+Shift+S)"
            >
              Stage all changes
            </button>
          }
        />
        <WipSection
          repoId={repoId}
          side="staged"
          title={`Staged Files (${staged.length})`}
          rows={staged}
          view={view}
          large={large}
          scrollEl={scrollEl}
          activePath={activeSide === 'staged' ? activePath : undefined}
          eolWarnings={eolWarnings}
          opKeys={opKeys}
          onOpen={(f) => openDiff(f, 'staged')}
          actions={
            <button
              type="button"
              className={s2.headerBtn}
              disabled={staged.length === 0 || busy}
              onClick={() => quiet(runOp(repoId, { type: 'wip.unstageAll' }))}
              title="Unstage all changes (Ctrl+Shift+U)"
            >
              Unstage all changes
            </button>
          }
        />
        {total === 0 && <p className={s2.clean}>Working directory clean</p>}
      </div>
      <CommitComposer
        repoId={repoId}
        stagedCount={staged.length}
        unstagedCount={unstaged.length}
        staged={staged}
      />
    </div>
  );
}

function SkeletonPanel() {
  return (
    <div className={`${styles.panel} ${s2.panel}`} aria-busy="true" aria-label="Loading changes">
      <div className={s2.scroll}>
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className={s2.skeleton} style={{ width: `${60 + ((i * 37) % 35)}%` }} />
        ))}
      </div>
    </div>
  );
}

function EolBanner({ repoId, count }: { repoId: RepoId; count: number }) {
  const dismissed = useComposer(repoId, (c) => c.eolBannerDismissed);
  if (dismissed) return null;
  return (
    <div className={s2.banner} role="status">
      <span>
        Line endings of {count} file{count === 1 ? '' : 's'} will be converted by Git. Configure{' '}
        <code>core.autocrlf</code> or a <code>.gitattributes</code> <code>eol</code> rule to make this
        explicit.
      </span>
      <button
        type="button"
        className={s2.linkBtn}
        onClick={() => useComposerStore.getState().dismissEolBanner(repoId)}
      >
        Dismiss
      </button>
    </div>
  );
}

const STATUS_CLASS: Record<WipRow['status'], string> = {
  A: 'added',
  '?': 'added',
  D: 'deleted',
  M: 'modified',
  T: 'modified',
  U: 'deleted',
  R: 'renamed',
  C: 'renamed',
};
const STATUS_LABEL: Record<WipRow['status'], string> = {
  A: 'Added',
  '?': 'Untracked',
  D: 'Deleted',
  M: 'Modified',
  T: 'Type changed',
  U: 'Conflicted',
  R: 'Renamed',
  C: 'Copied',
};
/** Indicator for names that are not valid UTF-8 (spec 02 §8). */
const RAW_NAME_NOTE =
  'This file name is not valid UTF-8: invalid bytes are shown as replacement characters. Actions use the exact name.';

const EOL_TEXT = {
  'lf-to-crlf': 'LF will be replaced by CRLF the next time Git touches this file',
  'crlf-to-lf': 'CRLF will be replaced by LF in the repository',
} as const;

interface SectionProps {
  repoId: RepoId;
  side: Side;
  title: string;
  rows: WipRow[];
  view: ViewPrefs;
  large: boolean;
  scrollEl: HTMLElement | null;
  activePath?: string;
  eolWarnings: Record<string, 'lf-to-crlf' | 'crlf-to-lf'>;
  /** Shown paths → the paths ops take (raw keys for names that are not valid UTF-8). */
  opKeys(paths: string[]): string[];
  onOpen(f: WipRow): void;
  actions: ReactNode;
}

/** One file section (spec 06 §4.3): selection, keyboard, context menu, drag & drop, virtualization. */
function WipSection(props: SectionProps) {
  const { repoId, side, rows, view, scrollEl } = props;
  const showMenu = useContextMenu((s) => s.show);
  const [rawSel, setSel] = useState<Selection>(emptySelection);
  const [toggled, setToggled] = useState<ReadonlySet<string>>(() => new Set());
  const [cursor, setCursor] = useState<string | null>(null);
  const [dropOver, setDropOver] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  const flat = useMemo(
    () => flattenRows(rows, view, toggled, props.large),
    [rows, view, toggled, props.large],
  );
  const order = useMemo(
    () =>
      flat
        .filter((r): r is Extract<FlatRow<WipRow>, { kind: 'file' }> => r.kind === 'file')
        .map((r) => r.row.path),
    [flat],
  );
  const byPath = useMemo(() => new Map(rows.map((r) => [r.path, r])), [rows]);
  // LFS tag + lock marker on tracked files (spec 09 §2)
  const isLfs = useLfsMatcher(repoId);
  const anyLfs = useMemo(() => rows.some((r) => isLfs(r.path)), [rows, isLfs]);
  const lfsLocks = useLfsLockMap(repoId, anyLfs);

  // the selection only ever holds listed files (status refreshes drop the others)
  const sel = useMemo(() => pruneSelection(rawSel, new Set(byPath.keys())), [rawSel, byPath]);

  const otherSide: Side = side === 'unstaged' ? 'staged' : 'unstaged';
  const rowsOf = (paths: string[]): WipRow[] =>
    paths.map((p) => byPath.get(p)).filter((r): r is WipRow => !!r);
  const selectedPaths = (): string[] => order.filter((p) => sel.paths.has(p));
  const targetPaths = (): string[] => {
    const s = selectedPaths();
    return s.length ? s : cursor && byPath.has(cursor) ? [cursor] : [];
  };
  const toggleStage = (paths: string[]): void =>
    side === 'unstaged'
      ? void stageFiles(repoId, props.opKeys(paths))
      : unstageFiles(repoId, props.opKeys(paths));

  const menuFor = (targets: WipRow[], x: number, y: number): void => {
    const n = targets.length;
    const one = n === 1 ? targets[0]! : null;
    const paths = targets.map((t) => t.path);
    const untracked = targets.filter((t) => t.untracked);
    const tracked = targets.filter((t) => !t.untracked && t.status !== 'A');
    const items: MenuEntry[] = [
      side === 'unstaged'
        ? {
            label: n === 1 ? 'Stage file' : `Stage ${n} files`,
            shortcut: 'Space',
            onSelect: () => toggleStage(paths),
          }
        : {
            label: n === 1 ? 'Unstage file' : `Unstage ${n} files`,
            shortcut: 'Space',
            onSelect: () => toggleStage(paths),
          },
    ];
    if (side === 'unstaged') {
      items.push({
        label: n === 1 ? 'Discard changes' : `Discard changes in ${n} files`,
        shortcut: 'Del',
        danger: true,
        onSelect: () => void discardRows(repoId, targets),
      });
    }
    items.push(...stashFileMenuItems(repoId, targets.map(opPathOf)));
    items.push('separator');
    if (untracked.length) {
      const sample = untracked[0]!;
      const ext = basename(sample.path).includes('.')
        ? basename(sample.path).slice(basename(sample.path).lastIndexOf('.'))
        : null;
      const dir = dirname(sample.path);
      items.push({
        label:
          untracked.length === 1 ? `Ignore ${basename(sample.path)}` : `Ignore ${untracked.length} files`,
        onSelect: () => void ignoreRows(repoId, 'file', untracked),
      });
      if (ext && untracked.length === 1)
        items.push({
          label: `Ignore all *${ext} files`,
          onSelect: () => void ignoreRows(repoId, 'extension', untracked),
        });
      if (dir && untracked.length === 1)
        items.push({
          label: `Ignore folder ${dir}/`,
          onSelect: () => void ignoreRows(repoId, 'folder', untracked),
        });
    }
    if (tracked.length) {
      items.push({
        label:
          tracked.length === 1
            ? 'Ignore and stop tracking'
            : `Ignore and stop tracking ${tracked.length} files`,
        title: 'Add to .gitignore and remove from the repository (the files stay on disk)',
        onSelect: () => void ignoreRows(repoId, 'file', tracked, true),
      });
    }
    if (one) {
      items.push(
        'separator',
        ...fileMenu(repoId, opPathOf(one), one.status !== 'D', wipDiffContext(one, side)),
      );
    }
    showMenu(x, y, items);
  };

  const folderMenu = (folder: string, x: number, y: number): void => {
    const under = filesUnder(rows, folder);
    const items: MenuEntry[] = [
      {
        label: side === 'unstaged' ? 'Stage folder' : 'Unstage folder',
        onSelect: () => toggleStage(under.map((r) => r.path)),
      },
      ...(side === 'unstaged'
        ? [
            {
              label: 'Discard folder',
              danger: true,
              onSelect: () => void discardRows(repoId, under),
            },
          ]
        : []),
      { label: 'Stash folder', onSelect: () => void stashRows(repoId, under) },
      ...(under.some((r) => r.untracked)
        ? [
            'separator' as const,
            {
              label: `Ignore folder ${folder}/`,
              // ignorePatternFor('folder', p) names the parent folder of p
              onSelect: () => void ignoreRows(repoId, 'folder', [{ ...under[0]!, path: `${folder}/_` }]),
            },
          ]
        : []),
    ];
    showMenu(x, y, items);
  };

  const onRowClick = (f: WipRow, e: React.MouseEvent): void => {
    const ctrl = e.ctrlKey || e.metaKey;
    setSel((s) => clickSelect(s, order, f.path, { ctrl, shift: e.shiftKey }));
    setCursor(f.path);
    if (!ctrl && !e.shiftKey) props.onOpen(f);
  };

  const moveCursor = (dir: 1 | -1, extend: boolean): void => {
    if (!order.length) return;
    const i = cursor ? order.indexOf(cursor) : -1;
    const next = order[Math.max(0, Math.min(order.length - 1, i < 0 ? 0 : i + dir))]!;
    setCursor(next);
    setSel((s) =>
      extend
        ? clickSelect(s, order, next, { ctrl: false, shift: true })
        : { paths: new Set([next]), anchor: next },
    );
    const f = byPath.get(next);
    if (f && !extend) props.onOpen(f);
    scrollIntoView(next);
  };

  const scrollIntoView = (p: string): void => {
    const idx = flat.findIndex((r) => r.kind === 'file' && r.row.path === p);
    const ul = listRef.current;
    if (idx < 0 || !ul || !scrollEl) return;
    const top = ul.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop;
    const y = top + idx * ROW_HEIGHT;
    if (y < scrollEl.scrollTop) scrollEl.scrollTo({ top: y });
    else if (y + ROW_HEIGHT > scrollEl.scrollTop + scrollEl.clientHeight)
      scrollEl.scrollTo({ top: y + ROW_HEIGHT - scrollEl.clientHeight });
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    if (k === 'ArrowDown' || k === 'ArrowUp') {
      e.preventDefault();
      moveCursor(k === 'ArrowDown' ? 1 : -1, e.shiftKey);
    } else if (
      k === ' ' ||
      (!mod &&
        ((k.toLowerCase() === 's' && side === 'unstaged') || (k.toLowerCase() === 'u' && side === 'staged')))
    ) {
      const t = targetPaths();
      if (!t.length) return;
      e.preventDefault();
      toggleStage(t);
    } else if ((k === 'Delete' || k === 'Backspace') && side === 'unstaged') {
      const t = rowsOf(targetPaths());
      if (!t.length) return;
      e.preventDefault();
      void discardRows(repoId, t);
    } else if (k === 'Enter') {
      const f = cursor ? byPath.get(cursor) : undefined;
      if (f) props.onOpen(f);
    } else if (mod && k.toLowerCase() === 'a') {
      e.preventDefault();
      e.stopPropagation();
      setSel({ paths: new Set(order), anchor: order[0] ?? null });
    } else if (k === 'Escape' && sel.paths.size) {
      e.stopPropagation();
      setSel(emptySelection());
    } else if (k === 'ContextMenu' || (e.shiftKey && k === 'F10')) {
      const t = rowsOf(targetPaths());
      if (!t.length) return;
      e.preventDefault();
      const r = listRef.current?.getBoundingClientRect();
      menuFor(t, (r?.left ?? 0) + 20, (r?.top ?? 0) + 20);
    }
  };

  // ---- drag & drop between the sections ----
  const onDragStart = (f: WipRow, e: DragEvent): void => {
    const paths = actionPaths(sel, f.path, order);
    e.dataTransfer.setData(WIP_DRAG_MIME, encodeDrag(side, paths));
    e.dataTransfer.setData('text/plain', paths.join('\n'));
    e.dataTransfer.effectAllowed = 'move';
  };
  const acceptsDrop = (e: DragEvent): boolean => e.dataTransfer.types.includes(WIP_DRAG_MIME);
  const onDrop = (e: DragEvent): void => {
    setDropOver(false);
    const d = decodeDrag(e.dataTransfer.getData(WIP_DRAG_MIME));
    if (!d || d.side !== otherSide) return;
    e.preventDefault();
    if (side === 'staged') void stageFiles(repoId, props.opKeys(d.paths));
    else unstageFiles(repoId, props.opKeys(d.paths));
  };

  // ---- virtualization (shared scroll container) ----
  const [range, setRange] = useState({ start: 0, end: VIRTUALIZE_AT });
  const virtual = flat.length > VIRTUALIZE_AT;
  useEffect(() => {
    if (!virtual || !scrollEl) return;
    const recompute = (): void => {
      const ul = listRef.current;
      if (!ul) return;
      const top = ul.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop;
      const r = visibleRange(flat.length, ROW_HEIGHT, top, scrollEl.scrollTop, scrollEl.clientHeight);
      setRange((prev) => (prev.start === r.start && prev.end === r.end ? prev : r));
    };
    recompute();
    scrollEl.addEventListener('scroll', recompute, { passive: true });
    const ro = new ResizeObserver(recompute);
    ro.observe(scrollEl);
    return () => {
      scrollEl.removeEventListener('scroll', recompute);
      ro.disconnect();
    };
  }, [virtual, scrollEl, flat.length]);
  const shown = virtual ? flat.slice(range.start, range.end) : flat;

  const renderRow = (r: FlatRow<WipRow>): ReactNode => {
    if (r.kind === 'folder') {
      const under = (): WipRow[] => filesUnder(rows, r.path);
      return (
        <li
          key={r.key}
          role="treeitem"
          aria-expanded={!r.collapsed}
          className={s2.row}
          style={{ paddingLeft: 14 + r.depth * 14 }}
          onClick={() =>
            setToggled((t) => {
              const next = new Set(t);
              if (next.has(r.path)) next.delete(r.path);
              else next.add(r.path);
              return next;
            })
          }
          onContextMenu={(e) => {
            e.preventDefault();
            folderMenu(r.path, e.clientX, e.clientY);
          }}
          title={r.path}
        >
          {r.collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
          <Folder size={13} className={s2.folderIcon} />
          <span className={styles.fileName}>{r.name}</span>
          <span className={s2.count}>{r.count}</span>
          <span className={s2.rowActions}>
            {side === 'unstaged' && (
              <button
                type="button"
                className={s2.rowBtn}
                aria-label={`Discard folder ${r.path}`}
                title="Discard folder"
                onClick={(e) => {
                  e.stopPropagation();
                  void discardRows(repoId, under());
                }}
              >
                <Trash2 size={12} />
              </button>
            )}
            <button
              type="button"
              className={s2.rowBtn}
              aria-label={`${side === 'unstaged' ? 'Stage' : 'Unstage'} folder ${r.path}`}
              title={side === 'unstaged' ? 'Stage folder' : 'Unstage folder'}
              onClick={(e) => {
                e.stopPropagation();
                toggleStage(under().map((f) => f.path));
              }}
            >
              {side === 'unstaged' ? <Plus size={13} /> : <Minus size={13} />}
              {side === 'unstaged' ? 'Stage folder' : 'Unstage folder'}
            </button>
          </span>
        </li>
      );
    }
    const f = r.row;
    const selected = sel.paths.has(f.path);
    const active = props.activePath === f.path;
    const eol = props.eolWarnings[f.path];
    const dir = view.mode === 'path' ? dirname(f.path) : '';
    return (
      <li
        key={r.key}
        role="option"
        aria-selected={selected}
        data-path={f.path}
        draggable
        onDragStart={(e) => onDragStart(f, e)}
        className={`${s2.row} ${selected ? s2.selected : ''} ${active ? styles.activeFile : ''} ${
          cursor === f.path ? s2.cursor : ''
        }`}
        style={view.mode === 'tree' ? { paddingLeft: 14 + r.depth * 14 + 17 } : undefined}
        onClick={(e) => onRowClick(f, e)}
        onDoubleClick={() => toggleStage([f.path])}
        onContextMenu={(e) => {
          e.preventDefault();
          let paths = actionPaths(sel, f.path, order);
          if (!sel.paths.has(f.path)) {
            setSel({ paths: new Set([f.path]), anchor: f.path });
            paths = [f.path];
          }
          menuFor(rowsOf(paths), e.clientX, e.clientY);
        }}
        title={`${f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}${f.rawKey || f.oldRawKey ? ` (${RAW_NAME_NOTE})` : ''}`}
      >
        <span
          className={`${styles.status} ${styles[STATUS_CLASS[f.status]]}`}
          aria-label={STATUS_LABEL[f.status]}
        >
          {f.status === '?' ? '+' : f.status}
        </span>
        <span className={styles.fileName}>
          {f.oldPath && view.mode === 'path' ? `${basename(f.oldPath)} → ` : ''}
          {basename(f.path)}
        </span>
        {dir && <span className={styles.fileDir}>{dir}</span>}
        {(f.rawKey || f.oldRawKey) && (
          <span className={s2.eolBadge} title={RAW_NAME_NOTE} aria-label={RAW_NAME_NOTE} data-raw-name>
            bytes
          </span>
        )}
        {isLfs(f.path) && <LfsBadge lock={lfsLocks.get(f.path)} />}
        {eol && (
          <span className={s2.eolBadge} title={EOL_TEXT[eol]} aria-label={EOL_TEXT[eol]}>
            {eol === 'lf-to-crlf' ? 'CRLF' : 'LF'}
          </span>
        )}
        <span className={s2.rowActions}>
          {side === 'unstaged' && (
            <button
              type="button"
              className={s2.rowBtn}
              aria-label={`Discard ${f.path}`}
              title="Discard changes (Delete)"
              onClick={(e) => {
                e.stopPropagation();
                void discardRows(repoId, [f]);
              }}
            >
              <Trash2 size={12} />
            </button>
          )}
          <button
            type="button"
            className={s2.rowBtn}
            aria-label={side === 'unstaged' ? `Stage ${f.path}` : `Unstage ${f.path}`}
            title={side === 'unstaged' ? 'Stage file (Space)' : 'Unstage file (Space)'}
            onClick={(e) => {
              e.stopPropagation();
              toggleStage(actionPaths(sel, f.path, order));
            }}
          >
            {side === 'unstaged' ? <Plus size={13} /> : <Minus size={13} />}
            {side === 'unstaged' ? 'Stage' : 'Unstage'}
          </button>
        </span>
      </li>
    );
  };

  return (
    <section
      className={dropOver ? s2.dropTarget : undefined}
      onDragOver={(e) => {
        if (!acceptsDrop(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (!dropOver) setDropOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropOver(false);
      }}
      onDrop={onDrop}
      aria-label={props.title}
    >
      <div className={s2.sectionHeader}>
        <h3 className={styles.groupTitle} style={{ padding: 0 }}>
          {props.title}
        </h3>
        <div className={s2.actions}>
          {sel.paths.size > 1 && <span className={s2.selCount}>{sel.paths.size} selected</span>}
          {props.actions}
        </div>
      </div>
      {rows.length === 0 ? (
        <p className={s2.empty}>{side === 'staged' ? 'No staged files' : 'No unstaged changes'}</p>
      ) : (
        <ul
          ref={listRef}
          className={styles.fileList}
          role={view.mode === 'tree' ? 'tree' : 'listbox'}
          aria-multiselectable
          aria-label={side === 'unstaged' ? 'Unstaged files' : 'Staged files'}
          tabIndex={0}
          onKeyDown={onKeyDown}
          style={
            virtual
              ? {
                  paddingTop: range.start * ROW_HEIGHT,
                  paddingBottom: (flat.length - range.end) * ROW_HEIGHT,
                }
              : undefined
          }
        >
          {shown.map(renderRow)}
        </ul>
      )}
    </section>
  );
}
