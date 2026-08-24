import { test, expect } from './helpers/e2e-test';
import { captureLayoutScreenshot, e2eState, openEmptyApp } from './helpers/app';

test('starts empty and activates modules exactly once by double click and drag', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await openEmptyApp(page);

  expect(await e2eState(page)).toMatchObject({ commitCount: 0, edgeCount: 0, moduleTypes: [], projectNodeTypes: [] });
  await expect(page.getByText('双击空白处添加模块')).toBeVisible();
  await expect(page.getByTestId('module-library')).toBeHidden();
  await expect(page.getByTestId('agent-panel')).toBeHidden();
  await captureLayoutScreenshot(page, testInfo, 'task-2-empty-light-1366x768');

  await page.getByTestId('tool-modules').click();
  const search = page.getByRole('searchbox', { name: '搜索模块' });
  await search.fill('提示词');
  const promptModule = page.getByRole('button', { name: '查看 文本提示词 / Text Prompt' });
  await promptModule.click();
  await expect(page.getByRole('region', { name: '模块详情' })).toBeVisible();
  expect((await e2eState(page)).commitCount).toBe(0);

  await promptModule.dblclick();
  await expect(page.locator('[data-module-type="text_prompt"]')).toHaveCount(1);
  await expect.poll(async () => (await e2eState(page)).commitCount).toBe(1);

  await search.fill('Image Input');
  const imageInputModule = page.getByRole('button', { name: /^查看 .*Image Input$/ });
  const pane = page.locator('.react-flow__pane');
  await imageInputModule.dragTo(pane, { targetPosition: { x: 700, y: 420 } });
  await expect(page.locator('[data-module-type="image_input"]')).toHaveCount(1);
  await expect.poll(async () => (await e2eState(page)).commitCount).toBe(2);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => localStorage.setItem('novus.theme.mode', 'dark'));
  await page.reload();
  await page.waitForFunction((nonce) => window.__NOVUS_E2E__?.nonce === nonce, process.env.NOVUS_E2E_NONCE);
  await page.evaluate(() => window.__NOVUS_E2E__!.resetEmpty());
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByText('双击空白处添加模块')).toBeVisible();
  await captureLayoutScreenshot(page, testInfo, 'task-2-empty-dark-1440x900');
});
