import '@xterm/xterm/css/xterm.css';

import type { RefInfo, RepoId, StatusResult } from '@githappens/git/types';
import { useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Bot,
  ChevronDown,
  Maximize2,
  Minimize2,
  Plus,
  SquareTerminal,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type MouseEvent } from 'react';

import type { TerminalInfo, TerminalShell } from '../../../../shared/ipc/terminal-contract';
import { useContextMenu, type MenuEntry } from '../../components/ContextMenu';
import { invoke } from '../../lib/api';
import { qk, refreshScopes } from '../../repo/queries';
import { useRepoUiStore } from '../../stores/repo-ui';
import { useSetting, useSettingsStore } from '../../stores/settings';
import { getThemeVersion, subscribeTheme } from '../../theme/builtin';
import styles from './TerminalPanel.module.css';
import { rootKey, useTerminalStore, type BoundSession, type FocusRequest } from './terminal-store';
import { terminalInvoke } from './terminal-api';
import { TerminalView, type CompletionData, type TerminalAppearance } from './TerminalView';

export interface TerminalPanelProps {
  /** Repo / worktree root; new tabs start here. */
  cwd: string;
  /** Repo of the panel: post-command refresh, autocomplete refs / paths, `path:line` links. */
  repoId?: RepoId;
  /** Hidden panels keep their sessions alive. */
  visible: boolean;
  /** Close (hide) the dock — e.g. the × button or closing the last tab. */
  onClose(): void;
  /** Dock height in px; omit to fill the parent. */
  height?: number;
  /** Called while dragging the top edge (only when `height` is given). */
  onHeightChange?(height: number): void;
  /** Overrides for the In-App Terminal settings (spec 13). */
  shell?: string;
  shellArgs?: string[];
  fontFamily?: string;
  fontSize?: number;
  lineHeight?: number;
  cursorStyle?: TerminalAppearance['cursorStyle'];
  cursorBlink?: boolean;
  scrollback?: number;
}

interface Tab {
  key: string;
  cwd: string;
  shell?: string;
  args?: string[];
  /** Requested shell label until the pty reports its real name. */
  label: string;
  /** Agent session pty this tab is bound to (survives the panel; killed only on close). */
  attachId?: string;
  info?: TerminalInfo;
  error?: string;
  exitCode?: number;
  /** Last cwd reported by the shell (OSC 7); new tabs inherit it. */
  currentCwd?: string;
}

interface ShellOption {
  label: string;
  shell?: string;
  args?: string[];
}

let tabSeq = 0;
function makeTab(cwd: string, opt: ShellOption): Tab {
  return { key: `tab-${++tabSeq}`, cwd, shell: opt.shell, args: opt.args, label: opt.label };
}
function makeAgentTab(b: BoundSession): Tab {
  return { key: `tab-${++tabSeq}`, cwd: b.cwd, label: b.label, attachId: b.ptyId };
}

const tabPtyId = (t: Tab): string | undefined => t.attachId ?? t.info?.id;

/** Applies pending focus requests for `root` to a tab list (adding tabs for bound agent ptys). */
function applyFocusRequests(
  tabs: Tab[],
  requests: FocusRequest[],
  root: string,
  bound: BoundSession[],
): { tabs: Tab[]; select: string | null; seqs: number[] } {
  const mine = requests.filter((r) => r.root === root);
  let next = tabs;
  let select: string | null = null;
  for (const r of mine) {
    let t = next.find((x) => tabPtyId(x) === r.ptyId);
    if (!t) {
      const b = bound.find((x) => x.ptyId === r.ptyId);
      if (!b) continue;
      t = makeAgentTab(b);
      next = [...next, t];
    }
    select = t.key;
  }
  return { tabs: next, select, seqs: mine.map((r) => r.seq) };
}

/** Detected shells (`terminal:listShells`), fetched once per window. */
let shellsPromise: Promise<TerminalShell[]> | null = null;
function detectedShells(): Promise<TerminalShell[]> {
  shellsPromise ??= terminalInvoke('terminal:listShells', {}).catch(() => {
    shellsPromise = null;
    return [];
  });
  return shellsPromise;
}

function shellOptions(): ShellOption[] {
  const def: ShellOption = { label: 'Default shell' };
  if (window.api.platform === 'win32') {
    return [
      def,
      { label: 'PowerShell', shell: 'powershell.exe' },
      { label: 'Command Prompt', shell: 'cmd.exe' },
      { label: 'Git Bash', shell: 'C:\\Program Files\\Git\\bin\\bash.exe' },
      { label: 'WSL', shell: 'wsl.exe' },
    ];
  }
  return [
    def,
    { label: 'bash', shell: '/bin/bash' },
    { label: 'zsh', shell: '/bin/zsh' },
    { label: 'sh', shell: '/bin/sh' },
  ];
}

const baseName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/** Reads a setting that may not be registered yet (keys are added by spec 13 work). */
function useOptionalSetting<T>(key: string, guard: (v: unknown) => v is T): T | undefined {
  const v = useSettingsStore((s) => (s.values as Record<string, unknown> | null)?.[key]);
  return guard(v) ? v : undefined;
}
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isCursor = (v: unknown): v is TerminalAppearance['cursorStyle'] =>
  v === 'block' || v === 'underline' || v === 'bar';
const isArgs = (v: unknown): v is string[] => Array.isArray(v) && v.every((a) => typeof a === 'string');

/** Integrated terminal bottom dock (spec 12 §4.2): tabs of xterm.js views backed by main-process ptys. */
export function TerminalPanel(props: TerminalPanelProps) {
  const { cwd, visible, onClose, height, onHeightChange, repoId } = props;
  const qc = useQueryClient();
  const [maximized, setMaximized] = useState(false);
  const sAutocomplete = useSetting('terminal.autocomplete') ?? true;
  const sIntegration = useSetting('terminal.shellIntegration') ?? true;

  const settingFontSize = useSetting('terminal.fontSize');
  const sFontFamily = useOptionalSetting('terminal.fontFamily', isStr);
  const sLineHeight = useOptionalSetting('terminal.lineHeight', isNum);
  const sCursorStyle = useOptionalSetting('terminal.cursorStyle', isCursor);
  const sCursorBlink = useOptionalSetting('terminal.cursorBlink', isBool);
  const sScrollback = useOptionalSetting('terminal.scrollback', isNum);
  const sShell = useOptionalSetting('terminal.shell', isStr);
  const sShellArgs = useOptionalSetting('terminal.shellArgs', isArgs);

  const appearance: TerminalAppearance = {
    fontFamily: props.fontFamily ?? sFontFamily,
    fontSize: props.fontSize ?? settingFontSize ?? 12,
    lineHeight: props.lineHeight ?? sLineHeight ?? 1.2,
    cursorStyle: props.cursorStyle ?? sCursorStyle ?? 'block',
    cursorBlink: props.cursorBlink ?? sCursorBlink ?? true,
    scrollback: props.scrollback ?? sScrollback ?? 5000,
  };
  const defaultShell: ShellOption = {
    label: 'Default shell',
    shell: props.shell ?? sShell,
    args: props.shellArgs ?? sShellArgs,
  };

  const themeVersion = useSyncExternalStore(subscribeTheme, getThemeVersion);

  const root = rootKey(cwd);
  const requests = useTerminalStore((s) => s.requests);
  const hasRequest = requests.some((r) => r.root === root);

  // Agent sessions bound to this root survive the panel (repo tab switches): re-attach them,
  // honouring focus requests that were made before the panel mounted.
  const [initial] = useState(() => {
    const st = useTerminalStore.getState();
    const bound = (st.bound[root] ?? []).map(makeAgentTab);
    const start = bound.length || hasRequest || !visible ? bound : [makeTab(cwd, defaultShell)];
    return applyFocusRequests(start, st.requests, root, st.bound[root] ?? []);
  });
  const [tabs, setTabs] = useState<Tab[]>(initial.tabs);
  const [activeKey, setActiveKey] = useState<string | null>(() => initial.select ?? tabs[0]?.key ?? null);
  const tabsRef = useRef(tabs);
  useEffect(() => {
    tabsRef.current = tabs;
  });

  // Opening the dock with no tabs creates the first one (adjusting state during render),
  // unless it was opened to show an agent session.
  const [wasVisible, setWasVisible] = useState(visible);
  if (visible !== wasVisible) {
    setWasVisible(visible);
    if (visible && tabs.length === 0 && !hasRequest) {
      const t = makeTab(cwd, defaultShell);
      setTabs([t]);
      setActiveKey(t.key);
    }
  }

  const active = tabs.find((t) => t.key === activeKey) ?? tabs[tabs.length - 1];

  const addTab = (opt: ShellOption = defaultShell, at?: string): void => {
    // New tabs inherit the active tab's current folder (OSC 7), else the repo root.
    const t = makeTab(at ?? active?.currentCwd ?? cwd, opt);
    setTabs((ts) => [...ts, t]);
    setActiveKey(t.key);
  };

  // `terminal.newTab` (Ctrl+Shift+`, spec 12 §4.11) adds a tab to the visible panel.
  const addTabRef = useRef(addTab);
  useEffect(() => {
    addTabRef.current = addTab;
  });
  useEffect(() => {
    if (!visible) return;
    const onNew = (): void => addTabRef.current();
    window.addEventListener('kl:terminal-new-tab', onNew);
    return () => window.removeEventListener('kl:terminal-new-tab', onNew);
  }, [visible]);

  // Focus requests from the Agents view: select the tab of that pty, adding agent tabs as needed.
  useEffect(() => {
    const handle = (): void => {
      const st = useTerminalStore.getState();
      const r = applyFocusRequests(tabsRef.current, st.requests, root, st.bound[root] ?? []);
      if (!r.seqs.length) return;
      st.consume(r.seqs);
      if (r.tabs !== tabsRef.current) {
        tabsRef.current = r.tabs;
        setTabs(r.tabs);
      }
      if (r.select) setActiveKey(r.select);
    };
    // Requests applied by the initial state only need consuming.
    useTerminalStore.getState().consume(initial.seqs);
    return useTerminalStore.subscribe((st, prev) => {
      if (st.requests !== prev.requests) handle();
    });
  }, [root, initial]);

  // "Open in terminal" requests (worktree rows, agents view): a new shell tab in that folder.
  useEffect(() => {
    const handle = (): void => {
      const st = useTerminalStore.getState();
      const mine = st.shellRequests.filter((r) => r.root === root);
      if (!mine.length) return;
      st.consumeShell(mine.map((r) => r.seq));
      for (const r of mine) addTabRef.current(undefined, r.cwd);
    };
    handle();
    return useTerminalStore.subscribe((st, prev) => {
      if (st.shellRequests !== prev.shellRequests) handle();
    });
  }, [root]);

  // Post-command refresh (OSC 133;D or idle fallback), coalesced.
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    },
    [],
  );
  const onCommandDone = useCallback(() => {
    if (!repoId || refreshTimer.current) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      refreshScopes(qc, repoId, ['status', 'refs', 'stash', 'repoState', 'worktrees', 'conflicts']);
    }, 150);
  }, [qc, repoId]);

  const onOpenPath = useCallback(
    (path: string) => {
      if (!repoId) return;
      useRepoUiStore.getState().update(repoId, () => ({ center: { kind: 'file', path, mode: 'edit' } }));
      setMaximized(false);
    },
    [repoId],
  );

  // Autocomplete data: refs + changed paths from the query cache, then the tracked file list.
  const filesRef = useRef<{ at: number; files: string[] } | null>(null);
  const completionData = useCallback((): CompletionData => {
    if (!repoId) return { refs: [], paths: [] };
    const refs = (qc.getQueryData<RefInfo[]>(qk.refs(repoId)) ?? [])
      .filter((r) => r.type === 'local' || r.type === 'remote' || r.type === 'tag')
      .map((r) => r.shortName)
      .filter((n) => !n.endsWith('/HEAD'));
    const changed = (qc.getQueryData<StatusResult>(qk.status(repoId))?.entries ?? [])
      .filter((e) => e.kind !== 'ignored')
      .map((e) => e.path);
    const f = filesRef.current;
    if (!f || Date.now() - f.at > 30_000) {
      filesRef.current = { at: Date.now(), files: f?.files ?? [] };
      void invoke('files:list', { repoId })
        .then((files) => (filesRef.current = { at: Date.now(), files }))
        .catch(() => undefined);
    }
    const seen = new Set(changed);
    return { refs, paths: [...changed, ...(filesRef.current?.files ?? []).filter((p) => !seen.has(p))] };
  }, [qc, repoId]);

  const closeTab = (key: string): void => {
    const i = tabs.findIndex((t) => t.key === key);
    if (i < 0) return;
    const closing = tabs[i]!;
    if (closing.attachId) {
      // Agent tabs only detach on unmount; closing the tab ends the session.
      useTerminalStore.getState().unbind(closing.attachId);
      void terminalInvoke('terminal:kill', { id: closing.attachId }).catch(() => undefined);
    }
    const next = tabs.filter((t) => t.key !== key);
    setTabs(next);
    if (active?.key === key) setActiveKey(next[Math.min(i, next.length - 1)]?.key ?? null);
    if (next.length === 0) onClose();
  };

  const patchTab = useCallback((key: string, patch: Partial<Tab>) => {
    setTabs((ts) => ts.map((t) => (t.key === key ? { ...t, ...patch } : t)));
  }, []);

  const showMenu = useContextMenu((s) => s.show);
  const openShellMenu = (e: MouseEvent<HTMLButtonElement>): void => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = r.left;
    const y = r.bottom + 2;
    void detectedShells().then((shells) => {
      const opts: ShellOption[] = shells.length
        ? [
            { label: 'Default shell' },
            ...shells.map((sh) => ({ label: sh.name, shell: sh.path, args: sh.args })),
          ]
        : shellOptions();
      const items: MenuEntry[] = opts.map((o) =>
        o.shell === undefined
          ? { label: o.label, onSelect: () => addTab() }
          : { label: o.label, onSelect: () => addTab(o) },
      );
      showMenu(x, y, items);
    });
  };

  const dragStart = useRef<{ y: number; h: number } | null>(null);

  return (
    <section
      className={`${styles.panel} ${maximized ? styles.panelMax : ''}`}
      style={{ display: visible ? undefined : 'none', height: maximized ? undefined : height }}
      aria-label="Terminal"
      aria-hidden={!visible}
    >
      {height !== undefined && onHeightChange && !maximized && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize terminal"
          className={styles.resizer}
          onPointerDown={(e) => {
            dragStart.current = { y: e.clientY, h: height };
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (!dragStart.current) return;
            const max = Math.max(160, window.innerHeight * 0.8);
            onHeightChange(
              Math.round(
                Math.max(120, Math.min(max, dragStart.current.h - (e.clientY - dragStart.current.y))),
              ),
            );
          }}
          onPointerUp={() => (dragStart.current = null)}
        />
      )}
      <header className={styles.header}>
        <div className={styles.tabs} role="tablist">
          {tabs.map((t) => (
            <div
              key={t.key}
              role="tab"
              aria-selected={t === active}
              tabIndex={0}
              className={`${styles.tab} ${t === active ? styles.tabActive : ''}`}
              title={t.info ? `${t.info.shell} — ${t.info.cwd}` : t.cwd}
              onClick={() => setActiveKey(t.key)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') setActiveKey(t.key);
              }}
              onAuxClick={(e) => {
                if (e.button === 1) closeTab(t.key);
              }}
            >
              {t.error ? (
                <AlertTriangle size={13} />
              ) : t.attachId ? (
                <Bot size={13} />
              ) : (
                <SquareTerminal size={13} />
              )}
              <span className={styles.tabLabel}>
                {t.attachId
                  ? (t.info?.label ?? t.label)
                  : `${t.info?.shellName ?? t.label} — ${baseName(t.info?.cwd ?? t.cwd)}`}
                {t.exitCode !== undefined && ' (exited)'}
              </span>
              <button
                type="button"
                className={styles.tabClose}
                aria-label="Close terminal"
                title="Kill terminal"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(t.key);
                }}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.iconBtn}
            title="New terminal"
            aria-label="New terminal"
            onClick={() => addTab()}
          >
            <Plus size={14} />
          </button>
          <button
            type="button"
            className={styles.iconBtn}
            title="New terminal with shell…"
            aria-label="Choose shell"
            onClick={openShellMenu}
          >
            <ChevronDown size={14} />
          </button>
          <button
            type="button"
            className={styles.iconBtn}
            title="Kill active terminal"
            aria-label="Kill active terminal"
            disabled={!active}
            onClick={() => active && closeTab(active.key)}
          >
            <Trash2 size={14} />
          </button>
          <button
            type="button"
            className={styles.iconBtn}
            title={maximized ? 'Restore terminal size' : 'Maximize terminal'}
            aria-label={maximized ? 'Restore terminal size' : 'Maximize terminal'}
            aria-pressed={maximized}
            onClick={() => setMaximized((m) => !m)}
          >
            {maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
          <button
            type="button"
            className={styles.iconBtn}
            title="Hide terminal"
            aria-label="Hide terminal"
            onClick={onClose}
          >
            <X size={14} />
          </button>
        </div>
      </header>
      <div className={styles.body}>
        {tabs.length === 0 && (
          <div className={styles.empty}>
            <button type="button" onClick={() => addTab()}>
              <Plus size={14} /> New terminal
            </button>
          </div>
        )}
        {tabs.map((t) => (
          <div key={t.key} className={styles.pane} style={{ display: t === active ? undefined : 'none' }}>
            {t.error ? (
              <div className={styles.error} role="alert">
                <AlertTriangle size={16} />
                <span>{t.error}</span>
              </div>
            ) : (
              <TerminalView
                cwd={t.cwd}
                shell={t.shell}
                args={t.args}
                attachId={t.attachId}
                active={visible && t === active}
                appearance={appearance}
                themeVersion={themeVersion}
                repoRoot={cwd}
                shellIntegration={sIntegration}
                autocomplete={sAutocomplete}
                completionData={completionData}
                onCwd={(currentCwd) => patchTab(t.key, { currentCwd })}
                onCommandDone={onCommandDone}
                onOpenPath={onOpenPath}
                onStarted={(info) => patchTab(t.key, { info })}
                onError={(error) =>
                  patchTab(t.key, {
                    error:
                      t.attachId && /Unknown terminal/.test(error) ? 'This agent session has ended.' : error,
                  })
                }
                onExit={(exitCode) =>
                  // Agent tabs stay open so the final output can be read.
                  exitCode === 0 && !t.attachId ? closeTab(t.key) : patchTab(t.key, { exitCode })
                }
              />
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
