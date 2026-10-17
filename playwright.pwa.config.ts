import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/pwa',
  outputDir: './test-results/pwa',
  forbidOnly: Boolean(process.env.CI),
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:4173',
    trace: 'off',
    screenshot: 'off',
  },
  webServer: [
    {
      command:
        'pnpm --filter @meshdrop/signaling exec wrangler dev --port 8788 --persist-to .wrangler/pwa-state --var ALLOWED_ORIGINS:http://127.0.0.1:4173',
      url: 'http://127.0.0.1:8788/health',
      reuseExistingServer: !process.env.CI,
    },
    {
      command:
        'pnpm --filter @meshdrop/web build && pnpm --filter @meshdrop/web preview --port 4173 --strictPort',
      url: 'http://127.0.0.1:4173',
      env: { MESHDROP_SIGNAL_ORIGIN: 'http://127.0.0.1:8788' },
      reuseExistingServer: !process.env.CI,
      timeout: 120000,
    },
  ],
});
