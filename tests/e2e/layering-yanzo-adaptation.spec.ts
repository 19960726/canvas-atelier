import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './helpers/e2e-test';
import { e2eState, openEmptyApp, queueProjectImageImport } from './helpers/app';
import { makeReferenceImage } from './helpers/fixtures';

const output = path.join(process.cwd(), 'work', process.env.CANVAS_LAYERING_FLOW_AUDIT_DIR ?? 'qa-layering-yanzo-2026-09-24');

for (const theme of ['light', 'dark'] as const) {
  test(`adapts layering parameters and result review in ${theme} without supplier calls`, async ({ page }) => {
    await mkdir(output, { recursive: true });
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
    await page.screenshot({ path: path.join(output, `${theme}-parameters-auto.png`), fullPage: true });
    await dialog.getByRole('button', { name: '自定义层数' }).click();
    await dialog.getByRole('slider', { name: '目标图层数' }).fill('12');
    await expect(dialog.getByText('12 层')).toBeVisible();
    await page.screenshot({ path: path.join(output, `${theme}-parameters-custom-12.png`), fullPage: true });
    await dialog.getByRole('slider', { name: '目标图层数' }).fill('3');
    await expect(dialog.getByText('3 层')).toBeVisible();
    await page.screenshot({ path: path.join(output, `${theme}-parameters.png`), fullPage: true });
    await dialog.getByRole('slider', { name: '目标图层数' }).fill('5');
    await expect(dialog.getByText('5 层')).toBeVisible();
    await page.evaluate(() => window.__NOVUS_E2E__!.queueLayeringAnalysisReply(JSON.stringify({ layers: [
      { layerId: 'background', kind: 'background', name: '厨房台面背景', description: '补全产品与摆件移除后露出的台面区域', included: true },
      { layerId: 'product-main', kind: 'transparent', name: '蓝色咖啡机', description: '仅咖啡机本体像素，不包含底部接触阴影', included: true },
      { layerId: 'prop-vase', kind: 'transparent', name: '左侧玻璃花瓶', description: '仅花瓶本体像素，不包含投影', included: true },
      { layerId: 'shadow-product', kind: 'transparent', name: '咖啡机接触阴影', description: '仅咖啡机底部接触阴影，不包含机器像素', included: true },
      { layerId: 'shadow-vase', kind: 'transparent', name: '花瓶投影', description: '仅花瓶投影像素，不包含花瓶本体', included: true },
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
    await page.screenshot({ path: path.join(output, `${theme}-semantic-plan.png`), fullPage: true });
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
    await page.screenshot({ path: path.join(output, `${theme}-review-model-selected.png`), fullPage: true });
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
    await page.screenshot({ path: path.join(output, `${theme}-progress-original.png`), fullPage: true });

    const results = [
      makeReferenceImage('YANZO background.png', [66, 88, 104, 255], { width: 320, height: 240 }),
      makeReferenceImage('YANZO subject.png', [222, 121, 63, 128], { width: 320, height: 240 }),
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
    }
    await expect(composite.getByRole('button', { name: '导出 PSD' })).toBeEnabled();
    await composite.getByRole('button', { name: '原图' }).click();
    await expect(composite.getByRole('img', { name: '原图预览', exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(output, `${theme}-result-original.png`), fullPage: true });
    await composite.getByRole('button', { name: '合成图' }).click();
    await expect(composite.getByRole('img', { name: '合成预览', exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(output, `${theme}-result-composite.png`), fullPage: true });
    expect((await e2eState(page)).modelSubmissions).toHaveLength(0);
    expect(externalRequests).toEqual([]);
    await writeFile(path.join(output, `${theme}-result.json`), JSON.stringify({ theme, modelSubmissions: 0, externalRequests,
      screens: ['parameters-auto', 'parameters-custom-12', 'parameters-custom-3', 'review-model-selected', 'semantic-plan',
        'progress-original', 'result-original', 'result-composite'] }, null, 2));
  });
}
