import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';

import {
  isEventChannel,
  isInvokeChannel,
  type EventChannel,
  type EventContract,
  type InvokeChannel,
  type GitHappensApi,
  type Req,
} from '../shared/ipc/contract';

/**
 * The only bridge between renderer and main (spec 00 §3). Channels are allowlisted;
 * the renderer never gets ipcRenderer, Node or Electron objects.
 */

function invoke(channel: InvokeChannel, req: Req<InvokeChannel>): Promise<never> {
  if (!isInvokeChannel(channel)) return Promise.reject(new Error(`Blocked IPC channel: ${String(channel)}`));
  return ipcRenderer.invoke(channel, req) as Promise<never>;
}

function on(event: EventChannel, cb: (payload: EventContract[EventChannel]) => void): () => void {
  if (!isEventChannel(event)) throw new Error(`Blocked IPC event: ${String(event)}`);
  const listener = (_e: IpcRendererEvent, payload: EventContract[EventChannel]): void => cb(payload);
  ipcRenderer.on(event, listener);
  return () => ipcRenderer.removeListener(event, listener);
}

function onlyGit<T extends string>(c: T): T {
  if (!c.startsWith('git:')) throw new Error(`Not a git channel: ${c}`);
  return c;
}

const api: GitHappensApi = {
  invoke: invoke as GitHappensApi['invoke'],
  on: on as GitHappensApi['on'],
  git: {
    invoke: ((c: InvokeChannel, r: Req<InvokeChannel>) =>
      invoke(onlyGit(c), r)) as GitHappensApi['git']['invoke'],
    on: ((e: EventChannel, cb: (p: EventContract[EventChannel]) => void) =>
      on(onlyGit(e), cb)) as GitHappensApi['git']['on'],
  },
  platform: process.platform,
  pathForFile: (f: File) => webUtils.getPathForFile(f),
};

contextBridge.exposeInMainWorld('api', api);
