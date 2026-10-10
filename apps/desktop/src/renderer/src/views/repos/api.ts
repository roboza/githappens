import type { Repos2IpcContract } from '../../../../shared/ipc/repos2-contract';
import { IpcError } from '../../lib/api';

type C = keyof Repos2IpcContract;

/**
 * Typed invoke for the repository-management channels (`shared/ipc/repos2-contract.ts`); unwraps the
 * `IpcResult` like `lib/api.invoke`.
 */
export async function reposInvoke<K extends C>(
  channel: K,
  req: Repos2IpcContract[K]['req'],
): Promise<Repos2IpcContract[K]['res']> {
  const raw = window.api.invoke as unknown as (
    c: string,
    r: unknown,
  ) => Promise<
    | { ok: true; data: Repos2IpcContract[K]['res'] }
    | { ok: false; error: ConstructorParameters<typeof IpcError>[0] }
  >;
  const r = await raw(channel, req);
  if (r.ok) return r.data;
  throw new IpcError(r.error);
}

export const errorText = (e: unknown): string =>
  e instanceof IpcError ? e.error.message : e instanceof Error ? e.message : String(e);
