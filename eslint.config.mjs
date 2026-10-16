import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/.agents/**',
      '**/.codex/**',
      '**/.aws/**',
      '**/.meshdrop-artifacts/**',
      '**/dist/**',
      '**/node_modules/**',
      '**/.wrangler/**',
      'playwright-report/**',
      'test-results/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,mjs}'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        crypto: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['**/apps/**'], message: 'Packages must not depend on application code.' },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/protocol/**/*.ts', 'packages/shared-types/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['react', 'react/*', 'cloudflare:*', '@cloudflare/*', 'node:*', '**/apps/**'],
              message: 'Shared contracts must stay independent of React, Node, and Cloudflare.',
            },
          ],
        },
      ],
    },
  },
);
