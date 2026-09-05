import { expect, test } from './helpers/e2e-test';
import { e2eState, openEmptyApp, waitForModelSubmissions } from './helpers/app';

test('Generate video submits the selected model job and exposes a running state', async ({ page }) => {
  await page.setViewportSize({ width: 1680, height: 1050 });
  await openEmptyApp(page);
  await page.evaluate(() => window.__NOVUS_E2E__!.createModule('video_generation', { x: 420, y: 140 }));

  const generation = page.locator('[data-module-type="video_generation"]');
  await expect(generation).toBeVisible();
  await generation.getByRole('button', { name: 'Open video generation editor' }).click();
  await generation.getByRole('textbox', { name: 'Video preview prompt' }).fill('A slow cinematic product orbit');

  // The custom model trigger is the visible control. Keep the native select as
  // the semantic value source without asking Playwright to treat it as visible.
  const route = generation.locator('select[aria-label="Video preview model"]');
  await expect(route).toBeAttached();
  await expect(route).toBeEnabled();
  const selectedRoute = await route.inputValue();
  expect(selectedRoute).not.toBe('');

  await generation.getByRole('button', { name: '生成视频' }).click();

  const state = await waitForModelSubmissions(page, 1);
  expect(state.modelSubmissions[0]).toMatchObject({ modelRoute: selectedRoute, retryCount: 0 });
  expect(state.modelJobs[0]?.status).toMatch(/submitting|running/);
  expect((await e2eState(page)).modelJobs).toHaveLength(1);
});
