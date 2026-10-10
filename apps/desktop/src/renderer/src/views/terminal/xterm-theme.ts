import type { ITheme } from '@xterm/xterm';

/** Derives an xterm theme from the active `--kl-*` tokens (spec 13 themes; terminal colors). */

type Rgba = [number, number, number, number];

function parseColor(input: string): Rgba | null {
  const c = input.trim();
  let m = /^#([0-9a-f]{3,8})$/i.exec(c);
  if (m) {
    let h = m[1]!;
    if (h.length === 3 || h.length === 4) h = [...h].map((x) => x + x).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    const n = (i: number): number => parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
  }
  m = /^rgba?\(([^)]+)\)$/i.exec(c);
  if (m) {
    const parts = m[1]!
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map(Number);
    if (parts.length < 3 || parts.some((p) => Number.isNaN(p))) return null;
    return [parts[0]!, parts[1]!, parts[2]!, parts[3] ?? 1];
  }
  return null;
}

const hex = ([r, g, b]: Rgba): string =>
  '#' +
  [r, g, b]
    .map((v) =>
      Math.round(Math.max(0, Math.min(255, v)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('');

/** Composite `fg` (possibly translucent) over opaque `bg`. */
function over(fg: Rgba, bg: Rgba): Rgba {
  const a = fg[3];
  return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a), 1];
}

function mix(a: Rgba, b: Rgba, t: number): Rgba {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, 1];
}

const WHITE: Rgba = [255, 255, 255, 1];
const BLACK: Rgba = [0, 0, 0, 1];

export function readToken(name: string, el: Element = document.documentElement): string {
  return getComputedStyle(el).getPropertyValue(`--kl-${name}`).trim();
}

export function buildXtermTheme(read: (token: string) => string = readToken, dark?: boolean): ITheme {
  const isDark = dark ?? document.documentElement.dataset.theme !== 'light';
  const tok = (name: string, fallback: string): Rgba =>
    parseColor(read(name) || fallback) ?? parseColor(fallback)!;

  const bg = over(tok('panel__bg0', isDark ? '#1d2126' : '#ffffff'), isDark ? BLACK : WHITE);
  const fg = over(tok('text-normal', isDark ? '#dbdbdb' : '#262626'), bg);
  const accent = over(tok('text-accent', '#2ec4b6'), bg);
  // Normal ANSI colors are toned toward the background's opposite for contrast in light themes.
  const tone = (name: string, fallback: string): Rgba => {
    const c = over(tok(name, fallback), bg);
    return isDark ? c : mix(c, BLACK, 0.25);
  };
  const bright = (c: Rgba): Rgba => (isDark ? mix(c, WHITE, 0.25) : mix(c, BLACK, 0.15));

  const red = tone('red', '#e5534b');
  const green = tone('green', '#4fb36b');
  const yellow = tone('yellow', '#e3c341');
  const blue = tone('blue', '#4a90e2');
  const magenta = tone('purple', '#9b6ad6');
  const cyan = tone('teal', '#2ec4b6');
  const black: Rgba = isDark ? [72, 79, 88, 1] : [36, 41, 47, 1];
  const white: Rgba = isDark ? [208, 212, 218, 1] : [110, 119, 129, 1];

  return {
    background: hex(bg),
    foreground: hex(fg),
    cursor: hex(accent),
    cursorAccent: hex(bg),
    selectionBackground: `rgba(${accent.slice(0, 3).map(Math.round).join(',')},0.35)`,
    selectionInactiveBackground: `rgba(${accent.slice(0, 3).map(Math.round).join(',')},0.2)`,
    scrollbarSliderBackground: isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.15)',
    scrollbarSliderHoverBackground: isDark ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.25)',
    scrollbarSliderActiveBackground: isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.35)',
    black: hex(black),
    red: hex(red),
    green: hex(green),
    yellow: hex(yellow),
    blue: hex(blue),
    magenta: hex(magenta),
    cyan: hex(cyan),
    white: hex(white),
    brightBlack: hex(isDark ? [110, 118, 129, 1] : [87, 96, 106, 1]),
    brightRed: hex(bright(red)),
    brightGreen: hex(bright(green)),
    brightYellow: hex(bright(yellow)),
    brightBlue: hex(bright(blue)),
    brightMagenta: hex(bright(magenta)),
    brightCyan: hex(bright(cyan)),
    brightWhite: hex(isDark ? WHITE : [140, 149, 159, 1]),
  };
}
