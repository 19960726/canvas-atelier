import { expect, test } from './helpers/e2e-test';
import { openEmptyApp, queueProjectImageImport } from './helpers/app';
import { makeReferenceImage } from './helpers/fixtures';

test('twelve image references use the full editor width without hiding slots', async ({ page }, testInfo) => {
  test.setTimeout(120000);
  await page.setViewportSize({ width: 1680, height: 1200 });
  await openEmptyApp(page);
  await page.evaluate(() => window.__NOVUS_E2E__!.createModule('image_generation', { x: 620, y: 120 }));
  const node = page.locator('[data-module-type="image_generation"]');
  for (let index = 1; index <= 12; index++) {
    await page.locator('.react-flow__pane').click({ position: { x: 1400, y: 60 } });
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
    return {
      rowWidth: row.getBoundingClientRect().width,
      availableWidth: outer.width - 28,
      scrollWidth: row.scrollWidth,
      clientWidth: row.clientWidth,
      firstTop: thumbnails[0]!.top,
      lastTop: thumbnails[11]!.top,
      lastRight: thumbnails[11]!.right,
      outerRight: outer.right,
    };
  });
  expect(geometry.rowWidth).toBeGreaterThan(geometry.availableWidth * 0.9);
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
  expect(geometry.lastTop).toBeCloseTo(geometry.firstTop, 0);
  expect(geometry.lastRight).toBeLessThanOrEqual(geometry.outerRight - 10);
  await node.screenshot({ path: testInfo.outputPath('image-twelve-slots.png') });
});
