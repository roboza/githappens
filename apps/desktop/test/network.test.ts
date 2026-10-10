import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { findOnPath, GitProcessRunner } from '@githappens/git';
import { afterAll, describe, expect, it } from 'vitest';

import { createNetworkHandlers } from '../src/main/ipc/network-handlers';
import { createNetBackedFetch } from '../src/main/network/app-fetch';
import { createCertificateVerifyProc, gitTlsConfig, pemBodies } from '../src/main/network/certs';
import {
  combineInvocation,
  createConnectivityServices,
  type ConnectivitySettings,
} from '../src/main/network';
import { NetworkService, type NetworkPrefs } from '../src/main/network/network-service';
import {
  chromiumBypassRules,
  curlNoProxy,
  gitProxyConfig,
  parsePacResult,
  redactProxyUrl,
  sessionProxyConfig,
  withProxyAuth,
} from '../src/main/network/proxy';
import type { SecretStore } from '../src/main/secrets/secret-store';
import { NETWORK_INVOKE_CHANNELS } from '../src/shared/ipc/network-contract';
import { defaultValues, type SettingKey } from '../src/shared/settings/registry';

class MemorySecrets implements SecretStore {
  readonly available = true;
  readonly backend = 'memory';
  readonly map = new Map<string, string>();
  get = (a: string): string | null => this.map.get(a) ?? null;
  set = (a: string, s: string): void => void this.map.set(a, s);
  delete = (a: string): boolean => this.map.delete(a);
  deleteByPrefix = (p: string): number => {
    let n = 0;
    for (const k of [...this.map.keys()]) if (k.startsWith(p) && this.map.delete(k)) n++;
    return n;
  };
  listAccounts = (p = ''): string[] => [...this.map.keys()].filter((k) => k.startsWith(p));
}

const base: NetworkPrefs = {
  mode: 'system',
  url: '',
  noProxy: [],
  useOsCertStore: false,
  caBundlePath: '',
  useCredentialHelpers: true,
};

describe('proxy helpers (spec 09 §6.11)', () => {
  it('parses Chromium / PAC results', () => {
    expect(parsePacResult('DIRECT')).toBeNull();
    expect(parsePacResult('PROXY proxy.corp:8080; DIRECT')).toBe('http://proxy.corp:8080');
    expect(parsePacResult('HTTPS secure:443')).toBe('https://secure:443');
    expect(parsePacResult('SOCKS5 s:1080')).toBe('socks5://s:1080');
    expect(parsePacResult('PROXY bad/host:1; PROXY ok:3128')).toBe('http://ok:3128');
    expect(parsePacResult('')).toBeNull();
  });

  it('adds percent-encoded credentials and redacts them', () => {
    const u = withProxyAuth('http://proxy:8080', { username: 'dom\\me', password: 'p@ss:w' });
    expect(u).toBe('http://dom%5Cme:p%40ss%3Aw@proxy:8080');
    expect(redactProxyUrl(u)).toBe('http://proxy:8080');
  });

  it('converts bypass lists for curl and Chromium', () => {
    expect(curlNoProxy(['*.corp.example', 'localhost', '<local>', 'bad host'])).toBe(
      '.corp.example,localhost',
    );
    expect(chromiumBypassRules(['*.corp.example'])).toBe('*.corp.example,<local>');
  });

  it('manual mode → HTTPS_PROXY/HTTP_PROXY/NO_PROXY with auth', () => {
    const c = gitProxyConfig(
      { ...base, mode: 'manual', url: 'http://p:3128', noProxy: ['*.internal'] },
      null,
      {
        username: 'u',
        password: 'pw',
      },
    );
    expect(c.env.HTTPS_PROXY).toBe('http://u:pw@p:3128');
    expect(c.env.HTTP_PROXY).toBe('http://u:pw@p:3128');
    expect(c.env.NO_PROXY).toBe('localhost,127.0.0.1,::1,.internal');
    expect(c.config).toEqual([]);
    expect(c.effective).toBe('http://p:3128');
  });

  it('system mode uses the resolved OS proxy, or leaves env alone for DIRECT', () => {
    expect(gitProxyConfig(base, 'http://sys:80', null).env.HTTPS_PROXY).toBe('http://sys:80');
    expect(gitProxyConfig(base, null, null)).toEqual({ env: {}, config: [], effective: null });
  });

  it('none mode clears proxy env and sets an empty http.proxy', () => {
    const c = gitProxyConfig({ ...base, mode: 'none' }, 'http://sys:80', null);
    expect(c.env).toEqual({ HTTPS_PROXY: null, HTTP_PROXY: null, ALL_PROXY: null, NO_PROXY: null });
    expect(c.config).toEqual([['http.proxy', '']]);
  });

  it('maps settings to Electron session proxy config', () => {
    expect(sessionProxyConfig(base)).toEqual({ mode: 'system' });
    expect(sessionProxyConfig({ ...base, mode: 'none' })).toEqual({ mode: 'direct' });
    expect(sessionProxyConfig({ ...base, mode: 'manual', url: 'http://u:p@h:1', noProxy: ['a.b'] })).toEqual({
      mode: 'fixed_servers',
      proxyRules: 'http://h:1',
      proxyBypassRules: 'a.b,<local>',
    });
  });
});

describe('TLS (spec 09 §6.11 Certificates)', () => {
  const exists = (p: string): boolean => p === '/ca.pem';
  it('maps OS store and CA bundle to git config', () => {
    expect(gitTlsConfig({ useOsCertStore: true, caBundlePath: '' }, 'win32', exists).config).toEqual([
      ['http.sslBackend', 'schannel'],
    ]);
    expect(gitTlsConfig({ useOsCertStore: true, caBundlePath: '' }, 'linux', exists).config).toEqual([]);
    expect(gitTlsConfig({ useOsCertStore: false, caBundlePath: '/ca.pem' }, 'linux', exists).config).toEqual([
      ['http.sslCAInfo', '/ca.pem'],
    ]);
    const both = gitTlsConfig({ useOsCertStore: true, caBundlePath: '/ca.pem' }, 'win32', exists);
    expect(both.config).toEqual([['http.sslBackend', 'schannel']]);
    expect(both.warnings[0]).toMatch(/Windows certificate store/);
    expect(
      gitTlsConfig({ useOsCertStore: false, caBundlePath: '/nope' }, 'linux', exists).warnings[0],
    ).toMatch(/does not exist/);
  });

  it('trusts chains containing a bundle certificate only when Chromium rejected them', () => {
    const pem = (b: string): string => `-----BEGIN CERTIFICATE-----\n${b}\n-----END CERTIFICATE-----\n`;
    const bundle = new Set(pemBodies(pem('QUJD') + pem('REVG')));
    expect([...bundle]).toEqual(['QUJD', 'REVG']);
    const proc = createCertificateVerifyProc(() => bundle);
    const codes: number[] = [];
    const leaf = { data: pem('TEVBRg=='), issuerCert: { data: pem('REVG') } };
    proc({ certificate: leaf, errorCode: -202 }, (c) => codes.push(c));
    proc({ certificate: leaf, errorCode: 0 }, (c) => codes.push(c));
    proc({ certificate: { data: pem('WFla') }, errorCode: -202 }, (c) => codes.push(c));
    expect(codes).toEqual([0, -3, -3]);
  });
});

describe('NetworkService', () => {
  it('resolves the system proxy through the session and injects it for git', async () => {
    const asked: string[] = [];
    const proxies: unknown[] = [];
    const svc = new NetworkService({
      prefs: () => base,
      profileId: () => 'p1',
      secrets: new MemorySecrets(),
      platform: 'linux',
      resolveProxy: async (u) => {
        asked.push(u);
        return 'PROXY sys.corp:8080';
      },
      setSessionProxy: async (c) => void proxies.push(c),
    });
    await svc.apply();
    expect(asked).toEqual(['https://github.com/']);
    expect(proxies).toEqual([{ mode: 'system' }]);
    expect(svc.gitConfig().env.HTTPS_PROXY).toBe('http://sys.corp:8080');
    const st = await svc.status();
    expect(st).toMatchObject({
      mode: 'system',
      gitProxy: 'http://sys.corp:8080',
      systemProxy: 'http://sys.corp:8080',
    });
  });

  it('stores proxy auth per host and never returns the password', async () => {
    const secrets = new MemorySecrets();
    let prefs: NetworkPrefs = {
      ...base,
      mode: 'manual',
      url: 'http://proxy:3128',
      useCredentialHelpers: false,
    };
    const svc = new NetworkService({ prefs: () => prefs, profileId: () => 'p1', secrets, platform: 'win32' });
    svc.setProxyAuth('me', 'pa ss');
    expect([...secrets.map.keys()]).toEqual(['p1/proxy/proxy:3128']);
    const g = svc.gitConfig();
    expect(g.env.HTTPS_PROXY).toBe('http://me:pa%20ss@proxy:3128');
    expect(g.config).toEqual([['credential.helper', '']]);
    const st = await svc.status();
    expect(st.proxyAuth).toEqual({ host: 'proxy:3128', username: 'me' });
    expect(JSON.stringify(st)).not.toContain('pa ss');
    expect(svc.proxyLogin({ isProxy: true, host: 'proxy', port: 3128 })).toEqual({
      username: 'me',
      password: 'pa ss',
    });
    expect(svc.proxyLogin({ isProxy: false, host: 'proxy', port: 3128 })).toBeNull();
    svc.clearProxyAuth();
    expect(secrets.map.size).toBe(0);
    prefs = { ...prefs, mode: 'none' };
    expect(() => svc.setProxyAuth('a', 'b')).toThrow(/No proxy/);
  });
});

describe('app HTTP through net.fetch', () => {
  it('routes http(s) to net.fetch without Chromium-managed headers, other schemes to the fallback', async () => {
    const seen: Array<[string, unknown]> = [];
    const net = (async (input: unknown, init?: RequestInit) => {
      seen.push(['net', new Headers(init?.headers).get('content-length')]);
      return new Response('ok');
    }) as typeof fetch;
    const fallback = (async () => {
      seen.push(['node', null]);
      return new Response('x');
    }) as typeof fetch;
    const f = createNetBackedFetch(net, fallback);
    await f('https://api.github.com/user', { headers: { 'Content-Length': '2', Authorization: 'x' } });
    await f('data:text/plain,hi');
    expect(seen).toEqual([
      ['net', null],
      ['node', null],
    ]);
  });
});

// ---- injection into real git invocations ----------------------------------------------------

function fakeSettings(over: Partial<Record<SettingKey, unknown>>): ConnectivitySettings {
  const values = { ...defaultValues(), ...over } as Record<string, unknown>;
  return {
    get: ((k: SettingKey) => values[k]) as ConnectivitySettings['get'],
    set: (k, v) => void (values[k] = v),
    activeProfile: { id: 'p1', authorEmail: 'me@example.com' },
    on: () => undefined,
  };
}

const gitPath = findOnPath('git');
(gitPath ? describe : describe.skip)('connectivity → every git invocation (real git)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-net-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('injects GIT_SSH_COMMAND, proxy env and -c config through GitProcessRunner', async () => {
    const conn = createConnectivityServices({
      settings: fakeSettings({
        'ssh.privateKeyPath': path.join(dir, 'my key'),
        'network.proxyMode': 'manual',
        'network.proxyUrl': 'http://proxy.test:3128',
        'network.noProxy': ['*.corp'],
        'git.useCredentialHelpers': false,
      }),
      secrets: new MemorySecrets(),
    });
    try {
      const runner = new GitProcessRunner({
        context: () => ({
          gitPath: gitPath!,
          baseEnv: { ...process.env, HTTPS_PROXY: 'http://inherited:1' },
          bundled: false,
        }),
      });
      runner.setInvocationExtras(conn.gitInvocation);
      const cfg = await runner.run({
        cwd: dir,
        args: ['config', '--get-regexp', '^(http\\.proxy|credential\\.helper)$'],
        expectedExitCodes: [0, 1],
      });
      expect(cfg.stdout).toMatch(/^credential\.helper\s*$/m);
      // A shell alias prints the environment git hands to its children (ssh, curl, submodules, LFS).
      const env = await runner.run({ cwd: dir, args: ['-c', 'alias.kl-env=!env', 'kl-env'] });
      const keyPath = path.join(dir, 'my key').replace(/\\/g, process.platform === 'win32' ? '/' : '\\');
      expect(env.stdout).toContain(`GIT_SSH_COMMAND=ssh -i '${keyPath}' -o IdentitiesOnly=yes`);
      expect(env.stdout).toMatch(/^HTTPS_PROXY=http:\/\/proxy\.test:3128$/m);
      expect(env.stdout).toMatch(/^NO_PROXY=localhost,127\.0\.0\.1,::1,\.corp$/m);
      expect(env.stdout).not.toContain('inherited');
    } finally {
      conn.dispose();
    }
  });

  it('combines ssh and network parts', () => {
    expect(
      combineInvocation(
        { env: { GIT_SSH_COMMAND: 'ssh' } },
        { env: { HTTPS_PROXY: null }, config: [['a', 'b']] },
      ),
    ).toEqual({ env: { HTTPS_PROXY: null, GIT_SSH_COMMAND: 'ssh' }, config: [['a', 'b']] });
  });
});

describe('network IPC handlers', () => {
  it('cover every channel and validate input', async () => {
    const h = createNetworkHandlers({
      ssh: {
        status: () => ({}) as never,
        generate: async (r) => ({ ...r }) as never,
        publicKey: async () => ({}) as never,
        testConnection: async (host) => ({ ok: true, kind: 'success', message: host, output: '' }),
      },
      network: {
        status: async () => ({}) as never,
        setProxyAuth: () => undefined,
        clearProxyAuth: () => undefined,
      },
      credentials: { list: () => [], forget: () => undefined, forgetAll: () => 3 },
    });
    expect(Object.keys(h).sort()).toEqual([...NETWORK_INVOKE_CHANNELS].sort());
    const ctx = { senderId: 1 };
    expect(() => h['ssh:key:generate']({ type: 'dsa' as never }, ctx)).toThrow(/key type/);
    expect(() => h['ssh:testConnection']({ host: 42 as never }, ctx)).toThrow(/host/);
    expect(await h['cred:forgetAll']({}, ctx)).toEqual({ removed: 3 });
  });
});
