import type { IpcResult } from '@githappens/git/types';

import type { FilesEventContract, FilesIpcContract } from '../../../../shared/ipc/files-contract';
import { IpcError } from '../../lib/api';

// The spec 07 channels live in `files-contract.ts` and are merged into the main contract by main/index;
// these wrappers keep renderer code typed against the files contract either way (same as prefsInvoke).

type LooseInvoke = (channel: string, req: unknown) => Promise<IpcResult<unknown>>;
type LooseOn = (event: string, cb: (payload: unknown) => void) => () => void;

export async function filesInvoke<C extends keyof FilesIpcContract>(
  channel: C,
  req: FilesIpcContract[C]['req'],
): Promise<FilesIpcContract[C]['res']> {
  const r = await (window.api.invoke as unknown as LooseInvoke)(channel, req);
  if (r.ok) return r.data as FilesIpcContract[C]['res'];
  throw new IpcError(r.error);
}

export function filesOn<E extends keyof FilesEventContract>(
  event: E,
  cb: (payload: FilesEventContract[E]) => void,
): () => void {
  try {
    return (window.api.on as unknown as LooseOn)(event, cb as (p: unknown) => void);
  } catch (e) {
    console.warn(`[files] cannot subscribe to ${event}:`, e);
    return () => undefined;
  }
}

export {
  INDEX,
  revisionUrl,
  WORKTREE,
  type FileEncoding,
  type FileHistoryEntry,
  type WorktreeFileRead,
} from '../../../../shared/ipc/files-contract';
