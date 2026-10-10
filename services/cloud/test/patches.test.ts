import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  call,
  createPatch,
  DAY,
  makeOrg,
  patchBody,
  patchCrypto,
  sealSample,
  signIn,
  startCloud,
  type Session,
  type TestCloud,
} from './helpers.ts';

let cloud: TestCloud;
beforeEach(async () => {
  cloud = await startCloud();
});
afterEach(async () => {
  await cloud.close();
});

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

async function download(meta: { downloadUrl: string }): Promise<Uint8Array> {
  const res = await fetch(meta.downloadUrl);
  expect(res.status).toBe(200);
  return new Uint8Array(await res.arrayBuffer());
}

describe('patch lifecycle', () => {
  it('create → upload → complete → anonymous link download → open with patch-crypto', async () => {
    const s = await signIn(cloud, 'ana@example.com', 'Ana');
    const sealed = await sealSample(false);
    const created = await call(cloud, 'POST', '/v1/patches', { token: s.access, body: patchBody(sealed) });
    expect(created.status).toBe(201);
    expect(created.json.id).toMatch(/^[0-9A-Za-z]{22}$/);
    expect(created.json.webUrl).toBe(`${cloud.url}/p/${created.json.id}`);
    expect(created.json.uploadUrl.startsWith(`${cloud.url}/v1/blobs/`)).toBe(true);

    // Not readable until completed.
    expect((await call(cloud, 'GET', `/v1/patches/${created.json.id}`)).status).toBe(410);

    const up = await call(cloud, 'PUT', created.json.uploadUrl, { raw: sealed.bytes });
    expect(up.status).toBe(200);
    const done = await call(cloud, 'POST', `/v1/patches/${created.json.id}/complete`, { token: s.access });
    expect(done.status).toBe(200);
    expect(done.json).toMatchObject({
      id: created.json.id,
      title: 'Fix the thing',
      kind: 'wip',
      author: { id: s.userId, name: 'Ana' },
      e2e: false,
      size: sealed.bytes.length,
      sha256: sealed.sha256,
      visibility: 'link',
      repo: { provider: 'github', owner: 'acme', name: 'app' },
      files: [{ path: 'src/app.ts', status: 'M', additions: 1, deletions: 1 }],
    });
    expect(done.json.author.email).toBeUndefined();

    const anon = await call(cloud, 'GET', `/v1/patches/${created.json.id}`);
    expect(anon.status).toBe(200);
    expect(anon.json.downloadUrl.startsWith(`${cloud.url}/v1/blobs/`)).toBe(true);
    const bytes = await download(anon.json);
    expect(Buffer.from(bytes).equals(Buffer.from(sealed.bytes))).toBe(true);
    const bundle = await (await patchCrypto()).openPatchBlob(bytes);
    expect(bundle.patch).toContain('+new');

    // Upload URLs are single-purpose.
    expect((await call(cloud, 'PUT', created.json.uploadUrl, { raw: sealed.bytes })).status).toBe(409);
    expect((await call(cloud, 'GET', created.json.uploadUrl)).status).toBe(403);
    expect((await call(cloud, 'PUT', anon.json.downloadUrl, { raw: sealed.bytes })).status).toBe(403);
    const tampered = anon.json.downloadUrl.replace(/.$/, (c: string) => (c === 'A' ? 'B' : 'A'));
    expect((await call(cloud, 'GET', tampered)).status).toBe(403);
  });

  it('keeps e2e blobs opaque: no file list, encrypted at rest, needs the fragment key', async () => {
    const s = await signIn(cloud, 'ana@example.com');
    const { meta, sealed } = await createPatch(cloud, s, { title: 'Encrypted patch' }, true);
    expect(meta.e2e).toBe(true);
    expect(meta.files).toBeUndefined();
    const got = await call(cloud, 'GET', `/v1/patches/${meta.id}`);
    const bytes = await download(got.json);
    const pc = await patchCrypto();
    await expect(pc.openPatchBlob(bytes)).rejects.toMatchObject({ code: 'needs-key' });
    expect((await pc.openPatchBlob(bytes, sealed.key)).patch).toContain('+new');

    // Server-side encryption at rest: the stored file is not the uploaded bytes.
    const files = walk(cloud.blobDir).filter((f) => f.endsWith('.bin'));
    expect(files).toHaveLength(1);
    const onDisk = readFileSync(files[0]!);
    expect(onDisk.length).toBe(sealed.bytes.length + 28);
    expect(onDisk.includes(Buffer.from(sealed.bytes.subarray(0, 32)))).toBe(false);
  });

  it('rejects e2e patches that carry a file list', async () => {
    const s = await signIn(cloud, 'ana@example.com');
    const sealed = await sealSample(true);
    const r = await call(cloud, 'POST', '/v1/patches', {
      token: s.access,
      body: patchBody(sealed, { e2e: true }),
    });
    expect(r.status).toBe(422);
  });

  it('verifies sha256 and size on complete', async () => {
    const s = await signIn(cloud, 'ana@example.com');
    const sealed = await sealSample(false);
    const created = await call(cloud, 'POST', '/v1/patches', {
      token: s.access,
      body: patchBody(sealed, { sha256: 'f'.repeat(64) }),
    });
    expect(
      (await call(cloud, 'POST', `/v1/patches/${created.json.id}/complete`, { token: s.access })).status,
    ).toBe(409);
    await call(cloud, 'PUT', created.json.uploadUrl, { raw: sealed.bytes });
    const bad = await call(cloud, 'POST', `/v1/patches/${created.json.id}/complete`, { token: s.access });
    expect(bad.status).toBe(422);
    expect(bad.json.message).toContain('sha256');

    const short = await call(cloud, 'POST', '/v1/patches', {
      token: s.access,
      body: patchBody(sealed, { size: sealed.bytes.length + 10 }),
    });
    await call(cloud, 'PUT', short.json.uploadUrl, { raw: sealed.bytes });
    const sizeBad = await call(cloud, 'POST', `/v1/patches/${short.json.id}/complete`, { token: s.access });
    expect(sizeBad.status).toBe(422);
    expect(sizeBad.json.message).toContain('size');

    // Only the author can complete.
    const other = await signIn(cloud, 'bob@example.com');
    expect(
      (await call(cloud, 'POST', `/v1/patches/${short.json.id}/complete`, { token: other.access })).status,
    ).toBe(404);
  });

  it('enforces the size limit at create (413) and on upload', async () => {
    await cloud.close();
    cloud = await startCloud({ patchMaxBytes: 2048 });
    const s = await signIn(cloud, 'ana@example.com');
    const sealed = await sealSample(false);
    const huge = await call(cloud, 'POST', '/v1/patches', {
      token: s.access,
      body: patchBody(sealed, { size: 4096 }),
    });
    expect(huge.status).toBe(413);
    expect(huge.json.error).toBe('too_large');
    expect((await call(cloud, 'GET', '/.well-known/githappens-cloud')).json.limits.patchMaxBytes).toBe(2048);

    const created = await call(cloud, 'POST', '/v1/patches', {
      token: s.access,
      body: patchBody(sealed, { size: 10 }),
    });
    const over = await call(cloud, 'PUT', created.json.uploadUrl, { raw: new Uint8Array(500) });
    expect(over.status).toBe(413);
  });

  it('expires upload URLs after 15 minutes', async () => {
    const s = await signIn(cloud, 'ana@example.com');
    const sealed = await sealSample(false);
    const created = await call(cloud, 'POST', '/v1/patches', { token: s.access, body: patchBody(sealed) });
    cloud.clock.now += 16 * 60_000;
    expect((await call(cloud, 'PUT', created.json.uploadUrl, { raw: sealed.bytes })).status).toBe(403);
  });

  it('validates the create body', async () => {
    const s = await signIn(cloud, 'ana@example.com');
    const sealed = await sealSample(false);
    for (const extra of [
      { title: '' },
      { kind: 'bogus' },
      { baseSha: 'xyz' },
      { sha256: 'abc' },
      { size: 0 },
      { visibility: 'public' },
      { files: [{ path: 'a', status: 'Q', additions: 0, deletions: 0 }] },
      { repo: { provider: 'github', host: 'github.com', owner: 'a' } },
      { expiresAt: 'tomorrow' },
      { expiresAt: new Date(cloud.clock.now - 1000).toISOString() },
      { visibility: 'org' }, // needs orgId
    ]) {
      const r = await call(cloud, 'POST', '/v1/patches', { token: s.access, body: patchBody(sealed, extra) });
      expect(r.status, JSON.stringify(extra)).toBe(422);
      expect(r.json.error).toBe('validation');
    }
    expect((await call(cloud, 'POST', '/v1/patches', { body: patchBody(sealed) })).status).toBe(401);
  });
});

describe('patch visibility', () => {
  let author: Session;
  let member: Session;
  let collaborator: Session;
  let outsider: Session;
  let org: any;

  beforeEach(async () => {
    author = await signIn(cloud, 'author@example.com');
    member = await signIn(cloud, 'member@example.com');
    collaborator = await signIn(cloud, 'collab@example.com');
    outsider = await signIn(cloud, 'out@example.com');
    org = await makeOrg(cloud, author, [{ s: member }, { s: collaborator }]);
  });

  const get = (id: string, s?: Session) => call(cloud, 'GET', `/v1/patches/${id}`, { token: s?.access });

  it('link: anyone, including anonymous', async () => {
    const { meta } = await createPatch(cloud, author, { orgId: org.id, visibility: 'link' });
    for (const s of [undefined, member, outsider]) expect((await get(meta.id, s)).status).toBe(200);
    expect((await call(cloud, 'GET', `/v1/patches/${meta.id}`, { token: 'garbage' })).status).toBe(401);
  });

  it('org: members only', async () => {
    const { meta } = await createPatch(cloud, author, { orgId: org.id, visibility: 'org' });
    expect((await get(meta.id)).status).toBe(401);
    expect((await get(meta.id, outsider)).status).toBe(403);
    expect((await get(meta.id, member)).status).toBe(200);
    expect((await get(meta.id, author)).status).toBe(200);
  });

  it('collaborators: listed users and the author only', async () => {
    const { meta } = await createPatch(cloud, author, {
      orgId: org.id,
      visibility: 'collaborators',
      collaborators: [collaborator.userId],
    });
    expect(meta.collaborators).toEqual([expect.objectContaining({ id: collaborator.userId })]);
    expect((await get(meta.id)).status).toBe(401);
    expect((await get(meta.id, member)).status).toBe(403);
    expect((await get(meta.id, outsider)).status).toBe(403);
    expect((await get(meta.id, collaborator)).status).toBe(200);

    const sealed = await sealSample(false);
    const notMember = await call(cloud, 'POST', '/v1/patches', {
      token: author.access,
      body: patchBody(sealed, {
        orgId: org.id,
        visibility: 'collaborators',
        collaborators: [outsider.userId],
      }),
    });
    expect(notMember.status).toBe(422);
  });

  it('requires org membership to attach a patch to an org', async () => {
    const sealed = await sealSample(false);
    const r = await call(cloud, 'POST', '/v1/patches', {
      token: outsider.access,
      body: patchBody(sealed, { orgId: org.id, visibility: 'org' }),
    });
    expect(r.status).toBe(403);
  });

  it('lists mine and shared, filtered by repo, with pagination', async () => {
    const a = await createPatch(cloud, author, { orgId: org.id, visibility: 'org' });
    cloud.clock.now += 1000;
    const b = await createPatch(cloud, author, {
      orgId: org.id,
      visibility: 'collaborators',
      collaborators: [member.userId],
    });
    cloud.clock.now += 1000;
    const c = await createPatch(cloud, author, {
      visibility: 'link',
      repo: { provider: 'github', host: 'github.com', owner: 'acme', name: 'other' },
    });
    const mine = await call(cloud, 'GET', '/v1/patches?scope=mine', { token: author.access });
    expect(mine.json.items.map((p: any) => p.id)).toEqual([c.meta.id, b.meta.id, a.meta.id]);
    expect(mine.json.nextCursor).toBeUndefined();

    const p1 = await call(cloud, 'GET', '/v1/patches?scope=mine&limit=2', { token: author.access });
    expect(p1.json.items.map((p: any) => p.id)).toEqual([c.meta.id, b.meta.id]);
    const p2 = await call(cloud, 'GET', `/v1/patches?scope=mine&limit=2&cursor=${p1.json.nextCursor}`, {
      token: author.access,
    });
    expect(p2.json.items.map((p: any) => p.id)).toEqual([a.meta.id]);
    expect(p2.json.nextCursor).toBeUndefined();

    const byRepo = await call(
      cloud,
      'GET',
      `/v1/patches?scope=mine&repo=${encodeURIComponent('github:github.com/acme/other')}`,
      {
        token: author.access,
      },
    );
    expect(byRepo.json.items.map((p: any) => p.id)).toEqual([c.meta.id]);

    const sharedMember = await call(cloud, 'GET', '/v1/patches?scope=shared', { token: member.access });
    expect(sharedMember.json.items.map((p: any) => p.id)).toEqual([b.meta.id, a.meta.id]);
    const sharedCollab = await call(cloud, 'GET', '/v1/patches?scope=shared', { token: collaborator.access });
    expect(sharedCollab.json.items.map((p: any) => p.id)).toEqual([a.meta.id]);
    expect(
      (await call(cloud, 'GET', '/v1/patches?scope=shared', { token: outsider.access })).json.items,
    ).toEqual([]);
    expect(
      (await call(cloud, 'GET', '/v1/patches?scope=everything', { token: outsider.access })).status,
    ).toBe(422);
    expect((await call(cloud, 'GET', '/v1/patches?cursor=!!', { token: outsider.access })).status).toBe(422);
  });

  it('updates (author only) and audits visibility changes', async () => {
    const { meta } = await createPatch(cloud, author, { orgId: org.id, visibility: 'org' });
    expect(
      (await call(cloud, 'PATCH', `/v1/patches/${meta.id}`, { token: member.access, body: { title: 'x' } }))
        .status,
    ).toBe(403);
    expect(
      (await call(cloud, 'PATCH', `/v1/patches/${meta.id}`, { token: outsider.access, body: { title: 'x' } }))
        .status,
    ).toBe(404);
    const upd = await call(cloud, 'PATCH', `/v1/patches/${meta.id}`, {
      token: author.access,
      body: {
        title: 'New title',
        description: 'Details',
        visibility: 'collaborators',
        collaborators: [collaborator.userId],
      },
    });
    expect(upd.status).toBe(200);
    expect(upd.json).toMatchObject({
      title: 'New title',
      description: 'Details',
      visibility: 'collaborators',
    });
    expect((await get(meta.id, member)).status).toBe(403);
    expect((await get(meta.id, collaborator)).status).toBe(200);
    const exp = new Date(cloud.clock.now + 3 * DAY).toISOString();
    const withExpiry = await call(cloud, 'PATCH', `/v1/patches/${meta.id}`, {
      token: author.access,
      body: { expiresAt: exp },
    });
    expect(withExpiry.json.expiresAt).toBe(exp);
    const cleared = await call(cloud, 'PATCH', `/v1/patches/${meta.id}`, {
      token: author.access,
      body: { expiresAt: null },
    });
    expect(cleared.json.expiresAt).toBeUndefined();
  });

  it('deletes (author or org admin) → 410', async () => {
    const one = await createPatch(cloud, author, { orgId: org.id, visibility: 'org' });
    expect((await call(cloud, 'DELETE', `/v1/patches/${one.meta.id}`, { token: member.access })).status).toBe(
      403,
    );
    expect((await call(cloud, 'DELETE', `/v1/patches/${one.meta.id}`, { token: author.access })).status).toBe(
      204,
    );
    expect((await get(one.meta.id, author)).status).toBe(410);

    const two = await createPatch(cloud, member, { orgId: org.id, visibility: 'org' });
    const dl = await get(two.meta.id, member);
    expect((await call(cloud, 'DELETE', `/v1/patches/${two.meta.id}`, { token: author.access })).status).toBe(
      204,
    ); // org owner
    expect((await fetch(dl.json.downloadUrl)).status).toBe(410);
  });
});

describe('expiry and org policies', () => {
  it('expired patches answer 410 (API, blob URL and viewer)', async () => {
    const s = await signIn(cloud, 'ana@example.com');
    const { meta } = await createPatch(cloud, s, {
      expiresAt: new Date(cloud.clock.now + DAY).toISOString(),
    });
    const ok = await call(cloud, 'GET', `/v1/patches/${meta.id}`);
    expect(ok.status).toBe(200);
    cloud.clock.now += DAY + 1;
    const r = await call(cloud, 'GET', `/v1/patches/${meta.id}`);
    expect(r.status).toBe(410);
    expect(r.json.error).toBe('gone');
    expect((await fetch(ok.json.downloadUrl)).status).toBe(403); // 5-minute URL expired as well
    expect((await call(cloud, 'GET', `/p/${meta.id}`)).status).toBe(410);
    expect(
      (
        await call(cloud, 'GET', '/v1/patches?scope=mine', {
          token: (await signIn(cloud, 'ana@example.com')).access,
        })
      ).json.items,
    ).toEqual([]);
  });

  it('caps expiry to the org policy and can forbid public links', async () => {
    const owner = await signIn(cloud, 'owner@example.com');
    const org = await makeOrg(cloud, owner);
    await call(cloud, 'PATCH', `/v1/orgs/${org.id}/policies`, {
      token: owner.access,
      body: { patchMaxExpiryDays: 7, allowPublicLinks: false },
    });
    const sealed = await sealSample(false);
    const link = await call(cloud, 'POST', '/v1/patches', {
      token: owner.access,
      body: patchBody(sealed, { orgId: org.id }),
    });
    expect(link.status).toBe(403);

    const capped = await createPatch(cloud, owner, {
      orgId: org.id,
      visibility: 'org',
      expiresAt: new Date(cloud.clock.now + 30 * DAY).toISOString(),
    });
    expect(capped.meta.expiresAt).toBe(new Date(cloud.clock.now + 7 * DAY).toISOString());
    const noExpiry = await createPatch(cloud, owner, { orgId: org.id, visibility: 'org' });
    expect(noExpiry.meta.expiresAt).toBe(new Date(cloud.clock.now + 7 * DAY).toISOString());
    const shorter = new Date(cloud.clock.now + 2 * DAY).toISOString();
    expect(
      (await createPatch(cloud, owner, { orgId: org.id, visibility: 'org', expiresAt: shorter })).meta
        .expiresAt,
    ).toBe(shorter);

    // Switching an existing patch to link visibility is refused too.
    expect(
      (
        await call(cloud, 'PATCH', `/v1/patches/${noExpiry.meta.id}`, {
          token: owner.access,
          body: { visibility: 'link' },
        })
      ).status,
    ).toBe(403);
  });

  it('applies the server-wide expiry cap', async () => {
    await cloud.close();
    cloud = await startCloud({ patchMaxExpiryDays: 30 });
    const s = await signIn(cloud, 'ana@example.com');
    const { meta } = await createPatch(cloud, s);
    expect(meta.expiresAt).toBe(new Date(cloud.clock.now + 30 * DAY).toISOString());
  });
});

describe('web viewer', () => {
  it('serves a self-contained page with a strict nonce CSP', async () => {
    const s = await signIn(cloud, 'ana@example.com');
    const { meta } = await createPatch(cloud, s);
    const page = await call(cloud, 'GET', `/p/${meta.id}`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    const csp = page.headers.get('content-security-policy')!;
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)![1]!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).toContain("connect-src 'self'");
    expect(page.text).toContain(`<script nonce="${nonce}">`);
    expect(page.text).toContain(`<style nonce="${nonce}">`);
    expect(page.text).toContain(`githappens://patch/${meta.id}`);
    expect(page.text).toContain('KLP1');
    expect(page.text).toContain('DecompressionStream');
    expect(page.text).not.toMatch(/<(?:script|link|img)[^>]+(?:src|href)=["']https?:/);
    expect(page.headers.get('referrer-policy')).toBe('no-referrer');
    // A fresh nonce per response.
    const again = await call(cloud, 'GET', `/p/${meta.id}`);
    expect(again.headers.get('content-security-policy')).not.toBe(csp);
  });

  it('404s unknown ids', async () => {
    expect((await call(cloud, 'GET', '/p/doesnotexist')).status).toBe(404);
    expect((await call(cloud, 'GET', '/p/AAAAAAAAAAAAAAAAAAAAAA')).status).toBe(404);
  });
});
