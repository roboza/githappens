import { describe, expect, it, vi } from 'vitest';

import { chordToAccelerator } from '../src/main/menu/accelerators';
import {
  buildMenuModel,
  compactSeparators,
  menuCommandIds,
  toElectronTemplate,
  type MenuBuildInput,
  type MenuNode,
} from '../src/main/menu/menu-template';
import { DEFAULT_KEYBINDINGS, resolveKeybindings } from '../src/renderer/src/commands/keybindings';
import { menuState } from '../src/renderer/src/shell/menu-state';

type Item = Electron.MenuItemConstructorOptions;

const base = (platform: NodeJS.Platform, extra: Partial<MenuBuildInput> = {}): MenuBuildInput => ({
  platform,
  appName: 'GitHappens',
  devTools: false,
  accelerators: {},
  enabled: {},
  recent: [],
  profiles: [],
  ...extra,
});

function find(items: Item[], label: string): Item | undefined {
  for (const i of items) {
    if (i.label === label) return i;
    if (Array.isArray(i.submenu)) {
      const hit = find(i.submenu, label);
      if (hit) return hit;
    }
  }
  return undefined;
}

describe('chord → Electron accelerator (spec 01 §4.11)', () => {
  it('maps modifiers per platform and named keys', () => {
    expect(chordToAccelerator('ctrl+shift+s', false)).toBe('Ctrl+Shift+S');
    expect(chordToAccelerator('meta+alt+1', true)).toBe('Cmd+Option+1');
    expect(chordToAccelerator('ctrl+meta+f', true)).toBe('Ctrl+Cmd+F');
    expect(chordToAccelerator('meta+p', false)).toBe('Super+P');
    expect(chordToAccelerator('ctrl+`', false)).toBe('Ctrl+`');
    expect(chordToAccelerator('ctrl+=', false)).toBe('Ctrl+=');
    expect(chordToAccelerator('ctrl+numpadadd', false)).toBe('Ctrl+numadd');
    expect(chordToAccelerator('f11', false)).toBe('F11');
    expect(chordToAccelerator('shift+f6', false)).toBe('Shift+F6');
    expect(chordToAccelerator('escape', false)).toBe('Esc');
    expect(chordToAccelerator('ctrl+enter', false)).toBe('Ctrl+Enter');
    expect(chordToAccelerator('ctrl+up', false)).toBe('Ctrl+Up');
  });

  it('rejects what it cannot express', () => {
    expect(chordToAccelerator('', false)).toBeUndefined();
    expect(chordToAccelerator('ctrl+mouse4', false)).toBeUndefined();
    expect(chordToAccelerator('hyper+a', false)).toBeUndefined();
  });
});

describe('menu model', () => {
  it('has the mac app menu only on macOS; Preferences/Exit live in File elsewhere', () => {
    const mac = buildMenuModel(base('darwin'));
    const win = buildMenuModel(base('win32'));
    expect(mac.map((m) => (m.kind === 'submenu' ? m.label : m.kind))).toEqual([
      'GitHappens',
      'File',
      'Edit',
      'View',
      'Repository',
      'Help',
    ]);
    expect(win.map((m) => (m.kind === 'submenu' ? m.label : m.kind))).toEqual([
      '&File',
      '&Edit',
      '&View',
      '&Repository',
      '&Help',
    ]);
    const winIds = menuCommandIds(win);
    expect(winIds).toContain('prefs.open');
    const winFile = win[0] as Extract<MenuNode, { kind: 'submenu' }>;
    expect(winFile.items.some((n) => n.kind === 'role' && n.role === 'quit')).toBe(true);
    const macFile = mac[1] as Extract<MenuNode, { kind: 'submenu' }>;
    expect(macFile.items.some((n) => n.kind === 'command' && n.commandId === 'prefs.open')).toBe(false);
  });

  it('lists recent repositories (max 10) and profiles as arg commands', () => {
    const recent = Array.from({ length: 12 }, (_, i) => ({ path: `/r/${i}`, label: `repo${i}` }));
    const model = buildMenuModel(
      base('linux', {
        recent,
        profiles: [
          { id: 'a', name: 'Work', active: true },
          { id: 'b', name: 'Home', active: false },
        ],
      }),
    );
    const tpl = toElectronTemplate(model, base('linux', { enabled: { 'repo.open': true } }), () => undefined);
    const openRecent = find(tpl, 'Open Recent')!;
    expect((openRecent.submenu as Item[]).map((i) => i.label)).toEqual(
      recent.slice(0, 10).map((r) => r.label),
    );
    const work = find(tpl, 'Work')!;
    expect(work.type).toBe('checkbox');
    expect(work.checked).toBe(true);
    expect(find(tpl, 'Home')!.checked).toBe(false);
  });

  it('drops doubled / dangling separators', () => {
    const s: MenuNode = { kind: 'separator' };
    const c: MenuNode = { kind: 'command', commandId: 'x', label: 'X' };
    expect(compactSeparators([s, c, s, s, c, s])).toEqual([c, s, c]);
  });
});

describe('Electron template from the registry (accelerators + enablement)', () => {
  const resolvedWin = resolveKeybindings(DEFAULT_KEYBINDINGS, [], false);
  const resolvedMac = resolveKeybindings(DEFAULT_KEYBINDINGS, [], true);
  const registered = [
    'tab.new',
    'repo.closeTab',
    'palette.toggle',
    'view.fullscreen',
    'view.toggleTerminal',
    'core.undo',
    'remote.push',
  ].map((id) => ({ id }));

  it('uses the keybinding registry for accelerators (display-only on Windows/Linux)', () => {
    const st = menuState(registered, resolvedWin, (id) => id !== 'remote.push');
    const input = base('win32', st);
    const invoke = vi.fn();
    const tpl = toElectronTemplate(buildMenuModel(input), input, invoke);
    const newTab = find(tpl, 'New Tab')!;
    expect(newTab.accelerator).toBe('Ctrl+T');
    expect(newTab.registerAccelerator).toBe(false);
    expect(newTab.enabled).toBe(true);
    expect(find(tpl, 'Toggle Full Screen')!.accelerator).toBe('F11');
    expect(find(tpl, 'Toggle Terminal')!.accelerator).toBe('Ctrl+`');
    expect(find(tpl, 'Push')!.enabled).toBe(false);
    // Commands that are not registered render disabled.
    expect(find(tpl, 'Perform Repo Maintenance')!.enabled).toBe(false);
    (newTab.click as () => void)();
    expect(invoke).toHaveBeenCalledWith({ commandId: 'tab.new' });
    (find(tpl, 'Undo')!.click as () => void)();
    expect(invoke).toHaveBeenLastCalledWith({ commandId: 'core.undo', textEdit: 'undo' });
  });

  it('macOS accelerators are real key equivalents with mac modifiers', () => {
    const st = menuState(registered, resolvedMac, () => true);
    const input = base('darwin', st);
    const tpl = toElectronTemplate(buildMenuModel(input), input, () => undefined);
    const fs = find(tpl, 'Toggle Full Screen')!;
    expect(fs.accelerator).toBe('Ctrl+Cmd+F');
    expect(fs.registerAccelerator).toBeUndefined();
    expect(find(tpl, 'Command Palette')!.accelerator).toBe('Cmd+P');
    // Roles stay native (text editing).
    expect(find(find(tpl, 'Edit')!.submenu as Item[], 'Undo')!.accelerator).toBe('Cmd+Z');
    expect((find(tpl, 'Edit')!.submenu as Item[]).some((i) => i.role === 'paste')).toBe(true);
  });

  it('user overrides win (first resolved binding) and unbound commands get no accelerator', () => {
    const resolved = resolveKeybindings(
      DEFAULT_KEYBINDINGS,
      [
        { command: 'tab.new', key: 'ctrl+alt+n' },
        { command: 'palette.toggle', key: '' },
      ],
      false,
    );
    const st = menuState(registered, resolved, () => true);
    expect(st.accelerators['tab.new']).toBe('ctrl+alt+n');
    expect(st.accelerators['palette.toggle']).toBeUndefined();
    const input = base('win32', st);
    const tpl = toElectronTemplate(buildMenuModel(input), input, () => undefined);
    expect(find(tpl, 'New Tab')!.accelerator).toBe('Ctrl+Alt+N');
    expect(find(tpl, 'Command Palette')!.accelerator).toBeUndefined();
  });

  it('recent-repo items never carry the command accelerator', () => {
    const input = base('win32', {
      accelerators: { 'repo.open': 'ctrl+shift+r' },
      enabled: { 'repo.open': true },
      recent: [{ path: 'C:\\r\\a', label: 'a' }],
    });
    const invoke = vi.fn();
    const tpl = toElectronTemplate(buildMenuModel(input), input, invoke);
    const a = find(tpl, 'a')!;
    expect(a.accelerator).toBeUndefined();
    (a.click as () => void)();
    expect(invoke).toHaveBeenCalledWith({ commandId: 'repo.open', arg: 'C:\\r\\a' });
  });
});
