import { GitError, makeError } from '@githappens/git';

import {
  SYNC_DATA_CATEGORIES,
  type CloudIpcContract,
  type SyncDataCategory,
} from '../../shared/ipc/cloud-contract';
import type { CloudServices } from '../cloud';
import { CloudError } from '../cloud/cloud-http';
import { SyncKeyError } from '../cloud/sync/crypto';
import type { HandlerContext } from './registry';

export type CloudHandlers = {
  [C in keyof CloudIpcContract]: (
    req: CloudIpcContract[C]['req'],
    ctx: HandlerContext,
  ) => CloudIpcContract[C]['res'] | Promise<CloudIpcContract[C]['res']>;
};

/** Cloud failures → IPC errors; the UI reads `details.cloudCode` (spec 14 §5.4). */
export function toIpcCloudError(e: unknown): unknown {
  if (e instanceof CloudError) {
    const details: Record<string, string | number> = { cloudCode: e.code };
    if (e.status) details.status = e.status;
    return new GitError(makeError('Unknown', { argv: [] }, e.message, details));
  }
  if (e instanceof SyncKeyError) {
    return new GitError(makeError('Unknown', { argv: [] }, e.message, { cloudCode: e.code }));
  }
  return e;
}

const IDPS = new Set(['github', 'gitlab', 'google', 'email', 'dev']);

function str(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`Invalid ${name}`);
  return v;
}

function category(v: unknown): SyncDataCategory {
  if (!SYNC_DATA_CATEGORIES.includes(v as SyncDataCategory)) throw new Error('Unknown sync category');
  return v as SyncDataCategory;
}

/**
 * Account / settings sync / organizations IPC (spec 14 §5.4). Tokens, the sync key and
 * passphrases only ever flow renderer → main; only the recovery key is returned (to be shown).
 */
export function createCloudHandlers(svc: CloudServices): CloudHandlers {
  const { client, sync, orgs } = svc;
  const wrap =
    <A extends unknown[], R>(fn: (...a: A) => R | Promise<R>) =>
    async (...a: A): Promise<R> => {
      try {
        return await fn(...a);
      } catch (e) {
        throw toIpcCloudError(e);
      }
    };

  const handlers: CloudHandlers = {
    // ---- account ----
    'cloud:state': () => client.status(),
    'cloud:validateServer': ({ url }) => client.validateServer(str(url, 'server URL')),
    'cloud:serverInfo': ({ refresh }) => client.serverInfo(!!refresh),
    'cloud:signIn': ({ idp, loginHint }) => {
      if (!IDPS.has(idp)) throw new Error('Unknown sign-in provider');
      return client.signIn(idp, { loginHint: typeof loginHint === 'string' ? loginHint : undefined });
    },
    'cloud:cancelSignIn': () => client.cancelSignIn(),
    'cloud:signOut': () => client.signOut(),
    'cloud:session': () => client.session(),
    'cloud:refresh': () => client.refreshMe(),
    'cloud:setActiveOrg': ({ orgId }) => client.setActiveOrg(str(orgId, 'organization')),
    'cloud:deleteAccount': () => client.deleteAccount(),
    'cloud:takeDeepLinks': ({ kinds }) => svc.takeDeepLinks(Array.isArray(kinds) ? kinds : undefined),
    'cloud:inspectCertificate': ({ url }) => svc.serverTrust.inspect(str(url, 'server URL')),
    'cloud:trustCertificate': ({ url, fingerprint256 }) =>
      svc.serverTrust.trust(str(url, 'server URL'), str(fingerprint256, 'fingerprint')),
    'cloud:untrustCertificate': ({ url }) => svc.serverTrust.untrust(str(url, 'server URL')),
    'cloud:trustedCertificates': () =>
      svc.serverTrust.list().map((p) => ({
        origin: p.origin,
        fingerprint256: p.fingerprint256,
        subject: p.subject,
        validTo: p.validTo,
        addedAt: p.addedAt,
      })),

    // ---- settings sync ----
    'sync:status': () => sync.status(),
    'sync:setEnabled': (req) => sync.setEnabled(req ?? {}),
    'sync:now': () => sync.syncNow(),
    'sync:resolveConflict': ({ category: c, keep }) => {
      if (keep !== 'local' && keep !== 'remote') throw new Error('Invalid choice');
      return sync.resolveConflict(category(c), keep);
    },
    'sync:setupPassphrase': ({ passphrase }) => sync.setupPassphrase(passphrase),
    'sync:unlock': ({ passphrase, recoveryKey }) =>
      sync.unlock(
        recoveryKey ? { recoveryKey: str(recoveryKey, 'recovery key') } : { passphrase: passphrase ?? '' },
      ),
    'sync:exportRecoveryKey': ({ regenerate }) => sync.exportRecoveryKey(!!regenerate),
    'sync:reset': ({ passphrase }) => sync.reset(passphrase),
    'sync:deleteCloudData': () => sync.deleteCloudData(),
    'sync:dismissReconnect': ({ key }) => sync.dismissReconnect(str(key, 'key')),

    // ---- organizations ----
    'org:create': ({ name, slug }) => orgs.create(name, slug),
    'org:get': ({ orgId }) => orgs.get(orgId),
    'org:rename': ({ orgId, name }) => orgs.rename(orgId, name),
    'org:delete': ({ orgId }) => orgs.delete(orgId),
    'org:setPolicies': ({ orgId, policies }) => orgs.setPolicies(orgId, policies ?? {}),
    'org:setRole': ({ orgId, userId, role }) => orgs.setRole(orgId, userId, role),
    'org:removeMember': ({ orgId, userId }) => orgs.removeMember(orgId, userId),
    'org:leave': ({ orgId }) => orgs.leave(orgId),
    'org:invite': ({ orgId, email, role }) => orgs.invite(orgId, email, role),
    'org:invites': ({ orgId }) => orgs.invites(orgId),
    'org:revokeInvite': ({ orgId, inviteId }) => orgs.revokeInvite(orgId, inviteId),
    'org:acceptInvite': ({ token }) => orgs.acceptInvite(token),
    'org:teams': ({ orgId }) => orgs.teams(orgId),
    'org:createTeam': ({ orgId, name }) => orgs.createTeam(orgId, name),
    'org:renameTeam': ({ orgId, teamId, name }) => orgs.renameTeam(orgId, teamId, name),
    'org:deleteTeam': ({ orgId, teamId }) => orgs.deleteTeam(orgId, teamId),
    'org:setTeamMembers': ({ orgId, teamId, userIds }) => orgs.setTeamMembers(orgId, teamId, userIds),
  };

  return Object.fromEntries(
    Object.entries(handlers).map(([k, fn]) => [k, wrap(fn as (...a: unknown[]) => unknown)]),
  ) as CloudHandlers;
}
