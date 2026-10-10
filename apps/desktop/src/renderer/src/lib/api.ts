import type { SerializedGitError } from '@githappens/git/types';

import type { EventChannel, EventContract, InvokeChannel, Req, Res } from '../../../shared/ipc/contract';

/** Rejection type for failed IPC calls; carries the typed error from main. */
export class IpcError extends Error {
  constructor(readonly error: SerializedGitError) {
    super(error.message);
    this.name = 'IpcError';
  }
  get code(): SerializedGitError['code'] {
    return this.error.code;
  }
}

/** Unwraps `IpcResult`: resolves with data or throws `IpcError`. */
export async function invoke<C extends InvokeChannel>(channel: C, req: Req<C>): Promise<Res<C>> {
  const r = await window.api.invoke(channel, req);
  if (r.ok) return r.data;
  throw new IpcError(r.error);
}

export function on<E extends EventChannel>(event: E, cb: (payload: EventContract[E]) => void): () => void {
  return window.api.on(event, cb);
}
