import { availableParallelism } from 'node:os';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Each worker spawns real git processes; cap workers so the git and desktop suites can run
    // side by side (turbo) without starving each other into timeouts.
    maxWorkers: Math.max(2, Math.floor(availableParallelism() / 3)),
    include: ['test/**/*.test.ts'],
    // Integration tests spawn many real git processes; under parallel turbo runs on Windows
    // individual tests can take far longer than when run alone (several take 20–35 s locally, and the
    // hosted Windows runner is a few times slower than that).
    testTimeout: process.env.CI ? 180_000 : 60_000,
    hookTimeout: process.env.CI ? 180_000 : 60_000,
    // Spec 15 §7.4 quality gate: `pnpm test:coverage` (turbo task `test:coverage`).
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Re-export barrels, type-only modules and the generated completions table carry no behaviour.
      // (`ops/executors/index.ts` and `repo-create/index.ts` hold real code and stay included.)
      exclude: [
        'src/index.ts',
        'src/askpass/index.ts',
        'src/undo/index.ts',
        'src/service/extras/index.ts',
        'src/service/phase3/index.ts',
        'src/**/types.ts',
        'src/completions.json',
      ],
      thresholds: { lines: 80, statements: 80, functions: 75, branches: 70 },
      reporter: ['text-summary', 'json-summary'],
      reportsDirectory: 'coverage',
    },
  },
});
