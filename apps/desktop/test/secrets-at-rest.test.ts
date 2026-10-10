import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AiService, type AiServiceDeps, type AiSettingKey } from '../src/main/ai/ai-service';
import { AccountStore } from '../src/main/integrations/account-store';
import { NetworkService } from '../src/main/network/network-service';
import { EncryptedFileSecretStore, type Encryptor } from '../src/main/secrets/secret-store';
import { SettingsStore } from '../src/main/settings/settings-store';
import { defaultValues } from '../src/shared/settings/registry';
import { scanUserDataForSecrets } from './settings-secret-scan';

/**
 * CI-friendly companion of e2e/secrets.spec.ts (spec 00 §2, spec 13 §9): the main-process stores that
 * accept credentials write them only to the encrypted SecretStore, and what they hand back for the
 * renderer (lists, status) never contains them. Real SettingsStore + EncryptedFileSecretStore on a temp
 * userData folder; AES-GCM stands in for Electron safeStorage.
 */

function aesEncryptor(): Encryptor {
  const key = crypto.randomBytes(32);
  return {
    isAvailable: () => true,
    backend: () => 'test',
    encrypt(plain) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), body]);
    },
    decrypt(buf) {
      const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
      d.setAuthTag(buf.subarray(12, 28));
      return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
    },
  };
}

/** Every file under `dir`, byte-searched for each needle (secrets.bin included: it must be ciphertext). */
function byteHits(dir: string, needles: string[]): string[] {
  const hits: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!e.isFile()) continue;
    const buf = fs.readFileSync(path.join(e.parentPath, e.name));
    for (const n of needles) {
      for (const form of [n, Buffer.from(n).toString('base64').replace(/=+$/, '')]) {
        if (buf.includes(Buffer.from(form))) hits.push(`${e.name}: ${n.slice(0, 6)}…`);
      }
    }
  }
  return hits;
}

const rnd = (n: number): string => crypto.randomBytes(n).toString('hex');

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-at-rest-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('secrets at rest (spec 13 §9)', () => {
  it('AI key, integration token and proxy password live only in the encrypted store', async () => {
    const AI_KEY = `sk-unit${rnd(20)}`;
    const PAT = `ghp_${rnd(18)}`;
    const REFRESH = `refresh-${rnd(12)}`;
    const PROXY_PW = `proxy-${rnd(12)}`;
    const markers = [AI_KEY, PAT, REFRESH, PROXY_PW];

    const settings = new SettingsStore({ dir });
    settings.load();
    settings.set('network.proxyMode', 'manual');
    settings.set('network.proxyUrl', 'http://proxy.corp:3128');
    expect(() => settings.set('network.proxyUrl', `http://me:${PROXY_PW}@proxy.corp:3128`)).toThrow();
    const profile = (): string => settings.activeProfile.id;
    const secrets = new EncryptedFileSecretStore(path.join(dir, 'secrets.bin'), aesEncryptor());

    // AI provider key
    const values = defaultValues() as Record<string, unknown>;
    const ai = new AiService({
      settings: ((k: AiSettingKey) => values[k]) as AiServiceDeps['settings'],
      secrets,
      profileId: profile,
      git: () => {
        throw new Error('no repo');
      },
      emit: () => undefined,
    });
    expect(ai.setKey('anthropic', AI_KEY)).toEqual({ hasKey: true, last4: AI_KEY.slice(-4) });

    // integration token (PAT + a refresh token)
    const accounts = new AccountStore(() => settings.profileDir(), profile, secrets);
    accounts.save(
      {
        kind: 'github',
        host: 'ghe.corp.test',
        accountId: '7',
        key: 'github:ghe.corp.test:7',
        login: 'octo',
        authType: 'pat',
        scopes: ['repo'],
        connectedAt: 1,
      },
      { type: 'pat', accessToken: PAT, refreshToken: REFRESH },
    );

    // proxy login
    const net = new NetworkService({
      prefs: () => ({
        mode: settings.get('network.proxyMode'),
        url: settings.get('network.proxyUrl'),
        noProxy: [],
        useOsCertStore: false,
        caBundlePath: '',
        useCredentialHelpers: false,
      }),
      profileId: profile,
      secrets,
      platform: 'linux',
    });
    net.setProxyAuth('me', PROXY_PW);

    // stored and retrievable from a fresh store instance (same key) …
    expect(secrets.listAccounts().length).toBe(3);
    expect(net.proxyLogin({ isProxy: true, host: 'proxy.corp', port: 3128 })?.password).toBe(PROXY_PW);
    // … but nothing renderer-facing carries them
    const facing = JSON.stringify([
      ai.keyStatus('anthropic'),
      await ai.status(),
      accounts.list(),
      await net.status(),
      settings.snapshot(),
    ]);
    for (const m of markers) expect(facing).not.toContain(m);

    // and no file under userData holds them in clear text or base64
    expect(byteHits(dir, markers)).toEqual([]);
    expect(scanUserDataForSecrets(dir, { known: markers })).toEqual([]);
    expect(fs.readFileSync(path.join(dir, 'secrets.bin')).subarray(0, 4).toString('latin1')).toBe('KLS1');
  });
});
