import { expect, test } from './helpers/e2e-test';
import { openAgentPanel, openEmptyApp, queueProjectImageImport } from './helpers/app';
import { makeReferenceImage } from './helpers/fixtures';

for (const theme of ['light', 'dark']) {
 for (const kind of ['material', 'generated']) {
  test(`${kind} has an immersive preview and image action menu in ${theme}`, async ({ page }, info) => {
    await page.addInitScript(theme => localStorage.setItem('novus.theme.mode', theme), theme);
    await openEmptyApp(page);
    if (kind === 'generated') {
      await page.evaluate(async () => { await window.__NOVUS_E2E__!.createModule('image_generation', { x: 260, y: 140 }); await window.__NOVUS_E2E__!.seedGeneratedImageResult?.(); });
      await page.getByRole('button', { name: 'Open image generation editor' }).click();
      await page.getByRole('button', { name: 'Generated image 1; double click to preview' }).dblclick();
    } else {
      await page.evaluate(async () => { await window.__NOVUS_E2E__!.createModule('image_input', { x: 260, y: 140 }); });
      await queueProjectImageImport(page, makeReferenceImage('Preview material.png', [140, 130, 100, 255], { width: 2400, height: 1600 }));
      const node = page.locator('[data-module-type="image_input"]');
      await node.getByRole('button', { name: /Import image/ }).click();
      await node.getByRole('img', { name: 'Preview material' }).dblclick();
    }
    const dialog = page.getByRole('dialog', { name: 'Generated image preview' });
    await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox();
    expect(box!.width).toBe(page.viewportSize()!.width);
    expect(box!.height).toBe(page.viewportSize()!.height);
    await expect(dialog.getByText('图片细节预览', { exact: true })).toHaveCount(0);
    const image = dialog.getByRole('img');
    const fit = await image.boundingBox();
    await dialog.getByRole('button', { name: '原始尺寸 1:1' }).click();
    await expect(dialog.getByLabel('Generated image zoom level')).toHaveText('100%');
    const actual = await image.boundingBox();
    expect(Math.round(actual!.width)).toBe(kind === 'generated' ? 1024 : 2400);
    await dialog.getByRole('button', { name: 'Reset generated image zoom' }).click();
    expect(Math.abs((await image.boundingBox())!.width - fit!.width)).toBeLessThan(2);
    const stage = dialog.getByLabel('Generated image detail viewer');
    await stage.hover();
    await page.keyboard.down('Shift');
    await page.mouse.wheel(0, -120);
    await page.keyboard.up('Shift');
    await expect.poll(async () => (await image.boundingBox())!.width / fit!.width).toBeCloseTo(1.06, 2);
    const beforeDrag = (await image.boundingBox())!;
    await page.mouse.down();
    await page.mouse.move(page.viewportSize()!.width / 2 + 36, page.viewportSize()!.height / 2 + 20, { steps: 4 });
    await page.mouse.up();
    expect((await image.boundingBox())!.x - beforeDrag.x).toBeCloseTo(36, 0);
    await page.keyboard.press('ArrowUp');
    await expect.poll(async () => (await image.boundingBox())!.width / beforeDrag.width).toBeCloseTo(1.25, 2);
    await page.keyboard.press('0');
    await page.screenshot({ path: info.outputPath(`${kind}-${theme}-fit.png`) });
    await image.click({ button: 'right' });
    const menu = page.getByRole('menu', { name: 'Generated image actions' });
    for (const name of ['发送到 AI 对话', '发送到画布', '导入 Photoshop（智能对象）', '复制图片', '下载图片']) await expect(menu.getByRole('menuitem', { name, exact: true })).toBeVisible();
    const menuBox = (await menu.boundingBox())!;
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(page.viewportSize()!.height);
    await page.keyboard.press('End');
    await expect(menu.getByRole('menuitem', { name: '下载图片', exact: true })).toBeFocused();
    await page.screenshot({ path: info.outputPath(`${kind}-${theme}-menu.png`) });
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });
 }
 test(`knowledge selector shares ${theme} palette and fits its content`, async ({ page }, info) => {
   await page.addInitScript(theme => localStorage.setItem('novus.theme.mode', theme), theme);
   await openEmptyApp(page);
   await openAgentPanel(page);
   await page.getByTestId('knowledge-base-trigger').click();
   const sheet = page.getByRole('dialog', { name: '选择知识库' });
   await expect(sheet).toHaveCSS('background-color', theme === 'dark' ? 'rgb(32, 37, 35)' : 'rgb(253, 253, 251)');
   expect((await sheet.boundingBox())!.height).toBeLessThan(500);
   const sheetBounds = (await sheet.boundingBox())!;
   const composerBounds = (await page.locator('.skill-chat-workbench__composer').boundingBox())!;
   const headerBounds = (await page.locator('.skill-chat-workbench__header').boundingBox())!;
   expect(composerBounds.y - (sheetBounds.y + sheetBounds.height)).toBeGreaterThanOrEqual(6);
   expect(composerBounds.y - (sheetBounds.y + sheetBounds.height)).toBeLessThanOrEqual(20);
   expect(sheetBounds.y).toBeGreaterThanOrEqual(headerBounds.y + headerBounds.height + 6);
   const choice = sheet.getByRole('button', { name: /场景 Skill/ });
   await choice.click();
   await expect(choice).toHaveAttribute('aria-pressed', 'true');
   await expect(sheet.getByText('选择 1 个知识库')).toBeVisible();
   await sheet.getByLabel('搜索知识库').fill('不存在的内容');
   await expect(choice).toHaveCount(0);
   await sheet.getByLabel('搜索知识库').clear();
   await expect(choice).toHaveAttribute('aria-pressed', 'true');
   await sheet.screenshot({ path: info.outputPath(`knowledge-${theme}.png`) });
 });
}
