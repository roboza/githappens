/**
 * `GET /openapi.json` (PUBLIC): the OpenAPI 3.1 description of this API, generated from the REST
 * contract in `@githappens/cloud-api/types` by `scripts/gen-openapi.ts` and committed as
 * `services/cloud/openapi.json`. The `servers` entry is rewritten to this deployment's public URL.
 */
import { readFileSync } from 'node:fs';
import type { Ctx } from '../context.ts';
import { HttpError, type Router } from '../http.ts';

export const OPENAPI_FILE = new URL('../../openapi.json', import.meta.url);

let cached: Record<string, unknown> | null = null;

function load(): Record<string, unknown> {
  cached ??= JSON.parse(readFileSync(OPENAPI_FILE, 'utf8')) as Record<string, unknown>;
  return cached;
}

export function registerOpenApi(router: Router<Ctx>): void {
  router.add('GET', '/openapi.json', async (ctx) => {
    let doc: Record<string, unknown>;
    try {
      doc = load();
    } catch {
      throw new HttpError(404, 'not_found', 'The OpenAPI document is not bundled with this server');
    }
    ctx.json(
      200,
      { ...doc, servers: [{ url: ctx.app.config.publicUrl }] },
      {
        'cache-control': 'public, max-age=300',
      },
    );
  });
}
