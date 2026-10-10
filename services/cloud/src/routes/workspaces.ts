/**
 * Cloud workspaces (spec 11 §6.6) and Launchpad state.
 *
 * Visibility: owner; users listed in `shares`; members of an org listed in `shares`; members of a
 * team listed in `shares`. Writes (doc, shares, delete): the owner, or an admin/owner of the
 * workspace's org. Shared users are read-only (clarification: the contract does not say who may
 * write; this is the conservative choice).
 *
 * Workspace docs must not contain local paths: any `localPath` / `localPaths` key is stripped
 * server-side as a safety net (spec 14 §6.8).
 */
import type { WorkspaceShare } from '@githappens/cloud-api/types';
import type { Ctx } from '../context.ts';
import { uuid, UUID_RE } from '../crypto.ts';
import { forbidden, invalid, notFound, preconditionFailed, type Router, tooLarge } from '../http.ts';
import { workspaceOut } from '../serialize.ts';
import type { UserRec, WorkspaceRec } from '../store/types.ts';
import { asArray, asObject, ifMatch, reqEnum, uuidParam } from '../validation.ts';
import { isAdminRole, type Membership, membershipOf } from './access.ts';

const DOC_MAX_BYTES = 512 * 1024;
const MAX_SHARES = 200;
const LOCAL_PATH_KEYS = new Set(['localPath', 'localPaths']);

function stripLocalPaths(value: unknown, depth = 0): unknown {
  if (depth > 64) throw invalid('"doc" is nested too deeply');
  if (Array.isArray(value)) return value.map((v) => stripLocalPaths(v, depth + 1));
  if (value && typeof value === 'object') {
    // fromEntries defines own data properties, so a "__proto__" key stays plain data.
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => !LOCAL_PATH_KEYS.has(k))
        .map(([k, v]) => [k, stripLocalPaths(v, depth + 1)]),
    );
  }
  return value;
}

export function parseDoc(v: unknown, key = 'doc'): Record<string, unknown> {
  const doc = stripLocalPaths(asObject(v, key)) as Record<string, unknown>;
  if (Buffer.byteLength(JSON.stringify(doc)) > DOC_MAX_BYTES)
    throw tooLarge(`"${key}" exceeds ${DOC_MAX_BYTES} bytes`);
  return doc;
}

function canSee(ws: WorkspaceRec, user: UserRec, m: Membership): boolean {
  if (ws.ownerUserId === user.id) return true;
  if (ws.orgId && isAdminRole(m.roles.get(ws.orgId))) return true;
  return ws.shares.some(
    (s) =>
      (s.principalType === 'user' && s.principalId === user.id) ||
      (s.principalType === 'org' && m.roles.has(s.principalId)) ||
      (s.principalType === 'team' && m.teamIds.includes(s.principalId)),
  );
}

function canWrite(ws: WorkspaceRec, user: UserRec, m: Membership): boolean {
  return ws.ownerUserId === user.id || (!!ws.orgId && isAdminRole(m.roles.get(ws.orgId)));
}

async function loadVisible(ctx: Ctx, rawId: string | undefined, user: UserRec) {
  const id = uuidParam(rawId, 'Workspace not found');
  const [ws, m] = await Promise.all([ctx.app.store.getWorkspace(id), membershipOf(ctx, user.id)]);
  if (!ws || !canSee(ws, user, m)) throw notFound('Workspace not found');
  return { ws, m };
}

/** Principals must exist and live inside the workspace's org (or an org the caller belongs to). */
async function parseShares(
  ctx: Ctx,
  v: unknown,
  ws: WorkspaceRec,
  actor: Membership,
): Promise<WorkspaceShare[]> {
  const out = new Map<string, WorkspaceShare>();
  const inScope = (orgId: string): boolean => (ws.orgId ? orgId === ws.orgId : actor.roles.has(orgId));
  for (const raw of asArray(v, 'shares', MAX_SHARES)) {
    const o = asObject(raw, 'shares[]');
    const principalType = reqEnum(o, 'principalType', ['team', 'user', 'org'] as const);
    const principalId = typeof o.principalId === 'string' ? o.principalId : '';
    try {
      uuidParam(principalId);
    } catch {
      throw invalid('"principalId" must be an id');
    }
    if (principalType === 'org') {
      if (!inScope(principalId) || !(await ctx.app.store.getOrg(principalId))) {
        throw invalid('Workspaces can only be shared with your own organization');
      }
    } else if (principalType === 'team') {
      const team = await ctx.app.store.getTeam(principalId);
      if (!team || !inScope(team.orgId)) throw invalid('Unknown team');
    } else {
      const target = await ctx.app.store.getUser(principalId);
      if (!target || target.deletedAt) throw invalid('Unknown user');
      const theirOrgs = (await ctx.app.store.listOrgsForUser(principalId)).map((x) => x.org.id);
      if (!theirOrgs.some(inScope))
        throw invalid('Workspaces can only be shared with members of your organizations');
    }
    out.set(`${principalType}:${principalId}`, { principalType, principalId });
  }
  return [...out.values()];
}

export function registerWorkspaces(router: Router<Ctx>): void {
  router.add('GET', '/v1/workspaces', async (ctx) => {
    const user = await ctx.user();
    const m = await membershipOf(ctx, user.id);
    const list = await ctx.app.store.listWorkspacesVisibleTo(user.id, [...m.roles.keys()], m.teamIds);
    ctx.json(200, list.map(workspaceOut));
  });

  router.add('POST', '/v1/workspaces', async (ctx) => {
    const user = await ctx.user();
    const body = await ctx.body();
    let orgId: string | undefined;
    if (body.orgId !== undefined && body.orgId !== null) {
      orgId = typeof body.orgId === 'string' ? body.orgId : '';
      const member = UUID_RE.test(orgId) ? await ctx.app.store.getMember(orgId, user.id) : undefined;
      if (!member) throw forbidden('You are not a member of that organization');
    }
    const now = ctx.date();
    const ws: WorkspaceRec = {
      id: uuid(),
      ownerUserId: user.id,
      orgId,
      version: 1,
      doc: parseDoc(body.doc),
      shares: [],
      createdAt: now,
      updatedAt: now,
    };
    if (body.shares !== undefined)
      ws.shares = await parseShares(ctx, body.shares, ws, await membershipOf(ctx, user.id));
    await ctx.app.store.createWorkspace(ws);
    ctx.json(201, workspaceOut(ws), { etag: `"${ws.version}"` });
  });

  router.add('GET', '/v1/workspaces/:id', async (ctx, params) => {
    const user = await ctx.user();
    const { ws } = await loadVisible(ctx, params.id, user);
    ctx.json(200, workspaceOut(ws), { etag: `"${ws.version}"` });
  });

  router.add('PUT', '/v1/workspaces/:id', async (ctx, params) => {
    const user = await ctx.user();
    const { ws, m } = await loadVisible(ctx, params.id, user);
    if (!canWrite(ws, user, m)) throw forbidden('Only the owner or an org admin can edit this workspace');
    const expected = ifMatch(ctx.req.headers['if-match']);
    const body = await ctx.body();
    const result = await ctx.app.store.updateWorkspace(
      ws.id,
      expected,
      { doc: parseDoc(body.doc) },
      ctx.date(),
    );
    if (!result.ok) throw preconditionFailed(result.currentVersion);
    ctx.json(200, workspaceOut(result.value), { etag: `"${result.value.version}"` });
  });

  router.add('DELETE', '/v1/workspaces/:id', async (ctx, params) => {
    const user = await ctx.user();
    const { ws, m } = await loadVisible(ctx, params.id, user);
    if (!canWrite(ws, user, m)) throw forbidden('Only the owner or an org admin can delete this workspace');
    await ctx.app.store.deleteWorkspace(ws.id);
    ctx.json(204, undefined);
  });

  router.add('PUT', '/v1/workspaces/:id/shares', async (ctx, params) => {
    const user = await ctx.user();
    const { ws, m } = await loadVisible(ctx, params.id, user);
    if (!canWrite(ws, user, m)) throw forbidden('Only the owner or an org admin can share this workspace');
    const body = await ctx.body();
    const shares = await parseShares(ctx, body.shares, ws, m);
    const expected = ifMatch(ctx.req.headers['if-match']);
    const result = await ctx.app.store.updateWorkspace(ws.id, expected, { shares }, ctx.date());
    if (!result.ok) throw preconditionFailed(result.currentVersion);
    await ctx.app.store.audit({
      at: ctx.date(),
      actorId: user.id,
      orgId: ws.orgId,
      action: 'workspace.shares',
      target: ws.id,
      detail: { shares },
    });
    ctx.json(200, workspaceOut(result.value), { etag: `"${result.value.version}"` });
  });

  router.add('GET', '/v1/launchpad/state', async (ctx) => {
    const user = await ctx.user();
    const rec = await ctx.app.store.getLaunchpad(user.id);
    const version = rec?.version ?? 0;
    ctx.json(200, { version, doc: rec?.doc ?? {} }, { etag: `"${version}"` });
  });

  router.add('PUT', '/v1/launchpad/state', async (ctx) => {
    const user = await ctx.user();
    const expected = ifMatch(ctx.req.headers['if-match']);
    const body = await ctx.body();
    const result = await ctx.app.store.putLaunchpad(user.id, expected, parseDoc(body.doc), ctx.date());
    if (!result.ok) throw preconditionFailed(result.currentVersion);
    ctx.json(200, { version: result.value }, { etag: `"${result.value}"` });
  });
}
