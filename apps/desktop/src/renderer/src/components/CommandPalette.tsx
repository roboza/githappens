import {
  Archive,
  ChevronRight,
  Cloud,
  Command,
  CornerDownLeft,
  File,
  Folder,
  FolderGit2,
  GitBranch,
  GitCommitHorizontal,
  GitFork,
  LoaderCircle,
  Palette,
  Search,
  Tag,
  Type,
  User,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useId, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';

import {
  acceptsFreeText,
  DEFAULT_ARG_ICON,
  fetchArgItems,
  getArgProvider,
  type ArgIconName,
  type ArgItem,
} from '../commands/args';
import { fuzzyScore, rankItems } from '../commands/fuzzy';
import { useKeybindingLabel } from '../commands/keybindings-store';
import { getMru, recordMru } from '../commands/mru';
import { parsePrefix, type PrefixMode } from '../commands/prefix';
import {
  disabledReason,
  getCommand,
  getContext,
  isCommandEnabled,
  runCommand,
  setArgRequestHandler,
  useCommands,
} from '../commands/registry';
import type { ArgKind, CommandDef, KeybindingHint } from '../commands/types';
import { useToastStore } from '../stores/toasts';
import { fileEnterAction } from '../views/finder/finder-score';
import styles from './CommandPalette.module.css';

const MAX_RESULTS = 200;
const PAGE = 12;

// ---- store ---------------------------------------------------------------------------------------------

interface PaletteState {
  isOpen: boolean;
  /** Incremented on every open so the dialog remounts with fresh state. */
  session: number;
  initialQuery: string;
  /** When set, the palette opens directly in this command's argument picker. */
  initialCommandId?: string;
  /** Open with an optional prefix/query (`'>'`, `'@'`, `'#'`, `':'`, or any text). */
  open(prefix?: string): void;
  /** Open straight into the argument stage of a two-stage command. */
  openArgs(commandId: string): void;
  close(): void;
  toggle(prefix?: string): void;
}

let restoreFocusTo: HTMLElement | null = null;

function captureFocus(): void {
  const el = document.activeElement;
  if (el instanceof HTMLElement && el !== document.body && !el.closest('[data-command-palette]')) {
    restoreFocusTo = el;
  }
}

export const usePaletteStore = create<PaletteState>((set, get) => ({
  isOpen: false,
  session: 0,
  initialQuery: '',
  open(prefix) {
    if (!get().isOpen) captureFocus();
    set((s) => ({
      isOpen: true,
      session: s.session + 1,
      initialQuery: prefix ?? '',
      initialCommandId: undefined,
    }));
  },
  openArgs(commandId) {
    if (!get().isOpen) captureFocus();
    set((s) => ({ isOpen: true, session: s.session + 1, initialQuery: '', initialCommandId: commandId }));
  },
  close() {
    if (!get().isOpen) return;
    set({ isOpen: false });
    const el = restoreFocusTo;
    restoreFocusTo = null;
    if (el?.isConnected) el.focus();
  },
  toggle(prefix) {
    if (get().isOpen) get().close();
    else get().open(prefix);
  },
}));

// Commands invoked without their argument (e.g. from a shortcut) open the argument picker.
setArgRequestHandler((cmd) => usePaletteStore.getState().openArgs(cmd.id));

// ---- helpers -------------------------------------------------------------------------------------------

const ARG_ICONS: Record<ArgIconName, LucideIcon> = {
  branch: GitBranch,
  branchHead: GitBranch,
  remoteBranch: Cloud,
  tag: Tag,
  stash: Archive,
  repo: FolderGit2,
  file: File,
  folder: Folder,
  theme: Palette,
  commit: GitCommitHorizontal,
  profile: User,
  worktree: GitFork,
  text: Type,
};

const isMac = (): boolean => typeof window !== 'undefined' && window.api?.platform === 'darwin';

/** The command's effective shortcut (defaults + user overrides), so only bindings that fire are shown. */
function CommandHint({ id }: { id: string }) {
  const label = useKeybindingLabel(id);
  return label ? <Hint hint={{ win: label, mac: label }} /> : null;
}

function Hint({ hint }: { hint: KeybindingHint }) {
  const text = isMac() ? hint.mac : hint.win;
  // Split on '+' separators but keep a literal '+' key (e.g. 'Ctrl++').
  const keys = text.split(/\+(?!$)/).filter(Boolean);
  return (
    <span className={styles.hint} aria-label={`Shortcut ${text}`}>
      {keys.map((k, i) => (
        <kbd key={i}>{k}</kbd>
      ))}
    </span>
  );
}

function Highlighted({ text, positions }: { text: string; positions: number[] }) {
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
        <mark key={i} className={styles.match}>
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

type Row =
  | { type: 'command'; key: string; cmd: CommandDef; positions: number[]; enabled: boolean; reason?: string }
  | { type: 'arg'; key: string; item: ArgItem; positions: number[]; kind: ArgKind }
  | { type: 'free'; key: string; value: string; kind: ArgKind };

type Stage = { type: 'commands' } | { type: 'args'; cmd: CommandDef; returnQuery: string };

interface Picker {
  kind: ArgKind;
  query: string;
  commandId: string;
  /** Label of the command/mode, shown as a chip before the input. */
  label: string;
  placeholder: string;
}

function reportError(title: string, err: unknown): void {
  console.error(`[palette] ${title}`, err);
  useToastStore.getState().push({
    kind: 'error',
    title: `${title} failed`,
    body: err instanceof Error ? err.message : String(err),
  });
}

function execute(cmd: CommandDef | undefined, commandId: string, arg?: string): void {
  usePaletteStore.getState().close();
  const title = cmd?.title ?? commandId;
  runCommand(commandId, arg).then(
    (res) => {
      if (res === 'notFound') {
        useToastStore.getState().push({ kind: 'warning', title: `No handler registered for "${commandId}"` });
      } else if (res === 'disabled') {
        const c = getCommand(commandId);
        const reason = c ? disabledReason(c) : undefined;
        useToastStore.getState().push({ kind: 'warning', title: `${title} is unavailable`, body: reason });
      }
    },
    (err: unknown) => reportError(title, err),
  );
}

// ---- component -----------------------------------------------------------------------------------------

/** App-wide command palette (spec 01 §4.8). Mount once; drive it with `usePaletteStore`. */
export function CommandPalette() {
  const isOpen = usePaletteStore((s) => s.isOpen);
  const session = usePaletteStore((s) => s.session);
  const initialQuery = usePaletteStore((s) => s.initialQuery);
  const initialCommandId = usePaletteStore((s) => s.initialCommandId);
  if (!isOpen) return null;
  return createPortal(
    <PaletteDialog key={session} initialQuery={initialQuery} initialCommandId={initialCommandId} />,
    document.body,
  );
}

function PaletteDialog({
  initialQuery,
  initialCommandId,
}: {
  initialQuery: string;
  initialCommandId?: string;
}) {
  const baseId = useId();
  const listId = `${baseId}-list`;
  const optionId = (i: number): string => `${baseId}-opt-${i}`;
  const commands = useCommands();
  const close = usePaletteStore((s) => s.close);

  const [ctx] = useState(getContext);
  const [mru] = useState(getMru);
  const [stage, setStage] = useState<Stage>(() => {
    const cmd = initialCommandId ? getCommand(initialCommandId) : undefined;
    return cmd?.arg ? { type: 'args', cmd, returnQuery: '' } : { type: 'commands' };
  });
  const [query, setQuery] = useState(initialQuery);
  const [active, setActive] = useState(0);
  const [argResult, setArgResult] = useState<{ key: string; kind: ArgKind; items: ArgItem[] } | null>(null);

  // What the input currently picks: commands, a two-stage argument, or a prefix mode.
  const parsed = stage.type === 'commands' ? parsePrefix(query) : null;
  const prefixMode: PrefixMode | null = parsed?.mode ?? null;
  const picker: Picker | null =
    stage.type === 'args'
      ? {
          kind: stage.cmd.arg!.kind,
          query,
          commandId: stage.cmd.id,
          label: stage.cmd.title,
          placeholder: stage.cmd.arg!.placeholder ?? `${stage.cmd.title}…`,
        }
      : prefixMode
        ? {
            kind: prefixMode.kind,
            query: parsed!.rest,
            commandId: prefixMode.commandId,
            label: prefixMode.label,
            placeholder: prefixMode.placeholder,
          }
        : null;
  const pickerKind = picker?.kind;
  const pickerQuery = picker?.query ?? '';
  const requestKey = picker ? `${picker.kind}\u0000${pickerQuery}` : '';

  // Fetch argument candidates (debounced per provider); stale results stay visible while loading.
  useEffect(() => {
    if (!pickerKind || !getArgProvider(pickerKind)) return;
    let cancelled = false;
    const timer = setTimeout(
      () => {
        void fetchArgItems(pickerKind, pickerQuery).then((items) => {
          if (!cancelled) setArgResult({ key: requestKey, kind: pickerKind, items });
        });
      },
      getArgProvider(pickerKind)?.debounceMs ?? 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [pickerKind, pickerQuery, requestKey]);

  const hasProvider = pickerKind ? !!getArgProvider(pickerKind) : false;
  const loading = hasProvider && argResult?.key !== requestKey;

  const rows = useMemo<Row[]>(() => {
    if (!pickerKind) {
      const q = parsed?.rest ?? '';
      return rankItems(commands, q, {
        getText: (c) => c.title,
        getAltText: (c) => [c.category, c.id, ...(c.keywords ?? [])].join(' '),
        getKey: (c) => c.id,
        mru,
        limit: MAX_RESULTS,
        demote: (c) => !isCommandEnabled(c, ctx),
      }).map(({ item, positions }) => {
        const enabled = isCommandEnabled(item, ctx);
        return {
          type: 'command',
          key: `c:${item.id}`,
          cmd: item,
          positions,
          enabled,
          reason: enabled ? undefined : disabledReason(item, ctx),
        };
      });
    }
    const provider = getArgProvider(pickerKind);
    const items = argResult?.kind === pickerKind ? argResult.items : [];
    const out: Row[] = [];
    if (acceptsFreeText(pickerKind) && pickerQuery.trim()) {
      out.push({ type: 'free', key: 'free', value: pickerQuery.trim(), kind: pickerKind });
    }
    if (provider?.filter === 'none') {
      for (const item of items.slice(0, MAX_RESULTS)) {
        out.push({
          type: 'arg',
          key: `a:${item.id}`,
          item,
          kind: pickerKind,
          positions: fuzzyScore(pickerQuery, item.label)?.positions ?? [],
        });
      }
    } else {
      const ranked = rankItems(items, pickerQuery, {
        getText: (i) => i.label,
        getAltText: (i) => i.detail,
        getKey: (i) => `${pickerKind}:${i.id}`,
        mru,
        limit: MAX_RESULTS,
      });
      for (const { item, positions } of ranked) {
        out.push({ type: 'arg', key: `a:${item.id}`, item, kind: pickerKind, positions });
      }
    }
    return out;
  }, [pickerKind, pickerQuery, parsed?.rest, commands, mru, ctx, argResult]);

  const activeIndex = rows.length ? Math.min(Math.max(active, 0), rows.length - 1) : -1;
  const activeRow = activeIndex >= 0 ? rows[activeIndex] : undefined;

  useEffect(() => {
    if (activeIndex >= 0)
      document.getElementById(`${baseId}-opt-${activeIndex}`)?.scrollIntoView({ block: 'nearest' });
  }, [baseId, activeIndex, rows]);

  const changeQuery = (q: string): void => {
    setQuery(q);
    setActive(0);
  };

  const enterArgs = (cmd: CommandDef): void => {
    setStage({ type: 'args', cmd, returnQuery: query });
    setArgResult(null);
    changeQuery('');
  };

  const activate = (
    row: Row | undefined,
    modifiers?: { ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean },
  ): void => {
    if (!row) return;
    if (row.type === 'command') {
      if (!row.enabled) return;
      if (row.cmd.arg) enterArgs(row.cmd);
      else execute(row.cmd, row.cmd.id);
      return;
    }
    if (!picker) return;
    const cmd = stage.type === 'args' ? stage.cmd : getCommand(picker.commandId);
    if (row.type === 'arg') {
      recordMru(`${row.kind}:${row.item.id}`);
      // Files mode (`#` / Ctrl+Shift+O): Ctrl/Cmd+Enter history, Alt+Enter blame, Shift+Enter external.
      const alt =
        row.kind === 'file' && stage.type === 'commands' && modifiers ? fileEnterAction(modifiers) : null;
      if (alt && alt !== picker.commandId) execute(getCommand(alt), alt, row.item.id);
      else execute(cmd, picker.commandId, row.item.id);
    } else execute(cmd, picker.commandId, row.value);
  };

  const move = (delta: number, wrap: boolean): void => {
    if (!rows.length) return;
    const n = rows.length;
    const next = activeIndex + delta;
    setActive(wrap ? (next + n) % n : Math.min(Math.max(next, 0), n - 1));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    const ctrlOnly = e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
    const k = e.key;
    let handled = true;
    if (k === 'ArrowDown' || (ctrlOnly && k === 'j')) move(1, true);
    else if (k === 'ArrowUp' || (ctrlOnly && k === 'k')) move(-1, true);
    else if (k === 'PageDown') move(PAGE, false);
    else if (k === 'PageUp') move(-PAGE, false);
    else if (k === 'Enter' && !e.nativeEvent.isComposing) activate(activeRow, e);
    else if (k === 'Escape') close();
    else if (k === 'Tab') {
      // Tab accepts the argument stage for a two-stage command, or autocompletes an argument.
      if (activeRow?.type === 'command' && activeRow.enabled && activeRow.cmd.arg) enterArgs(activeRow.cmd);
      else if (activeRow?.type === 'arg') {
        changeQuery(prefixMode ? `${prefixMode.prefix}${activeRow.item.label}` : activeRow.item.label);
      }
    } else if (k === 'Backspace' && stage.type === 'args' && query === '') {
      setStage({ type: 'commands' });
      changeQuery(stage.returnQuery);
    } else handled = false;
    if (handled) {
      e.preventDefault();
      // Keep global shortcuts (Ctrl+J/K panel toggles, Esc close-current) from also firing.
      e.stopPropagation();
    }
  };

  const ModeIcon = picker ? ARG_ICONS[DEFAULT_ARG_ICON[picker.kind]] : Command;
  const emptyText = loading
    ? 'Loading…'
    : picker
      ? hasProvider || pickerQuery
        ? 'No matches'
        : 'Type a value and press Enter'
      : commands.length
        ? 'No matching commands'
        : 'No commands registered';

  return (
    <div
      className={styles.backdrop}
      data-command-palette=""
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className={styles.palette} role="dialog" aria-modal="true" aria-label="Command Palette">
        <div className={styles.inputRow}>
          {loading ? (
            <LoaderCircle size={16} className={`${styles.modeIcon} ${styles.spin}`} aria-hidden />
          ) : (
            <ModeIcon size={16} className={styles.modeIcon} aria-hidden />
          )}
          {stage.type === 'args' && (
            <span className={styles.chip}>
              {stage.cmd.title}
              <ChevronRight size={12} aria-hidden />
            </span>
          )}
          <input
            className={styles.input}
            type="text"
            role="combobox"
            aria-expanded={rows.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
            aria-label={picker ? picker.placeholder : 'Type a command'}
            placeholder={picker ? picker.placeholder : 'Type a command, or @ branch, # file, : commit'}
            spellCheck={false}
            autoComplete="off"
            autoFocus
            value={query}
            onChange={(e) => changeQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>
        <ul
          id={listId}
          role="listbox"
          aria-label={picker ? picker.label : 'Commands'}
          className={styles.list}
          onMouseDown={(e) => e.preventDefault() /* keep focus in the input */}
        >
          {rows.map((row, i) => (
            <PaletteRow
              key={row.key}
              id={optionId(i)}
              row={row}
              active={i === activeIndex}
              onHover={() => {
                if (i !== activeIndex) setActive(i);
              }}
              onSelect={() => activate(row)}
            />
          ))}
        </ul>
        {rows.length === 0 && (
          <div className={styles.empty} role="status">
            {emptyText}
          </div>
        )}
        <div className={styles.footer} aria-hidden>
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> navigate
          </span>
          <span>
            <kbd>
              <CornerDownLeft size={10} />
            </kbd>{' '}
            run
          </span>
          {stage.type === 'args' ? (
            <span>
              <kbd>⌫</kbd> back
            </span>
          ) : (
            <span>
              <kbd>Tab</kbd> arguments
            </span>
          )}
          <span>
            <kbd>Esc</kbd> close
          </span>
          {picker?.kind === 'file' && stage.type === 'commands' && (
            <span className={styles.prefixes}>
              {isMac() ? 'Cmd' : 'Ctrl'}+↵ history · {isMac() ? 'Option' : 'Alt'}+↵ blame · Shift+↵ external
              editor
            </span>
          )}
          {!picker && (
            <span className={styles.prefixes}>
              <Search size={10} /> &gt; commands · @ branches · # files · : commits
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function PaletteRow({
  id,
  row,
  active,
  onHover,
  onSelect,
}: {
  id: string;
  row: Row;
  active: boolean;
  onHover(): void;
  onSelect(): void;
}) {
  const disabled = row.type === 'command' && !row.enabled;
  const cls = `${styles.row} ${active ? styles.active : ''} ${disabled ? styles.disabled : ''}`;
  const common = {
    id,
    role: 'option' as const,
    'aria-selected': active,
    'aria-disabled': disabled || undefined,
    className: cls,
    onMouseMove: onHover,
    onClick: onSelect,
  };

  if (row.type === 'command') {
    const Icon = row.cmd.icon;
    return (
      <li {...common} title={row.reason}>
        <span className={styles.icon} aria-hidden>
          {Icon ? <Icon size={14} /> : null}
        </span>
        <span className={styles.category}>{row.cmd.category}</span>
        <span className={styles.label}>
          <Highlighted text={row.cmd.title} positions={row.positions} />
          {row.cmd.arg && (
            <ChevronRight size={12} className={styles.argMarker} aria-label="takes an argument" />
          )}
        </span>
        {row.reason && <span className={styles.detail}>{row.reason}</span>}
        <CommandHint id={row.cmd.id} />
      </li>
    );
  }

  if (row.type === 'free') {
    const Icon = ARG_ICONS[DEFAULT_ARG_ICON[row.kind]];
    return (
      <li {...common}>
        <span className={styles.icon} aria-hidden>
          <Icon size={14} />
        </span>
        <span className={styles.label}>
          Use “<strong>{row.value}</strong>”
        </span>
        <span className={styles.hint}>
          <kbd>
            <CornerDownLeft size={10} />
          </kbd>
        </span>
      </li>
    );
  }

  const Icon = ARG_ICONS[row.item.icon ?? DEFAULT_ARG_ICON[row.kind]];
  return (
    <li {...common}>
      <span className={`${styles.icon} ${row.item.icon === 'branchHead' ? styles.head : ''}`} aria-hidden>
        <Icon size={14} />
      </span>
      <span className={styles.label}>
        <Highlighted text={row.item.label} positions={row.positions} />
      </span>
      {row.item.detail && <span className={styles.detail}>{row.item.detail}</span>}
    </li>
  );
}
