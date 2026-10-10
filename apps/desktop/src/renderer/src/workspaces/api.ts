import type { IpcResult } from '@githappens/git/types';

import type { WorkspacesEventContract, WorkspacesIpcContract } from '../../../shared/ipc/workspaces-contract';
import { IpcError } from '../lib/api';

/**
 * Typed access to the workspace IPC channels (spec 11 §5.4). Goes through `window.api` like
 * `invoke`/`on` in lib/api.ts, typed against the workspaces contract directly.
 */

type LooseInvoke = (channel: string, req: unknown) => Promise<IpcResult<unknown>>;
type LooseOn = (event: string, cb: (payload: unknown) => void) => () => void;

export type WsChannel = keyof WorkspacesIpcContract;
export type WsReq<C extends WsChannel> = WorkspacesIpcContract[C]['req'];
export type WsRes<C extends WsChannel> = WorkspacesIpcContract[C]['res'];

export async function wsInvoke<C extends WsChannel>(channel: C, req: WsReq<C>): Promise<WsRes<C>> {
  const r = await (window.api.invoke as unknown as LooseInvoke)(channel, req);
  if (r.ok) return r.data as WsRes<C>;
  throw new IpcError(r.error);
}

export function wsOn<E extends keyof WorkspacesEventContract>(
  event: E,
  cb: (payload: WorkspacesEventContract[E]) => void,
): () => void {
  return (window.api.on as unknown as LooseOn)(event, cb as (p: unknown) => void);
}

export const errorMessage = (e: unknown): string =>
  e instanceof IpcError ? e.error.message : e instanceof Error ? e.message : String(e);
