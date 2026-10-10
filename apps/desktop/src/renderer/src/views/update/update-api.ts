import type { IpcResult } from '@githappens/git/types';
import { useEffect, useState } from 'react';

import type {
  UpdateEventContract,
  UpdateIpcContract,
  UpdateStatus,
  WhatsNew,
} from '../../../../shared/ipc/update-contract';
import { invoke, IpcError } from '../../lib/api';

// Typed against the update contract whether or not it has been merged into the main contract yet.
type LooseInvoke = (channel: string, req: unknown) => Promise<IpcResult<unknown>>;
type LooseOn = (event: string, cb: (payload: unknown) => void) => () => void;

export async function updateInvoke<C extends keyof UpdateIpcContract>(
  channel: C,
  req: UpdateIpcContract[C]['req'],
): Promise<UpdateIpcContract[C]['res']> {
  const r = await (window.api.invoke as unknown as LooseInvoke)(channel, req);
  if (r.ok) return r.data as UpdateIpcContract[C]['res'];
  throw new IpcError(r.error);
}

export function updateOn<E extends keyof UpdateEventContract>(
  event: E,
  cb: (payload: UpdateEventContract[E]) => void,
): () => void {
  try {
    return (window.api.on as unknown as LooseOn)(event, cb as (p: unknown) => void);
  } catch (e) {
    console.warn(`[update] cannot subscribe to ${event}:`, e);
    return () => undefined;
  }
}

export const errorText = (e: unknown): string =>
  e instanceof IpcError ? e.error.message : e instanceof Error ? e.message : String(e);

export function openExternal(url: string): void {
  if (!/^https?:\/\//i.test(url)) return;
  invoke('shell:openExternal', { url }).catch((e: unknown) => console.warn('[update] openExternal', e));
}

/** Live `UpdateStatus` (initial fetch + `update:status` events). `null` until known / unavailable. */
export function useUpdateStatus(): UpdateStatus | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    let alive = true;
    const off = updateOn('update:status', (s) => {
      if (alive) setStatus(s);
    });
    updateInvoke('update:status', {})
      .then((s) => {
        if (alive) setStatus((cur) => cur ?? s);
      })
      .catch(() => undefined); // channel not wired (dev) → stays null
    return () => {
      alive = false;
      off();
    };
  }, []);
  return status;
}

let whatsNewOnce: Promise<WhatsNew | null> | null = null;
/** The post-update release notes; fetched once per renderer so React StrictMode can't consume them twice. */
export function fetchWhatsNewOnce(): Promise<WhatsNew | null> {
  whatsNewOnce ??= updateInvoke('update:whatsNew', {}).catch(() => null);
  return whatsNewOnce;
}
