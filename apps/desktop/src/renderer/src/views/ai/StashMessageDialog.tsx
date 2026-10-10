import type { RepoId } from '@githappens/git/types';
import { createElement, useEffect, useRef, useState } from 'react';

import { describeAiError } from '../../ai/api';
import { useAiRun } from '../../ai/hooks';
import { mountDialog } from '../../ai/mount';
import { SparkleButton } from './SparkleButton';
import s from './Ai.module.css';

/** "Stash with message…" with an AI sparkle (spec 12 §4.4). Resolves with the message, or null on cancel. */
export function promptStashMessage(repoId: RepoId): Promise<string | null> {
  return mountDialog<string | null>((done) => createElement(StashMessageDialog, { repoId, onDone: done }));
}

function StashMessageDialog({ repoId, onDone }: { repoId: RepoId; onDone(v: string | null): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const run = useAiRun('stashMessage');
  const [value, setValue] = useState('');
  const edited = useRef(false);

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);

  const generate = async (): Promise<void> => {
    edited.current = false;
    const prev = value;
    const r = await run.start(
      { repoId },
      {
        onPartial: (p) => {
          const summary = (p as { summary?: string }).summary;
          if (summary !== undefined && !edited.current) setValue(summary);
        },
      },
    );
    if (r && !edited.current) setValue(r.summary);
    else if (!r && !edited.current) setValue(prev);
  };

  const cancel = (): void => {
    run.cancel();
    onDone(null);
  };

  return (
    <dialog
      ref={ref}
      className={s.dialog}
      aria-label="Stash changes"
      onCancel={(e) => {
        e.preventDefault();
        cancel();
      }}
    >
      <h2 className={s.dialogTitle}>Stash changes</h2>
      <form
        className={s.dialogBody}
        onSubmit={(e) => {
          e.preventDefault();
          run.cancel();
          onDone(value);
        }}
      >
        <label className={s.field}>
          Message (optional)
          <span className={s.keyRow}>
            <input
              autoFocus
              className={s.input}
              aria-label="Stash message"
              value={value}
              onChange={(e) => {
                edited.current = true;
                setValue(e.target.value);
              }}
            />
            <SparkleButton
              label="Generate stash message with AI"
              running={run.running}
              onRun={() => void generate()}
              onCancel={run.cancel}
            />
          </span>
        </label>
        {run.state.error && (
          <p className={s.error} role="alert">
            {describeAiError(run.state.error)}
          </p>
        )}
        <div className={s.buttons}>
          <button type="button" onClick={cancel}>
            Cancel
          </button>
          <button type="submit" className="primary">
            Stash
          </button>
        </div>
      </form>
    </dialog>
  );
}
