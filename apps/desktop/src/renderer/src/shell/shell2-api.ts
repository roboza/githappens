import type { IpcResult } from '@githappens/git/types';

import type { Shell2EventContract, Shell2IpcContract } from '../../../shared/ipc/shell2-contract';
import { IpcError } from '../lib/api';

/**
 * Typed access to the shell-completion channels (`shared/ipc/shell2-contract.ts`), through `window.api`
 * like `invoke` in lib/api.ts but typed against this contract directly.
 */

type LooseInvoke = (channel: string, req: unknown) => Promise<IpcResult<unknown>>;
type LooseOn = (event: string, cb: (payload: unknown) => void) => () => void;

export async function shellInvoke<C extends keyof Shell2IpcContract>(
  channel: C,
  req: Shell2IpcContract[C]['req'],
): Promise<Shell2IpcContract[C]['res']> {
  const r = await (window.api.invoke as unknown as LooseInvoke)(channel, req);
  if (r.ok) return r.data as Shell2IpcContract[C]['res'];
  throw new IpcError(r.error);
}

export function shellOn<E extends keyof Shell2EventContract>(
  event: E,
  cb: (payload: Shell2EventContract[E]) => void,
): () => void {
  try {
    return (window.api.on as unknown as LooseOn)(event, cb as (p: unknown) => void);
  } catch (e) {
    // Channel not allowlisted yet (contract not merged): stay inert instead of crashing the shell.
    console.warn(`[shell] event ${event} unavailable`, e);
    return () => undefined;
  }
}
