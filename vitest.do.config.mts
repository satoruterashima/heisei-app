import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';
import { resolve } from 'node:path';

export default defineWorkersConfig({
  test: {
    include: ['tests/durable-object-runtime.test.ts'],
    pool: '@cloudflare/vitest-pool-workers',
    poolOptions: {
      workers: {
        main: 'apps/api/src/quota-do-worker.ts',
        isolatedStorage: false,
        wrangler: { configPath: resolve('apps/api/wrangler.do-local.json') },
      },
    },
  },
});
