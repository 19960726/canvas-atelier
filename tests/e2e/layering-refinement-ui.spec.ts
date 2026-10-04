import { writeFile } from 'node:fs/promises';
import { test, expect } from './helpers/e2e-test';
import { e2eState, openEmptyApp, queueProjectImageImport } from './helpers/app';
import { makeReferenceImage } from './helpers/fixtures';

for (const theme of ['light', 'dark'] as const) {
  for (const viewport of [{ width: 1100, height: 760 }, { width: 1600, height: 900 }, { width: 640, height: 760 }]) {
    test(`refinement tools and persistent actions fit ${theme} ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      await page.addInitScript(value => localStorage.setItem('novus.theme.mode', value), theme);
      const errors: string[] = [], requests: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => {
        if (/^https?:/u.test(request.url()) && !/^https?:\/\/(127\.0\.0\.1|localhost):/u.test(request.url())) requests.push(request.url());
      });
      await openEmptyApp(page);
      await page.evaluate(async () => {
        await window.__NOVUS_E2E__!.createModule('image_input', { x: 20, y: 80 });
        await window.__NOVUS_E2E__!.createModule('image_layering', { x: 360, y: 80 });
        await window.__NOVUS_E2E__!.createModule('image_layer', { x: 1500, y: 80 });
      });
      const input = page.locator('[data-module-type="image_input"]'), ids: string[] = [];
      for (let index = 0; index < 2; index++) {
        await queueProjectImageImport(page, makeReferenceImage(`refinement-${index}.png`,
          [110, 150, 130, index === 0 ? 255 : 180], { width: 400, height: 500 }), { preservePixels: true });
        await input.getByRole('button', { name: index === 0 ? /Import image/u : /Replace image/u }).click();
        ids.push((await e2eState(page)).projectImages.at(-1)!.assetId);
      }
      const layerId = (await e2eState(page)).modulePositions.find(node => node.moduleType === 'image_layer')!.id;
      await page.evaluate(async ({ ids, layerId }) => {
        await window.__NOVUS_E2E__!.configureModuleById(layerId, { config: {
          groupId: 'refinement-ui', layerId: 'hands', name: '人物手部与衣袖', layerKind: 'transparent',
          sourceAssetId: ids[0], resultAssetId: ids[1], canvasWidth: 400, canvasHeight: 500,
          resultWidth: 400, resultHeight: 500, sourceBounds: { x: 0, y: 0, width: 1, height: 1 },
          pixelMode: 'source', maskSpace: 'source', qualityStatus: 'passed', qualityValidationVersion: 2,
          status: 'completed', mattingRegions: Array.from({ length: 40 }, (_, index) => ({
            mode: index % 2 ? 'clear' : 'keep', box: { x: .02 + index % 8 * .1, y: .02 + Math.floor(index / 8) * .15, width: .03, height: .03 },
          })),
        } });
        await window.__NOVUS_E2E__!.configureModule('image_layering', { config: {
          groupId: 'refinement-ui', sourceAssetId: ids[0], canvasWidth: 400, canvasHeight: 500,
          pixelMode: 'source', layerSelection: { mode: 'whole' }, backgroundMode: 'preserve', layers: [],
          planLayers: [{ layerId: 'hands', kind: 'transparent', name: '人物手部与衣袖', order: 1, description: 'UI geometry fixture' }],
        } });
      }, { ids, layerId });
      await page.locator('[data-module-type="image_layering"]').getByRole('button', { name: '本地抠图与边缘精修' }).click();
      const dialog = page.getByRole('dialog', { name: '边缘精修', exact: true });
      await expect(dialog).toBeVisible();
      await dialog.screenshot({ path: testInfo.outputPath('refinement-open.png') });
      const geometry = await dialog.evaluate(element => {
        const dialog = element as HTMLElement, rect = dialog.getBoundingClientRect();
        const actions = [...dialog.querySelectorAll('button')].filter(button => /^(应用本地精修|关闭精修)$/u.test(button.getAttribute('aria-label') ?? button.textContent ?? ''));
        const stage = dialog.querySelector('.image-layering-dialog__source-stage') as HTMLElement;
        const sidebar = dialog.querySelector('.source-refinement__sidebar') as HTMLElement | null;
        return { rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          overflowX: dialog.scrollWidth - dialog.clientWidth, viewportHeight: innerHeight,
          stage: stage.getBoundingClientRect().toJSON(), sidebar: sidebar?.getBoundingClientRect().toJSON() ?? null,
          background: getComputedStyle(dialog).backgroundColor,
          workspaceSurface: getComputedStyle(document.querySelector('.workspace--canvas-layout')!).getPropertyValue('--gate-card').trim(),
          actions: actions.map(button => { const box = button.getBoundingClientRect(); return {
            label: button.getAttribute('aria-label') ?? button.textContent,
            inside: box.top >= 0 && box.bottom <= innerHeight && box.left >= 0 && box.right <= innerWidth,
            width: box.width, height: box.height, overflow: button.scrollWidth - button.clientWidth,
          }; }),
        };
      });
      await writeFile(testInfo.outputPath('refinement-geometry.json'), JSON.stringify({ theme, viewport, geometry, paidCalls: 0 }, null, 2), { flag: 'wx' });
      expect(geometry.actions).toHaveLength(2);
      for (const action of geometry.actions) { expect(action.inside, JSON.stringify(geometry)).toBe(true); expect(action.overflow).toBeLessThanOrEqual(1); }
      expect(geometry.overflowX).toBeLessThanOrEqual(1);
      expect(geometry.stage.height).toBeGreaterThanOrEqual(200);
      expect(geometry.sidebar).not.toBeNull();
      if (viewport.width >= 720) expect(geometry.stage.right).toBeLessThanOrEqual(geometry.sidebar!.left);
      expect(geometry.background).toBe(theme === 'dark' ? 'rgb(32, 37, 35)' : 'rgb(253, 253, 251)');
      const tools = dialog.getByRole('group', { name: '精修方式' });
      await tools.getByRole('button', { name: '清除背景', exact: true }).click();
      await expect(tools.getByRole('button', { name: '清除背景', exact: true })).toHaveAttribute('aria-pressed', 'true');
      const regions = dialog.getByRole('list', { name: '已添加的精修区域' });
      await expect(regions.locator('li')).toHaveCount(40);
      const overlay = dialog.getByRole('group', { name: '框选分层范围' });
      await overlay.scrollIntoViewIfNeeded();
      const box = (await overlay.boundingBox())!;
      await page.mouse.move(box.x + box.width * .84, box.y + box.height * .84);
      await page.mouse.down(); await page.mouse.move(box.x + box.width * .94, box.y + box.height * .94, { steps: 6 }); await page.mouse.up();
      await dialog.getByRole('button', { name: '添加精修区域' }).click();
      await expect(regions.locator('li')).toHaveCount(41);
      await expect(overlay.locator('[data-refinement-region]')).toHaveCount(41);
      await dialog.getByRole('button', { name: '移除精修区域 41', exact: true }).click();
      await expect(regions.locator('li')).toHaveCount(40);
      await expect(overlay.locator('[data-refinement-region]')).toHaveCount(40);
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      expect((await e2eState(page)).modelSubmissions).toHaveLength(0);
      expect(errors).toEqual([]); expect(requests).toEqual([]);
    });
  }
}
