/**
 * Minimal SQL migration runner: applies pending `migrations/*.sql` in lexical order inside one
 * transaction, recording applied names in `schema_migrations`. A transaction-scoped advisory lock
 * makes concurrent server starts safe.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

const LOCK_ID = 7_314_002_211; // arbitrary, fits in bigint

export async function migrate(pool: pg.Pool, dir = MIGRATIONS_DIR): Promise<string[]> {
  const files = readdirSync(dir)
    .filter((f) => /^\d+_[\w-]+\.sql$/.test(f))
    .sort();
  const applied: string[] = [];
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('select pg_advisory_xact_lock($1)', [LOCK_ID]);
    await client.query(
      'create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())',
    );
    const done = new Set(
      (await client.query<{ name: string }>('select name from schema_migrations')).rows.map((r) => r.name),
    );
    for (const file of files) {
      if (done.has(file)) continue;
      await client.query(readFileSync(`${dir}/${file}`, 'utf8'));
      await client.query('insert into schema_migrations (name) values ($1)', [file]);
      applied.push(file);
    }
    await client.query('commit');
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  return applied;
}
