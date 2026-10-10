import { Menu, type BrowserWindow } from 'electron';

import type { MenuInvokeEvent, MenuRebuildRequest } from '../../shared/ipc/shell2-contract';
import { buildMenuModel, toElectronTemplate } from './menu-template';

export interface MenuControllerOptions {
  appName: string;
  platform: NodeJS.Platform;
  devTools: boolean;
  /** Forward a click to the renderer (`menu:invoke`). */
  invoke(e: MenuInvokeEvent): void;
  window(): BrowserWindow | undefined;
}

const EMPTY: MenuRebuildRequest = { accelerators: {}, enabled: {}, recent: [], profiles: [] };

/**
 * Owns the native application menu (spec 01 §4.11). Installed at startup with every command disabled,
 * then rebuilt from the renderer's registry state on `menu:rebuild`. On Windows/Linux the window keeps
 * its custom title bar, so the menu is reached through `popup` (title-bar hamburger or a lone Alt).
 */
export class MenuController {
  private last: MenuRebuildRequest = EMPTY;
  private lastKey = '';

  constructor(private readonly o: MenuControllerOptions) {}

  install(): void {
    this.apply(EMPTY, true);
  }

  rebuild(req: MenuRebuildRequest): void {
    this.apply(req, false);
  }

  popup(at: { x?: number; y?: number } = {}): void {
    const menu = Menu.getApplicationMenu();
    const win = this.o.window();
    if (!menu || !win) return;
    menu.popup({
      window: win,
      ...(at.x !== undefined ? { x: Math.round(at.x) } : {}),
      ...(at.y !== undefined ? { y: Math.round(at.y) } : {}),
    });
  }

  private apply(req: MenuRebuildRequest, force: boolean): void {
    const key = JSON.stringify(req);
    if (!force && key === this.lastKey) return;
    this.last = req;
    this.lastKey = key;
    const input = {
      ...this.last,
      platform: this.o.platform,
      appName: this.o.appName,
      devTools: this.o.devTools,
    };
    const template = toElectronTemplate(buildMenuModel(input), input, (e) => this.o.invoke(e));
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }
}
