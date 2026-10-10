import { PatchCryptoError } from '@githappens/cloud-api/patch-crypto';
import { GitError, makeError } from '@githappens/git';

import type { PatchesIpcContract } from '../../shared/ipc/patches-contract';
import { CloudError } from '../cloud/cloud-http';
import type { PatchService } from '../cloud/patches/patch-service';
import type { HandlerContext } from './registry';

export type PatchesHandlers = {
  [C in keyof PatchesIpcContract]: (
    req: PatchesIpcContract[C]['req'],
    ctx: HandlerContext,
  ) => PatchesIpcContract[C]['res'] | Promise<PatchesIpcContract[C]['res']>;
};

const CLOUD_MESSAGES: Partial<Record<CloudError['code'], string>> = {
  gone: 'This Cloud Patch has expired or was deleted.',
  not_found: 'This Cloud Patch does not exist.',
  forbidden: 'You do not have access to this Cloud Patch.',
  unauthorized: 'Sign in to GitHappens Cloud to open this Cloud Patch.',
  signed_out: 'Sign in to GitHappens Cloud first.',
  not_configured: 'No GitHappens Cloud server is configured. Set one in Preferences → Account.',
  network: 'Could not reach the GitHappens Cloud server.',
  too_large: 'The patch is larger than the server allows. Push a branch instead.',
};

/**
 * Cloud failures become GitErrors with `details.cloudCode` (and `details.patchError` for decrypt/format
 * problems) so the renderer can explain them; the message never contains link keys.
 */
export function toPatchError(e: unknown): unknown {
  if (e instanceof CloudError) {
    const message = CLOUD_MESSAGES[e.code] ?? e.message;
    return new GitError(
      makeError('Unknown', { argv: [] }, message, {
        cloudCode: e.code,
        ...(e.status ? { status: e.status } : {}),
      }),
    );
  }
  if (e instanceof PatchCryptoError) {
    return new GitError(makeError('Unknown', { argv: [] }, e.message, { patchError: e.code }));
  }
  return e;
}

function wrap<A extends unknown[], R>(fn: (...a: A) => R | Promise<R>): (...a: A) => Promise<R> {
  return async (...a) => {
    try {
      return await fn(...a);
    } catch (e) {
      throw toPatchError(e);
    }
  };
}

/** Cloud Patches IPC (spec 14 §5.4). */
export function createPatchesHandlers(svc: PatchService): PatchesHandlers {
  return {
    'patch:availability': wrap(() => svc.availability()),
    'patch:preview': wrap(({ repoId, source }) => svc.preview(repoId, source)),
    'patch:create': wrap((req) => svc.create(req)),
    'patch:list': wrap((req) => svc.list(req)),
    'patch:get': wrap(({ id }) => svc.get(id)),
    'patch:update': wrap((req) => svc.update(req)),
    'patch:delete': wrap(({ id }) => svc.delete(id)),
    'patch:open': wrap(({ url, allowOtherServer }) => svc.open(url, allowOtherServer)),
    'patch:checkRepo': wrap(({ patchId, repoId }) => svc.checkRepo(patchId, repoId)),
    'patch:fetchBase': wrap(({ patchId, repoId }) => svc.fetchBase(patchId, repoId)),
    'patch:apply': wrap((req) => svc.apply(req)),
    'patch:collaboratorCandidates': wrap(({ orgId }) => svc.collaboratorCandidates(orgId)),
  };
}
