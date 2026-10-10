import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/store/memory.ts';
import { PgStore } from '../src/store/pg.ts';
import { call, makeOrg, signIn, startCloud, type TestCloud } from './helpers.ts';

let cloud: TestCloud;
beforeEach(async () => {
  cloud = await startCloud();
});
afterEach(async () => {
  await cloud.close();
});

const b64 = (b: Buffer): string => b.toString('base64url');

describe('settings sync', () => {
  it('round-trips ciphertext with optimistic concurrency', async () => {
    const s = await signIn(cloud, 'ana@example.com');
    const ct = randomBytes(300);
    const nonce = randomBytes(24);
    const put = (version: number, body: unknown) =>
      call(cloud, 'PUT', '/v1/sync/preferences', {
        token: s.access,
        body,
        headers: { 'if-match': String(version) },
      });

    expect((await call(cloud, 'GET', '/v1/sync/preferences', { token: s.access })).status).toBe(404);
    const created = await put(0, { ciphertext: b64(ct), nonce: b64(nonce), deviceId: 'dev-A' });
    expect(created.status).toBe(200);
    expect(created.json).toEqual({ version: 1 });

    const item = await call(cloud, 'GET', '/v1/sync/preferences', { token: s.access });
    expect(item.json).toMatchObject({ category: 'preferences', version: 1, size: 300, deviceId: 'dev-A' });
    expect(Buffer.from(item.json.ciphertext, 'base64url').equals(ct)).toBe(true);
    expect(Buffer.from(item.json.nonce, 'base64url').equals(nonce)).toBe(true);
    expect(item.headers.get('etag')).toBe('"1"');

    // Creating again with If-Match: 0 conflicts.
    const again = await put(0, { ciphertext: b64(ct), nonce: b64(nonce), deviceId: 'dev-B' });
    expect(again.status).toBe(412);
    expect(again.json).toMatchObject({ error: 'precondition_failed', currentVersion: 1 });

    const v2 = await call(cloud, 'PUT', '/v1/sync/preferences', {
      token: s.access,
      body: { ciphertext: b64(randomBytes(10)), nonce: b64(nonce), deviceId: 'dev-B' },
      headers: { 'if-match': '"1"' },
    });
    expect(v2.json).toEqual({ version: 2 });
    const stale = await put(1, { ciphertext: b64(ct), nonce: b64(nonce), deviceId: 'dev-A' });
    expect(stale.status).toBe(412);
    expect(stale.json.currentVersion).toBe(2);

    const list = await call(cloud, 'GET', '/v1/sync', { token: s.access });
    expect(list.json).toEqual([
      expect.objectContaining({ category: 'preferences', version: 2, size: 10, deviceId: 'dev-B' }),
    ]);
  });

  it('stores exactly the bytes it was given and nothing derived from them', async () => {
    const s = await signIn(cloud, 'bob@example.com');
    const ct = randomBytes(64);
    const nonce = randomBytes(24);
    await call(cloud, 'PUT', '/v1/sync/_keys', {
      token: s.access,
      body: { ciphertext: b64(ct), nonce: b64(nonce), deviceId: 'd1', plaintext: 'ignored', key: 'ignored' },
      headers: { 'if-match': '0' },
    });
    if (cloud.store instanceof MemoryStore) {
      const raw = cloud.store.rawSync(s.userId, '_keys')!;
      expect(Object.keys(raw).sort()).toEqual([
        'category',
        'ciphertext',
        'deviceId',
        'nonce',
        'updatedAt',
        'userId',
        'version',
      ]);
      expect(raw.ciphertext.equals(ct)).toBe(true);
      expect(raw.nonce.equals(nonce)).toBe(true);
    } else if (cloud.store instanceof PgStore) {
      const raw = (await cloud.store.rawSync(s.userId, '_keys'))!;
      expect(Object.keys(raw).sort()).toEqual([
        'category',
        'ciphertext',
        'device_id',
        'nonce',
        'updated_at',
        'user_id',
        'version',
      ]);
      expect((raw.ciphertext as Buffer).equals(ct)).toBe(true);
      expect((raw.nonce as Buffer).equals(nonce)).toBe(true);
    }
  });

  it('validates categories, payloads and size', async () => {
    const s = await signIn(cloud, 'cy@example.com');
    const body = { ciphertext: b64(randomBytes(8)), nonce: b64(randomBytes(24)), deviceId: 'd' };
    expect((await call(cloud, 'PUT', '/v1/sync/Bad!Cat', { token: s.access, body })).status).toBe(404);
    expect(
      (
        await call(cloud, 'PUT', '/v1/sync/prefs', {
          token: s.access,
          body: { ...body, ciphertext: 'not base64!' },
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await call(cloud, 'PUT', '/v1/sync/prefs', {
          token: s.access,
          body: { ...body, deviceId: undefined },
        })
      ).status,
    ).toBe(422);
    const big = await call(cloud, 'PUT', '/v1/sync/prefs', {
      token: s.access,
      body: { ...body, ciphertext: b64(randomBytes(cloud.config.syncMaxBytes + 1)) },
    });
    expect(big.status).toBe(413);
    expect(big.json.error).toBe('too_large');
    expect(
      (await call(cloud, 'PUT', '/v1/sync/prefs', { token: s.access, body, headers: { 'if-match': 'abc' } }))
        .status,
    ).toBe(422);
  });

  it('isolates users and resets all categories', async () => {
    const a = await signIn(cloud, 'a@example.com');
    const b = await signIn(cloud, 'b@example.com');
    const body = { ciphertext: b64(randomBytes(8)), nonce: b64(randomBytes(24)), deviceId: 'd' };
    await call(cloud, 'PUT', '/v1/sync/themes', { token: a.access, body });
    await call(cloud, 'PUT', '/v1/sync/_keys', { token: a.access, body });
    expect((await call(cloud, 'GET', '/v1/sync/themes', { token: b.access })).status).toBe(404);
    expect((await call(cloud, 'DELETE', '/v1/sync', { token: a.access })).status).toBe(204);
    expect((await call(cloud, 'GET', '/v1/sync', { token: a.access })).json).toEqual([]);
  });
});

describe('cloud workspaces', () => {
  const doc = {
    name: 'Platform',
    repos: [{ provider: 'github', owner: 'acme', name: 'app', localPath: 'C:\\code\\app' }],
  };

  it('creates personal workspaces, strips local paths, and versions writes', async () => {
    const s = await signIn(cloud, 'ana@example.com');
    const ws = await call(cloud, 'POST', '/v1/workspaces', { token: s.access, body: { doc } });
    expect(ws.status).toBe(201);
    expect(ws.json).toMatchObject({ ownerUserId: s.userId, version: 1, shares: [] });
    expect(JSON.stringify(ws.json.doc)).not.toContain('localPath');
    expect(ws.json.doc.repos[0].name).toBe('app');

    const upd = await call(cloud, 'PUT', `/v1/workspaces/${ws.json.id}`, {
      token: s.access,
      body: { doc: { name: 'Renamed' } },
      headers: { 'if-match': '1' },
    });
    expect(upd.json).toMatchObject({ version: 2, doc: { name: 'Renamed' } });
    const stale = await call(cloud, 'PUT', `/v1/workspaces/${ws.json.id}`, {
      token: s.access,
      body: { doc: { name: 'Lost' } },
      headers: { 'if-match': '1' },
    });
    expect(stale.status).toBe(412);
    expect(stale.json.currentVersion).toBe(2);
    expect((await call(cloud, 'GET', '/v1/workspaces', { token: s.access })).json).toHaveLength(1);
    expect((await call(cloud, 'DELETE', `/v1/workspaces/${ws.json.id}`, { token: s.access })).status).toBe(
      204,
    );
    expect((await call(cloud, 'GET', `/v1/workspaces/${ws.json.id}`, { token: s.access })).status).toBe(404);
  });

  it('shares with a team, the org, or a user — and nobody else sees it', async () => {
    const owner = await signIn(cloud, 'owner@example.com');
    const teamMate = await signIn(cloud, 'tm@example.com');
    const member = await signIn(cloud, 'member@example.com');
    const outsider = await signIn(cloud, 'out@example.com');
    const org = await makeOrg(cloud, owner, [{ s: teamMate }, { s: member }]);
    const team = await call(cloud, 'POST', `/v1/orgs/${org.id}/teams`, {
      token: owner.access,
      body: { name: 'Core' },
    });
    await call(cloud, 'PUT', `/v1/orgs/${org.id}/teams/${team.json.id}/members`, {
      token: owner.access,
      body: { userIds: [teamMate.userId] },
    });

    const ws = await call(cloud, 'POST', '/v1/workspaces', {
      token: owner.access,
      body: { orgId: org.id, doc },
    });
    const visible = async (s: { access: string }) =>
      (await call(cloud, 'GET', '/v1/workspaces', { token: s.access })).json
        .map((w: any) => w.id)
        .includes(ws.json.id);

    expect(await visible(teamMate)).toBe(false);
    const shareTeam = await call(cloud, 'PUT', `/v1/workspaces/${ws.json.id}/shares`, {
      token: owner.access,
      body: { shares: [{ principalType: 'team', principalId: team.json.id }] },
    });
    expect(shareTeam.status).toBe(200);
    expect(shareTeam.json.version).toBe(2);
    expect(await visible(teamMate)).toBe(true);
    expect(await visible(member)).toBe(false);
    expect((await call(cloud, 'GET', `/v1/workspaces/${ws.json.id}`, { token: member.access })).status).toBe(
      404,
    );

    await call(cloud, 'PUT', `/v1/workspaces/${ws.json.id}/shares`, {
      token: owner.access,
      body: { shares: [{ principalType: 'org', principalId: org.id }] },
    });
    expect(await visible(member)).toBe(true);
    expect(await visible(outsider)).toBe(false);

    // Shared members are read-only.
    const write = await call(cloud, 'PUT', `/v1/workspaces/${ws.json.id}`, {
      token: member.access,
      body: { doc: {} },
    });
    expect(write.status).toBe(403);

    // Principals must be inside the org.
    const bad = await call(cloud, 'PUT', `/v1/workspaces/${ws.json.id}/shares`, {
      token: owner.access,
      body: { shares: [{ principalType: 'user', principalId: outsider.userId }] },
    });
    expect(bad.status).toBe(422);
    const user = await call(cloud, 'PUT', `/v1/workspaces/${ws.json.id}/shares`, {
      token: owner.access,
      body: { shares: [{ principalType: 'user', principalId: member.userId }] },
    });
    expect(user.json.shares).toEqual([{ principalType: 'user', principalId: member.userId }]);
    expect(await visible(member)).toBe(true);
    expect(await visible(teamMate)).toBe(false);

    // Outsiders cannot create org workspaces.
    expect(
      (await call(cloud, 'POST', '/v1/workspaces', { token: outsider.access, body: { orgId: org.id, doc } }))
        .status,
    ).toBe(403);
  });

  it('keeps a "__proto__" key as plain data', async () => {
    const s = await signIn(cloud, 'proto@example.com');
    const ws = await call(cloud, 'POST', '/v1/workspaces', {
      token: s.access,
      body: '{"doc":{"__proto__":{"polluted":true},"name":"p"}}',
    });
    expect(ws.status).toBe(201);
    expect(Object.getPrototypeOf(ws.json.doc)).toBe(Object.prototype);
    expect(JSON.stringify(ws.json.doc)).toContain('"__proto__":{"polluted":true}');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const again = await call(cloud, 'GET', `/v1/workspaces/${ws.json.id}`, { token: s.access });
    expect(JSON.stringify(again.json.doc)).toContain('"__proto__":{"polluted":true}');
  });
});

describe('launchpad state', () => {
  it('starts empty and uses If-Match versions', async () => {
    const s = await signIn(cloud, 'ana@example.com');
    expect((await call(cloud, 'GET', '/v1/launchpad/state', { token: s.access })).json).toEqual({
      version: 0,
      doc: {},
    });
    const doc = { itemStates: { 'gh:1': { pinned: true } }, savedViews: [] };
    const put = await call(cloud, 'PUT', '/v1/launchpad/state', {
      token: s.access,
      body: { doc },
      headers: { 'if-match': '0' },
    });
    expect(put.json).toEqual({ version: 1 });
    expect((await call(cloud, 'GET', '/v1/launchpad/state', { token: s.access })).json).toEqual({
      version: 1,
      doc,
    });
    const conflict = await call(cloud, 'PUT', '/v1/launchpad/state', {
      token: s.access,
      body: { doc },
      headers: { 'if-match': '0' },
    });
    expect(conflict.status).toBe(412);
    expect(conflict.json.currentVersion).toBe(1);
  });
});
