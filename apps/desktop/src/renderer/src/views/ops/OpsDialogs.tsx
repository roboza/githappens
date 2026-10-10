import { createElement, useEffect, useRef, useState, type ReactNode } from 'react';

import { mountDialog } from '../../ai/mount';
import s from './Ops.module.css';

/** Self-mounting dialogs of the branching UI (spec 05 §4.1 `<StashDialog/>`, squash message editor). */

function Shell({ title, onCancel, children }: { title: string; onCancel(): void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className={s.dialog}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
    >
      <h2 className={s.title}>{title}</h2>
      {children}
    </dialog>
  );
}

// ---------------------------------------------------------------------------
// StashDialog (spec 05 §4.9)

export interface StashDialogOptions {
  message?: string;
  includeUntracked: boolean;
  /** Only these paths (`git stash push -- <paths>`), e.g. from "Stash file(s)". */
  paths?: string[];
  /** git >= 2.35 (`--staged`). */
  stagedSupported: boolean;
}

export interface StashDialogResult {
  message: string;
  includeUntracked: boolean;
  keepIndex: boolean;
  stagedOnly: boolean;
  paths: string[];
}

export function openStashDialog(o: StashDialogOptions): Promise<StashDialogResult | null> {
  return mountDialog<StashDialogResult | null>((done) => createElement(StashDialog, { o, onDone: done }));
}

function StashDialog({ o, onDone }: { o: StashDialogOptions; onDone(v: StashDialogResult | null): void }) {
  const [message, setMessage] = useState(o.message ?? '');
  const [includeUntracked, setIncludeUntracked] = useState(o.includeUntracked);
  const [keepIndex, setKeepIndex] = useState(false);
  const [stagedOnly, setStagedOnly] = useState(false);
  const [paths, setPaths] = useState((o.paths ?? []).join('\n'));
  const pathList = paths
    .split(/\r?\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  return (
    <Shell
      title={pathList.length ? `Stash ${pathList.length} file(s)` : 'Stash changes'}
      onCancel={() => onDone(null)}
    >
      <form
        className={s.body}
        onSubmit={(e) => {
          e.preventDefault();
          onDone({ message: message.trim(), includeUntracked, keepIndex, stagedOnly, paths: pathList });
        }}
      >
        <label className={s.label}>
          Message (optional)
          <input
            autoFocus
            className={s.input}
            aria-label="Stash message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
        </label>
        <label className={s.check} aria-disabled={stagedOnly}>
          <input
            type="checkbox"
            checked={includeUntracked && !stagedOnly}
            disabled={stagedOnly}
            onChange={(e) => setIncludeUntracked(e.target.checked)}
          />
          Include untracked files
        </label>
        <label className={s.check} aria-disabled={stagedOnly}>
          <input
            type="checkbox"
            checked={keepIndex && !stagedOnly}
            disabled={stagedOnly}
            onChange={(e) => setKeepIndex(e.target.checked)}
          />
          Keep staged changes in the working tree (--keep-index)
        </label>
        <label
          className={s.check}
          aria-disabled={!o.stagedSupported}
          title={o.stagedSupported ? undefined : 'Needs Git 2.35 or newer'}
        >
          <input
            type="checkbox"
            checked={stagedOnly}
            disabled={!o.stagedSupported}
            onChange={(e) => setStagedOnly(e.target.checked)}
          />
          Stash only staged changes (--staged){o.stagedSupported ? '' : ' — needs Git 2.35+'}
        </label>
        <label className={s.label}>
          Only these paths (one per line; empty = everything)
          <textarea
            className={s.input}
            rows={3}
            aria-label="Paths to stash"
            value={paths}
            onChange={(e) => setPaths(e.target.value)}
          />
        </label>
        <div className={s.buttons}>
          <button type="button" onClick={() => onDone(null)}>
            Cancel
          </button>
          <button type="submit" className="primary">
            Stash
          </button>
        </div>
      </form>
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// Squash message editor (spec 05 §4.2 "Squash N commits", §4.6 RewordModal fields)

const SUMMARY_LIMIT = 72;

export function openSquashDialog(o: { count: number; message: string }): Promise<string | null> {
  return mountDialog<string | null>((done) => createElement(SquashDialog, { o, onDone: done }));
}

function SquashDialog({
  o,
  onDone,
}: {
  o: { count: number; message: string };
  onDone(v: string | null): void;
}) {
  const [text, setText] = useState(o.message);
  const summary = text.split(/\r?\n/)[0] ?? '';
  const empty = !text.trim();
  return (
    <Shell title={`Squash ${o.count} commits`} onCancel={() => onDone(null)}>
      <form
        className={s.body}
        onSubmit={(e) => {
          e.preventDefault();
          if (!empty) onDone(text);
        }}
      >
        <p className={s.note}>
          The commits are combined into one commit that keeps the oldest commit&apos;s author and date. You
          can undo this.
        </p>
        <label className={s.label}>
          Commit message (first line = summary)
          <textarea
            autoFocus
            className={s.textarea}
            aria-label="Squashed commit message"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !empty) {
                e.preventDefault();
                onDone(text);
              }
            }}
          />
        </label>
        <span className={summary.length > SUMMARY_LIMIT ? s.counterOver : s.counter}>
          Summary {summary.length}/{SUMMARY_LIMIT}
        </span>
        {empty && <p className={s.error}>The commit message is empty.</p>}
        <div className={s.buttons}>
          <button type="button" onClick={() => onDone(null)}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={empty}>
            Squash {o.count} commits
          </button>
        </div>
      </form>
    </Shell>
  );
}
