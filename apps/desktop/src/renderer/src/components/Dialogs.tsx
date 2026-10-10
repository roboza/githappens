import { useEffect, useRef, useState, type ReactNode } from 'react';
import { create } from 'zustand';

import styles from './Dialogs.module.css';

/** Promise-based dialogs (prompt / confirm / choice) so actions can `await` user input. */

export interface PromptOptions {
  title: string;
  label?: string;
  placeholder?: string;
  initial?: string;
  okLabel?: string;
  /** Returns an error message, or null when valid. May be async (e.g. `git check-ref-format`). */
  validate?: (value: string) => string | null | Promise<string | null>;
  /** Extra checkbox rendered under the input. */
  checkbox?: { label: string; initial: boolean };
  multiline?: boolean;
  password?: boolean;
}
export interface PromptResult {
  value: string;
  checked: boolean;
}

export interface ChoiceOptions<T extends string> {
  title: string;
  message: ReactNode;
  choices: { value: T; label: string; primary?: boolean; danger?: boolean }[];
  checkbox?: { label: string; initial: boolean };
}

type Request = { id?: number } & (
  | { kind: 'prompt'; options: PromptOptions; resolve: (r: PromptResult | null) => void }
  | {
      kind: 'choice';
      options: ChoiceOptions<string>;
      resolve: (r: { value: string; checked: boolean } | null) => void;
    }
);

let seq = 0;

interface DialogStore {
  queue: Request[];
  push(r: Request): void;
  shift(): void;
}

const useDialogStore = create<DialogStore>((set) => ({
  queue: [],
  push: (r) => set((s) => ({ queue: [...s.queue, { ...r, id: ++seq }] })),
  shift: () => set((s) => ({ queue: s.queue.slice(1) })),
}));

export function prompt(options: PromptOptions): Promise<PromptResult | null> {
  return new Promise((resolve) => useDialogStore.getState().push({ kind: 'prompt', options, resolve }));
}

export function choose<T extends string>(
  options: ChoiceOptions<T>,
): Promise<{ value: T; checked: boolean } | null> {
  return new Promise((resolve) =>
    useDialogStore.getState().push({
      kind: 'choice',
      options: options as ChoiceOptions<string>,
      resolve: resolve as (r: { value: string; checked: boolean } | null) => void,
    }),
  );
}

export async function confirm(
  title: string,
  message: ReactNode,
  okLabel = 'OK',
  danger = false,
): Promise<boolean> {
  const r = await choose({
    title,
    message,
    choices: [
      { value: 'cancel', label: 'Cancel' },
      { value: 'ok', label: okLabel, primary: !danger, danger },
    ],
  });
  return r?.value === 'ok';
}

/** Mounted once in App. Shows queued dialogs one at a time. */
export function DialogHost() {
  const current = useDialogStore((s) => s.queue[0]);
  const shift = useDialogStore((s) => s.shift);
  if (!current) return null;
  const done = (fn: () => void): void => {
    fn();
    shift();
  };
  return current.kind === 'prompt' ? (
    <PromptDialog key={current.id} req={current} onDone={done} />
  ) : (
    <ChoiceDialog key={current.id} req={current} onDone={done} />
  );
}

function Shell({ title, onCancel, children }: { title: string; onCancel(): void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
    >
      <h2 className={styles.title}>{title}</h2>
      {children}
    </dialog>
  );
}

function PromptDialog({
  req,
  onDone,
}: {
  req: Extract<Request, { kind: 'prompt' }>;
  onDone(fn: () => void): void;
}) {
  const o = req.options;
  const [value, setValue] = useState(o.initial ?? '');
  const [checked, setChecked] = useState(o.checkbox?.initial ?? false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cancel = (): void => onDone(() => req.resolve(null));

  const submit = async (): Promise<void> => {
    setBusy(true);
    const err = o.validate ? await o.validate(value) : null;
    setBusy(false);
    if (err) {
      setError(err);
      return;
    }
    onDone(() => req.resolve({ value, checked }));
  };

  const inputProps = {
    autoFocus: true,
    'aria-label': o.label ?? o.title,
    placeholder: o.placeholder,
    value,
    onChange: (e: { target: { value: string } }) => {
      setValue(e.target.value);
      setError(null);
    },
  };

  return (
    <Shell title={o.title} onCancel={cancel}>
      <form
        className={styles.body}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {o.label && <label className={styles.label}>{o.label}</label>}
        {o.multiline ? (
          <textarea {...inputProps} rows={4} className={styles.input} />
        ) : (
          <input {...inputProps} type={o.password ? 'password' : 'text'} className={styles.input} />
        )}
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        {o.checkbox && (
          <label className={styles.check}>
            <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />{' '}
            {o.checkbox.label}
          </label>
        )}
        <div className={styles.buttons}>
          <button type="button" onClick={cancel}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {o.okLabel ?? 'OK'}
          </button>
        </div>
      </form>
    </Shell>
  );
}

function ChoiceDialog({
  req,
  onDone,
}: {
  req: Extract<Request, { kind: 'choice' }>;
  onDone(fn: () => void): void;
}) {
  const o = req.options;
  const [checked, setChecked] = useState(o.checkbox?.initial ?? false);
  return (
    <Shell title={o.title} onCancel={() => onDone(() => req.resolve(null))}>
      <div className={styles.body}>
        <div className={styles.message}>{o.message}</div>
        {o.checkbox && (
          <label className={styles.check}>
            <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />{' '}
            {o.checkbox.label}
          </label>
        )}
        <div className={styles.buttons}>
          {o.choices.map((c) => (
            <button
              key={c.value}
              type="button"
              autoFocus={c.primary}
              className={c.primary ? 'primary' : c.danger ? styles.danger : undefined}
              onClick={() => onDone(() => req.resolve({ value: c.value, checked }))}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>
    </Shell>
  );
}
