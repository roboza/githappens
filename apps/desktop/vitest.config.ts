import { availableParallelism } from 'node:os';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Each worker spawns real git processes; cap workers so the git and desktop suites can run
    // side by side (turbo) without starving each other into timeouts.
    maxWorkers: Math.max(2, Math.floor(availableParallelism() / 3)),
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    // Watcher/integration tests spawn git and wait on real file-system events; under the full
    // monorepo run (other packages testing in parallel) real-git suites need generous limits.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
