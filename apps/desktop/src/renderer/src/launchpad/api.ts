import type { IpcResult } from '@githappens/git/types';

import type { LaunchpadEventContract, LaunchpadIpcContract } from '../../../shared/ipc/launchpad-contract';
import { IpcError } from '../lib/api';

/** Typed access to the Launchpad IPC channels (spec 11 §5.4), like `intInvoke` for integrations. */

type LooseInvoke = (channel: string, req: unknown) => Promise<IpcResult<unknown>>;
type LooseOn = (event: string, cb: (payload: unknown) => void) => () => void;

export type LpChannel = keyof LaunchpadIpcContract;
export type LpReq<C extends LpChannel> = LaunchpadIpcContract[C]['req'];
export type LpRes<C extends LpChannel> = LaunchpadIpcContract[C]['res'];

export async function lpInvoke<C extends LpChannel>(channel: C, req: LpReq<C>): Promise<LpRes<C>> {
  const r = await (window.api.invoke as unknown as LooseInvoke)(channel, req);
  if (r.ok) return r.data as LpRes<C>;
  throw new IpcError(r.error);
}

export function lpOn<E extends keyof LaunchpadEventContract>(
  event: E,
  cb: (payload: LaunchpadEventContract[E]) => void,
): () => void {
  return (window.api.on as unknown as LooseOn)(event, cb as (p: unknown) => void);
}
