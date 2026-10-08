// @ts-check
const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: 'test/e2e',
  timeout: 60000,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:3300', launchOptions: { executablePath: process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium' } },
  webServer: { command: 'node test/support/dev-server.js', url: 'http://127.0.0.1:3300/api/scenarios', reuseExistingServer: false, env: { PORT: '3300', E2E_TIMEOUT_MS: '1500' } },
});
