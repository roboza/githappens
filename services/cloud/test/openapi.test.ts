import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generateOpenApi, OUTPUT_FILE, UNDOCUMENTED_ROUTES } from '../scripts/gen-openapi.ts';
import { call, startCloud } from './helpers.ts';

describe('OpenAPI document', () => {
  const doc = generateOpenApi() as { openapi: string; paths: Record<string, Record<string, unknown>> };

  it('is generated from the contract and committed up to date', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(JSON.parse(readFileSync(OUTPUT_FILE, 'utf8'))).toEqual(doc);
  });

  it('documents every JSON route the server registers', async () => {
    const cloud = await startCloud();
    try {
      // Router is internal to the app; re-create the route table through a fresh app instance.
      const { Router } = await import('../src/http.ts');
      const routes = new Router();
      const mods = await Promise.all([
        import('../src/routes/account.ts'),
        import('../src/routes/sync.ts'),
        import('../src/routes/workspaces.ts'),
        import('../src/routes/orgs.ts'),
        import('../src/routes/patches.ts'),
        import('../src/routes/footprints.ts'),
        import('../src/routes/suggestions.ts'),
        import('../src/routes/openapi.ts'),
        import('../src/routes/oauth.ts'),
      ]);
      for (const m of mods) {
        for (const [name, fn] of Object.entries(m)) {
          if (name.startsWith('register') && typeof fn === 'function')
            (fn as (r: unknown, v: string) => void)(routes, '0');
        }
      }
      const missing = routes
        .list()
        .map((r) => `${r.method} ${r.pattern}`)
        .filter((r) => !UNDOCUMENTED_ROUTES.includes(r))
        .filter((r) => {
          const [method, pattern] = r.split(' ');
          return !doc.paths[pattern!.replace(/:(\w+)/g, '{$1}')]?.[method!.toLowerCase()];
        });
      expect(missing).toEqual([]);

      const served = await call(cloud, 'GET', '/openapi.json');
      expect(served.status).toBe(200);
      expect(served.json.servers).toEqual([{ url: cloud.url }]);
      expect(served.json.paths['/v1/suggestions'].post).toBeDefined();
    } finally {
      await cloud.close();
    }
  });
});
