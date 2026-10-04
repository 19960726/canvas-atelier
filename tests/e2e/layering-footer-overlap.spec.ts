import { readFile, writeFile } from 'node:fs/promises';
import { readPsd } from 'ag-psd';
import { test, expect } from './helpers/e2e-test';
import { e2eState, openEmptyApp, queueProjectImageImport } from './helpers/app';
import { makeReferenceImage } from './helpers/fixtures';

for (const theme of ['light', 'dark'] as const) {
  for (const width of [1100, 1600]) {
    test(`overlapping five-layer results keep all four footer labels inside their buttons in ${theme} at ${width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 1600 });
      await page.addInitScript(value => localStorage.setItem('novus.theme.mode', value), theme);
      const externalRequests: string[] = [];
      const pageErrors: string[] = [];
      page.on('pageerror', error => pageErrors.push(error.message));
      page.on('request', request => {
        if (/^https?:/u.test(request.url()) && !/^https?:\/\/(127\.0\.0\.1|localhost):/u.test(request.url())) externalRequests.push(request.url());
      });
      await openEmptyApp(page);
      await page.evaluate(async () => {
        await window.__NOVUS_E2E__!.createModule('image_input', { x: 40, y: 100 });
        await window.__NOVUS_E2E__!.createModule('image_layering', { x: 420, y: 100 });
        for (let index = 0; index < 5; index++) await window.__NOVUS_E2E__!.createModule('image_layer', { x: 1500 + index * 360, y: 100 });
      });
      const source = page.locator('[data-module-type="image_input"]');
      const assets: string[] = [];
      for (let index = 0; index < 6; index++) {
        await queueProjectImageImport(page, makeReferenceImage(`Footer source-space pixels ${index}.png`,
          [90 + index * 10, 140, 110, index < 2 ? 255 : 200], { width: 40, height: 50 }), { preservePixels: true });
        await source.getByRole('button', { name: index === 0 ? /Import image/u : /Replace image/u }).click();
        assets.push((await e2eState(page)).projectImages.at(-1)!.assetId);
      }
      const names = ['厨房背景与水槽', '便携杯盖组件', '人物手部与衣袖', '冲洗水流与水花水滴', '不锈钢电热杯本体'];
      const layerIds = (await e2eState(page)).modulePositions.filter(node => node.moduleType === 'image_layer').map(node => node.id);
      await page.evaluate(async ({ assets, layerIds, names }) => {
        for (let index = 0; index < layerIds.length; index++) await window.__NOVUS_E2E__!.configureModuleById(layerIds[index]!, {
          config: { groupId: 'footer-overlap', layerId: `footer-${index}`, layerKind: index === 0 ? 'background' : 'transparent',
            name: names[index], order: index, resultAssetId: assets[index + 1], sourceAssetId: assets[0],
            resultWidth: 40, resultHeight: 50, canvasWidth: 40, canvasHeight: 50,
            pixelMode: 'source', maskSpace: 'source', qualityStatus: 'passed', qualityValidationVersion: 2,
            status: 'completed', visible: true, sourceBounds: { x: 0, y: 0, width: 1, height: 1 } },
          execution: { state: 'completed' },
        });
        await window.__NOVUS_E2E__!.configureModule('image_layering', { config: {
          groupId: 'footer-overlap', canvasWidth: 40, canvasHeight: 50, sourceAssetId: assets[0],
          pixelMode: 'source', layerSelection: { mode: 'whole' }, backgroundMode: 'preserve', layers: [],
          planLayers: names.map((name, index) => ({ layerId: `footer-${index}`, kind: index === 0 ? 'background' : 'transparent',
            name, description: '已返回的原图坐标蒙版，故意重叠以复现待修整错误态', order: index })),
        } });
      }, { assets, layerIds, names });
      const node = page.locator('[data-module-type="image_layering"]');
      await expect(node.getByRole('alert')).toContainText('图层内容重叠，暂不能正式合成或导出正式 PSD');
      const actions = node.locator('.image-layering__actions');
      await expect(actions.getByRole('button')).toHaveCount(4);
      await expect(actions.getByRole('button', { name: '导出 PSD', exact: true })).toBeDisabled();
      await expect(actions.getByRole('button', { name: '在 Photoshop 中打开', exact: true })).toBeDisabled();
      await expect(actions.getByRole('button', { name: '导出待修整 PSD', exact: true })).toBeEnabled();
      await expect(actions.getByRole('button', { name: '在 Photoshop 中打开待修整 PSD', exact: true })).toBeEnabled();
      const geometry = await node.evaluate(element => {
        const actions = element.querySelector('.image-layering__actions') as HTMLElement;
        const body = element.querySelector('.image-layering__body') as HTMLElement;
        const nodeRect = element.getBoundingClientRect();
        const actionsRect = actions.getBoundingClientRect();
        return {
          actionsOutsideScroll: !body.contains(actions), footerOverflow: actions.scrollWidth - actions.clientWidth,
          footerInsideNode: actionsRect.left >= nodeRect.left && actionsRect.right <= nodeRect.right && actionsRect.bottom <= nodeRect.bottom,
          buttons: [...actions.querySelectorAll('button')].map(button => {
            const rect = button.getBoundingClientRect();
            const range = document.createRange(); range.selectNodeContents(button);
            const textRects = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0);
            return { text: button.textContent, width: button.offsetWidth, height: button.offsetHeight,
              overflowX: button.scrollWidth - button.clientWidth, overflowY: button.scrollHeight - button.clientHeight,
              textInsideButton: textRects.every(text => text.left >= rect.left - 1 && text.right <= rect.right + 1
                && text.top >= rect.top - 1 && text.bottom <= rect.bottom + 1) };
          }),
        };
      });
      await writeFile(testInfo.outputPath('footer-geometry.json'), JSON.stringify({ theme, width, geometry, paidCalls: 0 }, null, 2), { flag: 'wx' });
      await node.screenshot({ path: testInfo.outputPath('overlap-workbench.png') });
      await actions.screenshot({ path: testInfo.outputPath('overlap-footer.png') });
      expect(geometry.actionsOutsideScroll).toBe(true);
      expect(geometry.footerInsideNode).toBe(true);
      expect(geometry.footerOverflow, JSON.stringify(geometry)).toBeLessThanOrEqual(1);
      for (const button of geometry.buttons) {
        expect(button.textInsideButton, JSON.stringify(button)).toBe(true);
        expect(button.overflowX, JSON.stringify(button)).toBeLessThanOrEqual(1);
        expect(button.overflowY, JSON.stringify(button)).toBeLessThanOrEqual(1);
      }
      const downloadPromise = page.waitForEvent('download', { timeout: 10_000 });
      await actions.getByRole('button', { name: '导出待修整 PSD', exact: true }).click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toBe('canvas-atelier-layers-to-repair.psd');
      const bytes = await readFile((await download.path())!);
      const psd = readPsd(bytes, { skipLayerImageData: true, skipCompositeImageData: true, skipThumbnail: true });
      expect([psd.width, psd.height, psd.children?.length]).toEqual([40, 50, 6]);
      expect(psd.children?.map(layer => layer.hidden)).toEqual([false, true, true, true, true, true]);
      await page.evaluate(() => {
        window.novusDesktop!.projectImages.openLayeredPsdInPhotoshop = async payload => {
          (window as typeof window & { __footerDraftPsd?: number[] }).__footerDraftPsd = [...payload]; return { ok: true };
        };
      });
      await actions.getByRole('button', { name: '在 Photoshop 中打开待修整 PSD', exact: true }).click();
      await expect.poll(() => page.evaluate(() => (window as typeof window & { __footerDraftPsd?: number[] }).__footerDraftPsd?.length ?? 0)).toBe(bytes.length);
      expect(await page.evaluate(() => (window as typeof window & { __footerDraftPsd?: number[] }).__footerDraftPsd)).toEqual([...bytes]);
      await expect(actions.getByRole('button', { name: '导出 PSD', exact: true })).toBeDisabled();
      expect((await e2eState(page)).modelSubmissions).toHaveLength(0);
      expect(pageErrors).toEqual([]); expect(externalRequests).toEqual([]);
      await testInfo.attach('footer-geometry', { body: JSON.stringify(geometry), contentType: 'application/json' });
    });
  }
}
