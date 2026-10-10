import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  EncryptedFileSecretStore,
  safeStorageEncryptor,
  secretAccount,
  SecretStoreUnavailableError,
  type Encryptor,
} from '../src/main/secrets/secret-store';

/** AES-GCM stand-in for Electron safeStorage. */
function fakeEncryptor(available = true): Encryptor {
  const key = crypto.randomBytes(32);
  return {
    isAvailable: () => available,
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

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-secrets-'));
  file = path.join(dir, 'secrets.bin');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('secretAccount', () => {
  it('builds <profileId>/<kind>/<key>', () => {
    expect(secretAccount('p1', 'integration', 'github.com')).toBe('p1/integration/github.com');
    expect(secretAccount('p1', 'git', 'bob@gitlab.com')).toBe('p1/git/bob@gitlab.com');
    expect(() => secretAccount('a/b', 'ai', 'anthropic')).toThrow();
    expect(() => secretAccount('p1', 'ai', '')).toThrow();
  });
});

describe('EncryptedFileSecretStore', () => {
  it('round-trips secrets across instances', () => {
    const enc = fakeEncryptor();
    const a = new EncryptedFileSecretStore(file, enc);
    a.set('p1/integration/github.com', 'ghp_secret_token_value');
    a.set('p1/ai/anthropic', 'sk-ant-xyz');
    const b = new EncryptedFileSecretStore(file, enc);
    expect(b.get('p1/integration/github.com')).toBe('ghp_secret_token_value');
    expect(b.listAccounts('p1/')).toEqual(['p1/ai/anthropic', 'p1/integration/github.com']);
  });

  it('never writes secrets or account names in plain text', () => {
    const s = new EncryptedFileSecretStore(file, fakeEncryptor());
    s.set('p1/git/bob@github.com', 'hunter2-password');
    const raw = fs.readFileSync(file).toString('latin1');
    expect(raw.startsWith('KLS1')).toBe(true);
    expect(raw).not.toContain('hunter2');
    expect(raw).not.toContain('bob@github.com');
  });

  it('deletes single accounts and by prefix (profile removal)', () => {
    const s = new EncryptedFileSecretStore(file, fakeEncryptor());
    s.set('p1/a/x', '1');
    s.set('p1/b/y', '2');
    s.set('p2/a/x', '3');
    expect(s.delete('p1/a/x')).toBe(true);
    expect(s.delete('p1/a/x')).toBe(false);
    expect(s.deleteByPrefix('p1/')).toBe(1);
    expect(s.listAccounts()).toEqual(['p2/a/x']);
  });

  it('refuses to store when secure storage is unavailable', () => {
    const s = new EncryptedFileSecretStore(file, fakeEncryptor(false));
    expect(() => s.set('p1/ai/x', 'k')).toThrow(SecretStoreUnavailableError);
    expect(s.get('p1/ai/x')).toBeNull();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('treats a file it can no longer decrypt as empty (e.g. a new keychain item)', () => {
    const a = new EncryptedFileSecretStore(file, fakeEncryptor());
    a.set('p1/ai/x', 'secret');
    const other = new EncryptedFileSecretStore(file, fakeEncryptor()); // different key
    expect(other.get('p1/ai/x')).toBeNull();
    expect(other.listAccounts()).toEqual([]);
    expect(fs.existsSync(`${file}.undecryptable`)).toBe(true);
    other.set('p1/ai/x', 'again');
    expect(other.get('p1/ai/x')).toBe('again');
  });

  it('rejects a file in an unknown format', () => {
    fs.writeFileSync(file, 'plain text');
    expect(() => new EncryptedFileSecretStore(file, fakeEncryptor()).get('x')).toThrow(/Unrecognized/);
  });
});

describe('safeStorageEncryptor', () => {
  it('treats the Linux basic_text backend as unavailable', () => {
    if (process.platform !== 'linux') return;
    const enc = safeStorageEncryptor({
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from(s),
      decryptString: (b) => b.toString(),
      getSelectedStorageBackend: () => 'basic_text',
    });
    expect(enc.isAvailable()).toBe(false);
  });

  it('is available when the OS backend is', () => {
    const enc = safeStorageEncryptor({
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from(s),
      decryptString: (b) => b.toString(),
      getSelectedStorageBackend: () => 'gnome_libsecret',
    });
    expect(enc.isAvailable()).toBe(true);
  });
});
