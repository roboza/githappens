import type { IpcResult } from '@githappens/git/types';

import type { CloudEventContract, CloudIpcContract } from '../../../shared/ipc/cloud-contract';
import { invoke, IpcError } from '../lib/api';

/**
 * Typed access to the account / sync / organization IPC channels (spec 14 §5.4), going through
 * `window.api` like the integrations wrapper. Cloud failures carry `details.cloudCode`.
 */

type LooseInvoke = (channel: string, req: unknown) => Promise<IpcResult<unknown>>;
type LooseOn = (event: string, cb: (payload: unknown) => void) => () => void;

export type CloudChannel = keyof CloudIpcContract;
export type CloudReq<C extends CloudChannel> = CloudIpcContract[C]['req'];
export type CloudRes<C extends CloudChannel> = CloudIpcContract[C]['res'];

export async function cloudInvoke<C extends CloudChannel>(
  channel: C,
  req: CloudReq<C>,
): Promise<CloudRes<C>> {
  const r = await (window.api.invoke as unknown as LooseInvoke)(channel, req);
  if (r.ok) return r.data as CloudRes<C>;
  throw new IpcError(r.error);
}

export function cloudOn<E extends keyof CloudEventContract>(
  event: E,
  cb: (payload: CloudEventContract[E]) => void,
): () => void {
  try {
    return (window.api.on as unknown as LooseOn)(event, cb as (p: unknown) => void);
  } catch (e) {
    // Channel not allowlisted by this preload build yet.
    console.warn(`[cloud] cannot subscribe to ${event}:`, e);
    return () => undefined;
  }
}

/** CloudError code of a failed call ('network', 'signed_out', 'precondition_failed', …). */
export function cloudCode(e: unknown): string | undefined {
  if (!(e instanceof IpcError)) return undefined;
  const c = e.error.details?.cloudCode;
  return typeof c === 'string' ? c : undefined;
}

export function cloudErrorText(e: unknown): string {
  const code = cloudCode(e);
  const msg = e instanceof IpcError ? e.error.message : e instanceof Error ? e.message : String(e);
  if (code === 'network') return `You appear to be offline. ${msg}`;
  if (code === 'forbidden') return `You don't have permission to do that. ${msg}`;
  return msg;
}

/** Open Preferences at a section (handled by App). */
export function openPreferencesAt(section: 'Account' | 'Integrations'): void {
  window.dispatchEvent(new CustomEvent('kl:open-preferences', { detail: section }));
}

export function copyText(text: string): void {
  void invoke('shell:copyText', { text });
}

/** "2m ago" style relative time for ISO strings. */
export function relativeTime(iso: string | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'never';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
