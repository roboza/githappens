import type { NetworkIpcContract, SshKeyType } from '../../shared/ipc/network-contract';
import type { NetworkService } from '../network/network-service';
import type { CredentialService } from '../services/credentials';
import type { SshService } from '../ssh/ssh-service';
import type { HandlerContext } from './registry';

export type NetworkHandlers = {
  [C in keyof NetworkIpcContract]: (
    req: NetworkIpcContract[C]['req'],
    ctx: HandlerContext,
  ) => NetworkIpcContract[C]['res'] | Promise<NetworkIpcContract[C]['res']>;
};

export interface NetworkHandlerDeps {
  ssh: Pick<SshService, 'status' | 'generate' | 'publicKey' | 'testConnection'>;
  network: Pick<NetworkService, 'status' | 'setProxyAuth' | 'clearProxyAuth'>;
  credentials: Pick<CredentialService, 'list' | 'forget' | 'forgetAll'>;
}

const KEY_TYPES: readonly SshKeyType[] = ['ed25519', 'rsa-4096'];

function str(v: unknown, name: string, max = 4096): string {
  if (typeof v !== 'string' || v.length > max || v.includes('\0')) throw new Error(`Invalid ${name}`);
  return v;
}

function optStr(v: unknown, name: string, max = 4096): string | undefined {
  return v === undefined || v === null ? undefined : str(v, name, max);
}

/** SSH / credentials / proxy IPC (spec 09 §5, spec 13). Inputs are validated: the renderer is untrusted. */
export function createNetworkHandlers(d: NetworkHandlerDeps): NetworkHandlers {
  return {
    'ssh:status': () => d.ssh.status(),
    'ssh:key:generate': (req) => {
      if (!KEY_TYPES.includes(req?.type)) throw new Error('Invalid key type');
      return d.ssh.generate({
        type: req.type,
        comment: optStr(req.comment, 'comment', 256),
        passphrase: optStr(req.passphrase, 'passphrase', 1024),
        path: optStr(req.path, 'path'),
        useAsDefault: req.useAsDefault === true,
      });
    },
    'ssh:key:publicKey': (req) => d.ssh.publicKey(optStr(req?.path, 'path')),
    'ssh:testConnection': (req) => d.ssh.testConnection(str(req?.host, 'host', 300)),

    'cred:list': () => d.credentials.list(),
    'cred:forget': (req) => d.credentials.forget(str(req?.id, 'id', 1024)),
    'cred:forgetAll': () => ({ removed: d.credentials.forgetAll() }),

    'net:status': () => d.network.status(),
    'net:proxyAuth:set': (req) =>
      d.network.setProxyAuth(str(req?.username, 'username', 512), str(req?.password, 'password', 1024)),
    'net:proxyAuth:clear': () => d.network.clearProxyAuth(),
  };
}
