import type { FileDiff, RepoId } from '@githappens/git/types';
import { ChevronDown, ChevronRight, Folder, List, ListTree } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';

import { basename, buildTree, dirname, type TreeNode } from '../../lib/format';
import { MAX_LISTED_FILES } from '../diff/large-file';
import { useDiffNavStore } from '../diff/nav-store';
import styles from './RightPanel.module.css';

export interface FileEntry {
  path: string;
  oldPath?: string;
  status: FileDiff['status'] | '?';
  additions?: number | null;
  deletions?: number | null;
  /** "View all files": a file of the tree the commit didn't change. */
  unchanged?: boolean;
}

const STATUS_CLASS: Record<FileEntry['status'], string> = {
  A: 'added',
  '?': 'added',
  D: 'deleted',
  M: 'modified',
  T: 'modified',
  U: 'deleted',
  R: 'renamed',
  C: 'renamed',
};

const STATUS_LABEL: Record<FileEntry['status'], string> = {
  A: 'Added',
  '?': 'Untracked',
  D: 'Deleted',
  M: 'Modified',
  T: 'Type changed',
  U: 'Conflicted',
  R: 'Renamed',
  C: 'Copied',
};

/** Totals for the toolbar summary (spec 07 §4.2: `+a −d`, per-status counts). */
export function fileCounts(files: FileEntry[]): {
  additions: number;
  deletions: number;
  byStatus: Partial<Record<FileEntry['status'], number>>;
  changed: number;
} {
  let additions = 0;
  let deletions = 0;
  let changed = 0;
  const byStatus: Partial<Record<FileEntry['status'], number>> = {};
  for (const f of files) {
    if (f.unchanged) continue;
    changed++;
    additions += f.additions ?? 0;
    deletions += f.deletions ?? 0;
    byStatus[f.status] = (byStatus[f.status] ?? 0) + 1;
  }
  return { additions, deletions, byStatus, changed };
}

/** Case-insensitive substring filter on paths (old and new). */
export function filterFiles(files: FileEntry[], q: string): FileEntry[] {
  const t = q.trim().toLowerCase();
  if (!t) return files;
  return files.filter((f) => f.path.toLowerCase().includes(t) || !!f.oldPath?.toLowerCase().includes(t));
}

/** Keyboard ↑/↓ debounce while a key is held (spec 07 §4.2: 300 ms). */
const KEY_DEBOUNCE_MS = 300;

/**
 * File list for commits / comparisons / WIP with path vs tree view (spec 07 §4.2): filter box, counts
 * summary, "View all files", truncation above 5,000 files and keyboard navigation.
 */
export function FileList(props: {
  files: FileEntry[];
  activePath?: string;
  onOpen(f: FileEntry): void;
  /** Right-click handler (spec 07 file actions: history, blame, …). */
  onMenu?(f: FileEntry, x: number, y: number): void;
  viewKey: string;
  /** Show the filter box and counts summary. */
  toolbar?: boolean;
  /** "View all files" checkbox (commit lists). */
  viewAll?: { checked: boolean; loading?: boolean; onChange(checked: boolean): void };
  /** Register the visible order for next/previous file in the diff viewer. */
  navRepoId?: RepoId;
  /** Total count when the caller already truncated the list (e.g. numstat skipped). */
  totalCount?: number;
}) {
  const [mode, setMode] = useState<'path' | 'tree'>(() => {
    try {
      return (localStorage.getItem(`fileView:${props.viewKey}`) as 'path' | 'tree') ?? 'path';
    } catch {
      return 'path';
    }
  });
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const filtered = useMemo(() => filterFiles(props.files, query), [props.files, query]);
  const truncated = !showAll && filtered.length > MAX_LISTED_FILES;
  const visible = useMemo(
    () => (truncated ? filtered.slice(0, MAX_LISTED_FILES) : filtered),
    [filtered, truncated],
  );
  const tree = useMemo(() => (mode === 'tree' ? buildTree(visible, (f) => f.path) : []), [visible, mode]);
  const counts = useMemo(() => fileCounts(props.files), [props.files]);
  const listRef = useRef<HTMLUListElement>(null);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusPath = cursor ?? props.activePath;

  const setView = (m: 'path' | 'tree'): void => {
    setMode(m);
    try {
      localStorage.setItem(`fileView:${props.viewKey}`, m);
    } catch {
      /* storage unavailable */
    }
  };

  // next/previous file in the diff viewer follows this list's visible order
  const { navRepoId, onOpen } = props;
  const openRef = useRef(onOpen);
  useEffect(() => {
    openRef.current = onOpen;
  });
  useEffect(() => {
    if (!navRepoId) return;
    const changed = visible.filter((f) => !f.unchanged);
    return useDiffNavStore.getState().register(navRepoId, {
      paths: changed.map((f) => f.path),
      open: (p) => {
        const f = changed.find((x) => x.path === p);
        if (f) openRef.current(f);
      },
    });
  }, [navRepoId, visible]);

  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const onKeyDown = (e: ReactKeyboardEvent): void => {
    if (e.target instanceof HTMLInputElement) return;
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Enter') return;
    const order = visible;
    if (!order.length) return;
    const i = order.findIndex((f) => f.path === focusPath);
    if (e.key === 'Enter') {
      const f = order[i];
      if (f) props.onOpen(f);
      e.preventDefault();
      return;
    }
    const next =
      order[Math.max(0, Math.min(order.length - 1, i < 0 ? 0 : i + (e.key === 'ArrowDown' ? 1 : -1)))]!;
    e.preventDefault();
    setCursor(next.path);
    listRef.current
      ?.querySelector<HTMLElement>(`[data-path="${CSS.escape(next.path)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
    // the diff follows the cursor, debounced while the key is held
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => props.onOpen(next), e.repeat ? KEY_DEBOUNCE_MS : 0);
  };

  const rowProps = { activePath: focusPath, onOpen: props.onOpen, onMenu: props.onMenu };
  const statusSummary = (['A', 'M', 'D', 'R', 'C', 'T', 'U', '?'] as const)
    .filter((s) => counts.byStatus[s])
    .map((s) => `${counts.byStatus[s]} ${STATUS_LABEL[s].toLowerCase()}`)
    .join(', ');
  const total = props.totalCount ?? filtered.length;

  return (
    <div className={styles.files}>
      <div className={styles.filesHeader}>
        <span title={statusSummary}>
          {counts.changed} file{counts.changed === 1 ? '' : 's'}
          {props.toolbar && (counts.additions > 0 || counts.deletions > 0) && (
            <>
              {' · '}
              <span className={styles.plus}>+{counts.additions}</span>{' '}
              <span className={styles.minus}>−{counts.deletions}</span>
            </>
          )}
        </span>
        <div className={styles.segmented} role="group" aria-label="File view">
          <button
            type="button"
            aria-pressed={mode === 'path'}
            title="Path view"
            onClick={() => setView('path')}
          >
            <List size={14} />
          </button>
          <button
            type="button"
            aria-pressed={mode === 'tree'}
            title="Tree view"
            onClick={() => setView('tree')}
          >
            <ListTree size={14} />
          </button>
        </div>
      </div>
      {props.toolbar && (
        <div className={styles.filesToolbar}>
          <input
            type="search"
            className={styles.fileFilter}
            placeholder="Filter files"
            aria-label="Filter files"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {props.viewAll && (
            <label className={styles.viewAll} title="Show every file of the commit's tree">
              <input
                type="checkbox"
                checked={props.viewAll.checked}
                onChange={(e) => props.viewAll!.onChange(e.target.checked)}
              />
              {props.viewAll.loading ? 'Loading…' : 'View all files'}
            </label>
          )}
        </div>
      )}
      {props.toolbar && statusSummary && <div className={styles.statusSummary}>{statusSummary}</div>}
      {(truncated || total > visible.length) && (
        <div className={styles.truncated}>
          Showing first {visible.length.toLocaleString()} of {total.toLocaleString()} files
          {truncated && (
            <>
              {' · '}
              <button type="button" className={styles.link} onClick={() => setShowAll(true)}>
                Show all
              </button>
            </>
          )}
        </div>
      )}
      <ul
        ref={listRef}
        className={styles.fileList}
        role={mode === 'tree' ? 'tree' : 'list'}
        tabIndex={0}
        aria-label="Changed files"
        onKeyDown={onKeyDown}
      >
        {mode === 'path'
          ? visible.map((f) => <FileRow key={f.path} f={f} {...rowProps} />)
          : tree.map((n) => <TreeRow key={n.path} node={n} depth={0} {...rowProps} />)}
      </ul>
    </div>
  );
}

function FileRow(props: {
  f: FileEntry;
  activePath?: string;
  onOpen(f: FileEntry): void;
  onMenu?(f: FileEntry, x: number, y: number): void;
  depth?: number;
  label?: string;
}) {
  const { f } = props;
  const dir = dirname(f.path);
  return (
    <li data-path={f.path}>
      <button
        type="button"
        tabIndex={-1}
        className={`${styles.fileRow} ${props.activePath === f.path ? styles.activeFile : ''} ${
          f.unchanged ? styles.unchangedFile : ''
        }`}
        style={props.depth !== undefined ? { paddingLeft: 10 + props.depth * 14 } : undefined}
        title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
        onClick={() => props.onOpen(f)}
        onContextMenu={(e) => {
          if (!props.onMenu) return;
          e.preventDefault();
          props.onMenu(f, e.clientX, e.clientY);
        }}
      >
        <span
          className={`${styles.status} ${f.unchanged ? '' : styles[STATUS_CLASS[f.status]]}`}
          aria-label={f.unchanged ? 'Unchanged' : STATUS_LABEL[f.status]}
        >
          {f.unchanged ? '' : f.status === '?' ? 'A' : f.status}
        </span>
        <span className={styles.fileName}>{props.label ?? basename(f.path)}</span>
        {props.label === undefined && dir && <span className={styles.fileDir}>{dir}</span>}
        {(f.additions ?? 0) + (f.deletions ?? 0) > 0 && (
          <span className={styles.stat}>
            {!!f.additions && <span className={styles.plus}>+{f.additions}</span>}
            {!!f.deletions && <span className={styles.minus}>−{f.deletions}</span>}
          </span>
        )}
      </button>
    </li>
  );
}

function TreeRow(props: {
  node: TreeNode<FileEntry>;
  depth: number;
  activePath?: string;
  onOpen(f: FileEntry): void;
  onMenu?(f: FileEntry, x: number, y: number): void;
}) {
  const [open, setOpen] = useState(true);
  const { node, depth } = props;
  if (node.item)
    return (
      <FileRow
        f={node.item}
        depth={depth}
        label={node.name}
        activePath={props.activePath}
        onOpen={props.onOpen}
        onMenu={props.onMenu}
      />
    );
  return (
    <li>
      <button
        type="button"
        tabIndex={-1}
        className={styles.fileRow}
        style={{ paddingLeft: 10 + depth * 14 }}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <Folder size={13} />
        <span className={styles.fileName}>{node.name}</span>
      </button>
      {open && (
        <ul className={styles.fileList}>
          {node.children.map((c) => (
            <TreeRow key={c.path} {...props} node={c} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}
