/**
 * Team footprints (spec 14 §6.5): per-branch path hashes + changed line ranges, never file
 * contents. Plaintext paths / branch labels are dropped unless the org policy allows them.
 * Footprints expire 14 days after their last update; leaving the org deletes them.
 */
import type { Footprint, FootprintFile, TeamView } from '@githappens/cloud-api/types';
import { repoIdentityKey } from '@githappens/cloud-api/types';
import type { Ctx } from '../context.ts';
import { uuid } from '../crypto.ts';
import { invalid, notFound, type Router } from '../http.ts';
import { userRef, usersById } from '../serialize.ts';
import type { FootprintRec } from '../store/types.ts';
import {
  asArray,
  asObject,
  optString,
  parseIso,
  repoIdentity,
  reqString,
  SHA_RE,
  uuidParam,
} from '../validation.ts';
import { orgForMember } from './access.ts';

export const FOOTPRINT_TTL_MS = 14 * 86_400_000;
const MAX_FILES = 500;
const MAX_RANGES = 1000;
const HASH_RE = /^[A-Za-z0-9_-]{16,128}$/;

function parseFiles(v: unknown, sharePaths: boolean): FootprintFile[] {
  return asArray(v, 'files', MAX_FILES).map((raw) => {
    const o = asObject(raw, 'files[]');
    const file: FootprintFile = {
      pathHash: reqString(o, 'pathHash', { max: 128, pattern: HASH_RE }),
      ranges: asArray(o.ranges ?? [], 'ranges', MAX_RANGES).map((r) => {
        if (
          !Array.isArray(r) ||
          r.length !== 2 ||
          !r.every((n) => Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= 1e9) ||
          (r[0] as number) > (r[1] as number)
        ) {
          throw invalid('"ranges" must contain [start, end] pairs with 0 <= start <= end');
        }
        return [r[0] as number, r[1] as number] as [number, number];
      }),
    };
    const path = optString(o, 'path', { min: 1, max: 4096 });
    if (path !== undefined && sharePaths) file.path = path;
    return file;
  });
}

function footprintOut(f: FootprintRec, user: ReturnType<typeof userRef>): Footprint {
  const out: Footprint = {
    user,
    repoIdentityId: f.repoIdentityId,
    branchHash: f.branchHash,
    baseRef: f.baseRef,
    headSha: f.headSha,
    files: f.files,
    updatedAt: f.updatedAt.toISOString(),
  };
  if (f.branchLabel) out.branchLabel = f.branchLabel;
  return out;
}

export function registerFootprints(router: Router<Ctx>): void {
  router.add('PUT', '/v1/orgs/:orgId/footprints', async (ctx, params) => {
    const user = await ctx.user();
    const { org } = await orgForMember(ctx, params.orgId, user.id);
    const body = await ctx.body();
    const repo = repoIdentity(body.repo);
    const branchHash = reqString(body, 'branchHash', { max: 128, pattern: HASH_RE });
    const branchLabel = optString(body, 'branchLabel', { min: 1, max: 255 });
    const baseRef = reqString(body, 'baseRef', { max: 255 });
    const headSha = reqString(body, 'headSha', { max: 64, pattern: SHA_RE });
    const files = parseFiles(body.files, org.policies.footprintSharePaths);
    const now = ctx.date();
    const identity = await ctx.app.store.upsertRepoIdentity({
      id: uuid(),
      orgId: org.id,
      key: repoIdentityKey(repo),
      repo,
      createdAt: now,
    });
    await ctx.app.store.upsertFootprint({
      orgId: org.id,
      userId: user.id,
      repoIdentityId: identity.id,
      branchHash,
      branchLabel: org.policies.footprintShareBranchNames ? branchLabel : undefined,
      baseRef,
      headSha: headSha.toLowerCase(),
      files,
      updatedAt: now,
    });
    ctx.json(200, { repoIdentityId: identity.id });
  });

  router.add('DELETE', '/v1/orgs/:orgId/footprints/:repoIdentityId/:branchHash', async (ctx, params) => {
    const user = await ctx.user();
    const { org } = await orgForMember(ctx, params.orgId, user.id);
    const repoIdentityId = uuidParam(params.repoIdentityId, 'Footprint not found');
    const branchHash = params.branchHash ?? '';
    if (!HASH_RE.test(branchHash)) throw notFound('Footprint not found');
    await ctx.app.store.deleteFootprint(org.id, user.id, repoIdentityId, branchHash);
    ctx.json(204, undefined);
  });

  router.add('GET', '/v1/orgs/:orgId/footprints', async (ctx, params) => {
    const user = await ctx.user();
    const { org } = await orgForMember(ctx, params.orgId, user.id);
    const repo = ctx.query.get('repo');
    const since = ctx.query.get('since');
    const rows = await ctx.app.store.listFootprints(org.id, {
      repoIdentityId: repo ? uuidParam(repo, 'Repo identity not found') : undefined,
      since: since ? parseIso(since, 'since') : undefined,
      excludeUserId: user.id,
      notBefore: new Date(ctx.app.now() - FOOTPRINT_TTL_MS),
    });
    const users = await usersById(
      ctx.app.store,
      rows.map((r) => r.userId),
    );
    ctx.json(
      200,
      rows.map((r) => footprintOut(r, userRef(users.get(r.userId), r.userId))),
    );
  });

  router.add('GET', '/v1/orgs/:orgId/repo-identities', async (ctx, params) => {
    const user = await ctx.user();
    const { org } = await orgForMember(ctx, params.orgId, user.id);
    const key = ctx.query.get('key');
    if (!key || key.length > 800) throw invalid('"key" is required');
    const rec = await ctx.app.store.findRepoIdentity(org.id, key);
    if (!rec) throw notFound('Repo identity not found');
    ctx.json(200, { id: rec.id });
  });

  router.add('GET', '/v1/orgs/:orgId/team', async (ctx, params) => {
    const user = await ctx.user();
    const { org } = await orgForMember(ctx, params.orgId, user.id);
    const rows = await ctx.app.store.listFootprints(org.id, {
      notBefore: new Date(ctx.app.now() - FOOTPRINT_TTL_MS),
    });
    const [users, repos] = await Promise.all([
      usersById(
        ctx.app.store,
        rows.map((r) => r.userId),
      ),
      ctx.app.store.getRepoIdentities([...new Set(rows.map((r) => r.repoIdentityId))]),
    ]);
    const view: TeamView = { repos: [] };
    for (const repo of repos.sort((a, b) => a.key.localeCompare(b.key))) {
      const byUser = new Map<string, FootprintRec[]>();
      for (const r of rows) {
        if (r.repoIdentityId !== repo.id) continue;
        byUser.set(r.userId, [...(byUser.get(r.userId) ?? []), r]);
      }
      view.repos.push({
        repoIdentityId: repo.id,
        repo: repo.repo,
        members: [...byUser.entries()].map(([userId, fps]) => {
          const sorted = fps.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
          return {
            user: userRef(users.get(userId), userId),
            branches: sorted.map((f) => ({
              branchHash: f.branchHash,
              ...(f.branchLabel ? { branchLabel: f.branchLabel } : {}),
              fileCount: f.files.length,
              updatedAt: f.updatedAt.toISOString(),
            })),
            lastActivity: sorted[0]!.updatedAt.toISOString(),
          };
        }),
      });
    }
    ctx.json(200, view);
  });
}
