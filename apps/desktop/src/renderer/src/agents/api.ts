import type { IpcResult } from '@githappens/git/types';

import type { AgentsEventContract, AgentsIpcContract } from '../../../shared/ipc/agents-contract';
import { IpcError } from '../lib/api';

/** Typed access to the Agent Sessions channels (spec 12 §4.12) via `window.api`. */

type LooseInvoke = (channel: string, req: unknown) => Promise<IpcResult<unknown>>;
type LooseOn = (event: string, cb: (payload: unknown) => void) => () => void;

export type AgentsChannel = keyof AgentsIpcContract;

export async function agentsInvoke<C extends AgentsChannel>(
  channel: C,
  req: AgentsIpcContract[C]['req'],
): Promise<AgentsIpcContract[C]['res']> {
  const r = await (window.api.invoke as unknown as LooseInvoke)(channel, req);
  if (r.ok) return r.data as AgentsIpcContract[C]['res'];
  throw new IpcError(r.error);
}

export function agentsOn<E extends keyof AgentsEventContract>(
  event: E,
  cb: (payload: AgentsEventContract[E]) => void,
): () => void {
  return (window.api.on as unknown as LooseOn)(event, cb as (p: unknown) => void);
}
