import { readFile } from 'node:fs/promises';
import { initializeCanvas, readPsd, type Layer } from 'ag-psd';
import type { Page } from '@playwright/test';
import { test, expect } from './helpers/e2e-test';
import { e2eState, openEmptyApp, queueProjectImageImport } from './helpers/app';
import { fixturePng } from '../../apps/renderer/src/test/rgba-png-fixture';

initializeCanvas(() => { throw new Error('PSD readback uses stored channel data'); },
  (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }) as ImageData);

const exportName = '\u5bfc\u51fa PSD';
const solid = (width: number, height: number, rgba: readonly number[]) =>
  Uint8Array.from(Array.from({ length: width * height }, () => rgba).flat());
const alphas = [1, 8, 32, 64, 128, 255, 0] as const;

function foregroundPixels(width: number, height: number) {
  return Uint8Array.from(Array.from({ length: width * height }, (_, pixel) =>
    [37 + pixel % 5, 83 + pixel % 7, 129 + pixel % 11, alphas[pixel % alphas.length]!]).flat());
}

async function importRasters(page: Page, rasters: readonly { width: number; height: number; pixels: Uint8Array }[]) {
  const input = page.locator('[data-module-type="image_input"]');
  const ids: string[] = [];
  for (const [index, raster] of rasters.entries()) {
    const displayUrl = fixturePng(raster.pixels, raster.width, raster.height);
    await queueProjectImageImport(page, { name: `straight-pixels-${index}.png`, mimeType: 'image/png',
      width: raster.width, height: raster.height, buffer: Buffer.from(displayUrl.split(',')[1]!, 'base64') }, { preservePixels: true });
    await input.getByRole('button', { name: index ? /Replace image/u : /Import image/u }).click();
    const asset = (await e2eState(page)).projectImages.at(-1)!;
    expect(asset.displayUrl).toBe(displayUrl);
    ids.push(asset.assetId);
  }
  return ids;
}

async function downloadPsd(page: Page) {
  const group = page.locator('[data-module-type="image_layering"]');
  await expect(group.getByRole('button', { name: exportName, exact: true })).toBeEnabled();
  const downloaded = page.waitForEvent('download');
  await group.getByRole('button', { name: exportName, exact: true }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe('canvas-atelier-layers.psd');
  return readPsd(new Uint8Array(await readFile((await download.path())!)), { useImageData: true, skipThumbnail: true });
}

function expectLayer(layer: Layer, pixels: Uint8Array, bounds: readonly number[], hidden = false) {
  expect([layer.left, layer.top, layer.right, layer.bottom]).toEqual(bounds);
  expect(layer.hidden).toBe(hidden);
  expect(Array.from(layer.imageData!.data)).toEqual(Array.from(pixels));
}

for (const theme of ['light', 'dark'] as const) {
  test(`generated PSD keeps straight low-alpha bytes, coordinates, order and visibility after reopen in ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.addInitScript(value => localStorage.setItem('novus.theme.mode', value), theme);
    const errors: string[] = [], external: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      if (/^https?:/u.test(request.url()) && !/^https?:\/\/(127\.0\.0\.1|localhost):/u.test(request.url())) external.push(request.url());
    });
    await openEmptyApp(page);
    await page.evaluate(async () => {
      await window.__NOVUS_E2E__!.createModule('image_input', { x: 40, y: 100 });
      await window.__NOVUS_E2E__!.createModule('image_layering', { x: 420, y: 100 });
    });
    const background = solid(8, 6, [20, 30, 40, 255]);
    const foreground = foregroundPixels(6, 4);
    const overlay = Uint8Array.from([170, 91, 63, 8, 87, 126, 199, 64, 99, 113, 127, 0, 188, 92, 53, 128]);
    const assets = await importRasters(page, [{ width: 8, height: 6, pixels: background },
      { width: 6, height: 4, pixels: foreground }, { width: 2, height: 2, pixels: overlay }]);
    await page.evaluate(async assets => window.__NOVUS_E2E__!.configureModule('image_layering', { config: {
      pixelMode: 'generated', canvasWidth: 8, canvasHeight: 6, layerSelection: { mode: 'whole' },
      layers: [
        { layerId: 'background', kind: 'background', name: 'Background', assetId: assets[0], x: 0, y: 0, width: 8, height: 6, visible: true, opacity: 1 },
        { layerId: 'foreground', kind: 'transparent', name: 'Foreground', assetId: assets[1], x: 1, y: 1, width: 6, height: 4, visible: true, opacity: 1 },
        { layerId: 'overlay', kind: 'transparent', name: 'Overlay', assetId: assets[2], x: 2, y: 2, width: 2, height: 2, visible: true, opacity: 1 },
      ],
    } }), assets);
    const group = page.locator('[data-module-type="image_layering"]');
    await group.getByRole('button', { name: '\u9690\u85cf\u56fe\u5c42 Overlay' }).click();
    await group.getByRole('button', { name: '\u4e0b\u79fb\u56fe\u5c42 Overlay' }).click();
    await page.evaluate(() => window.__NOVUS_E2E__!.reopenProject());
    await expect(group.getByRole('button', { name: '\u663e\u793a\u56fe\u5c42 Overlay' })).toBeVisible();
    await expect(group.getByRole('list', { name: '\u5206\u5c42\u56fe\u5c42' }).getByRole('listitem').nth(1)).toContainText('Overlay');
    await group.screenshot({ path: testInfo.outputPath('generated-straight-pixels.png') });
    const psd = await downloadPsd(page);
    expect([psd.width, psd.height]).toEqual([8, 6]);
    expect(psd.children!.map(layer => layer.name)).toEqual(['Background', 'Overlay', 'Foreground']);
    expectLayer(psd.children![0]!, background, [0, 0, 8, 6]);
    expectLayer(psd.children![1]!, overlay, [2, 2, 4, 4], true);
    expectLayer(psd.children![2]!, foreground, [1, 1, 7, 5]);
    expect((await e2eState(page)).modelSubmissions).toHaveLength(0);
    expect(errors).toEqual([]); expect(external).toEqual([]);
  });

  test(`regional generated PSD preserves the outside source and native returned resolution in ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.addInitScript(value => localStorage.setItem('novus.theme.mode', value), theme);
    const errors: string[] = [], external: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      if (/^https?:/u.test(request.url()) && !/^https?:\/\/(127\.0\.0\.1|localhost):/u.test(request.url())) external.push(request.url());
    });
    await openEmptyApp(page);
    await page.evaluate(async () => {
      await window.__NOVUS_E2E__!.createModule('image_input', { x: 40, y: 100 });
      await window.__NOVUS_E2E__!.createModule('image_layering', { x: 420, y: 100 });
      await window.__NOVUS_E2E__!.createModule('image_layer', { x: 1400, y: 100 });
      await window.__NOVUS_E2E__!.createModule('image_layer', { x: 1800, y: 100 });
    });
    const source = solid(6, 4, [90, 80, 70, 255]);
    const background = solid(12, 8, [20, 30, 40, 255]);
    const foreground = foregroundPixels(12, 8);
    const assets = await importRasters(page, [{ width: 6, height: 4, pixels: source },
      { width: 12, height: 8, pixels: background }, { width: 12, height: 8, pixels: foreground }]);
    const layerNodes = (await e2eState(page)).modulePositions.filter(node => node.moduleType === 'image_layer').map(node => node.id);
    await page.evaluate(async ({ assets, layerNodes }) => {
      for (let index = 0; index < layerNodes.length; index++) await window.__NOVUS_E2E__!.configureModuleById(layerNodes[index]!, { config: {
        groupId: 'generated-region-native', layerId: index ? 'foreground' : 'background', layerKind: index ? 'transparent' : 'background',
        name: index ? 'Foreground' : 'Background', order: index, sourceAssetId: assets[0], resultAssetId: assets[index + 1],
        canvasWidth: 6, canvasHeight: 4, resultWidth: 12, resultHeight: 8, pixelMode: 'generated',
        qualityStatus: 'passed', qualityValidationVersion: 2, formatQualityStatus: 'passed', qualityFormatCheckedAssetId: assets[index + 1],
        status: 'completed', visible: true,
      } });
      await window.__NOVUS_E2E__!.configureModule('image_layering', { config: {
        groupId: 'generated-region-native', sourceAssetId: assets[0], pixelMode: 'generated', canvasWidth: 6, canvasHeight: 4,
        layerSelection: { mode: 'region', box: { x: .25, y: .25, width: .5, height: .5 } }, layers: [],
        planLayers: [{ layerId: 'background', kind: 'background', name: 'Background', order: 0 },
          { layerId: 'foreground', kind: 'transparent', name: 'Foreground', order: 1 }],
      } });
    }, { assets, layerNodes });
    await page.evaluate(() => window.__NOVUS_E2E__!.reopenProject());
    const group = page.locator('[data-module-type="image_layering"]');
    await group.screenshot({ path: testInfo.outputPath('generated-region-native.png') });
    const psd = await downloadPsd(page);
    expect([psd.width, psd.height]).toEqual([12, 8]);
    expect(psd.children!.map(layer => layer.name)).toEqual(['Background', 'Foreground']);
    const expectedBackground = background.slice(), expectedForeground = new Uint8Array(foreground.length);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 12; x++) {
      const offset = (y * 12 + x) * 4;
      if (x >= 3 && x < 9 && y >= 2 && y < 6) expectedForeground.set(foreground.subarray(offset, offset + 4), offset);
      else expectedBackground.set([90, 80, 70, 255], offset);
    }
    expectLayer(psd.children![0]!, expectedBackground, [0, 0, 12, 8]);
    const restored = new Uint8Array(foreground.length), fg = psd.children![1]!;
    expect([fg.left, fg.top, fg.right, fg.bottom]).toEqual([2, 1, 10, 7]);
    for (let y = 0; y < fg.imageData!.height; y++) restored.set(
      fg.imageData!.data.subarray(y * fg.imageData!.width * 4, (y + 1) * fg.imageData!.width * 4),
      ((fg.top! + y) * 12 + fg.left!) * 4);
    expect(Array.from(restored)).toEqual(Array.from(expectedForeground));
    expect((await e2eState(page)).modelSubmissions).toHaveLength(0);
    expect(errors).toEqual([]); expect(external).toEqual([]);
  });
}
