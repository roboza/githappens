import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { call, makeOrg, signIn, startCloud, type TestCloud } from './helpers.ts';

let cloud: TestCloud;
beforeEach(async () => {
  cloud = await startCloud();
});
afterEach(async () => {
  await cloud.close();
});

describe('organizations', () => {
  it('creates an org with the caller as owner, default policies and a footprint salt', async () => {
    const s = await signIn(cloud, 'owner@example.com');
    const org = await call(cloud, 'POST', '/v1/orgs', { token: s.access, body: { name: 'Acme Corp' } });
    expect(org.status).toBe(201);
    expect(org.json).toMatchObject({
      name: 'Acme Corp',
      slug: 'acme-corp',
      policies: {
        patchMaxExpiryDays: null,
        allowPublicLinks: true,
        footprintSharePaths: false,
        footprintShareBranchNames: false,
      },
    });
    expect(Buffer.from(org.json.footprintSalt, 'base64url')).toHaveLength(32);

    const detail = await call(cloud, 'GET', `/v1/orgs/${org.json.id}`, { token: s.access });
    expect(detail.json).toMatchObject({ myRole: 'owner', teams: [] });
    expect(detail.json.members).toEqual([
      expect.objectContaining({
        role: 'owner',
        user: expect.objectContaining({ id: s.userId, email: 'owner@example.com' }),
      }),
    ]);
    const me = await call(cloud, 'GET', '/v1/me', { token: s.access });
    expect(me.json.orgs).toEqual([{ id: org.json.id, name: 'Acme Corp', slug: 'acme-corp', role: 'owner' }]);

    // Derived slug collision gets a suffix; an explicit one is a 409.
    const second = await call(cloud, 'POST', '/v1/orgs', { token: s.access, body: { name: 'Acme Corp' } });
    expect(second.json.slug).toMatch(/^acme-corp-[0-9a-f]{6}$/);
    expect(
      (await call(cloud, 'POST', '/v1/orgs', { token: s.access, body: { name: 'X', slug: 'acme-corp' } }))
        .status,
    ).toBe(409);
    expect((await call(cloud, 'POST', '/v1/orgs', { token: s.access, body: { name: '' } })).status).toBe(422);
  });

  it('hides orgs from non-members and enforces admin for changes', async () => {
    const owner = await signIn(cloud, 'owner@example.com');
    const member = await signIn(cloud, 'member@example.com');
    const outsider = await signIn(cloud, 'out@example.com');
    const org = await makeOrg(cloud, owner, [{ s: member }]);
    expect((await call(cloud, 'GET', `/v1/orgs/${org.id}`, { token: outsider.access })).status).toBe(404);
    expect((await call(cloud, 'GET', `/v1/orgs/${org.id}`, { token: member.access })).json.myRole).toBe(
      'member',
    );
    expect(
      (await call(cloud, 'PATCH', `/v1/orgs/${org.id}`, { token: member.access, body: { name: 'Hacked' } }))
        .status,
    ).toBe(403);
    expect(
      (
        await call(cloud, 'PATCH', `/v1/orgs/${org.id}/policies`, {
          token: member.access,
          body: { allowPublicLinks: false },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(cloud, 'POST', `/v1/orgs/${org.id}/invites`, {
          token: member.access,
          body: { email: 'x@example.com' },
        })
      ).status,
    ).toBe(403);
    expect(
      (await call(cloud, 'POST', `/v1/orgs/${org.id}/teams`, { token: member.access, body: { name: 'T' } }))
        .status,
    ).toBe(403);
    const renamed = await call(cloud, 'PATCH', `/v1/orgs/${org.id}`, {
      token: owner.access,
      body: { name: 'Acme 2' },
    });
    expect(renamed.json.name).toBe('Acme 2');
  });

  it('updates policies with validation', async () => {
    const owner = await signIn(cloud, 'owner@example.com');
    const org = await makeOrg(cloud, owner);
    const p = await call(cloud, 'PATCH', `/v1/orgs/${org.id}/policies`, {
      token: owner.access,
      body: { patchMaxExpiryDays: 7, allowPublicLinks: false },
    });
    expect(p.json).toEqual({
      patchMaxExpiryDays: 7,
      allowPublicLinks: false,
      footprintSharePaths: false,
      footprintShareBranchNames: false,
    });
    expect(
      (
        await call(cloud, 'PATCH', `/v1/orgs/${org.id}/policies`, {
          token: owner.access,
          body: { patchMaxExpiryDays: 0 },
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await call(cloud, 'PATCH', `/v1/orgs/${org.id}/policies`, {
          token: owner.access,
          body: { allowPublicLinks: 'yes' },
        })
      ).status,
    ).toBe(422);
    const back = await call(cloud, 'PATCH', `/v1/orgs/${org.id}/policies`, {
      token: owner.access,
      body: { patchMaxExpiryDays: null },
    });
    expect(back.json.patchMaxExpiryDays).toBeNull();
  });

  it('deletes an org (owner only)', async () => {
    const owner = await signIn(cloud, 'owner@example.com');
    const admin = await signIn(cloud, 'admin@example.com');
    const org = await makeOrg(cloud, owner, [{ s: admin, role: 'admin' }]);
    expect((await call(cloud, 'DELETE', `/v1/orgs/${org.id}`, { token: admin.access })).status).toBe(403);
    expect((await call(cloud, 'DELETE', `/v1/orgs/${org.id}`, { token: owner.access })).status).toBe(204);
    expect((await call(cloud, 'GET', `/v1/orgs/${org.id}`, { token: owner.access })).status).toBe(404);
  });
});

describe('invites', () => {
  it('invites, lists, accepts (any signed-in user) and serves the landing page', async () => {
    const owner = await signIn(cloud, 'owner@example.com');
    const newbie = await signIn(cloud, 'someone-else@example.com');
    const org = await makeOrg(cloud, owner);
    const inv = await call(cloud, 'POST', `/v1/orgs/${org.id}/invites`, {
      token: owner.access,
      body: { email: 'Newbie@Example.com', role: 'admin' },
    });
    expect(inv.status).toBe(201);
    expect(inv.json).toMatchObject({ orgId: org.id, email: 'newbie@example.com', role: 'admin' });
    expect(inv.json.acceptUrl).toMatch(new RegExp(`^${cloud.url}/invite/kli_[A-Za-z0-9_-]{43}$`));
    expect(new Date(inv.json.expiresAt).getTime() - cloud.clock.now).toBe(7 * 86_400_000);
    const token = inv.json.acceptUrl.split('/invite/')[1];

    const list = await call(cloud, 'GET', `/v1/orgs/${org.id}/invites`, { token: owner.access });
    expect(list.json.map((i: any) => i.id)).toEqual([inv.json.id]);

    const page = await call(cloud, 'GET', `/invite/${token}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain(`githappens://invite/${token}`);
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");

    const acc = await call(cloud, 'POST', `/v1/invites/${token}/accept`, { token: newbie.access });
    expect(acc.status).toBe(200);
    expect(acc.json).toMatchObject({ id: org.id, footprintSalt: org.footprintSalt });
    expect((await call(cloud, 'GET', `/v1/orgs/${org.id}`, { token: newbie.access })).json.myRole).toBe(
      'admin',
    );
    expect((await call(cloud, 'GET', `/v1/orgs/${org.id}/invites`, { token: owner.access })).json).toEqual(
      [],
    );

    // Re-accepting as a member is idempotent; another user gets 410.
    expect((await call(cloud, 'POST', `/v1/invites/${token}/accept`, { token: newbie.access })).status).toBe(
      200,
    );
    const third = await signIn(cloud, 'third@example.com');
    expect((await call(cloud, 'POST', `/v1/invites/${token}/accept`, { token: third.access })).status).toBe(
      410,
    );
    expect((await call(cloud, 'GET', `/invite/${token}`)).status).toBe(410);
    expect((await call(cloud, 'POST', '/v1/invites/kli_nope/accept', { token: third.access })).status).toBe(
      404,
    );
  });

  it('expires after 7 days, can be revoked, and only owners invite owners', async () => {
    const owner = await signIn(cloud, 'owner@example.com');
    const admin = await signIn(cloud, 'admin@example.com');
    const x = await signIn(cloud, 'x@example.com');
    const org = await makeOrg(cloud, owner, [{ s: admin, role: 'admin' }]);
    expect(
      (
        await call(cloud, 'POST', `/v1/orgs/${org.id}/invites`, {
          token: admin.access,
          body: { email: 'o@example.com', role: 'owner' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(cloud, 'POST', `/v1/orgs/${org.id}/invites`, {
          token: admin.access,
          body: { email: 'not-an-email' },
        })
      ).status,
    ).toBe(422);

    const a = await call(cloud, 'POST', `/v1/orgs/${org.id}/invites`, {
      token: admin.access,
      body: { email: 'x@example.com' },
    });
    const b = await call(cloud, 'POST', `/v1/orgs/${org.id}/invites`, {
      token: admin.access,
      body: { email: 'x@example.com' },
    });
    expect(
      (await call(cloud, 'DELETE', `/v1/orgs/${org.id}/invites/${b.json.id}`, { token: admin.access }))
        .status,
    ).toBe(204);
    expect(
      (
        await call(cloud, 'POST', `/v1/invites/${b.json.acceptUrl.split('/invite/')[1]}/accept`, {
          token: x.access,
        })
      ).status,
    ).toBe(404);

    cloud.clock.now += 8 * 86_400_000;
    const x2 = await signIn(cloud, 'x@example.com'); // access tokens only live 15 min
    const late = await call(cloud, 'POST', `/v1/invites/${a.json.acceptUrl.split('/invite/')[1]}/accept`, {
      token: x2.access,
    });
    expect(late.status).toBe(410);
    expect(late.json.error).toBe('gone');
  });
});

describe('members and roles', () => {
  it('admins manage members; owner role changes need an owner; the last owner stays', async () => {
    const owner = await signIn(cloud, 'owner@example.com');
    const admin = await signIn(cloud, 'admin@example.com');
    const member = await signIn(cloud, 'member@example.com');
    const org = await makeOrg(cloud, owner, [{ s: admin, role: 'admin' }, { s: member }]);
    const role = (actor: { access: string }, userId: string, r: string) =>
      call(cloud, 'PATCH', `/v1/orgs/${org.id}/members/${userId}`, {
        token: actor.access,
        body: { role: r },
      });

    expect((await role(member, admin.userId, 'member')).status).toBe(403);
    expect((await role(admin, member.userId, 'owner')).status).toBe(403);
    expect((await role(admin, owner.userId, 'member')).status).toBe(403);
    const promoted = await role(admin, member.userId, 'admin');
    expect(promoted.status).toBe(200);
    expect(promoted.json).toMatchObject({ role: 'admin', user: { id: member.userId } });
    expect((await role(owner, owner.userId, 'admin')).status).toBe(409); // last owner
    expect((await role(owner, admin.userId, 'owner')).status).toBe(200);
    expect((await role(owner, owner.userId, 'member')).status).toBe(200); // another owner exists now
    expect((await role(owner, admin.userId, 'bogus')).status).toBe(403); // owner is now a plain member
  });

  it('members can leave; admins remove members; owners cannot leave as last owner', async () => {
    const owner = await signIn(cloud, 'owner@example.com');
    const admin = await signIn(cloud, 'admin@example.com');
    const m1 = await signIn(cloud, 'm1@example.com');
    const m2 = await signIn(cloud, 'm2@example.com');
    const org = await makeOrg(cloud, owner, [{ s: admin, role: 'admin' }, { s: m1 }, { s: m2 }]);
    const del = (actor: { access: string }, userId: string) =>
      call(cloud, 'DELETE', `/v1/orgs/${org.id}/members/${userId}`, { token: actor.access });

    expect((await del(m1, m2.userId)).status).toBe(403);
    expect((await del(m1, m1.userId)).status).toBe(204);
    expect((await call(cloud, 'GET', `/v1/orgs/${org.id}`, { token: m1.access })).status).toBe(404);
    expect((await del(admin, m2.userId)).status).toBe(204);
    expect((await del(admin, owner.userId)).status).toBe(403);
    expect((await del(owner, owner.userId)).status).toBe(409);
    const detail = await call(cloud, 'GET', `/v1/orgs/${org.id}`, { token: owner.access });
    expect(detail.json.members.map((m: any) => m.user.id).sort()).toEqual(
      [owner.userId, admin.userId].sort(),
    );
  });
});

describe('teams', () => {
  it('creates, renames, sets members (org members only) and deletes teams', async () => {
    const owner = await signIn(cloud, 'owner@example.com');
    const member = await signIn(cloud, 'member@example.com');
    const outsider = await signIn(cloud, 'out@example.com');
    const org = await makeOrg(cloud, owner, [{ s: member }]);
    const t = await call(cloud, 'POST', `/v1/orgs/${org.id}/teams`, {
      token: owner.access,
      body: { name: 'Core' },
    });
    expect(t.status).toBe(201);
    expect(t.json).toMatchObject({ orgId: org.id, name: 'Core', memberIds: [] });
    const renamed = await call(cloud, 'PATCH', `/v1/orgs/${org.id}/teams/${t.json.id}`, {
      token: owner.access,
      body: { name: 'Platform' },
    });
    expect(renamed.json.name).toBe('Platform');
    const bad = await call(cloud, 'PUT', `/v1/orgs/${org.id}/teams/${t.json.id}/members`, {
      token: owner.access,
      body: { userIds: [outsider.userId] },
    });
    expect(bad.status).toBe(422);
    const set = await call(cloud, 'PUT', `/v1/orgs/${org.id}/teams/${t.json.id}/members`, {
      token: owner.access,
      body: { userIds: [member.userId, owner.userId, member.userId] },
    });
    expect([...set.json.memberIds].sort()).toEqual([member.userId, owner.userId].sort());
    const list = await call(cloud, 'GET', `/v1/orgs/${org.id}/teams`, { token: member.access });
    expect(list.json).toHaveLength(1);
    expect([...list.json[0].memberIds].sort()).toEqual([member.userId, owner.userId].sort());

    // Leaving the org drops team membership.
    await call(cloud, 'DELETE', `/v1/orgs/${org.id}/members/${member.userId}`, { token: member.access });
    expect(
      (await call(cloud, 'GET', `/v1/orgs/${org.id}/teams`, { token: owner.access })).json[0].memberIds,
    ).toEqual([owner.userId]);

    expect(
      (await call(cloud, 'DELETE', `/v1/orgs/${org.id}/teams/${t.json.id}`, { token: owner.access })).status,
    ).toBe(204);
    expect((await call(cloud, 'GET', `/v1/orgs/${org.id}/teams`, { token: owner.access })).json).toEqual([]);
    expect(
      (
        await call(cloud, 'PATCH', `/v1/orgs/${org.id}/teams/${t.json.id}`, {
          token: owner.access,
          body: { name: 'x' },
        })
      ).status,
    ).toBe(404);
  });
});
