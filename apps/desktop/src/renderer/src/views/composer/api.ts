import type { RepoId } from '@githappens/git/types';

import type { CommitEventContract, CommitIpcContract } from '../../../../shared/ipc/commit-contract';
import { HOOK_OUTPUT_PHASE } from '../../../../shared/ipc/commit-contract';
import { IpcError, on } from '../../lib/api';

type Channel = keyof CommitIpcContract;

interface LooseApi {
  invoke(channel: string, req: unknown): Promise<{ ok: true; data: unknown } | { ok: false; error: never }>;
  on(event: string, cb: (payload: unknown) => void): () => void;
}
const api = (): LooseApi => (window as unknown as { api: LooseApi }).api;

/**
 * Typed invoke for the composer channels (`shared/ipc/commit-contract.ts`). Kept separate from
 * `lib/api.invoke` so this module type-checks whether or not the channels are merged into the root
 * contract yet; unknown channels reject (callers degrade gracefully).
 */
export async function commitInvoke<C extends Channel>(
  channel: C,
  req: CommitIpcContract[C]['req'],
): Promise<CommitIpcContract[C]['res']> {
  const r = await api().invoke(channel, req);
  if (r.ok) return r.data as CommitIpcContract[C]['res'];
  throw new IpcError(r.error);
}

/** `commitInvoke` that resolves `fallback` on any failure (channel not wired, repo closed, …). */
export function commitInvokeOr<C extends Channel>(
  channel: C,
  req: CommitIpcContract[C]['req'],
  fallback: CommitIpcContract[C]['res'],
): Promise<CommitIpcContract[C]['res']> {
  return commitInvoke(channel, req).catch(() => fallback);
}

/**
 * Hook output while a commit runs (spec 06 §4.6): `commit:hookOutput` when main forwards it, else the
 * `git:progress` events with the `hook-output` phase that `commit.create` emits.
 */
export function onHookOutput(
  repoId: RepoId,
  cb: (e: CommitEventContract['commit:hookOutput']) => void,
): () => void {
  try {
    return api().on('commit:hookOutput', (p) => {
      const e = p as CommitEventContract['commit:hookOutput'];
      if (e.repoId === repoId) cb(e);
    });
  } catch {
    return on('git:progress', (p) => {
      if (p.repoId === repoId && p.phase === HOOK_OUTPUT_PHASE)
        cb({ repoId, opId: p.opId, chunk: p.text, stream: 'err' });
    });
  }
}
