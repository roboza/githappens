import type { IpcResult } from '@githappens/git/types';

import type { GraphIpcContract } from '../../../../shared/ipc/graph-contract';
import { IpcError } from '../../lib/api';

/**
 * Typed invoke for the graph side channels (`avatar:resolve`, `repoUi:*`, `graph:countCommits`).
 *
 * `GraphIpcContract` is merged into the app-wide `IpcContract` by the coordinator; going through
 * `window.api.invoke` with this narrow signature keeps the renderer independent of that wiring step.
 * The preload allowlist (`INVOKE_CHANNELS`) still gates every call at runtime.
 */
export async function graphInvoke<C extends keyof GraphIpcContract>(
  channel: C,
  req: GraphIpcContract[C]['req'],
): Promise<GraphIpcContract[C]['res']> {
  const call = window.api.invoke as unknown as (c: string, r: unknown) => Promise<IpcResult<unknown>>;
  const r = await call(channel, req);
  if (r.ok) return r.data as GraphIpcContract[C]['res'];
  throw new IpcError(r.error);
}
