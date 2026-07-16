import { test as base, expect } from '@playwright/test';

export const test = base.extend<{ collectConsoleAndPageErrors: void }>({
  collectConsoleAndPageErrors: [async ({ page }, use, testInfo) => {
    const messages: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') {
        messages.push(`[console:${message.type()}] ${message.text()}`);
      }
    });
    page.on('pageerror', (error) => {
      messages.push(`[pageerror] ${error.stack ?? error.message}`);
    });
    page.on('requestfailed', (request) => {
      const failure = request.failure();
      messages.push(`[requestfailed] ${request.method()} ${request.url()} ${failure?.errorText ?? 'unknown'}`);
    });

    await use();

    if (testInfo.status !== testInfo.expectedStatus && messages.length > 0) {
      await testInfo.attach('console-page-errors', {
        body: messages.join('\n'),
        contentType: 'text/plain',
      });
    }
  }, { auto: true }],
});

export { expect };
