import type { IpcResult, RepoId } from '@githappens/git/types';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import type {
  PatchAvailability,
  PatchesEventContract,
  PatchesIpcContract,
} from '../../../shared/ipc/patches-contract';
import { invoke, IpcError } from '../lib/api';

/**
 * Typed access to the Cloud Patches IPC channels (spec 14 §5.4 `patch:*`). Goes through `window.api` like
 * `invoke` in lib/api.ts, typed against the patches contract directly.
 */

type LooseInvoke = (channel: string, req: unknown) => Promise<IpcResult<unknown>>;
type LooseOn = (event: string, cb: (payload: unknown) => void) => () => void;

export type PatchChannel = keyof PatchesIpcContract;

export async function patchInvoke<C extends PatchChannel>(
  channel: C,
  req: PatchesIpcContract[C]['req'],
): Promise<PatchesIpcContract[C]['res']> {
  const r = await (window.api.invoke as unknown as LooseInvoke)(channel, req);
  if (r.ok) return r.data as PatchesIpcContract[C]['res'];
  throw new IpcError(r.error);
}

/** Subscribe to a patches event; a no-op while the channel is not allowlisted. */
export function patchOn<E extends keyof PatchesEventContract>(
  event: E,
  cb: (payload: PatchesEventContract[E]) => void,
): () => void {
  try {
    return (window.api.on as unknown as LooseOn)(event, cb as (p: unknown) => void);
  } catch {
    return () => undefined;
  }
}

export const patchKeys = {
  all: ['cloudPatches'] as const,
  availability: ['cloudPatches', 'availability'] as const,
  list: (scope: 'mine' | 'shared', repoId?: RepoId) =>
    ['cloudPatches', 'list', scope, repoId ?? null] as const,
};

const UNAVAILABLE: PatchAvailability = {
  configured: false,
  signedIn: false,
  serverUrl: null,
  orgs: [],
  activeOrgId: null,
};

/** Invalidate every Cloud Patches query on `patch:changed` (create/update/delete, sign-in/out). */
export function usePatchEvents(): void {
  const qc = useQueryClient();
  useEffect(
    () => patchOn('patch:changed', () => void qc.invalidateQueries({ queryKey: patchKeys.all })),
    [qc],
  );
}

let lastAvailability: PatchAvailability = UNAVAILABLE;

/** Fetch availability (errors, e.g. the channel not wired yet, read as "unavailable") and cache it. */
export async function fetchPatchAvailability(): Promise<PatchAvailability> {
  lastAvailability = await patchInvoke('patch:availability', {}).catch(() => UNAVAILABLE);
  return lastAvailability;
}

/** Last known availability, for synchronous menus (refreshed by `usePatchAvailability`). */
export const cachedPatchAvailability = (): PatchAvailability => lastAvailability;

/** Server configured / signed in. */
export function usePatchAvailability(): PatchAvailability {
  usePatchEvents();
  const q = useQuery({
    queryKey: patchKeys.availability,
    queryFn: fetchPatchAvailability,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
  return q.data ?? UNAVAILABLE;
}

export function usePatchList(scope: 'mine' | 'shared', repoId: RepoId | undefined, enabled: boolean) {
  return useQuery({
    queryKey: patchKeys.list(scope, repoId),
    queryFn: () => patchInvoke('patch:list', { scope, ...(repoId ? { repoId } : {}) }),
    enabled,
    staleTime: 30_000,
  });
}

/** Why sharing is unavailable, or null when it is possible. */
export function shareBlockedReason(a: PatchAvailability): string | null {
  if (!a.configured) return 'Cloud Patches need a GitHappens Cloud server (Preferences → Account).';
  if (!a.signedIn) return 'Sign in to GitHappens Cloud to share Cloud Patches.';
  return null;
}

export function errorText(e: unknown): string {
  if (e instanceof IpcError) return e.error.message;
  return e instanceof Error ? e.message : String(e);
}

/** Details code from a failed patch call (`cloudCode`, `patchError`, `patchApply`). */
export function errorDetail(e: unknown, key: 'cloudCode' | 'patchError' | 'patchApply'): string | undefined {
  if (!(e instanceof IpcError)) return undefined;
  const v = e.error.details?.[key];
  return typeof v === 'string' ? v : undefined;
}

export function copyText(text: string): void {
  void invoke('shell:copyText', { text });
}

/** Ask the app shell to open Preferences on the Account page (cloud sign-in). */
export function openAccountPreferences(): void {
  window.dispatchEvent(new CustomEvent('kl:open-preferences', { detail: 'Account' }));
}
