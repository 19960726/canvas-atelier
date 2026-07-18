import { test, expect } from './helpers/e2e-test';
import { captureLayoutScreenshot, e2eState, openApp, queueProjectImageImport } from './helpers/app';
import { makeReferenceImage } from './helpers/fixtures';

test('creates and connects executable modules from the library', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: 'Modules' }).click();
  await page.getByRole('searchbox', { name: 'Search modules' }).fill('prompt');
  await page.getByRole('button', { name: 'Add Text Prompt' }).click();
  await page.getByRole('searchbox', { name: 'Search modules' }).fill('generation v1');
  await page.getByRole('button', { name: 'Add Image Generation V1' }).click();

  const edgeCountBeforeConnect = (await e2eState(page)).edgeCount;
  await expect(page.locator('[data-module-type="text_prompt"]')).toHaveCount(1);
  await expect(page.locator('[data-module-type="image_generation_v1"]')).toHaveCount(1);

  await page.evaluate(() => window.__NOVUS_E2E__?.connectModules(
    'text_prompt',
    'prompt',
    'image_generation_v1',
    'prompt',
  ));

  await expect.poll(async () => (await e2eState(page)).edgeCount).toBe(edgeCountBeforeConnect + 1);
  await expect(page.locator('.react-flow__edge')).not.toHaveCount(0);
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-save-state', 'saved');
});

test('does not persist every pointermove', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: 'Modules' }).click();
  await page.getByRole('searchbox', { name: 'Search modules' }).fill('prompt');
  await page.getByRole('button', { name: 'Add Text Prompt' }).click();
  await page.getByRole('button', { name: 'Modules' }).click();
  const before = (await e2eState(page)).commitCount;
  const dragHandle = page.locator('[data-module-type="text_prompt"] .module-node__header');
  const box = await dragHandle.boundingBox();
  expect(box).not.toBeNull();

  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  for (let index = 1; index <= 6; index += 1) {
    await page.mouse.move(
      box!.x + box!.width / 2 + index * 8,
      box!.y + box!.height / 2 + index * 5,
      { steps: 2 },
    );
  }

  expect((await e2eState(page)).commitCount).toBe(before);
  await page.mouse.up();
  await expect.poll(async () => (await e2eState(page)).commitCount).toBe(before + 1);
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-save-state', 'saved');
});

test('imports managed module images and persists a searchable ordered canvas library', async ({ page }, testInfo) => {
  await openApp(page);
  await page.evaluate(async () => {
    await window.__NOVUS_E2E__?.createModule('image_input', { x: 180, y: 120 });
    await window.__NOVUS_E2E__?.createModule('upload_image', { x: 500, y: 120 });
    await window.__NOVUS_E2E__?.createModule('canvas_library', { x: 820, y: 120 });
  });

  const imageInput = page.locator('[data-module-type="image_input"]');
  const uploadImage = page.locator('[data-module-type="upload_image"]');
  const canvasLibrary = page.locator('[data-module-type="canvas_library"]');
  await expect(imageInput).toBeVisible();
  await expect(uploadImage).toBeVisible();
  await expect(canvasLibrary).toBeVisible();

  await queueProjectImageImport(page, makeReferenceImage('Product front.png', [20, 132, 108, 255]));
  await imageInput.getByRole('button', { name: 'Import image' }).click();
  await expect(imageInput.getByRole('strong').filter({ hasText: 'Product front' })).toBeVisible();

  await queueProjectImageImport(page, makeReferenceImage('Studio scene.png', [49, 75, 132, 255]));
  await uploadImage.getByRole('button', { name: 'Import image' }).click();
  await expect(uploadImage.getByRole('strong').filter({ hasText: 'Studio scene' })).toBeVisible();

  await canvasLibrary.getByRole('searchbox', { name: 'Search project images' }).fill('scene');
  await expect(canvasLibrary.getByRole('checkbox', { name: 'Select Studio scene' })).toBeVisible();
  await expect(canvasLibrary.getByRole('checkbox', { name: 'Select Product front' })).toHaveCount(0);
  await canvasLibrary.getByRole('searchbox', { name: 'Search project images' }).fill('');
  await canvasLibrary.getByRole('checkbox', { name: 'Select Product front' }).check();
  await canvasLibrary.getByRole('checkbox', { name: 'Select Studio scene' }).check();
  await canvasLibrary.getByRole('button', { name: 'Move Studio scene up' }).click();
  await expect(canvasLibrary.getByText('Reference 1')).toBeVisible();
  await expect(canvasLibrary.getByText('Reference 2')).toBeVisible();

  const state = await e2eState(page);
  expect(state.projectImages.map((asset) => asset.label)).toEqual(['Product front', 'Studio scene']);
  expect(state.projectAssetIds).toEqual(state.projectImages.map((asset) => asset.assetId));
  expect(state.projectImages.every((asset) => asset.displayUrl.includes('/__novus_e2e_asset/'))).toBe(true);
  expect(state.durableProjectContainsTransientImageUrl).toBe(false);
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-save-state', 'saved');
  await captureLayoutScreenshot(page, testInfo, 'renderer-managed-image-library');
});
