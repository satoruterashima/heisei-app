import { spawnSync } from 'node:child_process';

const command = 'pnpm';
const result = spawnSync(command, [
  '--config.verifyDepsBeforeRun=warn',
  '--filter',
  '@heisei/api',
  'exec',
  'wrangler',
  'deploy',
  '--dry-run',
  '--outdir',
  '.wrangler/build',
], {
  env: {
    ...process.env,
    WRANGLER_SEND_METRICS: 'false',
    WRANGLER_LOG_PATH: '.wrangler/logs',
  },
  shell: process.platform === 'win32',
  stdio: 'inherit',
});

if (result.error) {
  console.error(`build check failed to start: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
