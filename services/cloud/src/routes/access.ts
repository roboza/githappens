/** Membership lookups shared by the org-aware routes. */
import type { OrgRole } from '@githappens/cloud-api/types';
import type { Ctx } from '../context.ts';
import { forbidden, notFound } from '../http.ts';
import type { MemberRec, OrgRec } from '../store/types.ts';
import { uuidParam } from '../validation.ts';

export interface Membership {
  roles: Map<string, OrgRole>;
  teamIds: string[];
}

export async function membershipOf(ctx: Ctx, userId: string): Promise<Membership> {
  const [orgs, teamIds] = await Promise.all([
    ctx.app.store.listOrgsForUser(userId),
    ctx.app.store.listTeamIdsForUser(userId),
  ]);
  return { roles: new Map(orgs.map(({ org, role }) => [org.id, role])), teamIds };
}

export const isAdminRole = (role: OrgRole | undefined): boolean => role === 'admin' || role === 'owner';

/**
 * Load an org the caller belongs to. Non-members get 404 (org ids are not secret, but there is no
 * reason to confirm their existence). `admin` additionally requires admin/owner (403 otherwise).
 */
export async function orgForMember(
  ctx: Ctx,
  rawId: string | undefined,
  userId: string,
  need: 'member' | 'admin' | 'owner' = 'member',
): Promise<{ org: OrgRec; me: MemberRec }> {
  const id = uuidParam(rawId, 'Organization not found');
  const [org, me] = await Promise.all([ctx.app.store.getOrg(id), ctx.app.store.getMember(id, userId)]);
  if (!org || !me) throw notFound('Organization not found');
  if (need === 'admin' && !isAdminRole(me.role)) throw forbidden('Organization admin role required');
  if (need === 'owner' && me.role !== 'owner') throw forbidden('Organization owner role required');
  return { org, me };
}
