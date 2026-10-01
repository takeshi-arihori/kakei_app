import { defineConfig, devices } from '@playwright/test';

/** 本番Build済みのWeb入口を、専用ローカルServerで検証する設定。 */
const config = defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:3180',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm start --hostname 127.0.0.1 --port 3180',
    url: 'http://127.0.0.1:3180',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});

export default config;
