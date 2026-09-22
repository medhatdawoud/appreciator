import { defineConfig, devices } from '@playwright/test';

import { API_ORIGIN, PAGE_ORIGIN } from './test/e2e/constants.js';

export default defineConfig({
  testDir: 'test/e2e',
  testMatch: '**/*.spec.ts',
  // Every test shares one API server and one visitor allowance per item, so
  // they run one at a time and each picks a unique item.
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: PAGE_ORIGIN,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run build && npx tsx test/e2e/server.ts',
    url: `${API_ORIGIN}/healthz`,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 120_000,
  },
});
