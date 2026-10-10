/**
 * Postgres 16 {@link Store}. Schema lives in `migrations/*.sql` (applied at startup). Optimistic
 * concurrency and single-use semantics are expressed as conditional `update … returning` /
 * `insert … on conflict do nothing` statements so they hold across multiple server instances.
 */
import type {
  FootprintFile,
  OrgPolicies,
  OrgRole,
  PatchFile,
  RepoIdentity,
  WorkspaceShare,
} from '@githappens/cloud-api/types';
import pg from 'pg';
import { migrate } from './migrate.ts';
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

// int8 → number (versions and sizes stay far below 2^53).
pg.types.setTypeParser(20, (v) => Number(v));

type Row = Record<string, unknown>;
const opt = <T>(v: unknown): T | undefined => (v === null || v === undefined ? undefined : (v as T));
const date = (v: unknown): Date => v as Date;
const optDate = (v: unknown): Date | undefined => (v === null || v === undefined ? undefined : (v as Date));

function userFrom(r: Row): UserRec {
  return {
    id: r.id as string,
    email: r.email as string,
    name: r.name as string,
    avatarUrl: opt(r.avatar_url),
    createdAt: date(r.created_at),
    deletedAt: optDate(r.deleted_at),
  };
}

function refreshFrom(r: Row): RefreshTokenRec {
  return {
    id: r.id as string,
    userId: r.user_id as string,
    familyId: r.family_id as string,
    hash: r.hash as Buffer,
    createdAt: date(r.created_at),
    expiresAt: date(r.expires_at),
    usedAt: optDate(r.used_at),
    revokedAt: optDate(r.revoked_at),
  };
}

function orgFrom(r: Row): OrgRec {
  return {
    id: r.id as string,
    name: r.name as string,
    slug: r.slug as string,
    policies: r.policies as OrgPolicies,
    footprintSalt: r.footprint_salt as string,
    createdBy: r.created_by as string,
    createdAt: date(r.created_at),
  };
}

function memberFrom(r: Row): MemberRec {
  return {
    orgId: r.org_id as string,
    userId: r.user_id as string,
    role: r.role as OrgRole,
    joinedAt: date(r.joined_at),
  };
}

function inviteFrom(r: Row): InviteRec {
  return {
    id: r.id as string,
    orgId: r.org_id as string,
    email: r.email as string,
    role: r.role as OrgRole,
    tokenHash: r.token_hash as Buffer,
    createdBy: r.created_by as string,
    createdAt: date(r.created_at),
    expiresAt: date(r.expires_at),
    acceptedAt: optDate(r.accepted_at),
  };
}

function syncFrom(r: Row): SyncRec {
  return {
    userId: r.user_id as string,
    category: r.category as string,
    version: r.version as number,
    ciphertext: r.ciphertext as Buffer,
    nonce: r.nonce as Buffer,
    deviceId: opt(r.device_id),
    updatedAt: date(r.updated_at),
  };
}

function repoIdFrom(r: Row): RepoIdentityRec {
  const repo: RepoIdentity = {
    provider: r.provider as string,
    host: r.host as string,
    owner: r.owner as string,
    name: r.name as string,
  };
  if (r.initial_commit_sha) repo.initialCommitSha = r.initial_commit_sha as string;
  return {
    id: r.id as string,
    orgId: r.org_id as string,
    key: r.key as string,
    repo,
    createdAt: date(r.created_at),
  };
}

function footprintFrom(r: Row): FootprintRec {
  return {
    orgId: r.org_id as string,
    userId: r.user_id as string,
    repoIdentityId: r.repo_identity_id as string,
    branchHash: r.branch_hash as string,
    branchLabel: opt(r.branch_label),
    baseRef: r.base_ref as string,
    headSha: r.head_sha as string,
    files: r.files as FootprintFile[],
    updatedAt: date(r.updated_at),
  };
}

const PATCH_COLS = `p.*, coalesce((select array_agg(c.user_id::text order by c.user_id) from patch_collaborators c where c.patch_id = p.id), '{}') as collaborators`;

function patchFrom(r: Row): PatchRec {
  return {
    id: r.id as string,
    authorId: r.author_id as string,
    orgId: opt(r.org_id),
    repo: opt<RepoIdentity>(r.repo),
    repoKey: opt(r.repo_key),
    title: r.title as string,
    description: opt(r.description),
    kind: r.kind as PatchRec['kind'],
    baseSha: r.base_sha as string,
    baseBranch: opt(r.base_branch),
    files: opt<PatchFile[]>(r.files),
    e2e: r.e2e as boolean,
    size: r.size as number,
    sha256: r.sha256 as string,
    visibility: r.visibility as PatchRec['visibility'],
    collaborators: (r.collaborators as string[] | null) ?? [],
    status: r.status as PatchRec['status'],
    createdAt: date(r.created_at),
    completedAt: optDate(r.completed_at),
    expiresAt: optDate(r.expires_at),
    deletedAt: optDate(r.deleted_at),
  };
}

function suggestionFrom(r: Row): SuggestionRec {
  return {
    id: r.id as string,
    patchId: r.patch_id as string,
    authorId: r.author_id as string,
    provider: r.provider as string,
    host: r.host as string,
    owner: r.owner as string,
    repo: r.repo as string,
    prNumber: r.pr_number as number,
    prHeadSha: r.pr_head_sha as string,
    title: r.title as string,
    status: r.status as SuggestionRec['status'],
    statusBy: opt(r.status_by),
    commentId: opt(r.comment_id),
    coAuthor: opt(r.co_author),
    createdAt: date(r.created_at),
    updatedAt: date(r.updated_at),
  };
}

const json = (v: unknown): string | null => (v === undefined ? null : JSON.stringify(v));

export interface PgStoreOptions {
  connectionString: string;
  /** Use (and create) a dedicated schema — test isolation. Must be a simple identifier. */
  schema?: string;
  max?: number;
}

export class PgStore implements Store {
  readonly kind = 'postgres' as const;
  private readonly pool: pg.Pool;
  private constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  /** Connect, create the schema if requested, and apply pending migrations. */
  static async open(opts: PgStoreOptions): Promise<PgStore> {
    if (opts.schema !== undefined && !/^[a-z_][a-z0-9_]{0,62}$/.test(opts.schema)) {
      throw new Error('invalid schema name');
    }
    const pool = new pg.Pool({
      connectionString: opts.connectionString,
      max: opts.max ?? 10,
      options: opts.schema ? `-c search_path=${opts.schema}` : undefined,
    });
    pool.on('error', () => undefined); // idle client errors surface on the next query instead
    try {
      if (opts.schema) await pool.query(`create schema if not exists ${opts.schema}`);
      await migrate(pool);
    } catch (err) {
      await pool.end();
      throw err;
    }
    return new PgStore(pool);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /** Test helper: drop a schema created with `open({ schema })`. */
  async dropSchema(schema: string): Promise<void> {
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error('invalid schema name');
    await this.pool.query(`drop schema if exists ${schema} cascade`);
  }

  /** Test helper: raw row for a sync category. */
  async rawSync(userId: string, category: string): Promise<Row | undefined> {
    return (
      await this.pool.query('select * from sync_items where user_id = $1 and category = $2', [
        userId,
        category,
      ])
    ).rows[0];
  }

  private async rows(sql: string, params: unknown[] = []): Promise<Row[]> {
    return (await this.pool.query(sql, params)).rows as Row[];
  }

  private async tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('begin');
      const out = await fn(c);
      await c.query('commit');
      return out;
    } catch (err) {
      await c.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }

  // ---- users -----------------------------------------------------------------------------------

  async createUser(u: UserRec): Promise<void> {
    await this.pool.query(
      'insert into users (id, email, name, avatar_url, created_at, deleted_at) values ($1,$2,$3,$4,$5,$6)',
      [u.id, u.email, u.name, u.avatarUrl ?? null, u.createdAt, u.deletedAt ?? null],
    );
  }
  async getUser(id: string): Promise<UserRec | undefined> {
    const r = (await this.rows('select * from users where id = $1', [id]))[0];
    return r ? userFrom(r) : undefined;
  }
  async getUsers(ids: string[]): Promise<UserRec[]> {
    if (ids.length === 0) return [];
    return (await this.rows('select * from users where id = any($1::uuid[])', [ids])).map(userFrom);
  }
  async getUserByEmail(email: string): Promise<UserRec | undefined> {
    const r = (await this.rows('select * from users where email = $1', [email]))[0];
    return r ? userFrom(r) : undefined;
  }
  async updateUserProfile(id: string, patch: { name?: string; avatarUrl?: string }): Promise<void> {
    await this.pool.query(
      'update users set name = coalesce($2, name), avatar_url = coalesce($3, avatar_url) where id = $1',
      [id, patch.name ?? null, patch.avatarUrl ?? null],
    );
  }
  async markUserDeleted(id: string, at: Date): Promise<void> {
    await this.pool.query('update users set deleted_at = $2 where id = $1 and deleted_at is null', [id, at]);
  }
  async listUsersDeletedBefore(cutoff: Date): Promise<UserRec[]> {
    return (await this.rows('select * from users where deleted_at < $1', [cutoff])).map(userFrom);
  }
  async purgeUser(id: string): Promise<void> {
    await this.tx(async (c) => {
      await c.query("delete from workspace_shares where principal_type = 'user' and principal_id = $1", [id]);
      // Everything else cascades from users (identities, tokens, sync, workspaces, memberships,
      // team memberships, launchpad, patches + collaborators, footprints).
      await c.query('delete from users where id = $1', [id]);
    });
  }
  async findIdentity(provider: string, host: string, subject: string): Promise<IdentityRec | undefined> {
    const r = (
      await this.rows('select * from identities where provider = $1 and host = $2 and subject = $3', [
        provider,
        host,
        subject,
      ])
    )[0];
    return r
      ? {
          provider: r.provider as string,
          host: r.host as string,
          subject: r.subject as string,
          userId: r.user_id as string,
        }
      : undefined;
  }
  async linkIdentity(i: IdentityRec): Promise<void> {
    await this.pool.query(
      'insert into identities (provider, host, subject, user_id) values ($1,$2,$3,$4) on conflict do nothing',
      [i.provider, i.host, i.subject, i.userId],
    );
  }

  // ---- auth ------------------------------------------------------------------------------------

  async saveAuthCode(code: AuthCodeRec): Promise<void> {
    await this.pool.query(
      'insert into auth_codes (hash, user_id, code_challenge, redirect_uri, expires_at) values ($1,$2,$3,$4,$5)',
      [code.hash, code.userId, code.codeChallenge, code.redirectUri, code.expiresAt],
    );
  }
  async consumeAuthCode(hash: Buffer, now: Date): Promise<AuthCodeRec | undefined> {
    const r = (await this.rows('delete from auth_codes where hash = $1 returning *', [hash]))[0];
    if (!r || date(r.expires_at) <= now) return undefined;
    return {
      hash: r.hash as Buffer,
      userId: r.user_id as string,
      codeChallenge: r.code_challenge as string,
      redirectUri: r.redirect_uri as string,
      expiresAt: date(r.expires_at),
    };
  }
  async consumeNonce(nonce: string, expiresAt: Date): Promise<boolean> {
    const r = await this.pool.query(
      'insert into used_nonces (nonce, expires_at) values ($1, $2) on conflict do nothing',
      [nonce, expiresAt],
    );
    return r.rowCount === 1;
  }
  async insertRefreshToken(t: RefreshTokenRec): Promise<void> {
    await this.pool.query(
      `insert into refresh_tokens (id, user_id, family_id, hash, created_at, expires_at, used_at, revoked_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [t.id, t.userId, t.familyId, t.hash, t.createdAt, t.expiresAt, t.usedAt ?? null, t.revokedAt ?? null],
    );
  }
  async findRefreshToken(hash: Buffer): Promise<RefreshTokenRec | undefined> {
    const r = (await this.rows('select * from refresh_tokens where hash = $1', [hash]))[0];
    return r ? refreshFrom(r) : undefined;
  }
  async markRefreshTokenUsed(id: string, at: Date): Promise<boolean> {
    const r = await this.pool.query(
      'update refresh_tokens set used_at = $2 where id = $1 and used_at is null and revoked_at is null',
      [id, at],
    );
    return r.rowCount === 1;
  }
  async revokeRefreshFamily(familyId: string, at: Date): Promise<void> {
    await this.pool.query(
      'update refresh_tokens set revoked_at = $2 where family_id = $1 and revoked_at is null',
      [familyId, at],
    );
  }
  async revokeUserRefreshTokens(userId: string, at: Date): Promise<void> {
    await this.pool.query(
      'update refresh_tokens set revoked_at = $2 where user_id = $1 and revoked_at is null',
      [userId, at],
    );
  }
  async cleanupAuth(now: Date): Promise<number> {
    const stale = new Date(now.getTime() - 30 * 86_400_000);
    let n = 0;
    n += (await this.pool.query('delete from auth_codes where expires_at <= $1', [now])).rowCount ?? 0;
    n += (await this.pool.query('delete from used_nonces where expires_at <= $1', [now])).rowCount ?? 0;
    n += (await this.pool.query('delete from refresh_tokens where expires_at <= $1', [now])).rowCount ?? 0;
    n += (await this.pool.query('delete from invites where expires_at <= $1', [stale])).rowCount ?? 0;
    return n;
  }

  // ---- orgs ------------------------------------------------------------------------------------

  async createOrg(org: OrgRec, owner: MemberRec): Promise<void> {
    await this.tx(async (c) => {
      await c.query(
        `insert into orgs (id, name, slug, policies, footprint_salt, created_by, created_at)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [org.id, org.name, org.slug, json(org.policies), org.footprintSalt, org.createdBy, org.createdAt],
      );
      await c.query('insert into org_members (org_id, user_id, role, joined_at) values ($1,$2,$3,$4)', [
        owner.orgId,
        owner.userId,
        owner.role,
        owner.joinedAt,
      ]);
    });
  }
  async getOrg(id: string): Promise<OrgRec | undefined> {
    const r = (await this.rows('select * from orgs where id = $1', [id]))[0];
    return r ? orgFrom(r) : undefined;
  }
  async getOrgBySlug(slug: string): Promise<OrgRec | undefined> {
    const r = (await this.rows('select * from orgs where slug = $1', [slug]))[0];
    return r ? orgFrom(r) : undefined;
  }
  async updateOrg(id: string, patch: { name?: string; policies?: OrgPolicies }): Promise<void> {
    await this.pool.query(
      'update orgs set name = coalesce($2, name), policies = coalesce($3::jsonb, policies) where id = $1',
      [id, patch.name ?? null, patch.policies ? json(patch.policies) : null],
    );
  }
  async deleteOrg(id: string): Promise<void> {
    await this.tx(async (c) => {
      await c.query("delete from workspace_shares where principal_type = 'org' and principal_id = $1", [id]);
      await c.query('delete from orgs where id = $1', [id]);
    });
  }
  async listOrgsForUser(userId: string): Promise<Array<{ org: OrgRec; role: OrgRole }>> {
    const rows = await this.rows(
      `select o.*, m.role as member_role from org_members m join orgs o on o.id = m.org_id
       where m.user_id = $1 order by o.created_at`,
      [userId],
    );
    return rows.map((r) => ({ org: orgFrom(r), role: r.member_role as OrgRole }));
  }
  async getMember(orgId: string, userId: string): Promise<MemberRec | undefined> {
    const r = (
      await this.rows('select * from org_members where org_id = $1 and user_id = $2', [orgId, userId])
    )[0];
    return r ? memberFrom(r) : undefined;
  }
  async listMembers(orgId: string): Promise<MemberRec[]> {
    return (
      await this.rows('select * from org_members where org_id = $1 order by joined_at, user_id', [orgId])
    ).map(memberFrom);
  }
  async upsertMember(m: MemberRec): Promise<void> {
    await this.pool.query(
      `insert into org_members (org_id, user_id, role, joined_at) values ($1,$2,$3,$4)
       on conflict (org_id, user_id) do update set role = excluded.role`,
      [m.orgId, m.userId, m.role, m.joinedAt],
    );
  }
  async removeMember(orgId: string, userId: string): Promise<void> {
    await this.tx(async (c) => {
      await c.query('delete from org_members where org_id = $1 and user_id = $2', [orgId, userId]);
      await c.query(
        'delete from team_members where user_id = $2 and team_id in (select id from teams where org_id = $1)',
        [orgId, userId],
      );
      await c.query('delete from footprints where org_id = $1 and user_id = $2', [orgId, userId]);
    });
  }

  // ---- teams -----------------------------------------------------------------------------------

  private async teamsWhere(where: string, params: unknown[]): Promise<TeamRec[]> {
    const rows = await this.rows(
      `select t.*, coalesce((select array_agg(tm.user_id::text order by tm.user_id) from team_members tm
         where tm.team_id = t.id), '{}') as member_ids
       from teams t where ${where} order by t.created_at, t.id`,
      params,
    );
    return rows.map((r) => ({
      id: r.id as string,
      orgId: r.org_id as string,
      name: r.name as string,
      memberIds: r.member_ids as string[],
      createdAt: date(r.created_at),
    }));
  }
  async listTeams(orgId: string): Promise<TeamRec[]> {
    return this.teamsWhere('t.org_id = $1', [orgId]);
  }
  async getTeam(id: string): Promise<TeamRec | undefined> {
    return (await this.teamsWhere('t.id = $1', [id]))[0];
  }
  async createTeam(t: TeamRec): Promise<void> {
    await this.tx(async (c) => {
      await c.query('insert into teams (id, org_id, name, created_at) values ($1,$2,$3,$4)', [
        t.id,
        t.orgId,
        t.name,
        t.createdAt,
      ]);
      for (const u of new Set(t.memberIds)) {
        await c.query('insert into team_members (team_id, user_id) values ($1,$2)', [t.id, u]);
      }
    });
  }
  async renameTeam(id: string, name: string): Promise<void> {
    await this.pool.query('update teams set name = $2 where id = $1', [id, name]);
  }
  async deleteTeam(id: string): Promise<void> {
    await this.tx(async (c) => {
      await c.query("delete from workspace_shares where principal_type = 'team' and principal_id = $1", [id]);
      await c.query('delete from teams where id = $1', [id]);
    });
  }
  async setTeamMembers(id: string, userIds: string[]): Promise<void> {
    await this.tx(async (c) => {
      await c.query('delete from team_members where team_id = $1', [id]);
      for (const u of new Set(userIds)) {
        await c.query('insert into team_members (team_id, user_id) values ($1,$2)', [id, u]);
      }
    });
  }
  async listTeamIdsForUser(userId: string): Promise<string[]> {
    return (await this.rows('select team_id from team_members where user_id = $1', [userId])).map(
      (r) => r.team_id as string,
    );
  }

  // ---- invites ---------------------------------------------------------------------------------

  async createInvite(i: InviteRec): Promise<void> {
    await this.pool.query(
      `insert into invites (id, org_id, email, role, token_hash, created_by, created_at, expires_at, accepted_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        i.id,
        i.orgId,
        i.email,
        i.role,
        i.tokenHash,
        i.createdBy,
        i.createdAt,
        i.expiresAt,
        i.acceptedAt ?? null,
      ],
    );
  }
  async listPendingInvites(orgId: string, now: Date): Promise<InviteRec[]> {
    return (
      await this.rows(
        'select * from invites where org_id = $1 and accepted_at is null and expires_at > $2 order by created_at',
        [orgId, now],
      )
    ).map(inviteFrom);
  }
  async getInvite(id: string): Promise<InviteRec | undefined> {
    const r = (await this.rows('select * from invites where id = $1', [id]))[0];
    return r ? inviteFrom(r) : undefined;
  }
  async getInviteByTokenHash(hash: Buffer): Promise<InviteRec | undefined> {
    const r = (await this.rows('select * from invites where token_hash = $1', [hash]))[0];
    return r ? inviteFrom(r) : undefined;
  }
  async deleteInvite(id: string): Promise<void> {
    await this.pool.query('delete from invites where id = $1', [id]);
  }
  async markInviteAccepted(id: string, at: Date): Promise<boolean> {
    const r = await this.pool.query(
      'update invites set accepted_at = $2 where id = $1 and accepted_at is null',
      [id, at],
    );
    return r.rowCount === 1;
  }

  // ---- sync ------------------------------------------------------------------------------------

  async listSync(userId: string): Promise<SyncRec[]> {
    return (await this.rows('select * from sync_items where user_id = $1 order by category', [userId])).map(
      syncFrom,
    );
  }
  async getSync(userId: string, category: string): Promise<SyncRec | undefined> {
    const r = (
      await this.rows('select * from sync_items where user_id = $1 and category = $2', [userId, category])
    )[0];
    return r ? syncFrom(r) : undefined;
  }
  async putSync(
    rec: Omit<SyncRec, 'version'>,
    expected: number | undefined,
  ): Promise<VersionedWrite<number>> {
    const vals = [rec.userId, rec.category, rec.ciphertext, rec.nonce, rec.deviceId ?? null, rec.updatedAt];
    let r: Row | undefined;
    if (expected === undefined) {
      r = (
        await this.rows(
          `insert into sync_items (user_id, category, version, ciphertext, nonce, device_id, updated_at)
           values ($1,$2,1,$3,$4,$5,$6)
           on conflict (user_id, category) do update set version = sync_items.version + 1,
             ciphertext = excluded.ciphertext, nonce = excluded.nonce, device_id = excluded.device_id,
             updated_at = excluded.updated_at
           returning version`,
          vals,
        )
      )[0];
    } else if (expected === 0) {
      r = (
        await this.rows(
          `insert into sync_items (user_id, category, version, ciphertext, nonce, device_id, updated_at)
           values ($1,$2,1,$3,$4,$5,$6) on conflict do nothing returning version`,
          vals,
        )
      )[0];
    } else {
      r = (
        await this.rows(
          `update sync_items set version = version + 1, ciphertext = $3, nonce = $4, device_id = $5, updated_at = $6
           where user_id = $1 and category = $2 and version = $7 returning version`,
          [...vals, expected],
        )
      )[0];
    }
    if (r) return { ok: true, value: r.version as number };
    const current = await this.getSync(rec.userId, rec.category);
    return { ok: false, currentVersion: current?.version ?? 0 };
  }
  async deleteAllSync(userId: string): Promise<void> {
    await this.pool.query('delete from sync_items where user_id = $1', [userId]);
  }

  // ---- workspaces & launchpad ------------------------------------------------------------------

  private async workspacesWhere(where: string, params: unknown[]): Promise<WorkspaceRec[]> {
    const rows = await this.rows(
      `select w.*, coalesce((select json_agg(json_build_object('principalType', s.principal_type,
          'principalId', s.principal_id) order by s.principal_type, s.principal_id)
        from workspace_shares s where s.workspace_id = w.id), '[]') as shares
       from workspaces w where ${where} order by w.updated_at desc, w.id`,
      params,
    );
    return rows.map((r) => ({
      id: r.id as string,
      ownerUserId: r.owner_user_id as string,
      orgId: opt(r.org_id),
      version: r.version as number,
      doc: r.doc as Record<string, unknown>,
      shares: r.shares as WorkspaceShare[],
      createdAt: date(r.created_at),
      updatedAt: date(r.updated_at),
    }));
  }
  private async writeShares(c: pg.PoolClient, id: string, shares: WorkspaceShare[]): Promise<void> {
    await c.query('delete from workspace_shares where workspace_id = $1', [id]);
    for (const s of shares) {
      await c.query(
        'insert into workspace_shares (workspace_id, principal_type, principal_id) values ($1,$2,$3) on conflict do nothing',
        [id, s.principalType, s.principalId],
      );
    }
  }
  async createWorkspace(ws: WorkspaceRec): Promise<void> {
    await this.tx(async (c) => {
      await c.query(
        `insert into workspaces (id, owner_user_id, org_id, version, doc, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [ws.id, ws.ownerUserId, ws.orgId ?? null, ws.version, json(ws.doc), ws.createdAt, ws.updatedAt],
      );
      await this.writeShares(c, ws.id, ws.shares);
    });
  }
  async getWorkspace(id: string): Promise<WorkspaceRec | undefined> {
    return (await this.workspacesWhere('w.id = $1', [id]))[0];
  }
  async listWorkspacesVisibleTo(
    userId: string,
    orgIds: string[],
    teamIds: string[],
  ): Promise<WorkspaceRec[]> {
    return this.workspacesWhere(
      `w.owner_user_id = $1 or exists (select 1 from workspace_shares s where s.workspace_id = w.id and (
         (s.principal_type = 'user' and s.principal_id = $1) or
         (s.principal_type = 'org' and s.principal_id = any($2::uuid[])) or
         (s.principal_type = 'team' and s.principal_id = any($3::uuid[]))))`,
      [userId, orgIds, teamIds],
    );
  }
  async listWorkspacesOwnedBy(userId: string): Promise<WorkspaceRec[]> {
    return this.workspacesWhere('w.owner_user_id = $1', [userId]);
  }
  async updateWorkspace(
    id: string,
    expected: number | undefined,
    patch: { doc?: Record<string, unknown>; shares?: WorkspaceShare[] },
    at: Date,
  ): Promise<VersionedWrite<WorkspaceRec>> {
    const ok = await this.tx(async (c) => {
      const r = await c.query(
        `update workspaces set version = version + 1, doc = coalesce($2::jsonb, doc), updated_at = $3
         where id = $1 and ($4::bigint is null or version = $4) returning version`,
        [id, patch.doc ? json(patch.doc) : null, at, expected ?? null],
      );
      if (r.rowCount !== 1) return false;
      if (patch.shares) await this.writeShares(c, id, patch.shares);
      return true;
    });
    const ws = await this.getWorkspace(id);
    if (!ok || !ws) return { ok: false, currentVersion: ws?.version ?? 0 };
    return { ok: true, value: ws };
  }
  async deleteWorkspace(id: string): Promise<void> {
    await this.pool.query('delete from workspaces where id = $1', [id]);
  }
  async getLaunchpad(userId: string): Promise<LaunchpadRec | undefined> {
    const r = (await this.rows('select * from launchpad_state where user_id = $1', [userId]))[0];
    return r
      ? {
          userId: r.user_id as string,
          version: r.version as number,
          doc: r.doc as Record<string, unknown>,
          updatedAt: date(r.updated_at),
        }
      : undefined;
  }
  async putLaunchpad(
    userId: string,
    expected: number | undefined,
    doc: Record<string, unknown>,
    at: Date,
  ): Promise<VersionedWrite<number>> {
    let r: Row | undefined;
    if (expected === undefined) {
      r = (
        await this.rows(
          `insert into launchpad_state (user_id, version, doc, updated_at) values ($1, 1, $2, $3)
           on conflict (user_id) do update set version = launchpad_state.version + 1, doc = excluded.doc,
             updated_at = excluded.updated_at returning version`,
          [userId, json(doc), at],
        )
      )[0];
    } else if (expected === 0) {
      r = (
        await this.rows(
          `insert into launchpad_state (user_id, version, doc, updated_at) values ($1, 1, $2, $3)
           on conflict do nothing returning version`,
          [userId, json(doc), at],
        )
      )[0];
    } else {
      r = (
        await this.rows(
          `update launchpad_state set version = version + 1, doc = $2, updated_at = $3
           where user_id = $1 and version = $4 returning version`,
          [userId, json(doc), at, expected],
        )
      )[0];
    }
    if (r) return { ok: true, value: r.version as number };
    return { ok: false, currentVersion: (await this.getLaunchpad(userId))?.version ?? 0 };
  }

  // ---- repo identities & footprints ------------------------------------------------------------

  async upsertRepoIdentity(rec: RepoIdentityRec): Promise<RepoIdentityRec> {
    const r = (
      await this.rows(
        `insert into repo_identities (id, org_id, key, provider, host, owner, name, initial_commit_sha, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         on conflict (org_id, key) do update
           set initial_commit_sha = coalesce(repo_identities.initial_commit_sha, excluded.initial_commit_sha)
         returning *`,
        [
          rec.id,
          rec.orgId,
          rec.key,
          rec.repo.provider,
          rec.repo.host,
          rec.repo.owner,
          rec.repo.name,
          rec.repo.initialCommitSha ?? null,
          rec.createdAt,
        ],
      )
    )[0]!;
    return repoIdFrom(r);
  }
  async findRepoIdentity(orgId: string, key: string): Promise<RepoIdentityRec | undefined> {
    const r = (
      await this.rows('select * from repo_identities where org_id = $1 and key = $2', [orgId, key])
    )[0];
    return r ? repoIdFrom(r) : undefined;
  }
  async getRepoIdentities(ids: string[]): Promise<RepoIdentityRec[]> {
    if (ids.length === 0) return [];
    return (await this.rows('select * from repo_identities where id = any($1::uuid[])', [ids])).map(
      repoIdFrom,
    );
  }
  async upsertFootprint(f: FootprintRec): Promise<void> {
    await this.pool.query(
      `insert into footprints (org_id, user_id, repo_identity_id, branch_hash, branch_label, base_ref, head_sha, files, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict (org_id, user_id, repo_identity_id, branch_hash) do update set branch_label = excluded.branch_label,
         base_ref = excluded.base_ref, head_sha = excluded.head_sha, files = excluded.files, updated_at = excluded.updated_at`,
      [
        f.orgId,
        f.userId,
        f.repoIdentityId,
        f.branchHash,
        f.branchLabel ?? null,
        f.baseRef,
        f.headSha,
        json(f.files),
        f.updatedAt,
      ],
    );
  }
  async deleteFootprint(
    orgId: string,
    userId: string,
    repoIdentityId: string,
    branchHash: string,
  ): Promise<void> {
    await this.pool.query(
      'delete from footprints where org_id = $1 and user_id = $2 and repo_identity_id = $3 and branch_hash = $4',
      [orgId, userId, repoIdentityId, branchHash],
    );
  }
  async listFootprints(
    orgId: string,
    q: { repoIdentityId?: string; since?: Date; excludeUserId?: string; notBefore: Date },
  ): Promise<FootprintRec[]> {
    return (
      await this.rows(
        `select * from footprints where org_id = $1 and updated_at >= $2
           and ($3::uuid is null or repo_identity_id = $3) and ($4::timestamptz is null or updated_at >= $4)
           and ($5::uuid is null or user_id <> $5)
         order by updated_at desc`,
        [orgId, q.notBefore, q.repoIdentityId ?? null, q.since ?? null, q.excludeUserId ?? null],
      )
    ).map(footprintFrom);
  }
  async deleteFootprintsForUser(userId: string): Promise<void> {
    await this.pool.query('delete from footprints where user_id = $1', [userId]);
  }
  async deleteFootprintsBefore(cutoff: Date): Promise<number> {
    return (await this.pool.query('delete from footprints where updated_at < $1', [cutoff])).rowCount ?? 0;
  }

  // ---- patches ---------------------------------------------------------------------------------

  async createPatch(p: PatchRec): Promise<void> {
    await this.tx(async (c) => {
      await c.query(
        `insert into patches (id, author_id, org_id, repo, repo_key, title, description, kind, base_sha, base_branch,
           files, e2e, size, sha256, visibility, status, created_at, completed_at, expires_at, deleted_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
        [
          p.id,
          p.authorId,
          p.orgId ?? null,
          json(p.repo),
          p.repoKey ?? null,
          p.title,
          p.description ?? null,
          p.kind,
          p.baseSha,
          p.baseBranch ?? null,
          json(p.files),
          p.e2e,
          p.size,
          p.sha256,
          p.visibility,
          p.status,
          p.createdAt,
          p.completedAt ?? null,
          p.expiresAt ?? null,
          p.deletedAt ?? null,
        ],
      );
      for (const u of new Set(p.collaborators)) {
        await c.query('insert into patch_collaborators (patch_id, user_id) values ($1,$2)', [p.id, u]);
      }
    });
  }
  async getPatch(id: string): Promise<PatchRec | undefined> {
    const r = (await this.rows(`select ${PATCH_COLS} from patches p where p.id = $1`, [id]))[0];
    return r ? patchFrom(r) : undefined;
  }
  async updatePatch(id: string, patch: Partial<PatchRec>): Promise<void> {
    const cols: Record<string, string> = {
      title: 'title',
      description: 'description',
      visibility: 'visibility',
      expiresAt: 'expires_at',
      status: 'status',
      completedAt: 'completed_at',
      deletedAt: 'deleted_at',
    };
    await this.tx(async (c) => {
      const sets: string[] = [];
      const vals: unknown[] = [id];
      for (const [k, col] of Object.entries(cols)) {
        if (!(k in patch)) continue;
        vals.push((patch as Record<string, unknown>)[k] ?? null);
        sets.push(`${col} = $${vals.length}`);
      }
      if (sets.length) await c.query(`update patches set ${sets.join(', ')} where id = $1`, vals);
      if (patch.collaborators) {
        await c.query('delete from patch_collaborators where patch_id = $1', [id]);
        for (const u of new Set(patch.collaborators)) {
          await c.query('insert into patch_collaborators (patch_id, user_id) values ($1,$2)', [id, u]);
        }
      }
    });
  }
  async listPatches(q: PatchQuery): Promise<PatchRec[]> {
    const params: unknown[] = [
      q.userId,
      q.now,
      q.repoKey ?? null,
      q.cursor?.createdAt ?? null,
      q.cursor?.id ?? null,
      q.limit,
    ];
    let scope: string;
    if (q.scope === 'mine') {
      scope = 'p.author_id = $1';
    } else {
      params.push(q.orgIds);
      scope = `p.author_id <> $1 and ((p.visibility = 'org' and p.org_id = any($7::uuid[])) or
        (p.visibility = 'collaborators' and exists (select 1 from patch_collaborators c where c.patch_id = p.id and c.user_id = $1)))`;
    }
    const rows = await this.rows(
      `select ${PATCH_COLS} from patches p
       where ${scope} and p.status = 'complete' and p.deleted_at is null and (p.expires_at is null or p.expires_at > $2)
         and ($3::text is null or p.repo_key = $3)
         and ($4::timestamptz is null or (p.created_at, p.id) < ($4, $5::text))
       order by p.created_at desc, p.id desc limit $6`,
      params,
    );
    return rows.map(patchFrom);
  }
  async listPatchesByAuthor(userId: string): Promise<PatchRec[]> {
    return (await this.rows(`select ${PATCH_COLS} from patches p where p.author_id = $1`, [userId])).map(
      patchFrom,
    );
  }
  async markPatchesDeleted(by: { authorId?: string; orgId?: string }, at: Date): Promise<void> {
    await this.pool.query(
      `update patches set deleted_at = $3 where deleted_at is null and
         (($1::uuid is not null and author_id = $1) or ($2::uuid is not null and org_id = $2))`,
      [by.authorId ?? null, by.orgId ?? null, at],
    );
  }
  async listPatchesToPurge(now: Date, pendingCutoff: Date, limit: number): Promise<PatchRec[]> {
    return (
      await this.rows(
        `select ${PATCH_COLS} from patches p where p.deleted_at is not null or p.expires_at <= $1
           or (p.status = 'pending' and p.created_at < $2) limit $3`,
        [now, pendingCutoff, limit],
      )
    ).map(patchFrom);
  }
  async hardDeletePatch(id: string): Promise<void> {
    await this.pool.query('delete from patches where id = $1', [id]);
  }

  // ---- suggestions -----------------------------------------------------------------------------

  async createSuggestion(x: SuggestionRec): Promise<void> {
    await this.pool.query(
      `insert into suggestions (id, patch_id, author_id, provider, host, owner, repo, pr_number, pr_head_sha, title,
         status, status_by, comment_id, co_author, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        x.id,
        x.patchId,
        x.authorId,
        x.provider,
        x.host,
        x.owner,
        x.repo,
        x.prNumber,
        x.prHeadSha,
        x.title,
        x.status,
        x.statusBy ?? null,
        x.commentId ?? null,
        json(x.coAuthor),
        x.createdAt,
        x.updatedAt,
      ],
    );
  }
  async getSuggestion(id: string): Promise<SuggestionRec | undefined> {
    const r = (await this.rows('select * from suggestions where id = $1', [id]))[0];
    return r ? suggestionFrom(r) : undefined;
  }
  async listSuggestions(q: SuggestionQuery): Promise<SuggestionRec[]> {
    return (
      await this.rows(
        `select * from suggestions
         where provider = $1 and lower(owner) = lower($2) and lower(repo) = lower($3)
           and ($4::text is null or lower(host) = lower($4)) and ($5::int is null or pr_number = $5)
         order by created_at desc, id desc limit $6`,
        [q.provider, q.owner, q.repo, q.host ?? null, q.prNumber ?? null, q.limit],
      )
    ).map(suggestionFrom);
  }
  async updateSuggestion(
    id: string,
    patch: Partial<Pick<SuggestionRec, 'status' | 'statusBy' | 'commentId' | 'updatedAt'>>,
  ): Promise<void> {
    const cols: Record<string, string> = {
      status: 'status',
      statusBy: 'status_by',
      commentId: 'comment_id',
      updatedAt: 'updated_at',
    };
    const sets: string[] = [];
    const vals: unknown[] = [id];
    for (const [k, col] of Object.entries(cols)) {
      if (!(k in patch)) continue;
      vals.push((patch as Record<string, unknown>)[k] ?? null);
      sets.push(`${col} = $${vals.length}`);
    }
    if (sets.length) await this.pool.query(`update suggestions set ${sets.join(', ')} where id = $1`, vals);
  }

  async audit(e: AuditRec): Promise<void> {
    await this.pool.query(
      'insert into audit_log (at, actor_id, org_id, action, target, detail) values ($1,$2,$3,$4,$5,$6)',
      [e.at, e.actorId, e.orgId ?? null, e.action, e.target, json(e.detail)],
    );
  }
}
