import type { IpcResult } from '@githappens/git/types';

import type {
  IntegrationsEventContract,
  IntegrationsIpcContract,
} from '../../../shared/ipc/integrations-contract';
import { invoke, IpcError } from '../lib/api';
import { describeProviderError, type FriendlyError } from './helpers';

/**
 * Typed access to the integrations IPC channels (spec 10 §5.5). Goes through `window.api` like
 * `invoke`/`on` in lib/api.ts, typed against the integrations contract directly.
 */

type LooseInvoke = (channel: string, req: unknown) => Promise<IpcResult<unknown>>;
type LooseOn = (event: string, cb: (payload: unknown) => void) => () => void;

export type IntChannel = keyof IntegrationsIpcContract;
export type IntReq<C extends IntChannel> = IntegrationsIpcContract[C]['req'];
export type IntRes<C extends IntChannel> = IntegrationsIpcContract[C]['res'];

export async function intInvoke<C extends IntChannel>(channel: C, req: IntReq<C>): Promise<IntRes<C>> {
  const r = await (window.api.invoke as unknown as LooseInvoke)(channel, req);
  if (r.ok) return r.data as IntRes<C>;
  throw new IpcError(r.error);
}

export function intOn<E extends keyof IntegrationsEventContract>(
  event: E,
  cb: (payload: IntegrationsEventContract[E]) => void,
): () => void {
  return (window.api.on as unknown as LooseOn)(event, cb as (p: unknown) => void);
}

/** Friendly description of any thrown value (IpcError with providerCode or plain Error). */
export function friendlyError(e: unknown): FriendlyError {
  if (e instanceof IpcError) return describeProviderError(e.error, Date.now());
  return describeProviderError({ message: e instanceof Error ? e.message : String(e) }, Date.now());
}

export const errorLine = (e: unknown): string => {
  const f = friendlyError(e);
  return f.detail ? `${f.title} — ${f.detail}` : f.title;
};

/** Ask the app shell to open Preferences → Integrations. */
export function openIntegrationsPreferences(): void {
  window.dispatchEvent(new CustomEvent('kl:open-preferences', { detail: 'Integrations' }));
}

export function openExternal(url: string): void {
  void invoke('shell:openExternal', { url });
}

export function copyText(text: string): void {
  void invoke('shell:copyText', { text });
}
