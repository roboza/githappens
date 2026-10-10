import { DiffEditor } from '@monaco-editor/react';
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';

import { applyMonacoTheme, languageFor, type monaco } from '../../lib/monaco';
import { monacoOptions, type EditorPrefs } from './editor-prefs';
import type { ChangeNav } from './nav';
import styles from './DiffView.module.css';

type DiffEditorInstance = monaco.editor.IStandaloneDiffEditor;

const MAX_COMPUTATION_MS = 2000;

/**
 * Whether Monaco gave up on the diff (`maxComputationTime` exceeded). The public API doesn't expose the
 * flag, so read the internal diff model when present and fall back to the elapsed time.
 */
function diffQuitEarly(editor: DiffEditorInstance, startedAt: number | null): boolean {
  try {
    type Obs<T> = { get(): T } | undefined;
    const internal = (editor as unknown as { _diffModel?: Obs<{ diff?: Obs<{ quitEarly?: boolean }> }> })
      ._diffModel;
    const flag = internal?.get()?.diff?.get()?.quitEarly;
    if (typeof flag === 'boolean') return flag;
  } catch {
    /* internal shape changed */
  }
  return startedAt !== null && performance.now() - startedAt >= MAX_COMPUTATION_MS - 50;
}

/**
 * Inline / Split modes (spec 07 §4.3, §6.4): Monaco DiffEditor with the advanced diff algorithm (inner
 * word changes), a 2 s computation budget and change navigation through `getLineChanges()`.
 */
export function MonacoDiff(props: {
  original: string;
  modified: string;
  path: string;
  split: boolean;
  ignoreTrimWhitespace: boolean;
  prefs: EditorPrefs;
  wordWrap: boolean;
  navRef: Ref<ChangeNav | null>;
  onNav(count: number, index: number): void;
  anchorLine?: number | null;
}) {
  const editorRef = useRef<DiffEditorInstance | null>(null);
  const [current, setCurrent] = useState(-1);
  const [count, setCount] = useState(0);
  const [quitEarly, setQuitEarly] = useState(false);
  const { onNav } = props;

  useEffect(() => onNav(count, current), [count, current, onNav]);

  const changes = (): monaco.editor.ILineChange[] => editorRef.current?.getLineChanges() ?? [];
  const lineOf = (c: monaco.editor.ILineChange): number =>
    c.modifiedEndLineNumber === 0 ? Math.max(1, c.modifiedStartLineNumber) : c.modifiedStartLineNumber;

  useImperativeHandle(
    props.navRef,
    (): ChangeNav => ({
      go(dir) {
        const list = changes();
        const next = current < 0 && dir < 0 ? list.length - 1 : current + dir;
        if (next < 0 || next >= list.length) return false;
        setCurrent(next);
        const ed = editorRef.current!.getModifiedEditor();
        const line = lineOf(list[next]!);
        ed.revealLineInCenter(line);
        ed.setPosition({ lineNumber: line, column: 1 });
        return true;
      },
      topLine() {
        return editorRef.current?.getModifiedEditor().getVisibleRanges()[0]?.startLineNumber ?? null;
      },
      reveal(line) {
        editorRef.current?.getModifiedEditor().revealLineNearTop(line);
      },
    }),
    [current],
  );

  const options = {
    ...monacoOptions(props.prefs, props.wordWrap),
    readOnly: true,
    originalEditable: false,
    renderSideBySide: props.split,
    useInlineViewWhenSpaceIsLimited: false,
    ignoreTrimWhitespace: props.ignoreTrimWhitespace,
    diffAlgorithm: 'advanced' as const,
    maxComputationTime: MAX_COMPUTATION_MS,
    renderOverviewRuler: true,
    diffWordWrap: props.wordWrap ? ('on' as const) : ('off' as const),
  };

  return (
    <div className={styles.monacoWrap}>
      {quitEarly && (
        <div className={styles.banner} role="status">
          Diff too complex — showing a simplified line diff. Hunk view uses git&apos;s exact hunks.
        </div>
      )}
      <div className={styles.monacoFill}>
        <DiffEditor
          original={props.original}
          modified={props.modified}
          language={props.prefs.syntaxHighlighting ? languageFor(props.path) : 'plaintext'}
          theme={applyMonacoTheme()}
          options={options}
          onMount={(editor) => {
            editorRef.current = editor;
            let anchor = props.anchorLine;
            let startedAt: number | null = performance.now();
            editor.onDidUpdateDiff(() => {
              setCount(editor.getLineChanges()?.length ?? 0);
              setQuitEarly(diffQuitEarly(editor, startedAt));
              startedAt = null;
              if (anchor) editor.getModifiedEditor().revealLineNearTop(anchor);
              anchor = null; // only the first computed diff restores the position
            });
          }}
        />
      </div>
    </div>
  );
}
