import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { rankItems } from '../commands/fuzzy';
import styles from './FilterDropdown.module.css';

export interface DropdownItem {
  id: string;
  label: string;
  detail?: string;
  /** Section header the item is listed under (when not filtering). */
  group?: string;
  icon?: ReactNode;
  /** Bold / checked marker (current branch, active tab). */
  current?: boolean;
  disabled?: boolean;
}

export interface DropdownAction {
  label: string;
  icon?: ReactNode;
  onSelect(): void;
}

/**
 * Filterable popover list used by the breadcrumb switchers and the tab overflow menu (spec 01 §4.2, §4.4).
 * Fuzzy filter, ↑/↓/Enter/Esc, click outside closes. `allowCreate` adds a "Create “query”" row.
 */
export function FilterDropdown(props: {
  anchor: { left: number; top: number };
  items: DropdownItem[];
  placeholder: string;
  label: string;
  loading?: boolean;
  actions?: DropdownAction[];
  allowCreate?: (query: string) => string | null;
  onCreate?(query: string): void;
  onPick(id: string): void;
  onClose(): void;
}) {
  const { items, onPick, onClose, allowCreate, onCreate } = props;
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(props.anchor);

  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    setPos({
      left: Math.max(4, Math.min(props.anchor.left, window.innerWidth - r.width - 4)),
      top: Math.max(4, Math.min(props.anchor.top, window.innerHeight - r.height - 4)),
    });
  }, [props.anchor]);

  useEffect(() => {
    const down = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener('mousedown', down, true);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('mousedown', down, true);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  type Row =
    | { type: 'item'; item: DropdownItem; positions: number[]; header?: string }
    | { type: 'create'; label: string }
    | { type: 'action'; action: DropdownAction };

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    if (query.trim()) {
      for (const r of rankItems(items, query, {
        getText: (i) => i.label,
        getAltText: (i) => i.detail,
        limit: 300,
      })) {
        out.push({ type: 'item', item: r.item, positions: r.positions });
      }
      const create = allowCreate?.(query.trim());
      if (create) out.push({ type: 'create', label: create });
    } else {
      let group: string | undefined;
      for (const item of items.slice(0, 500)) {
        const header = item.group !== group ? item.group : undefined;
        group = item.group;
        out.push({ type: 'item', item, positions: [], header });
      }
    }
    for (const action of props.actions ?? []) out.push({ type: 'action', action });
    return out;
  }, [items, query, allowCreate, props.actions]);

  const idx = rows.length ? Math.min(Math.max(active, 0), rows.length - 1) : -1;

  useEffect(() => {
    ref.current?.querySelector(`[data-row="${idx}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [idx]);

  const choose = (row: Row | undefined): void => {
    if (!row) return;
    if (row.type === 'item') {
      if (row.item.disabled) return;
      onClose();
      onPick(row.item.id);
    } else if (row.type === 'create') {
      onClose();
      onCreate?.(query.trim());
    } else {
      onClose();
      row.action.onSelect();
    }
  };

  return createPortal(
    <div
      ref={ref}
      className={styles.dropdown}
      style={{ left: pos.left, top: pos.top }}
      role="dialog"
      aria-label={props.label}
      onKeyDown={(e) => {
        let handled = true;
        if (e.key === 'ArrowDown') setActive((a) => (rows.length ? (Math.max(a, 0) + 1) % rows.length : 0));
        else if (e.key === 'ArrowUp')
          setActive((a) => (rows.length ? (Math.max(a, 0) - 1 + rows.length) % rows.length : 0));
        else if (e.key === 'Enter') choose(rows[idx]);
        else if (e.key === 'Escape') onClose();
        else handled = false;
        if (handled) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
    >
      <input
        className={styles.input}
        autoFocus
        placeholder={props.placeholder}
        aria-label={props.placeholder}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
      />
      <ul className={styles.list} role="listbox" aria-label={props.label}>
        {props.loading && rows.length === 0 && <li className={styles.empty}>Loading…</li>}
        {!props.loading && rows.length === 0 && <li className={styles.empty}>No matches</li>}
        {rows.map((row, i) => (
          <RowView
            key={row.type === 'item' ? `i:${row.item.id}` : row.type === 'create' ? 'create' : `a:${i}`}
            row={row}
            index={i}
            active={i === idx}
            onHover={() => setActive(i)}
            onClick={() => choose(row)}
          />
        ))}
      </ul>
    </div>,
    document.body,
  );
}

function RowView({
  row,
  index,
  active,
  onHover,
  onClick,
}: {
  row:
    | { type: 'item'; item: DropdownItem; positions: number[]; header?: string }
    | { type: 'create'; label: string }
    | { type: 'action'; action: DropdownAction };
  index: number;
  active: boolean;
  onHover(): void;
  onClick(): void;
}) {
  const cls = `${styles.row} ${active ? styles.active : ''}`;
  const common = {
    'data-row': index,
    role: 'option' as const,
    'aria-selected': active,
    onMouseMove: onHover,
    onMouseDown: (e: React.MouseEvent) => e.preventDefault(),
    onClick,
  };
  if (row.type === 'create') {
    return (
      <li {...common} className={`${cls} ${styles.action}`}>
        {row.label}
      </li>
    );
  }
  if (row.type === 'action') {
    return (
      <li {...common} className={`${cls} ${styles.action}`}>
        {row.action.icon}
        {row.action.label}
      </li>
    );
  }
  const { item } = row;
  return (
    <>
      {row.header && (
        <li className={styles.header} role="presentation">
          {row.header}
        </li>
      )}
      <li
        {...common}
        aria-disabled={item.disabled || undefined}
        className={`${cls} ${item.current ? styles.current : ''} ${item.disabled ? styles.disabled : ''}`}
        title={item.detail}
      >
        {item.icon}
        <span className={styles.label}>
          <Marked text={item.label} positions={row.positions} />
        </span>
        {item.detail && <span className={styles.detail}>{item.detail}</span>}
      </li>
    </>
  );
}

function Marked({ text, positions }: { text: string; positions: number[] }) {
  if (!positions.length) return <>{text}</>;
  const set = new Set(positions);
  const parts: ReactNode[] = [];
  let i = 0;
  while (i < text.length) {
    const hit = set.has(i);
    let j = i + 1;
    while (j < text.length && set.has(j) === hit) j++;
    const chunk = text.slice(i, j);
    parts.push(
      hit ? (
        <mark key={i} className={styles.mark}>
          {chunk}
        </mark>
      ) : (
        chunk
      ),
    );
    i = j;
  }
  return <>{parts}</>;
}
