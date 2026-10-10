import type { RepoId } from '@githappens/git/types';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import type { CommitMessageResult } from '../../../../shared/ipc/ai-contract';
import { openExplain } from '../../ai/actions';
import { describeAiError, needsSettings, openAiPreferences } from '../../ai/api';
import { useAiEnabled, useAiRun } from '../../ai/hooks';
import { useRepoUiStore } from '../../stores/repo-ui';
import { SparkleButton } from './SparkleButton';
import s from './Ai.module.css';

type Field = 'summary' | 'description';
type Msg = Record<Field, string>;

/**
 * AI commit message for the composer (spec 12 §4.4): streamed fill of summary + description, the user
 * wins (typing in a field while streaming stops writes to it), Ctrl+Z in a field restores the previous
 * text, and a ▾ menu with Regenerate / Shorter / Conventional / Explain staged changes.
 */
export function useCommitMessageAi(o: {
  repoId: RepoId;
  stagedCount: number;
  amend: boolean;
  draft: Msg;
  setDraft(patch: Partial<Msg>): void;
}): {
  button: ReactNode;
  status: ReactNode;
  /** Call from the fields' onChange (user edits win over streaming). */
  noteEdit(field: Field): void;
  /** Call from the fields' onKeyDown (Ctrl+Z restores the text from before generation). */
  onKeyDown(field: Field, e: KeyboardEvent): void;
} {
  const enabled = useAiEnabled();
  const run = useAiRun('commitMessage');
  /** Latest draft for async callbacks (the composer draft lives in the repo UI store). */
  const current = (): Msg => {
    const d = useRepoUiStore.getState().get(o.repoId).draft;
    return { summary: d.summary, description: d.description };
  };
  const session = useRef<{ prev: Msg; written: Msg; userEdited: Record<Field, boolean> } | null>(null);
  const [undoable, setUndoable] = useState(false);

  const apply = (m: Partial<Msg>): void => {
    const ses = session.current;
    if (!ses) return;
    const patch: Partial<Msg> = {};
    for (const f of ['summary', 'description'] as const) {
      const v = m[f];
      if (v === undefined || ses.userEdited[f]) continue;
      ses.written[f] = v;
      patch[f] = v;
    }
    if (Object.keys(patch).length) o.setDraft(patch);
  };

  const generate = async (hint?: 'shorter' | 'conventional'): Promise<void> => {
    const prev = { ...current() };
    session.current = { prev, written: { ...prev }, userEdited: { summary: false, description: false } };
    setUndoable(false);
    const result = await run.start(
      {
        repoId: o.repoId,
        amend: o.amend || undefined,
        hint,
        current: hint === 'shorter' ? join(prev) : undefined,
      },
      {
        onPartial: (p) => apply(p as Partial<CommitMessageResult>),
        onReset: () => apply(prev),
      },
    );
    if (result) {
      apply(result);
      setUndoable(true);
    } else if (session.current) {
      // failed / cancelled: put back whatever the stream overwrote
      const ses = session.current;
      const back: Partial<Msg> = {};
      for (const f of ['summary', 'description'] as const) {
        if (!ses.userEdited[f] && current()[f] === ses.written[f]) back[f] = ses.prev[f];
      }
      if (Object.keys(back).length) o.setDraft(back);
      session.current = null;
    }
  };

  const undo = (): boolean => {
    const ses = session.current;
    if (!ses || run.running) return false;
    o.setDraft(ses.prev);
    session.current = null;
    setUndoable(false);
    return true;
  };

  const nothingStaged = o.stagedCount === 0 && !o.amend;

  // Ctrl/Cmd+Alt+M (`ai.commitMessage` command, spec 12 §4.11) asks the mounted composer to generate.
  const shortcut = useRef<() => void>(() => undefined);
  useEffect(() => {
    shortcut.current = () => {
      if (enabled && !nothingStaged && !run.running) void generate();
    };
  });
  useEffect(() => {
    const onRequest = (e: Event): void => {
      if ((e as CustomEvent<{ repoId?: string }>).detail?.repoId === o.repoId) shortcut.current();
    };
    window.addEventListener('kl:ai-commit-message', onRequest);
    return () => window.removeEventListener('kl:ai-commit-message', onRequest);
  }, [o.repoId]);
  const button = enabled ? (
    <SparkleButton
      label="Generate commit message with AI"
      title={nothingStaged ? 'Stage changes first' : 'Generate commit message with AI'}
      disabled={nothingStaged}
      running={run.running}
      onRun={() => void generate()}
      onCancel={run.cancel}
      menu={[
        { label: 'Regenerate', disabled: nothingStaged, onSelect: () => void generate() },
        { label: 'Shorter', disabled: nothingStaged, onSelect: () => void generate('shorter') },
        {
          label: 'Conventional commit',
          disabled: nothingStaged,
          onSelect: () => void generate('conventional'),
        },
        {
          label: 'Explain staged changes instead',
          onSelect: () => openExplain(o.repoId, { kind: 'wip' }),
        },
        'separator',
        { label: 'Undo AI message', disabled: !undoable, onSelect: () => void undo() },
      ]}
    />
  ) : null;

  const err = run.state.error;
  const status = !enabled ? null : err ? (
    <p className={s.error} role="alert">
      {describeAiError(err)}{' '}
      {needsSettings(err) && (
        <button type="button" className={s.linkBtn} onClick={openAiPreferences}>
          Open AI settings
        </button>
      )}
    </p>
  ) : run.state.status === 'done' && run.state.truncated ? (
    <p className={s.note}>Message based on a partial diff (some changes were too large to send).</p>
  ) : null;

  return {
    button,
    status,
    noteEdit: (field) => {
      if (session.current && run.running) session.current.userEdited[field] = true;
    },
    onKeyDown: (field, e) => {
      const ses = session.current;
      if (!ses || !undoable) return;
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
        if (current()[field] === ses.written[field] && undo()) e.preventDefault();
      }
    },
  };
}

const join = (m: Msg): string => (m.description.trim() ? `${m.summary}\n\n${m.description}` : m.summary);
