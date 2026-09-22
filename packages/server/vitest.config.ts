import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Integration specs share one MySQL schema and truncate it between tests,
    // so their files must not run in parallel with each other.
    fileParallelism: false,
  },
});
