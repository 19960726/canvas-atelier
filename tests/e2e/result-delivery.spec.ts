import { expect, test } from './helpers/e2e-test';
import { e2eState, openEmptyApp, queueProjectImageImport } from './helpers/app';
import { makeReferenceImage } from './helpers/fixtures';

test('reverse completion creates and fills a connected result node', async ({ page }) => {
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
  await reverse.getByLabel('Analysis task').fill('@');
  const referenceItem = reverse.getByRole('menu', { name: 'Select reference image' }).getByRole('menuitem', { name: 'Reverse reference' });
  await expect(referenceItem).toBeVisible();
  await referenceItem.click();
  await expect.poll(() => reverse.getByLabel('Analysis task').evaluate((element) => (
    (element as HTMLDivElement & { value?: string }).value ?? ''
  ))).toBe('@图片1');
  await reverse.getByRole('button', { name: 'Start reverse analysis' }).click();

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
