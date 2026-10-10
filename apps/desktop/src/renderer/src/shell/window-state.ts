import { create } from 'zustand';

import type { WindowStateInfo } from '../../../shared/ipc/shell2-contract';
import { shellInvoke, shellOn } from './shell2-api';

/** Fullscreen / maximized flags of the main window (`window:state`), for title-bar layout. */
export const useWindowState = create<WindowStateInfo>(() => ({
  fullscreen: false,
  maximized: false,
  focused: true,
}));

let installed = false;

/** Start listening (idempotent). */
export function installWindowStateListener(): () => void {
  if (installed) return () => undefined;
  installed = true;
  shellInvoke('window:getState', {})
    .then((s) => useWindowState.setState(s))
    .catch(() => undefined);
  const off = shellOn('window:state', (s) => useWindowState.setState(s));
  return () => {
    installed = false;
    off();
  };
}

export async function toggleFullscreen(): Promise<void> {
  try {
    const on = await shellInvoke('window:toggleFullscreen', {});
    useWindowState.setState({ fullscreen: on });
  } catch {
    // Main without the window channels: fall back to the DOM fullscreen API.
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
    else await document.documentElement.requestFullscreen().catch(() => undefined);
  }
}
