import type { UndoEventContract, UndoIpcContract } from '../../../../shared/ipc/undo-contract';
import { invoke, on } from '../../lib/api';

/**
 * Typed access to the undo / branching channels of `shared/ipc/undo-contract.ts`. The contract is merged into
 * the app-wide `IpcContract` by the shell; these wrappers keep this module independent of that wiring.
 */
export function undoInvoke<C extends keyof UndoIpcContract>(
  channel: C,
  req: UndoIpcContract[C]['req'],
): Promise<UndoIpcContract[C]['res']> {
  return (invoke as unknown as (c: string, r: unknown) => Promise<UndoIpcContract[C]['res']>)(channel, req);
}

export function onUndoEvent<E extends keyof UndoEventContract>(
  event: E,
  cb: (payload: UndoEventContract[E]) => void,
): () => void {
  try {
    return (on as unknown as (e: string, cb: (p: UndoEventContract[E]) => void) => () => void)(event, cb);
  } catch {
    return () => undefined; // channel not registered (older preload): fall back to query invalidation
  }
}
