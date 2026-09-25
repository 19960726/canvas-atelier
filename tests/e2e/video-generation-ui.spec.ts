import { expect, test } from './helpers/e2e-test';
import {
  captureLayoutScreenshot,
  e2eState,
  openEmptyApp,
  queueProjectImageImport,
  queueProjectVideoImport,
} from './helpers/app';
import { makeReferenceImage } from './helpers/fixtures';

const viewports = [
  { name: '1366x768', width: 1366, height: 768 },
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1920x1080', width: 1920, height: 1080 },
];

for (const viewport of viewports) {
for (const theme of ['dark', 'light'] as const) {
  test(`video generation exposes one media socket that accepts an image in ${theme} at ${viewport.name}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.addInitScript((nextTheme) => localStorage.setItem('novus.theme.mode', nextTheme), theme);
    await openEmptyApp(page);
    await page.evaluate(async () => {
      await window.__NOVUS_E2E__.createModule('image_input', { x: 80, y: 180 });
      await window.__NOVUS_E2E__.createModule('video_generation', { x: 460, y: 180 });
    });

    const generation = page.locator('[data-module-type="video_generation"]');
    const source = page.locator('[data-module-type="image_input"] [data-port-id="image"].react-flow__handle');
    const target = generation.locator('[data-port-id="media"].react-flow__handle');
    const result = generation.locator('[data-port-id="result"].react-flow__handle');
    await expect(generation.locator('[data-port-direction="input"] .react-flow__handle')).toHaveCount(1);
    const [generationBox, targetBox, resultBox] = await Promise.all([
      generation.boundingBox(),
      target.boundingBox(),
      result.boundingBox(),
    ]);
    expect(generationBox).not.toBeNull();
    expect(targetBox).not.toBeNull();
    expect(resultBox).not.toBeNull();
    const videoPreviewRailY = generationBox!.y + (208 / 720) * generationBox!.height;
    expect(
      Math.abs(targetBox!.y + targetBox!.height / 2 - videoPreviewRailY),
      'Canvas 332:2 anchors the video media socket on the preview rail, not the card midpoint.',
    ).toBeLessThanOrEqual(14);
    expect(
      Math.abs(resultBox!.y + resultBox!.height / 2 - videoPreviewRailY),
      'Canvas 332:2 keeps the video result socket on the same preview rail as the media input.',
    ).toBeLessThanOrEqual(14);
    await source.dragTo(target);
    await expect.poll(async () => (await e2eState(page)).edgeCount).toBe(1);
    const mediaTray = generation.getByLabel('Connected video media');
    await expect(mediaTray).toBeVisible();
    await expect(mediaTray).toHaveCSS('width', '614px');
    await expect(mediaTray).toHaveCSS('height', '54px');
    const pendingSlot = mediaTray.getByLabel('Video preview reference slot pending');
    await expect(pendingSlot).toHaveCSS('width', '36px');
    await expect(pendingSlot).toHaveCSS('height', '36px');
    await expect(mediaTray.locator('.module-node__connected-video-media-source')).toHaveCount(0);
    await expect(mediaTray.locator('.module-node__reference-slots--inline')).toHaveCount(0);
    await expect(pendingSlot.getByLabel('图槽编号 1')).toHaveText('1');
    await expect(mediaTray.getByText('+')).toHaveCount(0);
    await expect(mediaTray.getByText('Connected media pending')).toHaveCount(0);
    await captureLayoutScreenshot(page, testInfo, `video-media-image-${theme}-${viewport.name}`);
  });

  test(`video generation exposes one media socket that accepts a video in ${theme} at ${viewport.name}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.addInitScript((nextTheme) => localStorage.setItem('novus.theme.mode', nextTheme), theme);
    await openEmptyApp(page);
    await page.evaluate(async () => {
      await window.__NOVUS_E2E__.createModule('video_input', { x: 80, y: 180 });
      await window.__NOVUS_E2E__.createModule('video_generation', { x: 460, y: 180 });
    });

    const generation = page.locator('[data-module-type="video_generation"]');
    const source = page.locator('[data-module-type="video_input"] [data-port-id="video"].react-flow__handle');
    const target = generation.locator('[data-port-id="media"].react-flow__handle');
    await expect(generation.locator('[data-port-direction="input"] .react-flow__handle')).toHaveCount(1);
    await source.dragTo(target);
    await expect.poll(async () => (await e2eState(page)).edgeCount).toBe(1);
    await captureLayoutScreenshot(page, testInfo, `video-media-video-${theme}-${viewport.name}`);
  });

  test(`keeps image and video sockets on their Canvas source and preview rails in ${theme} at ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.addInitScript((nextTheme) => localStorage.setItem('novus.theme.mode', nextTheme), theme);
    await openEmptyApp(page);
    await page.evaluate(async () => {
      await window.__NOVUS_E2E__.createModule('image_input', { x: 80, y: 228 });
      await window.__NOVUS_E2E__.createModule('video_generation', { x: 460, y: 85 });
    });

    const image = page.locator('[data-module-type="image_input"]');
    const video = page.locator('[data-module-type="video_generation"]');
    const importButton = image.getByRole('button', { name: 'Import image' });
    const source = image.locator('[data-port-id="image"].react-flow__handle');
    const target = video.locator('[data-port-id="media"].react-flow__handle');
    await expect(image).toHaveCSS('width', '292px');
    await expect(image).toHaveCSS('height', '326px');
    await expect(image.locator('.module-node__footer')).toBeHidden();
    await expect(importButton).toHaveCSS('border-top-style', 'solid');
    const [imageBox, videoBox, importBox, sourceBox, targetBox] = await Promise.all([
      image.boundingBox(),
      video.boundingBox(),
      importButton.boundingBox(),
      source.boundingBox(),
      target.boundingBox(),
    ]);
    expect(imageBox).not.toBeNull();
    expect(videoBox).not.toBeNull();
    expect(importBox).not.toBeNull();
    expect(sourceBox).not.toBeNull();
    expect(targetBox).not.toBeNull();
    expect(importBox!.x).toBeGreaterThanOrEqual(imageBox!.x);
    expect(importBox!.y).toBeGreaterThanOrEqual(imageBox!.y);
    expect(importBox!.x + importBox!.width).toBeLessThanOrEqual(imageBox!.x + imageBox!.width);
    expect(importBox!.y + importBox!.height).toBeLessThanOrEqual(imageBox!.y + imageBox!.height);
    expect(Math.abs((sourceBox!.y + sourceBox!.height / 2) - (imageBox!.y + imageBox!.height / 2))).toBeLessThanOrEqual(2);
    expect(Math.abs((targetBox!.y + targetBox!.height / 2) - (videoBox!.y + videoBox!.height * 0.288889))).toBeLessThanOrEqual(14);
    await source.dragTo(target);
    await expect.poll(async () => (await e2eState(page)).edgeCount).toBe(1);
  });

  test(`video generation keeps completed results inside the generation card in ${theme} at ${viewport.name}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.addInitScript((nextTheme) => localStorage.setItem('novus.theme.mode', nextTheme), theme);
    await openEmptyApp(page);
  await page.evaluate(async () => {
    await window.__NOVUS_E2E__.createModule('image_input', { x: 1100, y: 1100 });
    await window.__NOVUS_E2E__.createModule('video_generation', { x: 100, y: 112 });
    });
    await queueProjectImageImport(page, makeReferenceImage('Video result poster.png', [20, 132, 108, 255]));
    await page.locator('[data-module-type="image_input"]').getByRole('button', { name: /Import image/u }).click();
    const posterAssetId = (await e2eState(page)).projectImages.at(-1)!.assetId;
    await page.evaluate(async (posterAssetId) => {
      await window.__NOVUS_E2E__.configureModule('video_generation', {
        config: {
          resultState: 'fresh',
          videoResults: [
            { assetId: 'video-result-1', mediaType: 'video/mp4', durationMs: 5000, posterAssetId },
            { assetId: 'video-result-2', mediaType: 'video/mp4', durationMs: 8000, posterAssetId },
          ],
        },
        execution: { state: 'completed' },
      });
    }, posterAssetId);

    const generation = page.locator('[data-module-type="video_generation"]');
    await expect(page.locator('[data-module-type="video_result"]')).toHaveCount(0);
    await expect(generation.getByLabel('Video generation preview')).toBeVisible();
    await expect(generation.getByLabel(/^Generated video preview \d+$/u)).toHaveCount(2);
    await expect(generation.getByRole('img', { name: 'Generated video preview 1' })).toBeVisible();
    await expect(generation.getByRole('img', { name: 'Generated video preview 2' })).toBeVisible();
    await expect(generation.locator('[data-port-id="result"].react-flow__handle')).toBeVisible();
    await captureLayoutScreenshot(page, testInfo, `video-results-inline-${theme}-${viewport.name}`);
  });
  test(`video generation uses the collapsed card and detached preview with aligned composer in ${theme} at ${viewport.name}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.addInitScript((nextTheme) => localStorage.setItem('novus.theme.mode', nextTheme), theme);
    await openEmptyApp(page);
    await page.evaluate(async () => {
      await window.__NOVUS_E2E__.createModule('video_generation', { x: 100, y: 112 });
    });

    const videoNode = page.locator('[data-module-type="video_generation"]');
    await expect(videoNode).toHaveCSS('width', '654px');
    await expect(videoNode).toHaveCSS('height', '486px');
    await expect(videoNode.getByLabel('Video generation preview')).toBeVisible();
    await expect(videoNode.getByLabel('Video generation composer')).toHaveCount(0);

    const viewportTransformBefore = await page.locator('.react-flow__viewport').evaluate((element) => getComputedStyle(element).transform);
    await videoNode.getByRole('button', { name: 'Open video generation editor' }).click();
    await expect(videoNode).toHaveCSS('width', '704px');
    await expect(videoNode).toHaveCSS('height', '742px');
    await expect(videoNode.getByLabel('Video generation composer')).toBeVisible();
    const preview = videoNode.locator('.module-node__result');
    const media = videoNode.getByLabel('Connected video media editor', { exact: true });
    const prompt = videoNode.getByLabel('Video preview prompt workspace');
    const controls = videoNode.getByLabel('Video preview parameter controls');
    await expect(preview).toHaveCSS('width', '676px');
    await expect(preview).toHaveCSS('height', '380px');
    for (const rail of [media, prompt, controls]) {
      await expect(rail).toBeVisible();
      await expect(rail).toHaveCSS('width', '702px');
    }
    const [previewBox, mediaBox, promptBox, controlsBox] = await Promise.all(
      [preview, media, prompt, controls].map((locator) => locator.boundingBox()),
    );
    expect(previewBox).not.toBeNull();
    expect(mediaBox).not.toBeNull();
    expect(promptBox).not.toBeNull();
    expect(controlsBox).not.toBeNull();
    expect(Math.abs(previewBox!.x + previewBox!.width / 2 - (mediaBox!.x + mediaBox!.width / 2))).toBeLessThanOrEqual(1);
    expect(mediaBox!.y - (previewBox!.y + previewBox!.height)).toBeCloseTo(0, 0);
    expect(Math.abs(mediaBox!.x - promptBox!.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(promptBox!.x - controlsBox!.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(mediaBox!.y + mediaBox!.height - promptBox!.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(promptBox!.y + promptBox!.height - controlsBox!.y)).toBeLessThanOrEqual(1);
    const runButton = videoNode.locator('.module-node__run-generation');
    const settingsTrigger = videoNode.getByRole('button', { name: '打开视频参数设置' });
    const settingsSummary = settingsTrigger.locator('.module-node__video-settings-summary');
    const composer = videoNode.getByLabel('Video generation composer');
    await expect(runButton).toBeVisible();
    await expect(settingsTrigger).toContainText(/· \d+s · \d个/u);
    const summaryMetrics = await settingsSummary.evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
    expect(summaryMetrics.scrollWidth).toBeLessThanOrEqual(summaryMetrics.clientWidth + 1);
    const [composerBox, runBox] = await Promise.all([composer.boundingBox(), runButton.boundingBox()]);
    expect(composerBox).not.toBeNull();
    expect(runBox).not.toBeNull();
    expect(runBox!.width).toBeLessThanOrEqual(92);
    expect(runBox!.height).toBe(34);
    expect(runBox!.x).toBeGreaterThanOrEqual(composerBox!.x);
    expect(runBox!.x + runBox!.width).toBeLessThanOrEqual(composerBox!.x + composerBox!.width);
    expect(await page.locator('.react-flow__viewport').evaluate((element) => getComputedStyle(element).transform)).toBe(viewportTransformBefore);

    await page.locator('.react-flow__pane').click({ position: { x: 8, y: 8 } });
    await expect(videoNode.getByLabel('Video generation composer')).toHaveCount(0);
    expect(await page.locator('.react-flow__viewport').evaluate((element) => getComputedStyle(element).transform)).toBe(viewportTransformBefore);

    await videoNode.getByRole('button', { name: 'Open video generation editor' }).click();
    await expect(videoNode.getByLabel('Video generation composer')).toBeVisible();
    await captureLayoutScreenshot(page, testInfo, `video-generation-${theme}-${viewport.name}`);
  });

  test(`video generation keeps one teal selected border without a second focus halo in ${theme} at ${viewport.name}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.addInitScript((nextTheme) => localStorage.setItem('novus.theme.mode', nextTheme), theme);
    await openEmptyApp(page);
    await page.evaluate(async () => {
      await window.__NOVUS_E2E__.createModule('video_generation', { x: 100, y: 112 });
    });

    const videoNode = page.locator('[data-module-type="video_generation"]');
    await videoNode.locator('.module-node__header').click();
    await videoNode.evaluate((element) => {
      const flowNode = element.closest('.react-flow__node') as HTMLElement | null;
      flowNode?.focus();
    });

    await expect(videoNode).toHaveClass(/is-selected/u);
    await expect(videoNode).toHaveCSS('border-top-color', 'rgb(24, 169, 153)');
    await expect(videoNode).toHaveCSS('border-top-style', 'solid');
    await expect(videoNode).toHaveCSS('outline-style', 'none');
    await expect(videoNode).toHaveCSS('box-shadow', 'none');
    await captureLayoutScreenshot(page, testInfo, `video-generation-focus-${theme}-${viewport.name}`);
  });
}
}

test('a completed video remains inside its source node after reload without an external result node', async ({ page }) => {
  await openEmptyApp(page);
  await page.evaluate(async () => {
    await window.__NOVUS_E2E__!.createModule('video_input', { x: 240, y: 112 });
    await window.__NOVUS_E2E__!.createModule('video_generation', { x: 620, y: 112 });
  });

  await queueProjectVideoImport(page, { label: 'Generated result.mp4' });
  await page.locator('[data-module-type="video_input"]').getByRole('button', { name: /Import video/u }).click();
  const videoAsset = (await e2eState(page)).projectVideos[0];
  expect(videoAsset).toBeDefined();
  await page.evaluate(async (assetId) => {
    await window.__NOVUS_E2E__!.configureModule('video_generation', {
      config: {
        resultState: 'fresh',
        videoResults: [{ assetId, durationMs: 5000, mediaType: 'video/mp4' }],
      },
      execution: { state: 'completed' },
    });
  }, videoAsset!.assetId);

  const videoNode = page.locator('[data-module-type="video_generation"]');
  await expect(videoNode.locator('video')).toHaveAttribute('src', videoAsset!.displayUrl);
  expect((await e2eState(page)).projectAssetIds).toContain(videoAsset!.assetId);
  await expect(page.locator('[data-module-type="video_result"]')).toHaveCount(0);

  await page.evaluate(() => window.__NOVUS_E2E__!.reopenProject());
  await expect(page.locator('[data-module-type="video_generation"] video')).toHaveAttribute('src', videoAsset!.displayUrl);
  await expect(page.locator('[data-module-type="video_result"]')).toHaveCount(0);
});

for (const viewport of viewports) {
for (const theme of ['dark', 'light'] as const) {
test(`captures completed video posters inside the generation card in ${theme} at ${viewport.name}`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: viewport.width, height: 1600 });
  await page.addInitScript((nextTheme) => localStorage.setItem('novus.theme.mode', nextTheme), theme);
  await openEmptyApp(page);
  await page.evaluate(async () => {
    await window.__NOVUS_E2E__.createModule('image_input', { x: 80, y: 228 });
    for (let index = 0; index < 4; index += 1) {
      await window.__NOVUS_E2E__.createModule('video_input', { x: 1200, y: 40 + index * 300 });
    }
    await window.__NOVUS_E2E__.createModule('video_generation', { x: 460, y: 85 });
  });
  await queueProjectImageImport(page, makeReferenceImage('video-poster.png', [20, 132, 108, 255], { width: 1280, height: 720 }));
  await page.locator('[data-module-type="image_input"]').getByRole('button', { name: /Import image/u }).click();
  const poster = (await e2eState(page)).projectImages[0];
  expect(poster?.assetId).toBeTruthy();
  expect(poster?.displayUrl).toBeTruthy();

  const videoInputs = page.locator('[data-module-type="video_input"]');
  const importedVideos: Array<{ assetId: string; displayUrl: string }> = [];
  for (let index = 0; index < 4; index += 1) {
    await queueProjectVideoImport(page, { label: `Completed result fixture ${index + 1}.mp4` });
    await videoInputs.nth(index).getByRole('button', { name: /Import video/u }).click();
    const importedVideo = (await e2eState(page)).projectVideos.at(-1);
    expect(importedVideo?.assetId).toBeTruthy();
    expect(importedVideo?.displayUrl).toBeTruthy();
    importedVideos.push(importedVideo!);
  }

  const imageNode = page.locator('[data-module-type="image_input"]');
  const videoNode = page.locator('[data-module-type="video_generation"]');
  await imageNode.locator('[data-port-id="image"].react-flow__handle').dragTo(videoNode.locator('[data-port-id="media"].react-flow__handle'));
  await expect.poll(async () => (await e2eState(page)).edgeCount).toBe(1);
  await page.evaluate(async ({ posterAssetId, posterUrl, videoAssetIds }) => {
    await window.__NOVUS_E2E__.configureModule('video_generation', {
      config: {
        resultState: 'fresh',
        videoResults: Array.from({ length: 4 }, (_, index) => ({
          assetId: videoAssetIds[index],
          mediaType: 'video/mp4',
          durationMs: 5000 + index * 1000,
          posterAssetId,
          posterUrl,
        })),
      },
      execution: { state: 'completed' },
    });
  }, { posterAssetId: poster!.assetId, posterUrl: poster!.displayUrl, videoAssetIds: importedVideos.map((video) => video.assetId) });
  await page.setViewportSize({ width: viewport.width, height: viewport.height });

  await expect(page.locator('[data-module-type="video_result"]')).toHaveCount(0);
  await expect(videoNode.getByLabel('Video generation preview')).toBeVisible();
  await expect(videoNode.getByRole('img', { name: /^Generated video preview \d+$/u })).toHaveCount(4);
  await expect(videoNode.getByLabel('Connected video media')).toHaveCount(0);

  await videoNode.getByRole('button', { name: 'Open video generation editor' }).click();
  await expect(videoNode.getByLabel('Video generation composer')).toBeVisible();
  await expect(videoNode.getByLabel('Connected video media editor').locator('img')).toBeVisible();
  await expect(videoNode.getByLabel('Video preview prompt workspace')).toBeVisible();
  await expect(videoNode.getByLabel('Video preview parameter controls')).toBeVisible();
  await expect(videoNode.getByText('正在加载返回视频')).toHaveCount(0);
  const gallery = videoNode.getByLabel('Completed video results');
  const galleryColumns = await gallery.evaluate((element) => getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/u).length);
  expect(galleryColumns, 'Four completed videos should be shown as a fixed two-column by two-row gallery.').toBe(2);
  await page.setViewportSize({ width: viewport.width, height: Math.max(viewport.height, 920) });
  await videoInputs.evaluateAll((nodes) => nodes.forEach((node) => { (node as HTMLElement).style.visibility = 'hidden'; }));
  await page.screenshot({ path: testInfo.outputPath(`video-generation-completed-${theme}-${viewport.name}.png`), fullPage: true });
});
}
}
