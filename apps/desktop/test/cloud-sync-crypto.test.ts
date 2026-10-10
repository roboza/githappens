import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { canonicalJson, gzipJson, gunzipJson } from '../src/main/cloud/sync/canonical';
import {
  createSyncKeys,
  decodeKeysDoc,
  decryptCategory,
  encodeKeysDoc,
  encryptCategory,
  formatRecoveryKey,
  parseRecoveryKey,
  rewrapPassphrase,
  rewrapRecovery,
  SYNC_KDF_DEFAULT,
  unlockWithPassphrase,
  unlockWithRecoveryKey,
  unwrapKey,
  wrapKey,
} from '../src/main/cloud/sync/crypto';

const FAST = { alg: 'scrypt', N: 1024, r: 8, p: 1 } as const;
const USER = 'user-1';

describe('canonical JSON', () => {
  it('sorts keys recursively and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[1,{"y":2,"z":1}]},"b":1}',
    );
    expect(gunzipJson(gzipJson({ x: 'é' }))).toEqual({ x: 'é' });
  });
});

describe('sync key wrapping', () => {
  it('uses scrypt N=2^16, r=8, p=1 by default', () => {
    expect(SYNC_KDF_DEFAULT).toEqual({ alg: 'scrypt', N: 65536, r: 8, p: 1 });
  });

  it('wraps and unwraps; a wrong KEK throws instead of returning garbage', () => {
    const kek = randomBytes(32);
    const dek = randomBytes(32);
    const w = wrapKey(kek, dek, 'passphrase');
    expect(unwrapKey(kek, w, 'passphrase').equals(dek)).toBe(true);
    expect(() => unwrapKey(randomBytes(32), w, 'passphrase')).toThrow();
    // Slot is bound via AAD.
    expect(() => unwrapKey(kek, w, 'recovery')).toThrow();
  });

  it('unlocks with the passphrase or the recovery key; wrong ones are rejected', async () => {
    const { dek, recoveryKey, doc } = await createSyncKeys('correct horse battery', USER, FAST);
    expect(recoveryKey).toMatch(/^([0-9A-Z]{4}-){8}[0-9A-Z]{4}$/);
    const encoded = encodeKeysDoc(doc, 'dev-1');
    // The _keys document contains wrapped keys only.
    expect(Buffer.from(encoded.ciphertext, 'base64url').toString()).not.toContain(dek.toString('base64url'));
    const back = decodeKeysDoc(encoded);
    expect((await unlockWithPassphrase(back, 'correct horse battery', USER)).equals(dek)).toBe(true);
    await expect(unlockWithPassphrase(back, 'wrong passphrase', USER)).rejects.toMatchObject({
      code: 'wrong_passphrase',
    });
    // The user id is part of the salt.
    await expect(unlockWithPassphrase(back, 'correct horse battery', 'user-2')).rejects.toThrow();
    expect(unlockWithRecoveryKey(back, recoveryKey.toLowerCase().replace(/-/g, ' '), USER).equals(dek)).toBe(
      true,
    );
    const other = formatRecoveryKey(randomBytes(20));
    expect(() => unlockWithRecoveryKey(back, other, USER)).toThrow(/does not match/);
  });

  it('rejects mistyped recovery keys via the checksum', async () => {
    const { recoveryKey } = await createSyncKeys('passphrase-1', USER, FAST);
    expect(parseRecoveryKey(recoveryKey)).toHaveLength(20);
    const typo = (recoveryKey[0] === 'A' ? 'B' : 'A') + recoveryKey.slice(1);
    expect(() => parseRecoveryKey(typo)).toThrow(/not valid/);
    expect(() => parseRecoveryKey('ABCD')).toThrow(/36 characters/);
  });

  it('changes the passphrase and rotates the recovery key without changing the DEK', async () => {
    const { dek, recoveryKey, doc } = await createSyncKeys('first passphrase', USER, FAST);
    const changed = await rewrapPassphrase(doc, dek, 'second passphrase', USER);
    expect((await unlockWithPassphrase(changed, 'second passphrase', USER)).equals(dek)).toBe(true);
    await expect(unlockWithPassphrase(changed, 'first passphrase', USER)).rejects.toThrow();
    const rotated = rewrapRecovery(changed, dek, USER);
    expect(unlockWithRecoveryKey(rotated.doc, rotated.recoveryKey, USER).equals(dek)).toBe(true);
    expect(() => unlockWithRecoveryKey(rotated.doc, recoveryKey, USER)).toThrow();
    expect(rotated.doc.keyId).toBe(doc.keyId);
  });
});

describe('category encryption', () => {
  it('round-trips with a random nonce and binds the category', () => {
    const dek = randomBytes(32);
    const value = { v: 1, items: { 'ui.zoom': { v: 1.2, at: 5 } }, secret: 'plaintext-marker' };
    const a = encryptCategory(dek, 'preferences', value, 'dev');
    const b = encryptCategory(dek, 'preferences', value, 'dev');
    expect(a.nonce).not.toBe(b.nonce);
    expect(Buffer.from(a.nonce, 'base64url')).toHaveLength(12);
    expect(Buffer.from(a.ciphertext, 'base64url').toString('latin1')).not.toContain('plaintext-marker');
    expect(decryptCategory(dek, 'preferences', a)).toEqual(value);
    expect(() => decryptCategory(dek, 'themes', a)).toThrow(/decrypt/);
    expect(() => decryptCategory(randomBytes(32), 'preferences', a)).toThrow(/decrypt/);
  });
});
