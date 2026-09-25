import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from './helpers/e2e-test';
import { e2eState, openEmptyApp, queueProjectImageImport } from './helpers/app';
import { makeReferenceImage } from './helpers/fixtures';

const evidenceDirectory = path.join(process.cwd(), 'work', process.env.CANVAS_UNRESOLVED_UI_AUDIT_DIR ?? 'qa-unresolved-ui-2026-09-24-r2');

for (const theme of ['light', 'dark'] as const) {
  test(`AI layering entry stays clickable near the top in ${theme} theme`, async ({ page }) => {
    await mkdir(evidenceDirectory, { recursive: true });
    await page.setViewportSize({ width: 1600, height: 1100 });
    await page.addInitScript((mode) => localStorage.setItem('novus.theme.mode', mode), theme);
    await openEmptyApp(page);
    await page.evaluate(() => window.__NOVUS_E2E__!.createModule('image_generation', { x: 470, y: 110 }));
    await queueProjectImageImport(page, makeReferenceImage(`layering-entry-${theme}.png`, [108, 156, 188, 255], { width: 320, height: 240 }), { preservePixels: true });
    await page.evaluate(() => window.__NOVUS_E2E__!.createModule('image_input', { x: 80, y: 260 }));
    await page.locator('[data-module-type="image_input"]').getByRole('button', { name: /Import image/u }).click();
    const assetId = (await e2eState(page)).projectImages.at(-1)!.assetId;
    await page.evaluate((id) => window.__NOVUS_E2E__!.configureModule('image_generation', {
      config: { resultState: 'fresh', resultAssetIds: [id] },
      execution: { state: 'completed' },
    }), assetId);
    const generation = page.locator('[data-module-type="image_generation"]');
    await generation.getByRole('button', { name: 'Open image generation editor' }).click();
    const entry = generation.getByRole('button', { name: 'AI 分层' });
    const hit = await entry.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const pointed = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      const topbar = document.querySelector('.topbar')?.getBoundingClientRect();
      return { button: rect.toJSON(), hitTag: pointed?.tagName ?? null, hitClass: pointed?.getAttribute('class') ?? null, reachable: pointed === element || element.contains(pointed), topbar: topbar?.toJSON() ?? null };
    });
    await writeFile(path.join(evidenceDirectory, `layering-hit-${theme}.json`), JSON.stringify(hit, null, 2), 'utf8');
    await page.screenshot({ path: path.join(evidenceDirectory, `layering-before-click-${theme}.png`), fullPage: true });
    expect(hit.reachable).toBe(true);
    await entry.click();
    await expect(page.getByRole('dialog', { name: 'AI 图片分层' })).toBeVisible();
    await page.screenshot({ path: path.join(evidenceDirectory, `layering-dialog-${theme}.png`), fullPage: true });
  });
}

test('video duration slider responds to a real mouse drag', async ({ page }) => {
  await mkdir(evidenceDirectory, { recursive: true });
  await page.setViewportSize({ width: 1600, height: 1100 });
  await page.addInitScript(() => localStorage.setItem('novus.theme.mode', 'light'));
  await openEmptyApp(page);
  await page.evaluate(() => window.__NOVUS_E2E__!.createModule('video_generation', { x: 350, y: 90 }));
  const video = page.locator('[data-module-type="video_generation"]');
  await video.getByRole('button', { name: 'Open video generation editor' }).click();
  await video.getByRole('button', { name: '打开视频参数设置' }).click();
  const settings = video.getByRole('dialog', { name: '视频生成参数' });
  const slider = settings.getByRole('slider', { name: '视频时长' });
  const box = await slider.boundingBox();
  expect(box).not.toBeNull();
  const before = await settings.locator('output').innerText();
  await page.screenshot({ path: path.join(evidenceDirectory, 'duration-before-drag.png') });
  await page.mouse.move(box!.x + 20, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width - 56, box!.y + box!.height / 2, { steps: 8 });
  await page.mouse.up();
  const after = await settings.locator('output').innerText();
  await writeFile(path.join(evidenceDirectory, 'duration-drag.json'), JSON.stringify({ before, after, sliderBox: box }, null, 2), 'utf8');
  await page.screenshot({ path: path.join(evidenceDirectory, 'duration-after-drag.png') });
  expect(after).not.toBe(before);
  await expect(video.getByRole('button', { name: '打开视频参数设置' })).toContainText(after);
});

test('classifies the eleven earlier focus probes using visible enabled controls', async ({ page }) => {
  await mkdir(evidenceDirectory, { recursive: true });
  await page.setViewportSize({ width: 1600, height: 1100 });
  await openEmptyApp(page);
  const earlierFailed = [
    'image_input', 'upload_image', 'video_input', 'video_generation', 'reverse_agent',
    'storyboard_sheet', 'music_generation', 'speech_generation', 'result_output',
    'video_result', 'reverse_result',
  ] as const;
  const records = [];
  for (const type of earlierFailed) {
    await page.evaluate(async (moduleType) => {
      await window.__NOVUS_E2E__!.resetEmpty();
      await window.__NOVUS_E2E__!.createModule(moduleType, { x: 300, y: 160 });
    }, type);
    const node = page.locator(`[data-module-type="${type}"]`);
    await expect(node).toBeVisible();
    const candidates = await node.locator('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled)').all();
    let result: { name: string; tag: string; tabIndex: number; focused: boolean } | null = null;
    for (const candidate of candidates) {
      if (!(await candidate.isVisible())) continue;
      const rect = await candidate.boundingBox();
      if (!rect || rect.width < 1 || rect.height < 1) continue;
      await candidate.focus();
      result = await candidate.evaluate((element) => ({
        name: element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 50) ?? '',
        tag: element.tagName,
        tabIndex: (element as HTMLElement).tabIndex,
        focused: document.activeElement === element,
      }));
      break;
    }
    records.push({ type, visibleEnabledControl: result });
  }
  await writeFile(path.join(evidenceDirectory, 'focus-followup.json'), JSON.stringify(records, null, 2), 'utf8');
  expect(records).toHaveLength(11);
  for (const record of records) {
    if (record.visibleEnabledControl) expect(record.visibleEnabledControl.focused, `${record.type} visible enabled control should retain focus`).toBe(true);
  }
});
