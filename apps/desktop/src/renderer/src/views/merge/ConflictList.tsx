import type { ConflictCode, ConflictFileInfo, RepoId, RepoOperationState } from '@githappens/git/types';
import { Binary, Check, CircleCheck, ExternalLink, FileCode, FileX, GitMerge, Undo2 } from 'lucide-react';
import { useRef, useState, type KeyboardEvent } from 'react';

import { useContextMenu, type MenuEntry } from '../../components/ContextMenu';
import { confirm } from '../../components/Dialogs';
import { invoke } from '../../lib/api';
import { basename, dirname } from '../../lib/format';
import { quiet, runOp } from '../../lib/ops';
import { useRepoUi, useRepoUiStore } from '../../stores/repo-ui';
import {
  openConflict,
  openExternalMergeTool,
  openInEditor,
  showInFolder,
  showInFolderLabel,
} from '../../tools/actions';
import { isTextConflict } from './banner-model';
import { setMergeSession, useConflictState } from './conflict-queries';
import { hasMarkers } from './merge-model';
import styles from './ConflictList.module.css';

export { allMarkersGone, isTextConflict } from './banner-model';

export const CODE_TEXT: Record<ConflictCode, string> = {
  UU: 'both modified',
  AA: 'both added',
  DU: 'deleted by current (A)',
  UD: 'deleted by incoming (B)',
  AU: 'added by current (A)',
  UA: 'added by incoming (B)',
  DD: 'both deleted',
};

export function openMergeTool(repoId: RepoId, path: string): void {
  useRepoUiStore.getState().update(repoId, () => ({ center: { kind: 'merge', path } }));
}

export function sideLabels(s: RepoOperationState | undefined): { a: string; b: string; tip: string } {
  const a = s?.current.label || 'current';
  const b = s?.incoming.label || 'incoming';
  const tip =
    s?.op === 'rebase'
      ? 'During a rebase, A (current) is the branch being rebased onto ("ours" in git) and B (incoming) is the commit being replayed ("theirs").'
      : 'A (current) is what git calls "ours"; B (incoming) is "theirs".';
  return { a, b, tip };
}

export async function takeSide(
  repoId: RepoId,
  paths: string[],
  side: 'ours' | 'theirs' | 'base',
  label: string,
): Promise<void> {
  for (const p of paths) setMergeSession(repoId, p, null);
  await runOp(
    repoId,
    { type: 'conflict.take', paths, side },
    {
      successToast: `Resolved ${paths.length === 1 ? basename(paths[0]!) : `${paths.length} files`} with ${label}`,
    },
  );
}

/** Mark resolved, warning first when a text file still contains conflict markers (spec 08 §4.5). */
export async function markResolved(repoId: RepoId, c: ConflictFileInfo): Promise<void> {
  if (isTextConflict(c)) {
    const markers =
      c.unresolvedChunks !== undefined
        ? c.unresolvedChunks > 0
        : await invoke('git:conflict:loadFile', { repoId, path: c.path })
            .then((f) => f.working != null && hasMarkers(f.working))
            .catch(() => false);
    if (markers) {
      const ok = await confirm(
        'Conflict markers remain',
        `${c.path} still contains conflict markers. Mark it as resolved anyway?`,
        'Mark resolved',
      );
      if (!ok) return;
    }
  }
  setMergeSession(repoId, c.path, null);
  await runOp(repoId, { type: 'conflict.markResolved', paths: [c.path] });
}

/** Re-create the conflict of a resolved-but-uncommitted file (spec 08 §4.2 "Mark unresolved"). */
export async function markUnresolved(repoId: RepoId, path: string): Promise<void> {
  const ok = await confirm(
    `Mark ${basename(path)} unresolved?`,
    'The conflict is re-created from both sides; the current resolution of this file is replaced.',
    'Mark unresolved',
    true,
  );
  if (!ok) return;
  setMergeSession(repoId, path, null);
  await runOp(repoId, { type: 'conflict.markUnresolved', paths: [path] });
}

function ConflictIcon({ c }: { c: ConflictFileInfo }) {
  if (c.code === 'DU' || c.code === 'UD' || c.code === 'DD') return <FileX size={14} aria-hidden />;
  if (c.kind !== 'text') return <Binary size={14} aria-hidden />;
  return <FileCode size={14} aria-hidden />;
}

function ChunkCount({ c }: { c: ConflictFileInfo }) {
  if (!isTextConflict(c) || c.unresolvedChunks === undefined) return null;
  const n = c.unresolvedChunks;
  return (
    <span
      className={`${styles.chunks} ${n === 0 ? styles.chunksDone : ''}`}
      title={
        n === 0
          ? 'No conflict markers left — ready to mark resolved'
          : `${n} unresolved conflict${n === 1 ? '' : 's'}`
      }
    >
      {n === 0 ? 'no markers' : `${n} conflict${n === 1 ? '' : 's'}`}
    </span>
  );
}

/**
 * Conflicted files for the right panel (spec 08 §4.2 `ConflictFileList`). Click / Enter / Ctrl+D opens the
 * merge tool; hover actions take a whole side or mark the file resolved; files resolved during the
 * operation stay listed with a ✓ (Mark unresolved re-creates the conflict).
 */
export function ConflictList({ repoId }: { repoId: RepoId }) {
  const state = useConflictState(repoId);
  const activePath = useRepoUi(repoId, (u) => (u.center.kind === 'merge' ? u.center.path : undefined));
  const showMenu = useContextMenu((s) => s.show);
  const [focus, setFocus] = useState(0);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);

  const files = state.data?.conflicts ?? [];
  const resolved = state.data?.op ? (state.data.resolvedPending ?? []) : [];
  if (!files.length && !resolved.length) return null;
  const labels = sideLabels(state.data);

  const menu = (c: ConflictFileInfo): MenuEntry[] => [
    { label: 'Open merge tool', shortcut: 'Ctrl+D', onSelect: () => openMergeTool(repoId, c.path) },
    'separator',
    {
      label: `Take current (A: ${labels.a})`,
      disabled: !c.stages.ours,
      title: c.stages.ours ? labels.tip : 'The file does not exist on this side',
      onSelect: () => quiet(takeSide(repoId, [c.path], 'ours', labels.a)),
    },
    {
      label: `Take incoming (B: ${labels.b})`,
      disabled: !c.stages.theirs,
      title: c.stages.theirs ? labels.tip : 'The file does not exist on this side',
      onSelect: () => quiet(takeSide(repoId, [c.path], 'theirs', labels.b)),
    },
    {
      label: 'Take base',
      disabled: !c.stages.base,
      title: c.stages.base
        ? "The common ancestor's version"
        : 'There is no common version (added on both sides)',
      onSelect: () => quiet(takeSide(repoId, [c.path], 'base', 'base')),
    },
    { label: 'Mark resolved', onSelect: () => quiet(markResolved(repoId, c)) },
    'separator',
    // spec 08 §4.2 context menu: external merge tool, editor, folder
    { label: 'Open in external merge tool', onSelect: () => void openExternalMergeTool(repoId, c.path) },
    { label: 'Open file in editor', onSelect: () => void openInEditor({ repoId, path: c.path }) },
    { label: showInFolderLabel(), onSelect: () => void showInFolder({ repoId, path: c.path }) },
    { label: 'Copy path', onSelect: () => void navigator.clipboard.writeText(c.path) },
  ];
  const resolvedMenu = (p: string): MenuEntry[] => [
    { label: 'Mark unresolved', onSelect: () => quiet(markUnresolved(repoId, p)) },
    'separator',
    { label: 'Open file in editor', onSelect: () => void openInEditor({ repoId, path: p }) },
    { label: showInFolderLabel(), onSelect: () => void showInFolder({ repoId, path: p }) },
    { label: 'Copy path', onSelect: () => void navigator.clipboard.writeText(p) },
  ];
  /** Click / Enter: the external tool when "use by default" is on (spec 08 §4.8), else the built-in one. */
  const open = (c: ConflictFileInfo): void =>
    isTextConflict(c)
      ? openConflict(repoId, c.path, () => openMergeTool(repoId, c.path))
      : openMergeTool(repoId, c.path);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const cur = Math.min(focus, files.length - 1);
    let next: number;
    if (e.key === 'ArrowDown') next = Math.min(files.length - 1, cur + 1);
    else if (e.key === 'ArrowUp') next = Math.max(0, cur - 1);
    else if (e.key === 'Enter' && files[cur]) {
      open(files[cur]);
      e.preventDefault();
      return;
    } else if ((e.ctrlKey || e.metaKey) && (e.key === 'd' || e.key === 'D') && files[cur]) {
      // Ctrl/⌘+D opens the built-in merge tool (spec 08 §4.2)
      openMergeTool(repoId, files[cur].path);
      e.preventDefault();
      return;
    } else return;
    e.preventDefault();
    setFocus(next);
    rowRefs.current[next]?.focus();
  };

  return (
    <section className={styles.section} aria-label="Conflicted files">
      <div className={styles.header}>
        <GitMerge size={14} aria-hidden />
        <span>
          Conflicted files ({files.length}){resolved.length ? ` · ${resolved.length} resolved` : ''}
        </span>
      </div>
      <p className={styles.hint} title={labels.tip}>
        A = {labels.a} (current) · B = {labels.b} (incoming)
      </p>
      <div role="listbox" aria-label="Conflicted files" onKeyDown={onKeyDown}>
        {files.map((c, i) => (
          <div
            key={c.path}
            ref={(el) => {
              rowRefs.current[i] = el;
            }}
            role="option"
            aria-selected={c.path === activePath}
            tabIndex={i === Math.min(focus, files.length - 1) ? 0 : -1}
            className={`${styles.row} ${c.path === activePath ? styles.active : ''}`}
            title={`${c.path} — ${CODE_TEXT[c.code]}${c.mergeDriver ? ` (merge driver ${c.mergeDriver})` : ''}`}
            onClick={() => {
              setFocus(i);
              open(c);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              showMenu(e.clientX, e.clientY, menu(c));
            }}
          >
            <span className={styles.icon}>
              <ConflictIcon c={c} />
            </span>
            <span className={styles.name}>{basename(c.path)}</span>
            <span className={styles.dir}>{dirname(c.path)}</span>
            <ChunkCount c={c} />
            <span className={styles.code}>{c.code}</span>
            <span className={styles.actions}>
              {c.stages.ours && (
                <button
                  type="button"
                  title={`Take current (A: ${labels.a}) for the whole file`}
                  onClick={(e) => {
                    e.stopPropagation();
                    quiet(takeSide(repoId, [c.path], 'ours', labels.a));
                  }}
                >
                  A
                </button>
              )}
              {c.stages.theirs && (
                <button
                  type="button"
                  title={`Take incoming (B: ${labels.b}) for the whole file`}
                  onClick={(e) => {
                    e.stopPropagation();
                    quiet(takeSide(repoId, [c.path], 'theirs', labels.b));
                  }}
                >
                  B
                </button>
              )}
              {isTextConflict(c) && (
                <button
                  type="button"
                  title="Open in external merge tool"
                  aria-label="Open in external merge tool"
                  onClick={(e) => {
                    e.stopPropagation();
                    void openExternalMergeTool(repoId, c.path);
                  }}
                >
                  <ExternalLink size={12} />
                </button>
              )}
              <button
                type="button"
                title="Mark resolved (stage)"
                aria-label="Mark resolved"
                onClick={(e) => {
                  e.stopPropagation();
                  quiet(markResolved(repoId, c));
                }}
              >
                <Check size={12} />
              </button>
            </span>
          </div>
        ))}
        {resolved.map((p) => (
          <div
            key={`resolved:${p}`}
            role="option"
            aria-selected={false}
            tabIndex={-1}
            className={`${styles.row} ${styles.resolvedRow}`}
            title={`${p} — resolved, will be included when you continue`}
            onContextMenu={(e) => {
              e.preventDefault();
              showMenu(e.clientX, e.clientY, resolvedMenu(p));
            }}
          >
            <span className={styles.icon}>
              <CircleCheck size={14} aria-label="resolved" />
            </span>
            <span className={styles.name}>{basename(p)}</span>
            <span className={styles.dir}>{dirname(p)}</span>
            <span className={styles.actions}>
              <button
                type="button"
                title="Mark unresolved (re-create the conflict)"
                aria-label="Mark unresolved"
                onClick={(e) => {
                  e.stopPropagation();
                  quiet(markUnresolved(repoId, p));
                }}
              >
                <Undo2 size={12} />
              </button>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
