import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from './helpers/e2e-test';
import { e2eState, openEmptyApp, queueProjectImageImport } from './helpers/app';

const evidenceDir = path.join(process.cwd(), 'work', 'qa-layering-user-image-20260924', 'final-r6');
const sourcePath = path.join(process.cwd(), 'work', 'qa-layering-user-image-20260924', 'source-image.png');
const layerPlan = [
  { layerId: 'warm-background', kind: 'background', name: '暖灰色渐变背景', description: '补全海报的暖灰色背景，不含产品、文字或图形。', included: true },
  { layerId: 'podium', kind: 'transparent', name: '底部弧形展台', description: '画面底部的棕色弧形台面，不含产品本体。', included: true },
  { layerId: 'heater-device', kind: 'transparent', name: '透明加热杯产品', description: '居中的杯盖、透明杯身、底座和控制面板，保留原有材质与尺寸；不含蒸汽和外围光效。', included: true },
  { layerId: 'heat-glow', kind: 'transparent', name: '杯身热效光环', description: '杯身外围橙色发光环和上升箭头，不含杯体像素。', included: true },
  { layerId: 'steam', kind: 'transparent', name: '杯盖上方蒸汽', description: '杯盖上方可见的淡白色蒸汽，不含背景。', included: true },
  { layerId: 'headline', kind: 'transparent', name: '2min 速热标题', description: '左上 2min 与速热的原图文字像素，不假称可编辑字体。', included: true },
  { layerId: 'headline-secondary', kind: 'transparent', name: '比暖奶器还快标题', description: '顶部第二行比暖奶器还快的原图文字像素。', included: true },
  { layerId: 'subheadline', kind: 'transparent', name: '80W 功率说明', description: '80W 大功率、316 聚能发热盘和下方说明的原图文字像素。', included: true },
  { layerId: 'comparison-card', kind: 'transparent', name: '底部时长对比卡底板', description: '下方圆角浅色卡片及底板，不含文字和数据条。', included: true },
  { layerId: 'comparison-labels', kind: 'transparent', name: '加热时长标签', description: '卡片左侧加热时长文字的原图像素。', included: true },
  { layerId: 'fast-bar', kind: 'transparent', name: '恒温杯加热 2min 对比条', description: '上方蓝色 2min 对比条及其文字，保持原图位置。', included: true },
  { layerId: 'slow-bar', kind: 'transparent', name: '普通暖奶器 7min 对比条', description: '下方灰色 7min 对比条及其文字，保持原图位置。', included: true },
] as const;

test('uses the supplied poster pixels for a zero-credit layering flow and checks the visible node sockets', async ({ page }) => {
  test.setTimeout(120_000);
  await mkdir(evidenceDir, { recursive: true });
  const buffer = await readFile(sourcePath);
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  expect(sha256).toBe('63993fdcc46f070884691a76f0e83660422f3690d8313d12e208dcb5485f3d3c');
  await page.setViewportSize({ width: 1600, height: 1100 });
  await openEmptyApp(page);
  const externalRequests: string[] = [];
  page.on('request', (request) => {
    if (/^https?:/u.test(request.url()) && !/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\//u.test(request.url())) externalRequests.push(request.url());
  });
  await page.evaluate(async () => {
    await window.__NOVUS_E2E__!.createModule('image_input', { x: 50, y: 180 });
    await window.__NOVUS_E2E__!.createModule('image_generation', { x: 460, y: 100 });
  });
  await queueProjectImageImport(page, { name: 'heater-poster-user-image.png', mimeType: 'image/png', buffer, width: 658, height: 1208 }, { preservePixels: true });
  await page.locator('[data-module-type="image_input"]').getByRole('button', { name: /Import image/u }).click();
  const image = (await e2eState(page)).projectImages.at(-1)!;
  expect(image.displayUrl).toBe(`data:image/png;base64,${buffer.toString('base64')}`);
  await page.evaluate(async (assetId) => window.__NOVUS_E2E__!.configureModule('image_generation', {
    config: { resultState: 'fresh', resultAssetIds: [assetId] },
    execution: { state: 'completed' },
  }), image.assetId);
  const generation = page.locator('[data-module-type="image_generation"]');
  await generation.getByRole('button', { name: 'Open image generation editor' }).click();
  await generation.getByRole('button', { name: 'AI 分层' }).click();
  const dialog = page.getByRole('dialog', { name: 'AI 图片分层' });
  await expect(dialog.getByRole('combobox', { name: '视觉分析模型' })).toBeVisible();
  await page.screenshot({ path: path.join(evidenceDir, '01-user-poster-analysis.png'), fullPage: true });
  await page.evaluate((layers) => window.__NOVUS_E2E__!.queueLayeringAnalysisReply(JSON.stringify({ layers })), layerPlan);
  await dialog.getByRole('button', { name: '分析图片' }).click();
  const names = dialog.getByRole('list', { name: '可编辑分层方案' }).getByRole('textbox', { name: /^图层名称/u });
  await expect(names).toHaveCount(12);
  expect(await names.evaluateAll((elements) => elements.map((element) => (element as HTMLInputElement).value)))
    .toEqual(layerPlan.map((layer) => layer.name));
  await page.screenshot({ path: path.join(evidenceDir, '02-user-poster-editable-plan.png'), fullPage: true });
  await dialog.getByRole('button', { name: '下一步：确认生成' }).click();
  await expect(dialog.getByRole('region', { name: '生成确认摘要' })).toBeVisible();
  const confirmGeneration = dialog.getByRole('button', { name: '确认生成 12 层' });
  await expect(confirmGeneration).toBeDisabled();
  await confirmGeneration.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(evidenceDir, '03-user-poster-generation-blocked.png'), fullPage: true });
  await dialog.getByRole('button', { name: '关闭 AI 图片分层' }).click();
  expect((await e2eState(page)).modelSubmissions).toHaveLength(0);
  expect(externalRequests).toEqual([]);

  await page.evaluate(async ({ assetId, layers }) => window.__NOVUS_E2E__!.seedImageLayeringGroup(assetId, 658, 1208, layers), { assetId: image.assetId, layers: layerPlan });
  const layering = page.locator('[data-module-type="image_layering"]');
  await expect(layering).toHaveCount(1);
  const visibleInputs = layering.locator('.react-flow__handle[data-port-direction="input"]:not([data-visual-alias="true"])');
  const visibleOutputs = layering.locator('.react-flow__handle[data-port-direction="output"]:not([data-visual-alias="true"])');
  await expect(visibleInputs).toHaveCount(1);
  await expect(visibleOutputs).toHaveCount(1);
  await expect(layering.locator('.react-flow__handle[data-port-id="layerImages"][data-visual-alias="true"]')).toHaveCount(1);
  await page.locator('.react-flow__controls-fitview').evaluate((button) => (button as HTMLButtonElement).click());
  await page.screenshot({ path: path.join(evidenceDir, '04-user-poster-layering-graph.png'), fullPage: true });
  await openEmptyApp(page);
  await page.evaluate(async () => window.__NOVUS_E2E__!.createModule('image_layering', { x: 480, y: 120 }));
  const standaloneLayering = page.locator('[data-module-type="image_layering"]');
  await expect(standaloneLayering.locator('.react-flow__handle[data-port-direction="input"]:not([data-visual-alias="true"])')).toHaveCount(1);
  await expect(standaloneLayering.locator('.react-flow__handle[data-port-direction="output"]:not([data-visual-alias="true"])')).toHaveCount(1);
  await page.screenshot({ path: path.join(evidenceDir, '05-layering-node-sockets-normal-scale.png'), fullPage: true });
  await writeFile(path.join(evidenceDir, 'verification.json'), JSON.stringify({
    sourcePath, sha256, width: 658, height: 1208, importedAssetId: image.assetId,
    planSource: 'local test reply drafted from the supplied poster; no provider analysis',
    layerNames: layerPlan.map((layer) => layer.name),
    trueTransparentPixelsGenerated: false, confirmationBlocked: true,
    providerSubmissions: 0, externalRequests, visibleInputSockets: 1, visibleOutputSockets: 1,
  }, null, 2), 'utf8');
});
