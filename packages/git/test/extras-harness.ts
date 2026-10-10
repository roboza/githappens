import { createExtrasRegistry } from '../src/ops/executors/extras';
import { OperationQueue, type QueueHooks } from '../src/ops/queue';
import type { GitOperation, OpResult } from '../src/ops/types';
import type { GitService } from '../src/service/git-service';
import type { SerializedGitError } from '../src/types';
import { GitError } from '../src/errors/classify';

const registry = createExtrasRegistry();

/** Run one extras op through a fresh OperationQueue. */
export function runExtra(svc: GitService, op: GitOperation, hooks?: QueueHooks): Promise<OpResult> {
  return new OperationQueue(svc, registry, hooks).enqueue(op).done;
}

/** Run an extras op that must fail; returns the serialized error. */
export async function failExtra(svc: GitService, op: GitOperation): Promise<SerializedGitError> {
  try {
    await runExtra(svc, op);
  } catch (e) {
    if (e instanceof GitError) return e.serialized;
    throw e;
  }
  throw new Error(`expected ${op.type} to fail`);
}
