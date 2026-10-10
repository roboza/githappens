import type { QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import type { MenuInvokeEvent, MenuRebuildRequest } from '../../../shared/ipc/shell2-contract';
import {
  getCommand,
  getCommands,
  getContext,
  isCommandEnabled,
  runCommand,
  useCommandRegistry,
} from '../commands';
import { useKeybindingsStore } from '../commands/keybindings-store';
import { disabledReason } from '../commands/registry';
import { invoke, on } from '../lib/api';
import { prefsInvoke, prefsOn } from '../stores/settings';
import { useTabsStore } from '../stores/tabs';
import { useToastStore } from '../stores/toasts';
import { menuState } from './menu-state';
import { shellInvoke, shellOn } from './shell2-api';

/**
 * Renderer half of the native application menu (spec 01 §4.11, §7.7): pushes accelerators (from the
 * keybinding service, so user overrides show), enablement (from command `when` in the current context),
 * recent repositories and profiles to main via `menu:rebuild`, and runs `menu:invoke` clicks through the
 * command registry.
 */

const isTextTarget = (el: Element | null): boolean =>
  el instanceof HTMLElement &&
  (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || !!el.closest('.monaco-editor'));

let recent: MenuRebuildRequest['recent'] = [];
let profiles: MenuRebuildRequest['profiles'] = [];

async function refreshLists(): Promise<void> {
  const [repos, prof] = await Promise.all([
    invoke('repos:list', {}).catch(() => []),
    prefsInvoke('profiles:list', {}).catch(() => null),
  ]);
  recent = repos
    .filter((r) => !r.missing)
    .sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0))
    .slice(0, 10)
    .map((r) => ({ path: r.path, label: r.alias ?? r.name }));
  profiles = prof
    ? prof.profiles.map((p) => ({ id: p.id, name: p.name, active: p.id === prof.activeId }))
    : [];
}

function sendRebuild(): void {
  const ctx = getContext();
  const commands = getCommands();
  const state = menuState(commands, useKeybindingsStore.getState().resolved, (id) => {
    const c = getCommand(id);
    return !!c && isCommandEnabled(c, ctx);
  });
  shellInvoke('menu:rebuild', { ...state, recent, profiles }).catch(() => undefined);
}

export function handleMenuInvoke(e: MenuInvokeEvent): void {
  if (e.textEdit && isTextTarget(document.activeElement)) {
    // Edit › Undo/Redo inside a text field edits the text, not the repository.
    document.execCommand(e.textEdit);
    return;
  }
  runCommand(e.commandId, e.arg).then(
    (res) => {
      if (res === 'disabled') {
        const c = getCommand(e.commandId);
        useToastStore.getState().push({
          kind: 'warning',
          title: `${c?.title ?? e.commandId} is unavailable`,
          body: c ? disabledReason(c) : undefined,
        });
      } else if (res === 'notFound') {
        useToastStore.getState().push({ kind: 'warning', title: `"${e.commandId}" is not available here` });
      }
    },
    (err: unknown) =>
      useToastStore.getState().push({
        kind: 'error',
        title: `${getCommand(e.commandId)?.title ?? e.commandId} failed`,
        body: err instanceof Error ? err.message : String(err),
      }),
  );
}

/** Mount once (from `useShortcuts`). */
export function useMenuBridge(qc: QueryClient): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = (delay = 250): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(sendRebuild, delay);
    };
    let listTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleLists = (): void => {
      if (listTimer) clearTimeout(listTimer);
      listTimer = setTimeout(() => void refreshLists().then(() => schedule(0)), 400);
    };
    scheduleLists();
    const offs = [
      shellOn('menu:invoke', handleMenuInvoke),
      useCommandRegistry.subscribe(() => schedule()),
      useKeybindingsStore.subscribe(() => schedule()),
      useTabsStore.subscribe((s, p) => {
        if (s.activeTabId !== p.activeTabId) schedule();
        if (s.tabs !== p.tabs) scheduleLists();
      }),
      // Context (`hasWip`, `hasStashes`, LFS / Git Flow state…) comes from the query cache.
      qc.getQueryCache().subscribe((ev) => {
        if (ev.type === 'updated' && ev.action.type === 'success') schedule(600);
      }),
      prefsOn('profiles:changed', scheduleLists),
      prefsOn('profiles:switched', scheduleLists),
      on('git:repo:changed', () => schedule(600)),
    ];
    return () => {
      if (timer) clearTimeout(timer);
      if (listTimer) clearTimeout(listTimer);
      offs.forEach((off) => off());
    };
  }, [qc]);

  // Windows/Linux: the custom title bar hides the menu bar; a lone Alt press pops the menu up.
  useEffect(() => {
    if (window.api.platform === 'darwin') return;
    let armed = false;
    const down = (e: KeyboardEvent): void => {
      armed = e.key === 'Alt' && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.repeat;
    };
    const up = (e: KeyboardEvent): void => {
      if (e.key === 'Alt' && armed && !e.defaultPrevented) {
        armed = false;
        shellInvoke('menu:popup', { x: 8, y: 36 }).catch(() => undefined);
      }
      armed = false;
    };
    const disarm = (): void => {
      armed = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('mousedown', disarm, true);
    window.addEventListener('blur', disarm);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('mousedown', disarm, true);
      window.removeEventListener('blur', disarm);
    };
  }, []);
}
