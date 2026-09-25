import { expect, test } from './helpers/e2e-test';
import { e2eState, openEmptyApp, queueProjectImageImport } from './helpers/app';
import { makeReferenceImage } from './helpers/fixtures';

for (const theme of ['dark', 'light'] as const) {
  test(`expanded generation editors form one compact ${theme} card`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1600, height: 1100 });
    await page.addInitScript((nextTheme) => localStorage.setItem('novus.theme.mode', nextTheme), theme);
    await openEmptyApp(page);
    for (const [moduleType, previewSelector, mediaLabel, controlSelector, minPreviewHeight] of [
      ['image_generation', '.module-node__generation-editor-preview', 'Image generation reference slots', '.module-node__generation-control-bar', 420],
      ['video_generation', '.module-node__result', 'Connected video media editor', '.module-node__video-control-bar', 340],
    ] as const) {
      await page.evaluate(async (type) => {
        await window.__NOVUS_E2E__!.resetEmpty();
        await window.__NOVUS_E2E__!.createModule(type, { x: 320, y: 100 });
      }, moduleType);
      const node = page.locator(`[data-module-type="${moduleType}"]`);
      await node.getByRole('button', { name: moduleType === 'image_generation' ? 'Open image generation editor' : 'Open video generation editor' }).click();
      await expect(node.locator('.module-node__summary--generation')).toHaveAttribute('data-editor-expanded', 'true');
      await expect(node.locator('.module-node__parameter-labels')).toBeVisible();
      await expect(node.locator('.module-node__parameter-labels')).toHaveCSS('border-top-width', '0px');
      if (moduleType === 'image_generation') {
        await node.getByRole('combobox', { name: 'Image generation model route' }).selectOption({ label: 'GPT Image 2' });
        await expect(node.getByRole('region', { name: 'GPT 参数' })).toBeVisible();
        const heading = await node.getByText('GPT 参数', { exact: true }).boundingBox();
        const group = await node.getByRole('region', { name: 'GPT 参数' }).boundingBox();
        const qualityControl = await node.getByRole('button', { name: 'Image generation quality' }).boundingBox();
        await expect(node.getByText('GPT 参数', { exact: true })).toHaveCSS('text-align', 'left');
        const headingGlyph = await node.getByText('GPT 参数', { exact: true }).evaluate((element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          return range.getBoundingClientRect().toJSON();
        });
        expect(headingGlyph.x - group!.x).toBeLessThanOrEqual(18);
        expect(qualityControl!.y - heading!.y).toBeGreaterThanOrEqual(20);
        expect(heading!.x - group!.x).toBeLessThanOrEqual(18);
      }
      const card = await node.boundingBox();
      const preview = await node.locator(previewSelector).boundingBox();
      const media = await node.getByLabel(mediaLabel, { exact: true }).boundingBox();
      const prompt = await node.locator('.module-node__prompt-workspace').boundingBox();
      const controls = await node.locator(controlSelector).boundingBox();
      expect(card).not.toBeNull();
      expect(preview).not.toBeNull();
      expect(media).not.toBeNull();
      expect(prompt).not.toBeNull();
      expect(controls).not.toBeNull();
      expect(card!.width).toBeGreaterThanOrEqual(680);
      expect(card!.width).toBeLessThanOrEqual(740);
      expect(preview!.width).toBeGreaterThan(600);
      expect(preview!.height).toBeGreaterThanOrEqual(minPreviewHeight);
      expect(preview!.x).toBeGreaterThan(card!.x);
      expect(preview!.y).toBeGreaterThan(card!.y + 40);
      expect(media!.y - (preview!.y + preview!.height)).toBeCloseTo(0, 0);
      expect(prompt!.y - (media!.y + media!.height)).toBeCloseTo(0, 0);
      expect(controls!.y - (prompt!.y + prompt!.height)).toBeCloseTo(0, 0);
      expect(prompt!.x - media!.x).toBeCloseTo(0, 0);
      expect(controls!.x - prompt!.x).toBeCloseTo(0, 0);
      expect(controls!.y + controls!.height).toBeLessThanOrEqual(card!.y + card!.height + 1);
      expect(await node.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
      const run = await node.locator('.module-node__run-generation').boundingBox();
      expect(run!.width).toBeLessThanOrEqual(92);
      expect(run!.height).toBeLessThanOrEqual(34);
      if (moduleType === 'image_generation') {
        await expect(node.getByRole('button', { name: 'Image generation quality' })).toBeVisible();
        await expect(node.getByRole('button', { name: 'Image generation format' })).toBeVisible();
        await expect(node.getByRole('button', { name: 'Image generation background' })).toBeVisible();
      } else {
        await expect(node.getByRole('button', { name: '打开视频参数设置' })).toContainText(/· \d+s · \d个/u);
        await node.getByRole('button', { name: '打开视频参数设置' }).click();
        const settings = node.getByRole('dialog', { name: '视频生成参数' });
        await expect(settings).toBeVisible();
        await expect(settings.getByText('视频设置', { exact: true })).toBeVisible();
        const settingsTrigger = await node.getByRole('button', { name: '打开视频参数设置' }).boundingBox();
        const settingsBox = await settings.boundingBox();
        expect(settingsBox).not.toBeNull();
        expect(settingsTrigger).not.toBeNull();
        expect(settingsBox!.y).toBeGreaterThanOrEqual(12);
        expect(settingsBox!.y + settingsBox!.height).toBeLessThanOrEqual(1100 - 12);
        expect(settingsBox!.y).toBeGreaterThanOrEqual(settingsTrigger!.y + settingsTrigger!.height);
        await expect(settings).toHaveAttribute('data-placement', 'below');
        expect(settingsBox!.width).toBeGreaterThanOrEqual(296);
        expect(settingsBox!.width).toBeLessThanOrEqual(304);
        await expect(settings.locator('.module-node__video-settings-row')).toHaveCount(5);
        await expect(settings.getByRole('button', { name: '视频比例' })).toBeVisible();
        for (const label of ['视频清晰度', '生成数量']) await expect(settings.getByRole('combobox', { name: label })).toBeVisible();
        await expect(settings.getByRole('button', { name: '视频比例' })).toHaveCSS('height', '30px');
        await expect(settings.locator('.module-node__video-settings-row > span').first()).toHaveCSS('font-size', '12px');
        await expect(settings.getByRole('slider', { name: '视频时长' })).toBeVisible();
        expect(await settings.getByRole('slider', { name: '视频时长' }).evaluate((element) => getComputedStyle(element).backgroundImage)).toContain('linear-gradient');
        const audioToggle = settings.getByRole('button', { name: '生成音频' });
        await expect(audioToggle).toBeVisible();
        await expect(audioToggle).toHaveAttribute('aria-pressed', 'true');
        await expect(audioToggle).toContainText('开启');
        expect((await audioToggle.boundingBox())!.width).toBeLessThanOrEqual(76);
        const audioRow = audioToggle.locator('xpath=../..');
        const [audioRowBox, audioToggleBox] = await Promise.all([audioRow.boundingBox(), audioToggle.boundingBox()]);
        expect(audioRowBox).not.toBeNull();
        expect(audioToggleBox).not.toBeNull();
        expect(
          Math.abs((audioToggleBox!.x + audioToggleBox!.width / 2) - (audioRowBox!.x + audioRowBox!.width / 2)),
          'The whole audio button must align with the horizontal center of its full settings row',
        ).toBeLessThanOrEqual(1);
        await page.screenshot({ path: testInfo.outputPath(`integrated-video-settings-${theme}.png`) });
        await settings.screenshot({ path: testInfo.outputPath(`video-settings-detail-${theme}.png`) });
        await audioToggle.click();
        await expect(audioToggle).toHaveAttribute('aria-pressed', 'false');
        await expect(audioToggle).toContainText('关闭');
        await audioToggle.click();
        await expect(audioToggle).toHaveAttribute('aria-pressed', 'true');
        const durationBefore = Number.parseInt((await settings.locator('output').textContent())!, 10);
        await settings.getByRole('slider', { name: '视频时长' }).focus();
        await settings.getByRole('slider', { name: '视频时长' }).press('ArrowRight');
        const durationAfter = Number.parseInt((await settings.locator('output').textContent())!, 10);
        expect(durationAfter).toBeGreaterThan(durationBefore);
        await expect(node.getByRole('button', { name: '打开视频参数设置' })).toContainText(`${durationAfter}s`);
      }
      await page.screenshot({ path: testInfo.outputPath(`integrated-${moduleType}-${theme}.png`) });
    }
  });
}

test('completed image results use a full-width two-by-two grid without a result scrollbar', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1100 });
  await openEmptyApp(page);
  await page.evaluate(async () => {
    await window.__NOVUS_E2E__!.createModule('image_generation', { x: 400, y: 100 });
  });
  for (const [index, color] of [[1, [182, 102, 72, 255]], [2, [68, 135, 168, 255]], [3, [132, 96, 161, 255]], [4, [190, 151, 84, 255]]] as const) {
    await page.evaluate(async (positionY) => window.__NOVUS_E2E__!.createModule('image_input', { x: 50, y: positionY }), 120 + (index - 1) * 210);
    await queueProjectImageImport(page, makeReferenceImage(`Grid result ${index}.png`, color));
    await page.locator('[data-module-type="image_input"]').last().getByRole('button', { name: /Import image/u }).click();
    await expect.poll(async () => (await e2eState(page)).projectImages.length).toBe(index);
  }
  const assetIds = (await e2eState(page)).projectImages.map((asset) => asset.assetId);
  await page.evaluate(async (ids) => {
    await window.__NOVUS_E2E__!.configureModule('image_generation', {
      config: { resultState: 'fresh', resultAssetIds: ids },
      execution: { state: 'completed' },
    });
  }, assetIds);
  const node = page.locator('[data-module-type="image_generation"]');
  await node.getByRole('button', { name: 'Open image generation editor' }).click();
  const stage = node.locator('.module-node__generation-editor-preview');
  const tiles = stage.locator('.module-node__generation-preview-item');
  await expect(tiles).toHaveCount(4);
  await expect.poll(() => tiles.locator('img').evaluateAll((images) => images.length === 4 && images.every((image) => (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
  const box = await stage.boundingBox();
  const rects = await tiles.evaluateAll((items) => items.map((item) => item.getBoundingClientRect().toJSON()));
  expect(box!.width).toBeGreaterThan(600);
  expect(rects[0]!.width).toBeGreaterThan(290);
  expect(rects[0]!.height).toBeGreaterThan(190);
  expect(rects[0]!.y).toBe(rects[1]!.y);
  expect(rects[2]!.y).toBe(rects[3]!.y);
  expect(rects[2]!.y).toBeGreaterThan(rects[0]!.y);
  expect(rects[1]!.x).toBeGreaterThan(rects[0]!.x);
  expect(await stage.evaluate((element) => getComputedStyle(element).overflowY)).toBe('hidden');
  await page.screenshot({ path: testInfo.outputPath('integrated-four-up.png') });
});
