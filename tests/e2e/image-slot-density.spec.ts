import { expect, test } from './helpers/e2e-test';
import { writeFile } from 'node:fs/promises';
import { openEmptyApp, queueProjectImageImport } from './helpers/app';
import { makeReferenceImage } from './helpers/fixtures';

test('twelve image references use the full editor width without hiding slots', async ({ page }, testInfo) => {
  test.setTimeout(120000);
  await page.setViewportSize({ width: 1680, height: 1200 });
  await openEmptyApp(page);
  await page.evaluate(() => window.__NOVUS_E2E__!.createModule('image_generation', { x: 620, y: 120 }));
  const node = page.locator('[data-module-type="image_generation"]');
  for (let index = 1; index <= 12; index++) {
    await page.locator('.react-flow__pane').click({ position: { x: 1400, y: 160 } });
    await page.evaluate(() => window.__NOVUS_E2E__!.createModule('image_input', { x: 160, y: 100 }));
    const input = page.locator('[data-module-type="image_input"]').last();
    await queueProjectImageImport(page, makeReferenceImage(`Dense reference ${index}.png`, [index * 10, 100, 130, 255]));
    await input.getByRole('button', { name: '导入图像 / Import image' }).click();
    await input.locator('[data-port-id="image"].react-flow__handle').dragTo(node.locator('[data-port-id="references"].react-flow__handle'));
  }
  await node.getByRole('button', { name: 'Open image generation editor' }).click();
  const slots = node.getByLabel('Image generation reference slots', { exact: true });
  await expect(slots.locator('[data-slot-index]')).toHaveCount(12);
  const geometry = await slots.evaluate((element) => {
    const row = element.querySelector<HTMLElement>('.connected-agent-media-slots__row')!;
    const thumbnails = [...row.querySelectorAll<HTMLElement>('[data-slot-index]')].map((item) => item.getBoundingClientRect());
    const outer = element.getBoundingClientRect();
    const box = (item: Element) => {
      const rect = item.getBoundingClientRect();
      const style = getComputedStyle(item);
      return {
        className: item.className,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right },
        clientWidth: item.clientWidth,
        scrollWidth: item.scrollWidth,
        css: Object.fromEntries([
          'display', 'width', 'min-width', 'max-width', 'box-sizing', 'padding-left', 'padding-right',
          'border-left-width', 'border-right-width', 'column-gap', 'grid-template-columns',
          'overflow-x', 'scrollbar-gutter', 'container-type', '--media-columns', '--media-slot-limit',
          '--generation-preview-width', '--generation-composer-width', '--media-slot-width',
        ].map((property) => [property, style.getPropertyValue(property)])),
      };
    };
    const ancestors = [];
    for (let parent: Element | null = row.parentElement; parent; parent = parent.parentElement) {
      ancestors.push(box(parent));
      if (parent.classList.contains('module-node')) break;
    }
    return {
      rowWidth: row.getBoundingClientRect().width,
      availableWidth: outer.width - 28,
      scrollWidth: row.scrollWidth,
      clientWidth: row.clientWidth,
      firstTop: thumbnails[0]!.top,
      lastTop: thumbnails[11]!.top,
      lastRight: thumbnails[11]!.right,
      outerRight: outer.right,
      boxes: { row: box(row), ancestors, slots: [...row.querySelectorAll<HTMLElement>('[data-slot-index]')].map(box) },
    };
  });
  const geometryPath = testInfo.outputPath('image-slot-density-geometry.json');
  await writeFile(geometryPath, JSON.stringify(geometry, null, 2), { flag: 'wx' });
  await testInfo.attach('image-slot-density-geometry.json', {
    path: geometryPath,
    contentType: 'application/json',
  });
  expect(geometry.rowWidth).toBeGreaterThan(geometry.availableWidth * 0.9);
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
  expect(geometry.lastTop).toBeCloseTo(geometry.firstTop, 0);
  expect(geometry.lastRight).toBeLessThanOrEqual(geometry.outerRight - 10);
  await node.screenshot({ path: testInfo.outputPath('image-twelve-slots.png') });
});
