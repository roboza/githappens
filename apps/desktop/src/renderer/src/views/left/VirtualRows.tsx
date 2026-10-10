import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import { windowRange } from './left-panel-model';
import styles from './LeftPanel.module.css';

export const ROW_HEIGHT = 26;

/**
 * Fixed-row-height list for left-panel sections. With `height` undefined every row renders in the normal
 * flow; with a number (px) or `'fill'` (maximized section) the list scrolls itself and only the rows in
 * view (+ overscan) are mounted.
 */
export function VirtualRows<T>(props: {
  items: readonly T[];
  height?: number | 'fill';
  keyOf(item: T): string;
  render(item: T, index: number): ReactNode;
  label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(typeof props.height === 'number' ? props.height : 400);
  const scrolls = props.height !== undefined;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !scrolls) return;
    setViewport(el.clientHeight || viewport);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setViewport(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrolls]);

  if (!scrolls) {
    return (
      <div role="tree" aria-label={props.label}>
        {props.items.map((it, i) => (
          <Keyed key={props.keyOf(it)}>{props.render(it, i)}</Keyed>
        ))}
      </div>
    );
  }
  const w = windowRange({ count: props.items.length, rowHeight: ROW_HEIGHT, scrollTop, viewport });
  return (
    <div
      ref={ref}
      role="tree"
      aria-label={props.label}
      className={props.height === 'fill' ? styles.scrollFill : styles.scrollBox}
      style={typeof props.height === 'number' ? { height: props.height } : undefined}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
    >
      <div style={{ height: w.padTop }} aria-hidden />
      {props.items.slice(w.start, w.end).map((it, i) => (
        <Keyed key={props.keyOf(it)}>{props.render(it, w.start + i)}</Keyed>
      ))}
      <div style={{ height: w.padBottom }} aria-hidden />
    </div>
  );
}

function Keyed({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
