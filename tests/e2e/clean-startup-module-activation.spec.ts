import { test, expect } from './helpers/e2e-test';
import { captureLayoutScreenshot, e2eState, openEmptyApp } from './helpers/app';

test('starts empty and activates modules exactly once by double click and drag', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await openEmptyApp(page);

  expect(await e2eState(page)).toMatchObject({ commitCount: 0, edgeCount: 0, moduleTypes: [], projectNodeTypes: [] });
  await expect(page.getByRole('button', { name: '打开项目' })).toBeVisible();
  await expect(page.getByRole('button', { name: '新建工作流' })).toBeVisible();
  await expect(page.getByText('双击模块')).toBeVisible();
  await captureLayoutScreenshot(page, testInfo, 'task-2-empty-light-1366x768');

  await page.getByRole('button', { name: '双击模块' }).click();
  const search = page.getByRole('searchbox', { name: '搜索模块' });
  await search.fill('提示词');
  const promptModule = page.getByRole('button', { name: '查看 文本提示词 / Text Prompt' });
  await promptModule.click();
  await expect(page.getByRole('region', { name: '模块详情' })).toBeVisible();
  expect((await e2eState(page)).commitCount).toBe(0);

  await promptModule.dblclick();
  await expect(page.locator('[data-module-type="text_prompt"]')).toHaveCount(1);
  await expect.poll(async () => (await e2eState(page)).commitCount).toBe(1);

  await search.fill('openpose');
  const poseModule = page.getByRole('button', { name: '查看 姿态提取 / OpenPose' });
  const pane = page.locator('.react-flow__pane');
  await poseModule.dragTo(pane, { targetPosition: { x: 700, y: 420 } });
  await expect(page.locator('[data-module-type="openpose"]')).toHaveCount(1);
  await expect.poll(async () => (await e2eState(page)).commitCount).toBe(2);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByLabel('主题 Theme').selectOption('dark');
  await page.evaluate(() => window.__NOVUS_E2E__!.resetEmpty());
  await page.getByRole('button', { name: '关闭模块库' }).click();
  await expect(page.getByRole('region', { name: '空白画布操作' })).toBeVisible();
  await captureLayoutScreenshot(page, testInfo, 'task-2-empty-dark-1440x900');
});
