/** `/v1/me`: profile, GDPR export, and account deletion (hard delete by the purge job after 7 days). */
import type { Me } from '@githappens/cloud-api/types';
import type { Ctx } from '../context.ts';
import type { Router } from '../http.ts';
import { memberRef, patchMeta, syncInfo, usersById, workspaceOut } from '../serialize.ts';

export const ACCOUNT_DELETE_GRACE_MS = 7 * 86_400_000;

export function registerAccount(router: Router<Ctx>): void {
  router.add('GET', '/v1/me', async (ctx) => {
    const user = await ctx.user();
    const orgs = await ctx.app.store.listOrgsForUser(user.id);
    const me: Me = {
      id: user.id,
      name: user.name,
      email: user.email,
      orgs: orgs.map(({ org, role }) => ({ id: org.id, name: org.name, slug: org.slug, role })),
    };
    if (user.avatarUrl) me.avatarUrl = user.avatarUrl;
    ctx.json(200, me);
  });

  router.add('GET', '/v1/me/export', async (ctx) => {
    const user = await ctx.user();
    const { store, config } = ctx.app;
    const [orgs, sync, patches, workspaces, launchpad] = await Promise.all([
      store.listOrgsForUser(user.id),
      store.listSync(user.id),
      store.listPatchesByAuthor(user.id),
      store.listWorkspacesOwnedBy(user.id),
      store.getLaunchpad(user.id),
    ]);
    const live = patches.filter((p) => !p.deletedAt);
    const users = await usersById(store, [user.id, ...live.flatMap((p) => p.collaborators)]);
    ctx.json(200, {
      user: { ...memberRef(user, user.id), createdAt: user.createdAt.toISOString() },
      orgs: orgs.map(({ org, role }) => ({ id: org.id, name: org.name, slug: org.slug, role })),
      syncCategories: sync.map(syncInfo),
      patches: live.map((p) => patchMeta(p, users, config.publicUrl)),
      workspaces: workspaces.map(workspaceOut),
      // Not in the contract's export shape, included for completeness (GDPR): Launchpad state.
      launchpadState: launchpad ? { version: launchpad.version, doc: launchpad.doc } : null,
    });
  });

  router.add('DELETE', '/v1/me', async (ctx) => {
    const user = await ctx.user();
    const { store } = ctx.app;
    const now = ctx.date();
    // Effective immediately: tokens revoked, patches unreachable (410), footprints gone. Rows and
    // blobs are hard-deleted by the purge job once the grace period has passed.
    await store.markUserDeleted(user.id, now);
    await store.revokeUserRefreshTokens(user.id, now);
    await store.markPatchesDeleted({ authorId: user.id }, now);
    await store.deleteFootprintsForUser(user.id);
    await store.audit({ at: now, actorId: user.id, action: 'account.delete', target: user.id });
    ctx.json(202, { deleteAfter: new Date(now.getTime() + ACCOUNT_DELETE_GRACE_MS).toISOString() });
  });
}
