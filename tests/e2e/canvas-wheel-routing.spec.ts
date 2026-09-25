import type { Page } from '@playwright/test';
import { expect, test } from './helpers/e2e-test';
import { e2eState, openEmptyApp, queueProjectVideoImport } from './helpers/app';

const zoom = (page: Page) => page.locator('.react-flow__viewport').evaluate((element) => new DOMMatrixReadOnly(getComputedStyle(element).transform).a);

test('wheel zoom stays responsive on blank canvas and generated image previews without moving nodes', async ({ page }) => {
  await openEmptyApp(page);
  await page.evaluate(async () => {
    await window.__NOVUS_E2E__!.createModule('image_generation', { x: 180, y: 160 });
    await window.__NOVUS_E2E__!.seedGeneratedImageResult();
  });
  const image = page.locator('[data-module-type="image_generation"]').getByRole('img').first();
  await expect(image).toBeVisible();
  const positions = (await e2eState(page)).modulePositions;

  await page.mouse.move(1250, 600);
  expect(await page.evaluate(() => document.elementFromPoint(1250, 600)?.closest('.react-flow__pane') !== null)).toBe(true);
  const blankZoom = await zoom(page);
  await page.mouse.wheel(0, -120);
  await expect.poll(() => zoom(page)).toBeGreaterThan(blankZoom);

  await image.hover();
  const imageZoom = await zoom(page);
  await page.mouse.wheel(0, -120);
  await expect.poll(() => zoom(page)).toBeGreaterThan(imageZoom);
  await image.hover();
  const enlargedZoom = await zoom(page);
  await page.mouse.wheel(0, 120);
  await expect.poll(() => zoom(page)).toBeLessThan(enlargedZoom);
  expect((await e2eState(page)).modulePositions).toEqual(positions);
});

test('wheel zoom works on video preview surfaces', async ({ page }) => {
  await openEmptyApp(page);
  await page.evaluate(() => window.__NOVUS_E2E__!.createModule('video_generation', { x: 200, y: 160 }));
  const preview = page.getByRole('button', { name: 'Open video generation editor' });
  await preview.hover();
  const before = await zoom(page);
  await page.mouse.wheel(0, -120);
  await expect.poll(() => zoom(page)).toBeGreaterThan(before);
});

test('wheel scroll stays local to prompt editors, option menus and native video controls', async ({ page }) => {
  await openEmptyApp(page);
  await page.evaluate(() => window.__NOVUS_E2E__!.createModule('image_generation', { x: 180, y: 140 }));
  await page.getByRole('button', { name: 'Open image generation editor' }).click();
  const editor = page.getByRole('textbox', { name: 'Image generation prompt' });
  await editor.fill(Array.from({ length: 30 }, (_, index) => `第 ${index + 1} 行提示词`).join('\n'));
  await editor.evaluate((element) => { element.scrollTop = 0; });
  await editor.hover();
  const before = await zoom(page);
  await page.mouse.wheel(0, 180);
  await expect.poll(() => editor.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect(await zoom(page)).toBe(before);

  await page.getByRole('button', { name: 'Image generation aspect ratio', exact: true }).click();
  const menu = page.getByRole('menu', { name: 'Image generation aspect ratio options' });
  await menu.hover();
  await page.mouse.wheel(0, 120);
  await page.waitForTimeout(200);
  expect(await zoom(page)).toBe(before);

  await openEmptyApp(page);
  await page.evaluate(() => window.__NOVUS_E2E__!.createModule('video_input', { x: 180, y: 140 }));
  await queueProjectVideoImport(page, { label: 'Wheel local video' });
  await page.getByRole('button', { name: /Import video/u }).click();
  const video = page.locator('[data-module-type="video_input"] video[controls]');
  await expect(video).toBeVisible();
  const videoBox = await video.boundingBox();
  expect(videoBox).not.toBeNull();
  // The preview has an intentional drag/play overlay. Its bottom strip leaves
  // the real native controls exposed; exercise that control surface directly.
  const controlsPoint = { x: videoBox!.x + videoBox!.width / 2, y: videoBox!.y + videoBox!.height - 12 };
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, controlsPoint)).toBe('VIDEO');
  await page.mouse.move(controlsPoint.x, controlsPoint.y);
  const videoZoom = await zoom(page);
  await page.mouse.wheel(0, -120);
  await page.waitForTimeout(200);
  expect(await zoom(page)).toBe(videoZoom);
  await page.getByRole('button', { name: '播放或暂停视频' }).hover();
  await page.mouse.wheel(0, -120);
  await expect.poll(() => zoom(page)).toBeGreaterThan(videoZoom);
});

test('wheel zoom remains available on low zoom overview node surfaces', async ({ page }) => {
  await openEmptyApp(page);
  await page.evaluate(() => window.__NOVUS_E2E__!.createModule('image_generation', { x: 200, y: 180 }));
  await page.mouse.move(1250, 600);
  await page.mouse.wheel(0, 1000);
  const overview = page.locator('[data-module-type="image_generation"][data-render-detail="overview"]');
  await expect(overview).toBeVisible();
  await overview.hover();
  const before = await zoom(page);
  await page.mouse.wheel(0, -120);
  await expect.poll(() => zoom(page)).toBeGreaterThan(before);
});
