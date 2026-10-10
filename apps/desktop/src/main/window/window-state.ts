import { readJson, writeFileAtomic } from '../settings/atomic-file';

/**
 * Main window bounds persistence (spec 01 §4.13 `windowState.json`, §8 "window on disconnected
 * monitor"). The sanitising / placement logic is pure so it can be unit-tested without Electron.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PersistedWindowState {
  /** Normal (restored) bounds; x/y absent until the window has been placed once. */
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
  fullscreen: boolean;
  /** Electron `Display.id` the window was on. */
  displayId?: number;
}

export interface DisplayLike {
  id: number;
  workArea: Rect;
}

export const DEFAULT_WINDOW_SIZE = { width: 1400, height: 880 } as const;
export const MIN_WINDOW_SIZE = { width: 900, height: 560 } as const;
/** Minimum visible part of the window (so the title bar can be grabbed) for bounds to be kept. */
const MIN_VISIBLE = { width: 120, height: 40 } as const;
const MAX_DIM = 100_000;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * `GITHAPPENS_WINDOW_SIZE=<width>x<height>` (e2e / dev): a fixed initial window size, so tests run at a
 * deterministic (CI-like, small) size regardless of the host screen or saved window state. Values below
 * the window minimum are raised to it; anything unparsable is ignored (null).
 */
export function windowSizeOverride(value: string | undefined): { width: number; height: number } | null {
  const m = /^\s*(\d{2,6})\s*[x×,]\s*(\d{2,6})\s*$/i.exec(value ?? '');
  if (!m) return null;
  return {
    width: Math.min(MAX_DIM, Math.max(MIN_WINDOW_SIZE.width, Number(m[1]))),
    height: Math.min(MAX_DIM, Math.max(MIN_WINDOW_SIZE.height, Number(m[2]))),
  };
}

/** Validate whatever was read from disk; unknown / broken fields fall back to defaults. */
export function sanitizeWindowState(raw: unknown): PersistedWindowState {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const dim = (v: unknown, min: number, def: number): number =>
    finite(v) && v > 0 ? Math.round(Math.min(MAX_DIM, Math.max(min, v))) : def;
  const out: PersistedWindowState = {
    width: dim(o.width, MIN_WINDOW_SIZE.width, DEFAULT_WINDOW_SIZE.width),
    height: dim(o.height, MIN_WINDOW_SIZE.height, DEFAULT_WINDOW_SIZE.height),
    maximized: o.maximized === true,
    fullscreen: o.fullscreen === true,
  };
  if (finite(o.x) && finite(o.y) && Math.abs(o.x) < MAX_DIM && Math.abs(o.y) < MAX_DIM) {
    out.x = Math.round(o.x);
    out.y = Math.round(o.y);
  }
  if (finite(o.displayId)) out.displayId = o.displayId;
  return out;
}

function overlap(a: Rect, b: Rect): { width: number; height: number } {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return { width: Math.max(0, width), height: Math.max(0, height) };
}

function centered(size: { width: number; height: number }, area: Rect): Rect {
  const width = Math.min(size.width, area.width);
  const height = Math.min(size.height, area.height);
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height,
  };
}

export interface Placement {
  bounds: Rect;
  maximized: boolean;
  fullscreen: boolean;
  displayId: number;
}

/**
 * Where to open the window: the saved bounds when they are still reachable on a connected display
 * (size clamped to that display), otherwise centered on the saved display if it still exists, else on
 * the primary display.
 */
export function placeWindow(
  state: PersistedWindowState | null,
  displays: readonly DisplayLike[],
  primary: DisplayLike,
): Placement {
  const s = state ?? sanitizeWindowState(null);
  const flags = { maximized: s.maximized, fullscreen: s.fullscreen };
  if (s.x !== undefined && s.y !== undefined) {
    const saved: Rect = { x: s.x, y: s.y, width: s.width, height: s.height };
    // Prefer the display it was on, then whichever shows most of it.
    const ranked = [...displays]
      .map((d) => ({ d, o: overlap(saved, d.workArea) }))
      .filter(({ o }) => o.width >= MIN_VISIBLE.width && o.height >= MIN_VISIBLE.height)
      .sort(
        (a, b) =>
          Number(b.d.id === s.displayId) - Number(a.d.id === s.displayId) ||
          b.o.width * b.o.height - a.o.width * a.o.height,
      );
    const hit = ranked[0];
    if (hit) {
      const area = hit.d.workArea;
      const width = Math.min(saved.width, area.width);
      const height = Math.min(saved.height, area.height);
      // Keep the title bar on screen: never above the work area's top edge.
      const y = Math.max(area.y, Math.min(saved.y, area.y + area.height - MIN_VISIBLE.height));
      return { bounds: { x: saved.x, y, width, height }, displayId: hit.d.id, ...flags };
    }
  }
  const target = displays.find((d) => d.id === s.displayId) ?? primary;
  return { bounds: centered(s, target.workArea), displayId: target.id, ...flags };
}

/** Minimal BrowserWindow surface used by the tracker (keeps it testable). */
export interface TrackedWindow {
  on(event: string, listener: () => void): void;
  isMaximized(): boolean;
  isFullScreen(): boolean;
  isMinimized(): boolean;
  isFocused(): boolean;
  isDestroyed(): boolean;
  getNormalBounds(): Rect;
}

export interface TrackOptions {
  save(state: PersistedWindowState): void;
  displayFor(bounds: Rect): number | undefined;
  /** Called on maximize / fullscreen / focus changes (for the `window:state` event). */
  onState?(state: { maximized: boolean; fullscreen: boolean; focused: boolean }): void;
  debounceMs?: number;
}

/** Snapshot of a window for persistence (normal bounds, so restore size survives maximize). */
export function snapshotWindow(
  win: TrackedWindow,
  displayFor: (b: Rect) => number | undefined,
): PersistedWindowState {
  const b = win.getNormalBounds();
  return {
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    maximized: win.isMaximized(),
    fullscreen: win.isFullScreen(),
    displayId: displayFor(b),
  };
}

/** Persist the window's state on move / resize (debounced) and on close. Returns a flush function. */
export function trackWindow(win: TrackedWindow, o: TrackOptions): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (win.isDestroyed() || win.isMinimized()) return;
    o.save(snapshotWindow(win, o.displayFor));
  };
  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, o.debounceMs ?? 500);
  };
  const emit = (): void => {
    if (win.isDestroyed()) return;
    o.onState?.({ maximized: win.isMaximized(), fullscreen: win.isFullScreen(), focused: win.isFocused() });
  };
  for (const e of ['resize', 'move']) win.on(e, schedule);
  for (const e of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) {
    win.on(e, () => {
      schedule();
      emit();
    });
  }
  for (const e of ['focus', 'blur']) win.on(e, emit);
  win.on('close', flush);
  return flush;
}

/** `userData/windowState.json` (app scope: one main window). */
export class WindowStateStore {
  constructor(private readonly file: string) {}

  load(): PersistedWindowState | null {
    const r = readJson<unknown>(this.file);
    return r.kind === 'ok' ? sanitizeWindowState(r.value) : null;
  }

  save(state: PersistedWindowState): void {
    try {
      writeFileAtomic(this.file, `${JSON.stringify(sanitizeWindowState(state), null, 2)}\n`);
    } catch (e) {
      console.warn('[window] could not save window state:', e);
    }
  }
}
