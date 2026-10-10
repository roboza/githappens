/**
 * In-memory {@link Store} for tests and local development. Everything is lost on restart. Values
 * are deep-copied on the way in and out so callers can never mutate stored state by accident.
 */
import type { OrgPolicies, OrgRole, WorkspaceShare } from '@githappens/cloud-api/types';
import type {
  AuditRec,
  AuthCodeRec,
  FootprintRec,
  IdentityRec,
  InviteRec,
  LaunchpadRec,
  MemberRec,
  OrgRec,
  PatchQuery,
  PatchRec,
  RefreshTokenRec,
  RepoIdentityRec,
  Store,
  SuggestionQuery,
  SuggestionRec,
  SyncRec,
  TeamRec,
  UserRec,
  VersionedWrite,
  WorkspaceRec,
} from './types.ts';

function clone<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (Buffer.isBuffer(value)) return Buffer.from(value) as T;
  if (Array.isArray(value)) return value.map((v: unknown) => clone(v)) as T;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, clone(v)]),
  ) as T;
}

/** Delete matching entries; returns how many were removed. */
function sweep<V>(map: Map<string, V>, pred: (v: V) => boolean): number {
  let n = 0;
  for (const [k, v] of map) {
    if (pred(v)) {
      map.delete(k);
      n++;
    }
  }
  return n;
}

const hex = (b: Buffer): string => b.toString('hex');
const fpKey = (orgId: string, userId: string, repoId: string, branchHash: string): string =>
  `${orgId}\u0000${userId}\u0000${repoId}\u0000${branchHash}`;

export class MemoryStore implements Store {
  readonly kind = 'memory' as const;
  private users = new Map<string, UserRec>();
  private identities = new Map<string, IdentityRec>();
  private authCodes = new Map<string, AuthCodeRec>();
  private nonces = new Map<string, Date>();
  private refresh = new Map<string, RefreshTokenRec>();
  private orgs = new Map<string, OrgRec>();
  private members = new Map<string, MemberRec>();
  private teams = new Map<string, TeamRec>();
  private invites = new Map<string, InviteRec>();
  private sync = new Map<string, SyncRec>();
  private workspaces = new Map<string, WorkspaceRec>();
  private launchpad = new Map<string, LaunchpadRec>();
  private repoIds = new Map<string, RepoIdentityRec>();
  private footprints = new Map<string, FootprintRec>();
  private patches = new Map<string, PatchRec>();
  private suggestions = new Map<string, SuggestionRec>();
  readonly auditLog: AuditRec[] = [];

  async close(): Promise<void> {}

  /** Test helper: raw view of what the store holds for a sync category. */
  rawSync(userId: string, category: string): SyncRec | undefined {
    return clone(this.sync.get(`${userId}/${category}`));
  }

  // ---- users -----------------------------------------------------------------------------------

  async createUser(user: UserRec): Promise<void> {
    if ([...this.users.values()].some((u) => u.email === user.email)) throw new Error('duplicate email');
    this.users.set(user.id, clone(user));
  }
  async getUser(id: string): Promise<UserRec | undefined> {
    return clone(this.users.get(id));
  }
  async getUsers(ids: string[]): Promise<UserRec[]> {
    return ids
      .map((id) => this.users.get(id))
      .filter((u): u is UserRec => !!u)
      .map(clone);
  }
  async getUserByEmail(email: string): Promise<UserRec | undefined> {
    return clone([...this.users.values()].find((u) => u.email === email));
  }
  async updateUserProfile(id: string, patch: { name?: string; avatarUrl?: string }): Promise<void> {
    const u = this.users.get(id);
    if (!u) return;
    if (patch.name !== undefined) u.name = patch.name;
    if (patch.avatarUrl !== undefined) u.avatarUrl = patch.avatarUrl;
  }
  async markUserDeleted(id: string, at: Date): Promise<void> {
    const u = this.users.get(id);
    if (u && !u.deletedAt) u.deletedAt = new Date(at);
  }
  async listUsersDeletedBefore(cutoff: Date): Promise<UserRec[]> {
    return [...this.users.values()].filter((u) => u.deletedAt && u.deletedAt < cutoff).map(clone);
  }
  async purgeUser(id: string): Promise<void> {
    this.users.delete(id);
    for (const [k, v] of this.identities) if (v.userId === id) this.identities.delete(k);
    for (const [k, v] of this.authCodes) if (v.userId === id) this.authCodes.delete(k);
    for (const [k, v] of this.refresh) if (v.userId === id) this.refresh.delete(k);
    for (const [k, v] of this.members) if (v.userId === id) this.members.delete(k);
    for (const t of this.teams.values()) t.memberIds = t.memberIds.filter((m) => m !== id);
    for (const [k, v] of this.sync) if (v.userId === id) this.sync.delete(k);
    for (const [k, v] of this.workspaces) if (v.ownerUserId === id) this.workspaces.delete(k);
    for (const ws of this.workspaces.values()) {
      ws.shares = ws.shares.filter((s) => !(s.principalType === 'user' && s.principalId === id));
    }
    this.launchpad.delete(id);
    for (const [k, v] of this.footprints) if (v.userId === id) this.footprints.delete(k);
    for (const [k, v] of this.patches) if (v.authorId === id) this.patches.delete(k);
    for (const p of this.patches.values()) p.collaborators = p.collaborators.filter((c) => c !== id);
    for (const [k, v] of this.suggestions) {
      if (v.authorId === id || !this.patches.has(v.patchId)) this.suggestions.delete(k);
      else if (v.statusBy === id) delete v.statusBy;
    }
  }
  async findIdentity(provider: string, host: string, subject: string): Promise<IdentityRec | undefined> {
    return clone(this.identities.get(`${provider}\u0000${host}\u0000${subject}`));
  }
  async linkIdentity(identity: IdentityRec): Promise<void> {
    const key = `${identity.provider}\u0000${identity.host}\u0000${identity.subject}`;
    if (!this.identities.has(key)) this.identities.set(key, clone(identity));
  }

  // ---- auth ------------------------------------------------------------------------------------

  async saveAuthCode(code: AuthCodeRec): Promise<void> {
    this.authCodes.set(hex(code.hash), clone(code));
  }
  async consumeAuthCode(hash: Buffer, now: Date): Promise<AuthCodeRec | undefined> {
    const rec = this.authCodes.get(hex(hash));
    if (!rec) return undefined;
    this.authCodes.delete(hex(hash));
    return rec.expiresAt > now ? rec : undefined;
  }
  async consumeNonce(nonce: string, expiresAt: Date): Promise<boolean> {
    if (this.nonces.has(nonce)) return false;
    this.nonces.set(nonce, new Date(expiresAt));
    return true;
  }
  async insertRefreshToken(token: RefreshTokenRec): Promise<void> {
    this.refresh.set(token.id, clone(token));
  }
  async findRefreshToken(hash: Buffer): Promise<RefreshTokenRec | undefined> {
    return clone([...this.refresh.values()].find((t) => t.hash.equals(hash)));
  }
  async markRefreshTokenUsed(id: string, at: Date): Promise<boolean> {
    const t = this.refresh.get(id);
    if (!t || t.usedAt || t.revokedAt) return false;
    t.usedAt = new Date(at);
    return true;
  }
  async revokeRefreshFamily(familyId: string, at: Date): Promise<void> {
    for (const t of this.refresh.values())
      if (t.familyId === familyId && !t.revokedAt) t.revokedAt = new Date(at);
  }
  async revokeUserRefreshTokens(userId: string, at: Date): Promise<void> {
    for (const t of this.refresh.values())
      if (t.userId === userId && !t.revokedAt) t.revokedAt = new Date(at);
  }
  async cleanupAuth(now: Date): Promise<number> {
    let n = 0;
    n += sweep(this.authCodes, (v) => v.expiresAt <= now);
    n += sweep(this.nonces, (v) => v <= now);
    n += sweep(this.refresh, (v) => v.expiresAt <= now);
    const stale = new Date(now.getTime() - 30 * 86_400_000);
    n += sweep(this.invites, (v) => v.expiresAt <= stale);
    return n;
  }

  // ---- orgs ------------------------------------------------------------------------------------

  async createOrg(org: OrgRec, owner: MemberRec): Promise<void> {
    if ([...this.orgs.values()].some((o) => o.slug === org.slug)) throw new Error('duplicate slug');
    this.orgs.set(org.id, clone(org));
    this.members.set(`${owner.orgId}/${owner.userId}`, clone(owner));
  }
  async getOrg(id: string): Promise<OrgRec | undefined> {
    return clone(this.orgs.get(id));
  }
  async getOrgBySlug(slug: string): Promise<OrgRec | undefined> {
    return clone([...this.orgs.values()].find((o) => o.slug === slug));
  }
  async updateOrg(id: string, patch: { name?: string; policies?: OrgPolicies }): Promise<void> {
    const o = this.orgs.get(id);
    if (!o) return;
    if (patch.name !== undefined) o.name = patch.name;
    if (patch.policies !== undefined) o.policies = clone(patch.policies);
  }
  async deleteOrg(id: string): Promise<void> {
    this.orgs.delete(id);
    for (const [k, v] of this.members) if (v.orgId === id) this.members.delete(k);
    for (const [k, v] of this.teams) if (v.orgId === id) this.teams.delete(k);
    for (const [k, v] of this.invites) if (v.orgId === id) this.invites.delete(k);
    for (const [k, v] of this.workspaces) if (v.orgId === id) this.workspaces.delete(k);
    for (const [k, v] of this.repoIds) if (v.orgId === id) this.repoIds.delete(k);
    for (const [k, v] of this.footprints) if (v.orgId === id) this.footprints.delete(k);
    for (const p of this.patches.values()) if (p.orgId === id) delete p.orgId;
    for (const ws of this.workspaces.values()) {
      ws.shares = ws.shares.filter((s) => !(s.principalType === 'org' && s.principalId === id));
    }
  }
  async listOrgsForUser(userId: string): Promise<Array<{ org: OrgRec; role: OrgRole }>> {
    const out: Array<{ org: OrgRec; role: OrgRole }> = [];
    for (const m of this.members.values()) {
      const org = this.orgs.get(m.orgId);
      if (m.userId === userId && org) out.push({ org: clone(org), role: m.role });
    }
    return out.sort((a, b) => a.org.createdAt.getTime() - b.org.createdAt.getTime());
  }
  async getMember(orgId: string, userId: string): Promise<MemberRec | undefined> {
    return clone(this.members.get(`${orgId}/${userId}`));
  }
  async listMembers(orgId: string): Promise<MemberRec[]> {
    return [...this.members.values()]
      .filter((m) => m.orgId === orgId)
      .sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime())
      .map(clone);
  }
  async upsertMember(member: MemberRec): Promise<void> {
    const key = `${member.orgId}/${member.userId}`;
    const existing = this.members.get(key);
    this.members.set(key, existing ? { ...existing, role: member.role } : clone(member));
  }
  async removeMember(orgId: string, userId: string): Promise<void> {
    this.members.delete(`${orgId}/${userId}`);
    for (const t of this.teams.values()) {
      if (t.orgId === orgId) t.memberIds = t.memberIds.filter((m) => m !== userId);
    }
    for (const [k, v] of this.footprints)
      if (v.orgId === orgId && v.userId === userId) this.footprints.delete(k);
  }

  // ---- teams -----------------------------------------------------------------------------------

  async listTeams(orgId: string): Promise<TeamRec[]> {
    return [...this.teams.values()]
      .filter((t) => t.orgId === orgId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map(clone);
  }
  async getTeam(id: string): Promise<TeamRec | undefined> {
    return clone(this.teams.get(id));
  }
  async createTeam(team: TeamRec): Promise<void> {
    this.teams.set(team.id, clone(team));
  }
  async renameTeam(id: string, name: string): Promise<void> {
    const t = this.teams.get(id);
    if (t) t.name = name;
  }
  async deleteTeam(id: string): Promise<void> {
    this.teams.delete(id);
    for (const ws of this.workspaces.values()) {
      ws.shares = ws.shares.filter((s) => !(s.principalType === 'team' && s.principalId === id));
    }
  }
  async setTeamMembers(id: string, userIds: string[]): Promise<void> {
    const t = this.teams.get(id);
    if (t) t.memberIds = [...new Set(userIds)];
  }
  async listTeamIdsForUser(userId: string): Promise<string[]> {
    return [...this.teams.values()].filter((t) => t.memberIds.includes(userId)).map((t) => t.id);
  }

  // ---- invites ---------------------------------------------------------------------------------

  async createInvite(invite: InviteRec): Promise<void> {
    this.invites.set(invite.id, clone(invite));
  }
  async listPendingInvites(orgId: string, now: Date): Promise<InviteRec[]> {
    return [...this.invites.values()]
      .filter((i) => i.orgId === orgId && !i.acceptedAt && i.expiresAt > now)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map(clone);
  }
  async getInvite(id: string): Promise<InviteRec | undefined> {
    return clone(this.invites.get(id));
  }
  async getInviteByTokenHash(hash: Buffer): Promise<InviteRec | undefined> {
    return clone([...this.invites.values()].find((i) => i.tokenHash.equals(hash)));
  }
  async deleteInvite(id: string): Promise<void> {
    this.invites.delete(id);
  }
  async markInviteAccepted(id: string, at: Date): Promise<boolean> {
    const i = this.invites.get(id);
    if (!i || i.acceptedAt) return false;
    i.acceptedAt = new Date(at);
    return true;
  }

  // ---- sync ------------------------------------------------------------------------------------

  async listSync(userId: string): Promise<SyncRec[]> {
    return [...this.sync.values()]
      .filter((s) => s.userId === userId)
      .sort((a, b) => a.category.localeCompare(b.category))
      .map(clone);
  }
  async getSync(userId: string, category: string): Promise<SyncRec | undefined> {
    return clone(this.sync.get(`${userId}/${category}`));
  }
  async putSync(
    rec: Omit<SyncRec, 'version'>,
    expected: number | undefined,
  ): Promise<VersionedWrite<number>> {
    const key = `${rec.userId}/${rec.category}`;
    const current = this.sync.get(key);
    const currentVersion = current?.version ?? 0;
    if (expected !== undefined && expected !== currentVersion) return { ok: false, currentVersion };
    const version = currentVersion + 1;
    this.sync.set(key, clone({ ...rec, version }));
    return { ok: true, value: version };
  }
  async deleteAllSync(userId: string): Promise<void> {
    for (const [k, v] of this.sync) if (v.userId === userId) this.sync.delete(k);
  }

  // ---- workspaces & launchpad ------------------------------------------------------------------

  async createWorkspace(ws: WorkspaceRec): Promise<void> {
    this.workspaces.set(ws.id, clone(ws));
  }
  async getWorkspace(id: string): Promise<WorkspaceRec | undefined> {
    return clone(this.workspaces.get(id));
  }
  async listWorkspacesVisibleTo(
    userId: string,
    orgIds: string[],
    teamIds: string[],
  ): Promise<WorkspaceRec[]> {
    const visible = (s: WorkspaceShare): boolean =>
      (s.principalType === 'user' && s.principalId === userId) ||
      (s.principalType === 'org' && orgIds.includes(s.principalId)) ||
      (s.principalType === 'team' && teamIds.includes(s.principalId));
    return [...this.workspaces.values()]
      .filter((w) => w.ownerUserId === userId || w.shares.some(visible))
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .map(clone);
  }
  async listWorkspacesOwnedBy(userId: string): Promise<WorkspaceRec[]> {
    return [...this.workspaces.values()].filter((w) => w.ownerUserId === userId).map(clone);
  }
  async updateWorkspace(
    id: string,
    expected: number | undefined,
    patch: { doc?: Record<string, unknown>; shares?: WorkspaceShare[] },
    at: Date,
  ): Promise<VersionedWrite<WorkspaceRec>> {
    const ws = this.workspaces.get(id);
    if (!ws) return { ok: false, currentVersion: 0 };
    if (expected !== undefined && expected !== ws.version) return { ok: false, currentVersion: ws.version };
    if (patch.doc) ws.doc = clone(patch.doc);
    if (patch.shares) ws.shares = clone(patch.shares);
    ws.version += 1;
    ws.updatedAt = new Date(at);
    return { ok: true, value: clone(ws) };
  }
  async deleteWorkspace(id: string): Promise<void> {
    this.workspaces.delete(id);
  }
  async getLaunchpad(userId: string): Promise<LaunchpadRec | undefined> {
    return clone(this.launchpad.get(userId));
  }
  async putLaunchpad(
    userId: string,
    expected: number | undefined,
    doc: Record<string, unknown>,
    at: Date,
  ): Promise<VersionedWrite<number>> {
    const current = this.launchpad.get(userId);
    const currentVersion = current?.version ?? 0;
    if (expected !== undefined && expected !== currentVersion) return { ok: false, currentVersion };
    const version = currentVersion + 1;
    this.launchpad.set(userId, { userId, version, doc: clone(doc), updatedAt: new Date(at) });
    return { ok: true, value: version };
  }

  // ---- repo identities & footprints ------------------------------------------------------------

  async upsertRepoIdentity(rec: RepoIdentityRec): Promise<RepoIdentityRec> {
    const existing = [...this.repoIds.values()].find((r) => r.orgId === rec.orgId && r.key === rec.key);
    if (existing) {
      if (!existing.repo.initialCommitSha && rec.repo.initialCommitSha) {
        existing.repo.initialCommitSha = rec.repo.initialCommitSha;
      }
      return clone(existing);
    }
    this.repoIds.set(rec.id, clone(rec));
    return clone(rec);
  }
  async findRepoIdentity(orgId: string, key: string): Promise<RepoIdentityRec | undefined> {
    return clone([...this.repoIds.values()].find((r) => r.orgId === orgId && r.key === key));
  }
  async getRepoIdentities(ids: string[]): Promise<RepoIdentityRec[]> {
    return ids
      .map((id) => this.repoIds.get(id))
      .filter((r): r is RepoIdentityRec => !!r)
      .map(clone);
  }
  async upsertFootprint(fp: FootprintRec): Promise<void> {
    this.footprints.set(fpKey(fp.orgId, fp.userId, fp.repoIdentityId, fp.branchHash), clone(fp));
  }
  async deleteFootprint(
    orgId: string,
    userId: string,
    repoIdentityId: string,
    branchHash: string,
  ): Promise<void> {
    this.footprints.delete(fpKey(orgId, userId, repoIdentityId, branchHash));
  }
  async listFootprints(
    orgId: string,
    q: { repoIdentityId?: string; since?: Date; excludeUserId?: string; notBefore: Date },
  ): Promise<FootprintRec[]> {
    return [...this.footprints.values()]
      .filter(
        (f) =>
          f.orgId === orgId &&
          (!q.repoIdentityId || f.repoIdentityId === q.repoIdentityId) &&
          (!q.since || f.updatedAt >= q.since) &&
          (!q.excludeUserId || f.userId !== q.excludeUserId) &&
          f.updatedAt >= q.notBefore,
      )
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .map(clone);
  }
  async deleteFootprintsForUser(userId: string): Promise<void> {
    for (const [k, v] of this.footprints) if (v.userId === userId) this.footprints.delete(k);
  }
  async deleteFootprintsBefore(cutoff: Date): Promise<number> {
    let n = 0;
    n += sweep(this.footprints, (v) => v.updatedAt < cutoff);
    return n;
  }

  // ---- patches ---------------------------------------------------------------------------------

  async createPatch(patch: PatchRec): Promise<void> {
    this.patches.set(patch.id, clone(patch));
  }
  async getPatch(id: string): Promise<PatchRec | undefined> {
    return clone(this.patches.get(id));
  }
  async updatePatch(id: string, patch: Partial<PatchRec>): Promise<void> {
    const p = this.patches.get(id);
    if (!p) return;
    for (const [k, v] of Object.entries(patch)) {
      (p as unknown as Record<string, unknown>)[k] = clone(v);
    }
  }
  async listPatches(q: PatchQuery): Promise<PatchRec[]> {
    return [...this.patches.values()]
      .filter((p) => {
        if (p.status !== 'complete' || p.deletedAt || (p.expiresAt && p.expiresAt <= q.now)) return false;
        if (q.repoKey && p.repoKey !== q.repoKey) return false;
        if (q.scope === 'mine') return p.authorId === q.userId;
        if (p.authorId === q.userId) return false;
        return (
          (p.visibility === 'org' && !!p.orgId && q.orgIds.includes(p.orgId)) ||
          (p.visibility === 'collaborators' && p.collaborators.includes(q.userId))
        );
      })
      .sort(
        (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
      )
      .filter((p) => {
        if (!q.cursor) return true;
        const t = p.createdAt.getTime();
        const c = q.cursor.createdAt.getTime();
        return t < c || (t === c && p.id < q.cursor.id);
      })
      .slice(0, q.limit)
      .map(clone);
  }
  async listPatchesByAuthor(userId: string): Promise<PatchRec[]> {
    return [...this.patches.values()].filter((p) => p.authorId === userId).map(clone);
  }
  async markPatchesDeleted(by: { authorId?: string; orgId?: string }, at: Date): Promise<void> {
    for (const p of this.patches.values()) {
      if (p.deletedAt) continue;
      if ((by.authorId && p.authorId === by.authorId) || (by.orgId && p.orgId === by.orgId))
        p.deletedAt = new Date(at);
    }
  }
  async listPatchesToPurge(now: Date, pendingCutoff: Date, limit: number): Promise<PatchRec[]> {
    return [...this.patches.values()]
      .filter(
        (p) =>
          !!p.deletedAt ||
          (p.expiresAt !== undefined && p.expiresAt <= now) ||
          (p.status === 'pending' && p.createdAt < pendingCutoff),
      )
      .slice(0, limit)
      .map(clone);
  }
  async hardDeletePatch(id: string): Promise<void> {
    this.patches.delete(id);
    for (const [k, v] of this.suggestions) if (v.patchId === id) this.suggestions.delete(k);
  }

  // ---- suggestions -----------------------------------------------------------------------------

  async createSuggestion(rec: SuggestionRec): Promise<void> {
    if (!this.patches.has(rec.patchId)) throw new Error('unknown patch');
    this.suggestions.set(rec.id, clone(rec));
  }
  async getSuggestion(id: string): Promise<SuggestionRec | undefined> {
    return clone(this.suggestions.get(id));
  }
  async listSuggestions(q: SuggestionQuery): Promise<SuggestionRec[]> {
    const lc = (v: string): string => v.toLowerCase();
    return [...this.suggestions.values()]
      .filter(
        (s) =>
          s.provider === q.provider &&
          (!q.host || lc(s.host) === lc(q.host)) &&
          lc(s.owner) === lc(q.owner) &&
          lc(s.repo) === lc(q.repo) &&
          (q.prNumber === undefined || s.prNumber === q.prNumber),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1))
      .slice(0, q.limit)
      .map(clone);
  }
  async updateSuggestion(
    id: string,
    patch: Partial<Pick<SuggestionRec, 'status' | 'statusBy' | 'commentId' | 'updatedAt'>>,
  ): Promise<void> {
    const s = this.suggestions.get(id);
    if (!s) return;
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete (s as unknown as Record<string, unknown>)[k];
      else (s as unknown as Record<string, unknown>)[k] = clone(v);
    }
  }

  async audit(entry: AuditRec): Promise<void> {
    this.auditLog.push(clone(entry));
  }
}
