import type { IpcResult } from '@githappens/git/types';

import type { NetworkIpcContract } from '../../../../shared/ipc/network-contract';
import { IpcError } from '../../lib/api';

/**
 * Typed access to the SSH / credentials / proxy channels (spec 09 §5). Goes through `window.api` like
 * `invoke` in lib/api.ts, typed against the network contract directly.
 */

type LooseInvoke = (channel: string, req: unknown) => Promise<IpcResult<unknown>>;

export type NetChannel = keyof NetworkIpcContract;
export type NetReq<C extends NetChannel> = NetworkIpcContract[C]['req'];
export type NetRes<C extends NetChannel> = NetworkIpcContract[C]['res'];

export async function netInvoke<C extends NetChannel>(channel: C, req: NetReq<C>): Promise<NetRes<C>> {
  const r = await (window.api.invoke as unknown as LooseInvoke)(channel, req);
  if (r.ok) return r.data as NetRes<C>;
  throw new IpcError(r.error);
}

export const errorText = (e: unknown): string =>
  e instanceof IpcError ? e.error.message : e instanceof Error ? e.message : String(e);

/** Provider page where a public key is pasted when the API can't upload it (spec 10 §6.5 fallback). */
export function sshKeysPageUrl(kind: string, host: string): string | null {
  const h = host.split('/')[0] || host;
  switch (kind) {
    case 'github':
      return `https://${h || 'github.com'}/settings/ssh/new`;
    case 'gitlab':
      return `https://${h || 'gitlab.com'}/-/user_settings/ssh_keys`;
    case 'bitbucket':
      return 'https://bitbucket.org/account/settings/ssh-keys/';
    case 'bitbucket-dc':
      return `https://${h}/plugins/servlet/ssh/account/keys`;
    case 'azure-devops': {
      const org = host.split('/')[1];
      return org ? `https://dev.azure.com/${org}/_usersSettings/keys` : 'https://dev.azure.com/';
    }
    default:
      return null;
  }
}

/** Kinds whose API accepts SSH key uploads (`capabilities.sshKeyUpload`, spec 10 §5.3). */
export const SSH_UPLOAD_KINDS = new Set(['github', 'gitlab', 'bitbucket']);
export const HOSTING_KINDS = new Set(['github', 'gitlab', 'bitbucket', 'bitbucket-dc', 'azure-devops']);

/** Host to `ssh -T` for a provider account. */
export function sshTestHost(kind: string, host: string): string {
  if (kind === 'azure-devops') return 'ssh.dev.azure.com';
  if (kind === 'bitbucket') return 'bitbucket.org';
  return host.split('/')[0] || host;
}
