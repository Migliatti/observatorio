import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.unit.test.ts', 'src/**/*.integration.test.ts', 'src/api/config.test.ts'],
    fileParallelism: false,
    isolate: false,
    restoreMocks: true,
    testTimeout: 25_000,
  },
});
