import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/.turbo/**', '**/.wrangler/**', '**/dist/**', '**/build/**', '**/.expo/**'] },
  {
    files: ['apps/**/*.{ts,tsx}', 'packages/**/*.{ts,tsx}', 'tests/**/*.ts', 'vitest.config.mts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
  },
);
