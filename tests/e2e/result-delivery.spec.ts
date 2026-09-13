import path from 'node:path';
import { expect, test } from './helpers/e2e-test';
import { e2eState, openEmptyApp, queueProjectImageImport } from './helpers/app';
import { makeReferenceImage } from './helpers/fixtures';

const zoomPreviewArtifact = path.join(process.cwd(), 'artifacts', 'CanvasAtelier-1.6.133-image-zoom', 'generated-image-zoom.png');

test('reverse completion creates and fills a connected result node', async ({ page }) => {
  const externalRequests: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if ((url.protocol === 'http:' || url.protocol === 'https:') && !['127.0.0.1', 'localhost'].includes(url.hostname)) {
      externalRequests.push(request.url());
    }
  });
  await openEmptyApp(page);
  await page.evaluate(async () => {
    await window.__NOVUS_E2E__!.createModule('image_input', { x: 40, y: 180 });
    await window.__NOVUS_E2E__!.createModule('reverse_agent', { x: 240, y: 180 });
    window.dispatchEvent(new Event('novus:provider-catalog-changed'));
  });
  await page.evaluate(() => {
    const provider = window.novusDesktop!.provider;
    const analyzeReversePrompt = provider.analyzeReversePrompt;
    provider.analyzeReversePrompt = async (input) => ({
      ...await analyzeReversePrompt(input),
      positivePrompt: 'Verified persisted reverse prompt',
    });
  });

  const imageInput = page.locator('[data-module-type="image_input"]');
  await queueProjectImageImport(page, makeReferenceImage('Reverse reference.png', [42, 126, 168, 255], { width: 800, height: 600 }));
  await imageInput.getByRole('button', { name: /Import image/u }).click();
  await page.evaluate(() => window.__NOVUS_E2E__!.connectModules('image_input', 'image', 'reverse_agent', 'references'));

  const reverse = page.locator('[data-module-type="reverse_agent"]');
  const route = reverse.getByRole('combobox', { name: 'Agent model route' });
  await expect.poll(async () => route.locator('option').count()).toBeGreaterThan(1);
  const availableRoute = await route.locator('option').evaluateAll((options) => (
    options.map((option) => (option as HTMLOptionElement).value).find((value) => value.length > 0) ?? ''
  ));
  expect(availableRoute).not.toBe('');
  await route.selectOption(availableRoute);
  await reverse.getByLabel('Role positioning').fill('Commercial visual analyst');
  await reverse.getByRole('button', { name: '深度反推' }).click();
  await expect(reverse.getByRole('button', { name: '深度反推' })).toHaveAttribute('aria-pressed', 'true');
  await reverse.getByLabel('Analysis task').fill('@');
  const referenceItem = reverse.getByRole('menu', { name: 'Select reference image' }).getByRole('menuitem', { name: 'Reverse reference' });
  await expect(referenceItem).toBeVisible();
  await referenceItem.click();
  await expect.poll(() => reverse.getByLabel('Analysis task').evaluate((element) => (
    (element as HTMLDivElement & { value?: string }).value ?? ''
  ))).toBe('@图片1');

  await page.evaluate(() => window.__NOVUS_E2E__!.failNextReverseAnalysis());
  await reverse.getByRole('button', { name: 'Start reverse analysis' }).click();
  await expect(reverse.getByRole('alert')).toContainText('E2E controlled reverse failure');
  const retryButton = reverse.getByRole('button', { name: 'Start reverse analysis' });
  await expect(retryButton).toBeEnabled();
  let reverseState = await e2eState(page);
  expect(reverseState.reverseAnalysisRequests).toHaveLength(1);
  expect(reverseState.reverseAnalysisRequests[0]).toMatchObject({
    analysisDepth: 'deep',
    modelRoute: availableRoute,
  });

  await retryButton.click();

  const result = page.locator('[data-module-type="reverse_result"]');
  await expect(result).toHaveCount(1);
  const preview = result.getByRole('region', { name: 'Reverse analysis result' });
  await expect(preview).toContainText('分析');
  await expect(preview).toContainText('关键词');
  await expect(preview).toContainText('反推正向提示词');
  await expect(preview).toContainText('负面约束');
  await expect(preview).toContainText('执行检查清单');
  await expect(preview).toContainText('Verified persisted reverse prompt');
  const positivePrompt = reverse.getByLabel('Reverse positive prompt');
  await expect(positivePrompt).toHaveValue('Verified persisted reverse prompt');
  reverseState = await e2eState(page);
  expect(reverseState.reverseAnalysisRequests).toHaveLength(2);
  expect(reverseState.reverseAnalysisRequests.map((request) => request.analysisDepth)).toEqual(['deep', 'deep']);
  expect(reverseState.modelSubmissions).toHaveLength(0);
  expect(externalRequests).toEqual([]);

  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (value: string) => { (window as typeof window & { __copiedReverse?: string }).__copiedReverse = value; } },
    });
  });
  await positivePrompt.fill('Edited persisted reverse prompt');
  await reverse.getByRole('button', { name: 'Copy reverse result' }).click();
  await expect(reverse.getByRole('button', { name: 'Copy reverse result' })).toContainText('复制成功');
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __copiedReverse?: string }).__copiedReverse ?? ''))
    .toContain('Edited persisted reverse prompt');

  const state = await e2eState(page);
  expect(state.edgeCount).toBe(2);
  const reversePosition = state.modulePositions.find((item) => item.moduleType === 'reverse_agent')?.position;
  const resultPosition = state.modulePositions.find((item) => item.moduleType === 'reverse_result')?.position;
  expect(reversePosition).toBeDefined();
  expect(resultPosition).toEqual({ x: reversePosition!.x + 680, y: reversePosition!.y });

  await page.waitForTimeout(350);
  await page.evaluate(() => window.__NOVUS_E2E__!.reopenProject());
  await expect(page.locator('[data-module-type="reverse_agent"]')).toContainText('Edited persisted reverse prompt');
  const reopenedResult = page.locator('[data-module-type="reverse_result"]');
  await expect(reopenedResult).toHaveCount(1);
  await expect(reopenedResult.getByRole('region', { name: 'Reverse analysis result' }))
    .toContainText('Edited persisted reverse prompt');
});

test('a completed generated image is visible inside its generation node', async ({ page }) => {
  await openEmptyApp(page);
  const seeded = await page.evaluate(async () => {
    await window.__NOVUS_E2E__!.createModule('image_generation', { x: 360, y: 180 });
    return await window.__NOVUS_E2E__!.seedGeneratedImageResult?.() ?? false;
  });
  expect(seeded).toBe(true);

  const generation = page.locator('[data-module-type="image_generation"]');
  await generation.getByRole('button', { name: 'Open image generation editor' }).click();
  const generatedImage = generation.getByRole('button', { name: 'Generated image 1; double click to preview' });
  await expect(generatedImage).toBeVisible();
  const previewImage = generatedImage.locator('img');
  await expect(previewImage).toHaveAttribute('src', /__novus_e2e_asset\/0123456789abcdef\.svg$/u);
  const dimensions = await previewImage.evaluate((image) => {
    const rect = image.getBoundingClientRect();
    const container = image.parentElement!.getBoundingClientRect();
    const gallery = image.parentElement!.parentElement!.getBoundingClientRect();
    const style = getComputedStyle(image);
    const containerStyle = getComputedStyle(image.parentElement!);
    const galleryStyle = getComputedStyle(image.parentElement!.parentElement!);
    return {
      height: rect.height, width: rect.width, containerHeight: container.height, containerWidth: container.width,
      galleryHeight: gallery.height, galleryWidth: gallery.width,
      cssHeight: style.height, cssWidth: style.width, maxHeight: style.maxHeight, maxWidth: style.maxWidth,
      justifySelf: style.justifySelf, containerDisplay: containerStyle.display, containerGridColumns: containerStyle.gridTemplateColumns,
      galleryDisplay: galleryStyle.display, galleryRows: galleryStyle.gridTemplateRows,
    };
  });
  expect(dimensions.width / dimensions.containerWidth).toBeGreaterThan(0.75);
  expect(dimensions.height / dimensions.containerHeight).toBeGreaterThan(0.75);

  await generatedImage.dblclick();
  const lightbox = page.getByRole('dialog', { name: 'Generated image preview' });
  const detailViewer = page.getByLabel('Generated image detail viewer');
  await expect(lightbox).toBeVisible();
  await expect(lightbox.getByLabel('图片尺寸')).toHaveText('1024 × 1024 px');
  await expect(lightbox.getByRole('button', { name: '复制图片' })).toBeVisible();
  await expect(detailViewer).toHaveAttribute('data-zoomed', 'false');
  expect(await detailViewer.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe('rgb(16, 22, 28)');

  const viewerBox = await detailViewer.boundingBox();
  expect(viewerBox).not.toBeNull();
  await page.mouse.move(viewerBox!.x + viewerBox!.width / 2, viewerBox!.y + viewerBox!.height / 2);
  await page.mouse.wheel(0, -240);
  await expect(lightbox.getByLabel('Generated image zoom level')).toHaveText('125%');
  await expect(detailViewer).toHaveAttribute('data-zoomed', 'true');
  await lightbox.screenshot({ path: zoomPreviewArtifact });

  await lightbox.getByRole('button', { name: 'Reset generated image zoom' }).click();
  await expect(lightbox.getByLabel('Generated image zoom level')).toHaveText('100%');
});

test('double-clicking a canvas material opens the shared detail viewer with exact dimensions', async ({ page }) => {
  await openEmptyApp(page);
  await page.evaluate(async () => {
    await window.__NOVUS_E2E__!.createModule('image_input', { x: 260, y: 140 });
  });
  await queueProjectImageImport(page, makeReferenceImage(
    'Material detail.png',
    [74, 116, 92, 255],
    { width: 2400, height: 1600 },
  ));

  const imageInput = page.locator('[data-module-type="image_input"]');
  await imageInput.getByRole('button', { name: /Import image/u }).click();
  await imageInput.getByRole('img', { name: 'Material detail' }).dblclick();

  const lightbox = page.getByRole('dialog', { name: 'Generated image preview' });
  await expect(lightbox).toBeVisible();
  await expect(lightbox.getByLabel('图片尺寸')).toHaveText('2400 × 1600 px');
  await expect(lightbox.getByRole('button', { name: '复制图片' })).toBeVisible();
  await expect(lightbox).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(lightbox).toBeHidden();
});

test('a newly completed image returns to the result-only gallery without a prompt', async ({ page }) => {
  await openEmptyApp(page);
  await page.evaluate(async () => {
    await window.__NOVUS_E2E__!.createModule('image_generation', { x: 360, y: 180 });
  });

  const generation = page.locator('[data-module-type="image_generation"]');
  await generation.getByRole('button', { name: 'Open image generation editor' }).click();
  await expect(generation.getByLabel('Image generation prompt workspace')).toBeVisible();

  const seeded = await page.evaluate(async () => await window.__NOVUS_E2E__!.seedGeneratedImageResult?.() ?? false);
  expect(seeded).toBe(true);

  await expect(generation.getByLabel('Image generation prompt workspace')).toHaveCount(0);
  await expect(generation.getByRole('button', { name: 'Open image generation editor' })).toBeVisible();
  await expect(generation.getByLabel('Generated image preview 1')).toBeVisible();
});

test('four completed images use a result-only four-up gallery', async ({ page }) => {
  await openEmptyApp(page);
  await page.evaluate(async () => {
    await window.__NOVUS_E2E__!.createModule('image_generation', { x: 260, y: 120 });
  });

  const seeded = await page.evaluate(async () => await window.__NOVUS_E2E__!.seedGeneratedImageResult?.(4) ?? false);
  expect(seeded).toBe(true);

  const generation = page.locator('[data-module-type="image_generation"]');
  await expect(generation.getByLabel(/Generated image preview \d/u)).toHaveCount(4);
  await expect(generation.getByLabel('Image generation prompt workspace')).toHaveCount(0);
  await expect(generation.locator('.module-node__generation-preview-gallery--4')).toBeVisible();
});
