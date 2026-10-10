import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { migrate } from '../src/store/migrate.ts';
import { PgStore } from '../src/store/pg.ts';
import { PG_URL, startCloud, STORE_KIND } from './helpers.ts';

describe('store selection', () => {
  it(`runs the API suite against the ${STORE_KIND} store`, async () => {
    const cloud = await startCloud();
    try {
      expect(cloud.store.kind).toBe(STORE_KIND);
    } finally {
      await cloud.close();
    }
  });
});

describe.skipIf(!PG_URL)('Postgres migrations', () => {
  it('apply once and are idempotent on restart', async () => {
    const schema = `m_${randomBytes(6).toString('hex')}`;
    const first = await PgStore.open({ connectionString: PG_URL!, schema });
    try {
      const pg = await import('pg');
      const pool = new pg.default.Pool({ connectionString: PG_URL!, options: `-c search_path=${schema}` });
      try {
        expect(await migrate(pool)).toEqual([]); // already applied by open()
        const { rows } = await pool.query('select name from schema_migrations order by name');
        expect(rows.map((r) => r.name)).toEqual(['001_init.sql', '002_suggestions.sql']);
      } finally {
        await pool.end();
      }
      const second = await PgStore.open({ connectionString: PG_URL!, schema });
      await second.close();
    } finally {
      await first.dropSchema(schema);
      await first.close();
    }
  });
});
