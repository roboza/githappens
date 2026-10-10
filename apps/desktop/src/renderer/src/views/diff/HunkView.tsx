import type { LineRef } from '@githappens/git/ops';
import type { DiffHunk, DiffSpec, FileDiff, RepoId } from '@githappens/git/types';
import { Undo2 } from 'lucide-react';
import { useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';

import { useContextMenu, type MenuEntry } from '../../components/ContextMenu';
import { confirm } from '../../components/Dialogs';
import { quiet, runOp } from '../../lib/ops';
import { codeStyle, type EditorPrefs } from './editor-prefs';
import { isChange, paintLine, rangeSelect, selKey, splitRows, toLineRefs } from './line-selection';
import { hunkWordDiff, segments, type Range } from './word-diff';
import type { ChangeNav } from './nav';
import styles from './DiffView.module.css';

export interface StagingCtx {
  repoId: RepoId;
  path: string;
  side: 'unstaged' | 'staged';
}

/** Revert hunk on commit / compare diffs (spec 07 §4.3, §6.6). */
export interface RevertCtx {
  repoId: RepoId;
  spec: DiffSpec;
  path: string;
  oldPath?: string;
  contextLines: number;
  /** Why reverting is unavailable (e.g. whitespace filtering); null when allowed. */
  disabled: string | null;
}

type HunkOpType = 'wip.stageHunk' | 'wip.unstageHunk' | 'wip.discardHunk';
type LinesOpType = 'wip.stageLines' | 'wip.unstageLines' | 'wip.discardLines';

/** First line of every run of consecutive changed lines (the "changes" of §4.3 navigation). */
export function changeBlocks(file: Pick<FileDiff, 'hunks'>): { h: number; l: number }[] {
  const out: { h: number; l: number }[] = [];
  file.hunks.forEach((hunk, h) => {
    let prevChange = false;
    hunk.lines.forEach((line, l) => {
      if (line.type === 'nonewline') return;
      const c = isChange(line.type);
      if (c && !prevChange) out.push({ h, l });
      prevChange = c;
    });
  });
  return out;
}

/**
 * Hunk view (custom renderer, spec 07 §6.4 fallback): git's hunks with word-level highlights, hunk
 * actions (stage/unstage/discard for WIP, revert for commits) and line selection for WIP staging.
 */
export function HunkView(props: {
  file: FileDiff;
  hash: string;
  staging?: StagingCtx;
  revert?: RevertCtx;
  prefs: EditorPrefs;
  wordWrap: boolean;
  /** Side-by-side rendering (split mode): left selects `-` lines, right selects `+` lines (spec 06 §4.4). */
  split?: boolean;
  /** Context expansion (absent when the diff options are fixed, e.g. WIP staging). */
  onExpand?: () => void;
  scrollEl: HTMLElement | null;
  navRef: Ref<ChangeNav | null>;
  onNav(count: number, index: number): void;
  anchorLine?: number | null;
}) {
  const { file, staging, revert, prefs } = props;
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [anchor, setAnchor] = useState<{ h: number; l: number } | null>(null);
  const blocks = useMemo(() => changeBlocks(file), [file]);
  const words = useMemo(() => file.hunks.map((h) => hunkWordDiff(h)), [file]);
  const [current, setCurrent] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const { onNav } = props;

  useEffect(() => onNav(blocks.length, current), [blocks.length, current, onNav]);

  // ---- line selection: drag-paint, Esc, context menu (spec 06 §4.4) ----
  const showMenu = useContextMenu((s) => s.show);
  const paint = useRef<{ on: boolean; only?: 'add' | 'del' } | null>(null);
  const linesOpRef = useRef<(type: LinesOpType) => Promise<void>>(async () => undefined);
  useEffect(() => {
    const end = (): void => void (paint.current = null);
    window.addEventListener('mouseup', end);
    window.addEventListener('blur', end);
    return () => {
      window.removeEventListener('mouseup', end);
      window.removeEventListener('blur', end);
    };
  }, []);
  const hasSelection = selected.size > 0;
  useEffect(() => {
    if (!hasSelection) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
      e.preventDefault();
      setSelected(new Set());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hasSelection]);

  const rows = (): HTMLElement[] =>
    Array.from(rootRef.current?.querySelectorAll<HTMLElement>('[data-nl]') ?? []);

  useImperativeHandle(
    props.navRef,
    (): ChangeNav => ({
      go(dir) {
        const next = current < 0 && dir < 0 ? blocks.length - 1 : current + dir;
        if (next < 0 || next >= blocks.length) return false;
        setCurrent(next);
        const b = blocks[next]!;
        rootRef.current
          ?.querySelector(`[data-key="${selKey(b.h, b.l)}"]`)
          ?.scrollIntoView({ block: 'center' });
        return true;
      },
      topLine() {
        const top = props.scrollEl?.getBoundingClientRect().top ?? 0;
        const row = rows().find((r) => r.getBoundingClientRect().bottom > top);
        const n = Number(row?.dataset.nl);
        return Number.isFinite(n) && n > 0 ? n : null;
      },
      reveal(line) {
        const row = rows().find((r) => Number(r.dataset.nl) >= line);
        row?.scrollIntoView({ block: 'start' });
      },
    }),
    [blocks, current, props.scrollEl],
  );

  // keep the logical line visible after a mode switch (spec 07 §4.3)
  const anchorLine = props.anchorLine;
  useEffect(() => {
    if (!anchorLine) return;
    const row = rows().find((r) => Number(r.dataset.nl) >= anchorLine);
    row?.scrollIntoView({ block: 'start' });
  }, [anchorLine]);

  /**
   * Mouse down on a changed line (spec 06 §4.4): click toggles (EOF pairs together), Shift+click selects
   * the range from the anchor (across hunks; split view: same side only), and dragging paints the
   * clicked line's new state over every line the pointer enters.
   */
  const pressLine = (h: number, l: number, shift: boolean, only?: 'add' | 'del'): void => {
    const line = file.hunks[h]?.lines[l];
    if (!staging || !line || !isChange(line.type)) return;
    if (shift && anchor) {
      setSelected((s) => rangeSelect(s, file.hunks, anchor, { h, l }, only));
      return;
    }
    const on = !selected.has(selKey(h, l));
    paint.current = { on, only };
    setSelected((s) => paintLine(s, file.hunks, h, l, on));
    setAnchor({ h, l });
  };
  const enterLine = (h: number, l: number): void => {
    const p = paint.current;
    const t = file.hunks[h]?.lines[l]?.type;
    if (!p || !t || !isChange(t) || (p.only && t !== p.only)) return;
    setSelected((s) => paintLine(s, file.hunks, h, l, p.on));
  };

  const lines: LineRef[] = toLineRefs(selected);

  const lineMenu = (h: number, l: number, x: number, y: number): void => {
    if (!staging) return;
    const t = file.hunks[h]?.lines[l]?.type;
    let count = selected.size;
    if (t && isChange(t) && !selected.has(selKey(h, l))) {
      // right-click on an unselected line selects it (like file lists)
      const next = paintLine(new Set(), file.hunks, h, l, true);
      setSelected(next);
      count = next.size;
    }
    const n = `${count} line${count === 1 ? '' : 's'}`;
    const items: MenuEntry[] =
      staging.side === 'unstaged'
        ? [
            {
              label: `Stage ${n}`,
              disabled: !count,
              onSelect: () => void linesOpRef.current('wip.stageLines'),
            },
            {
              label: `Discard ${n}`,
              danger: true,
              disabled: !count,
              onSelect: () => void linesOpRef.current('wip.discardLines'),
            },
            'separator',
            { label: 'Stage hunk', onSelect: () => void hunkOp('wip.stageHunk', h) },
            { label: 'Discard hunk', danger: true, onSelect: () => void hunkOp('wip.discardHunk', h) },
          ]
        : [
            {
              label: `Unstage ${n}`,
              disabled: !count,
              onSelect: () => void linesOpRef.current('wip.unstageLines'),
            },
            'separator',
            { label: 'Unstage hunk', onSelect: () => void hunkOp('wip.unstageHunk', h) },
          ];
    items.push('separator', {
      label: 'Clear selection',
      shortcut: 'Esc',
      disabled: !count,
      onSelect: () => setSelected(new Set()),
    });
    showMenu(x, y, items);
  };

  const hunkOp = async (type: HunkOpType, hunkIndex: number): Promise<void> => {
    if (!staging) return;
    if (
      type === 'wip.discardHunk' &&
      !(await confirm(
        'Discard hunk?',
        'The changes in this hunk will be discarded. You can undo this.',
        'Discard',
        true,
      ))
    ) {
      return;
    }
    quiet(runOp(staging.repoId, { type, path: staging.path, hunkIndex, diffHash: props.hash }));
  };

  const linesOp = async (type: LinesOpType): Promise<void> => {
    if (!staging || lines.length === 0) return;
    if (
      type === 'wip.discardLines' &&
      !(await confirm(
        'Discard selected lines?',
        'The selected changes will be discarded. You can undo this.',
        'Discard',
        true,
      ))
    ) {
      return;
    }
    quiet(runOp(staging.repoId, { type, path: staging.path, lines, diffHash: props.hash }));
  };
  useEffect(() => {
    linesOpRef.current = linesOp;
  });

  const revertHunk = (hunkIndex: number): void => {
    if (!revert || revert.disabled) return;
    quiet(
      runOp(
        revert.repoId,
        {
          type: 'diff.revertHunk',
          spec: revert.spec,
          path: revert.path,
          ...(revert.oldPath ? { oldPath: revert.oldPath } : {}),
          hunkIndex,
          diffHash: props.hash,
          contextLines: revert.contextLines,
        },
        { successToast: 'Hunk reverted in the working tree (unstaged). Undo with Ctrl+Z.' },
      ),
    );
  };

  if (file.hunks.length === 0) return null;

  const currentBlock = blocks[current];
  const gapBefore = (i: number): number => {
    const h = file.hunks[i]!;
    if (i === 0) return Math.max(0, (h.oldLines === 0 ? h.oldStart + 1 : h.oldStart) - 1);
    const p = file.hunks[i - 1]!;
    return Math.max(0, h.oldStart - (p.oldStart + p.oldLines));
  };

  return (
    <>
      {staging && selected.size > 0 && (
        <div className={styles.selectionBar} role="toolbar" aria-label="Selected lines">
          <span>
            {selected.size} line{selected.size === 1 ? '' : 's'} selected
          </span>
          {staging.side === 'unstaged' ? (
            <>
              <button type="button" className="primary" onClick={() => void linesOp('wip.stageLines')}>
                Stage lines
              </button>
              <button
                type="button"
                className={styles.danger}
                onClick={() => void linesOp('wip.discardLines')}
              >
                Discard lines
              </button>
            </>
          ) : (
            <button type="button" className="primary" onClick={() => void linesOp('wip.unstageLines')}>
              Unstage lines
            </button>
          )}
          <button type="button" onClick={() => setSelected(new Set())}>
            Clear
          </button>
        </div>
      )}
      <div
        ref={rootRef}
        className={`${styles.hunks} ${prefs.lineNumbers ? '' : styles.noLineNumbers}`}
        style={codeStyle(prefs, props.wordWrap)}
        role="table"
        aria-label="Diff hunks"
      >
        {file.hunks.map((h, i) => (
          <div key={i}>
            {props.onExpand && gapBefore(i) > 0 && (
              <ExpandBar hidden={gapBefore(i)} onExpand={props.onExpand} />
            )}
            <Hunk
              hunk={h}
              hunkIndex={i}
              words={words[i]!}
              staging={staging}
              revert={revert}
              prefs={prefs}
              selected={selected}
              currentLine={currentBlock?.h === i ? currentBlock.l : -1}
              split={!!props.split}
              onLinePress={pressLine}
              onLineEnter={enterLine}
              onLineMenu={lineMenu}
              onHunkOp={(type) => void hunkOp(type, i)}
              onRevert={() => revertHunk(i)}
            />
          </div>
        ))}
        {props.onExpand && <ExpandBar onExpand={props.onExpand} />}
      </div>
    </>
  );
}

function ExpandBar({ hidden, onExpand }: { hidden?: number; onExpand(): void }) {
  return (
    <button type="button" className={styles.expandBar} onClick={onExpand} title="Show 20 more context lines">
      ⋯ {hidden ? `${hidden} hidden line${hidden === 1 ? '' : 's'} · ` : ''}Expand 20 lines ↕
    </button>
  );
}

function Hunk(props: {
  hunk: DiffHunk;
  hunkIndex: number;
  words: Map<number, Range[]>;
  staging?: StagingCtx;
  revert?: RevertCtx;
  prefs: EditorPrefs;
  selected: Set<string>;
  currentLine: number;
  split: boolean;
  onLinePress(h: number, l: number, shift: boolean, only?: 'add' | 'del'): void;
  onLineEnter(h: number, l: number): void;
  onLineMenu(h: number, l: number, x: number, y: number): void;
  onHunkOp(type: HunkOpType): void;
  onRevert(): void;
}) {
  const { hunk, staging, revert } = props;
  return (
    <section className={styles.hunk}>
      <div className={styles.hunkHeader} role="row">
        <span className={styles.hunkTitle}>{hunk.header}</span>
        {staging && (
          <span className={styles.hunkActions}>
            {staging.side === 'unstaged' ? (
              <>
                <button
                  type="button"
                  className={styles.danger}
                  onClick={() => props.onHunkOp('wip.discardHunk')}
                >
                  Discard hunk
                </button>
                <button type="button" onClick={() => props.onHunkOp('wip.stageHunk')}>
                  Stage hunk
                </button>
              </>
            ) : (
              <button type="button" onClick={() => props.onHunkOp('wip.unstageHunk')}>
                Unstage hunk
              </button>
            )}
          </span>
        )}
        {!staging && revert && (
          <span className={styles.hunkActions}>
            <button
              type="button"
              disabled={!!revert.disabled}
              title={revert.disabled ?? 'Apply the inverse of this hunk to the working tree (unstaged)'}
              onClick={props.onRevert}
            >
              <Undo2 size={11} /> Revert hunk
            </button>
          </span>
        )}
      </div>
      {props.split ? (
        <SplitLines {...props} />
      ) : (
        hunk.lines.map((l, i) => <UnifiedLine key={i} {...props} i={i} />)
      )}
    </section>
  );
}

type HunkProps = Parameters<typeof Hunk>[0];

/** Mouse handlers shared by unified and split cells of a selectable line. */
function lineHandlers(props: HunkProps, i: number, selectable: boolean, only?: 'add' | 'del') {
  return {
    onMouseDown: (e: React.MouseEvent): void => {
      if (selectable && e.button === 0) {
        e.preventDefault();
        props.onLinePress(props.hunkIndex, i, e.shiftKey, only);
      }
    },
    onMouseEnter: (e: React.MouseEvent): void => {
      if (selectable && e.buttons === 1) props.onLineEnter(props.hunkIndex, i);
    },
    onContextMenu: (e: React.MouseEvent): void => {
      if (!props.staging) return;
      e.preventDefault();
      props.onLineMenu(props.hunkIndex, i, e.clientX, e.clientY);
    },
  };
}

function UnifiedLine(props: HunkProps & { i: number }) {
  const { hunk, hunkIndex, staging, prefs, i } = props;
  const l = hunk.lines[i]!;
  const selectable = !!staging && isChange(l.type);
  const isSel = props.selected.has(selKey(hunkIndex, i));
  const nl = l.newLineNo ?? l.oldLineNo;
  return (
    <div
      role="row"
      data-key={selKey(hunkIndex, i)}
      data-nl={nl}
      aria-selected={selectable ? isSel : undefined}
      className={`${styles.line} ${styles[l.type]} ${selectable ? styles.selectable : ''} ${
        isSel ? styles.selectedLine : ''
      } ${props.currentLine === i ? styles.currentChange : ''}`}
      {...lineHandlers(props, i, selectable)}
    >
      <span className={styles.ln}>{l.oldLineNo ?? ''}</span>
      <span className={styles.ln}>{l.newLineNo ?? ''}</span>
      <span className={styles.sign}>{l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}</span>
      <span className={styles.code}>
        {l.type === 'nonewline' ? (
          '\\ No newline at end of file'
        ) : (
          <Code text={l.content} ranges={props.words.get(i)} prefs={prefs} />
        )}
      </span>
    </div>
  );
}

/** Side-by-side rows: old side (`-`/context) left, new side (`+`/context) right. */
function SplitLines(props: HunkProps) {
  const { hunk, hunkIndex, staging, prefs } = props;
  const rows = splitRows(hunk);
  const cell = (idx: number | undefined, side: 'left' | 'right', noEol?: boolean): ReactNode => {
    if (idx === undefined) return <div className={`${styles.splitCell} ${styles.splitEmpty}`} />;
    const l = hunk.lines[idx]!;
    const only = side === 'left' ? 'del' : 'add';
    const selectable = !!staging && l.type === only;
    const isSel = props.selected.has(selKey(hunkIndex, idx));
    const n = side === 'left' ? l.oldLineNo : l.newLineNo;
    return (
      <div
        data-key={selKey(hunkIndex, idx)}
        aria-selected={selectable ? isSel : undefined}
        className={`${styles.splitCell} ${styles[l.type]} ${selectable ? styles.selectable : ''} ${
          isSel ? styles.selectedLine : ''
        } ${props.currentLine === idx ? styles.currentChange : ''}`}
        {...lineHandlers(props, idx, selectable, only)}
      >
        <span className={styles.ln}>{n ?? ''}</span>
        <span className={styles.sign}>{l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}</span>
        <span className={styles.code}>
          <Code text={l.content} ranges={props.words.get(idx)} prefs={prefs} />
          {noEol && (
            <span className={styles.noEol} title="No newline at end of file">
              ⊘
            </span>
          )}
        </span>
      </div>
    );
  };
  return (
    <>
      {rows.map((r, k) => {
        const first = r.left ?? r.right!;
        const ln = hunk.lines[first]!;
        return (
          <div key={k} role="row" className={styles.splitRow} data-nl={ln.newLineNo ?? ln.oldLineNo}>
            {cell(r.left, 'left', r.leftNoEol)}
            {cell(r.right, 'right', r.rightNoEol)}
          </div>
        );
      })}
    </>
  );
}

const WS_MAX_LINE = 2000;

/** Code text with word highlights, visible whitespace and EOL markers (editor preferences). */
export function Code({ text, ranges, prefs }: { text: string; ranges?: Range[]; prefs: EditorPrefs }) {
  const crlf = text.endsWith('\r');
  const body = crlf ? text.slice(0, -1) : text;
  const ws = body.length > WS_MAX_LINE ? 'none' : prefs.renderWhitespace;
  const lead = ws === 'boundary' ? (/^\s*/.exec(body)?.[0].length ?? 0) : 0;
  const trail = ws === 'boundary' ? body.length - (/\s*$/.exec(body)?.[0].length ?? 0) : body.length;
  const out: ReactNode[] = [];
  let offset = 0;
  segments(body, ranges).forEach((seg, si) => {
    const parts: ReactNode[] = [];
    if (ws === 'none') parts.push(seg.text);
    else {
      const re = /\s+/g;
      let pos = 0;
      for (let m = re.exec(seg.text); m; m = re.exec(seg.text)) {
        const abs = offset + m.index;
        const mark = ws === 'all' || abs < lead || abs >= trail;
        if (!mark) continue;
        if (m.index > pos) parts.push(seg.text.slice(pos, m.index));
        parts.push(
          <span key={`w${m.index}`} className={styles.ws}>
            {m[0].replace(/ /g, '·').replace(/\t/g, '→\t')}
          </span>,
        );
        pos = m.index + m[0].length;
      }
      if (pos < seg.text.length) parts.push(seg.text.slice(pos));
    }
    offset += seg.text.length;
    out.push(
      seg.hl ? (
        <mark key={si} className={styles.word}>
          {parts}
        </mark>
      ) : (
        <span key={si}>{parts}</span>
      ),
    );
  });
  if (prefs.showEol) {
    out.push(
      <span key="eol" className={styles.eol}>
        {crlf ? '␍␊' : '␊'}
      </span>,
    );
  }
  return <>{out}</>;
}
