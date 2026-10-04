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
  const existingPrompt = page.locator('[data-module-type="text_prompt"]').getByRole('textbox', { name: 'Text prompt' });
  expect(await existingPrompt.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return Boolean(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest('.react-flow__node'));
  }), 'The rejected drop must really land on an existing node surface').toBe(true);
  await imageInputModule.dragTo(existingPrompt);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.locator('[data-module-type="image_input"]')).toHaveCount(0);
  expect(await e2eState(page)).toMatchObject({ commitCount: 1, nodeCount: 1, edgeCount: 0, moduleTypes: ['text_prompt'] });

  // A fixed point can become covered by the previously created prompt. Choose
  // an actual unobstructed pane point without moving or hiding that node.
  const drop = await pane.evaluate(element => {
    const rect = element.getBoundingClientRect();
    for (const xFraction of [0.8, 0.9, 0.65]) for (const yFraction of [0.55, 0.7, 0.35]) {
      const point = { x: rect.x + rect.width * xFraction, y: rect.y + rect.height * yFraction };
      const hit = document.elementFromPoint(point.x, point.y);
      if (hit && (hit === element || hit.closest('.react-flow__pane') === element)
        && !hit.closest('.react-flow__node, .react-flow__handle, .react-flow__edge, .react-flow__controls, .react-flow__minimap, button, input, textarea, select, [data-canvas-surface], [role="dialog"], [role="menu"]')) {
        return { x: point.x - rect.x, y: point.y - rect.y };
      }
    }
    throw new Error('No genuinely empty canvas point is available for the module drop');
  });
  await testInfo.attach('actual-empty-drop-point', { body: JSON.stringify(drop), contentType: 'application/json' });
  await imageInputModule.dragTo(pane, { targetPosition: drop });
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
