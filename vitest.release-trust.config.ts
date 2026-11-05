import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/release-trust/**/*.spec.ts'],
    maxWorkers: 1,
    testTimeout: 15000,
    hookTimeout: 30000,
  },
});
