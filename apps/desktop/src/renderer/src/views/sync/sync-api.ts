import type { IpcResult } from '@githappens/git/types';

import type { SyncIpcContract } from '../../../../shared/ipc/sync-contract';
import { IpcError } from '../../lib/api';

// The sync channels live in `sync-contract.ts` and are merged into the main contract by main/index; this
// wrapper keeps renderer code typed against the sync contract either way (same as filesInvoke).

type LooseInvoke = (channel: string, req: unknown) => Promise<IpcResult<unknown>>;

export async function syncInvoke<C extends keyof SyncIpcContract>(
  channel: C,
  req: SyncIpcContract[C]['req'],
): Promise<SyncIpcContract[C]['res']> {
  const r = await (window.api.invoke as unknown as LooseInvoke)(channel, req);
  if (r.ok) return r.data as SyncIpcContract[C]['res'];
  throw new IpcError(r.error);
}

export type { HookStatus, PushPreviewResult } from '../../../../shared/ipc/sync-contract';
