import type { IpcResult } from '@githappens/git/types';

import type {
  CloudWorkspacesEventContract,
  CloudWorkspacesIpcContract,
} from '../../../shared/ipc/cloud-workspaces-contract';
import type { InsightsEventContract, InsightsIpcContract } from '../../../shared/ipc/insights-contract';
import type { SuggestEventContract, SuggestIpcContract } from '../../../shared/ipc/suggest-contract';
import { IpcError } from '../lib/api';

/**
 * Typed access to the Code Suggest, Insights and cloud workspaces channels (spec 14). Goes through
 * `window.api` like the other cloud wrappers; until the channels are allowlisted by the preload build,
 * calls fail with an IpcError and subscriptions are no-ops.
 */

type ExtrasIpc = SuggestIpcContract & InsightsIpcContract & CloudWorkspacesIpcContract;
type ExtrasEvents = SuggestEventContract & InsightsEventContract & CloudWorkspacesEventContract;

type LooseInvoke = (channel: string, req: unknown) => Promise<IpcResult<unknown>>;
type LooseOn = (event: string, cb: (payload: unknown) => void) => () => void;

export async function extrasInvoke<C extends keyof ExtrasIpc>(
  channel: C,
  req: ExtrasIpc[C]['req'],
): Promise<ExtrasIpc[C]['res']> {
  const r = await (window.api.invoke as unknown as LooseInvoke)(channel, req);
  if (r.ok) return r.data as ExtrasIpc[C]['res'];
  throw new IpcError(r.error);
}

export function extrasOn<E extends keyof ExtrasEvents>(
  event: E,
  cb: (payload: ExtrasEvents[E]) => void,
): () => void {
  try {
    return (window.api.on as unknown as LooseOn)(event, cb as (p: unknown) => void);
  } catch {
    return () => undefined;
  }
}

export const extrasKeys = {
  suggestions: (owner: string, name: string, n: number) => ['suggest', 'list', owner, name, n] as const,
  sessions: ['suggest', 'sessions'] as const,
  insights: (workspaceId: string, range: string, authors: string) =>
    ['insights', workspaceId, range, authors] as const,
  cloudWorkspaces: ['cloudWorkspaces', 'list'] as const,
  cloudWorkspaceStatus: (workspaceId: string) => ['cloudWorkspaces', 'status', workspaceId] as const,
};

export function errorText(e: unknown): string {
  if (e instanceof IpcError) return e.error.message;
  return e instanceof Error ? e.message : String(e);
}
