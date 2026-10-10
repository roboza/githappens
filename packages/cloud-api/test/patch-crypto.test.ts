import { describe, expect, it } from 'vitest';

import {
  fromBase64Url,
  hmacBase64Url,
  isEncryptedBlob,
  openPatchBlob,
  parsePatchLink,
  PATCH_FORMAT,
  PatchCryptoError,
  patchDeepLink,
  repoIdentityKey,
  sealPatchBundle,
  toBase64Url,
  type PatchBundle,
} from '../src';

const bundle: PatchBundle = {
  format: PATCH_FORMAT,
  title: 'Fix login',
  kind: 'wip',
  baseSha: 'a'.repeat(40),
  createdWith: 'test',
  patch: 'diff --git a/x b/x\n',
  files: [{ path: 'x', status: 'M', additions: 1, deletions: 0 }],
};

describe('patch crypto (spec 14 §6.3)', () => {
  it('round-trips plain and e2e bundles; sha256 covers the uploaded bytes', async () => {
    const plain = await sealPatchBundle(bundle, { e2e: false });
    expect(plain.key).toBeUndefined();
    expect(isEncryptedBlob(plain.bytes)).toBe(false);
    expect(await openPatchBlob(plain.bytes)).toEqual(bundle);

    const sealed = await sealPatchBundle(bundle, { e2e: true });
    expect(sealed.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(isEncryptedBlob(sealed.bytes)).toBe(true);
    expect(new TextDecoder().decode(sealed.bytes)).not.toContain('Fix login');
    expect(await openPatchBlob(sealed.bytes, sealed.key)).toEqual(bundle);
    expect(sealed.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses e2e blobs without or with the wrong key', async () => {
    const sealed = await sealPatchBundle(bundle, { e2e: true });
    await expect(openPatchBlob(sealed.bytes)).rejects.toMatchObject({ code: 'needs-key' });
    const other = toBase64Url(new Uint8Array(32).fill(7));
    await expect(openPatchBlob(sealed.bytes, other)).rejects.toBeInstanceOf(PatchCryptoError);
    await expect(openPatchBlob(new Uint8Array([1, 2, 3, 4, 5]))).rejects.toMatchObject({
      code: 'unsupported',
    });
  });

  it('base64url, hmac and links', async () => {
    const bytes = new Uint8Array([0, 250, 251, 252, 253, 254, 255]);
    expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
    const salt = toBase64Url(new Uint8Array(32).fill(1));
    const a = await hmacBase64Url(salt, 'github:github.com/acme/app:src/a.ts');
    expect(a).toBe(await hmacBase64Url(salt, 'github:github.com/acme/app:src/a.ts'));
    expect(a).not.toBe(await hmacBase64Url(salt, 'github:github.com/acme/app:src/b.ts'));
    expect(repoIdentityKey({ provider: 'github', host: 'GitHub.com', owner: 'Acme', name: 'App' })).toBe(
      'github:github.com/acme/app',
    );
    const id = 'AbCdEfGhIjKlMnOpQrStUv';
    expect(parsePatchLink(patchDeepLink(id, 'kkk'))).toEqual({ id, key: 'kkk', server: undefined });
    expect(parsePatchLink(`https://cloud.example.com/p/${id}#k=zz`)).toEqual({
      id,
      key: 'zz',
      server: 'https://cloud.example.com',
    });
    expect(parsePatchLink('https://example.com/other')).toBeNull();
    expect(patchDeepLink(id)).toBe(`githappens://patch/${id}`);
  });
});
