import type { KeybindingOverride } from '../../../shared/settings/keybindings';

/**
 * Keybinding service core (spec 13 §7 step 9, spec 01 §4.9). DOM-free so it can be unit-tested:
 * chord normalization, defaults, user overrides, `when` contexts and conflict detection.
 *
 * Chords are lower-case `+`-joined strings with modifiers in the order ctrl, alt, shift, meta,
 * e.g. `ctrl+shift+s`. In defaults, `mod` means Ctrl on Windows/Linux and Cmd (meta) on macOS.
 */

export type KeyWhen = 'textInputFocus' | '!textInputFocus';

export interface DefaultKeybinding {
  command: string;
  key: string;
  /** macOS chord when it differs from `key` (after `mod` expansion). */
  mac?: string;
  when?: KeyWhen;
}

export interface ResolvedKeybinding {
  command: string;
  /** Normalized chord for the current platform. */
  key: string;
  when?: string;
  source: 'default' | 'user';
}

export interface KeyContext {
  textInputFocus: boolean;
}

const MODS = ['ctrl', 'alt', 'shift', 'meta'] as const;
type Mod = (typeof MODS)[number];

const MOD_ALIASES: Record<string, Mod | 'mod'> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  shift: 'shift',
  meta: 'meta',
  cmd: 'meta',
  command: 'meta',
  super: 'meta',
  win: 'meta',
  mod: 'mod',
};

const KEY_ALIASES: Record<string, string> = {
  esc: 'escape',
  return: 'enter',
  del: 'delete',
  ins: 'insert',
  arrowup: 'up',
  arrowdown: 'down',
  arrowleft: 'left',
  arrowright: 'right',
  ' ': 'space',
  spacebar: 'space',
  plus: '=',
  pgup: 'pageup',
  pgdn: 'pagedown',
};

/** Normalize a chord string (`Ctrl+Shift+K`, `mod+p`, `cmd+,`) or return null when invalid. */
export function normalizeChord(input: string, isMac: boolean): string | null {
  const raw = input.trim().toLowerCase();
  if (!raw) return null;
  // A trailing "+" key ("ctrl++") is written as "=" (same physical key on US layouts).
  const parts = raw.endsWith('++') ? [...raw.slice(0, -2).split('+'), '='] : raw.split('+');
  const mods = new Set<Mod>();
  let key: string | null = null;
  for (const p of parts.map((x) => x.trim())) {
    if (!p) return null;
    const m = MOD_ALIASES[p];
    if (m) {
      mods.add(m === 'mod' ? (isMac ? 'meta' : 'ctrl') : m);
      continue;
    }
    if (key !== null) return null; // two non-modifier keys
    key = KEY_ALIASES[p] ?? p;
  }
  if (key === null) return null;
  return [...MODS.filter((m) => mods.has(m)), key].join('+');
}

const CODE_KEYS: Record<string, string> = {
  Minus: '-',
  Equal: '=',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Backquote: '`',
  Space: 'space',
  Enter: 'enter',
  NumpadEnter: 'enter',
  Tab: 'tab',
  Escape: 'escape',
  Backspace: 'backspace',
  Delete: 'delete',
  Insert: 'insert',
  Home: 'home',
  End: 'end',
  PageUp: 'pageup',
  PageDown: 'pagedown',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  NumpadAdd: 'numpadadd',
  NumpadSubtract: 'numpadsubtract',
  NumpadMultiply: 'numpadmultiply',
  NumpadDivide: 'numpaddivide',
};

export interface KeyEventLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

/**
 * Chord for a keyboard event, or null for a lone modifier. Latin letters use `key` (follows the
 * keyboard layout); digits, punctuation and named keys use `code`, so Shift does not change them.
 */
export function eventToChord(e: KeyEventLike): string | null {
  if (['Control', 'Shift', 'Alt', 'Meta', 'OS', 'AltGraph', 'CapsLock', 'Dead'].includes(e.key)) return null;
  let key: string | undefined;
  if (/^[a-z]$/i.test(e.key)) key = e.key.toLowerCase();
  else if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3).toLowerCase();
  else if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5);
  else if (/^Numpad[0-9]$/.test(e.code)) key = `numpad${e.code.slice(6)}`;
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(e.code)) key = e.code.toLowerCase();
  else key = CODE_KEYS[e.code];
  if (!key) {
    const k = e.key.toLowerCase();
    if (!k || k === 'unidentified') return null;
    key = KEY_ALIASES[k] ?? k;
  }
  const mods: Mod[] = [];
  if (e.ctrlKey) mods.push('ctrl');
  if (e.altKey) mods.push('alt');
  if (e.shiftKey) mods.push('shift');
  if (e.metaKey) mods.push('meta');
  return [...mods, key].join('+');
}

const KEY_LABELS: Record<string, string> = {
  enter: 'Enter',
  escape: 'Esc',
  tab: 'Tab',
  space: 'Space',
  backspace: 'Backspace',
  delete: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
};

/** Human label: `Ctrl+Shift+K` (Win/Linux) or `Cmd+Shift+K` / `Option+…` on macOS. */
export function formatChord(chord: string, isMac: boolean): string {
  if (!chord) return '';
  const parts = (normalizeChord(chord, isMac) ?? chord).split('+');
  const key = parts.pop() ?? '';
  const modLabel: Record<string, string> = isMac
    ? { ctrl: 'Ctrl', alt: 'Option', shift: 'Shift', meta: 'Cmd' }
    : { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Win' };
  const k =
    KEY_LABELS[key] ?? (key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1));
  return [...parts.map((m) => modLabel[m] ?? m), k].join('+');
}

// ---- defaults (spec 01 §4.9) ------------------------------------------------------------------------

const NOT_IN_TEXT: KeyWhen = '!textInputFocus';

export const DEFAULT_KEYBINDINGS: DefaultKeybinding[] = [
  // global
  { command: 'view.shortcuts', key: 'mod+/' },
  { command: 'palette.toggle', key: 'mod+p' },
  // Ctrl/Cmd+Shift+O opens the palette in files mode (spec 12 §4.8/§4.11; spec 01's "open repo via
  // palette" moved to the breadcrumb RepoSwitcher / `repo.open`). Repo Management is Ctrl/Cmd+O.
  { command: 'finder.files', key: 'mod+shift+o' },
  { command: 'history.file', key: 'mod+shift+h' },
  { command: 'repoMgmt.show', key: 'mod+o' },
  { command: 'repo.openInFileManager', key: 'alt+o' },
  // "Workspace: Open…" (spec 11 §4.1 asks for Ctrl/Cmd+Shift+O, which is the file finder here and
  // Ctrl/Cmd+O is Repo Management) → Ctrl/Cmd+Alt+O; never while typing (AltGr+O on some layouts).
  { command: 'workspace.open', key: 'mod+alt+o', when: NOT_IN_TEXT },
  // open in external apps (spec 01 §4.9, spec 12 §4.10); Ctrl+D stays Monaco's in editors
  { command: 'repo.openInTerminal', key: 'alt+t', when: NOT_IN_TEXT },
  { command: 'repo.openInExternalEditor', key: 'mod+shift+e' },
  { command: 'repo.openExternalDiff', key: 'mod+d', when: NOT_IN_TEXT },
  { command: 'graph.focusSearch', key: 'mod+f', when: NOT_IN_TEXT },
  { command: 'leftPanel.focusFilter', key: 'mod+alt+f' },
  { command: 'view.toggleLeftPanel', key: 'mod+j' },
  { command: 'view.toggleRightPanel', key: 'mod+k' },
  { command: 'view.zoomIn', key: 'mod+=' },
  { command: 'view.zoomIn', key: 'mod+shift+=' },
  { command: 'view.zoomIn', key: 'mod+numpadadd' },
  { command: 'view.zoomOut', key: 'mod+-' },
  { command: 'view.zoomOut', key: 'mod+numpadsubtract' },
  { command: 'view.zoomReset', key: 'mod+0' },
  { command: 'prefs.open', key: 'mod+,' },
  // Esc closes the current overlay view (diff / file / PR); deferred, so views that handle Esc win.
  { command: 'view.closeCurrent', key: 'escape' },
  // F6 cycles focus between the title bar, toolbar, left panel, center and right panel (spec 01 §7.18).
  { command: 'view.focusNextPanel', key: 'f6' },
  { command: 'view.focusPrevPanel', key: 'shift+f6' },
  { command: 'view.fullscreen', key: 'f11', mac: 'ctrl+meta+f' },
  // Terminal (spec 12 §4.11). Cmd+` is reserved by macOS (cycle windows), so Ctrl+` everywhere.
  { command: 'view.toggleTerminal', key: 'ctrl+`' },
  { command: 'terminal.newTab', key: 'ctrl+shift+`' },
  { command: 'ai.commitMessage', key: 'mod+alt+m' },
  // tabs
  { command: 'tab.new', key: 'mod+t' },
  { command: 'repo.closeTab', key: 'mod+w' },
  ...Array.from({ length: 9 }, (_, i) => ({ command: `tab.goto.${i + 1}`, key: `mod+${i + 1}` })),
  // Cmd+Tab is OS-reserved on macOS, so Ctrl+Tab is used on every platform (spec 01 §4.9 note).
  { command: 'tab.next', key: 'ctrl+tab' },
  { command: 'tab.prev', key: 'ctrl+shift+tab' },
  // Favorites 1–9 (spec 01 §4.9; Cmd+Option on macOS). Ctrl+Alt is AltGr on many layouts, so never
  // while typing; deferred, so the diff view's Ctrl/Cmd+Alt+1..3 view modes win while it is focused.
  ...Array.from({ length: 9 }, (_, i) => ({
    command: `favorite.open.${i + 1}`,
    key: `mod+alt+${i + 1}`,
    when: NOT_IN_TEXT,
  })),
  // repo
  { command: 'branch.create', key: 'mod+b' },
  { command: 'remote.fetchAll', key: 'mod+l' },
  { command: 'core.undo', key: 'mod+z', when: NOT_IN_TEXT },
  { command: 'core.redo', key: 'mod+y', when: NOT_IN_TEXT },
  { command: 'core.redo', key: 'mod+shift+z', when: NOT_IN_TEXT },
  { command: 'graph.jumpToHead', key: 'mod+shift+0' },
  // WIP
  { command: 'wip.stageAll', key: 'mod+shift+s' },
  { command: 'wip.unstageAll', key: 'mod+shift+u' },
  { command: 'wip.commit', key: 'mod+enter', when: NOT_IN_TEXT },
  // Ctrl/Cmd+Shift+Enter = commit & push (spec 06 §4.5); stage all + commit moved to Ctrl/Cmd+Alt+Enter
  { command: 'wip.commitPush', key: 'mod+shift+enter', when: NOT_IN_TEXT },
  { command: 'wip.stageAllCommit', key: 'mod+alt+enter', when: NOT_IN_TEXT },
  { command: 'wip.focusMessage', key: 'mod+shift+m' },
  // stash (spec 05 §4.10)
  { command: 'stash.quick', key: 'alt+s', when: NOT_IN_TEXT },
  { command: 'stash.popLatest', key: 'alt+shift+s', when: NOT_IN_TEXT },
];

/**
 * Commands whose bindings yield to view-local key handlers: the dispatcher runs them after the event
 * finished dispatching and only if nobody called `preventDefault` (Esc in the diff view / merge tool,
 * Ctrl/Cmd+Alt+1..3 diff modes).
 */
export function isDeferredCommand(command: string): boolean {
  return command === 'view.closeCurrent' || command.startsWith('favorite.open.');
}

/** OS-level shortcuts that can never be bound (spec 13 §8). */
const RESERVED: Record<'mac' | 'other', Record<string, string>> = {
  mac: {
    'meta+q': 'Quit',
    'meta+tab': 'App switcher',
    'meta+h': 'Hide app',
    'meta+m': 'Minimize',
    'meta+space': 'Spotlight',
    'meta+`': 'Cycle windows',
    'ctrl+meta+q': 'Lock screen',
  },
  other: {
    'alt+f4': 'Close window',
    'alt+tab': 'Window switcher',
    'ctrl+alt+delete': 'Security screen',
    'meta+l': 'Lock screen',
    'meta+d': 'Show desktop',
    'meta+tab': 'Task view',
  },
};

/** Why a chord cannot be bound, or undefined if it can. */
export function reservedReason(chord: string, isMac: boolean): string | undefined {
  const r = RESERVED[isMac ? 'mac' : 'other'][chord];
  return r ? `${formatChord(chord, isMac)} is reserved by the OS (${r}).` : undefined;
}

// ---- resolution -------------------------------------------------------------------------------------

/**
 * Effective bindings: user overrides first, then defaults for commands without overrides.
 * An override with an empty key unbinds the command.
 */
export function resolveKeybindings(
  defaults: readonly DefaultKeybinding[],
  overrides: readonly KeybindingOverride[],
  isMac: boolean,
): ResolvedKeybinding[] {
  const overridden = new Set(overrides.map((o) => o.command));
  const out: ResolvedKeybinding[] = [];
  const seen = new Set<string>();
  const push = (b: ResolvedKeybinding): void => {
    const id = `${b.command}\u0000${b.key}\u0000${b.when ?? ''}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push(b);
  };
  for (const o of overrides) {
    const raw = isMac ? (o.mac ?? o.key) : o.key;
    const key = raw ? normalizeChord(raw, isMac) : null;
    if (!key || reservedReason(key, isMac)) continue;
    push({ command: o.command, key, when: o.when, source: 'user' });
  }
  for (const d of defaults) {
    if (overridden.has(d.command)) continue;
    const key = normalizeChord(isMac ? (d.mac ?? d.key) : d.key, isMac);
    if (key) push({ command: d.command, key, when: d.when, source: 'default' });
  }
  return out;
}

const isBareKey = (chord: string): boolean =>
  !/^(ctrl|alt|meta)\+/.test(chord) && !/\+(ctrl|alt|meta)\+/.test(chord);

/** Whether a binding's `when` clause holds. Bare keys (no Ctrl/Alt/Cmd) never fire in text fields. */
export function whenMatches(b: Pick<ResolvedKeybinding, 'when' | 'key'>, ctx: KeyContext): boolean {
  const notFnKey = !/^f([1-9]|1[0-9]|2[0-4])$/.test(b.key.split('+').pop() ?? '');
  if (ctx.textInputFocus && isBareKey(b.key) && notFnKey) return false;
  switch (b.when?.trim()) {
    case undefined:
    case '':
      return true;
    case 'textInputFocus':
      return ctx.textInputFocus;
    case '!textInputFocus':
      return !ctx.textInputFocus;
    default:
      return false;
  }
}

/** Bindings for `chord` that apply in `ctx`, in priority order (user before default). */
export function findMatches(
  resolved: readonly ResolvedKeybinding[],
  chord: string,
  ctx: KeyContext,
): ResolvedKeybinding[] {
  return resolved.filter((b) => b.key === chord && whenMatches(b, ctx));
}

export function bindingsFor(resolved: readonly ResolvedKeybinding[], command: string): ResolvedKeybinding[] {
  return resolved.filter((b) => b.command === command);
}

const whenOverlaps = (a?: string, b?: string): boolean => {
  const x = a?.trim() || undefined;
  const y = b?.trim() || undefined;
  if (!x || !y || x === y) return true;
  return !(x === `!${y}` || y === `!${x}`);
};

export interface KeybindingConflict {
  key: string;
  commands: string[];
}

/** Chords bound to more than one command in overlapping contexts. */
export function findConflicts(resolved: readonly ResolvedKeybinding[]): KeybindingConflict[] {
  const byKey = new Map<string, ResolvedKeybinding[]>();
  for (const b of resolved) byKey.set(b.key, [...(byKey.get(b.key) ?? []), b]);
  const out: KeybindingConflict[] = [];
  for (const [key, list] of byKey) {
    const cmds = new Set<string>();
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!;
        const b = list[j]!;
        if (a.command !== b.command && whenOverlaps(a.when, b.when)) {
          cmds.add(a.command);
          cmds.add(b.command);
        }
      }
    }
    if (cmds.size > 1) out.push({ key, commands: [...cmds] });
  }
  return out;
}

/** Other commands already using `chord` (for the recorder's conflict warning). */
export function conflictsFor(
  resolved: readonly ResolvedKeybinding[],
  chord: string,
  command: string,
  when?: string,
): string[] {
  return [
    ...new Set(
      resolved
        .filter((b) => b.key === chord && b.command !== command && whenOverlaps(b.when, when))
        .map((b) => b.command),
    ),
  ];
}

// ---- override editing -------------------------------------------------------------------------------

/** Replace a command's bindings with `keys` (empty list = unbind). */
export function setCommandBindings(
  overrides: readonly KeybindingOverride[],
  command: string,
  keys: readonly { key: string; when?: string }[],
): KeybindingOverride[] {
  const rest = overrides.filter((o) => o.command !== command);
  const entries: KeybindingOverride[] = keys.length
    ? keys.map((k) => (k.when ? { command, key: k.key, when: k.when } : { command, key: k.key }))
    : [{ command, key: '' }];
  return [...rest, ...entries];
}

/** Drop all overrides of a command so its defaults apply again. */
export function resetCommandBindings(
  overrides: readonly KeybindingOverride[],
  command: string,
): KeybindingOverride[] {
  return overrides.filter((o) => o.command !== command);
}

/** Default bindings of one command (normalized for the platform). */
export function defaultBindingsFor(command: string, isMac: boolean): ResolvedKeybinding[] {
  return resolveKeybindings(
    DEFAULT_KEYBINDINGS.filter((d) => d.command === command),
    [],
    isMac,
  );
}
