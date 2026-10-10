import Editor, { type OnMount } from '@monaco-editor/react';
import type {
  ConflictFileContents,
  ConflictFileInfo,
  RepoId,
  RepoOperationState,
} from '@githappens/git/types';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeftRight,
  ChevronDown,
  ChevronUp,
  Columns3,
  RotateCcw,
  Save,
  Search,
  Undo2,
  WandSparkles,
  WrapText,
  X,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { choose, confirm, prompt } from '../../components/Dialogs';
import { invoke } from '../../lib/api';
import { shortSha } from '../../lib/format';
import { applyMonacoTheme, languageFor, monaco } from '../../lib/monaco';
import { quiet, runOp } from '../../lib/ops';
import { useRepoUiStore } from '../../stores/repo-ui';
import { useSetting } from '../../stores/settings';
import { useToastStore } from '../../stores/toasts';
import { openInEditor } from '../../tools/actions';
import { useConflictAssist } from '../ai/ConflictAssist';
import { revisionUrl } from '../file/files-api';
import { ExternalMergeButton, ExternalMergeOverlay } from '../tools/ExternalMergeButton';
import {
  conflictKeys,
  getMergeSession,
  sessionGeneration,
  setMergeSession,
  useConflictState,
} from './conflict-queries';
import { CODE_TEXT, isTextConflict, markResolved, openMergeTool, sideLabels, takeSide } from './ConflictList';
import {
  appendSide,
  autoResolveTrivial,
  chunkLines,
  chunkRanges,
  chunkSource,
  editorLayout,
  emptyState,
  findChunk,
  flipOrder,
  hasMarkers,
  isResolved,
  parseMerged,
  pickedLines,
  regionLines,
  regionText,
  resetToBase,
  resolveEmpty,
  sameIgnoringWhitespace,
  serializeEditorText,
  sideCheck,
  splitLines,
  syncLine,
  takeAll,
  takeBoth,
  takeSide as takeChunkSide,
  toggleLine,
  toggleSide,
  unresolvedCount,
  workingDivergence,
  type ChunkSource,
  type ChunkState,
  type ConflictSegment,
  type MergeDocument,
  type PaneSide,
  type Side,
} from './merge-model';
import styles from './MergeToolView.module.css';

type Labels = ReturnType<typeof sideLabels>;
type Editor = monaco.editor.IStandaloneCodeEditor;
type Range = { start: number; length: number };

const LARGE_BYTES = 5 * 1024 * 1024;
const LARGE_LINES = 50_000;
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|ico|svg|avif)$/i;
const FULL_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/i;

const rangeAt = (m: monaco.editor.ITextModel, start: number, end: number): monaco.Range =>
  monaco.Range.fromPositions(m.getPositionAt(start), m.getPositionAt(end));

const lf = (s: string | null | undefined): string | null => (s == null ? null : s.replace(/\r\n/g, '\n'));

const closeTool = (repoId: RepoId): void =>
  useRepoUiStore.getState().update(repoId, () => ({ center: { kind: 'graph' } }));

/** After a file is resolved: open the next conflicted file, or return to the graph (spec 08 §4.5). */
function advance(repoId: RepoId, path: string, state: RepoOperationState | undefined): void {
  const next = state?.conflicts.find((c) => c.path !== path);
  if (next) {
    openMergeTool(repoId, next.path);
    return;
  }
  closeTool(repoId);
  if (state?.op)
    useToastStore.getState().push({
      kind: 'success',
      title: 'All conflicts resolved',
      body: 'Continue the operation from the banner.',
    });
}

/**
 * Built-in 3-way merge tool (spec 08 §4.3–4.6) for one conflicted file: full-file A and B Monaco panes
 * (optional Base) with chunk and line checkboxes, an editable Monaco output, and dedicated cards for
 * binary, submodule, symlink, rename and delete/modify conflicts.
 */
export default function MergeToolView({ repoId, path }: { repoId: RepoId; path: string }) {
  const state = useConflictState(repoId);
  const info = state.data?.conflicts.find((c) => c.path === path);
  // remember that the file was conflicted while open here ("Resolved outside the app")
  const [seen, setSeen] = useState(false);
  if (info && !seen) setSeen(true);
  const file = useQuery({
    queryKey: conflictKeys.file(repoId, path),
    queryFn: () => invoke('git:conflict:loadFile', { repoId, path }),
    enabled: !!info,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  const [allowLarge, setAllowLarge] = useState(false);
  const [source, setSource] = useState<'fresh' | 'working' | null>(null);
  const labels = sideLabels(state.data);

  const simple = (body: ReactNode): ReactNode => (
    <div className={styles.view}>
      <div className={styles.toolbar}>
        <span className={styles.path} title={path}>
          {path}
        </span>
        {info && <span className={styles.badge}>{CODE_TEXT[info.code]}</span>}
        <span className={styles.spacer} />
        {info && <ExternalMergeButton repoId={repoId} path={path} />}
        <button
          type="button"
          className={styles.icon}
          aria-label="Close merge tool"
          onClick={() => closeTool(repoId)}
        >
          <X size={16} />
        </button>
      </div>
      <div className={styles.center}>{body}</div>
      <ExternalMergeOverlay repoId={repoId} path={path} />
    </div>
  );

  if (state.isLoading) return simple(<p className={styles.message}>Loading conflict state…</p>);
  if (state.error) return simple(<p className={styles.message}>{(state.error as Error).message}</p>);
  if (!info)
    return simple(
      <div className={styles.card}>
        <h3>{seen ? 'Resolved outside the app' : 'No longer conflicted'}</h3>
        <p>
          <code>{path}</code>{' '}
          {seen
            ? 'was resolved outside GitHappens (in a terminal, an editor or another tool).'
            : `has been resolved${state.data?.op ? '' : ', and no operation is in progress'}.`}
        </p>
        <button type="button" onClick={() => closeTool(repoId)}>
          Back to graph
        </button>
      </div>,
    );

  // custom merge drivers / `-merge` attributes: never offer the text tool (spec 08 §6.4, §8)
  const driver = info.mergeDriver ?? file.data?.mergeDriver;
  if (driver)
    return simple(
      <div className={styles.card}>
        <h3>Custom merge driver</h3>
        <p>
          <code>.gitattributes</code> assigns the merge driver <code>{driver}</code> to this file. The
          built-in text merge is disabled so it doesn&apos;t overwrite the driver&apos;s result: resolve the
          file in your editor or external tool, take a whole side, then mark it resolved.
        </p>
        <WholeFileButtons repoId={repoId} info={info} state={state.data} labels={labels} />
        <div className={styles.cardButtons}>
          <button type="button" onClick={() => void openInEditor({ repoId, path })}>
            Open in editor
          </button>
          <button type="button" onClick={() => quiet(markResolved(repoId, info))}>
            Mark resolved
          </button>
        </div>
      </div>,
    );

  const special = !isTextConflict(info) || file.data?.binary;
  if (special)
    return simple(
      <SpecialConflict repoId={repoId} info={info} contents={file.data} state={state.data} labels={labels} />,
    );
  if (file.isLoading) return simple(<p className={styles.message}>Loading file…</p>);
  if (file.error || !file.data)
    return simple(
      <div className={styles.card}>
        <h3>Could not load the conflicted file</h3>
        <p>{(file.error as Error | null)?.message ?? 'Unknown error'}</p>
        <WholeFileButtons repoId={repoId} info={info} state={state.data} labels={labels} />
        <button type="button" onClick={() => void openInEditor({ repoId, path })}>
          Open in editor (with markers)
        </button>
      </div>,
    );
  const merged = file.data.mergedDiff3;
  if (merged == null)
    return simple(
      <div className={styles.card}>
        <h3>No merge result</h3>
        <p>The 3-way merge could not be computed for this file. Resolve it as a whole file instead.</p>
        <WholeFileButtons repoId={repoId} info={info} state={state.data} labels={labels} />
      </div>,
    );

  // the working file vs this tool's view of the merge (spec 08 §6.4, §8 "resolved outside the app")
  const working = file.data.working;
  const saved = getMergeSession(repoId, path);
  const sessionDiverged =
    !!saved && saved.working !== undefined && lf(saved.working) !== lf(working) && working !== null;
  const divergence = saved ? 'none' : workingDivergence(merged, working);
  if (source === null && (sessionDiverged || divergence !== 'none')) {
    const resolvedOutside = divergence === 'resolved' || info.unresolvedChunks === 0;
    const startFresh = (): void => {
      setMergeSession(repoId, path, null);
      setSource('fresh');
    };
    return simple(
      <div className={styles.card}>
        <h3>{resolvedOutside ? 'Resolved outside the app?' : 'The file changed outside the merge tool'}</h3>
        <p>
          {resolvedOutside ? (
            <>
              <code>{path}</code> no longer contains conflict markers — it was probably resolved in an editor
              or another tool. Mark it resolved, or review it here.
            </>
          ) : sessionDiverged ? (
            <>
              <code>{path}</code> was edited on disk after you started merging it here.
            </>
          ) : (
            <>
              <code>{path}</code> on disk differs from git&apos;s merge result (it was edited outside the
              app).
            </>
          )}
        </p>
        <div className={styles.cardButtons}>
          {resolvedOutside && (
            <button type="button" className="primary" onClick={() => quiet(markResolved(repoId, info))}>
              Mark resolved
            </button>
          )}
          <button type="button" onClick={() => setSource('working')}>
            Load current file contents
          </button>
          <button type="button" onClick={startFresh}>
            Start fresh
          </button>
        </div>
      </div>,
    );
  }
  const text = source === 'working' && working != null ? working : merged;
  const large = text.length > LARGE_BYTES || text.split('\n', LARGE_LINES + 1).length > LARGE_LINES;
  if (large && !allowLarge)
    return simple(
      <div className={styles.card}>
        <h3>Large conflicted file</h3>
        <p>
          This file is very large. Resolving it as a whole file is recommended
          {/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(path)
            ? ' — lock files are best regenerated: take either side, then run install'
            : ''}
          .
        </p>
        <WholeFileButtons repoId={repoId} info={info} state={state.data} labels={labels} />
        <button type="button" onClick={() => setAllowLarge(true)}>
          Open in the merge tool anyway
        </button>
      </div>,
    );

  return (
    <TextMergeTool
      key={`${path}\u0000${file.dataUpdatedAt}\u0000${source ?? ''}`}
      repoId={repoId}
      path={path}
      info={info}
      contents={file.data}
      mergedDiff3={text}
      fromWorking={source === 'working'}
      opState={state.data}
      labels={labels}
    />
  );
}

function WholeFileButtons(props: {
  repoId: RepoId;
  info: ConflictFileInfo;
  state: RepoOperationState | undefined;
  labels: Labels;
}) {
  const { repoId, info, state, labels } = props;
  const take = (side: 'ours' | 'theirs' | 'base'): void =>
    quiet(
      takeSide(
        repoId,
        [info.path],
        side,
        side === 'ours' ? labels.a : side === 'theirs' ? labels.b : 'base',
      ).then(() => advance(repoId, info.path, state)),
    );
  return (
    <div className={styles.cardButtons}>
      {info.stages.ours && (
        <button type="button" title={labels.tip} onClick={() => take('ours')}>
          Take A — {labels.a}
        </button>
      )}
      {info.stages.theirs && (
        <button type="button" title={labels.tip} onClick={() => take('theirs')}>
          Take B — {labels.b}
        </button>
      )}
      {info.stages.base && (
        <button type="button" title="The common ancestor's version" onClick={() => take('base')}>
          Take base
        </button>
      )}
    </div>
  );
}

/** Rename/rename and rename/delete groups (spec 08 §4.6): the DD source path plus the AU / UA targets. */
function renameGroup(
  info: ConflictFileInfo,
  state: RepoOperationState | undefined,
): { origin: string; targets: ConflictFileInfo[] } | null {
  const all = state?.conflicts ?? [];
  const dd = all.filter((c) => c.code === 'DD');
  const targets = all.filter((c) => c.code === 'AU' || c.code === 'UA');
  if (dd.length !== 1 || !targets.length) return null;
  if (info.code !== 'DD' && !targets.includes(info)) return null;
  return { origin: dd[0]!.path, targets };
}

/** Non-text conflicts (spec 08 §4.6): delete/modify, add/add-only, renames, binary, submodule, symlink. */
function SpecialConflict(props: {
  repoId: RepoId;
  info: ConflictFileInfo;
  contents: ConflictFileContents | undefined;
  state: RepoOperationState | undefined;
  labels: Labels;
}) {
  const { repoId, info, contents, state, labels } = props;
  const run = (
    action: Extract<Parameters<typeof runOp>[1], { type: 'conflict.resolveSpecial' }>['action'],
    toast: string,
  ): void =>
    quiet(
      runOp(
        repoId,
        { type: 'conflict.resolveSpecial', path: info.path, action },
        { successToast: toast },
      ).then((r) => {
        if (r) {
          setMergeSession(repoId, info.path, null);
          advance(repoId, info.path, state);
        }
      }),
    );
  const resolve = (action: 'keep' | 'delete'): void =>
    run(action, action === 'keep' ? `Kept ${info.path}` : `Deleted ${info.path}`);
  const stageSha = (s?: { sha: string }): string => (s ? shortSha(s.sha) : '—');
  const A = `A (${labels.a})`;
  const B = `B (${labels.b})`;

  let title: string;
  let message: ReactNode;
  let buttons: ReactNode;
  let preview: string | null | undefined;
  let extra: ReactNode = null;
  const group = renameGroup(info, state);
  if (group) {
    const names = group.targets.map((t) => t.path);
    title = 'Renamed differently on each side';
    message = (
      <>
        <code>{group.origin}</code> was renamed to{' '}
        {group.targets.map((t, i) => (
          <span key={t.path}>
            {i > 0 && ' and '}
            <code>{t.path}</code> ({t.code === 'AU' ? A : B})
          </span>
        ))}
        . Keep one name, or both.
      </>
    );
    buttons = (
      <>
        {group.targets.map((t) => (
          <button
            key={t.path}
            type="button"
            onClick={() =>
              run(
                { rename: { keep: [t.path], remove: [group.origin, ...names.filter((n) => n !== t.path)] } },
                `Kept ${t.path}`,
              )
            }
          >
            Keep {t.path}
          </button>
        ))}
        {names.length > 1 && (
          <button
            type="button"
            className="primary"
            onClick={() => run({ rename: { keep: names, remove: [group.origin] } }, 'Kept both names')}
          >
            Keep both
          </button>
        )}
      </>
    );
  } else
    switch (info.code) {
      case 'DU':
      case 'UD': {
        const deleter = info.code === 'DU' ? A : B;
        const modifier = info.code === 'DU' ? B : A;
        title = 'Deleted on one side, modified on the other';
        message = (
          <>
            {deleter} deleted this file; {modifier} modified it.
          </>
        );
        preview = info.code === 'DU' ? contents?.theirs : contents?.ours;
        buttons = (
          <>
            <button type="button" className="primary" onClick={() => resolve('keep')}>
              Keep {modifier}&apos;s file
            </button>
            <button type="button" onClick={() => resolve('delete')}>
              Delete file
            </button>
          </>
        );
        break;
      }
      case 'AU':
      case 'UA': {
        const adder = info.code === 'AU' ? A : B;
        title = 'Added on one side only';
        message = <>Only {adder} has this file (for example after a rename or directory change).</>;
        preview = info.code === 'AU' ? contents?.ours : contents?.theirs;
        buttons = (
          <>
            <button type="button" className="primary" onClick={() => resolve('keep')}>
              Keep file
            </button>
            <button type="button" onClick={() => resolve('delete')}>
              Delete file
            </button>
          </>
        );
        break;
      }
      case 'DD':
        title = 'Deleted on both sides';
        message = <>Both sides removed this path (typically a rename to different names on each side).</>;
        buttons = (
          <button type="button" className="primary" onClick={() => resolve('delete')}>
            Delete file
          </button>
        );
        break;
      default: {
        const kind = contents?.binary && info.kind === 'text' ? 'binary' : info.kind;
        title =
          kind === 'submodule'
            ? 'Submodule commit differs'
            : kind === 'symlink'
              ? 'Symbolic link targets differ'
              : kind === 'lfs'
                ? 'Git LFS objects differ'
                : 'Binary file differs';
        message = (
          <>
            {A}: <code>{stageSha(info.stages.ours)}</code> · {B}: <code>{stageSha(info.stages.theirs)}</code>
            {kind === 'symlink' && contents && (
              <>
                <br />
                {A} → <code>{contents.ours ?? '—'}</code>
                <br />
                {B} → <code>{contents.theirs ?? '—'}</code>
              </>
            )}
            {contents?.attrBinary && (
              <>
                <br />
                <code>.gitattributes</code> marks this file as binary (or <code>-merge</code>), so it is never
                merged as text.
              </>
            )}
          </>
        );
        buttons = (
          <>
            <WholeFileButtons repoId={repoId} info={info} state={state} labels={labels} />
            {kind === 'submodule' && (
              <button
                type="button"
                onClick={() =>
                  void prompt({
                    title: `Choose the commit for ${info.path}`,
                    label: 'Full commit id of the submodule',
                    initial: info.stages.ours?.sha ?? '',
                    okLabel: 'Use commit',
                    validate: (v) =>
                      FULL_SHA.test(v.trim()) ? null : 'Enter a full 40-character commit id.',
                  }).then((r) => {
                    if (r)
                      run(
                        { submoduleSha: r.value.trim().toLowerCase() },
                        `Set ${info.path} to ${shortSha(r.value.trim())}`,
                      );
                  })
                }
              >
                Choose commit…
              </button>
            )}
            {kind === 'symlink' && (
              <button
                type="button"
                onClick={() =>
                  void prompt({
                    title: `Link target for ${info.path}`,
                    label: 'Target path',
                    initial: contents?.ours ?? contents?.theirs ?? '',
                    okLabel: 'Set target',
                    validate: (v) => (v.trim() && !/[\r\n]/.test(v) ? null : 'Enter a target path.'),
                  }).then((r) => {
                    if (r) run({ symlinkTarget: r.value.trim() }, `Set ${info.path} → ${r.value.trim()}`);
                  })
                }
              >
                Edit target…
              </button>
            )}
          </>
        );
        if ((kind === 'binary' || kind === 'lfs') && IMAGE.test(info.path)) {
          // image preview through githappens-rev:// (spec 07): commits when known (fresh), else the index stages
          const rev = (sha: string | null | undefined, stage: string): string => sha || stage;
          extra = (
            <div className={styles.imagePair}>
              {info.stages.ours && (
                <figure>
                  <img
                    alt={`A — ${labels.a}`}
                    src={revisionUrl(repoId, rev(state?.current.sha, ':2'), info.path)}
                  />
                  <figcaption>A — {labels.a}</figcaption>
                </figure>
              )}
              {info.stages.theirs && (
                <figure>
                  <img
                    alt={`B — ${labels.b}`}
                    src={revisionUrl(
                      repoId,
                      state?.op === 'revert' ? ':3' : rev(state?.incoming.sha, ':3'),
                      info.path,
                    )}
                  />
                  <figcaption>B — {labels.b}</figcaption>
                </figure>
              )}
            </div>
          );
        }
      }
    }
  const previewLines = preview?.split(/\r?\n/).slice(0, 200).join('\n');
  return (
    <div className={styles.card}>
      <h3>{title}</h3>
      <p>{message}</p>
      <div className={styles.cardButtons}>{buttons}</div>
      {extra}
      {previewLines && (
        <pre className={styles.preview} aria-label="File preview">
          {previewLines}
        </pre>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Text merge tool

const SOURCE_TEXT: Record<ChunkSource, string> = {
  unresolved: 'unresolved',
  a: 'A',
  b: 'B',
  mixed: 'A + B',
  edited: 'edited',
  empty: 'resolved as empty',
};

interface Snapshot {
  text: string;
  regions: { start: number; end: number }[];
}

type PaneKey = 'a' | 'b' | 'base' | 'out';

const modeOf = (s?: { mode: string }): string | undefined => s?.mode;

function TextMergeTool(props: {
  repoId: RepoId;
  path: string;
  info: ConflictFileInfo;
  contents: ConflictFileContents;
  mergedDiff3: string;
  fromWorking: boolean;
  opState: RepoOperationState | undefined;
  labels: Labels;
}) {
  const { repoId, path, contents, mergedDiff3, opState, labels, info, fromWorking } = props;
  const fontSize = useSetting('editor.fontSize') ?? 12;
  const language = languageFor(path);
  const doc: MergeDocument = useMemo(
    () => parseMerged(mergedDiff3, contents.eol),
    [mergedDiff3, contents.eol],
  );
  const sideText = useMemo(
    () => ({
      a: lf(contents.ours) ?? '',
      b: lf(contents.theirs) ?? '',
      base: lf(contents.base) ?? '',
    }),
    [contents.ours, contents.theirs, contents.base],
  );
  const ranges = useMemo(
    () => ({
      a: chunkRanges(doc, 'a', splitLines(sideText.a).lines),
      b: chunkRanges(doc, 'b', splitLines(sideText.b).lines),
      base: chunkRanges(doc, 'base', splitLines(sideText.base).lines),
    }),
    [doc, sideText],
  );

  const [init] = useState(() => {
    const saved = getMergeSession(repoId, path);
    if (saved && saved.fingerprint === mergedDiff3 && saved.states.length === doc.chunks.length)
      return { ...saved, generation: sessionGeneration(repoId) };
    // also for "Load current file contents": the doc was parsed from the working file, so the layout
    // (stable text + its marker blocks) reproduces that file
    const states = doc.chunks.map(emptyState);
    const layout = editorLayout(doc, states);
    return {
      fingerprint: mergedDiff3,
      text: layout.text,
      regions: layout.regions,
      states,
      dirty: false,
      working: contents.working,
      generation: sessionGeneration(repoId),
    };
  });
  const [states, setStates] = useState<ChunkState[]>(init.states);
  const [dirty, setDirty] = useState(init.dirty);
  const [current, setCurrent] = useState(0);
  const [busy, setBusy] = useState(false);
  const [showBase, setShowBase] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [ignoreWs, setIgnoreWs] = useState(false);
  const [autoUndo, setAutoUndo] = useState<{ i: number; prev: ChunkState; auto: ChunkState }[]>([]);
  const oursMode = modeOf(info.stages.ours);
  const theirsMode = modeOf(info.stages.theirs);
  const modeConflict =
    oursMode !== theirsMode && [oursMode, theirsMode].every((m) => m === '100644' || m === '100755');
  const [executable, setExecutable] = useState<boolean>(oursMode === '100755');

  const statesRef = useRef(init.states);
  const dirtyRef = useRef(init.dirty);
  const workingRef = useRef<string | null | undefined>(init.working);
  const currentRef = useRef(0);
  const editorRef = useRef<Editor | null>(null);
  const eds = useRef<Record<PaneKey, Editor | null>>({ a: null, b: null, base: null, out: null });
  const lastFocused = useRef<Editor | null>(null);
  const syncing = useRef<PaneKey | 'nav' | null>(null);
  const decoIds = useRef<string[]>([]);
  const applying = useRef(false);
  const discard = useRef(false);
  const snapshot = useRef<Snapshot | null>(null);
  const history = useRef<ChunkState[][]>(init.states.map((s) => [s]));
  const actions = useRef<{ save(resolve: boolean): void; nav(dir: 1 | -1, any: boolean): void } | null>(null);

  // ---- editor plumbing (only called from event handlers / editor callbacks) ----

  const model = (): monaco.editor.ITextModel | null => {
    const m = editorRef.current?.getModel();
    return m && !m.isDisposed() ? m : null;
  };

  const rangeOf = (i: number): monaco.Range | null => {
    const id = decoIds.current[i];
    return id ? (model()?.getDecorationRange(id) ?? null) : null;
  };

  const decoOptions = (i: number, st: ChunkState, empty: boolean): monaco.editor.IModelDecorationOptions => {
    const src = chunkSource(st);
    return {
      stickiness: monaco.editor.TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges,
      isWholeLine: !empty,
      className: empty
        ? undefined
        : `${styles[`out_${src}`]} ${i === currentRef.current ? styles.outCurrent : ''}`,
      linesDecorationsClassName: empty ? undefined : styles[`gut_${src}`],
      hoverMessage: { value: `Conflict ${i + 1} — ${SOURCE_TEXT[src]}` },
      overviewRuler: {
        color: src === 'unresolved' ? '#f0a04b' : '#4fb36b',
        position: monaco.editor.OverviewRulerLane.Right,
      },
    };
  };

  /** Re-create all chunk decorations; `ranges` overrides the current tracked ranges. */
  const redecorate = (sts: ChunkState[], over?: (monaco.IRange | null)[]): void => {
    const m = model();
    if (!m) return;
    const next = doc.chunks.map((_, i) => {
      const r = over?.[i] ?? rangeOf(i) ?? new monaco.Range(1, 1, 1, 1);
      const empty = r.startLineNumber === r.endLineNumber && r.startColumn === r.endColumn;
      return { range: r, options: decoOptions(i, sts[i] ?? emptyState(), empty) };
    });
    decoIds.current = m.deltaDecorations(decoIds.current, next);
  };

  const commitStates = (next: ChunkState[]): void => {
    statesRef.current = next;
    setStates(next);
  };

  const takeSnapshot = (m: monaco.editor.ITextModel | null = model()): Snapshot | null => {
    if (!m) return snapshot.current;
    return {
      text: m.getValue(),
      regions: doc.chunks.map((_, i) => {
        const id = decoIds.current[i];
        const r = id ? m.getDecorationRange(id) : null;
        return r
          ? { start: m.getOffsetAt(r.getStartPosition()), end: m.getOffsetAt(r.getEndPosition()) }
          : { start: 0, end: 0 };
      }),
    };
  };

  const persist = (isDirty: boolean): void => {
    if (discard.current || sessionGeneration(repoId) !== init.generation) return;
    const snap = takeSnapshot();
    if (!snap) return;
    setMergeSession(repoId, path, {
      fingerprint: mergedDiff3,
      text: snap.text,
      regions: snap.regions,
      states: statesRef.current,
      dirty: isDirty,
      working: workingRef.current,
    });
  };

  const markDirty = (v: boolean): void => {
    const was = dirtyRef.current;
    dirtyRef.current = v;
    setDirty(v);
    if (was !== v) persist(v);
  };

  /** Replace chunk i's output text according to `next` (undoable) and update state. */
  const setChunks = (updates: { i: number; next: ChunkState }[], record = true): void => {
    const m = model();
    const ed = editorRef.current;
    if (!m || !ed) return;
    const sts = [...statesRef.current];
    // Bottom-up, so an edit never moves a region that is edited after it; regions above shift
    // the ones below by their net length change (`delta`).
    const ordered = [...updates].sort((x, y) => y.i - x.i);
    const placed: { i: number; start: number; len: number; delta: number }[] = [];
    ed.pushUndoStop();
    applying.current = true;
    try {
      for (const { i, next } of ordered) {
        const r = rangeOf(i);
        if (!r) continue;
        const lines = chunkLines(doc.chunks[i]!, next);
        const body = regionText(lines);
        let start = m.getOffsetAt(r.getStartPosition());
        let end = m.getOffsetAt(r.getEndPosition());
        let text: string;
        if (start === end) {
          text = lines.length ? `${body}\n` : '';
        } else if (lines.length) {
          text = body;
        } else {
          // Remove the region including one adjacent newline.
          if (end < m.getValueLength() && m.getValueInRange(rangeAt(m, end, end + 1)) === `\n`) end += 1;
          else if (start > 0) start -= 1;
          text = '';
        }
        if (text || end > start) {
          ed.executeEdits('merge-tool', [{ range: rangeAt(m, start, end), text, forceMoveMarkers: false }]);
        }
        placed.push({ i, start, len: lines.length ? body.length : 0, delta: text.length - (end - start) });
        sts[i] = next;
        if (record) history.current[i] = [...(history.current[i] ?? []), next].slice(-50);
      }
    } finally {
      applying.current = false;
    }
    ed.pushUndoStop();
    const rs: (monaco.IRange | null)[] = [];
    for (const p of placed) {
      const shift = placed.filter((q) => q.i < p.i).reduce((sum, q) => sum + q.delta, 0);
      rs[p.i] = rangeAt(m, p.start + shift, p.start + shift + p.len);
    }
    commitStates(sts);
    redecorate(sts, rs);
    markDirty(true);
  };

  const setChunk = (i: number, next: ChunkState, record = true): void => setChunks([{ i, next }], record);

  // AI conflict assist (spec 12 §4.4): proposals are only written into the output on Accept.
  const aiAssist = useConflictAssist({
    repoId,
    path,
    chunks: doc.chunks,
    onAccept: (updates) =>
      setChunks(updates.map(({ index, lines }) => ({ i: index, next: { selected: [], edited: lines } }))),
  });

  /** User typing / undo: re-derive each chunk's state from its region text. */
  const onContentChanged = (): void => {
    if (applying.current) return;
    const m = model();
    if (!m) return;
    let changed = false;
    const sts = statesRef.current.map((st, i) => {
      const r = rangeOf(i);
      if (!r) return st;
      const txt = m.getValueInRange(r, monaco.editor.EndOfLinePreference.LF);
      const seg = doc.chunks[i]!;
      if (txt === regionText(chunkLines(seg, st))) return st;
      changed = true;
      const h = [...(history.current[i] ?? [])]
        .reverse()
        .find((x) => regionText(pickedLines(seg, x)) === txt);
      if (h) return h;
      return { ...st, edited: regionLines(txt) };
    });
    if (changed) {
      commitStates(sts);
      redecorate(sts);
    }
    if (!dirtyRef.current) markDirty(true);
  };

  const onMount: OnMount = (ed) => {
    editorRef.current = ed;
    eds.current.out = ed;
    const m = ed.getModel();
    if (!m) return;
    m.setEOL(monaco.editor.EndOfLineSequence.LF);
    const rs = init.regions.map((r) => rangeAt(m, r.start, r.end));
    redecorate(statesRef.current, rs);
    m.onDidChangeContent(onContentChanged);
    m.onWillDispose(() => {
      snapshot.current = takeSnapshot(m);
    });
    ed.onDidFocusEditorText(() => {
      lastFocused.current = ed;
    });
    ed.onDidScrollChange((e) => {
      if (e.scrollTopChanged) syncFrom('out');
    });
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => actions.current?.save(false));
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => actions.current?.save(true));
    ed.addCommand(monaco.KeyCode.F7, () => actions.current?.nav(1, false));
    ed.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.F7, () => actions.current?.nav(-1, false));
    const first = findChunk(statesRef.current, -1, 1, (s) => !isResolved(s));
    if (first >= 0) setTimeout(() => reveal(first), 0);
  };

  // ---- scroll sync (spec 08 §4.3: panes aligned by conflict chunk) ----

  const anchors = (k: PaneKey): number[] =>
    k === 'out'
      ? doc.chunks.map((_, i) => rangeOf(i)?.startLineNumber ?? 1)
      : ranges[k].map((r) => r.start + 1);

  const syncFrom = (k: PaneKey): void => {
    if (syncing.current && syncing.current !== k) return;
    const src = eds.current[k];
    const vr = src?.getVisibleRanges()[0];
    if (!src || !vr) return;
    const line = vr.startLineNumber;
    const off = src.getScrollTop() - src.getTopForLineNumber(line);
    syncing.current = k;
    const from = anchors(k);
    for (const o of ['a', 'b', 'base', 'out'] as PaneKey[]) {
      const dst = eds.current[o];
      if (o === k || !dst) continue;
      const l = syncLine(from, anchors(o), line);
      dst.setScrollTop(Math.max(0, dst.getTopForLineNumber(l) + off));
    }
    requestAnimationFrame(() => {
      if (syncing.current === k) syncing.current = null;
    });
  };

  // ---- navigation ----

  /** A side pane mounted (or was toggled on): show the current chunk there too. */
  const attachPane = (k: 'a' | 'b' | 'base', ed: Editor | null): void => {
    eds.current[k] = ed;
    const r = ranges[k][currentRef.current];
    if (ed && r) requestAnimationFrame(() => ed.revealLineInCenter(r.start + 1));
  };

  const reveal = (i: number): void => {
    currentRef.current = i;
    setCurrent(i);
    syncing.current = 'nav';
    const r = rangeOf(i);
    const ed = editorRef.current;
    if (r && ed) {
      ed.revealLineInCenter(r.startLineNumber);
      ed.setPosition(r.getStartPosition());
    }
    for (const k of ['a', 'b', 'base'] as const) {
      const rr = ranges[k][i];
      if (rr) eds.current[k]?.revealLineInCenter(rr.start + 1);
    }
    requestAnimationFrame(() => {
      if (syncing.current === 'nav') syncing.current = null;
    });
    redecorate(statesRef.current);
  };

  const nav = (dir: 1 | -1, any: boolean): void => {
    if (!doc.chunks.length) return;
    const i = findChunk(statesRef.current, currentRef.current, dir, any ? undefined : (s) => !isResolved(s));
    if (i >= 0) reveal(i);
    else if (any) reveal(currentRef.current);
  };

  // ---- save ----

  const save = async (resolve: boolean): Promise<void> => {
    const m = model();
    if (!m || busy) return;
    const text = serializeEditorText(m.getValue(), doc.eol, doc.finalNewline);
    const markers = hasMarkers(text);
    if (markers) {
      const n = Math.max(unresolvedCount(statesRef.current), 1);
      const ok = resolve
        ? await confirm(
            'Output still contains conflict markers',
            `${n} conflict${n === 1 ? ' is' : 's are'} unresolved or the output contains marker lines. Mark the file resolved anyway?`,
            'Save & mark resolved',
          )
        : await confirm(
            'Unresolved conflicts',
            `${n} conflict${n === 1 ? ' is' : 's are'} unresolved. Save anyway with conflict markers?`,
            'Save anyway',
          );
      if (!ok) return;
    }
    setBusy(true);
    try {
      const r = await runOp(
        repoId,
        {
          type: 'conflict.saveFile',
          path,
          text,
          markResolved: resolve,
          ...(resolve && modeConflict ? { executable } : {}),
        },
        { successToast: resolve ? `Resolved ${path}` : undefined },
      );
      if (!r) return;
      if (resolve) {
        discard.current = true;
        setMergeSession(repoId, path, null);
        advance(repoId, path, opState);
      } else {
        workingRef.current = text;
        dirtyRef.current = true; // force persist with the new working snapshot
        markDirty(false);
      }
    } finally {
      setBusy(false);
    }
  };

  const close = async (): Promise<void> => {
    if (dirtyRef.current) {
      const r = await choose({
        title: 'Unsaved merge result',
        message: `Save the merge output for ${path}?`,
        choices: [
          { value: 'cancel', label: 'Cancel' },
          { value: 'discard', label: 'Discard', danger: true },
          { value: 'save', label: 'Save', primary: true },
        ],
      });
      if (!r || r.value === 'cancel') return;
      if (r.value === 'save') await save(false);
      else {
        discard.current = true;
        setMergeSession(repoId, path, null);
      }
    }
    closeTool(repoId);
  };

  const resetAll = async (): Promise<void> => {
    const r = await choose({
      title: 'Reset all conflicts',
      message: 'Discard every pick and edit in the conflict regions? (Ctrl+Z undoes it.)',
      choices: [
        { value: 'cancel', label: 'Cancel' },
        { value: 'base', label: 'Reset to base' },
        { value: 'markers', label: 'Reset to conflict markers', primary: true },
      ],
    });
    if (!r || r.value === 'cancel') return;
    const next = r.value === 'base' ? resetToBase(doc) : doc.chunks.map(emptyState);
    setChunks(next.map((n, i) => ({ i, next: n })));
    setAutoUndo([]);
  };

  const autoResolve = (): void => {
    const before = statesRef.current;
    const next = autoResolveTrivial(doc, before);
    const changed = next.flatMap((n, i) => (n !== before[i] ? [{ i, next: n }] : []));
    if (changed.length) setChunks(changed);
    const undo = changed.map(({ i, next: n }) => ({ i, prev: before[i]!, auto: n }));
    setAutoUndo(undo);
    useToastStore.getState().push({
      kind: changed.length ? 'success' : 'info',
      title: changed.length
        ? `Auto-resolved ${changed.length} trivial conflict${changed.length === 1 ? '' : 's'}`
        : 'No trivial conflicts found',
      ...(changed.length ? { actions: [{ label: 'Undo', run: () => undoAuto(undo) }] } : {}),
    });
  };

  /** Explicit undo of the last auto-resolve (spec 08 §4.7), for chunks not changed since. */
  const undoAuto = (list: { i: number; prev: ChunkState; auto: ChunkState }[]): void => {
    const still = list.filter(({ i, auto }) => statesRef.current[i] === auto);
    if (still.length) setChunks(still.map(({ i, prev }) => ({ i, next: prev })));
    setAutoUndo([]);
  };

  const find = (): void => {
    const ed = lastFocused.current ?? editorRef.current;
    ed?.focus();
    void ed?.getAction('actions.find')?.run();
  };

  useEffect(() => {
    actions.current = { save: (r) => quiet(save(r)), nav };
  });

  useEffect(() => {
    for (const ed of Object.values(eds.current)) ed?.updateOptions({ wordWrap: wrap ? 'on' : 'off' });
  }, [wrap]);

  // Keep the session (picks + output) when the tool unmounts so reopening restores it.
  useEffect(
    () => () => {
      persist(dirtyRef.current);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // ---- pane interactions ----

  const st = (i: number): ChunkState => states[i] ?? emptyState();

  /** Keys inside the A / B / Base panes (spec 08 §4.4): A / B take, Shift appends, E edits, F7 / Alt+↑↓. */
  const onPaneKey = (e: monaco.IKeyboardEvent): boolean => {
    const i = currentRef.current;
    const seg = doc.chunks[i];
    const K = monaco.KeyCode;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.keyCode === K.KeyS) actions.current?.save(false);
    else if (mod && e.keyCode === K.Enter) actions.current?.save(true);
    else if (e.altKey && (e.keyCode === K.DownArrow || e.keyCode === K.UpArrow))
      nav(e.keyCode === K.DownArrow ? 1 : -1, mod);
    else if (e.keyCode === K.F7) nav(e.shiftKey ? -1 : 1, false);
    else if (!mod && !e.altKey && seg && (e.keyCode === K.KeyA || e.keyCode === K.KeyB)) {
      const side: Side = e.keyCode === K.KeyA ? 'a' : 'b';
      setChunk(i, e.shiftKey ? appendSide(seg, st(i), side) : takeChunkSide(seg, side));
    } else if (!mod && !e.altKey && e.keyCode === K.KeyE) editorRef.current?.focus();
    else return false;
    return true;
  };

  const focusChunk = (i: number): void => {
    if (i !== currentRef.current) {
      currentRef.current = i;
      setCurrent(i);
      redecorate(statesRef.current);
    }
  };

  const renderHeader =
    (side: PaneSide) =>
    (i: number): ReactNode => (
      <ChunkHeader
        side={side}
        seg={doc.chunks[i]!}
        st={st(i)}
        i={i}
        current={i === current}
        onFocus={focusChunk}
        onChange={setChunk}
      />
    );

  const unresolved = unresolvedCount(states);
  const total = doc.chunks.length;
  const paneProps = {
    language,
    fontSize,
    wrap,
    doc,
    states,
    current,
    ignoreWs,
    onChunkClick: focusChunk,
    onKey: onPaneKey,
    onFocus: (ed: Editor) => {
      lastFocused.current = ed;
    },
  };
  const autoUndoLive = autoUndo.some(({ i, auto }) => states[i] === auto);

  return (
    <div className={styles.view}>
      <div className={styles.toolbar}>
        <span className={styles.path} title={path}>
          {path}
        </span>
        <span className={styles.badge}>{CODE_TEXT[info.code]}</span>
        <div className={styles.nav}>
          <button
            type="button"
            className={styles.icon}
            aria-label="Previous unresolved conflict"
            title="Previous unresolved conflict (Shift+F7 / Alt+↑)"
            disabled={!total}
            onClick={() => nav(-1, false)}
          >
            <ChevronUp size={14} />
          </button>
          <span className={styles.counter}>
            {total ? `Conflict ${Math.min(current, total - 1) + 1} of ${total}` : 'No conflicts'}
          </span>
          <button
            type="button"
            className={styles.icon}
            aria-label="Next unresolved conflict"
            title="Next unresolved conflict (F7 / Alt+↓)"
            disabled={!total}
            onClick={() => nav(1, false)}
          >
            <ChevronDown size={14} />
          </button>
        </div>
        <span className={unresolved ? styles.unresolved : styles.allResolved}>
          {unresolved ? `${unresolved} unresolved` : 'All resolved'}
        </span>
        {fromWorking && <span className={styles.badge}>from file on disk</span>}
        <span className={styles.spacer} />
        <button
          type="button"
          title={`Take all of A (${labels.a})`}
          onClick={() => setChunks(takeAll(doc, 'a').map((next, i) => ({ i, next })))}
        >
          Take all A
        </button>
        <button
          type="button"
          title={`Take all of B (${labels.b})`}
          onClick={() => setChunks(takeAll(doc, 'b').map((next, i) => ({ i, next })))}
        >
          Take all B
        </button>
        <button
          type="button"
          className={styles.iconText}
          title="Reset every chunk to its conflict markers or to the base version"
          disabled={!total}
          onClick={() => quiet(resetAll())}
        >
          <RotateCcw size={14} /> Reset…
        </button>
        <button
          type="button"
          className={styles.iconText}
          title="Resolve chunks that differ only in whitespace or are identical"
          onClick={autoResolve}
        >
          <WandSparkles size={14} /> Auto-resolve
        </button>
        {autoUndoLive && (
          <button
            type="button"
            className={styles.iconText}
            title="Undo the last auto-resolve"
            onClick={() => undoAuto(autoUndo)}
          >
            <Undo2 size={14} /> Undo auto
          </button>
        )}
        {aiAssist.button}
        <ExternalMergeButton repoId={repoId} path={path} />
        <button
          type="button"
          className={styles.iconText}
          title="Save (Ctrl+S)"
          disabled={busy}
          onClick={() => quiet(save(false))}
        >
          <Save size={14} /> Save{dirty ? ' •' : ''}
        </button>
        <button
          type="button"
          className="primary"
          title="Save and mark resolved (Ctrl+Enter)"
          disabled={busy}
          onClick={() => quiet(save(true))}
        >
          Save &amp; mark resolved
        </button>
        <button
          type="button"
          className={styles.icon}
          aria-label="Close merge tool"
          title="Close"
          onClick={() => quiet(close())}
        >
          <X size={16} />
        </button>
      </div>
      <div className={styles.subToolbar}>
        <button
          type="button"
          className={`${styles.toggle} ${showBase ? styles.toggleOn : ''}`}
          aria-pressed={showBase}
          title="Show the common ancestor (base) as a third pane"
          onClick={() => setShowBase((v) => !v)}
        >
          <Columns3 size={13} /> Show base
        </button>
        <button
          type="button"
          className={`${styles.toggle} ${wrap ? styles.toggleOn : ''}`}
          aria-pressed={wrap}
          title="Word wrap"
          onClick={() => setWrap((v) => !v)}
        >
          <WrapText size={13} /> Wrap
        </button>
        <button
          type="button"
          className={`${styles.toggle} ${ignoreWs ? styles.toggleOn : ''}`}
          aria-pressed={ignoreWs}
          title="Don't highlight conflict lines that differ only in whitespace (display only)"
          onClick={() => setIgnoreWs((v) => !v)}
        >
          ␣ Ignore whitespace
        </button>
        <button type="button" className={styles.toggle} title="Find (Ctrl+F)" onClick={find}>
          <Search size={13} /> Find
        </button>
        {modeConflict && (
          <label className={styles.modeChooser} title="The sides disagree on the executable bit">
            Mode:
            <select
              value={executable ? '100755' : '100644'}
              onChange={(e) => setExecutable(e.target.value === '100755')}
            >
              <option value={oursMode}>{oursMode === '100755' ? 'executable' : 'not executable'} (A)</option>
              <option value={theirsMode}>
                {theirsMode === '100755' ? 'executable' : 'not executable'} (B)
              </option>
            </select>
          </label>
        )}
        <span className={styles.spacer} />
        <span className={styles.hintText}>A / B take · Shift+A/B append · E edit · F7 next</span>
      </div>

      {aiAssist.panel}
      <ExternalMergeOverlay repoId={repoId} path={path} />
      <div className={styles.split}>
        <div className={`${styles.paneHeaders} ${showBase ? styles.three : ''}`}>
          <div className={styles.paneHeader} title={labels.tip}>
            <span className={styles.sideA}>A</span> {labels.a} (current)
            {opState?.current.sha && <code>{shortSha(opState.current.sha)}</code>}
            {contents.ours === null && <em> — file absent</em>}
          </div>
          {showBase && (
            <div className={styles.paneHeader} title="Common ancestor (git stage 1)">
              <span className={styles.sideBase}>⌂</span> Base
              {opState?.base?.sha && <code>{shortSha(opState.base.sha)}</code>}
              {contents.base === null && <em> — no common version</em>}
            </div>
          )}
          <div className={styles.paneHeader} title={labels.tip}>
            <span className={styles.sideB}>B</span> {labels.b} (incoming)
            {opState?.incoming.sha && <code>{shortSha(opState.incoming.sha)}</code>}
            {contents.theirs === null && <em> — file absent</em>}
          </div>
        </div>
        <div
          className={`${styles.sidePanes} ${showBase ? styles.three : ''}`}
          aria-label="Conflict sides. A or B takes a side for the current conflict."
        >
          <SideEditor
            {...paneProps}
            side="a"
            text={sideText.a}
            ranges={ranges.a}
            header={renderHeader('a')}
            onToggleLine={(i, line) => setChunk(i, toggleLine(st(i), 'a', line))}
            onEditor={(ed) => attachPane('a', ed)}
            onScroll={() => syncFrom('a')}
          />
          {showBase && (
            <SideEditor
              {...paneProps}
              side="base"
              text={sideText.base}
              ranges={ranges.base}
              header={renderHeader('base')}
              onEditor={(ed) => attachPane('base', ed)}
              onScroll={() => syncFrom('base')}
            />
          )}
          <SideEditor
            {...paneProps}
            side="b"
            text={sideText.b}
            ranges={ranges.b}
            header={renderHeader('b')}
            onToggleLine={(i, line) => setChunk(i, toggleLine(st(i), 'b', line))}
            onEditor={(ed) => attachPane('b', ed)}
            onScroll={() => syncFrom('b')}
          />
        </div>
        <div className={styles.outputHeader}>
          <span>Output</span>
          <span className={styles.legend}>
            <i className={styles.gut_a} /> A <i className={styles.gut_b} /> B{' '}
            <i className={styles.gut_mixed} /> both <i className={styles.gut_edited} /> edited{' '}
            <i className={styles.gut_unresolved} /> unresolved
          </span>
        </div>
        <div className={styles.output}>
          <Editor
            defaultValue={init.text}
            defaultLanguage={language}
            theme={applyMonacoTheme()}
            onMount={onMount}
            options={{
              fontSize,
              automaticLayout: true,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              lineDecorationsWidth: 8,
              renderValidationDecorations: 'off',
              wordWrap: wrap ? 'on' : 'off',
            }}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * One full-file side pane (A, B or Base): read-only Monaco with the conflict regions tinted, a checkbox
 * glyph per conflict line (click to pick it), and a view-zone header above each chunk with the chunk
 * checkbox and pick buttons.
 */
function SideEditor(props: {
  side: PaneSide;
  text: string;
  language: string;
  fontSize: number;
  wrap: boolean;
  doc: MergeDocument;
  ranges: Range[];
  states: ChunkState[];
  current: number;
  ignoreWs: boolean;
  header?: (i: number) => ReactNode;
  onToggleLine?(i: number, line: number): void;
  onChunkClick(i: number): void;
  onKey(e: monaco.IKeyboardEvent): boolean;
  onFocus(ed: Editor): void;
  onEditor(ed: Editor | null): void;
  onScroll(): void;
}) {
  const { side, ranges, states, current, ignoreWs, doc } = props;
  // editor callbacks are registered once: they read the latest props through this ref
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });
  const [ed, setEd] = useState<Editor | null>(null);
  const deco = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const hasHeader = !!props.header;
  // one DOM node per chunk header; Monaco hosts them as view zones, React renders into them (portals)
  const zones = useMemo(
    () =>
      hasHeader
        ? ranges.map(() => {
            const node = document.createElement('div');
            node.className = styles.zone ?? '';
            return node;
          })
        : [],
    [ranges, hasHeader],
  );

  const chunkAt = (line0: number): number =>
    latest.current.ranges.findIndex((r) => line0 >= r.start && line0 < r.start + r.length);

  const onMount: OnMount = (editor) => {
    setEd(editor);
    latest.current.onEditor(editor);
    deco.current = editor.createDecorationsCollection();
    editor.onDidScrollChange((e) => {
      if (e.scrollTopChanged) latest.current.onScroll();
    });
    editor.onDidFocusEditorText(() => latest.current.onFocus(editor));
    editor.onKeyDown((e) => {
      if (latest.current.onKey(e)) {
        e.preventDefault();
        e.stopPropagation();
      }
    });
    editor.onMouseDown((e) => {
      const ln = e.target.position?.lineNumber;
      if (!ln) return;
      const i = chunkAt(ln - 1);
      if (i < 0) return;
      latest.current.onChunkClick(i);
      const T = monaco.editor.MouseTargetType;
      if (e.target.type === T.GUTTER_GLYPH_MARGIN || e.target.type === T.GUTTER_LINE_DECORATIONS) {
        const st = latest.current.states[i];
        if (st?.edited) return;
        latest.current.onToggleLine?.(i, ln - 1 - latest.current.ranges[i]!.start);
      }
    });
  };

  useEffect(() => () => latest.current.onEditor(null), []);

  // decorations: tint per side, picked lines, current chunk, checkbox glyphs
  useEffect(() => {
    if (!ed || !deco.current) return;
    const tint = side === 'a' ? styles.sideTintA : side === 'b' ? styles.sideTintB : styles.sideTintBase;
    const picked = side === 'a' ? styles.sidePickedA : styles.sidePickedB;
    const list: monaco.editor.IModelDeltaDecoration[] = [];
    ranges.forEach((r, i) => {
      const seg = doc.chunks[i];
      if (!seg) return;
      const st = states[i] ?? emptyState();
      for (let k = 0; k < r.length; k++) {
        const line = r.start + k + 1;
        const isPicked = side !== 'base' && st.selected.some((p) => p.side === side && p.line === k);
        const wsSame = ignoreWs && side !== 'base' && sameIgnoringWhitespace(seg.a[k], seg.b[k]);
        const cls = [
          isPicked ? picked : wsSame ? styles.wsEqual : tint,
          i === current ? styles.sideCurrent : '',
        ]
          .filter(Boolean)
          .join(' ');
        list.push({
          range: new monaco.Range(line, 1, line, 1),
          options: {
            isWholeLine: true,
            className: cls,
            ...(side !== 'base'
              ? {
                  glyphMarginClassName: st.edited
                    ? styles.glyphLocked
                    : isPicked
                      ? styles.glyphOn
                      : styles.glyphOff,
                  glyphMarginHoverMessage: {
                    value: st.edited
                      ? 'Edited in the output — reset the chunk to pick lines again'
                      : isPicked
                        ? 'Click to remove this line from the output'
                        : 'Click to add this line to the output',
                  },
                }
              : {}),
            overviewRuler: {
              color: side === 'a' ? '#5b9bd5' : side === 'b' ? '#c586c0' : '#999',
              position: monaco.editor.OverviewRulerLane.Left,
            },
          },
        });
      }
    });
    deco.current.set(list);
  }, [ed, side, ranges, states, current, ignoreWs, doc]);

  // view zones: a header above every chunk
  useEffect(() => {
    if (!ed || !zones.length) return;
    const ids: string[] = [];
    ed.changeViewZones((acc) => {
      ranges.forEach((r, i) => {
        ids.push(
          acc.addZone({
            afterLineNumber: r.start,
            heightInPx: 26,
            domNode: zones[i]!,
            suppressMouseDown: true,
          }),
        );
      });
    });
    return () => {
      ed.changeViewZones((acc) => {
        for (const id of ids) acc.removeZone(id);
      });
    };
  }, [ed, ranges, zones]);

  return (
    <div className={styles.sidePane}>
      <Editor
        defaultValue={props.text}
        defaultLanguage={props.language}
        theme={applyMonacoTheme()}
        onMount={onMount}
        options={{
          readOnly: true,
          domReadOnly: true,
          fontSize: props.fontSize,
          automaticLayout: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          glyphMargin: side !== 'base',
          folding: false,
          lineDecorationsWidth: 6,
          renderValidationDecorations: 'off',
          wordWrap: props.wrap ? 'on' : 'off',
        }}
      />
      {props.header && zones.map((node, i) => createPortal(props.header!(i), node, `zone-${i}`))}
    </div>
  );
}

/** Header above a conflict chunk in a side pane (view zone): chunk checkbox, state chip, pick buttons. */
function ChunkHeader(props: {
  side: PaneSide;
  seg: ConflictSegment;
  st: ChunkState;
  i: number;
  current: boolean;
  onFocus(i: number): void;
  onChange(i: number, next: ChunkState): void;
}) {
  const { side, seg, st: s, i } = props;
  const setChunk = props.onChange;
  const src = chunkSource(s);
  const edited = !!s.edited;
  const sides = new Set(s.selected.map((p) => p.side));
  return (
    <div
      className={`${styles.zoneHeader} ${props.current ? styles.zoneCurrent : ''}`}
      onMouseDown={() => props.onFocus(i)}
    >
      <span className={styles.chunkTitle}>
        {side === 'base' ? `Base · conflict ${i + 1}` : `Conflict ${i + 1}`}
      </span>
      {side !== 'base' && (
        <>
          <SideCheckbox seg={seg} st={s} side={side} disabled={edited} onChange={(n) => setChunk(i, n)} />
          <span className={`${styles.chip} ${styles[`chip_${src}`]}`}>
            {SOURCE_TEXT[src]}
            {s.auto ? ' (auto)' : ''}
          </span>
        </>
      )}
      {side === 'a' &&
        (edited ? (
          <button
            type="button"
            className={styles.small}
            onClick={() => setChunk(i, { ...s, edited: undefined })}
          >
            <RotateCcw size={12} /> Reset chunk
          </button>
        ) : (
          <>
            {sides.size > 1 && (
              <button
                type="button"
                className={styles.small}
                title="Swap A/B order"
                onClick={() => setChunk(i, flipOrder(s))}
              >
                <ArrowLeftRight size={12} /> Flip
              </button>
            )}
            <button type="button" className={styles.small} onClick={() => setChunk(i, takeBoth(seg, 'a'))}>
              A then B
            </button>
            <button type="button" className={styles.small} onClick={() => setChunk(i, takeBoth(seg, 'b'))}>
              B then A
            </button>
            {!isResolved(s) && (
              <button
                type="button"
                className={styles.small}
                title="Resolve this chunk with no lines"
                onClick={() => setChunk(i, resolveEmpty())}
              >
                Empty
              </button>
            )}
            {(s.selected.length > 0 || s.resolvedEmpty) && (
              <button type="button" className={styles.small} onClick={() => setChunk(i, emptyState())}>
                Clear
              </button>
            )}
          </>
        ))}
    </div>
  );
}
function SideCheckbox(props: {
  seg: ConflictSegment;
  st: ChunkState;
  side: Side;
  disabled: boolean;
  onChange(next: ChunkState): void;
}) {
  const { seg, st, side } = props;
  const check = sideCheck(seg, st, side);
  const lines = side === 'a' ? seg.a : seg.b;
  return (
    <label className={styles.sideCheck}>
      <input
        type="checkbox"
        disabled={props.disabled}
        checked={check === 'all' || (!lines.length && !!st.resolvedEmpty && !st.selected.length)}
        ref={(el) => {
          if (el) el.indeterminate = check === 'some';
        }}
        onChange={() => props.onChange(toggleSide(seg, st, side))}
      />
      <span className={side === 'a' ? styles.sideA : styles.sideB}>{side.toUpperCase()}</span>
      {lines.length ? `${lines.length} line${lines.length === 1 ? '' : 's'}` : 'deleted'}
    </label>
  );
}
