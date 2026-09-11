import { expect, test } from './helpers/e2e-test';
import { openEmptyApp } from './helpers/app';

test('generated image action opens Agent and inserts a durable visual reference', async ({ page }) => {
  await openEmptyApp(page);
  const seeded = await page.evaluate(async () => {
    await window.__NOVUS_E2E__!.createModule('image_generation', { x: 360, y: 180 });
    return await window.__NOVUS_E2E__!.seedGeneratedImageResult?.() ?? false;
  });
  expect(seeded).toBe(true);

  const node = page.locator('[data-module-type="image_generation"]');
  await node.getByRole('button', { name: 'Open image generation editor' }).click();
  await node.getByRole('button', { name: 'Generated image 1; double click to preview' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '发送到 AI 对话' }).click();

  const panel = page.getByTestId('agent-panel');
  await expect(panel).toBeVisible();
  await expect.poll(() => panel.getByTestId('agent-composer-input').evaluate((element) => (
    (element as HTMLDivElement & { value?: string }).value ?? ''
  ))).toBe('@图片1');
  await expect(panel.getByLabel('Selected image references')).toContainText('Generated result 1');
  await expect(panel.getByTestId('agent-model-trigger')).not.toHaveAttribute('data-selected-model', '未配置');
});
