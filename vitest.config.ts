import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Process-level isolation: tests mutate PREVIOUSLY_HOME and spawn real
    // processes, so files must not share a process.
    pool: 'forks',
  },
});
