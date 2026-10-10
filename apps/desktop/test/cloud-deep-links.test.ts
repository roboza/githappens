import { describe, expect, it, vi } from 'vitest';

import {
  deepLinksFromArgv,
  installDeepLinks,
  isDeepLinkArg,
  parseDeepLink,
} from '../src/main/cloud/deep-links';
import { createCloudHandlers, toIpcCloudError } from '../src/main/ipc/cloud-handlers';
import { CloudError } from '../src/main/cloud/cloud-http';
import { CLOUD_EVENT_CHANNELS, CLOUD_INVOKE_CHANNELS } from '../src/shared/ipc/cloud-contract';
import type { CloudServices } from '../src/main/cloud';
import { GitError } from '@githappens/git';

describe('parseDeepLink', () => {
  it('routes invite, patch and suggestion links', () => {
    expect(parseDeepLink('githappens://invite/abcDEF123_-xyz')).toEqual({
      kind: 'invite',
      token: 'abcDEF123_-xyz',
      url: 'githappens://invite/abcDEF123_-xyz',
    });
    expect(parseDeepLink('githappens://invite/abcDEF123_-xyz/')).toMatchObject({ kind: 'invite' });
    expect(parseDeepLink('GITHAPPENS://patch/4fZk2Qy8sP1mNc7xVb3Ht9#k=secretKey')).toEqual({
      kind: 'patch',
      id: '4fZk2Qy8sP1mNc7xVb3Ht9',
      url: 'GITHAPPENS://patch/4fZk2Qy8sP1mNc7xVb3Ht9#k=secretKey',
    });
    expect(parseDeepLink('githappens://suggestion/abcdef12')).toMatchObject({
      kind: 'suggestion',
      id: 'abcdef12',
    });
  });

  it('rejects anything else', () => {
    for (const bad of [
      'https://invite/abcdefgh',
      'githappens://invite/short',
      'githappens://invite/abc/def/ghi',
      'githappens://unknown/abcdefgh',
      'githappens://invite/<script>alert(1)</script>',
      'githappens://',
      'C:\\repo',
    ]) {
      expect(parseDeepLink(bad), bad).toBeNull();
    }
  });

  it('finds links in argv', () => {
    const argv = ['C:\\GitHappens.exe', '--flag', 'githappens://invite/abcdefgh12'];
    expect(deepLinksFromArgv(argv)).toHaveLength(1);
    expect(argv.filter((a) => !isDeepLinkArg(a))).toEqual(['C:\\GitHappens.exe', '--flag']);
  });
});

describe('installDeepLinks', () => {
  function fakeApp(isPackaged: boolean) {
    const listeners: Array<(e: { preventDefault(): void }, url: string) => void> = [];
    return {
      isPackaged,
      setAsDefaultProtocolClient: vi.fn(() => true),
      on: vi.fn((_ev: 'open-url', l: (e: { preventDefault(): void }, url: string) => void) =>
        listeners.push(l),
      ),
      openUrl: (url: string) => listeners.forEach((l) => l({ preventDefault: () => undefined }, url)),
    };
  }

  it('registers the protocol (dev args on Windows) and buffers links until a handler exists', () => {
    const app = fakeApp(false);
    const dl = installDeepLinks({
      app,
      argv: ['electron.exe', '.', 'githappens://invite/abcdefgh12'],
      execPath: 'electron.exe',
      platform: 'win32',
    });
    expect(app.setAsDefaultProtocolClient).toHaveBeenCalledWith('githappens', 'electron.exe', [
      expect.stringMatching(/\S/),
    ]);
    const got: unknown[] = [];
    app.openUrl('githappens://patch/abcdefgh#k=1');
    dl.setHandler((l) => got.push(l.kind));
    expect(got).toEqual(['invite', 'patch']);
    expect(dl.handleArgv(['x', 'githappens://suggestion/abcdefgh'])).toBe(true);
    expect(dl.handleArgv(['x', '--path', 'C:\\r'])).toBe(false);
    expect(got).toEqual(['invite', 'patch', 'suggestion']);
  });

  it('registers without arguments when packaged', () => {
    const app = fakeApp(true);
    installDeepLinks({ app, argv: ['GitHappens.exe'], platform: 'win32', onLink: () => undefined });
    expect(app.setAsDefaultProtocolClient).toHaveBeenCalledWith('githappens');
  });
});

describe('cloud IPC handlers', () => {
  it('implement every cloud channel and map CloudError to cloudCode', async () => {
    const svc = {
      client: {
        status: () => ({}),
        signOut: async () => Promise.reject(new CloudError('network', 'offline')),
      },
      sync: {},
      orgs: {},
      takeDeepLinks: () => [],
    } as unknown as CloudServices;
    const h = createCloudHandlers(svc);
    expect(Object.keys(h).sort()).toEqual([...CLOUD_INVOKE_CHANNELS].sort());
    expect(CLOUD_EVENT_CHANNELS).toEqual(['cloud:sessionChanged', 'sync:statusChanged', 'cloud:deepLink']);
    const err = await Promise.resolve(h['cloud:signOut']({}, { senderId: 1 })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).serialized.details).toMatchObject({ cloudCode: 'network' });
    expect(toIpcCloudError(new Error('x'))).toBeInstanceOf(Error);
    await expect(
      Promise.resolve(h['cloud:signIn']({ idp: 'evil' as never }, { senderId: 1 })),
    ).rejects.toThrow(/Unknown sign-in provider/);
  });
});
