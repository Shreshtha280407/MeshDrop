import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 15000,
    hookTimeout: 30000,
    maxWorkers: 2,
    projects: [
      { test: { name: 'unit', include: ['tests/unit/**/*.spec.ts'] } },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.spec.ts'],
          hookTimeout: 30000,
        },
      },
      { test: { name: 'faults', include: ['tests/faults/**/*.spec.ts'] } },
    ],
  },
});
