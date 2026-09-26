import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './helpers/e2e-test';
import { e2eState, openEmptyApp, queueProjectImageImport } from './helpers/app';
import { makeReferenceImage } from './helpers/fixtures';

const output = path.join(process.cwd(), 'work', 'formal-evidence-1.6.174', 'scope');
for (const theme of ['light', 'dark'] as const) {
  test(`selects, moves and resizes a portrait scope in ${theme}, then persists it without live calls`, async ({ page }) => {
    await mkdir(output, { recursive: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.addInitScript(value => localStorage.setItem('novus.theme.mode', value), theme);
    const external: string[] = [], errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (/^https?:/u.test(request.url()) && !/^https?:\/\/(127\.0\.0\.1|localhost):/u.test(request.url())) external.push(request.url()); });
    await openEmptyApp(page);
    await page.evaluate(async () => {
      await window.__NOVUS_E2E__!.createModule('image_input', { x: 80, y: 260 });
      await window.__NOVUS_E2E__!.createModule('image_generation', { x: 470, y: 110 });
    });
    const input = page.locator('[data-module-type="image_input"]');
    const generation = page.locator('[data-module-type="image_generation"]');
    await queueProjectImageImport(page, makeReferenceImage('portrait scope.png', [90, 160, 120, 255], { width: 300, height: 400 }), { preservePixels: true });
    await input.getByRole('button', { name: /Import image/u }).click();
    const assetId = (await e2eState(page)).projectImages.at(-1)!.assetId;
    await page.evaluate(async id => window.__NOVUS_E2E__!.configureModule('image_generation', {
      config: { resultState: 'fresh', resultAssetIds: [id] }, execution: { state: 'completed' },
    }), assetId);
    await generation.getByRole('button', { name: 'Open image generation editor' }).click();
    await generation.getByRole('button', { name: 'AI 分层' }).click();
    const dialog = page.getByRole('dialog', { name: 'AI 图片分层' });
    await dialog.getByRole('button', { name: '框选物品', exact: true }).click();
    await expect(dialog.getByRole('button', { name: '分析图片' })).toBeDisabled();
    const overlay = dialog.getByRole('group', { name: '框选分层范围', exact: true });
    const rect = (await overlay.boundingBox())!;
    expect(rect.width / rect.height).toBeCloseTo(.75, 2);
    const drag = async (x1: number, y1: number, x2: number, y2: number) => {
      await page.mouse.move(rect.x + rect.width * x1, rect.y + rect.height * y1);
      await page.mouse.down();
      await page.mouse.move(rect.x + rect.width * x2, rect.y + rect.height * y2, { steps: 8 });
      await page.mouse.up();
    };
    await drag(.2, .2, .7, .7);
    const box = overlay.locator('[data-handle="move"]');
    expect(Number(await box.getAttribute('width'))).toBeCloseTo(500, -1);
    await drag(.4, .4, .45, .45);
    expect(Number(await box.getAttribute('x'))).toBeCloseTo(250, -1);
    await drag(.75, .75, .85, .85);
    expect(Number(await box.getAttribute('width'))).toBeCloseTo(600, -1);
    await overlay.press('ArrowLeft');
    const selectedX = Number(await box.getAttribute('x'));
    expect(selectedX).toBeLessThan(250);
    await dialog.getByRole('textbox', { name: '要提取的内容' }).fill('只提取料理机与它的阴影');
    await page.screenshot({ path: path.join(output, `${theme}-objects.png`) });
    await dialog.getByRole('button', { name: '框选区域', exact: true }).click();
    await expect(box).toBeVisible();
    await page.screenshot({ path: path.join(output, `${theme}-region.png`) });
    await page.evaluate(() => window.__NOVUS_E2E__!.queueLayeringAnalysisReply(JSON.stringify({ layers: [
      { layerId: 'background', kind: 'background', name: '厨房背景', description: '保留框外原图，补全框内移除物品的背景', included: true },
      { layerId: 'blender', kind: 'transparent', name: '红色料理机', description: '仅选区内料理机，保持原图位置，不含阴影', included: true },
    ] })));
    await dialog.getByRole('button', { name: '分析图片' }).click();
    await expect(dialog.getByRole('list', { name: '可编辑分层方案' })).toBeVisible();
    await dialog.getByRole('button', { name: '下一步：确认生成' }).click();
    const model = dialog.getByRole('combobox', { name: 'GPT 图像模型' });
    const flare = await model.locator('option').evaluateAll(options => options.find(option => option.textContent?.startsWith('GPT Image 2.5 Flare ·'))?.getAttribute('value'));
    expect(flare).toBeTruthy();
    await model.selectOption(flare!);
    await expect(dialog.getByRole('combobox', { name: '输出分辨率' })).toHaveValue('4K');
    await page.screenshot({ path: path.join(output, `${theme}-review.png`) });
    await dialog.getByRole('button', { name: '确认生成 2 层' }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await e2eState(page)).modelSubmissions.length).toBe(2);
    const submitted = (await e2eState(page)).modelSubmissions;
    expect(submitted.every(job => job.aspectRatio === '3:4' && job.imageQuality === 'high' && job.resolution === '4K')).toBe(true);
    await page.evaluate(() => window.__NOVUS_E2E__!.reopenProject());
    expect((await e2eState(page)).moduleTypes.filter(type => type === 'image_layer')).toHaveLength(2);
    expect(external).toEqual([]); expect(errors).toEqual([]);
    await writeFile(path.join(output, `${theme}.json`), JSON.stringify({ theme, selectedX, submitted, external, errors, paidCalls: 0 }, null, 2));
  });
}
