import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/durable-object-runtime.test.ts'],
    environment: 'node',
    pool: 'forks',
    maxWorkers: 2,
    minWorkers: 1,
    clearMocks: true,
    restoreMocks: true,
  },
});
