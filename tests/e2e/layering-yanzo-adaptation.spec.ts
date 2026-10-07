import { writeFile } from 'node:fs/promises';
import { test, expect } from './helpers/e2e-test';
import { e2eState, openEmptyApp, queueProjectImageImport } from './helpers/app';
import { makeReferenceImage } from './helpers/fixtures';
import { fixturePng } from '../../apps/renderer/src/test/rgba-png-fixture';

for (const theme of ['light', 'dark'] as const) {
  test(`adapts layering parameters and result review in ${theme} without supplier calls`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1600, height: 1100 });
    await page.addInitScript((nextTheme) => localStorage.setItem('novus.theme.mode', nextTheme), theme);
    const externalRequests: string[] = [];
    page.on('request', (request) => {
      if (/^https?:/u.test(request.url()) && !/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\//u.test(request.url())) externalRequests.push(request.url());
    });
    await openEmptyApp(page);
    await page.evaluate(async () => {
      await window.__NOVUS_E2E__!.createModule('image_input', { x: 80, y: 260 });
      await window.__NOVUS_E2E__!.createModule('image_generation', { x: 470, y: 110 });
    });
    const imageInput = page.locator('[data-module-type="image_input"]');
    const generation = page.locator('[data-module-type="image_generation"]');
    await queueProjectImageImport(page, makeReferenceImage('YANZO adapted source.png', [185, 209, 230, 255], { width: 320, height: 240 }), { preservePixels: true });
    await imageInput.getByRole('button', { name: /Import image/u }).click();
    const sourceAssetId = (await e2eState(page)).projectImages.at(-1)!.assetId;
    await page.evaluate(async (assetId) => window.__NOVUS_E2E__!.configureModule('image_generation', {
      config: { resultState: 'fresh', resultAssetIds: [assetId] }, execution: { state: 'completed' },
    }), sourceAssetId);
    await generation.getByRole('button', { name: 'Open image generation editor' }).click();
    await generation.getByRole('button', { name: 'AI 分层' }).click();
    const dialog = page.getByRole('dialog', { name: 'AI 图片分层' });
    await expect(dialog.getByRole('button', { name: '智能层数' })).toHaveAttribute('aria-pressed', 'true');
    await page.screenshot({ path: testInfo.outputPath(`${theme}-parameters-auto.png`), fullPage: true });
    await dialog.getByRole('button', { name: '自定义层数' }).click();
    await dialog.getByRole('slider', { name: '目标图层数' }).fill('12');
    await expect(dialog.getByText('12 层')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`${theme}-parameters-custom-12.png`), fullPage: true });
    await dialog.getByRole('slider', { name: '目标图层数' }).fill('3');
    await expect(dialog.getByText('3 层')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`${theme}-parameters.png`), fullPage: true });
    await dialog.getByRole('slider', { name: '目标图层数' }).fill('5');
    await expect(dialog.getByText('5 层')).toBeVisible();
    await page.evaluate(() => window.__NOVUS_E2E__!.queueLayeringAnalysisReply(JSON.stringify({ layers: [
      { layerId: 'background', kind: 'background', name: '厨房台面背景', description: '补全产品与摆件移除后露出的台面区域', included: true, elementIds: ['background'] },
      { layerId: 'product-main', kind: 'transparent', name: '蓝色咖啡机', description: '仅咖啡机本体像素，不包含底部接触阴影', included: true, sourceBounds: { x: .45, y: .15, width: .4, height: .65 }, elementIds: ['product-main'] },
      { layerId: 'prop-vase', kind: 'transparent', name: '左侧玻璃花瓶', description: '仅花瓶本体像素，不包含投影', included: true, sourceBounds: { x: .1, y: .3, width: .25, height: .5 }, elementIds: ['prop-vase'] },
      { layerId: 'shadow-product', kind: 'transparent', name: '咖啡机接触阴影', description: '仅咖啡机底部接触阴影，不包含机器像素', included: true, sourceBounds: { x: .4, y: .75, width: .5, height: .15 }, elementIds: ['shadow-product'] },
      { layerId: 'shadow-vase', kind: 'transparent', name: '花瓶投影', description: '仅花瓶投影像素，不包含花瓶本体', included: true, sourceBounds: { x: .05, y: .75, width: .35, height: .15 }, elementIds: ['shadow-vase'] },
    ], elements: [
      { elementId: 'background', name: '厨房台面背景', layerId: 'background', kind: 'object' },
      { elementId: 'product-main', name: '蓝色咖啡机', layerId: 'product-main', kind: 'object' },
      { elementId: 'prop-vase', name: '左侧玻璃花瓶', layerId: 'prop-vase', kind: 'object' },
      { elementId: 'shadow-product', name: '咖啡机接触阴影', layerId: 'shadow-product', kind: 'shadow', carrierElementId: 'product-main' },
      { elementId: 'shadow-vase', name: '花瓶投影', layerId: 'shadow-vase', kind: 'shadow', carrierElementId: 'prop-vase' },
    ] })));
    await dialog.getByRole('button', { name: '分析图片' }).click();
    const planList = dialog.getByRole('list', { name: '可编辑分层方案' });
    await expect(planList.getByRole('listitem')).toHaveCount(5);
    await expect(planList.getByRole('textbox', { name: '图层名称 蓝色咖啡机' })).toBeVisible();
    await expect(planList.getByRole('textbox', { name: '图层说明 咖啡机接触阴影' })).toHaveValue('仅咖啡机底部接触阴影，不包含机器像素');
    await expect(planList).toHaveCSS('overflow-y', 'visible');
    await planList.evaluate((list) => {
      const controls = list.closest<HTMLElement>('.image-layering-dialog__controls')!;
      const section = list.closest<HTMLElement>('.image-layering-dialog__plan-section')!;
      controls.scrollTop += section.getBoundingClientRect().top - controls.getBoundingClientRect().top;
    });
    await page.screenshot({ path: testInfo.outputPath(`${theme}-semantic-plan.png`), fullPage: true });
    await dialog.getByRole('button', { name: '下一步：确认生成' }).click();
    await expect(dialog.getByRole('region', { name: '生成确认摘要' })).toContainText('自定义目标 5 层');
    const modelSelect = dialog.getByRole('combobox', { name: 'GPT 图像模型' });
    await expect(modelSelect).toBeInViewport();
    await expect(modelSelect).toBeEnabled();
    const options = await modelSelect.locator('option').evaluateAll(options => options.map(option => ({ value: (option as HTMLOptionElement).value, text: option.textContent ?? '' })));
    expect(options.length).toBeGreaterThan(1);
    const flare = options.find((option) => /^GPT Image 2\.5 Flare\s*·/u.test(option.text ?? ''));
    expect(flare, 'the configured Flare route should be selectable').toBeDefined();
    await modelSelect.selectOption(flare!.value);
    const resolutionSelect = dialog.getByRole('combobox', { name: '输出分辨率' });
    await expect(resolutionSelect.locator('option[value="4K"]')).toHaveCount(1);
    await resolutionSelect.selectOption('4K');
    await expect(dialog.getByRole('region', { name: '生成确认摘要' })).toBeVisible();
    await expect(modelSelect).toHaveValue(flare!.value);
    const modelSummary = dialog.locator('.image-layering-dialog__summary > span').filter({ hasText: '生成模型' });
    const resolutionSummary = dialog.locator('.image-layering-dialog__summary > span').filter({ hasText: '分辨率' });
    await expect(modelSummary).toHaveText('生成模型GPT Image 2.5 Flare');
    await expect(resolutionSummary).toHaveText('分辨率4K');
    await expect(resolutionSelect).toHaveValue('4K');
    await expect(dialog.getByRole('button', { name: '确认生成 5 层' })).toBeEnabled();
    await expect(dialog.getByRole('combobox', { name: '输出分辨率' })).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath(`${theme}-review-model-selected.png`), fullPage: true });
    await dialog.getByRole('button', { name: '关闭 AI 图片分层' }).click();

    await page.evaluate(async (assetId) => window.__NOVUS_E2E__!.seedImageLayeringGroup(assetId, 320, 240, [
      { layerId: 'background', kind: 'background', name: '背景', description: '原场景', included: true },
      { layerId: 'subject', kind: 'transparent', name: '主体', description: '主体像素', included: true },
    ]), sourceAssetId);
    const composite = page.locator('[data-module-type="image_layering"]');
    await page.locator('.react-flow__controls-fitview').evaluate((button) => (button as HTMLButtonElement).click());
    await expect(composite.getByRole('img', { name: '原图预览', exact: true })).toBeVisible();
    await expect(composite.getByRole('button', { name: '导出 PSD' })).toBeDisabled();
    await composite.getByRole('button', { name: '同步任务状态' }).click();
    await page.screenshot({ path: testInfo.outputPath(`${theme}-progress-original.png`), fullPage: true });

    const subjectPixels = new Uint8Array(320 * 240 * 4);
    for (let y = 2; y < 238; y++) for (let x = 2; x < 318; x++) {
      subjectPixels.set([222, 121, 63, 128], (y * 320 + x) * 4);
    }
    const results = [
      makeReferenceImage('YANZO background.png', [66, 88, 104, 255], { width: 320, height: 240 }),
      { name: 'YANZO subject.png', mimeType: 'image/png' as const, width: 320, height: 240,
        buffer: Buffer.from(fixturePng(subjectPixels, 320, 240).split(',')[1]!, 'base64') },
    ];
    const layerIds = (await e2eState(page)).modulePositions.filter((node) => node.moduleType === 'image_layer').map((node) => node.id);
    for (const [index, fixture] of results.entries()) {
      await queueProjectImageImport(page, fixture, { preservePixels: true });
      await imageInput.getByRole('button', { name: /Replace image/u }).click();
      const assetId = (await e2eState(page)).projectImages.at(-1)!.assetId;
      await page.evaluate(async ({ nodeId, resultAssetId }) => window.__NOVUS_E2E__!.configureModuleById(nodeId, {
        config: { resultAssetId, resultWidth: 320, resultHeight: 240, qualityStatus: 'passed', status: 'completed' },
        execution: { state: 'completed' },
      }), { nodeId: layerIds[index]!, resultAssetId: assetId });
      const resultImage = page.locator(`.react-flow__node[data-id="${layerIds[index]!}"] .image-layer-node__preview img`);
      await expect(resultImage).toBeVisible();
      await expect.poll(() => resultImage.evaluate((image: HTMLImageElement) => ({ complete: image.complete,
        width: image.naturalWidth, height: image.naturalHeight, src: image.getAttribute('src') })))
        .toEqual({ complete: true, width: fixture.width, height: fixture.height,
          src: `data:image/png;base64,${fixture.buffer.toString('base64')}` });
    }
    await expect(composite.getByRole('button', { name: '导出 PSD' })).toBeEnabled();
    await composite.getByRole('button', { name: '原图', exact: true }).click();
    await expect(composite.getByRole('img', { name: '原图预览', exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`${theme}-result-original.png`), fullPage: true });
    await composite.getByRole('button', { name: '合成图' }).click();
    const compositePreview = composite.getByRole('img', { name: '合成预览', exact: true });
    await expect(compositePreview).toBeVisible();
    await expect(compositePreview.locator('img')).toHaveCount(2);
    for (const image of await compositePreview.locator('img').all()) await expect(image).toBeVisible();
    await expect.poll(() => compositePreview.locator('img').evaluateAll(images => images.map(element => {
      const image = element as HTMLImageElement;
      return { complete: image.complete, width: image.naturalWidth, height: image.naturalHeight, src: image.getAttribute('src') };
    }))).toEqual(results.map(fixture => ({ complete: true, width: fixture.width, height: fixture.height,
      src: `data:image/png;base64,${fixture.buffer.toString('base64')}` })));
    const compositeBox = (await compositePreview.boundingBox())!;
    expect(compositeBox.width / compositeBox.height).toBeCloseTo(4 / 3, 2);
    await page.screenshot({ path: testInfo.outputPath(`${theme}-result-composite.png`), fullPage: true });
    expect((await e2eState(page)).modelSubmissions).toHaveLength(0);
    expect(externalRequests).toEqual([]);
    await writeFile(testInfo.outputPath(`${theme}-result.json`), JSON.stringify({ theme, modelSubmissions: 0, externalRequests,
      screens: ['parameters-auto', 'parameters-custom-12', 'parameters-custom-3', 'review-model-selected', 'semantic-plan',
        'progress-original', 'result-original', 'result-composite'] }, null, 2));
  });
}
