import path from 'node:path';
import { test, expect } from './helpers/e2e-test';
import { e2eState, failNextModelJobEnqueue, openEmptyApp, queueProjectImageImport, waitForModelSubmissions } from './helpers/app';
import { makeReferenceImage } from './helpers/fixtures';

const artifact = (name: string) => path.join(process.cwd(), 'artifacts', '2026-08-28-generation-retry', name);

test('Generate image submits the selected model job and exposes a running state', async ({ page }) => {
  await openEmptyApp(page);
  await page.evaluate(() => window.__NOVUS_E2E__!.createModule('image_generation', { x: 420, y: 140 }));

  const generation = page.locator('[data-module-type="image_generation"]');
  await expect(generation).toBeVisible();
  await generation.getByRole('button', { name: 'Open image generation editor' }).click();
  await generation.getByRole('textbox', { name: 'Image generation prompt' }).fill('A clean studio product photograph');

  const route = generation.getByRole('combobox', { name: 'Image generation model route' });
  await expect(route).toBeEnabled();
  const selectedRoute = await route.inputValue();
  expect(selectedRoute).not.toBe('');

  await generation.getByRole('button', { name: 'Generate image' }).click();

  const state = await waitForModelSubmissions(page, 1);
  expect(state.modelSubmissions[0]).toMatchObject({ modelRoute: selectedRoute, retryCount: 0 });
  expect(state.modelJobs[0]?.status).toMatch(/submitting|running/);
  await expect(generation.locator('.module-node__run-generation')).not.toHaveAttribute('aria-label', 'Generate image');
  expect((await e2eState(page)).modelJobs).toHaveLength(1);
});

test('a generation start error exposes a clickable retry that starts the next attempt', async ({ page }) => {
  await openEmptyApp(page);
  await page.evaluate(() => window.__NOVUS_E2E__!.createModule('image_generation', { x: 420, y: 140 }));
  const generation = page.locator('[data-module-type="image_generation"]');
  await generation.getByRole('button', { name: 'Open image generation editor' }).click();
  await generation.getByRole('textbox', { name: 'Image generation prompt' }).fill('A clean studio product photograph');
  await failNextModelJobEnqueue(page);

  await generation.getByRole('button', { name: 'Generate image' }).click();
  const retry = generation.getByRole('button', { name: '重新尝试生成' });
  await expect(retry).toBeVisible();
  await expect(retry).toBeEnabled();
  await generation.screenshot({ path: artifact('generation-retry-light.png') });

  await retry.click();
  await waitForModelSubmissions(page, 1);
  await expect(retry).toHaveCount(0);
  await expect(generation.getByRole('button', { name: '停止生成' })).toBeVisible();
});

test('a collapsed image generation node can be dragged directly from its preview', async ({ page }) => {
  await openEmptyApp(page);
  await page.evaluate(() => window.__NOVUS_E2E__!.createModule('image_generation', { x: 420, y: 140 }));

  const generation = page.locator('[data-module-type="image_generation"]');
  const preview = generation.getByRole('button', { name: 'Open image generation editor' });
  const before = await generation.boundingBox();
  const handle = await preview.boundingBox();
  expect(before).not.toBeNull();
  expect(handle).not.toBeNull();

  await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle!.x + handle!.width / 2 + 120, handle!.y + handle!.height / 2 + 70, { steps: 8 });
  await page.mouse.up();

  const after = await generation.boundingBox();
  expect(after).not.toBeNull();
  expect(after!.x - before!.x).toBeGreaterThan(80);
  expect(after!.x - before!.x).toBeLessThan(180);
  expect(after!.y - before!.y).toBeGreaterThan(40);
  expect(after!.y - before!.y).toBeLessThan(130);
  const state = await e2eState(page);
  const persisted = state.modulePositions.find((node) => node.moduleType === 'image_generation');
  expect(persisted).toBeDefined();
  expect(persisted!.position.x).toBeGreaterThan(500);
  expect(persisted!.position.x).toBeLessThan(600);
  expect(persisted!.position.y).toBeGreaterThan(180);
  expect(persisted!.position.y).toBeLessThan(260);
  expect(await page.getByLabel('Image generation prompt workspace').count()).toBe(0);
  await page.waitForTimeout(500);
  await expect(generation).toBeVisible();
  await expect(generation.getByRole('button', { name: 'Open image generation editor' })).toHaveAttribute('aria-expanded', 'false');
  await page.screenshot({ path: artifact('collapsed-node-direct-drag-light.png'), fullPage: true });
});

test('a collapsed missing-result warning keeps both editor and reload actions clickable without resubmitting', async ({ page }) => {
  await openEmptyApp(page);
  await page.evaluate(async () => {
    await window.__NOVUS_E2E__!.createModule('image_generation', { x: 420, y: 140 });
    await window.__NOVUS_E2E__!.configureModule('image_generation', {
      config: { resultState: 'fresh' },
      execution: { state: 'completed' },
    });
  });

  const generation = page.locator('[data-module-type="image_generation"]');
  const warning = generation.getByRole('alert').filter({ hasText: '返图记录缺失' });
  await expect(warning).toBeVisible();
  await generation.getByRole('button', { name: 'Open image generation editor' }).click();
  await expect(generation.getByLabel('Image generation prompt workspace')).toBeVisible();

  await generation.getByRole('button', { name: '折叠图片生成节点' }).click();
  await expect(warning).toBeVisible();
  const submissionsBeforeReload = (await e2eState(page)).modelSubmissions.length;
  await warning.getByRole('button', { name: '重新加载返图' }).click();
  await expect(warning).toBeVisible();
  expect((await e2eState(page)).modelSubmissions).toHaveLength(submissionsBeforeReload);
});

test('Stop image generation finishes even when provider cancellation never responds', async ({ page }) => {
  await openEmptyApp(page);
  await page.evaluate(() => window.__NOVUS_E2E__!.createModule('image_generation', { x: 420, y: 140 }));

  const generation = page.locator('[data-module-type="image_generation"]');
  await generation.getByRole('button', { name: 'Open image generation editor' }).click();
  await generation.getByRole('textbox', { name: 'Image generation prompt' }).fill('A clean studio product photograph');
  await generation.getByRole('button', { name: 'Generate image' }).click();
  await waitForModelSubmissions(page, 1);
  await expect.poll(async () => (await e2eState(page)).modelJobs[0]?.status).toBe('running');
  await expect(generation.getByRole('button', { name: '停止生成' })).toBeVisible();

  await page.evaluate(() => window.__NOVUS_E2E__!.setModelCancellationMode('hang'));
  await generation.getByRole('button', { name: '停止生成' }).click();

  await expect(generation.getByRole('button', { name: 'Generate image' })).toBeVisible({ timeout: 7_000 });
  await expect.poll(async () => (await e2eState(page)).modelJobs[0]?.status).toBe('cancelled');
});

test('a completed formal image remains inside its source node after reload without an external result node', async ({ page }) => {
  const savedModelRoute = 'comfly-gemini-3-1-flash-image-preview-4k';
  await openEmptyApp(page);
  await page.evaluate(async () => {
    await window.__NOVUS_E2E__!.createModule('image_input', { x: 40, y: 140 });
    await window.__NOVUS_E2E__!.createModule('image_generation', { x: 420, y: 140 });
  });

  await queueProjectImageImport(page, makeReferenceImage('Generated result.png', [42, 126, 168, 255], { width: 1024, height: 1024 }));
  await page.locator('[data-module-type="image_input"]').getByRole('button', { name: /Import image/u }).click();
  const imageAsset = (await e2eState(page)).projectImages[0];
  expect(imageAsset).toBeDefined();
  await page.evaluate(async (assetId) => {
    await window.__NOVUS_E2E__!.configureModule('image_generation', {
      config: {
        modelRoute: 'comfly-gemini-3-1-flash-image-preview-4k',
        modelDisplayName: 'Nano Banana 2',
        resultState: 'fresh',
        resultAssetIds: [assetId],
      },
      execution: { state: 'completed' },
    });
  }, imageAsset!.assetId);

  const imageNode = page.locator('[data-module-type="image_generation"]');
  await imageNode.getByRole('button', { name: 'Open image generation editor' }).click();
  const imageRouteSelect = imageNode.getByRole('combobox', { name: 'Image generation model route' });
  await expect(imageRouteSelect.locator(`option[value="${savedModelRoute}"]`)).toHaveCount(1);
  await expect(imageRouteSelect).toHaveValue(savedModelRoute);
  await expect(imageNode.getByRole('button', { name: 'Generated image 1; double click to preview' }).locator('img'))
    .toHaveAttribute('src', imageAsset!.displayUrl);
  await page.evaluate(() => window.dispatchEvent(new Event('novus:provider-catalog-changed')));
  await expect(imageRouteSelect).toHaveValue(savedModelRoute);
  expect((await e2eState(page)).projectAssetIds).toContain(imageAsset!.assetId);
  await expect(page.locator('[data-module-type="image_result"]')).toHaveCount(0);

  await page.evaluate(() => window.__NOVUS_E2E__!.reopenProject());
  await expect(page.locator('[data-module-type="image_generation"]')
    .getByRole('button', { name: 'Generated image 1; double click to preview' }).locator('img'))
    .toHaveAttribute('src', imageAsset!.displayUrl);
  const reopenedImageNode = page.locator('[data-module-type="image_generation"]');
  const reopenedEditorButton = reopenedImageNode.getByRole('button', { name: 'Open image generation editor' });
  if (await reopenedEditorButton.count() > 0) await reopenedEditorButton.click();
  await expect(reopenedImageNode.getByRole('combobox', { name: 'Image generation model route' })).toHaveValue(savedModelRoute);
  await expect(page.locator('[data-module-type="image_result"]')).toHaveCount(0);
});
