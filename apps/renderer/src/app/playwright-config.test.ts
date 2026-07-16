import { describe, expect, it } from 'vitest';
import config from '../../../../playwright.config';

describe('Playwright e2e server config', () => {
  it('starts a fresh local renderer server instead of blindly reusing a fixed port', () => {
    const webServer = Array.isArray(config.webServer)
      ? config.webServer[0]
      : config.webServer;

    expect(webServer?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(webServer?.reuseExistingServer).toBe(false);
  });

  it('writes a scan-friendly report artifact instead of a self-contained HTML bundle', () => {
    expect(config.reporter).toContainEqual([
      './tests/e2e/helpers/safe-json-reporter.mjs',
      { outputFile: 'playwright-report/results.json' },
    ]);
    expect(config.reporter).not.toContainEqual([
      'html',
      expect.any(Object),
    ]);
  });
});
