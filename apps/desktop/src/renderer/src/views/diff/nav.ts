/** Change navigation exposed by every diff body (spec 07 §4.3: ↑/↓, F7/Shift+F7, Alt+↑/↓, counter). */
export interface ChangeNav {
  /** Move to the next (1) / previous (-1) change; false when already at the last/first one. */
  go(dir: 1 | -1): boolean;
  /** New-side line at the top of the viewport (for keeping the position across modes). */
  topLine(): number | null;
  reveal(line: number): void;
}
