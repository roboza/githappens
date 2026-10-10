import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { create } from 'zustand';

import styles from './ContextMenu.module.css';

export interface MenuItem {
  label: string;
  onSelect?: () => void;
  disabled?: boolean;
  /** Tooltip, e.g. why an item is disabled. */
  title?: string;
  shortcut?: string;
  danger?: boolean;
}
export type MenuEntry = MenuItem | 'separator';

interface MenuState {
  open: { x: number; y: number; items: MenuEntry[] } | null;
  show(x: number, y: number, items: MenuEntry[]): void;
  hide(): void;
}

/** Single app-wide context menu (spec 01 `<ContextMenuHost/>`); menus are data so commands can be shared. */
export const useContextMenu = create<MenuState>((set) => ({
  open: null,
  show: (x, y, items) => set({ open: { x, y, items } }),
  hide: () => set({ open: null }),
}));

export function ContextMenuHost() {
  const open = useContextMenu((s) => s.open);
  const hide = useContextMenu((s) => s.hide);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [active, setActive] = useState(-1);

  // Keep the menu inside the window.
  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({
      left: Math.min(open.x, window.innerWidth - r.width - 4),
      top: Math.min(open.y, window.innerHeight - r.height - 4),
    });
    setActive(-1);
    ref.current.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (): void => hide();
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
    };
  }, [open, hide]);

  if (!open) return null;
  const items = open.items;
  const selectable = items
    .map((it, i) => (it !== 'separator' && !it.disabled ? i : -1))
    .filter((i) => i >= 0);

  const run = (it: MenuItem): void => {
    hide();
    it.onSelect?.();
  };

  return (
    <div className={styles.backdrop} onMouseDown={hide} onContextMenu={(e) => (e.preventDefault(), hide())}>
      <div
        ref={ref}
        role="menu"
        tabIndex={-1}
        className={styles.menu}
        style={pos ? { left: pos.left, top: pos.top } : { left: open.x, top: open.y, visibility: 'hidden' }}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') hide();
          else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const cur = selectable.indexOf(active);
            const next = e.key === 'ArrowDown' ? cur + 1 : cur - 1;
            setActive(selectable[(next + selectable.length) % selectable.length] ?? -1);
          } else if (e.key === 'Enter' && active >= 0) {
            const it = items[active];
            if (it && it !== 'separator') run(it);
          }
        }}
      >
        {items.map((it, i) =>
          it === 'separator' ? (
            <div key={i} className={styles.separator} role="separator" />
          ) : (
            <button
              key={i}
              type="button"
              role="menuitem"
              className={`${styles.item} ${it.danger ? styles.danger : ''} ${i === active ? styles.active : ''}`}
              disabled={it.disabled}
              title={it.title}
              onMouseEnter={() => setActive(i)}
              onClick={() => run(it)}
            >
              <span>{it.label}</span>
              {it.shortcut && <span className={styles.shortcut}>{it.shortcut}</span>}
            </button>
          ),
        )}
      </div>
    </div>
  );
}
