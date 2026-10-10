import { randomUUID } from 'node:crypto';

import { hookInfo, KNOWN_HOOKS, pushPreview, type GitService, type RepoId } from '@githappens/git';

import type { SyncIpcContract } from '../../shared/ipc/sync-contract';
import type { HandlerContext } from './registry';

export type SyncHandlers = {
  [C in keyof SyncIpcContract]: (
    req: SyncIpcContract[C]['req'],
    ctx: HandlerContext,
  ) => SyncIpcContract[C]['res'] | Promise<SyncIpcContract[C]['res']>;
};

export interface SyncHandlerDeps {
  repos: { get(repoId: RepoId): GitService };
  /**
   * Askpass / credential env for the preview's `ls-remote` + fetch (CredentialService `envFor` / `finish`,
   * same as ops). Optional: without it the preview relies on credential helpers / SSH agent only.
   */
  credentials?: {
    envFor(opId: string, background: boolean): Record<string, string>;
    finish(opId: string, errorCode?: string): void;
  };
}

/** Sync safety reads (spec 09 §5 `git:push:preview`, §6.12 hook discovery). */
export function createSyncHandlers(d: SyncHandlerDeps): SyncHandlers {
  return {
    'git:push:preview': async ({ repoId, localRef, remote, remoteBranch }) => {
      const svc = d.repos.get(repoId);
      const opId = `push-preview-${randomUUID()}`;
      const env = d.credentials?.envFor(opId, false) ?? {};
      let code: string | undefined;
      try {
        return await pushPreview(svc, { localRef, remote, remoteBranch }, { env });
      } catch (e) {
        code = (e as { code?: string }).code ?? 'Unknown';
        throw e;
      } finally {
        d.credentials?.finish(opId, code);
      }
    },
    'sync:hooks': ({ repoId, names }) => hookInfo(d.repos.get(repoId), names?.length ? names : KNOWN_HOOKS),
  };
}
