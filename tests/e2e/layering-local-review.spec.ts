import { readFile } from 'node:fs/promises';
import { initializeCanvas, readPsd } from 'ag-psd';
import { test, expect } from './helpers/e2e-test';
import { e2eState, openEmptyApp, queueProjectImageImport } from './helpers/app';
import { fixturePng } from '../../apps/renderer/src/test/rgba-png-fixture';

initializeCanvas(() => { throw new Error('PSD readback uses image data, not a canvas'); },
  (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }) as ImageData);

for (const theme of ['light', 'dark']) {
  test(`local review unlocks the exact RGBA snapshot and survives reopen in ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1600 });
    await page.addInitScript(value => localStorage.setItem('novus.theme.mode', value), theme);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await openEmptyApp(page);
    await page.evaluate(async () => {
      await window.__NOVUS_E2E__!.createModule('image_input', { x: 20, y: 120 });
      await window.__NOVUS_E2E__!.createModule('image_layering', { x: 420, y: 120 });
      await window.__NOVUS_E2E__!.createModule('image_layer', { x: 1000, y: 120 });
      await window.__NOVUS_E2E__!.createModule('image_layer', { x: 1000, y: 620 });
      await window.__NOVUS_E2E__!.createModule('image_layer', { x: 1000, y: 1120 });
    });
    const background = new Uint8Array(24 * 24 * 4), foreground = new Uint8Array(background.length), blue = new Uint8Array(background.length);
    for (let i = 3; i < background.length; i += 4) background[i] = 255;
    const sourcePixels = background.slice();
    for (let y = 4; y < 10; y++) for (let x = 4; x < 10; x++) {
      foreground.set([255, 0, 0, 128], (y * 24 + x) * 4);
      sourcePixels.set([128, 0, 0, 255], (y * 24 + x) * 4);
    }
    for (let y = 12; y < 18; y++) for (let x = 12; x < 18; x++) {
      blue.set([0, 0, 255, 32], (y * 24 + x) * 4);
      sourcePixels.set([0, 0, 32, 255], (y * 24 + x) * 4);
    }
    const sourceNode = page.locator('[data-module-type="image_input"]'), assetIds: string[] = [];
    for (const [index, pixels] of [sourcePixels, background, foreground, blue].entries()) {
      await queueProjectImageImport(page, { name: `local-review-${index}.png`, mimeType: 'image/png', width: 24, height: 24,
        buffer: Buffer.from(fixturePng(pixels, 24, 24).split(',')[1]!, 'base64') }, { preservePixels: true });
      await sourceNode.getByRole('button', { name: index ? /Replace image/u : /Import image/u }).click();
      assetIds.push((await e2eState(page)).projectImages.at(-1)!.assetId);
    }
    const layerNodes = (await e2eState(page)).modulePositions.filter(node => node.moduleType === 'image_layer').map(node => node.id);
    await page.evaluate(async ({ layerNodes, assetIds }) => {
      for (let index = 0; index < layerNodes.length; index++) await window.__NOVUS_E2E__!.configureModuleById(layerNodes[index]!, { config: {
        groupId: 'local-review', layerId: index ? `foreground-${index}` : 'background', layerKind: index ? 'transparent' : 'background',
        name: ['纯黑背景', '红色半透明物体', '蓝色低透明物体'][index], description: '独立物理颜色测试', order: index, sourceAssetId: assetIds[0],
        resultAssetId: assetIds[index + 1], resultWidth: 24, resultHeight: 24, canvasWidth: 24, canvasHeight: 24,
        pixelMode: 'source', maskSpace: 'source', sourceBounds: { x: 0, y: 0, width: 1, height: 1 },
        // The real serial queue must decode every current asset; no prefilled format proof.
        qualityStatus: 'pending', status: 'validating', needsReconfirm: true,
        ...(index ? { layeringOutputContract: 'source-independent-rgba-v2', resultRepresentation: 'independent-rgba-candidate' } : {}),
      } });
      await window.__NOVUS_E2E__!.configureModule('image_layering', { config: { groupId: 'local-review', sourceAssetId: assetIds[0],
        pixelMode: 'source', canvasWidth: 24, canvasHeight: 24, backgroundMode: 'replace', layerSelection: { mode: 'whole' },
        needsReconfirm: true, status: 'validating', planLayers: [
          { layerId: 'background', kind: 'background', name: '纯黑背景', description: '独立物理颜色测试', order: 0 },
          { layerId: 'foreground-1', kind: 'transparent', name: '红色半透明物体', description: '独立物理颜色测试', order: 1,
            sourceBounds: { x: 0, y: 0, width: 1, height: 1 } },
          { layerId: 'foreground-2', kind: 'transparent', name: '蓝色低透明物体', description: '独立物理颜色测试', order: 2,
            sourceBounds: { x: 0, y: 0, width: 1, height: 1 } },
        ] } });
    }, { layerNodes, assetIds });
    const group = page.locator('[data-module-type="image_layering"]');
    await expect(group.getByRole('button', { name: '导出 PSD', exact: true })).toBeDisabled();
    await expect(group.getByRole('button', { name: '导出待修整 PSD', exact: true })).toBeEnabled();
    await group.getByRole('button', { name: '检查并确认图层' }).click();
    const dialog = page.getByRole('dialog', { name: '检查当前分层' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: '完成本地检查' })).toBeDisabled();
    await dialog.getByRole('combobox', { name: '检查图层' }).selectOption('foreground-2');
    await expect(dialog.getByRole('img', { name: '待检查图层' })).toBeVisible();
    await dialog.getByRole('button', { name: '深底检查' }).click();
    await dialog.screenshot({ path: testInfo.outputPath('local-review.png') });
    for (const checkbox of await dialog.getByRole('checkbox').all()) await checkbox.check();
    await dialog.getByRole('button', { name: '完成本地检查' }).click();
    await expect(dialog).toBeHidden();
    await expect(group.getByRole('button', { name: '导出 PSD', exact: true })).toBeEnabled();
    await page.evaluate(() => window.__NOVUS_E2E__!.reopenProject());
    await expect(group.getByRole('button', { name: '导出 PSD', exact: true })).toBeEnabled();
    const downloadPromise = page.waitForEvent('download');
    await group.getByRole('button', { name: '导出 PSD', exact: true }).click();
    const download = await downloadPromise;
    const psd = readPsd(new Uint8Array(await readFile((await download.path())!)), { useImageData: true });
    expect([psd.width, psd.height]).toEqual([24, 24]);
    expect(psd.children?.map(layer => layer.name)).toEqual(['纯黑背景', '红色半透明物体', '蓝色低透明物体']);
    const fg = psd.children![1]!;
    // Export retains the established one-pixel transparent safety margin.
    expect([fg.left, fg.top, fg.right, fg.bottom]).toEqual([3, 3, 11, 11]);
    const restored = new Uint8Array(foreground.length);
    for (let y = 0; y < fg.imageData!.height; y++) restored.set(
      fg.imageData!.data.subarray(y * fg.imageData!.width * 4, (y + 1) * fg.imageData!.width * 4),
      ((fg.top! + y) * 24 + fg.left!) * 4);
    expect(Array.from(restored)).toEqual(Array.from(foreground));
    const blueLayer = psd.children![2]!;
    expect([blueLayer.left, blueLayer.top, blueLayer.right, blueLayer.bottom]).toEqual([11, 11, 19, 19]);
    const restoredBlue = new Uint8Array(blue.length);
    for (let y = 0; y < blueLayer.imageData!.height; y++) restoredBlue.set(
      blueLayer.imageData!.data.subarray(y * blueLayer.imageData!.width * 4, (y + 1) * blueLayer.imageData!.width * 4),
      ((blueLayer.top! + y) * 24 + blueLayer.left!) * 4);
    expect(Array.from(restoredBlue)).toEqual(Array.from(blue));
    expect(Array.from(psd.imageData!.data)).toEqual(Array.from(sourcePixels));
    expect((await e2eState(page)).modelSubmissions).toHaveLength(0);
    expect(errors).toEqual([]);
  });
}
