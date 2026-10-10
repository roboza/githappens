/**
 * Code Suggest (spec 14 §6.4): suggestion records tie a Cloud Patch of kind `suggestion` to a pull
 * request. The server never checks repository access (that would require provider tokens, which never
 * reach this server); read access to a suggestion is read access to its patch, so possession of the
 * link is the capability.
 *
 * Clarifications:
 * - Create: the patch must be the caller's own, kind `suggestion`, completed and live; one patch backs
 *   at most one suggestion (409 otherwise).
 * - List: the PR coordinates are required (`provider`, `owner`, `repo`; `host` / `pr` optional);
 *   results are filtered to suggestions whose patch is live and readable by the caller (anonymous
 *   callers see link-visibility ones). Hidden rows are simply absent.
 * - PATCH: `status` may be changed by any signed-in user who can read the patch (the PR author marks a
 *   suggestion applied or dismissed); `commentId` only by the suggestion's author.
 */
import type { Suggestion, SuggestionStatus } from '@githappens/cloud-api/types';
import type { Ctx } from '../context.ts';
import { uuid, UUID_RE } from '../crypto.ts';
import { conflict, forbidden, gone, invalid, notFound, type Router } from '../http.ts';
import { userRef, usersById } from '../serialize.ts';
import type { SuggestionRec, UserRec } from '../store/types.ts';
import { asObject, optEnum, optString, reqInt, reqString } from '../validation.ts';
import { canRead, isLive } from './patches.ts';

const STATUSES = ['open', 'applied', 'dismissed'] as const satisfies readonly SuggestionStatus[];
const NAME_RE = /^(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9_.~-][A-Za-z0-9_.~/ -]*$/;
const PROVIDER_RE = /^[a-z][a-z0-9-]{0,31}$/;
const HOST_RE = /^[A-Za-z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._~/-]*)?$/;
const HEAD_RE = /^[0-9a-fA-F]{40}(?:[0-9a-fA-F]{24})?$/;
const COMMENT_ID_RE = /^[A-Za-z0-9_=:.-]{1,200}$/;
const MAX_LIST = 200;

function suggestionOut(s: SuggestionRec, users: Map<string, UserRec>, publicUrl: string): Suggestion {
  const out: Suggestion = {
    id: s.id,
    patchId: s.patchId,
    author: userRef(users.get(s.authorId), s.authorId),
    provider: s.provider,
    host: s.host,
    owner: s.owner,
    repo: s.repo,
    prNumber: s.prNumber,
    prHeadSha: s.prHeadSha,
    title: s.title,
    status: s.status,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
    webUrl: `${publicUrl}/p/${s.patchId}`,
    deepLink: `githappens://suggestion/${s.id}`,
  };
  if (s.statusBy) out.statusBy = userRef(users.get(s.statusBy), s.statusBy);
  if (s.commentId) out.commentId = s.commentId;
  if (s.coAuthor) out.coAuthor = { ...s.coAuthor };
  return out;
}

async function render(ctx: Ctx, list: SuggestionRec[]): Promise<Suggestion[]> {
  const users = await usersById(
    ctx.app.store,
    list.flatMap((s) => (s.statusBy ? [s.authorId, s.statusBy] : [s.authorId])),
  );
  return list.map((s) => suggestionOut(s, users, ctx.app.config.publicUrl));
}

/** Readable = patch live and (link visibility, or signed in with patch read access). */
async function readable(ctx: Ctx, s: SuggestionRec, user: UserRec | undefined): Promise<boolean> {
  const patch = await ctx.app.store.getPatch(s.patchId);
  if (!patch || !isLive(patch, ctx.date())) return false;
  if (patch.visibility === 'link') return true;
  return !!user && (await canRead(ctx, patch, user));
}

function prCoords(o: Record<string, unknown>): {
  provider: string;
  host: string;
  owner: string;
  repo: string;
} {
  return {
    provider: reqString(o, 'provider', { max: 32, pattern: PROVIDER_RE }),
    host: reqString(o, 'host', { max: 255, pattern: HOST_RE }),
    owner: reqString(o, 'owner', { max: 255, pattern: NAME_RE }),
    repo: reqString(o, 'repo', { max: 255, pattern: NAME_RE }),
  };
}

async function load(ctx: Ctx, rawId: string | undefined): Promise<SuggestionRec> {
  if (!rawId || !UUID_RE.test(rawId)) throw notFound('Suggestion not found');
  const s = await ctx.app.store.getSuggestion(rawId);
  if (!s) throw notFound('Suggestion not found');
  return s;
}

export function registerSuggestions(router: Router<Ctx>): void {
  router.add('POST', '/v1/suggestions', async (ctx) => {
    const user = await ctx.user();
    const body = await ctx.body();
    const coords = prCoords(body);
    const patchId = reqString(body, 'patchId', { max: 64, pattern: /^[0-9A-Za-z]{22}$/ });
    const prNumber = reqInt(body, 'prNumber', 1, 2_147_483_647);
    const prHeadSha = reqString(body, 'prHeadSha', { max: 64, pattern: HEAD_RE }).toLowerCase();
    const title = reqString(body, 'title', { max: 200 });
    const commentId = optString(body, 'commentId', { max: 200, pattern: COMMENT_ID_RE });
    let coAuthor: SuggestionRec['coAuthor'];
    if (body.coAuthor !== undefined && body.coAuthor !== null) {
      const o = asObject(body.coAuthor, 'coAuthor');
      coAuthor = {
        name: reqString(o, 'name', { max: 200 }),
        email: reqString(o, 'email', { max: 320, pattern: /^[^\s<>@]+@[^\s<>@]+$/ }),
      };
    }
    const patch = await ctx.app.store.getPatch(patchId);
    if (!patch || patch.authorId !== user.id) throw notFound('Patch not found');
    if (!isLive(patch, ctx.date())) throw gone('This patch has expired, was deleted or is not uploaded yet');
    if (patch.kind !== 'suggestion') throw invalid('The patch must be of kind "suggestion"');
    const existing = await ctx.app.store.listSuggestions({ ...coords, prNumber, limit: MAX_LIST });
    if (existing.some((s) => s.patchId === patchId)) throw conflict('This patch already backs a suggestion');
    const now = ctx.date();
    const rec: SuggestionRec = {
      id: uuid(),
      patchId,
      authorId: user.id,
      ...coords,
      prNumber,
      prHeadSha,
      title,
      status: 'open',
      createdAt: now,
      updatedAt: now,
      ...(commentId ? { commentId } : {}),
      ...(coAuthor ? { coAuthor } : {}),
    };
    await ctx.app.store.createSuggestion(rec);
    ctx.json(201, (await render(ctx, [rec]))[0]);
  });

  // Bearer OPTIONAL: anonymous callers see suggestions backed by link patches.
  router.add('GET', '/v1/suggestions', async (ctx) => {
    const user = await ctx.optionalUser();
    const q = Object.fromEntries(ctx.query.entries()) as Record<string, unknown>;
    if (!q.host) delete q.host;
    const provider = reqString(q, 'provider', { max: 32, pattern: PROVIDER_RE });
    const host = optString(q, 'host', { max: 255, pattern: HOST_RE });
    const owner = reqString(q, 'owner', { max: 255, pattern: NAME_RE });
    const repo = reqString(q, 'repo', { max: 255, pattern: NAME_RE });
    let prNumber: number | undefined;
    if (q.pr !== undefined && q.pr !== '') {
      if (typeof q.pr !== 'string' || !/^\d{1,10}$/.test(q.pr) || Number(q.pr) < 1)
        throw invalid('"pr" must be a positive integer');
      prNumber = Number(q.pr);
    }
    const rows = await ctx.app.store.listSuggestions({
      provider,
      ...(host ? { host } : {}),
      owner,
      repo,
      ...(prNumber !== undefined ? { prNumber } : {}),
      limit: MAX_LIST,
    });
    const visible: SuggestionRec[] = [];
    for (const s of rows) if (await readable(ctx, s, user)) visible.push(s);
    ctx.json(200, await render(ctx, visible));
  });

  router.add('GET', '/v1/suggestions/:id', async (ctx, params) => {
    const s = await load(ctx, params.id);
    const user = await ctx.optionalUser();
    if (!(await readable(ctx, s, user))) throw notFound('Suggestion not found');
    ctx.json(200, (await render(ctx, [s]))[0]);
  });

  router.add('PATCH', '/v1/suggestions/:id', async (ctx, params) => {
    const user = await ctx.user();
    const s = await load(ctx, params.id);
    if (!(await readable(ctx, s, user))) throw notFound('Suggestion not found');
    const body = await ctx.body();
    const status = optEnum(body, 'status', STATUSES);
    const commentId = optString(body, 'commentId', { max: 200, pattern: COMMENT_ID_RE });
    if (status === undefined && commentId === undefined) throw invalid('Nothing to update');
    if (commentId !== undefined && s.authorId !== user.id)
      throw forbidden('Only the author can attach the PR comment');
    const next: Partial<SuggestionRec> = { updatedAt: ctx.date() };
    if (commentId !== undefined) next.commentId = commentId;
    if (status !== undefined && status !== s.status) {
      next.status = status;
      next.statusBy = status === 'open' ? undefined : user.id;
    }
    await ctx.app.store.updateSuggestion(s.id, next);
    const updated = (await ctx.app.store.getSuggestion(s.id))!;
    ctx.json(200, (await render(ctx, [updated]))[0]);
  });
}
