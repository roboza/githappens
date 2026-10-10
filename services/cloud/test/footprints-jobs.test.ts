import { readdirSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  call,
  createPatch,
  DAY,
  makeOrg,
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

const repo = {
  provider: 'github',
  host: 'GitHub.com',
  owner: 'Acme',
  name: 'App',
  initialCommitSha: 'b'.repeat(40),
};
const hash = (c: string): string => c.repeat(43);

function footprint(extra: Record<string, unknown> = {}) {
  return {
    repo,
    branchHash: hash('B'),
    branchLabel: 'feature/login',
    baseRef: 'origin/main',
    headSha: 'c'.repeat(40),
    files: [{ pathHash: hash('P'), path: 'src/auth.ts', ranges: [[40, 58]] }],
    ...extra,
  };
}

describe('team footprints', () => {
  let ana: Session;
  let ben: Session;
  let org: any;
  beforeEach(async () => {
    ana = await signIn(cloud, 'ana@example.com', 'Ana');
    ben = await signIn(cloud, 'ben@example.com', 'Ben');
    org = await makeOrg(cloud, ana, [{ s: ben }]);
  });

  const put = (s: Session, body: unknown) =>
    call(cloud, 'PUT', `/v1/orgs/${org.id}/footprints`, { token: s.access, body });
  const list = (s: Session, q = '') =>
    call(cloud, 'GET', `/v1/orgs/${org.id}/footprints${q}`, { token: s.access });

  it('upserts per branch, excludes the caller, and strips paths/labels under the default policy', async () => {
    const a = await put(ana, footprint());
    expect(a.status).toBe(200);
    const repoId = a.json.repoIdentityId;
    expect((await put(ana, footprint({ headSha: 'd'.repeat(40) }))).json.repoIdentityId).toBe(repoId);
    await put(ben, footprint({ branchHash: hash('C') }));

    const seenByBen = await list(ben, `?repo=${repoId}`);
    expect(seenByBen.json).toHaveLength(1);
    expect(seenByBen.json[0]).toMatchObject({
      user: { id: ana.userId, name: 'Ana' },
      repoIdentityId: repoId,
      branchHash: hash('B'),
      baseRef: 'origin/main',
      headSha: 'd'.repeat(40),
      files: [{ pathHash: hash('P'), ranges: [[40, 58]] }],
    });
    expect(seenByBen.json[0].branchLabel).toBeUndefined();
    expect(seenByBen.json[0].files[0].path).toBeUndefined();
    expect(seenByBen.json[0].user.email).toBeUndefined();
    expect((await list(ana)).json.map((f: any) => f.user.id)).toEqual([ben.userId]);

    const key = encodeURIComponent('github:github.com/acme/app');
    expect(
      (await call(cloud, 'GET', `/v1/orgs/${org.id}/repo-identities?key=${key}`, { token: ben.access })).json,
    ).toEqual({ id: repoId });
    expect(
      (await call(cloud, 'GET', `/v1/orgs/${org.id}/repo-identities?key=nope`, { token: ben.access })).status,
    ).toBe(404);
  });

  it('keeps plaintext paths and labels when the policy allows them', async () => {
    await call(cloud, 'PATCH', `/v1/orgs/${org.id}/policies`, {
      token: ana.access,
      body: { footprintSharePaths: true, footprintShareBranchNames: true },
    });
    await put(ana, footprint());
    const seen = (await list(ben)).json[0];
    expect(seen.branchLabel).toBe('feature/login');
    expect(seen.files[0].path).toBe('src/auth.ts');
  });

  it('filters by since, deletes a branch, and expires after 14 days', async () => {
    await put(ana, footprint());
    const since = new Date(cloud.clock.now + 1000).toISOString();
    expect((await list(ben, `?since=${since}`)).json).toEqual([]);
    const repoId = (await list(ben)).json[0].repoIdentityId;
    expect(
      (
        await call(cloud, 'DELETE', `/v1/orgs/${org.id}/footprints/${repoId}/${hash('B')}`, {
          token: ana.access,
        })
      ).status,
    ).toBe(204);
    expect((await list(ben)).json).toEqual([]);

    await put(ana, footprint());
    cloud.clock.now += 15 * DAY;
    const ben2 = await signIn(cloud, 'ben@example.com');
    expect((await list(ben2)).json).toEqual([]); // hidden immediately past the TTL
    const report = await cloud.app.runJobs();
    expect(report.footprintsExpired).toBe(1);
  });

  it('deletes footprints when a member leaves the org', async () => {
    await put(ben, footprint());
    expect((await list(ana)).json).toHaveLength(1);
    await call(cloud, 'DELETE', `/v1/orgs/${org.id}/members/${ben.userId}`, { token: ben.access });
    expect((await list(ana)).json).toEqual([]);
    expect((await put(ben, footprint())).status).toBe(404);
  });

  it('aggregates the team view including the caller', async () => {
    await put(ana, footprint());
    await put(ana, footprint({ branchHash: hash('D'), files: [] }));
    await put(ben, footprint({ branchHash: hash('C') }));
    const view = await call(cloud, 'GET', `/v1/orgs/${org.id}/team`, { token: ana.access });
    expect(view.status).toBe(200);
    expect(view.json.repos).toHaveLength(1);
    const r = view.json.repos[0];
    expect(r.repo).toMatchObject({ owner: 'Acme', name: 'App' });
    const anaRow = r.members.find((m: any) => m.user.id === ana.userId);
    expect(anaRow.branches.map((b: any) => b.fileCount).sort()).toEqual([0, 1]);
    expect(r.members).toHaveLength(2);
  });

  it('validates input and membership', async () => {
    const outsider = await signIn(cloud, 'out@example.com');
    expect((await put(outsider, footprint())).status).toBe(404);
    expect((await put(ana, footprint({ branchHash: 'x' }))).status).toBe(422);
    expect((await put(ana, footprint({ files: [{ pathHash: hash('P'), ranges: [[5, 1]] }] }))).status).toBe(
      422,
    );
    const many = Array.from({ length: 501 }, () => ({ pathHash: hash('P'), ranges: [] }));
    expect((await put(ana, footprint({ files: many }))).status).toBe(422);
  });
});

describe('account deletion and maintenance jobs', () => {
  it('DELETE /v1/me revokes access now and purges everything incl. blobs after 7 days', async () => {
    const ana = await signIn(cloud, 'ana@example.com');
    const ben = await signIn(cloud, 'ben@example.com');
    const org = await makeOrg(cloud, ana, [{ s: ben }]);
    const solo = await call(cloud, 'POST', '/v1/orgs', { token: ana.access, body: { name: 'Solo' } });
    const { meta } = await createPatch(cloud, ana);
    await call(cloud, 'PUT', '/v1/sync/preferences', {
      token: ana.access,
      body: { ciphertext: 'AAAA', nonce: 'AAAA', deviceId: 'd' },
    });
    await call(cloud, 'PUT', `/v1/orgs/${org.id}/footprints`, {
      token: ana.access,
      body: footprint(),
    });

    const exp = await call(cloud, 'GET', '/v1/me/export', { token: ana.access });
    expect(exp.status).toBe(200);
    expect(exp.json.user.email).toBe('ana@example.com');
    expect(exp.json.patches.map((p: any) => p.id)).toEqual([meta.id]);
    expect(exp.json.syncCategories.map((c: any) => c.category)).toEqual(['preferences']);
    expect(exp.json.orgs).toHaveLength(2);

    const del = await call(cloud, 'DELETE', '/v1/me', { token: ana.access });
    expect(del.status).toBe(202);
    expect(del.json.deleteAfter).toBe(new Date(cloud.clock.now + 7 * DAY).toISOString());
    expect((await call(cloud, 'GET', '/v1/me', { token: ana.access })).status).toBe(401);
    expect(
      (
        await call(cloud, 'POST', '/oauth/token', {
          body: { grant_type: 'refresh_token', refresh_token: ana.refresh, client_id: 'desktop' },
        })
      ).status,
    ).toBe(400);
    expect((await call(cloud, 'GET', `/v1/patches/${meta.id}`)).status).toBe(410);
    expect((await call(cloud, 'GET', `/v1/orgs/${org.id}/footprints`, { token: ben.access })).json).toEqual(
      [],
    );

    // Not yet: the grace period has not elapsed (only the deleted patch row/blob goes).
    const early = await cloud.app.runJobs();
    expect(early.accountsPurged).toBe(0);
    expect(await cloud.store.getUser(ana.userId)).toBeDefined();

    cloud.clock.now += 7 * DAY + 1;
    const report = await cloud.app.runJobs();
    expect(report.accountsPurged).toBe(1);
    expect(await cloud.store.getUser(ana.userId)).toBeUndefined();
    expect(await cloud.store.getPatch(meta.id)).toBeUndefined();
    expect(await cloud.store.listSync(ana.userId)).toEqual([]);
    expect(readdirSync(cloud.blobDir, { recursive: true }).filter((f) => String(f).endsWith('.bin'))).toEqual(
      [],
    );

    // Ownership passed to the remaining member; the solo org is gone.
    const ben2 = await signIn(cloud, 'ben@example.com');
    const detail = await call(cloud, 'GET', `/v1/orgs/${org.id}`, { token: ben2.access });
    expect(detail.json.myRole).toBe('owner');
    expect(detail.json.members).toHaveLength(1);
    expect(await cloud.store.getOrg(solo.json.id)).toBeUndefined();

    // The email can sign up again as a brand-new account.
    const again = await signIn(cloud, 'ana@example.com');
    expect(again.userId).not.toBe(ana.userId);
  });

  it('purges expired, deleted and abandoned pending patches with their blobs', async () => {
    const s = await signIn(cloud, 'ana@example.com');
    const expiring = await createPatch(cloud, s, {
      expiresAt: new Date(cloud.clock.now + DAY).toISOString(),
    });
    const deleted = await createPatch(cloud, s);
    const kept = await createPatch(cloud, s);
    await call(cloud, 'DELETE', `/v1/patches/${deleted.meta.id}`, { token: s.access });
    const pending = await call(cloud, 'POST', '/v1/patches', {
      token: s.access,
      body: {
        title: 'pending',
        kind: 'wip',
        baseSha: 'a'.repeat(40),
        e2e: false,
        size: 3,
        sha256: '0'.repeat(64),
        visibility: 'link',
      },
    });
    await call(cloud, 'PUT', pending.json.uploadUrl, { raw: new Uint8Array([1, 2, 3]) });

    const first = await cloud.app.runJobs();
    expect(first.patchesPurged).toBe(1); // only the deleted one so far
    cloud.clock.now += 2 * DAY;
    const second = await cloud.app.runJobs();
    expect(second.patchesPurged).toBe(2); // expired + pending > 24 h
    expect(await cloud.store.getPatch(expiring.meta.id)).toBeUndefined();
    expect(await cloud.store.getPatch(pending.json.id)).toBeUndefined();
    expect(await cloud.store.getPatch(kept.meta.id)).toBeDefined();
    const blobs = readdirSync(cloud.blobDir, { recursive: true }).filter((f) => String(f).endsWith('.bin'));
    expect(blobs).toHaveLength(1);
    expect((await call(cloud, 'GET', `/v1/patches/${expiring.meta.id}`)).status).toBe(404);
  });
});
