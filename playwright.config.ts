import { defineConfig } from '@playwright/test';

const port = Number(process.env.NOVUS_E2E_PORT ?? 43127);
const baseURL = `http://127.0.0.1:${port}`;
const edgeExecutablePath = process.env.PLAYWRIGHT_EDGE_EXECUTABLE_PATH
  ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: 'test-results/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
  ],
  webServer: {
    command: `npm run dev -w @agent-canvas/renderer -- --host 127.0.0.1 --port ${port} --strictPort`,
    env: {
      VITE_NOVUS_E2E_MODE: '1',
    },
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    url: baseURL,
  },
  use: {
    baseURL,
    browserName: 'chromium',
    launchOptions: {
      executablePath: edgeExecutablePath,
    },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    viewport: { width: 1440, height: 900 },
  },
});
