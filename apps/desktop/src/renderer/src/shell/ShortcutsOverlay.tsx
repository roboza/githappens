import { useMemo, useState } from 'react';

import { useCommands } from '../commands';
import { formatChord } from '../commands/keybindings';
import { isMacPlatform, useKeybindingsStore } from '../commands/keybindings-store';
import { Modal } from '../components/Modal';
import { shortcutRows } from './shortcuts-model';
import { useShortcutsOverlay } from './shortcuts-overlay-store';
import styles from './ShellHost.module.css';

/** Keyboard Shortcuts overlay (spec 01 §4.9 `view.shortcuts`): every effective binding, by category. */
export function ShortcutsOverlay() {
  const open = useShortcutsOverlay((s) => s.open);
  const close = useShortcutsOverlay((s) => s.close);
  const commands = useCommands();
  const resolved = useKeybindingsStore((s) => s.resolved);
  const [filter, setFilter] = useState('');
  const mac = isMacPlatform();
  const groups = useMemo(
    () => shortcutRows(commands, resolved, filter, (k) => formatChord(k, mac)),
    [commands, resolved, filter, mac],
  );

  return (
    <Modal title="Keyboard Shortcuts" open={open} onClose={close}>
      <div className={styles.shortcuts}>
        <div className={styles.shortcutsBar}>
          <input
            type="search"
            autoFocus
            placeholder="Filter shortcuts…"
            aria-label="Filter shortcuts"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <button
            type="button"
            onClick={() => {
              close();
              // App opens Preferences at the section named in the event.
              window.dispatchEvent(new CustomEvent('kl:open-preferences', { detail: 'Keybindings' }));
            }}
          >
            Customize…
          </button>
        </div>
        <div className={styles.shortcutsGrid}>
          {groups.map((g) => (
            <section key={g.category} className={styles.shortcutGroup}>
              <h3>{g.category}</h3>
              <dl>
                {g.rows.map((r) => (
                  <div key={r.id} className={styles.shortcutRow}>
                    <dt>{r.title}</dt>
                    <dd>
                      {r.keys.map((k) => (
                        <kbd key={k}>{k}</kbd>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
          {groups.length === 0 && <p className={styles.muted}>No shortcuts match.</p>}
        </div>
      </div>
    </Modal>
  );
}
