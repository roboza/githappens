import { DiffEditor, Editor } from '@monaco-editor/react';
import type { RepoId } from '@githappens/git/types';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Save } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { choose, confirm } from '../../components/Dialogs';
import { invoke, on } from '../../lib/api';
import { shortSha } from '../../lib/format';
import { applyMonacoTheme, languageFor } from '../../lib/monaco';
import { refreshScopes } from '../../repo/queries';
import { useRepoUiStore } from '../../stores/repo-ui';
import { useToastStore } from '../../stores/toasts';
import { monacoOptions, useEditorPrefs } from '../diff/editor-prefs';
import { displayEncodingFor } from '../preferences/repo/display-encoding';
import {
  decodeText,
  encodeText,
  ENCODING_LABELS,
  showFileText,
  type Eol,
  type TextEncodingId,
} from './codec';
import { filesInvoke } from './files-api';
import styles from './FileView.module.css';

/** Unsaved drafts survive the editor being unmounted (e.g. selecting a commit) for this session. */
const drafts = new Map<
  string,
  { text: string; encoding: TextEncodingId; eol: Eol; baseHash: string | null }
>();
const draftKey = (repoId: RepoId, path: string): string => `${repoId}\0${path}`;

/** Whether `path` has unsaved edits (FileView asks before switching away). */
export const hasUnsavedDraft = (repoId: RepoId, path: string): boolean => drafts.has(draftKey(repoId, path));
export const discardDraft = (repoId: RepoId, path: string): void =>
  void drafts.delete(draftKey(repoId, path));

interface Loaded {
  exists: boolean;
  text: string;
  encoding: TextEncodingId;
  eol: Eol;
  mixed: boolean;
  readOnly: boolean;
  hash: string | null;
  tooLarge?: boolean;
  binary?: boolean;
}

function looksBinary(b: Uint8Array): boolean {
  const n = Math.min(b.length, 8000);
  if (b.length >= 2 && ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff))) return false;
  for (let i = 0; i < n; i++) if (b[i] === 0) return true;
  return false;
}

async function readWorktree(repoId: RepoId, path: string): Promise<Loaded> {
  const r = await filesInvoke('fs:readWorktreeFile', { repoId, path });
  if (!r.exists)
    return {
      exists: false,
      text: '',
      encoding: 'utf8',
      eol: 'lf',
      mixed: false,
      readOnly: false,
      hash: null,
    };
  if (r.tooLarge || !r.bytes) {
    return {
      exists: true,
      text: '',
      encoding: 'utf8',
      eol: 'lf',
      mixed: false,
      readOnly: true,
      hash: null,
      tooLarge: true,
    };
  }
  if (looksBinary(r.bytes)) {
    return {
      exists: true,
      text: '',
      encoding: 'utf8',
      eol: 'lf',
      mixed: false,
      readOnly: true,
      hash: r.hash,
      binary: true,
    };
  }
  const d = decodeText(r.bytes, await displayEncodingFor(repoId));
  return { exists: true, ...d, readOnly: d.readOnly || !!r.symlink, hash: r.hash };
}

/** Atomic save outcome after resolving an on-disk conflict. */
type SaveOutcome = 'saved' | 'cancelled' | 'reloaded';

/**
 * In-app editor (spec 07 §4.11): working-tree file with EOL and encoding preserved (UTF-8 ± BOM,
 * UTF-16 LE/BE), atomic save with on-disk conflict detection (Reload / Overwrite / Compare), dirty state,
 * and a read-only mode for revisions (`rev`).
 */
export function FileEditor({ repoId, path, rev }: { repoId: RepoId; path: string; rev?: string }) {
  const qc = useQueryClient();
  const prefs = useEditorPrefs();
  const key = draftKey(repoId, path);
  const file = useQuery({
    queryKey: ['editorFile', repoId, path, rev ?? ':worktree'],
    queryFn: async (): Promise<Loaded> => {
      if (rev === undefined) return readWorktree(repoId, path);
      const r = await invoke('git:show:file', { repoId, rev, path, maxBytes: 50 * 1024 * 1024 });
      if (r.missing)
        return {
          exists: false,
          text: '',
          encoding: 'utf8',
          eol: 'lf',
          mixed: false,
          readOnly: true,
          hash: null,
        };
      if (r.tooLarge)
        return {
          exists: true,
          text: '',
          encoding: 'utf8',
          eol: 'lf',
          mixed: false,
          readOnly: true,
          hash: null,
          tooLarge: true,
        };
      const d = showFileText(r);
      if (!d)
        return {
          exists: true,
          text: '',
          encoding: 'utf8',
          eol: 'lf',
          mixed: false,
          readOnly: true,
          hash: null,
          binary: true,
        };
      return { exists: true, ...d, readOnly: true, hash: null };
    },
    staleTime: Infinity,
    gcTime: 0,
  });
  const loaded = file.data;
  const saved = drafts.get(key);
  const [draft, setDraft] = useState<string | null>(() => (rev === undefined ? (saved?.text ?? null) : null));
  const [encoding, setEncoding] = useState<TextEncodingId | null>(() =>
    rev === undefined ? (saved?.encoding ?? null) : null,
  );
  const [eol, setEol] = useState<Eol | null>(() => (rev === undefined ? (saved?.eol ?? null) : null));
  const [diskChanged, setDiskChanged] = useState(false);
  const [compare, setCompare] = useState<{ disk: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const text = draft ?? loaded?.text ?? '';
  const enc = encoding ?? loaded?.encoding ?? 'utf8';
  const lineEnd = eol ?? loaded?.eol ?? 'lf';
  const readOnly = rev !== undefined || !!loaded?.readOnly;
  const dirty =
    !readOnly && !!loaded && (text !== loaded.text || enc !== loaded.encoding || lineEnd !== loaded.eol);

  // keep the session draft in sync so an unmount (e.g. selecting a commit) doesn't lose edits
  useEffect(() => {
    if (rev !== undefined || !loaded) return;
    if (dirty) drafts.set(key, { text, encoding: enc, eol: lineEnd, baseHash: loaded.hash });
    else drafts.delete(key);
  }, [dirty, text, enc, lineEnd, key, loaded, rev]);

  const reload = useCallback(async (): Promise<void> => {
    drafts.delete(key);
    setDraft(null);
    setEncoding(null);
    setEol(null);
    setDiskChanged(false);
    setCompare(null);
    await file.refetch();
  }, [file, key]);

  const write = async (expectedHash: string | null | undefined): Promise<SaveOutcome> => {
    const bytes = encodeText(text, enc, lineEnd);
    const r = await filesInvoke('fs:writeWorktreeFile', {
      repoId,
      path,
      bytes,
      ...(expectedHash !== undefined ? { expectedHash } : {}),
    });
    if (r.ok) {
      drafts.delete(key);
      qc.setQueryData(['editorFile', repoId, path, ':worktree'], {
        exists: true,
        text,
        encoding: enc,
        eol: lineEnd,
        mixed: false,
        readOnly: false,
        hash: r.hash,
      } satisfies Loaded);
      setDraft(null);
      setEncoding(null);
      setEol(null);
      setDiskChanged(false);
      setCompare(null);
      refreshScopes(qc, repoId, ['status']);
      return 'saved';
    }
    const choice = await choose({
      title: 'File changed on disk',
      message: `${path} was changed outside the editor since it was opened.`,
      choices: [
        { value: 'cancel', label: 'Cancel' },
        { value: 'compare', label: 'Compare' },
        { value: 'reload', label: 'Reload (discard my edits)', danger: true },
        { value: 'overwrite', label: 'Overwrite', primary: true },
      ],
    });
    if (choice?.value === 'overwrite') return write(undefined);
    if (choice?.value === 'reload') {
      await reload();
      return 'reloaded';
    }
    if (choice?.value === 'compare') {
      const disk = await readWorktree(repoId, path);
      setCompare({ disk: disk.text });
    }
    return 'cancelled';
  };

  const save = async (): Promise<SaveOutcome> => {
    if (!dirty || !loaded || saving) return 'cancelled';
    setSaving(true);
    try {
      return await write(loaded.exists ? loaded.hash : null);
    } catch (e) {
      useToastStore
        .getState()
        .push({ kind: 'error', title: `Could not save ${path}`, body: (e as Error).message });
      return 'cancelled';
    } finally {
      setSaving(false);
    }
  };
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  });

  // Ctrl/Cmd+S saves while the editor view is open.
  useEffect(() => {
    if (readOnly) return;
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void saveRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [readOnly]);

  // on-disk changes (watcher refresh / window focus): reload silently when clean, warn when dirty
  const dirtyRef = useRef(dirty);
  useEffect(() => {
    dirtyRef.current = dirty;
  });
  useEffect(() => {
    if (rev !== undefined) return;
    let busy = false;
    const check = async (): Promise<void> => {
      const base = qc.getQueryData<Loaded>(['editorFile', repoId, path, ':worktree']);
      if (busy || !base) return;
      busy = true;
      try {
        const r = await filesInvoke('fs:readWorktreeFile', { repoId, path, maxBytes: 50 * 1024 * 1024 });
        const changed = (r.hash ?? null) !== base.hash || r.exists !== base.exists;
        if (!changed) return;
        if (dirtyRef.current) setDiskChanged(true);
        else void file.refetch();
      } catch {
        /* ignore transient read errors */
      } finally {
        busy = false;
      }
    };
    const off = on('git:repo:changed', (e) => e.repoId === repoId && void check());
    const onFocus = (): void => void check();
    window.addEventListener('focus', onFocus);
    return () => {
      off();
      window.removeEventListener('focus', onFocus);
    };
  }, [repoId, path, rev, qc, file]);

  if (file.isLoading) return <p className={styles.message}>Loading file…</p>;
  if (file.error)
    return <p className={styles.message}>Could not read the file: {(file.error as Error).message}</p>;
  if (!loaded) return null;
  if (!loaded.exists && rev !== undefined)
    return <p className={styles.message}>This file does not exist at {shortSha(rev)}.</p>;
  if (loaded.binary) return <p className={styles.message}>Binary files can&apos;t be edited here.</p>;
  if (loaded.tooLarge)
    return <p className={styles.message}>This file is too large to edit here (over 50 MB).</p>;

  const toWorkingCopy = (): void =>
    useRepoUiStore.getState().update(repoId, () => ({ center: { kind: 'file', path, mode: 'edit' } }));

  return (
    <div className={styles.editor}>
      {rev !== undefined && (
        <div className={styles.readOnlyBanner} role="status">
          Viewing <code>{/^[0-9a-f]{7,}$/i.test(rev) ? shortSha(rev) : rev}</code> (read-only) —{' '}
          <button type="button" onClick={toWorkingCopy}>
            Edit working copy
          </button>
        </div>
      )}
      {rev === undefined && loaded.encoding === 'unknown' && (
        <div className={styles.readOnlyBanner} role="status">
          This file isn&apos;t valid UTF-8 or UTF-16; it is shown as Latin-1 and opened read-only.
        </div>
      )}
      {rev === undefined && !loaded.exists && (
        <div className={styles.readOnlyBanner} role="status">
          This file doesn&apos;t exist in the working tree yet; saving creates it.
        </div>
      )}
      {diskChanged && (
        <div className={styles.readOnlyBanner} role="alert">
          File changed on disk.{' '}
          <button type="button" onClick={() => void reload()}>
            Reload
          </button>{' '}
          <button type="button" onClick={() => void write(undefined)}>
            Overwrite
          </button>{' '}
          <button
            type="button"
            onClick={() => void readWorktree(repoId, path).then((d) => setCompare({ disk: d.text }))}
          >
            Compare
          </button>
        </div>
      )}
      <div className={styles.editorBar}>
        <span className={styles.byline}>
          {readOnly ? 'Read-only' : dirty ? '● Unsaved changes' : 'Saved'}
          {loaded.mixed && ' · mixed line endings (saved as the selected one)'}
        </span>
        <select
          aria-label="Line endings"
          value={lineEnd}
          disabled={readOnly}
          onChange={(e) => setEol(e.target.value as Eol)}
        >
          <option value="lf">LF</option>
          <option value="crlf">CRLF</option>
        </select>
        <select
          aria-label="Encoding"
          value={enc}
          disabled={readOnly}
          onChange={(e) => setEncoding(e.target.value as TextEncodingId)}
        >
          {(['utf8', 'utf8bom', 'utf16le', 'utf16be'] as const).map((id) => (
            <option key={id} value={id}>
              {ENCODING_LABELS[id]}
            </option>
          ))}
          {enc === 'unknown' && <option value="unknown">{ENCODING_LABELS.unknown}</option>}
        </select>
        {!readOnly && (
          <>
            <button
              type="button"
              disabled={!dirty}
              onClick={async () => {
                if (
                  await confirm(
                    'Revert edits?',
                    'Your unsaved edits will be lost and the file reloaded from disk.',
                    'Revert',
                    true,
                  )
                )
                  await reload();
              }}
            >
              Revert
            </button>
            <button
              type="button"
              className="primary"
              disabled={!dirty || saving}
              onClick={() => void save()}
              title="Ctrl+S"
            >
              <Save size={13} /> Save
            </button>
          </>
        )}
      </div>
      {compare ? (
        <div className={styles.compare}>
          <div className={styles.readOnlyBanner} role="status">
            Left: file on disk · Right: your edits.{' '}
            <button type="button" onClick={() => void write(undefined)}>
              Overwrite with my edits
            </button>{' '}
            <button type="button" onClick={() => void reload()}>
              Reload from disk
            </button>{' '}
            <button type="button" onClick={() => setCompare(null)}>
              Back to editor
            </button>
          </div>
          <DiffEditor
            original={compare.disk}
            modified={text}
            language={prefs.syntaxHighlighting ? languageFor(path) : 'plaintext'}
            theme={applyMonacoTheme()}
            options={{ ...monacoOptions(prefs), readOnly: true, renderSideBySide: true }}
          />
        </div>
      ) : (
        <Editor
          value={text}
          language={prefs.syntaxHighlighting ? languageFor(path) : 'plaintext'}
          theme={applyMonacoTheme()}
          onChange={(v) => setDraft(v ?? '')}
          options={{ ...monacoOptions(prefs), readOnly }}
        />
      )}
    </div>
  );
}

/**
 * Ask before leaving an editor with unsaved edits (spec 07 §4.11): Save / Discard / Cancel. Saving here
 * can't resolve conflicts, so a conflict keeps the user in the editor. Returns true when leaving is OK.
 */
export async function confirmLeaveEditor(repoId: RepoId, path: string): Promise<boolean> {
  const d = drafts.get(draftKey(repoId, path));
  if (!d) return true;
  const choice = await choose({
    title: 'Unsaved changes',
    message: `Save your changes to ${path}?`,
    choices: [
      { value: 'cancel', label: 'Cancel' },
      { value: 'discard', label: 'Discard', danger: true },
      { value: 'save', label: 'Save', primary: true },
    ],
  });
  if (choice?.value === 'discard') {
    drafts.delete(draftKey(repoId, path));
    return true;
  }
  if (choice?.value !== 'save') return false;
  const r = await filesInvoke('fs:writeWorktreeFile', {
    repoId,
    path,
    bytes: encodeText(d.text, d.encoding, d.eol),
    expectedHash: d.baseHash,
  });
  if (!r.ok) {
    useToastStore.getState().push({
      kind: 'warning',
      title: 'File changed on disk',
      body: 'Not saved: resolve the conflict in the editor (Reload / Overwrite / Compare).',
    });
    return false;
  }
  drafts.delete(draftKey(repoId, path));
  return true;
}
