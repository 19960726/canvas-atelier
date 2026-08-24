import { test, expect } from './helpers/e2e-test';
import { openEmptyApp } from './helpers/app';

test('generated image menu submits the explicit mocked Photoshop action', async ({ page }) => {
  await openEmptyApp(page);
  const seeded = await page.evaluate(async () => {
    const harness = window.__NOVUS_E2E__ as typeof window.__NOVUS_E2E__ & {
      seedGeneratedImageResult?: () => Promise<boolean>;
    };
    await harness?.createModule('image_generation', { x: 360, y: 180 });
    return await harness?.seedGeneratedImageResult?.() ?? false;
  });
  expect(seeded).toBe(true);

  const node = page.locator('[data-module-type="image_generation"]');
  await node.getByRole('button', { name: 'Open image generation editor' }).click();
  const image = node.getByRole('button', { name: 'Generated image 1; double click to preview' });
  await image.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '导入 Photoshop（智能对象）' }).click();

  await expect(page.getByRole('status').filter({ hasText: '已导入当前 Photoshop 文档' })).toBeVisible();
});
