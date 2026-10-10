import { describe, expect, it } from 'vitest';

import {
  conflictsFor,
  DEFAULT_KEYBINDINGS,
  eventToChord,
  findConflicts,
  findMatches,
  formatChord,
  normalizeChord,
  reservedReason,
  resetCommandBindings,
  resolveKeybindings,
  setCommandBindings,
  whenMatches,
} from '../src/renderer/src/commands/keybindings';

const ev = (
  key: string,
  code: string,
  mods: Partial<Record<'ctrl' | 'alt' | 'shift' | 'meta', boolean>> = {},
) => ({
  key,
  code,
  ctrlKey: !!mods.ctrl,
  altKey: !!mods.alt,
  shiftKey: !!mods.shift,
  metaKey: !!mods.meta,
});

describe('chords', () => {
  it('normalizes aliases, modifier order and mod', () => {
    expect(normalizeChord('Shift+Ctrl+K', false)).toBe('ctrl+shift+k');
    expect(normalizeChord('mod+p', false)).toBe('ctrl+p');
    expect(normalizeChord('mod+p', true)).toBe('meta+p');
    expect(normalizeChord('Cmd+Option+F', true)).toBe('alt+meta+f');
    expect(normalizeChord('ctrl++', false)).toBe('ctrl+=');
    expect(normalizeChord('ctrl+Esc', false)).toBe('ctrl+escape');
    expect(normalizeChord('ctrl+a+b', false)).toBeNull();
    expect(normalizeChord('ctrl+shift', false)).toBeNull();
    expect(normalizeChord('', false)).toBeNull();
  });

  it('maps keyboard events (shifted digits/punctuation by code, letters by key)', () => {
    expect(eventToChord(ev('P', 'KeyP', { ctrl: true, shift: true }))).toBe('ctrl+shift+p');
    expect(eventToChord(ev(')', 'Digit0', { ctrl: true, shift: true }))).toBe('ctrl+shift+0');
    expect(eventToChord(ev('+', 'Equal', { ctrl: true, shift: true }))).toBe('ctrl+shift+=');
    expect(eventToChord(ev('Enter', 'Enter', { meta: true }))).toBe('meta+enter');
    expect(eventToChord(ev('Tab', 'Tab', { ctrl: true }))).toBe('ctrl+tab');
    expect(eventToChord(ev('ArrowUp', 'ArrowUp'))).toBe('up');
    expect(eventToChord(ev('Control', 'ControlLeft', { ctrl: true }))).toBeNull();
    // AZERTY: the key labelled "a" sits on code KeyQ → follows the layout
    expect(eventToChord(ev('a', 'KeyQ', { ctrl: true }))).toBe('ctrl+a');
    // non-latin layouts fall back to the physical key
    expect(eventToChord(ev('ф', 'KeyA', { ctrl: true }))).toBe('ctrl+a');
  });

  it('formats labels per platform', () => {
    expect(formatChord('ctrl+shift+s', false)).toBe('Ctrl+Shift+S');
    expect(formatChord('meta+alt+f', true)).toBe('Option+Cmd+F');
    expect(formatChord('ctrl+enter', false)).toBe('Ctrl+Enter');
    expect(formatChord('ctrl+,', false)).toBe('Ctrl+,');
  });

  it('knows reserved OS shortcuts', () => {
    expect(reservedReason('alt+f4', false)).toMatch(/reserved/);
    expect(reservedReason('meta+q', true)).toMatch(/Quit/);
    expect(reservedReason('ctrl+b', false)).toBeUndefined();
  });
});

describe('defaults (spec 01 §4.9)', () => {
  const win = resolveKeybindings(DEFAULT_KEYBINDINGS, [], false);
  const mac = resolveKeybindings(DEFAULT_KEYBINDINGS, [], true);
  const cmdFor = (list: typeof win, key: string, text = false): string[] =>
    findMatches(list, key, { textInputFocus: text }).map((b) => b.command);

  it('maps the shortcut table to command ids', () => {
    expect(cmdFor(win, 'ctrl+p')).toEqual(['palette.toggle']);
    expect(cmdFor(mac, 'meta+p')).toEqual(['palette.toggle']);
    expect(cmdFor(win, 'ctrl+t')).toEqual(['tab.new']);
    expect(cmdFor(win, 'ctrl+w')).toEqual(['repo.closeTab']);
    expect(cmdFor(win, 'ctrl+b')).toEqual(['branch.create']);
    expect(cmdFor(win, 'ctrl+l')).toEqual(['remote.fetchAll']);
    expect(cmdFor(win, 'ctrl+shift+s')).toEqual(['wip.stageAll']);
    expect(cmdFor(win, 'ctrl+shift+u')).toEqual(['wip.unstageAll']);
    expect(cmdFor(win, 'ctrl+j')).toEqual(['view.toggleLeftPanel']);
    expect(cmdFor(win, 'ctrl+k')).toEqual(['view.toggleRightPanel']);
    expect(cmdFor(win, 'ctrl+,')).toEqual(['prefs.open']);
    expect(cmdFor(win, 'ctrl+3')).toEqual(['tab.goto.3']);
    expect(cmdFor(mac, 'ctrl+tab')).toEqual(['tab.next']);
    expect(cmdFor(win, 'ctrl+shift+tab')).toEqual(['tab.prev']);
    expect(cmdFor(win, 'ctrl+alt+f')).toEqual(['leftPanel.focusFilter']);
    expect(cmdFor(win, 'ctrl+shift+m')).toEqual(['wip.focusMessage']);
    expect(cmdFor(win, 'ctrl+shift+0')).toEqual(['graph.jumpToHead']);
    expect(cmdFor(win, 'ctrl+y')).toEqual(['core.redo']);
    expect(cmdFor(win, 'ctrl+shift+z')).toEqual(['core.redo']);
  });

  it('keeps the text-field exclusions', () => {
    expect(cmdFor(win, 'ctrl+z', true)).toEqual([]);
    expect(cmdFor(win, 'ctrl+z', false)).toEqual(['core.undo']);
    expect(cmdFor(win, 'ctrl+f', true)).toEqual([]);
    expect(cmdFor(win, 'ctrl+f', false)).toEqual(['graph.focusSearch']);
    expect(cmdFor(win, 'ctrl+enter', true)).toEqual([]);
    expect(cmdFor(win, 'ctrl+enter')).toEqual(['wip.commit']);
    expect(cmdFor(win, 'ctrl+shift+enter')).toEqual(['wip.commitPush']);
    expect(cmdFor(win, 'ctrl+alt+enter')).toEqual(['wip.stageAllCommit']);
    // global shortcuts still work while typing
    expect(cmdFor(win, 'ctrl+p', true)).toEqual(['palette.toggle']);
    // tab switching requires exact modifiers (Ctrl+Alt+1 is favorite #1, not Ctrl+1)
    expect(cmdFor(win, 'ctrl+alt+1')).not.toContain('tab.goto.1');
  });

  it('has no conflicts out of the box', () => {
    expect(findConflicts(win)).toEqual([]);
    expect(findConflicts(mac)).toEqual([]);
  });

  it('bare keys never fire in text inputs', () => {
    expect(whenMatches({ key: 's' }, { textInputFocus: true })).toBe(false);
    expect(whenMatches({ key: 's' }, { textInputFocus: false })).toBe(true);
    expect(whenMatches({ key: 'f5' }, { textInputFocus: true })).toBe(true);
    expect(whenMatches({ key: 'ctrl+s', when: 'textInputFocus' }, { textInputFocus: false })).toBe(false);
    expect(whenMatches({ key: 'ctrl+s', when: 'weird' }, { textInputFocus: false })).toBe(false);
  });
});

describe('overrides', () => {
  it('replace a command’s defaults, unbind with an empty key, and use mac variants', () => {
    const r = resolveKeybindings(
      DEFAULT_KEYBINDINGS,
      [
        { command: 'branch.create', key: 'ctrl+shift+b', mac: 'cmd+shift+b' },
        { command: 'remote.fetchAll', key: '' },
      ],
      false,
    );
    expect(findMatches(r, 'ctrl+b', { textInputFocus: false })).toEqual([]);
    expect(findMatches(r, 'ctrl+shift+b', { textInputFocus: false })[0]).toMatchObject({
      command: 'branch.create',
      source: 'user',
    });
    expect(findMatches(r, 'ctrl+l', { textInputFocus: false })).toEqual([]);
    const mac = resolveKeybindings(
      DEFAULT_KEYBINDINGS,
      [{ command: 'branch.create', key: 'ctrl+shift+b', mac: 'cmd+shift+b' }],
      true,
    );
    expect(findMatches(mac, 'shift+meta+b', { textInputFocus: false })[0]!.command).toBe('branch.create');
  });

  it('ignores reserved and invalid chords', () => {
    const r = resolveKeybindings(
      [],
      [
        { command: 'x', key: 'alt+f4' },
        { command: 'y', key: 'ctrl+a+b' },
      ],
      false,
    );
    expect(r).toEqual([]);
  });

  it('user bindings take priority and conflicts are detected', () => {
    const r = resolveKeybindings(DEFAULT_KEYBINDINGS, [{ command: 'remote.pull', key: 'ctrl+b' }], false);
    expect(findMatches(r, 'ctrl+b', { textInputFocus: false }).map((b) => b.command)).toEqual([
      'remote.pull',
      'branch.create',
    ]);
    expect(findConflicts(r)).toEqual([{ key: 'ctrl+b', commands: ['remote.pull', 'branch.create'] }]);
    expect(conflictsFor(r, 'ctrl+b', 'remote.pull')).toEqual(['branch.create']);
    // disjoint when-clauses do not conflict
    const d = resolveKeybindings(
      [],
      [
        { command: 'a', key: 'ctrl+e', when: 'textInputFocus' },
        { command: 'b', key: 'ctrl+e', when: '!textInputFocus' },
      ],
      false,
    );
    expect(findConflicts(d)).toEqual([]);
  });

  it('edit helpers set, unbind and reset a command', () => {
    let o = setCommandBindings([], 'tab.new', [
      { key: 'ctrl+n' },
      { key: 'ctrl+shift+n', when: '!textInputFocus' },
    ]);
    expect(o).toEqual([
      { command: 'tab.new', key: 'ctrl+n' },
      { command: 'tab.new', key: 'ctrl+shift+n', when: '!textInputFocus' },
    ]);
    o = setCommandBindings(o, 'core.undo', []);
    expect(o).toContainEqual({ command: 'core.undo', key: '' });
    o = resetCommandBindings(o, 'tab.new');
    expect(o).toEqual([{ command: 'core.undo', key: '' }]);
  });
});
