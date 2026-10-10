import { useEffect, useRef, type ReactNode } from 'react';

import styles from './forms.module.css';

/**
 * Modal form shell for the left-panel dialogs (native `<dialog>`: focus trap + Esc). Submit runs
 * `onSubmit`; the footer shows `error`, Cancel and the primary button.
 */
export function FormDialog(props: {
  title: string;
  okLabel: string;
  onCancel(): void;
  onSubmit(): void;
  busy?: boolean;
  okDisabled?: boolean;
  danger?: boolean;
  error?: string | null;
  wide?: boolean;
  /** Extra footer content on the left (e.g. a checkbox). */
  footer?: ReactNode;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => {
      if (d?.open) d.close();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`${styles.dialog} ${props.wide ? styles.wide : ''}`}
      aria-label={props.title}
      onCancel={(e) => {
        e.preventDefault();
        props.onCancel();
      }}
    >
      <h2 className={styles.title}>{props.title}</h2>
      <form
        className={styles.body}
        onSubmit={(e) => {
          e.preventDefault();
          if (!props.busy && !props.okDisabled) props.onSubmit();
        }}
      >
        {props.children}
        {props.error && (
          <p className={styles.error} role="alert">
            {props.error}
          </p>
        )}
        <div className={styles.buttons}>
          <div className={styles.footerLeft}>{props.footer}</div>
          <button type="button" onClick={props.onCancel}>
            Cancel
          </button>
          <button
            type="submit"
            className={props.danger ? styles.danger : 'primary'}
            disabled={props.busy || props.okDisabled}
          >
            {props.okLabel}
          </button>
        </div>
      </form>
    </dialog>
  );
}

/** Labelled form row. */
export function Field(props: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <label className={styles.field}>
      <span className={styles.label}>{props.label}</span>
      {props.children}
      {props.error ? (
        <span className={styles.fieldError}>{props.error}</span>
      ) : (
        props.hint && <span className={styles.hint}>{props.hint}</span>
      )}
    </label>
  );
}

export { styles as formStyles };
