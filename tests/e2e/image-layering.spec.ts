import { mkdir } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readPsd } from 'ag-psd';
import { test, expect } from './helpers/e2e-test';
import { e2eState, openEmptyApp, queueProjectImageImport } from './helpers/app';
import { makeReferenceImage } from './helpers/fixtures';

const visualArtifactDirectory = path.join(process.cwd(), 'work', process.env.CANVAS_LAYERING_UI_AUDIT_DIR ?? 'qa-layering-ui-2026-09-23');

for (const theme of ['light', 'dark'] as const) {
  test(`seven-layer workbench keeps proportional previews and accessible export actions in ${theme}`, async ({ page }) => {
    await mkdir(visualArtifactDirectory, { recursive: true });
    await page.setViewportSize({ width: 1600, height: 1100 });
    await page.addInitScript(nextTheme => localStorage.setItem('novus.theme.mode', nextTheme), theme);
    await openEmptyApp(page);
    await page.evaluate(async () => {
      await window.__NOVUS_E2E__!.createModule('image_input', { x: 40, y: 140 });
      await window.__NOVUS_E2E__!.createModule('image_layering', { x: 440, y: 140 });
    });
    const assetIds: string[] = [];
    const input = page.locator('[data-module-type="image_input"]');
    for (let i = 0; i < 7; i++) {
      await queueProjectImageImport(page, makeReferenceImage(`Workbench layout ${i}.png`, [60 + i * 10, 148, 132, i === 0 ? 255 : 128], { width: 300, height: 200 }), { preservePixels: true });
      await input.getByRole('button', { name: i === 0 ? /Import image/u : /Replace image/u }).click();
      assetIds.push((await e2eState(page)).projectImages.at(-1)!.assetId);
    }
    await page.evaluate(async assetIds => window.__NOVUS_E2E__!.configureModule('image_layering', { config: {
      canvasWidth: 300, canvasHeight: 200, sourceAssetId: assetIds[0],
      layers: Array.from({ length: 7 }, (_, i) => ({ layerId: `layout-${i}`, kind: i === 0 ? 'background' : 'transparent',
        name: i === 0 ? '背景' : `前景 ${i}`, assetId: assetIds[i], x: 0, y: 0, width: 300, height: 200, visible: true, opacity: 1 })),
    } }), assetIds);
    await page.locator('.react-flow__controls-fitview').evaluate(button => (button as HTMLButtonElement).click());
    const node = page.locator('[data-module-type="image_layering"]');
    await expect(node.getByText('图层工作台', { exact: true })).toHaveCount(0);
    await expect(node.getByText('预览、整理与导出', { exact: true })).toHaveCount(0);
    const list = node.getByRole('list', { name: '分层图层' });
    await expect(list.getByRole('listitem')).toHaveCount(7);
    await expect(node.getByRole('button', { name: '导出 PSD' })).toBeEnabled();
    const geometry = await node.evaluate(element => {
      const list = element.querySelector('.image-layering__list') as HTMLElement;
      const preview = element.querySelector('.image-layering__preview') as HTMLElement;
      const thumbnail = element.querySelector('.image-layering__thumbnail') as HTMLElement;
      const actions = element.querySelector('.image-layering__actions') as HTMLElement;
      const photoshopButton = actions.querySelector('[aria-label="在 Photoshop 中打开"]') as HTMLElement;
      const exportButton = actions.querySelector('.image-layering__export') as HTMLElement;
      const body = element.querySelector('.image-layering__body') as HTMLElement;
      return { listOverflow: list.scrollHeight - list.clientHeight, previewRatio: preview.offsetWidth / preview.offsetHeight,
        previewHeight: preview.offsetHeight, thumbnailWidth: thumbnail.offsetWidth,
        listHeight: list.clientHeight, listStyle: getComputedStyle(list).cssText,
        listPadding: getComputedStyle(list).padding, rowHeights: [...list.children].map(row => (row as HTMLElement).offsetHeight),
        photoshopText: getComputedStyle(photoshopButton).color, photoshopBackground: getComputedStyle(photoshopButton).backgroundColor,
        exportText: getComputedStyle(exportButton).color, exportBackground: getComputedStyle(exportButton).backgroundColor,
        bodyOverflow: body.scrollHeight - body.clientHeight, actionsOutsideScroll: !body.contains(actions) };
    });
    expect(geometry.listOverflow, JSON.stringify(geometry)).toBeLessThanOrEqual(1);
    expect(geometry.previewHeight).toBeLessThanOrEqual(210);
    expect(geometry.previewRatio).toBeCloseTo(1.5, 2);
    expect(geometry.thumbnailWidth).toBeGreaterThanOrEqual(48);
    expect(geometry.actionsOutsideScroll).toBe(true);
    expect(geometry.bodyOverflow).toBeLessThanOrEqual(1);
    expect(geometry.photoshopText).not.toEqual(geometry.photoshopBackground);
    expect(geometry.exportText).not.toEqual(geometry.exportBackground);
    await node.getByRole('button', { name: '原图', exact: true }).click();
    await expect(node.getByRole('img', { name: '原图预览区域' })).toBeVisible();
    await node.getByRole('button', { name: '合成图', exact: true }).click();
    await node.getByRole('button', { name: '隐藏图层 前景 6' }).click();
    await expect(node.getByRole('button', { name: '显示图层 前景 6' })).toBeVisible();
    await node.getByRole('button', { name: '下移图层 前景 3' }).click();
    await expect(list.getByRole('listitem').nth(2)).toContainText('前景 3');
    await list.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect(node.getByRole('button', { name: '导出 PSD' })).toBeVisible();
    await expect(node.getByRole('button', { name: '在 Photoshop 中打开', exact: true })).toBeVisible();
    await node.screenshot({ path: path.join(visualArtifactDirectory, `workbench-seven-${theme}.png`) });
    expect((await e2eState(page)).modelSubmissions).toHaveLength(0);
  });
}

for (const theme of ['light', 'dark'] as const) {
  test(`captures the AI layering toolbar and independent canvas layers in ${theme} without provider jobs`, async ({ page }) => {
    await mkdir(visualArtifactDirectory, { recursive: true });
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.addInitScript((nextTheme) => localStorage.setItem('novus.theme.mode', nextTheme), theme);
    await openEmptyApp(page);
    await page.evaluate(async () => {
      await window.__NOVUS_E2E__!.createModule('image_input', { x: 80, y: 310 });
      await window.__NOVUS_E2E__!.createModule('image_generation', { x: 470, y: 140 });
    });
    const input = page.locator('[data-module-type="image_input"]');
    const generation = page.locator('[data-module-type="image_generation"]');
    const fixtures = [
      makeReferenceImage('AI layering source.png', [206, 218, 228, 255], { width: 320, height: 240 }),
      makeReferenceImage('AI layering background.png', [40, 76, 110, 255], { width: 320, height: 240 }),
      makeReferenceImage('AI layering subject.png', [226, 120, 54, 128], { width: 320, height: 240 }),
      makeReferenceImage('AI layering detail.png', [24, 148, 132, 255], { width: 320, height: 240 }),
    ];
    await queueProjectImageImport(page, fixtures[0]!, { preservePixels: true });
    await input.getByRole('button', { name: /Import image/u }).click();
    const sourceAssetId = (await e2eState(page)).projectImages.at(-1)!.assetId;
    await page.evaluate(async (assetId) => window.__NOVUS_E2E__!.configureModule('image_generation', {
      config: { resultState: 'fresh', resultAssetIds: [assetId] },
      execution: { state: 'completed' },
    }), sourceAssetId);

    await generation.getByRole('button', { name: 'Open image generation editor' }).click();
    await expect(generation.getByRole('button', { name: '图片颜色校正' })).toBeVisible();
    const colorTool = generation.getByRole('button', { name: '图片颜色校正' });
    const layeringTool = generation.getByRole('button', { name: 'AI 分层' });
    await expect(layeringTool).toBeVisible();
    const colorToolBounds = await colorTool.boundingBox();
    const layeringToolBounds = await layeringTool.boundingBox();
    expect(colorToolBounds).not.toBeNull();
    expect(layeringToolBounds).not.toBeNull();
    expect(Math.abs(layeringToolBounds!.y - colorToolBounds!.y)).toBeLessThanOrEqual(2);
    expect(layeringToolBounds!.x).toBeGreaterThan(colorToolBounds!.x);
    await generation.getByLabel('Image result tools').screenshot({ path: path.join(visualArtifactDirectory, `layering-toolbar-detail-${theme}.png`) });
    await page.screenshot({ path: path.join(visualArtifactDirectory, `layering-toolbar-${theme}.png`), fullPage: true });
    await generation.getByRole('button', { name: 'AI 分层' }).click();
    const dialog = page.getByRole('dialog', { name: 'AI 图片分层' });
    await expect(dialog.getByRole('img', { name: '分层源图：AI layering source' })).toBeVisible();
    await expect(dialog.getByText('当前阶段')).toBeVisible();
    await expect(dialog.getByText('读取源图，返回可编辑分层方案')).toBeVisible();
    await expect(dialog.getByText('只分析')).toBeVisible();
    const dialogBackgroundAlpha = await dialog.evaluate((element) => {
      const background = getComputedStyle(element).backgroundColor;
      const rgba = background.match(/^rgba\([^,]+,\s*[^,]+,\s*[^,]+,\s*([\d.]+)\)$/u);
      return rgba ? Number(rgba[1]) : background.startsWith('rgb(') ? 1 : 0;
    });
    expect(dialogBackgroundAlpha, 'The dialog card must be opaque in both themes; only the page backdrop may dim the canvas.').toBe(1);
    if (theme === 'dark') {
      await expect(dialog).toHaveCSS('background-color', 'rgb(32, 37, 35)');
    }
    await expect(dialog.getByRole('combobox', { name: '视觉分析模型' })).toBeEnabled();
    await expect(dialog.getByRole('button', { name: '分析图片' })).toBeEnabled();
    await page.screenshot({ path: path.join(visualArtifactDirectory, `layering-dialog-${theme}.png`), fullPage: true });
    expect((await e2eState(page)).modelSubmissions).toHaveLength(0);
    await dialog.getByRole('button', { name: '关闭 AI 图片分层' }).click();

    const assetIds = [sourceAssetId];
    for (let index = 1; index < fixtures.length; index += 1) {
      await queueProjectImageImport(page, fixtures[index]!, { preservePixels: true });
      await input.getByRole('button', { name: /Replace image/u }).click();
      assetIds.push((await e2eState(page)).projectImages.at(-1)!.assetId);
    }
    await page.evaluate(async ({ source, width, height }) => window.__NOVUS_E2E__!.seedImageLayeringGroup(source, width, height, [
      { layerId: 'background', kind: 'background', name: '背景', description: '原场景背景', included: true },
      { layerId: 'subject', kind: 'transparent', name: '主体', description: '产品主体透明层', included: true },
      { layerId: 'detail', kind: 'transparent', name: '细节', description: '前景细节透明层', included: true },
    ]), { source: sourceAssetId, width: 320, height: 240 });
    const nodes = await e2eState(page);
    const layerIds = nodes.modulePositions.filter((node) => node.moduleType === 'image_layer').map((node) => node.id);
    expect(layerIds).toHaveLength(3);
    for (let index = 0; index < layerIds.length; index += 1) {
      await page.evaluate(async ({ nodeId, assetId, name, kind }) => window.__NOVUS_E2E__!.configureModuleById(nodeId, {
        config: {
          resultAssetId: assetId, resultWidth: 320, resultHeight: 240, qualityStatus: 'passed', status: 'completed',
          name, layerKind: kind, visible: true,
        },
        execution: { state: 'completed' },
      }), { nodeId: layerIds[index]!, assetId: assetIds[index + 1]!, name: ['背景', '主体', '细节'][index]!, kind: ['background', 'transparent', 'transparent'][index]! });
    }
    await page.locator('.react-flow__controls-fitview').evaluate((button) => (button as HTMLButtonElement).click());
    const layerNodes = page.locator('[data-module-type="image_layer"]');
    await expect(layerNodes).toHaveCount(3);
    await expect(layerNodes.nth(0).locator('.image-layer-node__heading strong')).toHaveText('背景');
    await expect(layerNodes.nth(1).getByRole('button', { name: /隐藏图层 主体/u })).toBeVisible();
    const composite = page.locator('[data-module-type="image_layering"]');
    // Legacy passed flags do not authorize unreviewed full-frame materials.
    await expect(composite.getByRole('button', { name: '导出 PSD', exact: true })).toBeDisabled();
    await expect(composite.getByRole('button', { name: '在 Photoshop 中打开', exact: true })).toBeDisabled();
    await expect(composite.locator('.image-layering__progress-heading')).toContainText('需复核');
    await expect(layerNodes.nth(2).getByRole('status')).toHaveText('透明层没有透明像素，不能作为独立前景层。');
    await expect.poll(async () => (await e2eState(page)).edgeCount).toBeGreaterThanOrEqual(4);
    await page.screenshot({ path: path.join(visualArtifactDirectory, `independent-layer-nodes-${theme}.png`), fullPage: true });
    expect((await e2eState(page)).modelSubmissions).toHaveLength(0);
  });
}

test('layering node preserves order and visibility after reopen and exports independent PSD layers', async ({ page }) => {
  await openEmptyApp(page);
  await page.evaluate(async () => {
    await window.__NOVUS_E2E__!.createModule('image_input', { x: 40, y: 140 });
    await window.__NOVUS_E2E__!.createModule('image_layering', { x: 420, y: 140 });
  });
  const node = page.locator('[data-module-type="image_layering"]');
  await expect(node.getByText(/GPT Image 透明背景路由/u)).toBeVisible();
  await expect(node.getByRole('button', { name: '自动分层' })).toHaveCount(0);
  await expect(node.getByRole('button', { name: '导出 PSD' })).toBeDisabled();

  const names = ['Background', 'Subject', 'Glass', 'Logo'];
  const colors: Array<[number, number, number, number]> = [
    [240, 240, 240, 255], [255, 0, 0, 128], [0, 0, 255, 128], [0, 255, 0, 128],
  ];
  const input = page.locator('[data-module-type="image_input"]');
  const assetIds: string[] = [];
  for (let index = 0; index < names.length; index += 1) {
    await queueProjectImageImport(page, makeReferenceImage(`${names[index]}.png`, colors[index]!, { width: 2, height: 2 }), { preservePixels: true });
    await input.getByRole('button', { name: index === 0 ? /Import image/u : /Replace image/u }).click();
    assetIds.push((await e2eState(page)).projectImages.at(-1)!.assetId);
  }
  const layers = assetIds.map((assetId, index) => ({
    layerId: `layer-${index}`, kind: index === 0 ? 'background' : 'transparent', name: names[index],
    assetId, x: 0, y: 0, width: 2, height: 2, visible: true, opacity: 1,
  }));
  await page.evaluate(async (config) => {
    await window.__NOVUS_E2E__!.configureModule('image_layering', { config });
  }, { canvasWidth: 2, canvasHeight: 2, layers });
  await expect(node.getByRole('list', { name: '分层图层' }).getByRole('listitem')).toHaveCount(4);
  await node.getByRole('button', { name: '隐藏图层 Logo' }).click();
  await node.getByRole('button', { name: '下移图层 Glass' }).click();
  await expect(node.getByRole('list', { name: '分层图层' }).getByRole('listitem').nth(1)).toContainText('Glass');
  await page.evaluate(() => window.__NOVUS_E2E__!.reopenProject());
  await expect(node.getByRole('button', { name: '显示图层 Logo' })).toBeVisible();
  await expect(node.getByRole('list', { name: '分层图层' }).getByRole('listitem').nth(1)).toContainText('Glass');
  await node.getByRole('button', { name: '预览图层 Subject' }).click();
  await expect(node.getByRole('img', { name: '透明图层 Subject' })).toBeVisible();

  const downloadPromise = page.waitForEvent('download');
  await node.getByRole('button', { name: '导出 PSD' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('canvas-atelier-layers.psd');
  const bytes = await readFile((await download.path())!);
  expect(bytes.toString('ascii', 0, 4)).toBe('8BPS');
  const psd = readPsd(new Uint8Array(bytes), { skipLayerImageData: true, skipCompositeImageData: true, skipThumbnail: true });
  expect([psd.width, psd.height, psd.bitsPerChannel]).toEqual([2, 2, 8]);
  expect(psd.children?.map(layer => [layer.name, layer.hidden])).toEqual([
    ['Background', false], ['Glass', false], ['Subject', false], ['Logo', true],
  ]);

  await page.evaluate(() => {
    window.novusDesktop!.projectImages.openLayeredPsdInPhotoshop = async (payload) => {
      (window as typeof window & { __openedLayeredPsd?: number[] }).__openedLayeredPsd = [...payload];
      return { ok: true };
    };
  });
  await node.getByRole('button', { name: '在 Photoshop 中打开' }).click();
  try {
    await expect.poll(() => page.evaluate(() => (window as typeof window & { __openedLayeredPsd?: number[] }).__openedLayeredPsd?.length ?? 0))
      .toBe(bytes.length);
  } catch (error) {
    const state = await page.evaluate(() => ({
      alert: document.querySelector('.image-layering [role="alert"]')?.textContent ?? null,
      buttonDisabled: (document.querySelector('.image-layering__actions button:last-child') as HTMLButtonElement | null)?.disabled ?? null,
      openedBytes: (window as typeof window & { __openedLayeredPsd?: number[] }).__openedLayeredPsd?.length ?? 0,
    }));
    throw new Error(`PSD Photoshop callback did not run: ${JSON.stringify(state)}`, { cause: error });
  }
  expect(await page.evaluate(() => (window as typeof window & { __openedLayeredPsd?: number[] }).__openedLayeredPsd))
    .toEqual([...bytes]);
});
