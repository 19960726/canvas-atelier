import { test, expect } from './helpers/e2e-test';
import { captureLayoutScreenshot, e2eState, openApp, openEmptyApp, queueProjectImageImport } from './helpers/app';
import { makeReferenceImage } from './helpers/fixtures';

test('creates and connects executable modules from the library', async ({ page }) => {
  await openApp(page);
  await page.getByTestId('tool-modules').click();
  await page.getByRole('searchbox', { name: '搜索模块' }).fill('prompt');
  await page.getByRole('button', { name: '查看 文本提示词 / Text Prompt' }).dblclick();
  await page.getByRole('searchbox', { name: '搜索模块' }).fill('image generation');
  await page.getByRole('button', { name: '查看 图片生成 / Image Generation' }).dblclick();

  const edgeCountBeforeConnect = (await e2eState(page)).edgeCount;
  await expect(page.locator('[data-module-type="text_prompt"]')).toHaveCount(1);
  await expect(page.locator('[data-module-type="image_generation"]')).toHaveCount(1);

  await page.evaluate(() => window.__NOVUS_E2E__?.connectModules(
    'text_prompt',
    'prompt',
    'image_generation',
    'prompt',
  ));

  await expect.poll(async () => (await e2eState(page)).edgeCount).toBe(edgeCountBeforeConnect + 1);
  await expect(page.locator('.react-flow__edge')).not.toHaveCount(0);
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-save-state', 'saved');
});

test('does not persist every pointermove', async ({ page }) => {
  await openApp(page);
  await page.getByTestId('tool-modules').click();
  await page.getByRole('searchbox', { name: '搜索模块' }).fill('prompt');
  await page.getByRole('button', { name: '查看 文本提示词 / Text Prompt' }).dblclick();
  await page.getByTestId('tool-modules').click();
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
  await imageInput.getByRole('button', { name: '导入图像 / Import image' }).click();
  await expect(imageInput.getByRole('strong').filter({ hasText: 'Product front' })).toBeVisible();

  await queueProjectImageImport(page, makeReferenceImage('Studio scene.png', [49, 75, 132, 255]));
  await uploadImage.getByRole('button', { name: '导入图像 / Import image' }).click();
  await expect(uploadImage.getByRole('strong').filter({ hasText: 'Studio scene' })).toBeVisible();

  await canvasLibrary.getByRole('searchbox', { name: '搜索项目图像 / Search project images' }).fill('scene');
  await expect(canvasLibrary.getByRole('checkbox', { name: '选择 Studio scene / Select Studio scene' })).toBeVisible();
  await expect(canvasLibrary.getByRole('checkbox', { name: '选择 Product front / Select Product front' })).toHaveCount(0);
  await canvasLibrary.getByRole('searchbox', { name: '搜索项目图像 / Search project images' }).fill('');
  await canvasLibrary.getByRole('checkbox', { name: '选择 Product front / Select Product front' }).check();
  await canvasLibrary.getByRole('checkbox', { name: '选择 Studio scene / Select Studio scene' }).check();
  await canvasLibrary.getByRole('button', { name: '上移 Studio scene / Move Studio scene up' }).click();
  await expect(canvasLibrary.getByText('参考 1 / Reference 1')).toBeVisible();
  await expect(canvasLibrary.getByText('参考 2 / Reference 2')).toBeVisible();

  const state = await e2eState(page);
  expect(state.projectImages.map((asset) => asset.label)).toEqual(['Product front', 'Studio scene']);
  expect(state.projectAssetIds).toEqual(state.projectImages.map((asset) => asset.assetId));
  expect(state.projectImages.every((asset) => asset.displayUrl.includes('/__novus_e2e_asset/'))).toBe(true);
  expect(state.durableProjectContainsTransientImageUrl).toBe(false);
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-save-state', 'saved');
  await captureLayoutScreenshot(page, testInfo, 'renderer-managed-image-library');
});

test('keeps landscape portrait and square images as the visual body of their nodes', async ({ page }, testInfo) => {
  await openEmptyApp(page);
  await page.evaluate(async () => {
    await window.__NOVUS_E2E__?.createModule('image_input', { x: 90, y: 70 });
    await window.__NOVUS_E2E__?.createModule('image_input', { x: 420, y: 70 });
    await window.__NOVUS_E2E__?.createModule('upload_image', { x: 750, y: 70 });
  });

  const nodes = page.locator('[data-module-type="image_input"], [data-module-type="upload_image"]');
  await expect(nodes).toHaveCount(3);

  const fixtures = [
    makeReferenceImage('Wide concept.png', [22, 101, 130, 255], { width: 640, height: 360 }),
    makeReferenceImage('Portrait study.png', [126, 66, 112, 255], { width: 360, height: 640 }),
    makeReferenceImage('Square material.png', [158, 108, 42, 255], { width: 512, height: 512 }),
  ];

  for (let index = 0; index < fixtures.length; index += 1) {
    await queueProjectImageImport(page, fixtures[index]!);
    await nodes.nth(index).getByRole('button', { name: '导入图像 / Import image' }).click();
  }

  await expect(nodes.nth(0).getByRole('img', { name: 'Wide concept' })).toBeVisible();
  await expect(nodes.nth(1).getByRole('img', { name: 'Portrait study' })).toBeVisible();
  await expect(nodes.nth(2).getByRole('img', { name: 'Square material' })).toBeVisible();
  await expect.poll(() => nodes.nth(0).getByRole('img', { name: 'Wide concept' }).evaluate((image) => ({
    height: (image as HTMLImageElement).naturalHeight,
    width: (image as HTMLImageElement).naturalWidth,
  }))).toEqual({ height: 360, width: 640 });
  await expect(nodes.nth(0).locator('.module-node__media-frame')).toHaveCSS('aspect-ratio', '640 / 360');
  await expect(nodes.nth(1).locator('.module-node__media-frame')).toHaveCSS('aspect-ratio', '360 / 640');
  await expect(nodes.nth(2).locator('.module-node__media-frame')).toHaveCSS('aspect-ratio', '512 / 512');

  for (let index = 0; index < 3; index += 1) {
    const nodeBox = await nodes.nth(index).boundingBox();
    const mediaBox = await nodes.nth(index).locator('.module-node__media-frame').boundingBox();
    expect(nodeBox).not.toBeNull();
    expect(mediaBox).not.toBeNull();
    expect(mediaBox!.width).toBeGreaterThan(180);
    expect(mediaBox!.height).toBeGreaterThan(110);
    expect(mediaBox!.x).toBeGreaterThanOrEqual(nodeBox!.x);
    expect(mediaBox!.x + mediaBox!.width).toBeLessThanOrEqual(nodeBox!.x + nodeBox!.width + 1);
  }

  await captureLayoutScreenshot(page, testInfo, 'renderer-media-first-image-nodes');
});

test('uses the same media-first hierarchy for image and video input nodes', async ({ page }, testInfo) => {
  await openEmptyApp(page);
  await page.evaluate(async () => {
    await window.__NOVUS_E2E__?.createModule('image_input', { x: 240, y: 140 });
    await window.__NOVUS_E2E__?.createModule('video_input', { x: 620, y: 140 });
  });

  const imageNode = page.locator('[data-module-type="image_input"]');
  const videoNode = page.locator('[data-module-type="video_input"]');
  await queueProjectImageImport(
    page,
    makeReferenceImage('Campaign frame.png', [21, 112, 105, 255], { width: 640, height: 360 }),
  );
  await imageNode.getByRole('button', { name: '导入图像 / Import image' }).click();

  await expect(imageNode.locator('.module-node__media-frame')).toBeVisible();
  await expect(videoNode.locator('.module-node__video-control')).toBeVisible();
  await expect(videoNode.getByText('视频预览')).toBeVisible();
  await expect(videoNode.getByText('MP4 导入尚未接入')).toBeVisible();
  await expect(videoNode.getByText('待配置')).toHaveCount(0);
  await expect.poll(() => imageNode.locator('.module-node__media-meta small').evaluate((element) => (
    Number.parseFloat(getComputedStyle(element).fontSize)
  ))).toBeGreaterThanOrEqual(8);

  const portHandle = imageNode.locator('.module-node__port-row .react-flow__handle').first();
  await expect(portHandle).toBeVisible();
  await expect.poll(() => portHandle.evaluate((element) => {
    const handle = getComputedStyle(element);
    const target = getComputedStyle(element, '::after');
    return {
      height: Number.parseFloat(handle.height) + Math.abs(Number.parseFloat(target.top)) + Math.abs(Number.parseFloat(target.bottom)),
      width: Number.parseFloat(handle.width) + Math.abs(Number.parseFloat(target.left)) + Math.abs(Number.parseFloat(target.right)),
    };
  })).toEqual({ height: 24, width: 24 });
  await expect.poll(() => portHandle.evaluate((element) => (
    (element.closest('.module-node__port-row') as HTMLElement).getBoundingClientRect().height
  ))).toBeGreaterThanOrEqual(24);
  await captureLayoutScreenshot(page, testInfo, 'renderer-media-first-image-video-nodes');
});

test('hand tool pans without moving modules or writing durable history', async ({ page }) => {
  await openEmptyApp(page);
  await page.evaluate(() => window.__NOVUS_E2E__?.createModule('image_input', { x: 360, y: 240 }));
  const node = page.locator('[data-module-type="image_input"]');
  const before = await e2eState(page);
  const box = await node.boundingBox();
  expect(box).not.toBeNull();

  await page.getByTestId('tool-hand').click();
  await expect(page.getByTestId('tool-hand')).toHaveAttribute('aria-pressed', 'true');
  await page.mouse.move(box!.x + box!.width / 2, box!.y + 24);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2 + 90, box!.y + 74, { steps: 6 });
  await page.mouse.up();

  const after = await e2eState(page);
  expect(after.commitCount).toBe(before.commitCount);
  expect(after.undoDepth).toBe(before.undoDepth);
  expect(after.modulePositions).toEqual(before.modulePositions);
});
