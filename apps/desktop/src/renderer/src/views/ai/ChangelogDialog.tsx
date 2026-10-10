import type { RepoId } from '@githappens/git/types';
import { Sparkles } from 'lucide-react';
import { createElement, useEffect, useRef, useState } from 'react';

import { aiInvoke, describeAiError } from '../../ai/api';
import { useAiRun } from '../../ai/hooks';
import { mountDialog } from '../../ai/mount';
import { invoke } from '../../lib/api';
import { useToastStore } from '../../stores/toasts';
import s from './Ai.module.css';

type Format = 'keepachangelog' | 'grouped' | 'plain';

/** Open the changelog dialog for `from..to` (two tags, or a selected range). */
export function openChangelog(repoId: RepoId, range: { from: string; to: string }): Promise<void> {
  return mountDialog<void>((done) =>
    createElement(ChangelogDialog, { repoId, ...range, onClose: () => done() }),
  );
}

/**
 * Changelog *(ours, spec 12 §4.4)*: tag/range → editable markdown, Copy, or prepend to CHANGELOG.md at
 * the repository root (a normal file change that shows up in WIP).
 */
export function ChangelogDialog({
  repoId,
  from,
  to,
  onClose,
}: {
  repoId: RepoId;
  from: string;
  to: string;
  onClose(): void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const run = useAiRun('changelog');
  const [format, setFormat] = useState<Format>('grouped');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);

  const generate = async (f = format): Promise<void> => {
    setText('');
    const r = await run.start({ repoId, from, to, format: f });
    if (r) setText(r.markdown);
  };

  useEffect(() => {
    const t = setTimeout(() => void generate(), 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const shown = run.running ? run.state.text : text;

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      const r = await aiInvoke('ai:changelog:save', { repoId, markdown: text });
      useToastStore.getState().push({ kind: 'success', title: 'Changelog updated', body: r.path });
      onClose();
    } catch (e) {
      useToastStore.getState().push({
        kind: 'error',
        title: 'Could not save CHANGELOG.md',
        body: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={ref}
      className={s.dialogWide}
      aria-label="Generate changelog"
      onCancel={(e) => {
        e.preventDefault();
        run.cancel();
        onClose();
      }}
    >
      <h2 className={s.dialogTitle}>
        <Sparkles size={16} /> Changelog {from}..{to}
      </h2>
      <div className={s.dialogBody}>
        <div className={s.row}>
          <label className={s.field}>
            Format
            <select
              value={format}
              onChange={(e) => {
                const f = e.target.value as Format;
                setFormat(f);
                void generate(f);
              }}
            >
              <option value="grouped">Grouped</option>
              <option value="keepachangelog">Keep a Changelog</option>
              <option value="plain">Plain list</option>
            </select>
          </label>
          <button type="button" onClick={() => (run.running ? run.cancel() : void generate())}>
            {run.running ? 'Stop' : 'Regenerate'}
          </button>
        </div>
        {run.state.error && (
          <p className={s.error} role="alert">
            {describeAiError(run.state.error)}
          </p>
        )}
        <textarea
          className={s.textarea}
          aria-label="Changelog markdown"
          rows={18}
          value={shown}
          readOnly={run.running}
          onChange={(e) => setText(e.target.value)}
          placeholder={run.running ? 'Writing…' : ''}
        />
        <div className={s.buttons}>
          <button
            type="button"
            onClick={() => {
              run.cancel();
              onClose();
            }}
          >
            Close
          </button>
          <button
            type="button"
            disabled={!text.trim() || run.running}
            onClick={() => void invoke('shell:copyText', { text })}
          >
            Copy
          </button>
          <button
            type="button"
            className="primary"
            disabled={!text.trim() || run.running || busy}
            onClick={() => void save()}
          >
            Prepend to CHANGELOG.md
          </button>
        </div>
      </div>
    </dialog>
  );
}
