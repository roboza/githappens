import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createShell2Handlers,
  resolveWorktreePath,
  type WindowControls,
} from '../src/main/ipc/shell2-handlers';
import {
  DEFAULT_WINDOW_SIZE,
  placeWindow,
  sanitizeWindowState,
  trackWindow,
  WindowStateStore,
  type DisplayLike,
  type TrackedWindow,
  windowSizeOverride,
} from '../src/main/window/window-state';
import { SHELL2_EVENT_CHANNELS, SHELL2_INVOKE_CHANNELS } from '../src/shared/ipc/shell2-contract';

const primary: DisplayLike = { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
const right: DisplayLike = { id: 2, workArea: { x: 1920, y: 0, width: 2560, height: 1400 } };

describe('window state sanitising (spec 01 §4.13)', () => {
  it('falls back to defaults for junk and clamps sizes', () => {
    expect(sanitizeWindowState(null)).toEqual({
      ...DEFAULT_WINDOW_SIZE,
      maximized: false,
      fullscreen: false,
    });
    expect(sanitizeWindowState('nope')).toEqual(sanitizeWindowState(null));
    const s = sanitizeWindowState({
      x: 10.6,
      y: '5',
      width: 300,
      height: Number.NaN,
      maximized: 'yes',
      fullscreen: true,
      displayId: 7,
    });
    expect(s).toEqual({ width: 900, height: 880, maximized: false, fullscreen: true, displayId: 7 });
    expect(sanitizeWindowState({ x: 1e9, y: 0, width: 1e9, height: 700 })).toEqual({
      width: 100_000,
      height: 700,
      maximized: false,
      fullscreen: false,
    });
  });
});

describe('placing the window', () => {
  it('keeps saved bounds on a connected display', () => {
    const p = placeWindow(
      { x: 2000, y: 100, width: 1200, height: 800, maximized: true, fullscreen: false, displayId: 2 },
      [primary, right],
      primary,
    );
    expect(p).toEqual({
      bounds: { x: 2000, y: 100, width: 1200, height: 800 },
      displayId: 2,
      maximized: true,
      fullscreen: false,
    });
  });

  it('re-centers on the primary display when the saved display is gone', () => {
    const p = placeWindow(
      { x: 2000, y: 100, width: 1200, height: 800, maximized: false, fullscreen: false, displayId: 2 },
      [primary],
      primary,
    );
    expect(p.displayId).toBe(1);
    expect(p.bounds).toEqual({ x: 360, y: 120, width: 1200, height: 800 });
  });

  it('clamps an oversized window to the display and keeps the title bar reachable', () => {
    const p = placeWindow(
      { x: 100, y: -300, width: 5000, height: 3000, maximized: false, fullscreen: false, displayId: 1 },
      [primary],
      primary,
    );
    expect(p.bounds).toEqual({ x: 100, y: 0, width: 1920, height: 1040 });
  });

  it('centers when nothing was saved or only a sliver would be visible', () => {
    expect(placeWindow(null, [primary], primary).bounds).toEqual({ x: 260, y: 80, width: 1400, height: 880 });
    const sliver = placeWindow(
      { x: 1900, y: 1030, width: 1000, height: 700, maximized: false, fullscreen: false },
      [primary],
      primary,
    );
    expect(sliver.bounds.x).toBe(460);
  });

  it('round-trips through windowState.json', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-win-'));
    try {
      const store = new WindowStateStore(path.join(dir, 'windowState.json'));
      expect(store.load()).toBeNull();
      store.save({ x: 5, y: 6, width: 1000, height: 700, maximized: true, fullscreen: false, displayId: 3 });
      expect(store.load()).toEqual({
        x: 5,
        y: 6,
        width: 1000,
        height: 700,
        maximized: true,
        fullscreen: false,
        displayId: 3,
      });
      fs.writeFileSync(path.join(dir, 'windowState.json'), '{broken');
      expect(store.load()).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('tracking a window', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function fakeWindow() {
    const listeners = new Map<string, (() => void)[]>();
    const w = {
      maximized: false,
      fullscreen: false,
      minimized: false,
      bounds: { x: 1, y: 2, width: 1000, height: 700 },
      on(e: string, l: () => void) {
        listeners.set(e, [...(listeners.get(e) ?? []), l]);
      },
      emit(e: string) {
        for (const l of listeners.get(e) ?? []) l();
      },
      isMaximized: () => w.maximized,
      isFullScreen: () => w.fullscreen,
      isMinimized: () => w.minimized,
      isFocused: () => true,
      isDestroyed: () => false,
      getNormalBounds: () => w.bounds,
    };
    return w satisfies TrackedWindow & { emit(e: string): void };
  }

  it('debounces move/resize saves, flushes on close and reports state changes', () => {
    const w = fakeWindow();
    const save = vi.fn();
    const onState = vi.fn();
    trackWindow(w, { save, displayFor: () => 9, onState, debounceMs: 100 });
    w.emit('move');
    w.emit('resize');
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenLastCalledWith({
      x: 1,
      y: 2,
      width: 1000,
      height: 700,
      maximized: false,
      fullscreen: false,
      displayId: 9,
    });
    w.maximized = true;
    w.emit('maximize');
    expect(onState).toHaveBeenCalledWith({ maximized: true, fullscreen: false, focused: true });
    w.emit('close');
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]![0]).toMatchObject({ maximized: true, width: 1000 });
    // Minimized windows are not saved (their bounds are meaningless).
    w.minimized = true;
    w.emit('close');
    expect(save).toHaveBeenCalledTimes(2);
  });
});

describe('shell2 handlers', () => {
  it('lists every channel', () => {
    expect(new Set(SHELL2_INVOKE_CHANNELS).size).toBe(SHELL2_INVOKE_CHANNELS.length);
    expect(SHELL2_EVENT_CHANNELS).toEqual(['menu:invoke', 'window:state']);
  });

  it('toggles fullscreen and maximize through the window', async () => {
    const st = { fs: false, max: false };
    const win: WindowControls = {
      isFullScreen: () => st.fs,
      setFullScreen: (on) => void (st.fs = on),
      isMaximized: () => st.max,
      maximize: () => void (st.max = true),
      unmaximize: () => void (st.max = false),
      minimize: vi.fn(),
      close: vi.fn(),
      isFocused: () => true,
    };
    const rebuild = vi.fn();
    const setAlias = vi.fn();
    const h = createShell2Handlers({
      window: () => win,
      menu: { rebuild, popup: vi.fn() },
      registry: () => ({ setAlias }),
      finder: { list: vi.fn() },
      repos: { get: vi.fn() },
      saveDialog: vi.fn(),
      reloadEnv: vi.fn(),
      gitVersion: () => [2, 45, 0],
    });
    const ctx = { senderId: 1 };
    expect(await h['window:toggleFullscreen']({}, ctx)).toBe(true);
    expect(await h['window:toggleFullscreen']({}, ctx)).toBe(false);
    expect(await h['window:setFullscreen']({ on: true }, ctx)).toBe(true);
    expect(await h['window:getState']({}, ctx)).toEqual({
      fullscreen: true,
      maximized: false,
      focused: true,
    });
    expect(await h['window:maximize']({}, ctx)).toBe(true);
    expect(await h['window:maximize']({}, ctx)).toBe(false);
    await h['menu:rebuild']({ accelerators: { a: 'ctrl+a' }, enabled: {}, recent: [], profiles: [] }, ctx);
    expect(rebuild).toHaveBeenCalledWith({
      accelerators: { a: 'ctrl+a' },
      enabled: {},
      recent: [],
      profiles: [],
    });
    await h['repos:setAlias']({ path: '/r', alias: '  Fork  ' }, ctx);
    await h['repos:setAlias']({ path: '/r', alias: '   ' }, ctx);
    expect(setAlias.mock.calls).toEqual([
      ['/r', 'Fork'],
      ['/r', null],
    ]);
  });

  it('refuses file deletes outside the worktree or inside .git', () => {
    const root = path.resolve('/repo');
    expect(resolveWorktreePath(root, 'src/a.ts')).toBe(path.join(root, 'src', 'a.ts'));
    expect(() => resolveWorktreePath(root, '../x')).toThrow(/inside/);
    expect(() => resolveWorktreePath(root, '/etc/passwd')).toThrow();
    expect(() => resolveWorktreePath(root, 'C:\\x')).toThrow();
    expect(() => resolveWorktreePath(root, '.git/config')).toThrow(/\.git/);
    expect(() => resolveWorktreePath(root, '.GIT/HEAD')).toThrow(/\.git/);
    expect(() => resolveWorktreePath(root, '')).toThrow();
    expect(() => resolveWorktreePath(root, '.')).toThrow();
  });
});

describe('windowSizeOverride (GITHAPPENS_WINDOW_SIZE)', () => {
  it('parses WxH, raises to the window minimum, ignores garbage', () => {
    expect(windowSizeOverride('1024x768')).toEqual({ width: 1024, height: 768 });
    expect(windowSizeOverride(' 1280 X 800 ')).toEqual({ width: 1280, height: 800 });
    expect(windowSizeOverride('640x480')).toEqual({ width: 900, height: 560 });
    expect(windowSizeOverride(undefined)).toBeNull();
    expect(windowSizeOverride('')).toBeNull();
    expect(windowSizeOverride('big')).toBeNull();
  });
});
