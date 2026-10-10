/**
 * Cloud Patches (spec 14 §6.3): metadata + client-sealed blobs (`sealPatchBundle`, never decrypted
 * here), presigned upload/download URLs, visibility enforcement, expiry, and the web viewer.
 *
 * Clarifications:
 * - Org policies (`allowPublicLinks`, `patchMaxExpiryDays`) apply to patches created with that
 *   `orgId`. An expiry beyond the cap (or no expiry) is clamped to the cap rather than rejected;
 *   the effective `expiresAt` is returned. The server-wide `GH_CLOUD_PATCH_MAX_EXPIRY_DAYS` caps
 *   every patch the same way.
 * - `collaborators` are stored only for `visibility: 'collaborators'` and must be org members.
 * - Expired / deleted / never-completed patches answer 410 until the purge job removes them; after
 *   that they are 404.
 * - Blob URLs: `<server>/v1/blobs/<token>`, token = HMAC-signed `{ p: patchId, o: 'put'|'get', exp }`.
 *   An invalid or expired blob token is 403. Upload answers 200 `{}`.
 */
import type {
  PatchCreated,
  PatchFile,
  PatchVisibility,
  PatchWithDownload,
} from '@githappens/cloud-api/types';
import { repoIdentityKey } from '@githappens/cloud-api/types';
import { BlobTooLargeError } from '../blob.ts';
import type { Ctx } from '../context.ts';
import { newPatchId, UUID_RE } from '../crypto.ts';
import {
  conflict,
  forbidden,
  gone,
  HttpError,
  invalid,
  notFound,
  type Router,
  SECURITY_HEADERS,
  sendHtml,
  tooLarge,
  unauthorized,
} from '../http.ts';
import { patchMeta, usersById } from '../serialize.ts';
import type { OrgRec, PatchRec, UserRec } from '../store/types.ts';
import {
  asArray,
  asObject,
  optBool,
  optEnum,
  optIso,
  optString,
  pageParams,
  parseIso,
  patchIdParam,
  repoIdentity,
  reqBool,
  reqEnum,
  reqInt,
  reqString,
  SHA_RE,
  uuidList,
} from '../validation.ts';
import { messagePage, newNonce, pageCsp, viewerPage } from '../views.ts';
import { isAdminRole } from './access.ts';

const UPLOAD_TTL_SEC = 15 * 60;
const DOWNLOAD_TTL_SEC = 5 * 60;
const MAX_FILES = 10_000;
const MAX_COLLABORATORS = 100;
const KINDS = ['wip', 'commit', 'stash', 'suggestion'] as const;
const VISIBILITIES = ['link', 'org', 'collaborators'] as const;
const DAY = 86_400_000;

interface BlobToken {
  p: string;
  o: 'put' | 'get';
  exp: number;
}

function blobUrl(ctx: Ctx, patchId: string, op: 'put' | 'get'): string {
  const ttl = op === 'put' ? UPLOAD_TTL_SEC : DOWNLOAD_TTL_SEC;
  const direct = ctx.app.blobs.presign?.(patchId, op, ttl);
  if (direct) return direct;
  const token = ctx.app.signer.sign('blob', {
    p: patchId,
    o: op,
    exp: Math.floor(ctx.app.now() / 1000) + ttl,
  });
  return `${ctx.app.config.publicUrl}/v1/blobs/${token}`;
}

export function isLive(p: PatchRec, now: Date): boolean {
  return p.status === 'complete' && !p.deletedAt && !(p.expiresAt && p.expiresAt <= now);
}

function parseFiles(v: unknown): PatchFile[] {
  return asArray(v, 'files', MAX_FILES).map((raw) => {
    const o = asObject(raw, 'files[]');
    const f: PatchFile = {
      path: reqString(o, 'path', { max: 4096 }),
      status: reqEnum(o, 'status', ['A', 'M', 'D', 'R'] as const),
      additions: reqInt(o, 'additions', 0, 1e9),
      deletions: reqInt(o, 'deletions', 0, 1e9),
    };
    const binary = optBool(o, 'binary');
    if (binary !== undefined) f.binary = binary;
    return f;
  });
}

/** Clamp `requested` to the strictest of the org and server caps; reject times in the past. */
function effectiveExpiry(ctx: Ctx, requested: Date | undefined, org: OrgRec | undefined): Date | undefined {
  const now = ctx.app.now();
  if (requested && requested.getTime() <= now) throw invalid('"expiresAt" must be in the future');
  const caps = [org?.policies.patchMaxExpiryDays, ctx.app.config.patchMaxExpiryDays].filter(
    (d): d is number => typeof d === 'number',
  );
  if (caps.length === 0) return requested;
  const max = new Date(now + Math.min(...caps) * DAY);
  return !requested || requested > max ? max : requested;
}

async function checkSharing(
  ctx: Ctx,
  author: UserRec,
  org: OrgRec | undefined,
  visibility: PatchVisibility,
  collaborators: string[],
): Promise<string[]> {
  if (visibility !== 'link' && !org) throw invalid(`"orgId" is required for visibility "${visibility}"`);
  if (visibility === 'link' && org && !org.policies.allowPublicLinks) {
    throw forbidden('This organization does not allow public link patches');
  }
  if (visibility !== 'collaborators') return [];
  const members = new Set((await ctx.app.store.listMembers(org!.id)).map((m) => m.userId));
  if (collaborators.some((id) => !members.has(id)))
    throw invalid('Collaborators must be members of the organization');
  return collaborators.filter((id) => id !== author.id);
}

export async function canRead(ctx: Ctx, p: PatchRec, user: UserRec): Promise<boolean> {
  if (p.authorId === user.id) return true;
  if (p.visibility === 'link') return true;
  if (p.visibility === 'org') return !!p.orgId && !!(await ctx.app.store.getMember(p.orgId, user.id));
  return p.collaborators.includes(user.id);
}

async function metaOf(ctx: Ctx, p: PatchRec) {
  const users = await usersById(ctx.app.store, [p.authorId, ...p.collaborators]);
  return patchMeta(p, users, ctx.app.config.publicUrl);
}

function encodeCursor(p: PatchRec): string {
  return Buffer.from(JSON.stringify({ t: p.createdAt.getTime(), i: p.id })).toString('base64url');
}

function decodeCursor(raw: string | undefined): { createdAt: Date; id: string } | undefined {
  if (!raw) return undefined;
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { t: unknown; i: unknown };
    if (
      typeof c.t === 'number' &&
      Number.isFinite(c.t) &&
      typeof c.i === 'string' &&
      /^[0-9A-Za-z]{22}$/.test(c.i)
    ) {
      return { createdAt: new Date(c.t), id: c.i };
    }
  } catch {
    // fall through
  }
  throw invalid('"cursor" is malformed');
}

export function registerPatches(router: Router<Ctx>): void {
  router.add('POST', '/v1/patches', async (ctx) => {
    const user = await ctx.user();
    const body = await ctx.body();
    const size = reqInt(body, 'size', 1, Number.MAX_SAFE_INTEGER);
    if (size > ctx.app.config.patchMaxBytes) {
      throw tooLarge(
        `Cloud Patches are limited to ${ctx.app.config.patchMaxBytes} bytes; push a branch instead`,
      );
    }
    const sha256 = reqString(body, 'sha256', { max: 64, pattern: /^[0-9a-fA-F]{64}$/ }).toLowerCase();
    const title = reqString(body, 'title', { max: 200 });
    const description = optString(body, 'description', { max: 20_000, multiline: true });
    const kind = reqEnum(body, 'kind', KINDS);
    const baseSha = reqString(body, 'baseSha', { max: 64, pattern: SHA_RE });
    const baseBranch = optString(body, 'baseBranch', { min: 1, max: 255, pattern: /^[^\s~^:?*[\\]+$/ });
    const e2e = reqBool(body, 'e2e');
    const visibility = reqEnum(body, 'visibility', VISIBILITIES);
    const repo = body.repo === undefined || body.repo === null ? undefined : repoIdentity(body.repo);
    let files = body.files === undefined || body.files === null ? undefined : parseFiles(body.files);
    if (e2e && files && files.length > 0)
      throw invalid('"files" must be omitted for end-to-end encrypted patches');
    if (e2e) files = undefined;
    const collaborators =
      body.collaborators === undefined || body.collaborators === null
        ? []
        : uuidList(body.collaborators, 'collaborators', MAX_COLLABORATORS);

    let org: OrgRec | undefined;
    if (body.orgId !== undefined && body.orgId !== null) {
      const orgId = typeof body.orgId === 'string' ? body.orgId : '';
      org = UUID_RE.test(orgId) ? await ctx.app.store.getOrg(orgId) : undefined;
      if (!org || !(await ctx.app.store.getMember(org.id, user.id))) {
        throw forbidden('You are not a member of that organization');
      }
    }
    const collab = await checkSharing(ctx, user, org, visibility, collaborators);
    const expiresAt = effectiveExpiry(ctx, optIso(body, 'expiresAt'), org);

    const patch: PatchRec = {
      id: newPatchId(),
      authorId: user.id,
      orgId: org?.id,
      repo,
      repoKey: repo ? repoIdentityKey(repo) : undefined,
      title,
      description,
      kind,
      baseSha: baseSha.toLowerCase(),
      baseBranch,
      files,
      e2e,
      size,
      sha256,
      visibility,
      collaborators: collab,
      status: 'pending',
      createdAt: ctx.date(),
      expiresAt,
    };
    await ctx.app.store.createPatch(patch);
    const created: PatchCreated = {
      id: patch.id,
      uploadUrl: blobUrl(ctx, patch.id, 'put'),
      webUrl: `${ctx.app.config.publicUrl}/p/${patch.id}`,
    };
    ctx.json(201, created);
  });

  router.add('PUT', '/v1/blobs/:token', async (ctx, params) => {
    const t = ctx.app.signer.verify<BlobToken>('blob', params.token ?? '', ctx.app.now());
    if (!t || t.o !== 'put') throw forbidden('The upload URL is invalid or expired');
    const patch = await ctx.app.store.getPatch(t.p);
    if (!patch || patch.deletedAt) throw gone('This patch was deleted');
    if (patch.status !== 'pending') throw conflict('This patch was already uploaded');
    const declared = ctx.req.headers['content-length'];
    if (declared !== undefined && Number(declared) > patch.size)
      throw tooLarge('Upload exceeds the declared size');
    try {
      await ctx.app.blobs.put(patch.id, ctx.req, patch.size);
    } catch (err) {
      if (err instanceof BlobTooLargeError) throw tooLarge('Upload exceeds the declared size');
      throw err;
    }
    ctx.json(200, {});
  });

  router.add('GET', '/v1/blobs/:token', async (ctx, params) => {
    const t = ctx.app.signer.verify<BlobToken>('blob', params.token ?? '', ctx.app.now());
    if (!t || t.o !== 'get') throw forbidden('The download URL is invalid or expired');
    const patch = await ctx.app.store.getPatch(t.p);
    if (!patch || !isLive(patch, ctx.date())) throw gone('This patch has expired or was deleted');
    const stream = await ctx.app.blobs.read(patch.id);
    if (!stream) throw gone('This patch has expired or was deleted');
    ctx.res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
      'content-type': 'application/octet-stream',
      'content-length': String(patch.size),
      'content-disposition': `attachment; filename="${patch.id}.klpatch"`,
    });
    if (ctx.req.method === 'HEAD') {
      stream.destroy();
      ctx.res.end();
      return;
    }
    stream.on('error', () => ctx.res.destroy());
    stream.pipe(ctx.res);
    await new Promise<void>((resolve) => ctx.res.on('close', resolve));
  });

  router.add('POST', '/v1/patches/:id/complete', async (ctx, params) => {
    const user = await ctx.user();
    const patch = await ctx.app.store.getPatch(patchIdParam(params.id));
    if (!patch || patch.authorId !== user.id) throw notFound('Patch not found');
    if (patch.deletedAt) throw gone('This patch was deleted');
    if (patch.status === 'complete') {
      ctx.json(200, await metaOf(ctx, patch));
      return;
    }
    const info = await ctx.app.blobs.digest(patch.id);
    if (!info) throw conflict('Upload the patch data before completing it');
    if (info.size !== patch.size || info.sha256 !== patch.sha256) {
      await ctx.app.blobs.delete(patch.id);
      throw invalid(
        info.size !== patch.size
          ? 'Uploaded size does not match "size"'
          : 'Uploaded data does not match "sha256"',
      );
    }
    const completedAt = ctx.date();
    await ctx.app.store.updatePatch(patch.id, { status: 'complete', completedAt });
    ctx.json(200, await metaOf(ctx, { ...patch, status: 'complete', completedAt }));
  });

  router.add('GET', '/v1/patches', async (ctx) => {
    const user = await ctx.user();
    const scope =
      optEnum({ scope: ctx.query.get('scope') ?? undefined }, 'scope', ['mine', 'shared'] as const) ?? 'mine';
    const repoKey = ctx.query.get('repo') ?? undefined;
    if (repoKey !== undefined && (repoKey.length === 0 || repoKey.length > 800))
      throw invalid('"repo" is malformed');
    const { limit, cursor } = pageParams(ctx.query);
    const orgIds =
      scope === 'shared' ? (await ctx.app.store.listOrgsForUser(user.id)).map((o) => o.org.id) : [];
    const rows = await ctx.app.store.listPatches({
      scope,
      userId: user.id,
      orgIds,
      repoKey,
      now: ctx.date(),
      cursor: decodeCursor(cursor),
      limit: limit + 1,
    });
    const page = rows.slice(0, limit);
    const users = await usersById(
      ctx.app.store,
      page.flatMap((p) => [p.authorId, ...p.collaborators]),
    );
    ctx.json(200, {
      items: page.map((p) => patchMeta(p, users, ctx.app.config.publicUrl)),
      ...(rows.length > limit ? { nextCursor: encodeCursor(page[page.length - 1]!) } : {}),
    });
  });

  // Bearer OPTIONAL: anonymous access for visibility 'link'.
  router.add('GET', '/v1/patches/:id', async (ctx, params) => {
    const patch = await ctx.app.store.getPatch(patchIdParam(params.id));
    if (!patch) throw notFound('Patch not found');
    if (!isLive(patch, ctx.date())) throw gone('This patch has expired or was deleted');
    if (patch.visibility !== 'link' || ctx.req.headers.authorization !== undefined) {
      const user = await ctx.optionalUser(); // an invalid token is a 401 even for link patches
      if (patch.visibility !== 'link') {
        if (!user) throw unauthorized('Sign in to open this patch');
        if (!(await canRead(ctx, patch, user))) throw forbidden('You do not have access to this patch');
      }
    }
    const out: PatchWithDownload = {
      ...(await metaOf(ctx, patch)),
      downloadUrl: blobUrl(ctx, patch.id, 'get'),
    };
    ctx.json(200, out);
  });

  router.add('PATCH', '/v1/patches/:id', async (ctx, params) => {
    const user = await ctx.user();
    const patch = await ctx.app.store.getPatch(patchIdParam(params.id));
    if (!patch || patch.authorId !== user.id) {
      if (patch && (await canRead(ctx, patch, user))) throw forbidden('Only the author can edit this patch');
      throw notFound('Patch not found');
    }
    if (patch.deletedAt || (patch.expiresAt && patch.expiresAt <= ctx.date())) {
      throw gone('This patch has expired or was deleted');
    }
    const body = await ctx.body();
    const org = patch.orgId ? await ctx.app.store.getOrg(patch.orgId) : undefined;
    const next: Partial<PatchRec> = {};
    const title = optString(body, 'title', { min: 1, max: 200 });
    if (title !== undefined) next.title = title;
    const description = optString(body, 'description', { max: 20_000, multiline: true });
    if (description !== undefined) next.description = description;
    const visibility = optEnum(body, 'visibility', VISIBILITIES) ?? patch.visibility;
    if (body.visibility !== undefined || body.collaborators !== undefined) {
      const requested =
        body.collaborators === undefined || body.collaborators === null
          ? patch.collaborators
          : uuidList(body.collaborators, 'collaborators', MAX_COLLABORATORS);
      next.visibility = visibility;
      next.collaborators = await checkSharing(ctx, user, org, visibility, requested);
    }
    if ('expiresAt' in body) {
      const requested = body.expiresAt === null ? undefined : parseIso(body.expiresAt, 'expiresAt');
      next.expiresAt = effectiveExpiry(ctx, requested, org);
    }
    await ctx.app.store.updatePatch(patch.id, next);
    if (next.visibility !== undefined) {
      await ctx.app.store.audit({
        at: ctx.date(),
        actorId: user.id,
        orgId: patch.orgId,
        action: 'patch.visibility',
        target: patch.id,
        detail: { visibility: next.visibility, collaborators: next.collaborators },
      });
    }
    const updated = await ctx.app.store.getPatch(patch.id);
    ctx.json(200, await metaOf(ctx, updated!));
  });

  router.add('DELETE', '/v1/patches/:id', async (ctx, params) => {
    const user = await ctx.user();
    const patch = await ctx.app.store.getPatch(patchIdParam(params.id));
    if (!patch) throw notFound('Patch not found');
    let allowed = patch.authorId === user.id;
    if (!allowed && patch.orgId)
      allowed = isAdminRole((await ctx.app.store.getMember(patch.orgId, user.id))?.role);
    if (!allowed) {
      if (await canRead(ctx, patch, user))
        throw forbidden('Only the author or an org admin can delete this patch');
      throw notFound('Patch not found');
    }
    if (!patch.deletedAt) {
      await ctx.app.store.updatePatch(patch.id, { deletedAt: ctx.date() });
      await ctx.app.blobs.delete(patch.id).catch(() => undefined); // the purge job retries
      await ctx.app.store.audit({
        at: ctx.date(),
        actorId: user.id,
        orgId: patch.orgId,
        action: 'patch.delete',
        target: patch.id,
      });
    }
    ctx.json(204, undefined);
  });

  // PUBLIC web viewer.
  router.add('GET', '/p/:id', async (ctx, params) => {
    const nonce = newNonce();
    const origins = [ctx.app.config.publicUrl];
    if (ctx.app.blobs.presign && ctx.app.blobs.publicOrigin) origins.push(ctx.app.blobs.publicOrigin);
    const csp = pageCsp(nonce, origins);
    let patch: PatchRec | undefined;
    try {
      patch = await ctx.app.store.getPatch(patchIdParam(params.id));
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
    }
    if (!patch) {
      sendHtml(
        ctx.res,
        404,
        messagePage(nonce, 'Cloud Patch not found', 'This link does not point to a Cloud Patch.'),
        csp,
      );
      return;
    }
    if (!isLive(patch, ctx.date())) {
      sendHtml(
        ctx.res,
        410,
        messagePage(nonce, 'Cloud Patch expired', 'This Cloud Patch has expired or was deleted.'),
        csp,
      );
      return;
    }
    sendHtml(ctx.res, 200, viewerPage(nonce, patch.id), csp);
  });
}
