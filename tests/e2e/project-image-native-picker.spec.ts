import { expect, test } from './helpers/e2e-test';
import { e2eState, openEmptyApp, queueProjectImageImport } from './helpers/app';
import { makeReferenceImage } from './helpers/fixtures';

for (const activation of ['pointer', 'keyboard'] as const) {
  test(`managed image picker preserves first native ${activation} opening and newly imported choices`, async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.addInitScript((theme) => localStorage.setItem('novus.theme.mode', theme), activation === 'pointer' ? 'light' : 'dark');
    await openEmptyApp(page);
    await page.evaluate(async () => {
      await window.__NOVUS_E2E__!.createModule('image_input', { x: 180, y: 240 });
      await window.__NOVUS_E2E__!.createModule('image_input', { x: 640, y: 240 });
    });
    const source = page.locator('[data-module-type="image_input"]').first();
    const importNode = page.locator('[data-module-type="image_input"]').nth(1);
    await queueProjectImageImport(page, makeReferenceImage('Initial material.png', [20, 100, 170, 255]));
    await source.getByRole('button', { name: '导入图像 / Import image' }).click();
    await queueProjectImageImport(page, makeReferenceImage('Second material.png', [170, 100, 20, 255]));
    await importNode.getByRole('button', { name: '导入图像 / Import image' }).click();
    const picker = source.getByLabel('选择项目图像 / Choose project image');
    await expect(picker).toHaveValue('0000000000000001');
    await expect(picker.locator('option')).toHaveCount(2);

    const openNativePicker = async () => {
      if (activation === 'pointer') {
        await picker.click();
      } else {
        await source.getByRole('button', { name: '更换图像 / Replace image' }).focus();
        await page.keyboard.press('Tab');
        await expect(picker).toBeFocused();
        await page.keyboard.press('Alt+ArrowDown');
      }
    };
    await openNativePicker();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await expect(picker).toHaveValue('0000000000000002');
    await expect(source.getByRole('img', { name: 'Second material' })).toBeVisible();
    await expect.poll(async () => (await e2eState(page)).recentTransactionLabels.some(entry => entry.label === 'Select managed project image')).toBe(true);

    await queueProjectImageImport(page, makeReferenceImage('Fresh imported material.png', [100, 170, 20, 255]));
    await importNode.getByRole('button', { name: '更换图像 / Replace image' }).click();
    await expect(picker.locator('option')).toHaveCount(4);
    await openNativePicker();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await expect(picker).toHaveValue('0000000000000003');
    await expect(source.getByRole('img', { name: 'Fresh imported material' })).toBeVisible();
    await expect.poll(async () => (await e2eState(page)).projectImages).toHaveLength(3);
  });
}