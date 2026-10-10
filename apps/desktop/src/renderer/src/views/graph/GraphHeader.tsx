import { Settings2 } from 'lucide-react';
import { useRef, useState } from 'react';

import type { GraphColumnId } from '../../../../shared/ipc/graph-contract';
import { COLUMN_SPECS } from './graph-columns';
import styles from './GraphView.module.css';

export interface HeaderColumn {
  id: GraphColumnId;
  width: number;
  left: number;
}

/**
 * Column headers (spec 04 §4.2): drag a header to reorder (drop indicator between headers), drag the
 * 4px handle on its right edge to resize, double-click the handle to autosize, right-click (or the gear)
 * for visibility / "Reset columns" / compact / avatars.
 */
export function GraphHeader({
  columns,
  onMove,
  onResize,
  onAutosize,
  onMenu,
}: {
  columns: HeaderColumn[];
  onMove(id: GraphColumnId, before: GraphColumnId | null): void;
  /** Live resize (`commit` false while dragging, true on release). */
  onResize(id: GraphColumnId, width: number, commit: boolean): void;
  onAutosize(id: GraphColumnId): void;
  onMenu(x: number, y: number): void;
}) {
  const [drag, setDrag] = useState<{ id: GraphColumnId; x: number; before: GraphColumnId | null } | null>(
    null,
  );
  const start = useRef<{ id: GraphColumnId; x: number; moved: boolean } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const dropBefore = (clientX: number): GraphColumnId | null => {
    const rect = rootRef.current?.getBoundingClientRect();
    const x = clientX - (rect?.left ?? 0);
    for (const c of columns) if (x < c.left + c.width / 2) return c.id;
    return null;
  };

  const indicatorLeft = (() => {
    if (!drag) return null;
    const c = drag.before ? columns.find((x) => x.id === drag.before) : null;
    if (c) return c.left;
    const last = columns[columns.length - 1];
    return last ? last.left + last.width : 0;
  })();

  return (
    <div
      ref={rootRef}
      className={styles.header}
      role="row"
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
    >
      {columns.map((c) => (
        <div
          key={c.id}
          role="columnheader"
          className={`${styles.headerCell} ${drag?.id === c.id ? styles.headerDragging : ''}`}
          style={{ width: c.width }}
          title="Drag to reorder · right-click for columns"
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            start.current = { id: c.id, x: e.clientX, moved: false };
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            const s = start.current;
            if (!s) return;
            if (!s.moved && Math.abs(e.clientX - s.x) < 4) return;
            s.moved = true;
            setDrag({ id: s.id, x: e.clientX, before: dropBefore(e.clientX) });
          }}
          onPointerUp={(e) => {
            const s = start.current;
            start.current = null;
            if (s?.moved) {
              const before = dropBefore(e.clientX);
              if (before !== s.id) onMove(s.id, before);
            }
            setDrag(null);
          }}
          onPointerCancel={() => {
            start.current = null;
            setDrag(null);
          }}
        >
          <span className={styles.headerTitle}>{COLUMN_SPECS[c.id].title}</span>
          {c.id !== 'message' && <ResizeHandle column={c} onResize={onResize} onAutosize={onAutosize} />}
        </div>
      ))}
      <button
        type="button"
        className={styles.headerGear}
        title="Graph columns and display"
        aria-label="Graph settings"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          onMenu(r.left, r.bottom);
        }}
      >
        <Settings2 size={12} />
      </button>
      {indicatorLeft !== null && <div className={styles.dropIndicator} style={{ left: indicatorLeft }} />}
    </div>
  );
}

function ResizeHandle({
  column,
  onResize,
  onAutosize,
}: {
  column: HeaderColumn;
  onResize(id: GraphColumnId, width: number, commit: boolean): void;
  onAutosize(id: GraphColumnId): void;
}) {
  const s = useRef<{ x: number; w: number } | null>(null);
  return (
    <div
      className={styles.resizeHandle}
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${COLUMN_SPECS[column.id].title}`}
      title="Drag to resize · double-click to autosize"
      onPointerDown={(e) => {
        e.stopPropagation();
        if (e.button !== 0) return;
        s.current = { x: e.clientX, w: column.width };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (s.current) onResize(column.id, s.current.w + e.clientX - s.current.x, false);
      }}
      onPointerUp={(e) => {
        if (s.current) onResize(column.id, s.current.w + e.clientX - s.current.x, true);
        s.current = null;
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onAutosize(column.id);
      }}
    />
  );
}
