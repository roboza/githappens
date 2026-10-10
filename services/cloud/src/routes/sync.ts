/**
 * Settings sync (spec 14 §6.2): the server stores exactly the ciphertext + nonce it is given, plus
 * category name, version, size, device id and timestamp. It never sees keys or plaintext.
 */
import type { SyncItem } from '@githappens/cloud-api/types';
import type { Ctx } from '../context.ts';
import { notFound, preconditionFailed, type Router, tooLarge } from '../http.ts';
import { syncInfo } from '../serialize.ts';
import { base64url, ifMatch, reqString } from '../validation.ts';

const CATEGORY_RE = /^[a-z_][a-z0-9-]{0,40}$/;
const NONCE_MAX_CHARS = 64; // XChaCha20 nonce = 24 bytes = 32 chars; leave headroom for other AEADs

export function registerSync(router: Router<Ctx>): void {
  router.add('GET', '/v1/sync', async (ctx) => {
    const user = await ctx.user();
    ctx.json(200, (await ctx.app.store.listSync(user.id)).map(syncInfo));
  });

  router.add('GET', '/v1/sync/:category', async (ctx, params) => {
    const user = await ctx.user();
    const category = params.category!;
    if (!CATEGORY_RE.test(category)) throw notFound('Unknown sync category');
    const rec = await ctx.app.store.getSync(user.id, category);
    if (!rec) throw notFound('Sync category not found');
    const item: SyncItem = {
      ...syncInfo(rec),
      ciphertext: rec.ciphertext.toString('base64url'),
      nonce: rec.nonce.toString('base64url'),
    };
    ctx.json(200, item, { etag: `"${rec.version}"` });
  });

  router.add('PUT', '/v1/sync/:category', async (ctx, params) => {
    const user = await ctx.user();
    const category = params.category!;
    if (!CATEGORY_RE.test(category)) throw notFound('Unknown sync category');
    const expected = ifMatch(ctx.req.headers['if-match']);
    const body = await ctx.body();
    const maxChars = Math.ceil((ctx.app.config.syncMaxBytes * 4) / 3) + 4;
    if (typeof body.ciphertext === 'string' && body.ciphertext.length > maxChars) {
      throw tooLarge(`Sync items are limited to ${ctx.app.config.syncMaxBytes} bytes`);
    }
    const ciphertext = base64url(body, 'ciphertext', maxChars);
    if (ciphertext.length > ctx.app.config.syncMaxBytes) {
      throw tooLarge(`Sync items are limited to ${ctx.app.config.syncMaxBytes} bytes`);
    }
    const nonce = base64url(body, 'nonce', NONCE_MAX_CHARS);
    const deviceId = reqString(body, 'deviceId', { max: 128, pattern: /^[\x21-\x7e]+$/ });
    const result = await ctx.app.store.putSync(
      { userId: user.id, category, ciphertext, nonce, deviceId, updatedAt: ctx.date() },
      expected,
    );
    if (!result.ok) throw preconditionFailed(result.currentVersion);
    ctx.json(200, { version: result.value }, { etag: `"${result.value}"` });
  });

  router.add('DELETE', '/v1/sync', async (ctx) => {
    const user = await ctx.user();
    await ctx.app.store.deleteAllSync(user.id);
    ctx.json(204, undefined);
  });
}
