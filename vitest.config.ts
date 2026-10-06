import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// Vitest does not load .env on its own. Load it so TEST_DATABASE_URL is honoured;
// variables already set in the environment win (loadEnvFile never overrides them).
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    globalSetup: ['src/test/global-setup.ts'],
    // Integration tests share one Postgres database and truncate it between tests,
    // so test files run one at a time.
    fileParallelism: false,
    restoreMocks: true,
  },
});
