import type { CompletionItem } from '@githappens/git/completions';
import { FileText, GitBranch, Terminal as TerminalIcon, ToggleLeft } from 'lucide-react';

import styles from './TerminalPanel.module.css';

export interface AutocompleteState {
  items: CompletionItem[];
  index: number;
  /** Pixel position of the cursor cell's bottom-left inside the terminal host. */
  x: number;
  y: number;
}

const ICONS = {
  subcommand: TerminalIcon,
  alias: TerminalIcon,
  flag: ToggleLeft,
  ref: GitBranch,
  path: FileText,
} as const;

/** Git autocomplete popup anchored to the cursor cell (spec 12 §4.3): ≤ 8 items + descriptions. */
export function GitAutocompletePopup({
  state,
  onPick,
}: {
  state: AutocompleteState;
  onPick(index: number): void;
}) {
  return (
    <div
      className={styles.autocomplete}
      style={{ left: state.x, top: state.y }}
      role="listbox"
      aria-label="Git suggestions"
      onMouseDown={(e) => e.preventDefault() /* keep focus in xterm */}
    >
      {state.items.map((it, i) => {
        const Icon = ICONS[it.kind];
        return (
          <div
            key={`${it.kind}:${it.label}`}
            role="option"
            aria-selected={i === state.index}
            className={`${styles.acItem} ${i === state.index ? styles.acItemActive : ''}`}
            onClick={() => onPick(i)}
          >
            <Icon size={12} className={styles.acIcon} />
            <span className={styles.acLabel}>{it.label}</span>
            {it.detail && <span className={styles.acDetail}>{it.detail}</span>}
          </div>
        );
      })}
      <div className={styles.acHint}>Tab / Enter to accept · Esc to dismiss</div>
    </div>
  );
}
