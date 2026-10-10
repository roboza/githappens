import type { IpcResult } from '@githappens/git/types';

import type { RemotesIpcContract } from '../../../../shared/ipc/remotes-contract';
import { IpcError } from '../../lib/api';

/**
 * Typed invoke for the Phase 8 read channels (`git:lfs:locks`, `git:worktree:status`,
 * `git:submodule:parent`). `RemotesIpcContract` is merged into the app-wide `IpcContract` by the
 * coordinator; this narrow signature keeps the renderer independent of that wiring step. The preload
 * allowlist (`INVOKE_CHANNELS`) still gates every call at runtime.
 */
export async function remotesInvoke<C extends keyof RemotesIpcContract>(
  channel: C,
  req: RemotesIpcContract[C]['req'],
): Promise<RemotesIpcContract[C]['res']> {
  const call = window.api.invoke as unknown as (c: string, r: unknown) => Promise<IpcResult<unknown>>;
  const r = await call(channel, req);
  if (r.ok) return r.data as RemotesIpcContract[C]['res'];
  throw new IpcError(r.error);
}
