import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/**/*.unit.test.ts',
      'src/**/*.integration.test.ts',
      'src/api/config.test.ts',
      'src/api/request-logs.test.ts',
      'src/test/database.test.ts',
    ],
    fileParallelism: false,
    isolate: false,
    testTimeout: 25_000,
    restoreMocks: true,
  },
});
