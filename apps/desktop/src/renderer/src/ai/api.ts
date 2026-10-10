import type { IpcResult } from '@githappens/git/types';

import type { AiError, AiEventContract, AiIpcContract } from '../../../shared/ipc/ai-contract';
import { IpcError } from '../lib/api';

/**
 * Typed access to the AI IPC channels (spec 12 §5), through `window.api` like lib/api.ts but typed
 * against the AI contract directly. API keys only ever go out (`ai:key:set`); nothing returns them.
 */

type LooseInvoke = (channel: string, req: unknown) => Promise<IpcResult<unknown>>;
type LooseOn = (event: string, cb: (payload: unknown) => void) => () => void;

export type AiChannel = keyof AiIpcContract;

export async function aiInvoke<C extends AiChannel>(
  channel: C,
  req: AiIpcContract[C]['req'],
): Promise<AiIpcContract[C]['res']> {
  const r = await (window.api.invoke as unknown as LooseInvoke)(channel, req);
  if (r.ok) return r.data as AiIpcContract[C]['res'];
  throw new IpcError(r.error);
}

export function aiOn<E extends keyof AiEventContract>(
  event: E,
  cb: (payload: AiEventContract[E]) => void,
): () => void {
  try {
    return (window.api.on as unknown as LooseOn)(event, cb as (p: unknown) => void);
  } catch (e) {
    // Channel not allowlisted by this preload build (AI contract not merged yet).
    console.warn(`[ai] cannot subscribe to ${event}:`, e);
    return () => undefined;
  }
}

export function newRequestId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `ai-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Ask the app shell to open Preferences → AI. */
export function openAiPreferences(): void {
  window.dispatchEvent(new CustomEvent('kl:open-preferences', { detail: 'AI' }));
}

/** One-line, user-facing text for an AI error. */
export function describeAiError(e: AiError | null | undefined): string {
  if (!e) return '';
  switch (e.code) {
    case 'rate-limit':
      return e.retryAfterMs ? `${e.message} (retry in ${Math.ceil(e.retryAfterMs / 1000)}s)` : e.message;
    case 'too-large':
      return `${e.message}`;
    default:
      return e.message;
  }
}

/** Errors whose fix is in Preferences → AI. */
export const needsSettings = (e: AiError | null | undefined): boolean =>
  !!e && (e.code === 'no-key' || e.code === 'auth' || e.code === 'provider');
