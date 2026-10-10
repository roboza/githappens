import type { MenuItemConstructorOptions } from 'electron';

import type { MenuInvokeEvent, MenuRebuildRequest } from '../../shared/ipc/shell2-contract';
import { chordToAccelerator } from './accelerators';

/**
 * Application menu (spec 01 §4.11) as data. Items reference command ids from the renderer's command
 * registry; labels are fixed here, accelerators and enablement come from the renderer (`menu:rebuild`),
 * so user keybinding overrides and the current context are reflected. Pure: no Electron runtime.
 */

export type MenuNode =
  | {
      kind: 'command';
      commandId: string;
      label: string;
      arg?: string;
      textEdit?: 'undo' | 'redo';
      /** Radio-style mark (active profile). */
      checked?: boolean;
    }
  | { kind: 'role'; role: NonNullable<MenuItemConstructorOptions['role']>; label?: string }
  | { kind: 'separator' }
  | {
      kind: 'submenu';
      label: string;
      items: MenuNode[];
      role?: NonNullable<MenuItemConstructorOptions['role']>;
    };

export interface MenuBuildInput extends MenuRebuildRequest {
  platform: NodeJS.Platform;
  appName: string;
  /** Show View › Toggle Developer Tools (dev builds). */
  devTools: boolean;
}

const cmd = (commandId: string, label: string, extra: Partial<MenuNode> = {}): MenuNode =>
  ({ kind: 'command', commandId, label, ...extra }) as MenuNode;
const sep: MenuNode = { kind: 'separator' };
const role = (r: NonNullable<MenuItemConstructorOptions['role']>, label?: string): MenuNode => ({
  kind: 'role',
  role: r,
  label,
});

export const MAX_RECENT_IN_MENU = 10;

/** The menu tree for a platform (before accelerators / enablement are applied). */
export function buildMenuModel(input: MenuBuildInput): MenuNode[] {
  const mac = input.platform === 'darwin';
  const recent: MenuNode[] = input.recent.length
    ? input.recent.slice(0, MAX_RECENT_IN_MENU).map((r) => cmd('repo.open', r.label, { arg: r.path }))
    : [{ kind: 'command', commandId: 'repoMgmt.show', label: 'No Recent Repositories' }];
  const profiles: MenuNode[] = input.profiles.length
    ? input.profiles.map((p) => cmd('profile.switch', p.name, { arg: p.id, checked: p.active }))
    : [cmd('profile.switch', 'Switch Profile…')];

  const appMenu: MenuNode = {
    kind: 'submenu',
    label: input.appName,
    role: 'appMenu',
    items: [
      cmd('app.about', `About ${input.appName}`),
      cmd('app.checkForUpdates', 'Check for Updates…'),
      sep,
      cmd('prefs.open', 'Settings…'),
      sep,
      role('services'),
      sep,
      role('hide'),
      role('hideOthers'),
      role('unhide'),
      sep,
      role('quit'),
    ],
  };

  const file: MenuNode = {
    kind: 'submenu',
    label: mac ? 'File' : '&File',
    role: 'fileMenu',
    items: [
      cmd('tab.new', 'New Tab'),
      cmd('repo.openFolder', 'Open Repo…'),
      cmd('repoMgmt.clone', 'Clone Repo…'),
      cmd('repoMgmt.init', 'Init Repo…'),
      { kind: 'submenu', label: 'Open Recent', items: recent },
      cmd('repoMgmt.show', 'Repo Management'),
      sep,
      cmd('repo.openInTerminal', 'Open in Terminal'),
      cmd('repo.openInFileManager', 'Open in File Manager'),
      cmd('repo.openInExternalEditor', 'Open in External Editor'),
      sep,
      ...(mac ? [] : [cmd('prefs.open', 'Preferences…')]),
      { kind: 'submenu', label: 'Switch Profile', items: profiles },
      sep,
      cmd('repo.closeTab', 'Close Tab'),
      ...(mac ? [role('close', 'Close Window')] : [role('quit', 'Exit')]),
    ],
  };

  const edit: MenuNode = {
    kind: 'submenu',
    label: mac ? 'Edit' : '&Edit',
    role: 'editMenu',
    items: [
      cmd('core.undo', 'Undo', { textEdit: 'undo' }),
      cmd('core.redo', 'Redo', { textEdit: 'redo' }),
      sep,
      role('cut'),
      role('copy'),
      role('paste'),
      role('selectAll'),
      sep,
      cmd('history.searchCommits', 'Find Commits…'),
      cmd('finder.files', 'Go to File…'),
    ],
  };

  const view: MenuNode = {
    kind: 'submenu',
    label: mac ? 'View' : '&View',
    role: 'viewMenu',
    items: [
      cmd('palette.toggle', 'Command Palette'),
      sep,
      cmd('view.toggleLeftPanel', 'Toggle Left Panel'),
      cmd('view.toggleRightPanel', 'Toggle Commit Detail'),
      cmd('view.toggleTerminal', 'Toggle Terminal'),
      sep,
      cmd('view.zoomIn', 'Zoom In'),
      cmd('view.zoomOut', 'Zoom Out'),
      cmd('view.zoomReset', 'Reset Zoom'),
      sep,
      cmd('view.toggleTheme', 'Toggle Theme'),
      cmd('view.fullscreen', 'Toggle Full Screen'),
      ...(input.devTools ? [sep, role('toggleDevTools'), role('reload')] : []),
    ],
  };

  const repo: MenuNode = {
    kind: 'submenu',
    label: mac ? 'Repository' : '&Repository',
    items: [
      cmd('remote.fetchAll', 'Fetch All'),
      cmd('remote.pull', 'Pull'),
      cmd('remote.push', 'Push'),
      sep,
      cmd('branch.create', 'Create Branch'),
      cmd('stash.create', 'Stash'),
      cmd('stash.popLatest', 'Pop Stash'),
      sep,
      {
        kind: 'submenu',
        label: 'Git Flow',
        items: [
          cmd('gitflow.configure', 'Configure Git Flow…'),
          sep,
          cmd('gitflow.start.feature', 'Start Feature'),
          cmd('gitflow.start.release', 'Start Release'),
          cmd('gitflow.start.hotfix', 'Start Hotfix'),
          cmd('gitflow.start.bugfix', 'Start Bugfix'),
          cmd('gitflow.start.support', 'Start Support'),
          sep,
          cmd('gitflow.reset', 'Reset Git Flow…'),
        ],
      },
      {
        kind: 'submenu',
        label: 'LFS',
        items: [cmd('lfs.init', 'Initialize LFS'), cmd('lfs.configure', 'Configure LFS…')],
      },
      sep,
      cmd('repo.maintenance', 'Perform Repo Maintenance'),
      cmd('repo.settings', 'Repository Settings…'),
    ],
  };

  const help: MenuNode = {
    kind: 'submenu',
    label: mac ? 'Help' : '&Help',
    role: 'help',
    items: [
      cmd('view.shortcuts', 'Keyboard Shortcuts'),
      cmd('palette.toggle', 'Command Palette'),
      sep,
      cmd('app.releaseNotes', 'Release Notes'),
      cmd('logs.open', 'Support Logs'),
      cmd('app.installCli', 'Install "githappens" Command in PATH…'),
      ...(mac ? [] : [sep, cmd('app.checkForUpdates', 'Check for Updates…'), cmd('app.about', 'About')]),
    ],
  };

  return [...(mac ? [appMenu] : []), file, edit, view, repo, help];
}

/**
 * Electron template from the model. Accelerators are display-only on Windows/Linux
 * (`registerAccelerator: false`): the renderer's dispatcher owns the keys, so `!textInputFocus` rules and
 * deferred bindings keep working and nothing fires twice. Unregistered commands render disabled.
 */
export function toElectronTemplate(
  model: readonly MenuNode[],
  input: Pick<MenuBuildInput, 'accelerators' | 'enabled' | 'platform'>,
  invoke: (e: MenuInvokeEvent) => void,
): MenuItemConstructorOptions[] {
  const mac = input.platform === 'darwin';
  const convert = (n: MenuNode): MenuItemConstructorOptions => {
    switch (n.kind) {
      case 'separator':
        return { type: 'separator' };
      case 'role':
        return n.label ? { role: n.role, label: n.label } : { role: n.role };
      case 'submenu':
        // Our own items, not the role's defaults (the role only documents intent / mac naming).
        return { label: n.label, submenu: compactSeparators(n.items).map(convert) };
      case 'command': {
        const chord = n.arg === undefined ? input.accelerators[n.commandId] : undefined;
        const accelerator = chord ? chordToAccelerator(chord, mac) : undefined;
        const enabled = input.enabled[n.commandId] === true;
        const item: MenuItemConstructorOptions = {
          label: n.label,
          enabled,
          click: () =>
            invoke({
              commandId: n.commandId,
              ...(n.arg !== undefined ? { arg: n.arg } : {}),
              ...(n.textEdit ? { textEdit: n.textEdit } : {}),
            }),
        };
        if (n.checked !== undefined) {
          item.type = 'checkbox';
          item.checked = n.checked;
        }
        if (accelerator) {
          item.accelerator = accelerator;
          if (!mac) item.registerAccelerator = false;
        }
        return item;
      }
    }
  };
  return compactSeparators(model).map(convert);
}

/** Drop leading / trailing / doubled separators (left behind by platform-conditional items). */
export function compactSeparators(items: readonly MenuNode[]): MenuNode[] {
  const out: MenuNode[] = [];
  for (const n of items) {
    if (n.kind === 'separator' && (out.length === 0 || out[out.length - 1]!.kind === 'separator')) continue;
    out.push(n);
  }
  while (out.length && out[out.length - 1]!.kind === 'separator') out.pop();
  return out;
}

/** Every command id the menu references (renderer uses it to know which enablement to report). */
export function menuCommandIds(model: readonly MenuNode[]): string[] {
  const ids = new Set<string>();
  const walk = (ns: readonly MenuNode[]): void => {
    for (const n of ns) {
      if (n.kind === 'command') ids.add(n.commandId);
      else if (n.kind === 'submenu') walk(n.items);
    }
  };
  walk(model);
  return [...ids];
}
