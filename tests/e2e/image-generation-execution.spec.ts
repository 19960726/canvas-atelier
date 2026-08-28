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
      config: { resultState: 'fresh', resultAssetIds: [assetId] },
      execution: { state: 'completed' },
    });
  }, imageAsset!.assetId);

  const imageNode = page.locator('[data-module-type="image_generation"]');
  await imageNode.getByRole('button', { name: 'Open image generation editor' }).click();
  await expect(imageNode.getByRole('button', { name: 'Generated image 1; double click to preview' }).locator('img'))
    .toHaveAttribute('src', imageAsset!.displayUrl);
  expect((await e2eState(page)).projectAssetIds).toContain(imageAsset!.assetId);
  await expect(page.locator('[data-module-type="image_result"]')).toHaveCount(0);

  await page.evaluate(() => window.__NOVUS_E2E__!.reopenProject());
  await expect(page.locator('[data-module-type="image_generation"]')
    .getByRole('button', { name: 'Generated image 1; double click to preview' }).locator('img'))
    .toHaveAttribute('src', imageAsset!.displayUrl);
  await expect(page.locator('[data-module-type="image_result"]')).toHaveCount(0);
});
