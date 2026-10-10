import type { RepoId, TodoAction, TodoItem } from '@githappens/git/types';
import { useQuery } from '@tanstack/react-query';
import { GripVertical, Pencil, X } from 'lucide-react';
import { useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';

import type { CommitMessageResult } from '../../../../shared/ipc/ai-contract';
import { describeAiError, needsSettings, openAiPreferences } from '../../ai/api';
import { useAiEnabled, useAiRun } from '../../ai/hooks';
import { confirm, prompt } from '../../components/Dialogs';
import { invoke } from '../../lib/api';
import { shortSha } from '../../lib/format';
import { isConflict, runOp } from '../../lib/ops';
import { useRepoUiStore } from '../../stores/repo-ui';
import { SparkleButton } from '../ai/SparkleButton';
import styles from './InteractiveRebaseView.module.css';

export interface InteractiveRebaseProps {
  repoId: RepoId;
  /** Exclusive lower bound: commits after it up to HEAD are rewritten. */
  upstream: string;
  /** Commit the todo is replayed onto. */
  onto: string;
  /** Human label, e.g. "feature/x onto main". */
  label: string;
}

const ACTIONS: { action: TodoAction; key: string; label: string; hint: string }[] = [
  { action: 'pick', key: 'p', label: 'Pick', hint: 'Use the commit' },
  { action: 'reword', key: 'r', label: 'Reword', hint: 'Use the commit, edit its message' },
  { action: 'edit', key: 'e', label: 'Edit', hint: 'Stop after this commit to amend it' },
  {
    action: 'squash',
    key: 's',
    label: 'Squash',
    hint: 'Meld into the previous (older) commit, combine messages',
  },
  {
    action: 'fixup',
    key: 'f',
    label: 'Fixup',
    hint: "Meld into the previous (older) commit, discard this commit's message",
  },
  { action: 'drop', key: 'd', label: 'Drop', hint: 'Remove the commit' },
];
const KEY_ACTION = new Map(ACTIONS.map((a) => [a.key, a.action]));
const folds = (a: TodoAction): boolean => a === 'squash' || a === 'fixup';

const backToGraph = (repoId: RepoId): void =>
  useRepoUiStore.getState().update(repoId, () => ({ center: { kind: 'graph' } }));

/** Squash/fixup groups (oldest-first todo): target sha → folded member shas. */
export function squashGroups(rows: TodoItem[]): { groups: Map<string, string[]>; error: string | null } {
  const groups = new Map<string, string[]>();
  let target: string | null = null;
  let error: string | null = null;
  for (const r of rows) {
    if (r.action === 'drop') continue;
    if (folds(r.action)) {
      if (!target) {
        error ??= `${shortSha(r.sha)} can't be ${r.action === 'squash' ? 'squashed' : 'fixed up'}: there is no older commit to fold it into.`;
        continue;
      }
      groups.get(target)!.push(r.sha);
    } else {
      target = r.sha;
      groups.set(target, []);
    }
  }
  return { groups, error };
}

/** Pre-filled combined message for a squash group (target message + squashed subjects). */
export function defaultSquashMessage(rows: TodoItem[], target: string, members: string[]): string {
  const bySha = new Map(rows.map((r) => [r.sha, r]));
  const t = bySha.get(target)!;
  const parts = [t.newMessage ?? t.summary];
  for (const m of members) {
    const r = bySha.get(m);
    if (r?.action === 'squash') parts.push(r.newMessage ?? r.summary);
  }
  return parts.join('\n\n');
}

/**
 * Interactive rebase editor (spec 05 §4.6): reorder commits by drag or Alt+↑/↓, pick an action per
 * row (P/R/E/S/F/D), reword inline, edit combined squash messages, then Start. Replaces the graph.
 */
export default function InteractiveRebaseView(props: InteractiveRebaseProps) {
  const { repoId, upstream } = props;
  const todo = useQuery({
    queryKey: ['rebaseTodo', repoId, upstream],
    queryFn: () => invoke('git:rebase:todoFor', { repoId, upstream }),
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });

  if (todo.isLoading) return <Shell {...props} message="Loading commits…" />;
  if (todo.error || !todo.data)
    return (
      <Shell
        {...props}
        message={`Can't start an interactive rebase: ${(todo.error as Error | null)?.message ?? 'no data'}`}
      />
    );
  if (!todo.data.length) return <Shell {...props} message="There are no commits to rebase." />;
  return <TodoEditor key={todo.dataUpdatedAt} {...props} initial={todo.data} />;
}

function Shell(props: InteractiveRebaseProps & { message: string }) {
  return (
    <div className={styles.view}>
      <div className={styles.header}>
        <h2 className={styles.title}>Interactive rebase: {props.label}</h2>
        <button type="button" onClick={() => backToGraph(props.repoId)}>
          Back to graph
        </button>
      </div>
      <p className={styles.message}>{props.message}</p>
    </div>
  );
}

function TodoEditor(props: InteractiveRebaseProps & { initial: TodoItem[] }) {
  const { repoId, upstream, onto, label, initial } = props;
  const [rows, setRows] = useState<TodoItem[]>(initial);
  const [oldestFirst, setOldestFirst] = useState(false);
  const [focus, setFocus] = useState<string | null>(initial[initial.length - 1]?.sha ?? null);
  const [editing, setEditing] = useState<string | null>(null);
  const [squashEditing, setSquashEditing] = useState<string | null>(null);
  const [squashMessages, setSquashMessages] = useState<Record<string, string>>({});
  const [drag, setDrag] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ sha: string; before: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const rowEls = useRef(new Map<string, HTMLDivElement>());
  // "Reword with AI" (spec 12 §11): one request at a time; the message only lands in the row's todo.
  const aiEnabled = useAiEnabled();
  const ai = useAiRun('commitMessage');
  const [aiSha, setAiSha] = useState<string | null>(null);
  const [editorVersion, setEditorVersion] = useState(0);

  const display = useMemo(() => (oldestFirst ? rows : [...rows].reverse()), [rows, oldestFirst]);
  const { groups, error } = useMemo(() => squashGroups(rows), [rows]);
  const memberOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const [t, ms] of groups) for (const s of ms) m.set(s, t);
    return m;
  }, [groups]);
  const changed = JSON.stringify(rows) !== JSON.stringify(initial);
  const oldest = rows[0]?.sha;

  const setAction = (sha: string, action: TodoAction): void => {
    if (folds(action) && sha === oldest) return;
    setRows((rs) => rs.map((r) => (r.sha === sha ? { ...r, action } : r)));
    if (action === 'reword') setEditing(sha);
  };

  const fromDisplay = (d: TodoItem[]): TodoItem[] => (oldestFirst ? d : [...d].reverse());

  const moveDisplay = (sha: string, dir: -1 | 1): void => {
    const d = [...display];
    const i = d.findIndex((r) => r.sha === sha);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= d.length) return;
    [d[i], d[j]] = [d[j]!, d[i]!];
    setRows(fromDisplay(d));
  };

  const moveTo = (sha: string, target: string, before: boolean): void => {
    if (sha === target) return;
    const d = display.filter((r) => r.sha !== sha);
    const moving = display.find((r) => r.sha === sha);
    let at = d.findIndex((r) => r.sha === target);
    if (!moving || at < 0) return;
    if (!before) at += 1;
    d.splice(at, 0, moving);
    setRows(fromDisplay(d));
  };

  const rewordWithAi = async (r: TodoItem): Promise<void> => {
    const before = { action: r.action, newMessage: r.newMessage };
    const write = (m: Partial<CommitMessageResult>): void => {
      if (m.summary === undefined) return;
      const msg = m.description?.trim() ? `${m.summary}\n\n${m.description.trimEnd()}` : m.summary;
      setRows((rs) => rs.map((x) => (x.sha === r.sha ? { ...x, action: 'reword', newMessage: msg } : x)));
    };
    const restore = (): void =>
      setRows((rs) =>
        rs.map((x) => {
          if (x.sha !== r.sha) return x;
          const { newMessage: _drop, ...rest } = x;
          return before.newMessage === undefined
            ? { ...rest, action: before.action }
            : { ...rest, action: before.action, newMessage: before.newMessage };
        }),
      );
    if (editing === r.sha) setEditing(null);
    setAiSha(r.sha);
    const result = await ai.start(
      { repoId, sha: r.sha, ...(r.newMessage ? { current: r.newMessage } : {}) },
      { onPartial: (p) => write(p as Partial<CommitMessageResult>), onReset: restore },
    );
    if (result) {
      write(result);
      // Open the editor on the generated message so the user can review / tweak it.
      setEditorVersion((v) => v + 1);
      setEditing(r.sha);
    } else restore();
  };

  const focusRow = (sha: string): void => {
    setFocus(sha);
    rowEls.current.get(sha)?.focus();
  };

  const onRowKey = (e: KeyboardEvent<HTMLDivElement>, r: TodoItem): void => {
    if (e.target !== e.currentTarget) return; // typing in the select / editors
    const i = display.findIndex((x) => x.sha === r.sha);
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const dir = e.key === 'ArrowUp' ? -1 : 1;
      if (e.altKey || e.metaKey) moveDisplay(r.sha, dir);
      else {
        const next = display[i + dir];
        if (next) focusRow(next.sha);
      }
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      setAction(r.sha, 'drop');
    } else if (e.key === 'Enter' && r.action === 'reword') {
      setEditing(r.sha);
    } else if (!e.ctrlKey && !e.metaKey && !e.altKey && KEY_ACTION.has(e.key.toLowerCase())) {
      setAction(r.sha, KEY_ACTION.get(e.key.toLowerCase())!);
    } else return;
    e.preventDefault();
  };

  // ---- drag & drop (HTML5) ----
  const onDragOver = (e: DragEvent<HTMLDivElement>, sha: string): void => {
    if (!drag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = e.currentTarget.getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    if (drop?.sha !== sha || drop.before !== before) setDrop({ sha, before });
  };
  const endDrag = (): void => {
    setDrag(null);
    setDrop(null);
  };

  const start = async (): Promise<void> => {
    if (error || busy || ai.running) return;
    if (rows.every((r) => r.action === 'drop')) {
      const ok = await confirm(
        'Drop all commits?',
        'Every commit is dropped, so the branch will point at the base commit.',
        'Drop all',
        true,
      );
      if (!ok) return;
    }
    // Combined messages for squash groups (pre-filled; editable here so the run is non-interactive).
    const messages: Record<string, string> = {};
    for (const [target, members] of groups) {
      if (!members.some((m) => rows.find((r) => r.sha === m)?.action === 'squash')) continue;
      let msg = squashMessages[target];
      if (msg === undefined) {
        const r = await prompt({
          title: `Squash message for ${shortSha(target)} + ${members.length} commit${members.length === 1 ? '' : 's'}`,
          label: 'Combined commit message',
          initial: defaultSquashMessage(rows, target, members),
          multiline: true,
          okLabel: 'Use message',
          validate: (v) => (v.trim() ? null : 'The message cannot be empty.'),
        });
        if (!r) return;
        msg = r.value;
      }
      messages[target] = msg;
    }
    const todo: TodoItem[] = rows.map((r) => ({
      sha: r.sha,
      action: r.action,
      summary: r.summary,
      ...(r.action === 'reword' ? { newMessage: r.newMessage ?? r.summary } : {}),
    }));
    setBusy(true);
    try {
      const res = await runOp(
        repoId,
        { type: 'rebase.interactive', onto, upstream, todo, squashMessages: messages },
        { successToast: 'Interactive rebase complete' },
      );
      if (res) backToGraph(repoId);
    } catch (e) {
      // Conflicts (or an `edit` stop) hand over to the operation banner and conflict list.
      if (isConflict(e)) backToGraph(repoId);
    } finally {
      setBusy(false);
    }
  };

  const reset = (): void => {
    setRows(initial);
    setSquashMessages({});
    setEditing(null);
    setSquashEditing(null);
  };

  return (
    <div className={styles.view}>
      <div className={styles.header}>
        <h2 className={styles.title} title={label}>
          Interactive rebase: {label} ({rows.length} commit{rows.length === 1 ? '' : 's'})
        </h2>
        <label className={styles.check}>
          <input type="checkbox" checked={oldestFirst} onChange={(e) => setOldestFirst(e.target.checked)} />{' '}
          Oldest first
        </label>
        <button type="button" disabled={!changed || busy} onClick={reset}>
          Reset
        </button>
        <button type="button" disabled={busy} onClick={() => backToGraph(repoId)}>
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          disabled={!!error || busy || ai.running}
          title={error ?? (ai.running ? 'Wait for the AI message (or stop it) first' : undefined)}
          onClick={() => void start()}
        >
          {busy ? 'Rebasing…' : 'Start rebase'}
        </button>
      </div>
      <p className={styles.help}>
        Drag rows or use Alt+↑/↓ to reorder. Keys: <kbd>P</kbd> pick · <kbd>R</kbd> reword · <kbd>E</kbd> edit
        · <kbd>S</kbd> squash · <kbd>F</kbd> fixup · <kbd>D</kbd> drop. Squash and fixup fold a commit into
        the older commit {oldestFirst ? 'above' : 'below'} it.
      </p>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      <div className={styles.list} role="listbox" aria-label="Rebase todo">
        {display.map((r) => {
          const target = memberOf.get(r.sha);
          const members = groups.get(r.sha) ?? [];
          const hasSquash = members.some((m) => rows.find((x) => x.sha === m)?.action === 'squash');
          const cls = [
            styles.row,
            r.sha === focus ? styles.focused : '',
            r.action === 'drop' ? styles.dropped : '',
            target ? styles.folded : '',
            members.length ? styles.target : '',
            drag === r.sha ? styles.dragging : '',
            drop?.sha === r.sha ? (drop.before ? styles.dropBefore : styles.dropAfter) : '',
          ].join(' ');
          return (
            <div key={r.sha} className={styles.item}>
              <div
                ref={(el) => {
                  if (el) rowEls.current.set(r.sha, el);
                  else rowEls.current.delete(r.sha);
                }}
                role="option"
                aria-selected={r.sha === focus}
                tabIndex={r.sha === focus ? 0 : -1}
                className={cls}
                draggable={editing !== r.sha}
                onFocus={() => setFocus(r.sha)}
                onKeyDown={(e) => onRowKey(e, r)}
                onDragStart={(e) => {
                  e.dataTransfer.setData('text/plain', r.sha);
                  e.dataTransfer.effectAllowed = 'move';
                  setDrag(r.sha);
                }}
                onDragOver={(e) => onDragOver(e, r.sha)}
                onDrop={(e) => {
                  e.preventDefault();
                  if (drag && drop) moveTo(drag, drop.sha, drop.before);
                  endDrag();
                }}
                onDragEnd={endDrag}
              >
                <span className={styles.grip} aria-hidden>
                  <GripVertical size={14} />
                </span>
                <select
                  className={`${styles.action} ${styles[`a_${r.action}`]}`}
                  value={r.action}
                  aria-label={`Action for ${shortSha(r.sha)}`}
                  onChange={(e) => setAction(r.sha, e.target.value as TodoAction)}
                >
                  {ACTIONS.map((a) => (
                    <option
                      key={a.action}
                      value={a.action}
                      title={a.hint}
                      disabled={folds(a.action) && r.sha === oldest}
                    >
                      {a.label}
                    </option>
                  ))}
                </select>
                <code className={styles.sha}>{shortSha(r.sha)}</code>
                <span className={styles.summary} title={r.newMessage ?? r.summary}>
                  {r.action === 'reword' && r.newMessage ? r.newMessage.split('\n')[0] : r.summary}
                </span>
                {target && (
                  <span className={styles.into} title={`Folded into ${shortSha(target)}`}>
                    → {shortSha(target)}
                  </span>
                )}
                {hasSquash && (
                  <button
                    type="button"
                    className={styles.small}
                    onClick={() => setSquashEditing(squashEditing === r.sha ? null : r.sha)}
                  >
                    Squash message{squashMessages[r.sha] !== undefined ? ' •' : ''}
                  </button>
                )}
                {aiEnabled && (r.action === 'pick' || r.action === 'reword') && (
                  <SparkleButton
                    label={`Reword ${shortSha(r.sha)} with AI`}
                    title="Reword with AI: write a new message from this commit's changes"
                    disabled={busy || (ai.running && aiSha !== r.sha)}
                    running={ai.running && aiSha === r.sha}
                    onRun={() => void rewordWithAi(r)}
                    onCancel={ai.cancel}
                  />
                )}
                <button
                  type="button"
                  className={styles.icon}
                  title="Reword (R)"
                  aria-label={`Reword ${shortSha(r.sha)}`}
                  onClick={() => {
                    if (r.action !== 'reword') setAction(r.sha, 'reword');
                    else setEditing(editing === r.sha ? null : r.sha);
                  }}
                >
                  <Pencil size={13} />
                </button>
              </div>
              {aiSha === r.sha && ai.state.status === 'error' && ai.state.error && (
                <p className={styles.error} role="alert">
                  {describeAiError(ai.state.error)}{' '}
                  {needsSettings(ai.state.error) && (
                    <button type="button" className={styles.small} onClick={openAiPreferences}>
                      Open AI settings
                    </button>
                  )}
                </p>
              )}
              {editing === r.sha && (
                <MessageEditor
                  key={`${r.sha}:${editorVersion}`}
                  title={`Reword ${shortSha(r.sha)}`}
                  initial={r.newMessage ?? r.summary}
                  onCancel={() => {
                    setEditing(null);
                    focusRow(r.sha);
                  }}
                  onSave={(msg) => {
                    setRows((rs) =>
                      rs.map((x) => (x.sha === r.sha ? { ...x, action: 'reword', newMessage: msg } : x)),
                    );
                    setEditing(null);
                    focusRow(r.sha);
                  }}
                />
              )}
              {squashEditing === r.sha && hasSquash && (
                <MessageEditor
                  title={`Combined message for ${shortSha(r.sha)} + ${members.length}`}
                  initial={squashMessages[r.sha] ?? defaultSquashMessage(rows, r.sha, members)}
                  onCancel={() => setSquashEditing(null)}
                  onSave={(msg) => {
                    setSquashMessages((m) => ({ ...m, [r.sha]: msg }));
                    setSquashEditing(null);
                  }}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MessageEditor(props: {
  title: string;
  initial: string;
  onSave(message: string): void;
  onCancel(): void;
}) {
  const [summary, ...rest] = props.initial.split('\n');
  const [subject, setSubject] = useState(summary ?? '');
  const [body, setBody] = useState(rest.join('\n').replace(/^\n+/, ''));
  const valid = subject.trim().length > 0;
  const save = (): void => {
    if (valid) props.onSave(body.trim() ? `${subject.trim()}\n\n${body.trimEnd()}` : subject.trim());
  };
  return (
    <div
      className={styles.editor}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          props.onCancel();
        } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          save();
        }
      }}
    >
      <div className={styles.editorTitle}>
        {props.title}
        <span className={subject.length > 72 ? styles.over : styles.count}>{subject.length}/72</span>
        <button type="button" className={styles.icon} aria-label="Cancel" onClick={props.onCancel}>
          <X size={13} />
        </button>
      </div>
      <input
        type="text"
        autoFocus
        aria-label="Summary"
        placeholder="Summary"
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
      />
      <textarea
        aria-label="Description"
        placeholder="Description"
        rows={4}
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <div className={styles.editorButtons}>
        <button type="button" onClick={props.onCancel}>
          Cancel
        </button>
        <button type="button" className="primary" disabled={!valid} onClick={save}>
          Save message
        </button>
      </div>
    </div>
  );
}
