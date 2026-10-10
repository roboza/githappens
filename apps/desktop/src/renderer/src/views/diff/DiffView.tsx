import { Editor } from '@monaco-editor/react';
import { diffHash, STAGING_DIFF_OPTIONS } from '@githappens/git/ops';
import type { DiffOptions, DiffSpec, FileDiff, RepoId, ShowFileResult } from '@githappens/git/types';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowDown,
  ArrowLeftRight,
  ArrowUp,
  ExternalLink,
  FileText,
  GitCompare,
  History,
  Pencil,
  ScanLine,
  SquareArrowOutUpRight,
  WrapText,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';

import { invoke } from '../../lib/api';
import { applyMonacoTheme, languageFor } from '../../lib/monaco';
import { quiet, runOp } from '../../lib/ops';
import { qk, useCommitDetail } from '../../repo/queries';
import { useRepoUiStore, type CenterView } from '../../stores/repo-ui';
import { useSetting, useSettingsStore } from '../../stores/settings';
import { openExternalDiff, openInEditor } from '../../tools/actions';
import { BlameView } from '../file/BlameView';
import { showFileText } from '../file/codec';
import { filesInvoke } from '../file/files-api';
import { CombinedDiff } from './CombinedDiff';
import { CompareView } from './CompareView';
import {
  useDiffPrefs,
  useEditorPrefs,
  monacoOptions,
  WHITESPACE_LABELS,
  type DiffPrefs,
} from './editor-prefs';
import { HunkView, type RevertCtx } from './HunkView';
import { isImagePath } from './image-meta';
import {
  allowLarge,
  countLines,
  hasLongLines,
  HUGE_FILE_BYTES,
  LARGE_FILE_BYTES,
  LARGE_FILE_LINES,
  LONG_LINE_CHARS,
} from './large-file';
import { MonacoDiff } from './MonacoDiff';
import type { ChangeNav } from './nav';
import { stepFile } from './nav-store';
import {
  Banner,
  BinaryCard,
  FileBanners,
  ImageDiff,
  LargeFileGuard,
  LfsBanner,
  SubmoduleDiff,
  useProtocolText,
} from './special';
import styles from './DiffView.module.css';

export type DiffMode = 'hunk' | 'inline' | 'split';
type DiffCenter = Extract<CenterView, { kind: 'diff' }>;

const LAST_MODE_KEY = 'kl.diff.lastMode';

function lastMode(): DiffMode | null {
  try {
    const v = localStorage.getItem(LAST_MODE_KEY);
    return v === 'hunk' || v === 'inline' || v === 'split' ? v : null;
  } catch {
    return null;
  }
}

/** Load one side of a diff. `''` = absent, `WORKTREE` = file on disk, `INDEX` = staged blob. */
async function loadSide(
  repoId: RepoId,
  rev: string,
  path: string,
  maxBytes: number,
): Promise<ShowFileResult> {
  if (!rev) return { content: '', binary: false, size: 0, encoding: 'utf8' };
  if (rev === 'WORKTREE') return invoke('git:worktree:readFile', { repoId, path, maxBytes });
  return invoke('git:show:file', { repoId, rev: rev === 'INDEX' ? ':0' : rev, path, maxBytes });
}

/** Side text for Monaco: BOM-aware (UTF-16 with BOM arrives as base64 "binary"). */
const sideText = (s: ShowFileResult): string | null =>
  s.content === null ? null : (showFileText(s)?.text ?? null);

/**
 * Center-area diff (spec 07 §4.3): a single file diff, or — when `path` is empty — a comparison with its
 * own file list (`compareRefs`).
 */
export default function DiffView({
  repoId,
  view,
  embedded,
}: {
  repoId: RepoId;
  view: DiffCenter;
  embedded?: boolean;
}) {
  if (!view.path) return <CompareView repoId={repoId} view={view} />;
  return (
    <FileDiffView
      key={`${view.path}\0${JSON.stringify(view.spec)}`}
      repoId={repoId}
      view={view}
      embedded={embedded}
    />
  );
}

function isTextTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el?.tagName) return false;
  if (el.closest?.('.monaco-editor')) return false; // Monaco's hidden textarea: shortcuts still apply
  return (
    el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable
  );
}

interface Target {
  spec: DiffSpec;
  baseOld: string;
  baseNew: string;
  path: string;
  oldPath: string;
  canSwap: boolean;
}

/** Effective diff target after the merge-parent selector and the swap toggle. Pure. */
export function resolveTarget(
  view: Pick<DiffCenter, 'spec' | 'oldRev' | 'newRev' | 'path' | 'oldPath'>,
  parents: string[],
  parent: number | 'combined',
  swapped: boolean,
): Target {
  let spec: DiffSpec = view.spec;
  let baseOld = view.oldRev;
  if (spec.kind === 'commit' && spec.parentIndex === 0) spec = { ...spec, parentIndex: 1 };
  if (spec.kind === 'commit' && typeof parent === 'number' && parents.length > 1) {
    spec = { ...spec, parentIndex: parent };
    baseOld = parents[parent - 1] ?? baseOld;
  } else if (spec.kind === 'commit' && parents.length === 1 && !baseOld) {
    baseOld = parents[0]!;
  }
  const canSwap = spec.kind === 'range' && spec.to !== ':worktree';
  const path = view.path;
  const oldPath = view.oldPath ?? view.path;
  if (swapped && spec.kind === 'range' && canSwap) {
    return {
      spec: { ...spec, from: spec.to, to: spec.from },
      baseOld: view.newRev,
      baseNew: baseOld,
      path: oldPath,
      oldPath: path,
      canSwap,
    };
  }
  return { spec, baseOld, baseNew: view.newRev, path, oldPath, canSwap };
}

/** One file's diff with toolbar, banners, special content and keyboard navigation. */
export function FileDiffView({
  repoId,
  view,
  embedded,
}: {
  repoId: RepoId;
  view: DiffCenter;
  embedded?: boolean;
}) {
  const prefs = useEditorPrefs();
  const dprefs = useDiffPrefs();
  const defaultMode = useSetting('diff.defaultView') ?? 'hunk';
  const setSetting = useSettingsStore((s) => s.set);
  const [mode, setModeState] = useState<DiffMode>(() => lastMode() ?? defaultMode);
  const [surface, setSurface] = useState<'diff' | 'file'>('diff');
  const [fileBlame, setFileBlame] = useState(false);
  const [whitespace, setWhitespace] = useState<DiffPrefs['whitespace']>(dprefs.whitespace);
  const [blankLines, setBlankLines] = useState(dprefs.ignoreBlankLines);
  const [extraContext, setExtraContext] = useState(0);
  const [wordWrap, setWordWrap] = useState(prefs.wordWrap);
  // `parentIndex: 0` in the spec asks for the combined (`--cc`) view of a merge commit
  const [parent, setParent] = useState<number | 'combined'>(() =>
    view.spec.kind !== 'commit' ? 1 : view.spec.parentIndex === 0 ? 'combined' : (view.spec.parentIndex ?? 1),
  );
  const [swapped, setSwapped] = useState(false);
  const [svgAsText, setSvgAsText] = useState(false);
  const [lfsPointer, setLfsPointer] = useState(false);
  const largeKey = `${repoId}\0${JSON.stringify(view.spec)}\0${view.path}`;
  const [loadLarge, setLoadLarge] = useState(() => allowLarge.has(largeKey));
  const [nav, setNav] = useState({ count: 0, index: -1 });
  const [anchor, setAnchor] = useState<number | null>(null);
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const navRef = useRef<ChangeNav | null>(null);
  const close = (): void => useRepoUiStore.getState().update(repoId, () => ({ center: { kind: 'graph' } }));
  const onNav = useCallback((count: number, index: number) => setNav({ count, index }), []);

  // ---- effective target (parent selector, swap) ----
  const commitSha = view.spec.kind === 'commit' ? view.spec.sha : null;
  const detail = useCommitDetail(repoId, commitSha);
  const parents = detail.data?.parents ?? [];
  const target = resolveTarget(view, parents, parent, swapped);
  const { spec, canSwap } = target;
  const threeDot = spec.kind === 'range' && !!spec.threeDot;
  const mergeBase = useQuery({
    queryKey: [
      'diff',
      repoId,
      'mergeBase',
      spec.kind === 'range' ? spec.from : '',
      spec.kind === 'range' ? spec.to : '',
    ],
    queryFn: () =>
      spec.kind === 'range' ? filesInvoke('diff:mergeBase', { repoId, a: spec.from, b: spec.to }) : null,
    enabled: threeDot,
    staleTime: Infinity,
  });
  const baseOld = threeDot && mergeBase.data ? mergeBase.data : target.baseOld;

  // ---- options ----
  // hunk / line patches name the file by its UTF-8 path: not for names that are not valid UTF-8
  const staging = view.stage && !view.stage.untracked && !view.stage.key ? view.stage : undefined;
  const fixed = !!staging;
  const contextLines = dprefs.contextLines + extraContext;
  const filtered = whitespace !== 'none' || blankLines;
  const options: DiffOptions = fixed
    ? STAGING_DIFF_OPTIONS
    : {
        contextLines,
        ignoreWhitespace: whitespace,
        ignoreBlankLines: blankLines,
        renameLimit: dprefs.renameLimit,
        ...(loadLarge ? { maxBytesPerFile: HUGE_FILE_BYTES } : {}),
      };
  const diff = useQuery({
    queryKey: qk.diff(repoId, JSON.stringify([spec, options])),
    queryFn: () => invoke('git:diff', { repoId, spec, options }),
    enabled: parent !== 'combined',
  });
  const file: FileDiff | undefined = useMemo(
    () => diff.data?.find((f) => f.newPath === target.path || f.oldPath === target.path) ?? diff.data?.[0],
    [diff.data, target.path],
  );
  const path = file?.newPath ?? target.path;
  const oldPath = file?.oldPath ?? target.oldPath;
  const oldRev = file?.status === 'A' ? '' : baseOld;
  const newRev = file?.status === 'D' ? '' : target.baseNew;

  // ---- what to render ----
  const image = isImagePath(path) && (!!file?.binary || (path.toLowerCase().endsWith('.svg') && !svgAsText));
  const lfs = !!file?.lfsPointer && !lfsPointer;
  const special = !!file && (!!file.submodule || lfs || image);
  const needSides =
    !!file &&
    !special &&
    parent !== 'combined' &&
    (surface === 'file' ||
      (mode !== 'hunk' && !(staging && mode === 'split')) ||
      file.binary ||
      (file.tooLarge && loadLarge));
  const maxBytes = loadLarge ? HUGE_FILE_BYTES : LARGE_FILE_BYTES;
  const sides = useQuery({
    queryKey: ['diff', repoId, 'sides', oldRev, newRev, oldPath, path, maxBytes],
    queryFn: () =>
      Promise.all([loadSide(repoId, oldRev, oldPath, maxBytes), loadSide(repoId, newRev, path, maxBytes)]),
    enabled: needSides,
  });
  const texts = useMemo(() => (sides.data ? sides.data.map(sideText) : null), [sides.data]);
  const sideBytes = sides.data ? Math.max(sides.data[0].size, sides.data[1].size) : 0;
  const sideLines = texts ? Math.max(countLines(texts[0] ?? ''), countLines(texts[1] ?? '')) : 0;
  const hunkLines = file ? file.hunks.reduce((n, h) => n + h.lines.length, 0) : 0;
  const longLines = useMemo(() => {
    if (texts) return texts.some((t) => t && hasLongLines(t));
    return !!file?.hunks.some((h) => h.lines.some((l) => l.content.length > LONG_LINE_CHARS));
  }, [texts, file]);

  const hash = useMemo(() => (file ? diffHash(file) : ''), [file]);
  const revert: RevertCtx | undefined =
    !view.stage && (spec.kind === 'commit' || spec.kind === 'range') && parent !== 'combined'
      ? {
          repoId,
          spec,
          path,
          ...(oldPath !== path ? { oldPath } : {}),
          contextLines,
          disabled: filtered ? 'Disable whitespace filtering to revert hunks' : null,
        }
      : undefined;

  // ---- mode switching keeps the logical line (spec 07 §4.3) ----
  const setMode = (m: DiffMode): void => {
    setAnchor(navRef.current?.topLine() ?? null);
    setModeState(m);
    setSurface('diff');
    try {
      localStorage.setItem(LAST_MODE_KEY, m);
    } catch {
      /* storage unavailable */
    }
  };
  const goChange = (dir: 1 | -1): void => {
    if (navRef.current?.go(dir)) return;
    if (!embedded) stepFile(repoId, view.path, dir); // past the last change → next file (our addition)
  };
  const openFile = (mode: 'history' | 'blame' | 'edit'): void =>
    useRepoUiStore.getState().update(repoId, () => ({
      center: {
        kind: 'file',
        path,
        mode,
        ...(mode === 'blame' && newRev && newRev !== 'WORKTREE' && newRev !== 'INDEX' ? { rev: newRev } : {}),
      },
    }));

  // ---- keyboard (spec 07 §4.15) ----
  const keys = useRef<(e: KeyboardEvent) => void>(() => undefined);
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.defaultPrevented || isTextTarget(e.target)) return;
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'F7') goChange(e.shiftKey ? -1 : 1);
    else if (e.altKey && !mod && (e.key === 'ArrowDown' || e.key === 'ArrowUp'))
      goChange(e.key === 'ArrowDown' ? 1 : -1);
    else if (mod && !e.altKey && !embedded && (e.key === 'ArrowDown' || e.key === 'ArrowUp'))
      stepFile(repoId, view.path, e.key === 'ArrowDown' ? 1 : -1);
    else if (mod && e.altKey && /^Digit[123]$/.test(e.code))
      setMode((['hunk', 'inline', 'split'] as const)[Number(e.code.slice(5)) - 1]!);
    else if (e.altKey && !mod && e.code === 'KeyZ') setWordWrap((w) => !w);
    else if (mod && !e.altKey && e.code === 'KeyE' && view.stage) openFile('edit');
    else if (e.key === 'Escape' && !embedded) close();
    else return;
    e.preventDefault();
  };
  useEffect(() => {
    keys.current = onKeyDown;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => keys.current(e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const merge = parents.length > 1;
  const title = oldPath !== path ? `${oldPath} → ${path}` : path;

  // ---- body ----
  const body = (() => {
    if (parent === 'combined' && commitSha) {
      return <CombinedDiff repoId={repoId} sha={commitSha} path={path} prefs={prefs} wordWrap={wordWrap} />;
    }
    if (diff.isLoading) return <p className={styles.message}>Loading diff…</p>;
    if (diff.error)
      return <p className={styles.message}>Could not load the diff: {(diff.error as Error).message}</p>;
    if (!file) {
      return (
        <p className={styles.message}>
          {filtered ? 'No changes with the current whitespace options.' : 'No changes.'}
        </p>
      );
    }
    const sideProps = { repoId, oldRev, newRev, oldPath, path };
    if (surface === 'file') {
      if (fileBlame && newRev !== 'INDEX') {
        const rev =
          newRev && newRev !== 'WORKTREE' ? newRev : newRev === 'WORKTREE' ? undefined : oldRev || undefined;
        return <BlameView key={`${rev}`} repoId={repoId} path={newRev ? path : oldPath} rev={rev} />;
      }
      if (sides.isLoading) return <p className={styles.message}>Loading file…</p>;
      const t = texts?.[newRev ? 1 : 0];
      if (t === null || t === undefined)
        return <p className={styles.message}>This file can&apos;t be shown as text.</p>;
      return (
        <Editor
          value={t}
          language={prefs.syntaxHighlighting ? languageFor(path) : 'plaintext'}
          theme={applyMonacoTheme()}
          options={{ ...monacoOptions(prefs, wordWrap), readOnly: true, domReadOnly: true }}
          onMount={(ed) => anchor && ed.revealLineNearTop(anchor)}
        />
      );
    }
    if (file.submodule) return <SubmoduleDiff repoId={repoId} file={file} />;
    if (lfs) {
      return (
        <LfsBanner {...sideProps}>
          {(available) =>
            available ? (
              isImagePath(path) ? (
                <ImageDiff {...sideProps} />
              ) : (
                <LfsText
                  {...sideProps}
                  mode={mode}
                  prefs={prefs}
                  wordWrap={wordWrap}
                  navRef={navRef}
                  onNav={onNav}
                />
              )
            ) : (
              <p className={styles.message}>
                The LFS object isn&apos;t downloaded.{' '}
                <button type="button" onClick={() => setLfsPointer(true)}>
                  Show pointer diff
                </button>
              </p>
            )
          }
        </LfsBanner>
      );
    }
    if (image) return <ImageDiff {...sideProps} />;
    if (file.binary) {
      if (sides.isLoading) return <p className={styles.message}>Loading…</p>;
      // UTF-16 text with a BOM: git calls it binary; show it decoded (no hunk actions)
      if (texts && texts.some((t) => t !== null && t !== '') && texts.every((t) => t !== null)) {
        return (
          <>
            <Banner>UTF-16 text shown decoded; hunk staging and revert are not available for it.</Banner>
            <MonacoDiff
              original={texts[0] ?? ''}
              modified={texts[1] ?? ''}
              path={path}
              split={mode === 'split'}
              ignoreTrimWhitespace={whitespace !== 'none'}
              prefs={prefs}
              wordWrap={wordWrap}
              navRef={navRef}
              onNav={onNav}
            />
          </>
        );
      }
      return <BinaryCard {...sideProps} />;
    }
    const guard = (bytes: number, lines?: number) => (
      <LargeFileGuard
        bytes={bytes}
        lines={lines}
        onLoad={() => {
          allowLarge.add(largeKey);
          setLoadLarge(true);
        }}
      />
    );
    if (file.tooLarge && !loadLarge) return guard(Math.max(LARGE_FILE_BYTES * 2, sideBytes));
    if (file.tooLarge) return <BinaryCard {...sideProps} note="Too large to display (over 50 MB)." />;
    if (file.hunks.length === 0) {
      return (
        <p className={styles.message}>
          {file.status === 'A'
            ? 'Empty file added.'
            : file.status === 'D'
              ? 'Empty file deleted.'
              : file.oldMode !== file.newMode || file.status === 'R' || file.status === 'C'
                ? 'No content changes.'
                : 'No content changes.'}
        </p>
      );
    }
    // WIP split view uses the hunk renderer side by side so lines stay selectable (spec 06 §4.4)
    if (mode === 'hunk' || (staging && mode === 'split')) {
      if (hunkLines > LARGE_FILE_LINES && !loadLarge) return guard(0, hunkLines);
      return (
        <HunkView
          key={hash}
          file={file}
          hash={hash}
          staging={staging ? { repoId, path: view.path, side: staging.side } : undefined}
          revert={revert}
          prefs={prefs}
          wordWrap={wordWrap}
          split={mode === 'split'}
          onExpand={fixed ? undefined : () => setExtraContext((c) => c + 20)}
          scrollEl={scrollEl}
          navRef={navRef}
          onNav={onNav}
          anchorLine={anchor}
        />
      );
    }
    if (sides.isLoading) return <p className={styles.message}>Loading file contents…</p>;
    if (sides.error) return <p className={styles.message}>{(sides.error as Error).message}</p>;
    if (!sides.data || !texts) return null;
    if (sides.data.some((s) => s.tooLarge)) {
      return sideBytes > HUGE_FILE_BYTES || loadLarge ? (
        <BinaryCard {...sideProps} note="Too large to display (over 50 MB)." />
      ) : (
        guard(sideBytes)
      );
    }
    if (sideLines > LARGE_FILE_LINES && !loadLarge) return guard(sideBytes, sideLines);
    return (
      <MonacoDiff
        key={mode}
        original={texts[0] ?? ''}
        modified={texts[1] ?? ''}
        path={path}
        split={mode === 'split'}
        ignoreTrimWhitespace={whitespace !== 'none'}
        prefs={prefs}
        wordWrap={wordWrap}
        navRef={navRef}
        onNav={onNav}
        anchorLine={anchor}
      />
    );
  })();

  const ws = (
    <select
      aria-label="Whitespace"
      value={whitespace}
      disabled={fixed}
      title={fixed ? 'Line staging uses exact whitespace' : 'Whitespace changes'}
      onChange={(e) => setWhitespace(e.target.value as DiffPrefs['whitespace'])}
    >
      {(Object.keys(WHITESPACE_LABELS) as DiffPrefs['whitespace'][]).map((k) => (
        <option key={k} value={k}>
          {WHITESPACE_LABELS[k]}
        </option>
      ))}
    </select>
  );

  return (
    <div className={styles.view}>
      <div className={styles.toolbar}>
        <span className={styles.title} title={view.title}>
          {title}
        </span>
        {file && (
          <span className={styles.stats}>
            <span className={styles.plus}>+{file.additions}</span>{' '}
            <span className={styles.minus}>−{file.deletions}</span>
          </span>
        )}
        {file && !file.binary && path.toLowerCase().endsWith('.svg') && (
          <button type="button" className={styles.stageFile} onClick={() => setSvgAsText((v) => !v)}>
            {svgAsText ? 'Show image' : 'Show text diff'}
          </button>
        )}
        {view.stage && (
          <button
            type="button"
            className={styles.stageFile}
            onClick={() =>
              quiet(
                runOp(repoId, {
                  type: view.stage!.side === 'unstaged' ? 'wip.stage' : 'wip.unstage',
                  paths: [view.stage!.key ?? view.path],
                }),
              )
            }
          >
            {view.stage.side === 'unstaged' ? 'Stage file' : 'Unstage file'}
          </button>
        )}
        {merge && (
          <select
            aria-label="Compare against parent"
            value={String(parent)}
            onChange={(e) => setParent(e.target.value === 'combined' ? 'combined' : Number(e.target.value))}
          >
            {parents.map((p, i) => (
              <option key={p} value={i + 1}>
                vs parent {i + 1}
                {i === 0 ? ' (default)' : ''}
              </option>
            ))}
            <option value="combined">Combined (--cc)</option>
          </select>
        )}
        {canSwap && (
          <button
            type="button"
            className={styles.iconBtn}
            aria-pressed={swapped}
            title="Swap sides"
            aria-label="Swap sides"
            onClick={() => setSwapped((s) => !s)}
          >
            <ArrowLeftRight size={14} />
          </button>
        )}
      </div>
      <div className={styles.toolbar}>
        <span className={styles.navGroup}>
          <button
            type="button"
            className={styles.iconBtn}
            title="Previous change (Shift+F7, Alt+↑)"
            aria-label="Previous change"
            onClick={() => goChange(-1)}
          >
            <ArrowUp size={14} />
          </button>
          <button
            type="button"
            className={styles.iconBtn}
            title="Next change (F7, Alt+↓)"
            aria-label="Next change"
            onClick={() => goChange(1)}
          >
            <ArrowDown size={14} />
          </button>
          <span className={styles.counter} aria-live="polite">
            {nav.count ? `${nav.index >= 0 ? nav.index + 1 : '–'}/${nav.count}` : '0/0'}
          </span>
        </span>
        <div className={styles.segmented} role="group" aria-label="Diff or file">
          <button type="button" aria-pressed={surface === 'diff'} onClick={() => setSurface('diff')}>
            Diff View
          </button>
          <button
            type="button"
            aria-pressed={surface === 'file'}
            onClick={() => {
              setAnchor(navRef.current?.topLine() ?? null);
              setSurface('file');
            }}
          >
            File View
          </button>
        </div>
        {surface === 'file' ? (
          <label className={styles.check}>
            <input type="checkbox" checked={fileBlame} onChange={(e) => setFileBlame(e.target.checked)} />{' '}
            Blame
          </label>
        ) : (
          <div className={styles.segmented} role="group" aria-label="Diff view mode">
            {(['hunk', 'inline', 'split'] as const).map((m, i) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                onClick={() => setMode(m)}
                onDoubleClick={() => void setSetting('diff.defaultView', m)}
                title={`${m[0]!.toUpperCase()}${m.slice(1)} view (Ctrl+Alt+${i + 1}; double-click to make default)`}
              >
                {m[0]!.toUpperCase() + m.slice(1)}
              </button>
            ))}
          </div>
        )}
        {ws}
        <label className={styles.check} title={fixed ? 'Line staging uses exact whitespace' : undefined}>
          <input
            type="checkbox"
            checked={blankLines}
            disabled={fixed}
            onChange={(e) => setBlankLines(e.target.checked)}
          />
          Ignore blank lines
        </label>
        {fixed && <span className={styles.hint}>Line staging uses exact whitespace</span>}
        <button
          type="button"
          className={styles.iconBtn}
          aria-pressed={wordWrap}
          title="Toggle word wrap (Alt+Z)"
          aria-label="Toggle word wrap"
          onClick={() => setWordWrap((w) => !w)}
        >
          <WrapText size={14} />
        </button>
        <span className={styles.spacer} />
        <button
          type="button"
          className={styles.iconBtn}
          title="File history"
          aria-label="File history"
          onClick={() => openFile('history')}
        >
          <History size={14} />
        </button>
        <button
          type="button"
          className={styles.iconBtn}
          title="File blame"
          aria-label="File blame"
          onClick={() => openFile('blame')}
        >
          <ScanLine size={14} />
        </button>
        <button
          type="button"
          className={styles.iconBtn}
          title={view.stage ? 'Edit in working directory (Ctrl+E)' : 'Edit in working directory'}
          aria-label="Edit in working directory"
          onClick={() => openFile('edit')}
        >
          <Pencil size={14} />
        </button>
        {newRev && newRev !== 'WORKTREE' && newRev !== 'INDEX' && (
          <button
            type="button"
            className={styles.iconBtn}
            title="Open file at this revision (read-only)"
            aria-label="Open file at this revision"
            onClick={() =>
              useRepoUiStore
                .getState()
                .update(repoId, () => ({ center: { kind: 'file', path, mode: 'edit', rev: newRev } }))
            }
          >
            <FileText size={14} />
          </button>
        )}
        <button
          type="button"
          className={styles.iconBtn}
          title="Open in external diff tool"
          aria-label="Open in external diff tool"
          onClick={() =>
            void openExternalDiff({
              repoId,
              path,
              ...(oldPath !== path ? { oldPath } : {}),
              oldRev,
              newRev,
              spec,
            })
          }
        >
          <ExternalLink size={14} />
        </button>
        <button
          type="button"
          className={styles.iconBtn}
          title="Open file in external editor"
          aria-label="Open file in external editor"
          disabled={!newRev && !oldRev}
          onClick={() => void openInEditor({ repoId, path: newRev ? path : oldPath })}
        >
          <SquareArrowOutUpRight size={14} />
        </button>
        {spec.kind === 'commit' && (
          <button
            type="button"
            className={styles.iconBtn}
            title="Compare this commit with the working directory"
            aria-label="Compare with working directory"
            onClick={() =>
              useRepoUiStore.getState().update(repoId, () => ({
                center: {
                  kind: 'diff',
                  spec: {
                    kind: 'range',
                    from: spec.kind === 'commit' ? spec.sha : '',
                    to: ':worktree',
                    paths: oldPath !== path ? [oldPath, path] : [path],
                  },
                  path,
                  ...(oldPath !== path ? { oldPath } : {}),
                  title: `${view.title} ↔ Working directory`,
                  oldRev: spec.kind === 'commit' ? spec.sha : '',
                  newRev: 'WORKTREE',
                },
              }))
            }
          >
            <GitCompare size={14} />
          </button>
        )}
        {!embedded && (
          <button
            type="button"
            className={styles.close}
            aria-label="Close diff"
            title="Close (Esc)"
            onClick={close}
          >
            <X size={16} />
          </button>
        )}
      </div>
      {file && surface === 'diff' && parent !== 'combined' && <FileBanners file={file} />}
      {threeDot && mergeBase.isFetched && mergeBase.data === null && (
        <Banner tone="warn">These histories have no merge base; showing a two-dot comparison.</Banner>
      )}
      {longLines && surface === 'diff' && (
        <Banner tone="warn">Long lines — syntax highlighting and word diff are limited for them.</Banner>
      )}
      <div className={styles.content} ref={setScrollEl}>
        {body}
      </div>
    </div>
  );
}

/** LFS text content resolved through `githappens-rev://` when the objects are local. */
function LfsText(props: {
  repoId: RepoId;
  oldRev: string;
  newRev: string;
  oldPath: string;
  path: string;
  mode: DiffMode;
  prefs: ReturnType<typeof useEditorPrefs>;
  wordWrap: boolean;
  navRef: RefObject<ChangeNav | null>;
  onNav(count: number, index: number): void;
}) {
  const q = useProtocolText(props.repoId, props.oldRev, props.newRev, props.oldPath, props.path, true);
  if (q.isLoading) return <p className={styles.message}>Loading LFS content…</p>;
  if (q.error || !q.data) return <p className={styles.message}>Could not load the LFS content.</p>;
  return (
    <MonacoDiff
      original={q.data[0]}
      modified={q.data[1]}
      path={props.path}
      split={props.mode === 'split'}
      ignoreTrimWhitespace={false}
      prefs={props.prefs}
      wordWrap={props.wordWrap}
      navRef={props.navRef}
      onNav={props.onNav}
    />
  );
}
