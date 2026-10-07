import { expect, test } from './helpers/e2e-test';
import { e2eState, openEmptyApp, queueProjectImageImport } from './helpers/app';
import { makeReferenceImage } from './helpers/fixtures';

for (const theme of ['light', 'dark'] as const) {
  for (const moduleType of ['image_generation', 'video_generation'] as const) {
    test(`${moduleType} extreme material tools remain reachable in ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: 1680, height: 1200 });
      await page.addInitScript(mode => localStorage.setItem('novus.theme.mode', mode), theme);
      await openEmptyApp(page);
      await page.evaluate(type => window.__NOVUS_E2E__!.createModule(type, { x: 700, y: 110 }), moduleType);
      const generation = page.locator(`[data-module-type="${moduleType}"]`);
      const fixtures = [
        makeReferenceImage('Panorama.png', [178, 88, 124, 255], { width: 5000, height: 100 }),
        makeReferenceImage('Tall reference.png', [83, 156, 166, 255], { width: 100, height: 5000 }),
        makeReferenceImage('Square reference.png', [136, 174, 91, 255], { width: 600, height: 600 }),
      ];
      const labels: string[] = [];
      for (const fixture of fixtures) {
        await page.locator('.react-flow__pane').click({ position: { x: 1400, y: 160 } });
        await page.evaluate(() => window.__NOVUS_E2E__!.createModule('image_input', { x: 140, y: 110 }));
        const source = page.locator('[data-module-type="image_input"]').last();
        await source.locator('[data-port-id="image"].react-flow__handle').dragTo(generation.locator(`[data-port-id="${moduleType === 'image_generation' ? 'references' : 'media'}"].react-flow__handle`));
        await queueProjectImageImport(page, fixture, { preservePixels: true });
        await source.getByRole('button', { name: /Import image/u }).click();
        labels.push((await e2eState(page)).projectImages.at(-1)!.label);
      }
      await expect.poll(async () => (await e2eState(page)).edgeCount).toBe(fixtures.length);
      await page.locator('.react-flow__pane').click({ position: { x: 1400, y: 160 } });
      await generation.getByRole('button', { name: moduleType === 'image_generation' ? 'Open image generation editor' : 'Open video generation editor' }).click();
      const materials = generation.getByLabel(moduleType === 'image_generation' ? 'Image generation reference slots' : 'Connected video media editor', { exact: true });
      const row = materials.locator('.connected-agent-media-slots__row');
      const slots = materials.locator('[data-slot-index]');
      await expect(slots).toHaveCount(fixtures.length);
      const original = await generation.evaluate(element => ({
        width: getComputedStyle(element).width,
        promptHeight: getComputedStyle(element.querySelector('.module-node__prompt-workspace')!).height,
        rowHeight: getComputedStyle(element.querySelector('.connected-agent-media-slots__row')!).height,
      }));
      expect(original.rowHeight).toBe('57px');
      for (const width of [1680, 1100]) {
        await page.setViewportSize({ width, height: 1200 });
        for (let index = 0; index < fixtures.length; index++) {
          const material = slots.nth(index);
          await material.scrollIntoViewIfNeeded();
          await material.hover();
          const geometry = await material.evaluate(element => {
            const frame = element.getBoundingClientRect();
            const badge = element.querySelector('.connected-agent-media-slots__index')!.getBoundingClientRect();
            const image = element.querySelector('img')!;
            const contains = (child: DOMRect) => child.left >= frame.left - 1 && child.right <= frame.right + 1 && child.top >= frame.top - 1 && child.bottom <= frame.bottom + 1;
            const controls = [...element.querySelectorAll<HTMLButtonElement>('.connected-agent-media-slots__reorder button')];
            return {
              width: frame.width,
              height: frame.height,
              badgeContained: contains(badge),
              fit: getComputedStyle(image).objectFit,
              naturalWidth: image.naturalWidth,
              naturalHeight: image.naturalHeight,
              controls: controls.map(button => {
                const rect = button.getBoundingClientRect();
                const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
                return { contained: contains(rect), unobstructed: target === button || button.contains(target), badgeOverlap: rect.left < badge.right && rect.right > badge.left && rect.top < badge.bottom && rect.bottom > badge.top, title: button.title };
              }),
            };
          });
          expect(geometry.badgeContained, `slot ${index + 1} badge fits its hit frame at ${width}`).toBe(true);
          expect(geometry.width).toBeCloseTo(54, 0);
          expect(geometry.height).toBeCloseTo(54, 0);
          expect([geometry.naturalWidth, geometry.naturalHeight]).toEqual([fixtures[index]!.width, fixtures[index]!.height]);
          expect(geometry.fit).toBe('contain');
          for (const control of geometry.controls) {
            expect(control.contained).toBe(true);
            expect(control.unobstructed).toBe(true);
            expect(control.badgeOverlap).toBe(false);
            expect(control.title.length).toBeGreaterThan(0);
          }
        }
        expect(await generation.evaluate(element => ({
          width: getComputedStyle(element).width,
          promptHeight: getComputedStyle(element.querySelector('.module-node__prompt-workspace')!).height,
          rowHeight: getComputedStyle(element.querySelector('.connected-agent-media-slots__row')!).height,
        }))).toEqual(original);
        await materials.screenshot({ path: testInfo.outputPath(`extreme-material-tools-${theme}-${width}.png`) });
      }
      await slots.nth(0).press('Enter');
      const preview = page.getByRole('dialog', { name: 'Generated image preview' });
      await expect(preview).toBeVisible();
      await expect.poll(() => preview.getByRole('img', { name: 'Generated image 1 full preview' })
        .evaluate((image: HTMLImageElement) => [image.naturalWidth, image.naturalHeight]))
        .toEqual([fixtures[0]!.width, fixtures[0]!.height]);
      await preview.press('ArrowRight');
      await expect.poll(() => preview.getByRole('img', { name: 'Generated image 2 full preview' })
        .evaluate((image: HTMLImageElement) => [image.naturalWidth, image.naturalHeight]))
        .toEqual([fixtures[1]!.width, fixtures[1]!.height]);
      await preview.getByRole('button', { name: 'Close generated image preview', exact: true }).click();
      await expect(preview).toHaveCount(0);
      const moveRight = materials.getByRole('button', { name: `Move ${labels[0]} right`, exact: true });
      await moveRight.click();
      await expect(slots.nth(1)).toHaveAttribute('title', `2. ${labels[0]}`);
      await page.getByRole('button', { name: '保存项目', exact: true }).click();
      await expect(page.locator('[aria-label="画布保存状态"]')).toHaveAttribute('data-save-state', 'saved');
      await page.evaluate(() => window.__NOVUS_E2E__!.reopenProject());
      const openEditor = generation.getByRole('button', { name: moduleType === 'image_generation' ? 'Open image generation editor' : 'Open video generation editor' });
      if (await openEditor.isVisible()) await openEditor.click();
      await expect(slots.nth(1)).toHaveAttribute('title', `2. ${labels[0]}`);
      expect((await e2eState(page)).modelSubmissions).toHaveLength(0);
      await row.hover();
    });
  }
}
