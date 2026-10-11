import { defineConfig } from 'vitest/config';

// Property tests run thousands of random DAGs; give them headroom when packages test in parallel.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 120_000,
    // Spec 15 §7.4 quality gate: `pnpm test:coverage` (turbo task `test:coverage`).
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/types.ts'],
      thresholds: { lines: 80, statements: 80, functions: 80, branches: 80 },
      reporter: ['text-summary', 'json-summary'],
      reportsDirectory: 'coverage',
    },
  },
});
