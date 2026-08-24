import path from 'node:path';
import { expect, test } from './helpers/e2e-test';
import { e2eState, openEmptyApp, queueProjectImageImport } from './helpers/app';
import { makeReferenceImage } from './helpers/fixtures';

const artifact = (name: string) => path.join(process.cwd(), 'artifacts', '2026-08-07-canvas-interaction-consolidation', name);

for (const theme of ['light', 'dark'] as const) {
  test(`captures clean collapsed and expanded generation layouts in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.addInitScript((nextTheme) => localStorage.setItem('novus.theme.mode', nextTheme), theme);
    await openEmptyApp(page);
    await page.evaluate(async () => {
      await window.__NOVUS_E2E__.createModule('image_input', { x: 220, y: 260 });
      await window.__NOVUS_E2E__.createModule('video_generation', { x: 720, y: 180 });
      await window.__NOVUS_E2E__.createModule('video_result', { x: 1700, y: 250 });
    });

    await queueProjectImageImport(page, makeReferenceImage('clean-video-reference.png', [34, 166, 142, 255], { width: 1280, height: 720 }));
    const imageNode = page.locator('[data-module-type="image_input"]');
    const videoNode = page.locator('[data-module-type="video_generation"]');
    const videoResult = page.locator('[data-module-type="video_result"]');
    await imageNode.getByRole('button', { name: /Import image/ }).click();
    await imageNode.locator('[data-port-id="image"].react-flow__handle').dragTo(videoNode.locator('[data-port-id="media"].react-flow__handle'));
    await expect.poll(async () => (await e2eState(page)).edgeCount).toBe(1);
    await page.evaluate(async () => {
      await window.__NOVUS_E2E__.configureModule('video_generation', {
        config: { resultState: 'fresh' },
        execution: { state: 'completed' },
      });
    });
    await page.locator('.react-flow__controls-fitview').evaluate((button) => (button as HTMLButtonElement).click());
    await expect(videoNode.getByLabel('Connected video media').locator('img')).toBeVisible();
    await page.screenshot({ path: artifact(`${theme}-canvas-collapsed.png`), fullPage: true });
    if (theme === 'light') await page.screenshot({ path: artifact('image-connected-slot.png'), fullPage: true });

    await videoNode.getByRole('button', { name: 'Open video generation editor' }).click();
    await page.locator('.react-flow__controls-fitview').evaluate((button) => (button as HTMLButtonElement).click());
    await expect(videoNode.getByLabel('Video generation composer')).toBeVisible();
    await expect(videoNode.getByLabel('Connected video media editor').locator('img')).toBeVisible();
    await page.screenshot({ path: artifact(`${theme}-generation-expanded.png`), fullPage: true });

    if (theme === 'dark') {
      const posterAssetId = (await e2eState(page)).projectImages[0]?.assetId;
      expect(posterAssetId).toBeTruthy();
      await page.evaluate(async ({ assetId }) => {
        await window.__NOVUS_E2E__.configureModule('video_generation', {
          config: {
            videoResults: [{
              assetId: 'e2e-generated-video-result-1',
              mediaType: 'video/mp4',
              durationMs: 5000,
              posterAssetId: assetId,
            }],
          },
          execution: { state: 'completed' },
        });
      }, { assetId: posterAssetId! });
      await videoNode.locator('[data-port-id="result"].react-flow__handle').dragTo(videoResult.locator('[data-port-id="video"].react-flow__handle'));
      await expect.poll(async () => (await e2eState(page)).edgeCount).toBe(2);
      await page.locator('.react-flow__controls-fitview').evaluate((button) => (button as HTMLButtonElement).click());
      await expect(videoResult.getByRole('img', { name: 'Video result poster' })).toBeVisible();
      await page.screenshot({ path: artifact('video-connected-slot.png'), fullPage: true });
    }
  });
}