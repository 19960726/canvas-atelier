import { expect, test } from './helpers/e2e-test';
import { e2eState, failNextModelJobEnqueue, openEmptyApp, queueProjectImageImport, queueProjectVideoImport, waitForModelSubmissions } from './helpers/app';
import { makeReferenceImage } from './helpers/fixtures';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Locator, Page } from '@playwright/test';

const referencePath = resolve('work/repair-185/qa-fixtures/reference.png');
const referenceBuffer = existsSync(referencePath) ? readFileSync(referencePath) : undefined;
const referenceFixture = referenceBuffer ? {
  name: '运行测试原始参考图.png', mimeType: 'image/png' as const, buffer: referenceBuffer,
  width: referenceBuffer.readUInt32BE(16), height: referenceBuffer.readUInt32BE(20),
} : makeReferenceImage('运行测试参考图.png', [72, 145, 122, 255], { width: 1200, height: 800 });

async function screenshotSideRanges(page: Page, region: Locator) {
  const screenshotBytes = await region.screenshot();
  return page.evaluate(async encoded => {
    const screenshot = new Image();
    screenshot.src = `data:image/png;base64,${encoded}`;
    await screenshot.decode();
    const canvas = document.createElement('canvas');
    canvas.width = screenshot.naturalWidth;
    canvas.height = screenshot.naturalHeight;
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    context.drawImage(screenshot, 0, 0);
    const range = (fraction: number) => {
      const values: number[] = [];
      for (let row = 0.15; row <= 0.85; row += 0.1) {
        const pixel = context.getImageData(Math.round(canvas.width * fraction), Math.round(canvas.height * row), 1, 1).data;
        values.push((pixel[0]! + pixel[1]! + pixel[2]!) / 3);
      }
      return Math.max(...values) - Math.min(...values);
    };
    return { leftRange: range(0.05), rightRange: range(0.95) };
  }, screenshotBytes.toString('base64'));
}

for (const theme of ['dark', 'light'] as const) {
  for (const kind of ['image', 'video'] as const) {
  for (const previewCase of ['reference', 'no-reference', 'previous-result'] as const) {
    test(`${kind} ${previewCase} running preview preserves the existing ${theme} generation card`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: 1600, height: 2000 });
      await page.addInitScript(mode => localStorage.setItem('novus.theme.mode', mode), theme);
      await openEmptyApp(page);
      const moduleType = kind === 'image' ? 'image_generation' : 'video_generation';
      await page.evaluate(async type => {
        await window.__NOVUS_E2E__!.createModule('image_input', { x: 40, y: 110 });
        await window.__NOVUS_E2E__!.createModule(type, { x: 440, y: 110 });
      }, moduleType);
      if (previewCase !== 'no-reference') {
        await queueProjectImageImport(page, referenceFixture, { preservePixels: true });
        const source = page.locator('[data-module-type="image_input"]');
        await source.getByRole('button', { name: /Import image/u }).click();
        await page.evaluate(async type => window.__NOVUS_E2E__!.connectModules('image_input', 'image', type, type === 'image_generation' ? 'references' : 'media'), moduleType);
      }
      if (previewCase === 'previous-result') {
        const assetId = (await e2eState(page)).projectImages.at(-1)!.assetId;
        let previousVideoAssetId: string | undefined;
        if (kind === 'video') {
          await page.evaluate(() => window.__NOVUS_E2E__!.createModule('video_input', { x: 1200, y: 1200 }));
          await queueProjectVideoImport(page, { label: '本项目上一段视频.mp4' });
          await page.locator('[data-module-type="video_input"]').getByRole('button', { name: 'Import video' }).click();
          previousVideoAssetId = (await e2eState(page)).projectVideos.at(-1)!.assetId;
        }
        await page.evaluate(async ({ type, assetId, previousVideoAssetId }) => window.__NOVUS_E2E__!.configureModule(type, {
          config: type === 'image_generation'
            ? { resultState: 'fresh', resultAssetIds: [assetId] }
            : { resultState: 'fresh', videoResults: [{ assetId: previousVideoAssetId, mediaType: 'video/mp4', durationMs: 5000, posterAssetId: assetId }] },
          execution: { state: 'completed' },
        }), { type: moduleType, assetId, previousVideoAssetId });
      }
      const generation = page.locator(`[data-module-type="${moduleType}"]`);
      await generation.getByRole('button', { name: kind === 'image' ? 'Open image generation editor' : 'Open video generation editor' }).click();
      if (kind === 'image') await generation.getByRole('combobox', { name: 'Image generation model route' }).selectOption('comfly-gpt-image-2');
      const prompt = generation.getByRole('textbox', { name: kind === 'image' ? 'Image generation prompt' : 'Video preview prompt' });
      const wholePrompt = '保留原图机位、物体比例和完整场景，参考图片作为构图依据；运行时仍然展示这份完整提示词。';
      await prompt.fill(wholePrompt);
      const parameterBar = generation.locator('.module-node__generation-control-bar');
      await expect(parameterBar).toBeVisible();
      if (kind === 'image') {
        const gptParameters = generation.getByRole('region', { name: 'GPT 参数' });
        await expect(gptParameters).toBeVisible();
        {
          const controls = parameterBar.locator(':scope > .module-node__run-generation');
          const [controlBox, sectionBox] = await Promise.all([controls.boundingBox(), gptParameters.boundingBox()]);
          expect(sectionBox!.y - (controlBox!.y + controlBox!.height), 'The GPT separator has breathing room below the parameter buttons').toBeGreaterThanOrEqual(10);
          expect(await gptParameters.evaluate(element => getComputedStyle(element).borderTopWidth)).toBe('1px');
        }
      }
      const parameterSnapshot = () => parameterBar.locator('select[aria-label], input[aria-label], button[aria-label]:not(.module-node__run-generation)').evaluateAll(elements => elements.map(element => ({
        label: element.getAttribute('aria-label'),
        value: element instanceof HTMLSelectElement || element instanceof HTMLInputElement ? element.value : element.textContent,
      })));
      const originalParameters = await parameterSnapshot();
      expect(originalParameters.map(field => field.label)).toEqual(expect.arrayContaining(kind === 'image'
        ? ['Image generation model route', 'Image generation aspect ratio', 'Image generation resolution', 'Image generation quantity']
        : ['Video preview model', 'Video preview mode', 'Video preview aspect ratio', 'Video preview resolution', 'Video preview duration', 'Video preview audio', 'Video preview quantity']));
      const originalResult = previewCase === 'previous-result'
        ? (kind === 'image' ? generation.getByRole('button', { name: 'Generated image 1; double click to preview' }) : generation.getByLabel('Completed video result 1 video', { exact: true }))
        : undefined;
      const resultImage = kind === 'image' ? originalResult?.locator('img') : originalResult;
      const originalResultSrc = await resultImage?.getAttribute('src');
      const before = await generation.boundingBox();
      await generation.getByRole('button', { name: kind === 'image' ? 'Generate image' : '生成视频' }).click();
      await waitForModelSubmissions(page, 1);
      await expect.poll(async () => (await e2eState(page)).modelJobs[0]?.status).toBe('running');
      const progress = generation.getByRole('status', { name: kind === 'image' ? '图片生成进度' : '视频生成进度' });
      await expect(progress).toBeVisible();
      await expect(progress).toContainText(kind === 'image' ? '正在生成' : '正在生成视频');
      await expect(progress).not.toContainText(/\d+%|预计|上传素材|保存结果/u);
      await expect(prompt).toHaveText(wholePrompt);
      const materials = generation.getByLabel(kind === 'image' ? 'Image generation reference slots' : 'Connected video media editor', { exact: true });
      await expect(materials).toBeVisible();
      await expect(materials.locator('img')).toHaveCount(previewCase === 'no-reference' ? 0 : 1);
      await expect(parameterBar).toBeVisible();
      expect(await parameterSnapshot(), 'All original model and generation parameters remain unchanged while running').toEqual(originalParameters);
      await expect(generation.getByRole('button', { name: '停止生成' })).toBeVisible();
      await expect(generation.getByRole('button', { name: kind === 'image' ? '折叠图片生成节点' : '折叠视频生成节点' })).toBeVisible();
      const after = await generation.boundingBox();
      expect(after!.width).toBeCloseTo(before!.width, 0);
      if (previewCase !== 'reference') expect(after!.height).toBeCloseTo(before!.height, 0);
      const stage = await generation.locator(kind === 'image' ? '.module-node__generation-editor-preview' : '.module-node__result').boundingBox();
      const progressBox = await progress.boundingBox();
      expect(progressBox!.x).toBeGreaterThanOrEqual(stage!.x);
      expect(progressBox!.y).toBeGreaterThanOrEqual(stage!.y);
      expect(progressBox!.x + progressBox!.width).toBeLessThanOrEqual(stage!.x + stage!.width + 1);
      expect(progressBox!.y + progressBox!.height).toBeLessThanOrEqual(stage!.y + stage!.height + 1);
      await expect(generation.locator('.module-node__running-reference-fill, .module-node__running-result-fill')).toHaveCount(0);
      if (previewCase !== 'no-reference') {
        await expect(generation).toHaveAttribute('data-preview-sizing', 'media');
        const priorVideo = kind === 'video' && previewCase === 'previous-result' ? await page.evaluate(async () => {
          const storePath = '/src/app/app-store.ts';
          const { useAppStore } = await import(storePath);
          const asset = useAppStore.getState().projectVideos.at(-1);
          return asset ? { width: asset.width, height: asset.height } : undefined;
        }) : undefined;
        const expectedRatio = priorVideo?.width && priorVideo?.height ? priorVideo.width / priorVideo.height : referenceFixture.width / referenceFixture.height;
        expect(stage!.width / stage!.height, 'The preview frame itself follows the displayed media dimensions, without decorative side strips').toBeCloseTo(expectedRatio, 2);
        const materialsBox = (await materials.boundingBox())!;
        expect(materialsBox.y, 'The material rail follows the media frame instead of covering its lower edge').toBeGreaterThanOrEqual(stage!.y + stage!.height - 1);
      }
      const timer = generation.getByLabel(kind === 'image' ? 'Image generation task timing' : 'Video generation task timing');
      await expect(timer).toBeVisible();
      await expect(timer).toContainText(/生成中 · \d+秒/u);
      expect(await generation.locator('.module-node__workbench-header > b').isVisible(), 'The real timer replaces the duplicate header state').toBe(false);
      if (previewCase === 'previous-result') {
        await expect(progress).toContainText(kind === 'image' ? '上一张结果保留' : '上一段视频保留');
        await expect(generation.getByRole('img', { name: '本次任务参考素材' })).toHaveCount(0);
        expect(await resultImage!.getAttribute('src'), 'The actual prior result source remains unchanged').toBe(originalResultSrc);
        await expect(resultImage!).toHaveCSS('object-fit', 'contain');
        if (referenceBuffer && kind === 'image') {
          const previousStage = generation.locator(kind === 'image' ? '.module-node__generation-editor-preview' : '.module-node__result');
          const sidePixels = await screenshotSideRanges(page, previousStage);
          expect(sidePixels.leftRange, 'The retained result contributes pixels on the left side instead of a flat strip').toBeGreaterThan(3);
          expect(sidePixels.rightRange, 'The retained result contributes pixels on the right side instead of a flat strip').toBeGreaterThan(3);
        }
      } else {
        expect(await generation.locator('.module-node__generation-empty-stage').evaluate(element => getComputedStyle(element).borderTopStyle))
          .toBe(kind === 'image' && previewCase === 'no-reference' ? 'none' : 'solid');
        await expect(progress.locator('.module-node__running-panel')).toHaveCSS('width', '264px');
        const previewBox = await generation.locator(kind === 'image' ? '.module-node__generation-editor-preview' : '.module-node__result').boundingBox();
        const fullState = await progress.boundingBox();
        expect(Math.abs(fullState!.width - previewBox!.width), 'The waiting surface fills the entire preview inside its border').toBeLessThanOrEqual(2);
        const reference = progress.getByRole('img', { name: '本次任务参考素材' });
        await expect(reference).toHaveCount(previewCase === 'reference' ? 1 : 0);
        if (previewCase === 'reference') {
          await expect(progress.getByText('参考素材', { exact: true })).toBeVisible();
          await expect(reference).toHaveCSS('object-fit', 'contain');
          const fullGeometry = await reference.evaluate((element: HTMLImageElement) => {
            const scale = Math.min(element.clientWidth / element.naturalWidth, element.clientHeight / element.naturalHeight);
            return { drawnWidth: element.naturalWidth * scale, drawnHeight: element.naturalHeight * scale,
              frameWidth: element.clientWidth, frameHeight: element.clientHeight, filter: getComputedStyle(element).filter };
          });
          expect(Math.abs(fullGeometry.drawnWidth - fullGeometry.frameWidth), 'The complete image uses the entire frame width').toBeLessThanOrEqual(2);
          expect(Math.abs(fullGeometry.drawnHeight - fullGeometry.frameHeight), 'The complete image uses the entire frame height').toBeLessThanOrEqual(2);
          expect(fullGeometry.filter).toBe('none');
          expect(await reference.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
          if (referenceBuffer) {
            const sidePixels = await screenshotSideRanges(page, progress);
            expect(sidePixels.leftRange, 'The real photo contributes pixels on the left side instead of a flat strip').toBeGreaterThan(3);
            expect(sidePixels.rightRange, 'The real photo contributes pixels on the right side instead of a flat strip').toBeGreaterThan(3);
          }
        }
      }
      for (const label of [progress.locator('strong'), progress.locator('p')]) {
        const lines = await label.evaluate(element => element.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(element).lineHeight));
        expect(lines, 'The short running title and status should each occupy one line').toBeLessThanOrEqual(1.01);
      }
      await generation.screenshot({ path: testInfo.outputPath(`${kind}-${previewCase}-running-${theme}.png`) });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await expect(progress.locator('svg')).toHaveCSS('animation-name', 'none');
      if (previewCase === 'reference') {
        const position = (await e2eState(page)).modulePositions.find(node => node.moduleType === moduleType)!.position;
        const dragHeader = async () => {
          const header = (await generation.locator('.module-node__heading').boundingBox())!;
          const x = header.x + Math.min(header.width / 2, 70);
          const y = header.y + header.height / 2;
          await page.mouse.move(x, y);
          await page.mouse.down();
          await page.mouse.move(x + 60, y + 24, { steps: 8 });
          await page.mouse.up();
        };
        await generation.getByRole('button', { name: '锁定位置 / Lock position', exact: true }).click();
        await expect(generation.getByRole('button', { name: '解锁位置 / Unlock position', exact: true })).toBeVisible();
        await dragHeader();
        expect((await e2eState(page)).modulePositions.find(node => node.moduleType === moduleType)!.position,
          'A real header drag cannot move a position-locked generation node').toEqual(position);
        await generation.getByRole('button', { name: '解锁位置 / Unlock position', exact: true }).click();
        await expect(generation.getByRole('button', { name: '锁定位置 / Lock position', exact: true })).toBeVisible();
        await dragHeader();
        await expect.poll(async () => (await e2eState(page)).modulePositions.find(node => node.moduleType === moduleType)!.position,
          'Unlocking restores actual node movement through the same header').not.toEqual(position);
        const movedPosition = (await e2eState(page)).modulePositions.find(node => node.moduleType === moduleType)!.position;
        await generation.getByRole('button', { name: kind === 'image' ? '折叠图片生成节点' : '折叠视频生成节点' }).click();
        await expect(prompt).toHaveCount(0);
        await expect(timer).toContainText(/生成中 · \d+秒/u);
        await generation.getByRole('button', { name: kind === 'image' ? 'Open image generation editor' : 'Open video generation editor' }).click();
        await expect(prompt).toHaveText(wholePrompt);
        expect(await parameterSnapshot()).toEqual(originalParameters);
        expect((await e2eState(page)).modulePositions.find(node => node.moduleType === moduleType)!.position).toEqual(movedPosition);
        await generation.getByRole('button', { name: '停止生成' }).click();
        await expect.poll(async () => (await e2eState(page)).modelJobs[0]?.status).toBe('cancelled');
        await expect(progress).toHaveCount(0);
        await expect(timer).toContainText('已取消');
        await expect(generation.getByRole('button', { name: kind === 'image' ? 'Generate image' : '生成视频' })).toBeEnabled();
      }
      expect((await e2eState(page)).modelSubmissions).toHaveLength(1);
    });
  }
  }
}

for (const kind of ['image', 'video'] as const) {
  for (const dimensions of [{ width: 720, height: 1280 }, { width: 960, height: 540 }, { width: 800, height: 800 }]) {
    test(`${kind} running frame follows the full ${dimensions.width}x${dimensions.height} media ratio`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: 1600, height: 2200 });
      await page.addInitScript(() => localStorage.setItem('novus.theme.mode', 'dark'));
      await openEmptyApp(page);
      const moduleType = kind === 'image' ? 'image_generation' : 'video_generation';
      await page.evaluate(async type => {
        await window.__NOVUS_E2E__!.createModule('image_input', { x: 40, y: 110 });
        await window.__NOVUS_E2E__!.createModule(type, { x: 440, y: 110 });
      }, moduleType);
      const fixture = makeReferenceImage('完整比例素材.png', [107, 158, 137, 255], dimensions);
      await queueProjectImageImport(page, fixture, { preservePixels: true });
      await page.locator('[data-module-type="image_input"]').getByRole('button', { name: /Import image/u }).click();
      await page.evaluate(async type => window.__NOVUS_E2E__!.connectModules('image_input', 'image', type, type === 'image_generation' ? 'references' : 'media'), moduleType);
      const generation = page.locator(`[data-module-type="${moduleType}"]`);
      await generation.getByRole('button', { name: kind === 'image' ? 'Open image generation editor' : 'Open video generation editor' }).click();
      await generation.getByRole('textbox', { name: kind === 'image' ? 'Image generation prompt' : 'Video preview prompt' }).fill('保留完整素材与真实比例');
      await generation.getByRole('button', { name: kind === 'image' ? 'Generate image' : '生成视频' }).click();
      await waitForModelSubmissions(page, 1);
      await expect(generation).toHaveAttribute('data-preview-sizing', 'media');
      const preview = generation.locator(kind === 'image' ? '.module-node__generation-editor-preview' : '.module-node__result');
      const image = generation.getByRole('img', { name: '本次任务参考素材' });
      await expect(image).toBeVisible();
      await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
      const geometry = await image.evaluate((element: HTMLImageElement) => {
        const box = element.getBoundingClientRect();
        const scale = Math.min(element.clientWidth / element.naturalWidth, element.clientHeight / element.naturalHeight);
        return { ratio: box.width / box.height, naturalWidth: element.naturalWidth, naturalHeight: element.naturalHeight,
          horizontalGap: element.clientWidth - element.naturalWidth * scale, verticalGap: element.clientHeight - element.naturalHeight * scale,
          fit: getComputedStyle(element).objectFit, filter: getComputedStyle(element).filter };
      });
      expect([geometry.naturalWidth, geometry.naturalHeight]).toEqual([dimensions.width, dimensions.height]);
      expect(geometry.ratio).toBeCloseTo(dimensions.width / dimensions.height, 2);
      expect(geometry.fit).toBe('contain');
      expect(geometry.filter).toBe('none');
      expect(Math.abs(geometry.horizontalGap)).toBeLessThanOrEqual(2);
      expect(Math.abs(geometry.verticalGap)).toBeLessThanOrEqual(2);
      const frame = (await preview.boundingBox())!;
      expect(frame.width / frame.height).toBeCloseTo(dimensions.width / dimensions.height, 2);
      await expect(generation.locator('.module-node__running-reference-fill, .module-node__running-result-fill')).toHaveCount(0);
      const materials = generation.getByLabel(kind === 'image' ? 'Image generation reference slots' : 'Connected video media editor', { exact: true });
      const materialsBox = (await materials.boundingBox())!;
      expect(materialsBox.y).toBeGreaterThanOrEqual(frame.y + frame.height - 1);
      const controls = (await generation.locator('.module-node__generation-control-bar').boundingBox())!;
      const card = (await generation.boundingBox())!;
      expect(controls.y).toBeGreaterThan(materialsBox.y + materialsBox.height);
      expect(controls.y + controls.height).toBeLessThanOrEqual(card.y + card.height + 1);
      await generation.screenshot({ path: testInfo.outputPath(`${kind}-${dimensions.width}x${dimensions.height}-full-frame.png`) });
      await generation.getByRole('button', { name: '停止生成' }).click();
      await expect.poll(async () => (await e2eState(page)).modelJobs[0]?.status).toBe('cancelled');
      expect((await e2eState(page)).modelSubmissions).toHaveLength(1);
    });
  }
}

for (const theme of ['dark', 'light'] as const) {
  for (const kind of ['image', 'video'] as const) {
    test(`${kind} real failure and retry controls remain usable in ${theme}`, async ({ page }) => {
      await page.addInitScript(mode => localStorage.setItem('novus.theme.mode', mode), theme);
      await openEmptyApp(page);
      const moduleType = kind === 'image' ? 'image_generation' : 'video_generation';
      await page.evaluate(type => window.__NOVUS_E2E__!.createModule(type, { x: 420, y: 110 }), moduleType);
      const generation = page.locator(`[data-module-type="${moduleType}"]`);
      await generation.getByRole('button', { name: kind === 'image' ? 'Open image generation editor' : 'Open video generation editor' }).click();
      await generation.getByRole('textbox', { name: kind === 'image' ? 'Image generation prompt' : 'Video preview prompt' }).fill('Keep the original generation parameters and retry only on user action');
      await failNextModelJobEnqueue(page);
      await generation.getByRole('button', { name: kind === 'image' ? 'Generate image' : '生成视频' }).click();
      await expect(generation.getByRole('alert')).toBeVisible();
      expect((await e2eState(page)).modelSubmissions).toHaveLength(0);
      const retry = generation.getByRole('button', { name: kind === 'image' ? '重新尝试生成' : '生成视频' });
      await expect(retry).toBeEnabled();
      await retry.click();
      await waitForModelSubmissions(page, 1);
      await expect(generation.getByRole('button', { name: '停止生成' })).toBeVisible();
      await expect(generation.getByRole('alert')).toHaveCount(0);
    });
  }
}
