import type { IpcResult } from '@githappens/git/types';

import type { BehaviourEventContract, BehaviourIpcContract } from '../../../shared/ipc/behaviour-contract';
import { IpcError } from '../lib/api';

// The behaviour channels live in `behaviour-contract.ts` and are merged into the main contract by the
// shell owner; these wrappers keep renderer code typed against that contract either way.

type LooseInvoke = (channel: string, req: unknown) => Promise<IpcResult<unknown>>;
type LooseOn = (event: string, cb: (payload: unknown) => void) => () => void;

export async function behaviourInvoke<C extends keyof BehaviourIpcContract>(
  channel: C,
  req: BehaviourIpcContract[C]['req'],
): Promise<BehaviourIpcContract[C]['res']> {
  const r = await (window.api.invoke as unknown as LooseInvoke)(channel, req);
  if (r.ok) return r.data as BehaviourIpcContract[C]['res'];
  throw new IpcError(r.error);
}

export function behaviourOn<E extends keyof BehaviourEventContract>(
  event: E,
  cb: (payload: BehaviourEventContract[E]) => void,
): () => void {
  try {
    return (window.api.on as unknown as LooseOn)(event, cb as (p: unknown) => void);
  } catch (e) {
    // Channel not allowlisted by this preload build (behaviour contract not merged yet).
    console.warn(`[behaviour] cannot subscribe to ${event}:`, e);
    return () => undefined;
  }
}
