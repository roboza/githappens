import { ChevronDown, LoaderCircle, Sparkles } from 'lucide-react';

import { useContextMenu, type MenuEntry } from '../../components/ContextMenu';
import s from './Ai.module.css';

/**
 * The AI "sparkle" button (spec 12 §4.4): spinner while running (click again to stop) and an optional
 * ▾ menu of variants. Callers hide it entirely when AI is disabled.
 */
export function SparkleButton({
  label,
  title,
  disabled,
  running,
  onRun,
  onCancel,
  menu,
  text,
}: {
  label: string;
  title?: string;
  disabled?: boolean;
  running?: boolean;
  onRun(): void;
  onCancel?(): void;
  menu?: MenuEntry[];
  /** Visible text next to the icon (icon-only when omitted). */
  text?: string;
}) {
  const show = useContextMenu((st) => st.show);
  const button = (
    <button
      type="button"
      className={s.sparkle}
      aria-label={running ? `Stop: ${label}` : label}
      title={running ? 'Stop generating' : (title ?? label)}
      disabled={disabled && !running}
      aria-busy={running}
      onClick={() => (running ? onCancel?.() : onRun())}
    >
      {running ? <LoaderCircle size={14} className={s.spin} /> : <Sparkles size={14} />}
      {text && <span>{text}</span>}
    </button>
  );
  if (!menu?.length) return button;
  return (
    <span className={s.split}>
      {button}
      <button
        type="button"
        className={s.sparkle}
        aria-label={`More ${label} options`}
        title="More options"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          show(r.left, r.bottom + 2, menu);
        }}
      >
        <ChevronDown size={12} />
      </button>
    </span>
  );
}
