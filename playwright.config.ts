import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: ['**/e2e/**/*.spec.ts', '**/storage/**/*.spec.ts'],
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 2,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    {
      name: 'mobile-chromium',
      testIgnore: '**/cross-browser.spec.ts',
      use: { ...devices['Pixel 7'] },
    },
  ],
  webServer: [
    {
      command: 'pnpm --filter @meshdrop/signaling dev',
      url: 'http://127.0.0.1:8787/health',
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'pnpm --filter @meshdrop/web dev',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: !process.env.CI,
    },
  ],
});
