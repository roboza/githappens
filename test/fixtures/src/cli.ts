/**
 * Generate fixture repos.
 *   pnpm fixtures                      # all except the heavy perf fixtures (huge, huge-1m, files-100k, branches-5k)
 *   pnpm fixtures linear branchy       # selected
 *   pnpm fixtures huge --count=1000000 # options are passed to generators
 *   pnpm fixtures --root=/tmp/repos
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FIXTURES, makeFixture, SkipFixture, type FixtureName } from './generators';
import { HEAVY_FIXTURES } from './perf';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flags = Object.fromEntries(
  args
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const [k, v] = a.slice(2).split('=');
      return [k!, v === undefined ? true : Number.isNaN(Number(v)) ? v : Number(v)];
    }),
);
const root = typeof flags.root === 'string' ? path.resolve(flags.root) : path.resolve(here, '..', '.repos');
delete flags.root;

const requested = args.filter((a) => !a.startsWith('--')) as FixtureName[];
const names = requested.length
  ? requested
  : (Object.keys(FIXTURES) as FixtureName[]).filter((n) => !HEAVY_FIXTURES.has(n));

for (const name of names) {
  if (!(name in FIXTURES)) {
    console.error(`Unknown fixture "${name}". Available: ${Object.keys(FIXTURES).join(', ')}`);
    process.exit(1);
  }
  const started = Date.now();
  try {
    const r = makeFixture(name, { root, force: true, options: flags });
    console.log(`✔ ${name.padEnd(22)} ${r.path}  (${Date.now() - started} ms)`);
  } catch (e) {
    if (e instanceof SkipFixture) console.log(`- ${name.padEnd(22)} skipped: ${e.message}`);
    else throw e;
  }
}
