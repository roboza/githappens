import { X } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';

import styles from './Modal.module.css';

/** Accessible modal dialog using the native <dialog> element (focus trap + Esc for free). */
export function Modal({
  title,
  open,
  onClose,
  children,
}: {
  title: string;
  open: boolean;
  onClose(): void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-label={title}
      onClose={onClose}
      onMouseDown={(e) => {
        if (e.target === ref.current) onClose(); // click on backdrop
      }}
    >
      <header className={styles.header}>
        <h2>{title}</h2>
        <button type="button" className={styles.close} aria-label="Close" onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      <div className={styles.body}>{open && children}</div>
    </dialog>
  );
}
