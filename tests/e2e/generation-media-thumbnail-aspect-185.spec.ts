import { expect, test } from './helpers/e2e-test';
import { e2eState, openEmptyApp, queueProjectImageImport } from './helpers/app';
import { makeReferenceImage } from './helpers/fixtures';

for (const theme of ['light', 'dark'] as const) {
  for (const kind of ['image', 'video'] as const) {
    test(`${kind} materials use uniform frames for complete portrait, landscape and square thumbnails in ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: 1680, height: 1200 });
      await page.addInitScript(mode => localStorage.setItem('novus.theme.mode', mode), theme);
      await openEmptyApp(page);
      const moduleType = kind === 'image' ? 'image_generation' : 'video_generation';
      await page.evaluate(type => window.__NOVUS_E2E__!.createModule(type, { x: 500, y: 110 }), moduleType);
      const generation = page.locator(`[data-module-type="${moduleType}"]`);
      const fixtures = [
        makeReferenceImage('完整竖图.png', [178, 88, 124, 255], { width: 600, height: 900 }),
        makeReferenceImage('完整横图.png', [83, 156, 166, 255], { width: 1200, height: 600 }),
        makeReferenceImage('完整方图.png', [136, 174, 91, 255], { width: 700, height: 700 }),
      ];
      const expectedLabels: string[] = [];
      let nextSourceY = 110;
      for (const [index, fixture] of fixtures.entries()) {
        const position = index === 2 ? { x: 1250, y: 110 } : { x: 140, y: nextSourceY };
        await page.evaluate(point => window.__NOVUS_E2E__!.createModule('image_input', point), position);
        const source = page.locator('[data-module-type="image_input"]').last();
        await queueProjectImageImport(page, fixture, { preservePixels: true });
        await source.getByRole('button', { name: /Import image/u }).click();
        await expect(source.locator('img').first()).toBeVisible();
        const imported = (await e2eState(page)).projectImages.at(-1)!;
        expectedLabels.push(imported.label);
        const sourceBox = (await source.boundingBox())!;
        const zoom = await page.locator('.react-flow__viewport').evaluate(element => new DOMMatrixReadOnly(getComputedStyle(element).transform).a);
        nextSourceY = position.y + sourceBox.height / zoom + 40;
        await source.locator('[data-port-id="image"].react-flow__handle').dragTo(generation.locator(`[data-port-id="${kind === 'image' ? 'references' : 'media'}"].react-flow__handle`));
      }
      await generation.getByRole('button', { name: kind === 'image' ? 'Open image generation editor' : 'Open video generation editor' }).click();
      const materials = generation.getByLabel(kind === 'image' ? 'Image generation reference slots' : 'Connected video media editor', { exact: true });
      await expect(materials).toHaveAttribute('data-thumbnail-sizing', 'uniform');
      await expect(materials.locator('[data-slot-index]')).toHaveCount(3);
      await expect(materials.locator('img')).toHaveCount(3);
      const metrics = await materials.locator('[data-slot-index]').evaluateAll(elements => elements.map(element => {
        const image = element.querySelector('img')!;
        const box = element.getBoundingClientRect();
        return { label: image.alt, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight,
          width: box.width, height: box.height, fit: getComputedStyle(image).objectFit, number: element.getAttribute('data-slot-index') };
      }));
      for (let index = 0; index < fixtures.length; index++) {
        const actual = metrics[index]!;
        const expected = fixtures[index]!;
        expect(actual.label).toBe(expectedLabels[index]);
        expect([actual.naturalWidth, actual.naturalHeight], 'The original imported image dimensions remain intact').toEqual([expected.width, expected.height]);
        expect(actual.fit).toBe('contain');
        expect(actual.width, 'Every reference has the same fixed frame width').toBeCloseTo(54, 0);
        expect(actual.height).toBeCloseTo(54, 0);
        expect(actual.number).toBe(`${index + 1}`);
      }
      expect(metrics.map(item => item.width)).toEqual([metrics[0]!.width, metrics[0]!.width, metrics[0]!.width]);
      expect(metrics.map(item => item.height)).toEqual([metrics[0]!.height, metrics[0]!.height, metrics[0]!.height]);
      await generation.screenshot({ path: testInfo.outputPath(`${kind}-complete-materials-${theme}.png`) });
      await materials.screenshot({ path: testInfo.outputPath(`${kind}-complete-materials-detail-${theme}.png`) });
      const before = (await materials.locator('img').evaluateAll(images => images.map(image => image.getAttribute('src'))));
      const moveRight = materials.getByRole('button', { name: `Move ${expectedLabels[0]} right`, exact: true });
      await moveRight.focus();
      await expect(moveRight).toBeVisible();
      await moveRight.press('Enter');
      await expect.poll(() => materials.locator('img').evaluateAll(images => images.map(image => image.getAttribute('src')))).toEqual([before[1], before[0], before[2]]);
      const moved = await materials.locator('[data-slot-index]').evaluateAll(elements => elements.map(element => ({
        index: element.getAttribute('data-slot-index'), label: element.querySelector('img')!.alt,
      })));
      expect(moved).toEqual([
        { index: '1', label: expectedLabels[1] }, { index: '2', label: expectedLabels[0] }, { index: '3', label: expectedLabels[2] },
      ]);
      expect((await e2eState(page)).modelSubmissions).toHaveLength(0);
    });
  }
}
