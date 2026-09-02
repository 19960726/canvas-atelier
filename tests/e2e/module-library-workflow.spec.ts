import { test, expect } from './helpers/e2e-test';
import {
  captureLayoutScreenshot,
  e2eState,
  openApp,
  openEmptyApp,
  queueProjectImageImport,
  queueProjectVideoImport,
} from './helpers/app';
import { makeReferenceImage } from './helpers/fixtures';

test('manual acceptance imports image and video files through real browser pickers', async ({ page }) => {
  await openEmptyApp(page, '/?novusHarness=novus-e2e-codex-ui-gate');
  await page.evaluate(async () => {
    await window.__NOVUS_E2E__!.createModule('image_input', { x: 180, y: 140 });
    await window.__NOVUS_E2E__!.createModule('video_input', { x: 560, y: 140 });
  });

  const imageNode = page.locator('[data-module-type="image_input"]');
  const videoNode = page.locator('[data-module-type="video_input"]');
  const imageFixture = makeReferenceImage(
    'Manual acceptance frame.png',
    [31, 118, 105, 255],
    { width: 640, height: 360 },
  );

  const imageChooserPromise = page.waitForEvent('filechooser');
  await imageNode.getByRole('button', { name: '导入图像 / Import image' }).click();
  const imageChooser = await imageChooserPromise;
  await imageChooser.setFiles({
    name: imageFixture.name,
    mimeType: imageFixture.mimeType,
    buffer: imageFixture.buffer,
  });

  await expect(imageNode.getByRole('img', { name: 'Manual acceptance frame' })).toBeVisible();
  await expect.poll(async () => (await e2eState(page)).projectImages.map((asset) => asset.label))
    .toEqual(['Manual acceptance frame']);

  const videoChooserPromise = page.waitForEvent('filechooser');
  await videoNode.getByRole('button', { name: '导入视频 / Import video' }).click();
  const videoChooser = await videoChooserPromise;
  await videoChooser.setFiles({
    name: 'Manual acceptance motion.mp4',
    mimeType: 'video/mp4',
    buffer: Buffer.from([0, 0, 0, 20, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0]),
  });

  await expect(videoNode.locator('video')).toHaveAttribute('aria-label', 'Manual acceptance motion');
  await expect.poll(async () => (await e2eState(page)).projectVideos.map((asset) => asset.label))
    .toEqual(['Manual acceptance motion']);
  const agentFileInput = page.getByTestId('agent-reference-file-input');
  await expect(agentFileInput).toHaveCount(1);
  await expect(agentFileInput).toBeHidden();
});

test('creates executable modules from the library', async ({ page }) => {
  await openApp(page);
  const initialTextPromptCount = await page.locator('[data-module-type="text_prompt"]').count();
  const initialImageGenerationCount = await page.locator('[data-module-type="image_generation"]').count();
  await page.getByTestId('tool-modules').click();
  await page.getByRole('searchbox', { name: '搜索模块' }).fill('prompt');
  await page.getByRole('button', { name: '查看 文本提示词 / Text Prompt' }).dblclick();
  await page.getByRole('searchbox', { name: '搜索模块' }).fill('image generation');
  await page.getByRole('button', { name: '查看 图片生成 / Image Generation' }).dblclick();

  await expect(page.locator('[data-module-type="text_prompt"]')).toHaveCount(initialTextPromptCount + 1);
  await expect(page.locator('[data-module-type="image_generation"]')).toHaveCount(initialImageGenerationCount + 1);
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-save-state', 'saved');
});

test('connects an image input to the reverse agent by dragging visible ports', async ({ page }) => {
  await openEmptyApp(page);
  await page.evaluate(async () => {
    await window.__NOVUS_E2E__!.createModule('image_input', { x: 120, y: 180 });
    await window.__NOVUS_E2E__!.createModule('reverse_agent', { x: 620, y: 180 });
  });

  const source = page.locator('[data-module-type="image_input"] [data-port-id="image"].react-flow__handle');
  const target = page.locator('[data-module-type="reverse_agent"] [data-port-id="references"].react-flow__handle');
  await expect(source).toBeVisible();
  await expect(target).toBeVisible();
  const [sourceBox, targetBox] = await Promise.all([source.boundingBox(), target.boundingBox()]);
  const [imageNodeBox, reverseNodeBox] = await Promise.all([
    page.locator('[data-module-type="image_input"]').boundingBox(),
    page.locator('[data-module-type="reverse_agent"]').boundingBox(),
  ]);
  expect(sourceBox).not.toBeNull();
  expect(targetBox).not.toBeNull();
  expect(imageNodeBox).not.toBeNull();
  expect(reverseNodeBox).not.toBeNull();
  expect(sourceBox!.width).toBeGreaterThanOrEqual(14);
  expect(targetBox!.width).toBeGreaterThanOrEqual(14);
  expect(Math.abs((sourceBox!.x + sourceBox!.width / 2) - (imageNodeBox!.x + imageNodeBox!.width))).toBeLessThanOrEqual(1);
  expect(Math.abs((targetBox!.x + targetBox!.width / 2) - reverseNodeBox!.x)).toBeLessThanOrEqual(1);

  // Module creation and React Flow's internal handle measurement settle on
  // separate animation frames. A real user cannot begin a drag before those
  // frames, while Playwright can; wait for the same visible-ready boundary.
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));

  await source.dragTo(target);

  await expect.poll(async () => (await e2eState(page)).edgeCount).toBe(1);
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  expect(
    await page.locator('.react-flow__edge-path').getAttribute('d'),
    'Image → reverse must use the same Bézier connector as the video flow.',
  ).toContain('C');
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

  const imageInputs = page.locator('[data-module-type="image_input"]');
  await expect(imageInputs).toHaveCount(2);
  const imageInput = imageInputs.last();
  const uploadImage = page.locator('[data-module-type="upload_image"]');
  const canvasLibrary = page.locator('[data-module-type="canvas_library"]');
  await expect(imageInput).toBeVisible();
  await expect(uploadImage).toBeVisible();
  await expect(canvasLibrary).toBeVisible();

  await queueProjectImageImport(page, makeReferenceImage('Product front.png', [20, 132, 108, 255]));
  await imageInput.getByRole('button', { name: '导入图像 / Import image' }).click();
  await expect(imageInput.getByRole('img', { name: 'Product front' })).toBeVisible();

  await queueProjectImageImport(page, makeReferenceImage('Studio scene.png', [49, 75, 132, 255]));
  await uploadImage.getByRole('button', { name: '导入图像 / Import image' }).click();
  await expect(uploadImage.getByRole('img', { name: 'Studio scene' })).toBeVisible();

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
  const agentFileInput = page.getByTestId('agent-reference-file-input');
  await expect(agentFileInput).toHaveCount(1);
  await expect(agentFileInput).toBeHidden();
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-save-state', 'saved');
  await captureLayoutScreenshot(page, testInfo, 'renderer-managed-image-library');
});

test('preserves landscape portrait and square images inside the large media source slot', async ({ page }, testInfo) => {
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
    // The Figma media source uses a stable 272px preview width while the
    // rendered frame follows each asset's intrinsic aspect ratio.
    const expectedMediaSizes = [
      { width: 272, height: 153 },
      { width: 272, height: 483.55555555555554 },
      { width: 272, height: 272 },
    ] as const;
    expect(mediaBox!.width).toBeCloseTo(expectedMediaSizes[index]!.width, 1);
    expect(mediaBox!.height).toBeCloseTo(expectedMediaSizes[index]!.height, 1);
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
  await queueProjectVideoImport(page, { label: 'Campaign turntable.mp4' });
  const beforeVideoImport = await e2eState(page);
  await videoNode.getByRole('button', { name: /Import video/u }).click();

  await expect(imageNode.locator('.module-node__media-frame')).toBeVisible();
  await expect(videoNode.locator('.module-node__video-control')).toBeVisible();
  const videoPreview = videoNode.locator('video');
  await expect(videoPreview).toHaveCount(1);
  await expect(videoPreview).toHaveAttribute('aria-label', 'Campaign turntable');
  await expect(videoPreview).toHaveAttribute('src', /\/__novus_e2e_asset\/[a-f0-9]{16}\.mp4$/u);
  await expect(videoNode.locator('.module-node__media-frame')).toHaveCSS('aspect-ratio', '1920 / 1080');
  const [imageMediaBox, videoMediaBox, imageNodeBox, videoNodeBox] = await Promise.all([
    imageNode.locator('.module-node__media-frame').boundingBox(),
    videoNode.locator('.module-node__media-frame').boundingBox(),
    imageNode.boundingBox(),
    videoNode.boundingBox(),
  ]);
  expect(imageMediaBox).not.toBeNull();
  expect(videoMediaBox).not.toBeNull();
  expect(imageNodeBox).not.toBeNull();
  expect(videoNodeBox).not.toBeNull();
  expect(videoMediaBox!.width).toBeCloseTo(272, 1);
  expect(videoMediaBox!.height).toBeCloseTo(153, 1);
  expect(videoNodeBox!.width).toBeCloseTo(imageNodeBox!.width, 1);
  await expect.poll(async () => (await e2eState(page)).commitCount).toBe(beforeVideoImport.commitCount + 1);
  expect((await e2eState(page)).projectVideos.map((asset) => asset.label)).toEqual(['Campaign turntable']);
  await expect(videoNode.getByText('待配置')).toHaveCount(0);
  await expect(imageNode.locator('.module-node__media-meta')).toBeHidden();
  await expect(videoNode.locator('.module-node__media-meta')).toBeHidden();

  const portHandle = imageNode.locator('.module-node__port-row .react-flow__handle').first();
  await expect(portHandle).toBeVisible();
  await expect.poll(() => portHandle.evaluate((element) => {
    const handle = getComputedStyle(element);
    const target = getComputedStyle(element, '::after');
    return {
      height: Number.parseFloat(handle.height) + Math.abs(Number.parseFloat(target.top)) + Math.abs(Number.parseFloat(target.bottom)),
      width: Number.parseFloat(handle.width) + Math.abs(Number.parseFloat(target.left)) + Math.abs(Number.parseFloat(target.right)),
    };
  })).toEqual({ height: 30, width: 30 });
  await expect.poll(() => portHandle.evaluate((element) => (
    (element.closest('.module-node__port-row') as HTMLElement).getBoundingClientRect().height
  ))).toBeGreaterThanOrEqual(24);
  await captureLayoutScreenshot(page, testInfo, 'renderer-media-first-image-video-nodes');
});

test('pastes a clipboard MP4 before falling back to clipboard image import', async ({ page }) => {
  await openEmptyApp(page);
  await queueProjectVideoImport(page, { label: 'Clipboard motion.mp4' });
  const stage = page.getByTestId('canvas-stage');
  const stageBox = await stage.boundingBox();
  expect(stageBox).not.toBeNull();
  const pointer = { x: stageBox!.x + 460, y: stageBox!.y + 280 };
  await page.mouse.move(pointer.x, pointer.y);
  const before = await e2eState(page);

  await page.evaluate(() => {
    const clipboardData = new DataTransfer();
    clipboardData.items.add(new File([new Uint8Array([1])], 'clipboard.mp4', { type: 'video/mp4' }));
    window.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
  });

  const node = page.locator('[data-module-type="video_input"]');
  await expect(node).toHaveCount(1);
  await expect(node.locator('video')).toHaveAttribute('src', /\/__novus_e2e_asset\/[a-f0-9]{16}\.mp4$/u);
  await expect.poll(async () => (await e2eState(page)).commitCount).toBe(before.commitCount + 1);
  const after = await e2eState(page);
  expect(after.projectVideos.map((asset) => asset.label)).toEqual(['clipboard']);
  expect(after.projectImages).toEqual([]);
  expect(after.durableProjectContainsTransientImageUrl).toBe(false);
});

test('pastes a clipboard image as one managed media node transaction', async ({ page }) => {
  await openEmptyApp(page);
  await queueProjectImageImport(
    page,
    makeReferenceImage('Clipboard concept.png', [58, 104, 148, 255], { width: 640, height: 360 }),
  );
  const stage = page.getByTestId('canvas-stage');
  const stageBox = await stage.boundingBox();
  expect(stageBox).not.toBeNull();
  const pointer = { x: stageBox!.x + 420, y: stageBox!.y + 260 };
  await page.mouse.move(pointer.x, pointer.y);
  const before = await e2eState(page);

  await page.evaluate(() => {
    const clipboardData = new DataTransfer();
    clipboardData.items.add(new File([new Uint8Array([1])], 'clipboard.png', { type: 'image/png' }));
    window.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
  });

  const node = page.locator('[data-module-type="image_input"]');
  await expect(node).toHaveCount(1);
  await expect(node.getByRole('img', { name: 'clipboard' })).toBeVisible();
  await expect.poll(async () => (await e2eState(page)).commitCount).toBe(before.commitCount + 1);
  const after = await e2eState(page);
  expect(after.projectImages.map((asset) => asset.label)).toEqual(['clipboard']);
  expect(after.durableProjectContainsTransientImageUrl).toBe(false);
});

test('does not expose the retired hand tool in the seven-action Figma rail', async ({ page }) => {
  await openEmptyApp(page);
  await expect(page.getByTestId('toolrail').locator('button:visible')).toHaveCount(7);
  await expect(page.getByTestId('tool-hand')).toHaveCount(0);
  await expect(page.getByTestId('tool-placement')).toBeHidden();
});
