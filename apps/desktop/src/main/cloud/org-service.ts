import type { Invite, Org, OrgDetail, OrgMember, OrgPolicies, OrgRole, Team } from '@githappens/cloud-api';

import type { CloudHttp } from './cloud-http';

const ROLES: readonly OrgRole[] = ['owner', 'admin', 'member'];
const enc = encodeURIComponent;

function req(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`Invalid ${name}`);
  return v.trim();
}

function role(v: unknown): OrgRole {
  if (!ROLES.includes(v as OrgRole)) throw new Error('Invalid role');
  return v as OrgRole;
}

/**
 * Minimal organizations (spec 14 §6.7): orgs, members/roles, invites, teams and policies — a thin
 * layer over the REST routes. Membership-changing calls refresh `/v1/me` so the account menu's org
 * list stays current.
 */
export class OrgService {
  constructor(
    private readonly http: CloudHttp,
    private readonly refreshMe: () => Promise<unknown>,
  ) {}

  private async call<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T> {
    return (await this.http.request<T>(method, path, body === undefined ? {} : { body })).data;
  }

  private async thenRefresh<T>(p: Promise<T>): Promise<T> {
    const out = await p;
    await this.refreshMe().catch(() => undefined);
    return out;
  }

  create(name: string, slug?: string): Promise<Org> {
    const body = { name: req(name, 'name'), ...(slug?.trim() ? { slug: slug.trim() } : {}) };
    return this.thenRefresh(this.call<Org>('POST', '/v1/orgs', body));
  }

  get(orgId: string): Promise<OrgDetail> {
    return this.call('GET', `/v1/orgs/${enc(req(orgId, 'org'))}`);
  }

  rename(orgId: string, name: string): Promise<Org> {
    return this.thenRefresh(
      this.call<Org>('PATCH', `/v1/orgs/${enc(req(orgId, 'org'))}`, { name: req(name, 'name') }),
    );
  }

  async delete(orgId: string): Promise<void> {
    await this.thenRefresh(this.call('DELETE', `/v1/orgs/${enc(req(orgId, 'org'))}`));
  }

  setPolicies(orgId: string, policies: Partial<OrgPolicies>): Promise<OrgPolicies> {
    const p: Partial<OrgPolicies> = {};
    if (policies.patchMaxExpiryDays !== undefined) {
      const d = policies.patchMaxExpiryDays;
      if (d !== null && (!Number.isInteger(d) || d < 1 || d > 3650)) throw new Error('Invalid expiry cap');
      p.patchMaxExpiryDays = d;
    }
    for (const k of ['allowPublicLinks', 'footprintSharePaths', 'footprintShareBranchNames'] as const) {
      if (policies[k] !== undefined) p[k] = !!policies[k];
    }
    return this.call('PATCH', `/v1/orgs/${enc(req(orgId, 'org'))}/policies`, p);
  }

  setRole(orgId: string, userId: string, r: OrgRole): Promise<OrgMember> {
    return this.call('PATCH', `/v1/orgs/${enc(req(orgId, 'org'))}/members/${enc(req(userId, 'user'))}`, {
      role: role(r),
    });
  }

  async removeMember(orgId: string, userId: string): Promise<void> {
    await this.call('DELETE', `/v1/orgs/${enc(req(orgId, 'org'))}/members/${enc(req(userId, 'user'))}`);
  }

  async leave(orgId: string): Promise<void> {
    const me = this.http.me();
    if (!me) throw new Error('Sign in first.');
    await this.thenRefresh(this.removeMember(orgId, me.id));
  }

  invite(orgId: string, email: string, r: OrgRole): Promise<Invite & { acceptUrl: string }> {
    const e = req(email, 'email');
    if (!/^[^\s@]+@[^\s@]+$/.test(e)) throw new Error('Enter a valid email address.');
    return this.call('POST', `/v1/orgs/${enc(req(orgId, 'org'))}/invites`, { email: e, role: role(r) });
  }

  invites(orgId: string): Promise<Invite[]> {
    return this.call('GET', `/v1/orgs/${enc(req(orgId, 'org'))}/invites`);
  }

  async revokeInvite(orgId: string, inviteId: string): Promise<void> {
    await this.call('DELETE', `/v1/orgs/${enc(req(orgId, 'org'))}/invites/${enc(req(inviteId, 'invite'))}`);
  }

  acceptInvite(token: string): Promise<Org> {
    const t = req(token, 'invite token');
    if (!/^[A-Za-z0-9_-]{8,256}$/.test(t)) throw new Error('Invalid invite link.');
    return this.thenRefresh(this.call<Org>('POST', `/v1/invites/${enc(t)}/accept`));
  }

  teams(orgId: string): Promise<Team[]> {
    return this.call('GET', `/v1/orgs/${enc(req(orgId, 'org'))}/teams`);
  }

  createTeam(orgId: string, name: string): Promise<Team> {
    return this.call('POST', `/v1/orgs/${enc(req(orgId, 'org'))}/teams`, { name: req(name, 'name') });
  }

  renameTeam(orgId: string, teamId: string, name: string): Promise<Team> {
    return this.call('PATCH', `/v1/orgs/${enc(req(orgId, 'org'))}/teams/${enc(req(teamId, 'team'))}`, {
      name: req(name, 'name'),
    });
  }

  async deleteTeam(orgId: string, teamId: string): Promise<void> {
    await this.call('DELETE', `/v1/orgs/${enc(req(orgId, 'org'))}/teams/${enc(req(teamId, 'team'))}`);
  }

  setTeamMembers(orgId: string, teamId: string, userIds: string[]): Promise<Team> {
    if (!Array.isArray(userIds) || userIds.some((u) => typeof u !== 'string'))
      throw new Error('Invalid members');
    return this.call('PUT', `/v1/orgs/${enc(req(orgId, 'org'))}/teams/${enc(req(teamId, 'team'))}/members`, {
      userIds,
    });
  }
}
