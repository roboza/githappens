/**
 * Organizations (spec 14 §6.7): orgs, members & roles, invites, teams, policies. No seats/billing.
 *
 * Role rules: admins (and owners) manage the org; only owners may grant/revoke the owner role,
 * remove an owner, invite as owner or delete the org; the last owner can neither be demoted nor
 * leave (409 — transfer ownership or delete the org). Leaving / removal deletes the user's
 * footprints and team memberships in that org.
 */
import { randomBytes } from 'node:crypto';
import type { OrgDetail, OrgPolicies, OrgRole } from '@githappens/cloud-api/types';
// Value imports come from the extension-free leaf module so Node's type stripping can load it.
import { DEFAULT_ORG_POLICIES } from '@githappens/cloud-api/types';
import type { Ctx } from '../context.ts';
import { randomToken, sha256, uuid } from '../crypto.ts';
import { conflict, forbidden, gone, invalid, notFound, type Router, sendHtml } from '../http.ts';
import { inviteOut, memberOut, orgOut, teamOut, usersById } from '../serialize.ts';
import type { InviteRec, OrgRec, TeamRec } from '../store/types.ts';
import { asObject, email, optString, reqEnum, reqString, uuidList, uuidParam } from '../validation.ts';
import { invitePage, messagePage, newNonce, pageCsp } from '../views.ts';
import { orgForMember } from './access.ts';

export const INVITE_TTL_MS = 7 * 86_400_000;
const ROLES = ['owner', 'admin', 'member'] as const;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const INVITE_TOKEN_RE = /^kli_[A-Za-z0-9_-]{43}$/;
const NAME = { max: 100, pattern: /\S/ };

function slugify(name: string): string {
  const s = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '');
  return s.length >= 2 ? s : `org-${s}`.replace(/-+$/, '');
}

function parsePolicies(body: Record<string, unknown>, current: OrgPolicies): OrgPolicies {
  const next = { ...current };
  if ('patchMaxExpiryDays' in body) {
    const v = body.patchMaxExpiryDays;
    if (v !== null && (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 3650)) {
      throw invalid('"patchMaxExpiryDays" must be null or an integer between 1 and 3650');
    }
    next.patchMaxExpiryDays = v;
  }
  for (const key of ['allowPublicLinks', 'footprintSharePaths', 'footprintShareBranchNames'] as const) {
    if (key in body) {
      if (typeof body[key] !== 'boolean') throw invalid(`"${key}" must be a boolean`);
      next[key] = body[key];
    }
  }
  return next;
}

async function orgDetail(ctx: Ctx, org: OrgRec, myRole: OrgRole): Promise<OrgDetail> {
  const [members, teams] = await Promise.all([
    ctx.app.store.listMembers(org.id),
    ctx.app.store.listTeams(org.id),
  ]);
  const users = await usersById(
    ctx.app.store,
    members.map((m) => m.userId),
  );
  return {
    ...orgOut(org),
    members: members.map((m) => memberOut(m, users)),
    teams: teams.map(teamOut),
    myRole,
  };
}

async function ownerCount(ctx: Ctx, orgId: string): Promise<number> {
  return (await ctx.app.store.listMembers(orgId)).filter((m) => m.role === 'owner').length;
}

async function teamInOrg(ctx: Ctx, orgId: string, rawTeamId: string | undefined): Promise<TeamRec> {
  const id = uuidParam(rawTeamId, 'Team not found');
  const team = await ctx.app.store.getTeam(id);
  if (!team || team.orgId !== orgId) throw notFound('Team not found');
  return team;
}

export function registerOrgs(router: Router<Ctx>): void {
  router.add('POST', '/v1/orgs', async (ctx) => {
    const user = await ctx.user();
    const body = await ctx.body();
    const name = reqString(body, 'name', NAME).trim();
    const explicit = optString(body, 'slug', { max: 40 });
    if (explicit !== undefined && !SLUG_RE.test(explicit)) {
      throw invalid('"slug" must be 1-40 lowercase letters, digits or dashes');
    }
    let slug = explicit ?? slugify(name);
    if (await ctx.app.store.getOrgBySlug(slug)) {
      if (explicit) throw conflict('That slug is already taken');
      slug = `${slug}-${randomBytes(3).toString('hex')}`;
    }
    const now = ctx.date();
    const org: OrgRec = {
      id: uuid(),
      name,
      slug,
      policies: { ...DEFAULT_ORG_POLICIES },
      footprintSalt: randomBytes(32).toString('base64url'),
      createdBy: user.id,
      createdAt: now,
    };
    try {
      await ctx.app.store.createOrg(org, { orgId: org.id, userId: user.id, role: 'owner', joinedAt: now });
    } catch (err) {
      if (await ctx.app.store.getOrgBySlug(slug)) throw conflict('That slug is already taken');
      throw err;
    }
    ctx.json(201, orgOut(org));
  });

  router.add('GET', '/v1/orgs/:id', async (ctx, params) => {
    const user = await ctx.user();
    const { org, me } = await orgForMember(ctx, params.id, user.id);
    ctx.json(200, await orgDetail(ctx, org, me.role));
  });

  router.add('PATCH', '/v1/orgs/:id', async (ctx, params) => {
    const user = await ctx.user();
    const { org } = await orgForMember(ctx, params.id, user.id, 'admin');
    const body = await ctx.body();
    const name = optString(body, 'name', { min: 1, ...NAME })?.trim();
    if (name !== undefined) await ctx.app.store.updateOrg(org.id, { name });
    ctx.json(200, orgOut({ ...org, name: name ?? org.name }));
  });

  router.add('DELETE', '/v1/orgs/:id', async (ctx, params) => {
    const user = await ctx.user();
    const { org } = await orgForMember(ctx, params.id, user.id, 'owner');
    const now = ctx.date();
    // Org-scoped patches become unreachable now; the purge job removes their blobs.
    await ctx.app.store.markPatchesDeleted({ orgId: org.id }, now);
    await ctx.app.store.deleteOrg(org.id);
    await ctx.app.store.audit({
      at: now,
      actorId: user.id,
      orgId: org.id,
      action: 'org.delete',
      target: org.id,
    });
    ctx.json(204, undefined);
  });

  router.add('PATCH', '/v1/orgs/:id/policies', async (ctx, params) => {
    const user = await ctx.user();
    const { org } = await orgForMember(ctx, params.id, user.id, 'admin');
    const policies = parsePolicies(await ctx.body(), org.policies);
    await ctx.app.store.updateOrg(org.id, { policies });
    await ctx.app.store.audit({
      at: ctx.date(),
      actorId: user.id,
      orgId: org.id,
      action: 'org.policies',
      target: org.id,
      detail: { ...policies },
    });
    ctx.json(200, policies);
  });

  router.add('PATCH', '/v1/orgs/:id/members/:userId', async (ctx, params) => {
    const user = await ctx.user();
    const { org, me } = await orgForMember(ctx, params.id, user.id, 'admin');
    const targetId = uuidParam(params.userId, 'Member not found');
    const target = await ctx.app.store.getMember(org.id, targetId);
    if (!target) throw notFound('Member not found');
    const role = reqEnum(await ctx.body(), 'role', ROLES);
    if ((role === 'owner' || target.role === 'owner') && me.role !== 'owner') {
      throw forbidden('Only owners can grant or revoke the owner role');
    }
    if (target.role === 'owner' && role !== 'owner' && (await ownerCount(ctx, org.id)) <= 1) {
      throw conflict('An organization needs at least one owner');
    }
    await ctx.app.store.upsertMember({ ...target, role });
    await ctx.app.store.audit({
      at: ctx.date(),
      actorId: user.id,
      orgId: org.id,
      action: 'member.role',
      target: targetId,
      detail: { role },
    });
    const users = await usersById(ctx.app.store, [targetId]);
    ctx.json(200, memberOut({ ...target, role }, users));
  });

  router.add('DELETE', '/v1/orgs/:id/members/:userId', async (ctx, params) => {
    const user = await ctx.user();
    const { org, me } = await orgForMember(ctx, params.id, user.id);
    const targetId = uuidParam(params.userId, 'Member not found');
    const self = targetId === user.id;
    if (!self && me.role !== 'admin' && me.role !== 'owner')
      throw forbidden('Organization admin role required');
    const target = self ? me : await ctx.app.store.getMember(org.id, targetId);
    if (!target) throw notFound('Member not found');
    if (target.role === 'owner') {
      if (!self && me.role !== 'owner') throw forbidden('Only owners can remove an owner');
      if ((await ownerCount(ctx, org.id)) <= 1) {
        throw conflict('The last owner cannot leave; transfer ownership or delete the organization');
      }
    }
    await ctx.app.store.removeMember(org.id, targetId);
    await ctx.app.store.audit({
      at: ctx.date(),
      actorId: user.id,
      orgId: org.id,
      action: self ? 'member.leave' : 'member.remove',
      target: targetId,
    });
    ctx.json(204, undefined);
  });

  router.add('POST', '/v1/orgs/:id/invites', async (ctx, params) => {
    const user = await ctx.user();
    const { org, me } = await orgForMember(ctx, params.id, user.id, 'admin');
    const body = await ctx.body();
    const inviteEmail = email(body.email);
    const role = body.role === undefined ? 'member' : reqEnum(body, 'role', ROLES);
    if (role === 'owner' && me.role !== 'owner') throw forbidden('Only owners can invite owners');
    const token = randomToken('kli_');
    const now = ctx.date();
    const invite: InviteRec = {
      id: uuid(),
      orgId: org.id,
      email: inviteEmail,
      role,
      tokenHash: sha256(token),
      createdBy: user.id,
      createdAt: now,
      expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
    };
    await ctx.app.store.createInvite(invite);
    await ctx.app.store.audit({
      at: now,
      actorId: user.id,
      orgId: org.id,
      action: 'invite.create',
      target: invite.id,
      detail: { role },
    });
    ctx.json(201, { ...inviteOut(invite), acceptUrl: `${ctx.app.config.publicUrl}/invite/${token}` });
  });

  router.add('GET', '/v1/orgs/:id/invites', async (ctx, params) => {
    const user = await ctx.user();
    const { org } = await orgForMember(ctx, params.id, user.id, 'admin');
    ctx.json(200, (await ctx.app.store.listPendingInvites(org.id, ctx.date())).map(inviteOut));
  });

  router.add('DELETE', '/v1/orgs/:id/invites/:inviteId', async (ctx, params) => {
    const user = await ctx.user();
    const { org } = await orgForMember(ctx, params.id, user.id, 'admin');
    const inviteId = uuidParam(params.inviteId, 'Invite not found');
    const invite = await ctx.app.store.getInvite(inviteId);
    if (!invite || invite.orgId !== org.id) throw notFound('Invite not found');
    await ctx.app.store.deleteInvite(invite.id);
    ctx.json(204, undefined);
  });

  router.add('POST', '/v1/invites/:token/accept', async (ctx, params) => {
    const user = await ctx.user();
    const token = params.token ?? '';
    if (!INVITE_TOKEN_RE.test(token)) throw notFound('Invite not found');
    const invite = await ctx.app.store.getInviteByTokenHash(sha256(token));
    if (!invite) throw notFound('Invite not found');
    const org = await ctx.app.store.getOrg(invite.orgId);
    if (!org) throw notFound('Invite not found');
    const existing = await ctx.app.store.getMember(org.id, user.id);
    if (existing) {
      // Already a member (e.g. the link was opened twice): keep the current role.
      await ctx.app.store.markInviteAccepted(invite.id, ctx.date());
      ctx.json(200, orgOut(org));
      return;
    }
    if (invite.acceptedAt) throw gone('This invite was already used');
    if (invite.expiresAt <= ctx.date()) throw gone('This invite has expired');
    if (!(await ctx.app.store.markInviteAccepted(invite.id, ctx.date())))
      throw gone('This invite was already used');
    // v1: the accepting account's email need not match the invited address (contract).
    await ctx.app.store.upsertMember({
      orgId: org.id,
      userId: user.id,
      role: invite.role,
      joinedAt: ctx.date(),
    });
    await ctx.app.store.audit({
      at: ctx.date(),
      actorId: user.id,
      orgId: org.id,
      action: 'invite.accept',
      target: invite.id,
      detail: { role: invite.role },
    });
    ctx.json(200, orgOut(org));
  });

  router.add('GET', '/v1/orgs/:id/teams', async (ctx, params) => {
    const user = await ctx.user();
    const { org } = await orgForMember(ctx, params.id, user.id);
    ctx.json(200, (await ctx.app.store.listTeams(org.id)).map(teamOut));
  });

  router.add('POST', '/v1/orgs/:id/teams', async (ctx, params) => {
    const user = await ctx.user();
    const { org } = await orgForMember(ctx, params.id, user.id, 'admin');
    const name = reqString(await ctx.body(), 'name', NAME).trim();
    const team: TeamRec = { id: uuid(), orgId: org.id, name, memberIds: [], createdAt: ctx.date() };
    await ctx.app.store.createTeam(team);
    ctx.json(201, teamOut(team));
  });

  router.add('PATCH', '/v1/orgs/:id/teams/:teamId', async (ctx, params) => {
    const user = await ctx.user();
    const { org } = await orgForMember(ctx, params.id, user.id, 'admin');
    const team = await teamInOrg(ctx, org.id, params.teamId);
    const name = reqString(await ctx.body(), 'name', NAME).trim();
    await ctx.app.store.renameTeam(team.id, name);
    ctx.json(200, teamOut({ ...team, name }));
  });

  router.add('DELETE', '/v1/orgs/:id/teams/:teamId', async (ctx, params) => {
    const user = await ctx.user();
    const { org } = await orgForMember(ctx, params.id, user.id, 'admin');
    const team = await teamInOrg(ctx, org.id, params.teamId);
    await ctx.app.store.deleteTeam(team.id);
    ctx.json(204, undefined);
  });

  router.add('PUT', '/v1/orgs/:id/teams/:teamId/members', async (ctx, params) => {
    const user = await ctx.user();
    const { org } = await orgForMember(ctx, params.id, user.id, 'admin');
    const team = await teamInOrg(ctx, org.id, params.teamId);
    const userIds = uuidList(asObject(await ctx.body(), 'body').userIds, 'userIds', 1000);
    const memberIds = new Set((await ctx.app.store.listMembers(org.id)).map((m) => m.userId));
    if (userIds.some((id) => !memberIds.has(id)))
      throw invalid('Every team member must be a member of the organization');
    await ctx.app.store.setTeamMembers(team.id, userIds);
    await ctx.app.store.audit({
      at: ctx.date(),
      actorId: user.id,
      orgId: org.id,
      action: 'team.members',
      target: team.id,
      detail: { userIds },
    });
    ctx.json(200, teamOut({ ...team, memberIds: userIds }));
  });

  // PUBLIC landing page for invite links: deep-links into the app.
  router.add('GET', '/invite/:token', async (ctx, params) => {
    const token = params.token ?? '';
    const nonce = newNonce();
    const invite = INVITE_TOKEN_RE.test(token)
      ? await ctx.app.store.getInviteByTokenHash(sha256(token))
      : undefined;
    const org = invite ? await ctx.app.store.getOrg(invite.orgId) : undefined;
    if (!invite || !org) {
      sendHtml(
        ctx.res,
        404,
        messagePage(nonce, 'Invite not found', 'This invite link is not valid.'),
        pageCsp(nonce),
      );
      return;
    }
    if (invite.acceptedAt || invite.expiresAt <= ctx.date()) {
      sendHtml(
        ctx.res,
        410,
        messagePage(
          nonce,
          'Invite expired',
          'This invite was already used or has expired. Ask an admin for a new one.',
        ),
        pageCsp(nonce),
      );
      return;
    }
    sendHtml(ctx.res, 200, invitePage(nonce, org.name, `githappens://invite/${token}`), pageCsp(nonce));
  });
}
