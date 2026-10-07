import { expect, test } from './helpers/e2e-test';
import { e2eState, openEmptyApp, queueProjectImageImport, queueProjectVideoImport } from './helpers/app';
import { makeReferenceImage } from './helpers/fixtures';
import { installOverviewVideoFixture } from './helpers/overview-video';
import type { Locator, Page } from '@playwright/test';

const expectedVideoPixels = [[240, 74, 71], [65, 181, 122], [79, 128, 223], [226, 180, 72]];

function expectVideoPixels(pixels: readonly number[][]) {
  expect(pixels).toHaveLength(4);
  pixels.forEach((pixel, index) => {
    expect(pixel[3]).toBeGreaterThan(200);
    expectedVideoPixels[index]!.forEach((value, channel) => expect(Math.abs(pixel[channel]! - value)).toBeLessThan(45));
  });
}

async function expectUnstartedVideoFrame(page: Page, media: Locator) {
  const decodeDeadline = Date.now() + 10_000;
  await expect.poll(() => media.evaluate((video: HTMLVideoElement) => ({ ready: video.readyState >= 2, width: video.videoWidth, height: video.videoHeight })), { timeout: 10_000 })
    .toEqual({ ready: true, width: 320, height: 180 });
  const readDecodedFrame = () => media.evaluate((video: HTMLVideoElement) => {
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    context.drawImage(video, 0, 0);
    return {
      paused: video.paused, currentTime: video.currentTime, errorCode: video.error?.code ?? null,
      framePixels: [[0.2, 0.2], [0.8, 0.2], [0.2, 0.8], [0.8, 0.8]].map(([x, y]) => [...context.getImageData(Math.round(canvas.width * x!), Math.round(canvas.height * y!), 1, 1).data]),
    };
  });
  // HAVE_CURRENT_DATA can precede the first drawable video frame after a poster swap.
  await expect.poll(async () => {
    const frame = await readDecodedFrame();
    return frame.framePixels.length === 4 && frame.framePixels.every((pixel, index) => pixel[3]! > 200
      && expectedVideoPixels[index]!.every((value, channel) => Math.abs(pixel[channel]! - value) < 45));
  }, { timeout: Math.max(1, decodeDeadline - Date.now()) }).toBe(true);
  const decoded = await readDecodedFrame();
  expect(decoded).toMatchObject({ paused: true, currentTime: 0, errorCode: null });
  expectVideoPixels(decoded.framePixels);
  const screenshotBytes = await media.locator('..').screenshot();
  const screenshotPixels = await page.evaluate(async encoded => {
    const screenshot = new Image();
    screenshot.src = `data:image/png;base64,${encoded}`;
    await screenshot.decode();
    const canvas = document.createElement('canvas');
    canvas.width = screenshot.naturalWidth;
    canvas.height = screenshot.naturalHeight;
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    context.drawImage(screenshot, 0, 0);
    const scale = Math.min(canvas.width / 320, canvas.height / 180);
    const renderedWidth = 320 * scale;
    const renderedHeight = 180 * scale;
    const left = (canvas.width - renderedWidth) / 2;
    const top = (canvas.height - renderedHeight) / 2;
    return [[0.2, 0.2], [0.8, 0.2], [0.2, 0.8], [0.8, 0.8]].map(([x, y]) => [...context.getImageData(Math.round(left + renderedWidth * x!), Math.round(top + renderedHeight * y!), 1, 1).data]);
  }, screenshotBytes.toString('base64'));
  expectVideoPixels(screenshotPixels);
  return { decoded, screenshotPixels };
}

async function overviewGeometry(page: Page) {
  return page.locator('.module-node[data-render-detail="overview"]').evaluateAll(elements => elements.map(element => ({
    type: element.getAttribute('data-module-type'), width: (element as HTMLElement).offsetWidth, height: (element as HTMLElement).offsetHeight,
    handles: [...element.querySelectorAll('.react-flow__handle')].map(handle => [handle.getAttribute('data-port-id'), handle.getAttribute('data-port-direction')]),
  })));
}

for (const theme of ['light', 'dark'] as const) {
  test(`keeps owned image and video previews in overview mode in ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 2400, height: 1500 });
    await page.addInitScript(theme => localStorage.setItem('novus.theme.mode', theme), theme);
    await openEmptyApp(page);
    const fixture = await installOverviewVideoFixture(page);
    expectVideoPixels(fixture.framePixels);
    await testInfo.attach('real-local-video-fixture', { body: JSON.stringify(fixture, null, 2), contentType: 'application/json' });
    await page.evaluate(async () => {
      await window.__NOVUS_E2E__!.createModule('image_input', { x: 130, y: 130 });
      await window.__NOVUS_E2E__!.createModule('video_input', { x: 530, y: 130 });
      await window.__NOVUS_E2E__!.createModule('canvas_library', { x: 1050, y: 130 });
      await window.__NOVUS_E2E__!.createModule('image_layering', { x: 1550, y: 130 });
      await window.__NOVUS_E2E__!.createModule('image_generation', { x: 130, y: 820 });
      await window.__NOVUS_E2E__!.createModule('result_output', { x: 680, y: 820 });
      await window.__NOVUS_E2E__!.createModule('video_generation', { x: 1200, y: 820 });
      await window.__NOVUS_E2E__!.createModule('video_result', { x: 1900, y: 820 });
    });
    await queueProjectImageImport(page, makeReferenceImage('overview-source.png', [36, 145, 94, 255], { width: 480, height: 600 }), { preservePixels: true });
    await page.locator('[data-module-type="image_input"]').getByRole('button', { name: /Import image/u }).click();
    await queueProjectVideoImport(page, { label: 'overview-source.mp4', byteSize: fixture.byteSize });
    await page.locator('[data-module-type="video_input"]').getByRole('button', { name: /Import video/u }).click();
    const state = await e2eState(page);
    const image = state.projectImages[0]!;
    const video = state.projectVideos[0]!;
    await page.evaluate(async ({ imageId, videoId }) => {
      await window.__NOVUS_E2E__!.configureModule('canvas_library', { config: { assetIds: [imageId] } });
      await window.__NOVUS_E2E__!.configureModule('image_layering', { config: { sourceAssetId: imageId } });
      await window.__NOVUS_E2E__!.configureModule('image_generation', { config: { resultAssetIds: [imageId], resultState: 'fresh' }, execution: { state: 'completed' } });
      await window.__NOVUS_E2E__!.configureModule('video_generation', { config: { videoResults: [{ assetId: videoId, mediaType: 'video/mp4', durationMs: 5000, posterAssetId: imageId }], resultState: 'fresh' }, execution: { state: 'completed' } });
      const modulePath = '/src/app/app-store.ts';
      const { useAppStore } = await import(modulePath);
      const nodes = useAppStore.getState().project.nodes;
      const nodeId = (type: string) => nodes.find(node => node.type === 'module' && node.data.moduleType === type)!.id;
      useAppStore.setState(current => ({ project: { ...current.project, edges: [
        { id: 'overview-image-edge', source: nodeId('image_generation'), target: nodeId('result_output'), sourcePortId: 'result', targetPortId: 'result' },
        { id: 'overview-video-edge', source: nodeId('video_generation'), target: nodeId('video_result'), sourcePortId: 'result', targetPortId: 'video' },
      ] } }));
    }, { imageId: image.assetId, videoId: video.assetId });
    await page.mouse.move(2250, 700);
    await page.mouse.wheel(0, 780);
    const types = ['image_input', 'video_input', 'canvas_library', 'image_layering', 'image_generation', 'result_output', 'video_generation', 'video_result'];
    for (const type of types) await expect(page.locator(`[data-module-type="${type}"]`)).toHaveAttribute('data-render-detail', 'overview');
    const before = await overviewGeometry(page);
    for (const type of ['image_input', 'canvas_library', 'image_layering', 'image_generation', 'result_output', 'video_generation', 'video_result']) {
      const preview = page.locator(`[data-module-type="${type}"] .module-node__overview-media img`);
      await expect(preview).toHaveAttribute('src', image.displayUrl);
      await expect.poll(() => preview.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
    }
    const videoPreview = page.locator('[data-module-type="video_input"] .module-node__overview-media video');
    await expect(videoPreview).toHaveAttribute('src', video.displayUrl);
    expect(await videoPreview.evaluate((element: HTMLVideoElement) => ({ muted: element.muted, controls: element.controls, autoPlay: element.autoplay, preload: element.preload }))).toEqual({ muted: true, controls: false, autoPlay: false, preload: 'metadata' });
    await testInfo.attach('video-input-first-frame', { body: JSON.stringify(await expectUnstartedVideoFrame(page, videoPreview), null, 2), contentType: 'application/json' });
    await page.mouse.wheel(0, 120);
    const after = await overviewGeometry(page);
    expect(after).toEqual(before);
    await page.screenshot({ path: testInfo.outputPath(`overview-managed-media-${theme}.png`) });

    await page.evaluate(async videoId => {
      await window.__NOVUS_E2E__!.configureModule('video_generation', { config: { videoResults: [{ assetId: videoId, mediaType: 'video/mp4', durationMs: 750 }], resultState: 'fresh' } });
    }, video.assetId);
    for (const type of ['video_generation', 'video_result']) {
      const generatedVideo = page.locator(`[data-module-type="${type}"] .module-node__overview-media video`);
      await expect(generatedVideo).toHaveAttribute('src', video.displayUrl);
      await testInfo.attach(`${type}-no-poster-first-frame`, { body: JSON.stringify(await expectUnstartedVideoFrame(page, generatedVideo), null, 2), contentType: 'application/json' });
    }
    expect(await overviewGeometry(page)).toEqual(before);

    await page.evaluate(async ({ imageId, videoId }) => {
      await window.__NOVUS_E2E__!.configureModule('image_generation', { config: { resultAssetIds: [], previousResultAssetIds: [imageId], resultState: 'pending' }, execution: { state: 'running' } });
      await window.__NOVUS_E2E__!.configureModule('video_generation', { config: { videoResults: [], previousVideoResults: [{ assetId: videoId, posterAssetId: imageId, mediaType: 'video/mp4', durationMs: 750 }], resultState: 'pending' }, execution: { state: 'running' } });
    }, { imageId: image.assetId, videoId: video.assetId });
    for (const type of ['image_generation', 'video_generation']) {
      await expect(page.locator(`[data-module-type="${type}"] .module-node__overview-media img`)).toHaveAttribute('src', image.displayUrl);
      await expect(page.locator(`[data-module-type="${type}"] .module-node__overview-surface`)).toHaveAttribute('data-has-result', 'true');
    }
    for (const type of ['result_output', 'video_result']) await expect(page.locator(`[data-module-type="${type}"] .module-node__overview-media`)).toHaveCount(0);
    expect(await overviewGeometry(page)).toEqual(before);
    await page.screenshot({ path: testInfo.outputPath(`overview-retained-history-${theme}.png`) });

    await page.evaluate(async () => {
      const modulePath = '/src/app/app-store.ts';
      const { useAppStore } = await import(modulePath);
      useAppStore.setState(current => ({ project: { ...current.project, assets: [] } }));
    });
    await expect(page.locator('.module-node__overview-media')).toHaveCount(0);
    expect(await overviewGeometry(page)).toEqual(before);
    expect((await e2eState(page)).modelSubmissions).toHaveLength(0);
  });
}
