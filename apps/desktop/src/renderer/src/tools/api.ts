import type { IpcResult } from '@githappens/git/types';

import type { ToolsIpcContract } from '../../../shared/ipc/tools-contract';
import { IpcError } from '../lib/api';

/**
 * Typed access to the external-tools channels (spec 12 §6.10). Goes through `window.api` like `invoke` in
 * lib/api.ts, typed against the tools contract directly.
 */

type LooseInvoke = (channel: string, req: unknown) => Promise<IpcResult<unknown>>;

export type ToolsChannel = keyof ToolsIpcContract;

export async function toolsInvoke<C extends ToolsChannel>(
  channel: C,
  req: ToolsIpcContract[C]['req'],
): Promise<ToolsIpcContract[C]['res']> {
  const r = await (window.api.invoke as unknown as LooseInvoke)(channel, req);
  if (r.ok) return r.data as ToolsIpcContract[C]['res'];
  throw new IpcError(r.error);
}

/** Ask the app shell to open Preferences → External Tools. */
export function openToolsPreferences(): void {
  window.dispatchEvent(new CustomEvent('kl:open-preferences', { detail: 'External Tools' }));
}
