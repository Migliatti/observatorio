import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/api/config.test.ts',
      'src/api/request-logs.test.ts',
      'src/test/database.test.ts',
    ],
    restoreMocks: true,
  },
});
