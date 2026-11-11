import fs from 'node:fs';
import { defineConfig } from '@playwright/test';

const chromium = process.env.PW_CHROMIUM || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:3500', launchOptions: { executablePath: chromium } },
  webServer: { command: 'node tests/e2e/server.js', url: 'http://127.0.0.1:3500/api/config', reuseExistingServer: false },
});
