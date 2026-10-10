/**
 * Keybinding chord → Electron accelerator (spec 01 §4.11: menu accelerators come from the keybinding
 * registry). Chords are the renderer's normalized form: lower-case, `+`-joined, modifiers in the order
 * ctrl, alt, shift, meta (`ctrl+shift+s`, `meta+alt+1`, `ctrl+\``).
 */

const NAMED: Record<string, string> = {
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
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  numpadadd: 'numadd',
  numpadsubtract: 'numsub',
  numpadmultiply: 'nummult',
  numpaddivide: 'numdiv',
  plus: 'Plus',
};

const PUNCT = new Set(['=', '-', ',', '.', '/', '\\', ';', "'", '[', ']', '`']);

function keyToAccelerator(key: string): string | undefined {
  if (/^[a-z]$/.test(key)) return key.toUpperCase();
  if (/^[0-9]$/.test(key)) return key;
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(key)) return key.toUpperCase();
  if (/^numpad[0-9]$/.test(key)) return `num${key.slice(6)}`;
  if (PUNCT.has(key)) return key;
  return NAMED[key];
}

/** Electron accelerator for a chord, or undefined when it cannot be expressed (unknown key). */
export function chordToAccelerator(chord: string, isMac: boolean): string | undefined {
  if (!chord) return undefined;
  // A literal "+" key is never produced by the renderer (it uses "="), so splitting on "+" is safe.
  const parts = chord.split('+');
  const key = parts.pop();
  if (!key) return undefined;
  const k = keyToAccelerator(key);
  if (!k) return undefined;
  const mods: string[] = [];
  for (const m of parts) {
    if (m === 'ctrl') mods.push('Ctrl');
    else if (m === 'alt') mods.push(isMac ? 'Option' : 'Alt');
    else if (m === 'shift') mods.push('Shift');
    else if (m === 'meta') mods.push(isMac ? 'Cmd' : 'Super');
    else return undefined;
  }
  return [...mods, k].join('+');
}
