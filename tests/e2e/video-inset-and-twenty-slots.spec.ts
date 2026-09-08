import { expect, test } from './helpers/e2e-test';
import { openEmptyApp, queueProjectImageImport } from './helpers/app';
import { makeReferenceImage } from './helpers/fixtures';

test('video prompt and rail keep separate insets after reopening a saved canvas', async ({ page }) => {
  await page.setViewportSize({ width: 1680, height: 1200 });
  await openEmptyApp(page);
  await page.evaluate(() => window.__NOVUS_E2E__!.createModule('video_generation', { x: 280, y: 120 }));
  const node = page.locator('[data-module-type="video_generation"]');
  for (const phase of ['fresh', 'reloaded']) {
    if (phase === 'reloaded') await page.evaluate(() => window.__NOVUS_E2E__!.reopenProject());
    const opener = node.getByRole('button', { name: 'Open video generation editor' });
    await expect.poll(async () => {
      if (await opener.isVisible()) await opener.click();
      return node.getByRole('textbox', { name: 'Video preview prompt' }).isVisible();
    }).toBe(true);
    await expect(node.getByRole('textbox', { name: 'Video preview prompt' })).toBeVisible();
    const layout = await node.evaluate((element) => {
      const composer = element.querySelector('.module-node__video-composer')!.getBoundingClientRect();
      const prompt = element.querySelector('.module-node__prompt-workspace')!.getBoundingClientRect();
      const bar = element.querySelector('.module-node__video-control-bar')!.getBoundingClientRect();
      return { bottom:composer.bottom-bar.bottom, gap:bar.top-prompt.bottom, left:bar.left-composer.left, aligned:prompt.left-bar.left };
    });
    expect(layout.bottom).toBeCloseTo(18, 0);
    expect(layout.left).toBeCloseTo(18, 0);
    expect(layout.gap).toBeCloseTo(12, 0);
    expect(layout.aligned).toBeCloseTo(0, 0);
    if (phase === 'fresh') {
      await node.getByRole('textbox', { name: 'Video preview prompt' }).fill('Saved canvas inset regression');
      await page.getByRole('button', { name: '保存项目', exact:true }).click();
    }
  }
  await expect(node.getByRole('textbox', { name: 'Video preview prompt' })).toContainText('Saved canvas inset regression');
});

for (const moduleType of ['reverse_agent', 'image_generation', 'video_generation'] as const) {
test(`${moduleType}: twenty five inputs retain thumbnails, scroll and reorder`, async ({ page }, testInfo) => {
  test.setTimeout(120000);
  await page.setViewportSize({ width: 1680, height: 1200 });
  await openEmptyApp(page);
  await page.evaluate(type => window.__NOVUS_E2E__!.createModule(type, { x: 620, y: 120 }), moduleType);
  const reverse = page.locator(`[data-module-type="${moduleType}"]`);
  const slotLabel = moduleType === 'reverse_agent' ? 'Connected reverse media slots' : moduleType === 'image_generation' ? 'Image generation reference slots' : 'Connected video media';
  const targetPort = moduleType === 'video_generation' ? 'media' : 'references';
  const visibleCount = (count: number) => moduleType === 'reverse_agent' ? count : Math.min(20, count);
  const inputCount = 25;
  for (let index=1; index<=inputCount; index++) {
    await page.locator('.react-flow__pane').click({ position: { x: 1400, y: 60 } });
    await page.evaluate(() => window.__NOVUS_E2E__!.createModule('image_input', { x: 160, y: 100 }));
    const input = page.locator('[data-module-type="image_input"]').last();
    await queueProjectImageImport(page, makeReferenceImage(`Reference ${index}.png`, [index*10,100,130,255]));
    await input.getByRole('button', { name:'导入图像 / Import image' }).click();
    await input.locator('[data-port-id="image"].react-flow__handle').dragTo(reverse.locator(`[data-port-id="${targetPort}"].react-flow__handle`));
    await expect(reverse.getByLabel(slotLabel, {exact:true})).toContainText(`${visibleCount(index)} / 20`);
    if ([6,7,20,21,25].includes(index)) {
      if (index > 20 && moduleType === 'reverse_agent') await expect(reverse.getByText(/Agent 反推最多连接 20/)).toBeVisible();
      const imgs = reverse.getByLabel(slotLabel, {exact:true}).locator('img');
      await expect(imgs).toHaveCount(visibleCount(index));
      await expect.poll(() => imgs.evaluateAll(images => images.every(img => (img as HTMLImageElement).naturalWidth > 0))).toBe(true);
      await reverse.screenshot({ path: testInfo.outputPath(`reverse-${index}-images.png`) });
    }
  }
  const slots = reverse.getByLabel(slotLabel, {exact:true});
  const last = visibleCount(inputCount);
  await expect(slots.locator('[data-slot-index] img')).toHaveCount(last);
  await expect.poll(() => slots.locator('img').evaluateAll(images => images.every(img => (img as HTMLImageElement).naturalWidth > 0))).toBe(true);
  const row = slots.locator('.connected-agent-media-slots__row');
  expect(await row.evaluate(e => e.scrollWidth > e.clientWidth && getComputedStyle(e).overflowX === 'auto')).toBe(true);
  expect(await row.evaluate(e => getComputedStyle(e).scrollbarWidth)).not.toBe('none');
  await row.hover();
  await page.mouse.wheel(0, 2000);
  await expect.poll(() => row.evaluate(e => e.scrollLeft)).toBeGreaterThan(0);
  await expect(slots.getByLabel(`Agent media slot ${last}`, { exact:true }).locator('img')).toBeInViewport();
  await slots.getByRole('button', { name:`Move Reference ${last} left`, exact:true }).click();
  await expect(slots.getByLabel(`Agent media slot ${last-1}`, { exact:true })).toHaveAttribute('title', new RegExp(`Reference ${last}`));
  await page.evaluate(() => window.__NOVUS_E2E__!.reopenProject());
  await expect(slots.locator('img')).toHaveCount(last);
  await expect(slots.getByLabel(`Agent media slot ${last-1}`, { exact:true })).toHaveAttribute('title', new RegExp(`Reference ${last}`));
  if(moduleType!=='reverse_agent') {
    await reverse.getByRole('button',{name:moduleType==='image_generation'?'Open image generation editor':'Open video generation editor'}).click();
    const expandedSlots=reverse.getByLabel(moduleType==='image_generation'?slotLabel:'Connected video media editor',{exact:true});
    await expect(expandedSlots.locator('img')).toHaveCount(20);
    await expect(expandedSlots.locator('.connected-agent-media-slots__row')).toBeVisible();
    await expandedSlots.locator('.connected-agent-media-slots__row').hover();
    await page.mouse.wheel(0,2000);
    await expandedSlots.getByRole('button',{name:'Move Reference 20 right',exact:true}).click();
    await expect(expandedSlots.getByLabel('Agent media slot 20',{exact:true})).toHaveAttribute('title',/Reference 20/);
  }
});
}
