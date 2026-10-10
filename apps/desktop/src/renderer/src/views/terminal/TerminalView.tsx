import { suggestGit, type CompletionItem } from '@githappens/git/completions';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal, type IMarker } from '@xterm/xterm';
import { ArrowDown, ArrowUp, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type { TerminalCompletionContext, TerminalInfo } from '../../../../shared/ipc/terminal-contract';
import { shellKindOf } from '../../../../shared/terminal/shell-quote';
import { useContextMenu } from '../../components/ContextMenu';
import { invoke } from '../../lib/api';
import { useSetting } from '../../stores/settings';
import { WIP_DRAG_MIME } from '../composer/staging-helpers';
import { droppedPaths } from '../repos/folder-drop';
import { GitAutocompletePopup, type AutocompleteState } from './GitAutocompletePopup';
import { attachTerminalSink, ensureTerminalEvents, terminalInvoke } from './terminal-api';
import {
  dropText,
  findPathLinks,
  joinPath,
  KeystrokeLine,
  pathsFromCwd,
  repoRelative,
} from './terminal-helpers';
import styles from './TerminalPanel.module.css';
import { buildXtermTheme, readToken } from './xterm-theme';

export interface TerminalAppearance {
  fontFamily?: string;
  fontSize: number;
  lineHeight: number;
  cursorStyle: 'block' | 'underline' | 'bar';
  cursorBlink: boolean;
  scrollback: number;
}

/** Repo data for git autocomplete (read lazily from the query cache). */
export interface CompletionData {
  refs: string[];
  /** Repo-relative paths: changed (WIP) first, then tracked files. */
  paths: string[];
}

interface Props {
  cwd: string;
  shell?: string;
  args?: string[];
  /**
   * Bind to an existing pty (agent session from `agents:start`) instead of creating one. Such
   * views detach on unmount (the pty keeps running); the owner kills it explicitly.
   */
  attachId?: string;
  /** Panel visible and this tab selected: refit + focus. */
  active: boolean;
  appearance: TerminalAppearance;
  themeVersion: number;
  /** Repo / worktree root (`GITHAPPENS_REPO`, link and path resolution). */
  repoRoot?: string;
  /** Inject OSC 7 / 133 shell integration into new shells. */
  shellIntegration?: boolean;
  /** `terminal.autocomplete`. */
  autocomplete?: boolean;
  completionData?(): CompletionData;
  onStarted(info: TerminalInfo): void;
  onError(message: string): void;
  onExit(exitCode: number): void;
  /** The shell reported a new cwd (OSC 7). */
  onCwd?(cwd: string): void;
  /** A command finished (OSC 133;D, or the 500 ms idle fallback after Enter). */
  onCommandDone?(): void;
  /** Ctrl/Cmd+click on `path:line` inside the repo. */
  onOpenPath?(repoPath: string, line: number): void;
}

/** Chars of processed output to accumulate before acking (flow control, see PtyService). */
const ACK_CHUNK = 16 * 1024;
/** Without shell integration a command counts as finished after this much output silence. */
const IDLE_MS = 500;
const noop = (): void => {};

const isMac = (): boolean => window.api.platform === 'darwin';

function copyText(text: string): void {
  navigator.clipboard.writeText(text).catch(() => void invoke('shell:copyText', { text }).catch(noop));
}

function pasteInto(term: Terminal): void {
  navigator.clipboard
    .readText()
    .then((t) => {
      if (t) term.paste(t);
      term.focus();
    })
    .catch(noop);
}

function monoFont(): string {
  return readToken('font-mono') || 'ui-monospace, Consolas, Menlo, monospace';
}

function openUrl(url: string): void {
  if (/^https?:\/\//i.test(url)) void invoke('shell:openExternal', { url }).catch(noop);
}

/** Context data per cwd shared by all views (aliases are cached in main too). */
const contextCache = new Map<string, Promise<TerminalCompletionContext>>();
function completionContext(cwd: string): Promise<TerminalCompletionContext> {
  let p = contextCache.get(cwd);
  if (!p) {
    p = terminalInvoke('terminal:completionContext', { cwd }).catch(() => ({ aliases: [], conflict: null }));
    contextCache.set(cwd, p);
    setTimeout(() => contextCache.delete(cwd), 60_000);
  }
  return p;
}

/** One xterm.js instance bound to one pty. Stays mounted (and alive) while hidden. */
export function TerminalView({
  cwd,
  shell,
  args,
  attachId,
  active,
  appearance,
  themeVersion,
  repoRoot,
  shellIntegration,
  autocomplete = true,
  completionData,
  onStarted,
  onError,
  onExit,
  onCwd,
  onCommandDone,
  onOpenPath,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<(() => void) | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const writeRef = useRef<(data: string) => void>(noop);
  const shellKindRef = useRef(shellKindOf(shell));
  // Spawn parameters are fixed at mount; callbacks are kept fresh without re-running the mount effect.
  const initRef = useRef({ cwd, shell, args, attachId, appearance, repoRoot, shellIntegration });
  const cbRef = useRef({ onStarted, onError, onExit, onCwd, onCommandDone, onOpenPath, completionData });
  const acEnabledRef = useRef(autocomplete);
  useEffect(() => {
    cbRef.current = { onStarted, onError, onExit, onCwd, onCommandDone, onOpenPath, completionData };
    acEnabledRef.current = autocomplete;
  }, [onStarted, onError, onExit, onCwd, onCommandDone, onOpenPath, completionData, autocomplete]);

  const [ac, setAc] = useState<AutocompleteState | null>(null);
  const acRef = useRef<AutocompleteState | null>(null);
  const acceptRef = useRef<(i: number) => void>(noop);
  const [conflict, setConflict] = useState<string | null>(null);
  const [conflictDismissed, setConflictDismissed] = useState(false);
  const [find, setFind] = useState<{ open: boolean; query: string; count: number; index: number }>({
    open: false,
    query: '',
    count: 0,
    index: -1,
  });
  const findInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const showAc = (s: AutocompleteState | null): void => {
    acRef.current = s;
    setAc(s);
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const init = initRef.current;
    const term = new Terminal({
      fontFamily: init.appearance.fontFamily || monoFont(),
      fontSize: init.appearance.fontSize,
      lineHeight: init.appearance.lineHeight,
      cursorStyle: init.appearance.cursorStyle,
      cursorBlink: init.appearance.cursorBlink,
      scrollback: init.appearance.scrollback,
      theme: buildXtermTheme(),
      allowTransparency: false,
      allowProposedApi: true, // unicode11 + search decorations
      macOptionIsMeta: true,
      ...(window.api.platform === 'win32' ? { windowsPty: { backend: 'conpty' as const } } : {}),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const search = new SearchAddon({ highlightLimit: 2000 });
    term.loadAddon(search);
    searchRef.current = search;
    term.loadAddon(new WebLinksAddon((e, uri) => (e.ctrlKey || e.metaKey ? openUrl(uri) : undefined)));
    term.open(host);
    try {
      term.loadAddon(new Unicode11Addon());
      term.unicode.activeVersion = '11';
    } catch {
      // keep the default unicode tables
    }
    termRef.current = term;

    const doFit = (): void => {
      if (!host.clientWidth || !host.clientHeight) return; // hidden (display: none)
      try {
        fit.fit();
      } catch {
        // renderer not ready yet
      }
    };
    fitRef.current = doFit;
    doFit();

    let ptyId: string | null = null;
    let disposed = false;
    let acked = 0;
    let detach = noop;
    /** Last cwd from OSC 7 (relative `path:line` links resolve against it). */
    let shellCwd = init.cwd;

    // ---- shell integration (OSC 7 / 133) parsed in sync with the buffer ----
    let integrated = false;
    let promptMarker: IMarker | null = null;
    let promptCol = 0;
    let inputActive = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let awaitingIdle = false;
    const keyLine = new KeystrokeLine();
    /** User input arrived: recompute suggestions once the echo is rendered. */
    let pendingCompute = false;

    const commandDone = (): void => cbRef.current.onCommandDone?.();
    const oscSubs = [
      term.parser.registerOscHandler(7, (data) => {
        const m = /^[a-z][a-z0-9+.-]*:\/\/[^/]*(\/.*)$/i.exec(data);
        if (m) {
          let p = m[1]!;
          try {
            if (/%[0-9a-f]{2}/i.test(p)) p = decodeURIComponent(p);
          } catch {
            // raw
          }
          if (window.api.platform === 'win32') {
            const d = /^\/([A-Za-z]):?(?=\/|$)(.*)$/.exec(p);
            if (d) p = `${d[1]!.toUpperCase()}:${d[2] || '/'}`.replace(/\//g, '\\');
            else if (p.startsWith('//')) p = p.replace(/\//g, '\\');
            else return true;
          }
          shellCwd = p;
          cbRef.current.onCwd?.(p);
        }
        return true;
      }),
      term.parser.registerOscHandler(133, (data) => {
        integrated = true;
        const code = data.split(';')[0];
        if (code === 'B') {
          promptMarker?.dispose();
          promptMarker = term.registerMarker(0);
          promptCol = term.buffer.active.cursorX;
          inputActive = true;
        } else if (code === 'C') {
          inputActive = false;
          showAc(null);
        } else if (code === 'D') {
          inputActive = false;
          showAc(null);
          awaitingIdle = false;
          commandDone();
        } else if (code === 'A') {
          inputActive = false;
        }
        return true;
      }),
    ];

    /** Text typed since the prompt, up to the cursor; null when unknown. */
    const currentInput = (): string | null => {
      if (integrated) {
        if (!inputActive || !promptMarker || promptMarker.isDisposed || promptMarker.line < 0) return null;
        const buf = term.buffer.active;
        const curRow = buf.baseY + buf.cursorY;
        if (curRow < promptMarker.line || curRow - promptMarker.line > 20) return null;
        let text = '';
        for (let row = promptMarker.line; row <= curRow; row++) {
          const line = buf.getLine(row);
          if (!line) return null;
          if (row === curRow) text += line.translateToString(false, 0, buf.cursorX);
          else text += line.translateToString(false);
        }
        return text.slice(promptCol);
      }
      return keyLine.value;
    };

    // ---- git autocomplete ----
    let dismissedFor: string | null = null;
    let ctx: TerminalCompletionContext | null = null;
    void completionContext(init.cwd).then((c) => {
      ctx = c;
      if (!disposed && c.conflict) setConflict(c.conflict);
    });
    let computeRaf = 0;
    const compute = (): void => {
      cancelAnimationFrame(computeRaf);
      computeRaf = requestAnimationFrame(() => {
        if (disposed || !acEnabledRef.current || ctx?.conflict) return showAc(null);
        const line = currentInput();
        if (line === null || !/^\s*\S*\s*git(\.exe)?\s/.test(line) || line === dismissedFor)
          return showAc(null);
        dismissedFor = null;
        const data = cbRef.current.completionData?.() ?? { refs: [], paths: [] };
        const root = initRef.current.repoRoot;
        const paths = root ? pathsFromCwd(data.paths, shellCwd, root) : data.paths;
        const items: CompletionItem[] = suggestGit(line.trimStart(), {
          aliases: ctx?.aliases ?? [],
          refs: data.refs,
          paths,
        });
        if (!items.length) return showAc(null);
        const screen = host.querySelector<HTMLElement>('.xterm-screen');
        const cellW = screen ? screen.clientWidth / term.cols : 8;
        const cellH = screen ? screen.clientHeight / term.rows : 16;
        const buf = term.buffer.active;
        const prev = acRef.current;
        const keep = prev && prev.items.length === items.length ? Math.min(prev.index, items.length - 1) : 0;
        showAc({
          items,
          index: keep,
          x: (screen?.offsetLeft ?? 0) + buf.cursorX * cellW,
          y: (screen?.offsetTop ?? 0) + (buf.cursorY + 1) * cellH,
        });
      });
    };
    acceptRef.current = (i: number) => {
      const s = acRef.current;
      const it = s?.items[i];
      if (!it) return;
      writeRef.current('\x7f'.repeat(it.deleteBefore) + it.insert);
      // keep the keystroke fallback in sync with what was typed
      for (let k = 0; k < it.deleteBefore; k++) keyLine.feed('\x7f');
      if (it.insert) keyLine.feed(it.insert);
      showAc(null);
    };

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      // Autocomplete navigation only while the popup is open (never steals Enter otherwise).
      const open = acEnabledRef.current ? acRef.current : null;
      if (open && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          const n = open.items.length;
          showAc({ ...open, index: (open.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n });
          e.preventDefault();
          return false;
        }
        if (e.key === 'Tab' || e.key === 'Enter') {
          acceptRef.current(open.index);
          e.preventDefault();
          return false;
        }
        if (e.key === 'Escape') {
          dismissedFor = currentInput();
          showAc(null);
          e.preventDefault();
          return false;
        }
      }
      const clip = isMac() ? e.metaKey && !e.ctrlKey : e.ctrlKey && e.shiftKey;
      if (clip && e.code === 'KeyC') {
        if (term.hasSelection()) copyText(term.getSelection());
        e.preventDefault();
        return false;
      }
      if (clip && e.code === 'KeyV') {
        pasteInto(term);
        e.preventDefault();
        return false;
      }
      // Find in terminal: Ctrl+Shift+F (Cmd+F on macOS).
      if (clip && e.code === 'KeyF') {
        setFind((f) => ({ ...f, open: true }));
        requestAnimationFrame(() => findInputRef.current?.select());
        e.preventDefault();
        return false;
      }
      // Let app-level shortcuts (terminal toggle, Cmd+… on macOS) bubble to the keybinding dispatcher.
      if (e.ctrlKey && e.code === 'Backquote') return false;
      if (isMac() && e.metaKey) return false;
      return true;
    });

    // `path:line` links → in-app editor (Ctrl/Cmd+click).
    const linkSub = term.registerLinkProvider({
      provideLinks(y, callback) {
        const root = initRef.current.repoRoot;
        const line = term.buffer.active.getLine(y - 1);
        if (!root || !line) return callback(undefined);
        const text = line.translateToString(true);
        const links = findPathLinks(text).flatMap((l) => {
          const rel = repoRelative(l.path, shellCwd, root);
          if (!rel) return [];
          return [
            {
              range: { start: { x: l.start + 1, y }, end: { x: l.end, y } },
              text: text.slice(l.start, l.end),
              decorations: { underline: true, pointerCursor: true },
              activate: (ev: MouseEvent) => {
                if (ev.ctrlKey || ev.metaKey) cbRef.current.onOpenPath?.(rel, l.line);
              },
            },
          ];
        });
        callback(links.length ? links : undefined);
      },
    });

    const searchSub = search.onDidChangeResults(({ resultIndex, resultCount }) =>
      setFind((f) => ({ ...f, count: resultCount, index: resultIndex })),
    );

    ensureTerminalEvents();
    const requested = { cols: term.cols, rows: term.rows };
    const persistent = !!init.attachId;
    const release = (id: string): void => {
      if (persistent) void terminalInvoke('terminal:detach', { id }).catch(noop);
      else void terminalInvoke('terminal:kill', { id }).catch(noop);
    };
    const started = init.attachId
      ? terminalInvoke('terminal:attach', { id: init.attachId, ...requested })
      : terminalInvoke('terminal:create', {
          cwd: init.cwd,
          ...requested,
          shell: init.shell,
          args: init.args,
          repoPath: init.repoRoot,
          shellIntegration: init.shellIntegration,
        }).then((info) => ({ info, backlog: '' }));
    started.then(
      ({ info, backlog }) => {
        if (disposed) {
          release(info.id);
          return;
        }
        ptyId = info.id;
        shellKindRef.current = shellKindOf(info.shell);
        // Replay what the pty printed while no view was attached, before live output.
        if (backlog) term.write(backlog);
        detach = attachTerminalSink(info.id, {
          data: (d) => {
            if (awaitingIdle && !integrated) {
              if (idleTimer) clearTimeout(idleTimer);
              idleTimer = setTimeout(() => {
                idleTimer = null;
                if (!awaitingIdle) return;
                awaitingIdle = false;
                commandDone();
              }, IDLE_MS);
            }
            term.write(d, () => {
              if (acRef.current || pendingCompute) {
                pendingCompute = false;
                compute();
              }
              acked += d.length;
              if (acked >= ACK_CHUNK) {
                const chars = acked;
                acked = 0;
                void terminalInvoke('terminal:ack', { id: info.id, chars }).catch(noop);
              }
            });
          },
          exit: (exitCode) => {
            ptyId = null;
            term.write(`\r\n\x1b[2m[Process exited with code ${exitCode}]\x1b[0m\r\n`);
            cbRef.current.onExit(exitCode);
          },
        });
        if (term.cols !== requested.cols || term.rows !== requested.rows) {
          void terminalInvoke('terminal:resize', { id: info.id, cols: term.cols, rows: term.rows }).catch(
            noop,
          );
        }
        cbRef.current.onStarted(info);
      },
      (e: unknown) => {
        if (!disposed) cbRef.current.onError(e instanceof Error ? e.message : String(e));
      },
    );

    const send = (data: string): void => {
      if (ptyId) void terminalInvoke('terminal:write', { id: ptyId, data }).catch(noop);
    };
    writeRef.current = send;
    const subs = [
      term.onData((data) => {
        keyLine.feed(data);
        if (data.includes('\r')) {
          showAc(null);
          dismissedFor = null;
          // Idle fallback for shells without OSC 133: refresh once output settles.
          if (!integrated) awaitingIdle = true;
        } else pendingCompute = true;
        send(data);
      }),
      term.onBinary(send),
      term.onResize(({ cols, rows }) => {
        if (ptyId) void terminalInvoke('terminal:resize', { id: ptyId, cols, rows }).catch(noop);
      }),
    ];

    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(doFit);
    });
    ro.observe(host);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      cancelAnimationFrame(computeRaf);
      if (idleTimer) clearTimeout(idleTimer);
      ro.disconnect();
      for (const s of [...subs, ...oscSubs, linkSub, searchSub]) s.dispose();
      promptMarker?.dispose();
      detach();
      if (ptyId) release(ptyId);
      ptyId = null;
      writeRef.current = noop;
      searchRef.current = null;
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  // Live appearance updates (settings / props).
  const { fontFamily, fontSize, lineHeight, cursorStyle, cursorBlink, scrollback } = appearance;
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontFamily = fontFamily || monoFont();
    term.options.fontSize = fontSize;
    term.options.lineHeight = lineHeight;
    term.options.cursorStyle = cursorStyle;
    term.options.cursorBlink = cursorBlink;
    term.options.scrollback = scrollback;
    fitRef.current?.();
  }, [fontFamily, fontSize, lineHeight, cursorStyle, cursorBlink, scrollback]);

  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.theme = buildXtermTheme();
  }, [themeVersion]);

  useEffect(() => {
    if (!active) return;
    const raf = requestAnimationFrame(() => {
      fitRef.current?.();
      termRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [active]);

  const showMenu = useContextMenu((s) => s.show);
  const mod = isMac() ? '⌘' : 'Ctrl+Shift+';
  const dim = useSetting('terminal.dimWhenUnfocused') ?? true;

  const runFind = (dir: 'next' | 'prev', query = find.query): void => {
    const s = searchRef.current;
    if (!s) return;
    if (!query) {
      s.clearDecorations();
      setFind((f) => ({ ...f, count: 0, index: -1 }));
      return;
    }
    const accent = readToken('text-accent') || '#4b9fff';
    const opts = {
      incremental: dir === 'next',
      decorations: {
        matchBackground: '#ffd33d55',
        matchOverviewRuler: '#ffd33d',
        activeMatchBackground: `${accent}99`,
        activeMatchColorOverviewRuler: accent,
      },
    };
    if (dir === 'next') s.findNext(query, opts);
    else s.findPrevious(query, opts);
  };
  const closeFind = (): void => {
    searchRef.current?.clearDecorations();
    setFind({ open: false, query: '', count: 0, index: -1 });
    termRef.current?.focus();
  };

  const insertDropped = (paths: string[]): void => {
    const text = dropText(paths, shellKindRef.current);
    if (text) writeRef.current(text);
    termRef.current?.focus();
  };

  return (
    <div
      className={styles.viewWrap}
      onDragOver={(e) => {
        const types = e.dataTransfer.types;
        if (!types.includes('Files') && !types.includes(WIP_DRAG_MIME)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        setDragOver(false);
        const dt = e.dataTransfer;
        if (dt.types.includes(WIP_DRAG_MIME)) {
          // Commit Panel rows: repo-relative paths in text/plain.
          e.preventDefault();
          e.stopPropagation();
          const root = initRef.current.repoRoot ?? initRef.current.cwd;
          const win = window.api.platform === 'win32' && shellKindRef.current !== 'bash';
          const rel = dt
            .getData('text/plain')
            .split('\n')
            .map((p) => p.trim())
            .filter(Boolean);
          insertDropped(
            rel.map((p) => {
              const abs = joinPath(root, p);
              return win ? abs.replace(/\//g, '\\') : abs;
            }),
          );
          return;
        }
        const paths = droppedPaths(dt);
        if (!paths.length) return;
        e.preventDefault();
        e.stopPropagation();
        insertDropped(paths);
      }}
      data-drag-over={dragOver ? 'true' : undefined}
    >
      <div
        ref={hostRef}
        className={styles.xterm}
        data-dim-unfocused={dim ? 'true' : undefined}
        onContextMenu={(e) => {
          const term = termRef.current;
          if (!term) return;
          e.preventDefault();
          showMenu(e.clientX, e.clientY, [
            {
              label: 'Copy',
              shortcut: `${mod}C`,
              disabled: !term.hasSelection(),
              onSelect: () => copyText(term.getSelection()),
            },
            { label: 'Paste', shortcut: `${mod}V`, onSelect: () => pasteInto(term) },
            'separator',
            { label: 'Select All', onSelect: () => term.selectAll() },
            { label: 'Clear', onSelect: () => term.clear() },
            {
              label: 'Find…',
              shortcut: isMac() ? '⌘F' : 'Ctrl+Shift+F',
              onSelect: () => {
                setFind((f) => ({ ...f, open: true }));
                requestAnimationFrame(() => findInputRef.current?.select());
              },
            },
          ]);
        }}
      />
      {autocomplete && ac && <GitAutocompletePopup state={ac} onPick={(i) => acceptRef.current(i)} />}
      {find.open && (
        <div className={styles.findBar} role="search">
          <input
            ref={findInputRef}
            autoFocus
            aria-label="Find in terminal"
            placeholder="Find"
            value={find.query}
            onChange={(e) => {
              const query = e.target.value;
              setFind((f) => ({ ...f, query }));
              runFind('next', query);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') runFind(e.shiftKey ? 'prev' : 'next');
              else if (e.key === 'Escape') closeFind();
              else return;
              e.preventDefault();
            }}
          />
          <span className={styles.findCount}>
            {find.query ? (find.count ? `${find.index + 1} of ${find.count}` : 'No results') : ''}
          </span>
          <button
            type="button"
            className={styles.iconBtn}
            title="Previous match"
            onClick={() => runFind('prev')}
          >
            <ArrowUp size={13} />
          </button>
          <button type="button" className={styles.iconBtn} title="Next match" onClick={() => runFind('next')}>
            <ArrowDown size={13} />
          </button>
          <button type="button" className={styles.iconBtn} title="Close" onClick={closeFind}>
            <X size={13} />
          </button>
        </div>
      )}
      {autocomplete && conflict && !conflictDismissed && (
        <div className={styles.notice} role="status">
          <span>Git autocomplete is off: {conflict}.</span>
          <button
            type="button"
            className={styles.iconBtn}
            aria-label="Dismiss"
            onClick={() => setConflictDismissed(true)}
          >
            <X size={12} />
          </button>
        </div>
      )}
    </div>
  );
}
