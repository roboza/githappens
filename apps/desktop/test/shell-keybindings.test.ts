import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_KEYBINDINGS,
  findConflicts,
  findMatches,
  isDeferredCommand,
  resolveKeybindings,
} from '../src/renderer/src/commands/keybindings';

const win = resolveKeybindings(DEFAULT_KEYBINDINGS, [], false);
const mac = resolveKeybindings(DEFAULT_KEYBINDINGS, [], true);
const cmdFor = (list: typeof win, key: string, text = false): string[] =>
  findMatches(list, key, { textInputFocus: text }).map((b) => b.command);

describe('shell completion default keybindings (spec 01 §4.9, spec 12 §4.11)', () => {
  it('has no conflicts on either platform', () => {
    expect(findConflicts(win)).toEqual([]);
    expect(findConflicts(mac)).toEqual([]);
  });

  it('binds the shortcuts the palette advertises', () => {
    expect(cmdFor(win, 'ctrl+`')).toEqual(['view.toggleTerminal']);
    expect(cmdFor(mac, 'ctrl+`')).toEqual(['view.toggleTerminal']); // Cmd+` is reserved by macOS
    expect(cmdFor(win, 'ctrl+shift+`')).toEqual(['terminal.newTab']);
    expect(cmdFor(win, 'ctrl+alt+m')).toEqual(['ai.commitMessage']);
    expect(cmdFor(mac, 'alt+meta+m')).toEqual(['ai.commitMessage']);
    expect(cmdFor(win, 'ctrl+shift+o')).toEqual(['finder.files']);
    expect(cmdFor(win, 'ctrl+shift+h')).toEqual(['history.file']);
    expect(cmdFor(win, 'ctrl+o')).toEqual(['repoMgmt.show']);
    expect(cmdFor(mac, 'meta+o')).toEqual(['repoMgmt.show']);
    expect(cmdFor(win, 'f11')).toEqual(['view.fullscreen']);
    expect(cmdFor(mac, 'ctrl+meta+f')).toEqual(['view.fullscreen']);
    expect(cmdFor(win, 'f6')).toEqual(['view.focusNextPanel']);
    expect(cmdFor(win, 'shift+f6', true)).toEqual(['view.focusPrevPanel']);
    expect(cmdFor(win, 'escape')).toEqual(['view.closeCurrent']);
    expect(cmdFor(win, 'ctrl+/')).toEqual(['view.shortcuts']);
    // Phase 7 bindings are kept.
    expect(cmdFor(win, 'alt+o')).toEqual(['repo.openInFileManager']);
    expect(cmdFor(win, 'alt+t')).toEqual(['repo.openInTerminal']);
    expect(cmdFor(win, 'ctrl+shift+e')).toEqual(['repo.openInExternalEditor']);
    expect(cmdFor(win, 'ctrl+d')).toEqual(['repo.openExternalDiff']);
  });

  it('favorites use Ctrl+Alt (Cmd+Option) 1–9, never while typing, and yield to the diff view', () => {
    for (let n = 1; n <= 9; n++) {
      expect(cmdFor(win, `ctrl+alt+${n}`)).toEqual([`favorite.open.${n}`]);
      expect(cmdFor(mac, `alt+meta+${n}`)).toEqual([`favorite.open.${n}`]);
      // AltGr = Ctrl+Alt on many layouts: typing `{` / `@` in a field must not open a repo.
      expect(cmdFor(win, `ctrl+alt+${n}`, true)).toEqual([]);
      expect(cmdFor(win, `ctrl+${n}`)).toEqual([`tab.goto.${n}`]);
    }
    expect(isDeferredCommand('favorite.open.2')).toBe(true);
    expect(isDeferredCommand('view.closeCurrent')).toBe(true);
    expect(isDeferredCommand('tab.goto.2')).toBe(false);
  });

  it('Esc and other bare keys never fire while typing', () => {
    expect(cmdFor(win, 'escape', true)).toEqual([]);
  });

  it('every default binding targets a command some module registers', () => {
    const root = path.join(__dirname, '../src/renderer/src');
    const sources: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name)) sources.push(fs.readFileSync(p, 'utf8'));
      }
    };
    walk(root);
    const all = sources.join('\n');
    const missing = [...new Set(DEFAULT_KEYBINDINGS.map((b) => b.command))].filter((cmd) => {
      if (all.includes(`id: '${cmd}'`) || all.includes(`fileCmd('${cmd}'`)) return false;
      // Families registered with template ids: `tab.goto.${i + 1}`, `favorite.open.${i + 1}`.
      const family = /^(.*\.)\d+$/.exec(cmd)?.[1];
      return !(family && all.includes(`id: \`${family}\${`));
    });
    expect(missing).toEqual([]);
  });
});
