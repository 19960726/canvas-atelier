import { test, expect } from './helpers/e2e-test';
import { e2eState, openApp } from './helpers/app';

test('creates and connects executable modules from the library', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: 'Modules' }).click();
  await page.getByRole('searchbox', { name: 'Search modules' }).fill('prompt');
  await page.getByRole('button', { name: 'Add Text Prompt' }).click();
  await page.getByRole('searchbox', { name: 'Search modules' }).fill('generation v1');
  await page.getByRole('button', { name: 'Add Image Generation V1' }).click();

  const edgeCountBeforeConnect = await page.locator('.react-flow__edge').count();
  await expect(page.locator('[data-module-type="text_prompt"]')).toHaveCount(1);
  await expect(page.locator('[data-module-type="image_generation_v1"]')).toHaveCount(1);

  await page.evaluate(() => window.__NOVUS_E2E__?.connectModules(
    'text_prompt',
    'prompt',
    'image_generation_v1',
    'prompt',
  ));

  await expect(page.locator('.react-flow__edge')).toHaveCount(edgeCountBeforeConnect + 1);
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-save-state', 'saved');
});

test('does not persist every pointermove', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: 'Modules' }).click();
  await page.getByRole('searchbox', { name: 'Search modules' }).fill('prompt');
  await page.getByRole('button', { name: 'Add Text Prompt' }).click();
  const before = (await e2eState(page)).commitCount;

  await page.evaluate(() => window.__NOVUS_E2E__?.simulateModuleDrag('text_prompt', 40));

  const after = (await e2eState(page)).commitCount;
  expect(after - before).toBe(1);
});
