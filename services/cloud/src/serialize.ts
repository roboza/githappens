/** Record → contract type conversions (`@githappens/cloud-api` shapes). */
import type {
  CloudWorkspace,
  Invite,
  Org,
  OrgMember,
  PatchMeta,
  SyncCategoryInfo,
  Team,
  UserRef,
} from '@githappens/cloud-api/types';
import type {
  InviteRec,
  MemberRec,
  OrgRec,
  PatchRec,
  SyncRec,
  TeamRec,
  UserRec,
  WorkspaceRec,
} from './store/types.ts';

/** Public user reference (no email): used where non-members may see it (patch authors, footprints). */
export function userRef(u: UserRec | undefined, id: string): UserRef {
  if (!u || u.deletedAt) return { id, name: 'Deleted user' };
  const ref: UserRef = { id: u.id, name: u.name };
  if (u.avatarUrl) ref.avatarUrl = u.avatarUrl;
  return ref;
}

/** Member-visible user reference (includes email). */
export function memberRef(u: UserRec | undefined, id: string): UserRef {
  const ref = userRef(u, id);
  if (u && !u.deletedAt) ref.email = u.email;
  return ref;
}

export function orgOut(o: OrgRec): Org {
  return {
    id: o.id,
    name: o.name,
    slug: o.slug,
    policies: { ...o.policies },
    footprintSalt: o.footprintSalt,
  };
}

export function memberOut(m: MemberRec, users: Map<string, UserRec>): OrgMember {
  return { user: memberRef(users.get(m.userId), m.userId), role: m.role, joinedAt: m.joinedAt.toISOString() };
}

export function teamOut(t: TeamRec): Team {
  return { id: t.id, orgId: t.orgId, name: t.name, memberIds: [...t.memberIds] };
}

export function inviteOut(i: InviteRec): Invite {
  return {
    id: i.id,
    orgId: i.orgId,
    email: i.email,
    role: i.role,
    expiresAt: i.expiresAt.toISOString(),
    createdAt: i.createdAt.toISOString(),
  };
}

export function syncInfo(s: SyncRec): SyncCategoryInfo {
  const info: SyncCategoryInfo = {
    category: s.category,
    version: s.version,
    updatedAt: s.updatedAt.toISOString(),
    size: s.ciphertext.length,
  };
  if (s.deviceId) info.deviceId = s.deviceId;
  return info;
}

export function workspaceOut(w: WorkspaceRec): CloudWorkspace {
  const out: CloudWorkspace = {
    id: w.id,
    ownerUserId: w.ownerUserId,
    version: w.version,
    doc: w.doc,
    shares: w.shares.map((s) => ({ ...s })),
    updatedAt: w.updatedAt.toISOString(),
  };
  if (w.orgId) out.orgId = w.orgId;
  return out;
}

export function patchMeta(p: PatchRec, users: Map<string, UserRec>, publicUrl: string): PatchMeta {
  const meta: PatchMeta = {
    id: p.id,
    title: p.title,
    kind: p.kind,
    author: userRef(users.get(p.authorId), p.authorId),
    baseSha: p.baseSha,
    e2e: p.e2e,
    size: p.size,
    sha256: p.sha256,
    visibility: p.visibility,
    createdAt: p.createdAt.toISOString(),
    webUrl: `${publicUrl}/p/${p.id}`,
  };
  if (p.description !== undefined) meta.description = p.description;
  if (p.orgId) meta.orgId = p.orgId;
  if (p.repo) meta.repo = { ...p.repo };
  if (p.baseBranch) meta.baseBranch = p.baseBranch;
  if (p.files) meta.files = p.files.map((f) => ({ ...f }));
  if (p.visibility === 'collaborators') {
    meta.collaborators = p.collaborators.map((id) => userRef(users.get(id), id));
  }
  if (p.expiresAt) meta.expiresAt = p.expiresAt.toISOString();
  return meta;
}

export async function usersById(
  store: { getUsers(ids: string[]): Promise<UserRec[]> },
  ids: Iterable<string>,
): Promise<Map<string, UserRec>> {
  const unique = [...new Set(ids)];
  return new Map((await store.getUsers(unique)).map((u) => [u.id, u]));
}
