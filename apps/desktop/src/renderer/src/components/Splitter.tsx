import { useRef } from 'react';

import styles from './Splitter.module.css';

interface Props {
  /** Current size of the panel the splitter resizes. */
  size: number;
  min: number;
  max: number;
  /** +1 when dragging right grows the panel (left panel), -1 when it shrinks it (right panel). */
  direction: 1 | -1;
  onResize(size: number): void;
  label: string;
}

/** Vertical drag handle between panels (spec 01 §4.6 resize). Keyboard: ←/→ by 16 px. */
export function Splitter({ size, min, max, direction, onResize, label }: Props) {
  const start = useRef<{ x: number; size: number } | null>(null);
  const clamp = (v: number): number => Math.max(min, Math.min(max, v));

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(size)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      className={styles.splitter}
      onPointerDown={(e) => {
        start.current = { x: e.clientX, size };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!start.current) return;
        onResize(clamp(start.current.size + direction * (e.clientX - start.current.x)));
      }}
      onPointerUp={() => (start.current = null)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') onResize(clamp(size - 16 * direction));
        if (e.key === 'ArrowRight') onResize(clamp(size + 16 * direction));
      }}
    />
  );
}
