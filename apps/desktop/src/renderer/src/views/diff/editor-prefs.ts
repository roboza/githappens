import type { DiffOptions } from '@githappens/git/types';
import type { CSSProperties } from 'react';

import { useSetting } from '../../stores/settings';

/** Editor & Diff preferences (spec 13 "Editor & Diff") resolved with their defaults. */
export interface EditorPrefs {
  fontFamily: string;
  fontSize: number;
  tabSize: number;
  wordWrap: boolean;
  lineNumbers: boolean;
  syntaxHighlighting: boolean;
  renderWhitespace: 'none' | 'boundary' | 'all';
  showEol: boolean;
}

export function useEditorPrefs(): EditorPrefs {
  return {
    fontFamily: useSetting('editor.fontFamily') ?? "Menlo, Consolas, 'DejaVu Sans Mono', monospace",
    fontSize: useSetting('editor.fontSize') ?? 12,
    tabSize: useSetting('editor.tabSize') ?? 4,
    wordWrap: useSetting('editor.wordWrap') ?? false,
    lineNumbers: useSetting('editor.lineNumbers') ?? true,
    syntaxHighlighting: useSetting('editor.syntaxHighlighting') ?? true,
    renderWhitespace: useSetting('editor.renderWhitespace') ?? 'none',
    showEol: useSetting('editor.showEol') ?? false,
  };
}

export interface DiffPrefs {
  contextLines: number;
  whitespace: NonNullable<DiffOptions['ignoreWhitespace']>;
  ignoreBlankLines: boolean;
  renameLimit: number;
}

export function useDiffPrefs(): DiffPrefs {
  return {
    contextLines: useSetting('diff.contextLines') ?? 3,
    whitespace: useSetting('diff.whitespace') ?? 'none',
    ignoreBlankLines: useSetting('diff.ignoreBlankLines') ?? false,
    renameLimit: useSetting('diff.renameLimit') ?? 1000,
  };
}

/** Shared Monaco options derived from the preferences (spec 07 §6.4). */
export function monacoOptions(p: EditorPrefs, wordWrap = p.wordWrap) {
  return {
    fontFamily: p.fontFamily,
    fontSize: p.fontSize,
    tabSize: p.tabSize,
    wordWrap: wordWrap ? ('on' as const) : ('off' as const),
    lineNumbers: p.lineNumbers ? ('on' as const) : ('off' as const),
    renderWhitespace: p.renderWhitespace,
    renderControlCharacters: p.showEol,
    maxTokenizationLineLength: 20_000,
    automaticLayout: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
  };
}

/** Inline style for the custom renderers (hunk view, blame). */
export function codeStyle(p: EditorPrefs, wordWrap = p.wordWrap): CSSProperties {
  return {
    fontFamily: p.fontFamily,
    fontSize: p.fontSize,
    lineHeight: `${Math.round(p.fontSize * 1.6)}px`,
    tabSize: p.tabSize,
    ['--kl-code-wrap' as string]: wordWrap ? 'pre-wrap' : 'pre',
  };
}

export const WHITESPACE_LABELS: Record<DiffPrefs['whitespace'], string> = {
  none: 'Show all whitespace',
  eol: 'Ignore changes at EOL',
  amount: 'Ignore amount of whitespace',
  all: 'Ignore all whitespace',
};
