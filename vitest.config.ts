import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 15000,
    hookTimeout: 30000,
    maxWorkers: 2,
    projects: [
      {
        test: {
          name: 'security',
          include: [
            'tests/security/**/*.spec.ts',
            'packages/protocol/tests/fuzz/**/*.spec.ts',
            'packages/recovery/tests/property/**/*.spec.ts',
          ],
        },
      },
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.spec.ts'],
          // The existing diagnostics-history case takes ~3s CPU in isolation.
          // Competing unit workers exceeded its unchanged 5s deadline locally.
          // Keep every case; isolate this project's CPU work instead of relaxing checks.
          maxWorkers: 1,
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.spec.ts'],
          hookTimeout: 30000,
          testTimeout: 15000,
        },
      },
      { test: { name: 'faults', include: ['tests/faults/**/*.spec.ts'] } },
    ],
  },
});
