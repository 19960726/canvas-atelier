import { expect, test } from './helpers/e2e-test';
import { openEmptyApp, queueProjectImageImport } from './helpers/app';
import { makeReferenceImage } from './helpers/fixtures';

for (const action of ['发送到 AI 对话', '发送到画布', '复制图片', '下载图片']) {
  test(`immersive material preview performs ${action}`, async ({ page }) => {
    await openEmptyApp(page);
    await page.evaluate(async () => window.__NOVUS_E2E__!.createModule('image_input', { x: 260, y: 140 }));
    await queueProjectImageImport(page, makeReferenceImage('Preview action.png', [80, 140, 100, 255], { width: 320, height: 240 }), { preservePixels: true });
    const node = page.locator('[data-module-type="image_input"]');
    await node.getByRole('button', { name: /Import image/ }).click();
    await node.getByRole('img', { name: 'Preview action', exact: true }).dblclick();
    const dialog = page.getByRole('dialog', { name: 'Generated image preview' });
    const stage = (await dialog.getByLabel('Generated image detail viewer').boundingBox())!;
    await expect.poll(async () => (await dialog.getByRole('img').boundingBox())!.height).toBeCloseTo(stage.height, 0);
    await dialog.getByRole('img').click({ button: 'right' });
    if (action === '复制图片') await page.evaluate(() => {
      window.novusDesktop!.projectImages.writeClipboardImage = async bytes => {
        (window as typeof window & { previewCopiedBytes?: number[] }).previewCopiedBytes = Array.from(bytes);
        return true;
      };
    });
    const downloadPromise = action === '下载图片' ? page.waitForEvent('download') : undefined;
    await page.getByRole('menuitem', { name: action, exact: true }).click();
    if (action === '发送到 AI 对话') {
      await expect(dialog).toBeHidden();
      await expect(page.getByTestId('agent-panel')).toBeVisible();
      await expect(page.getByLabel('Selected image references')).toContainText('Preview action');
    } else if (action === '发送到画布') {
      await expect(dialog).toBeHidden();
      await expect(page.locator('[data-module-type="image_input"]')).toHaveCount(2);
    } else if (action === '复制图片') {
      await expect(page.getByRole('menu', { name: 'Generated image actions' })).toBeHidden();
      const bytes = await page.evaluate(() => (window as typeof window & { previewCopiedBytes?: number[] }).previewCopiedBytes);
      expect(bytes!.slice(0, 8)).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      expect(bytes!.length).toBeGreaterThan(100);
      await expect(dialog).toBeVisible();
    } else {
      const download = await downloadPromise!;
      expect(download.suggestedFilename()).toContain('Preview action');
      expect(await download.failure()).toBeNull();
      await expect(dialog).toBeVisible();
    }
  });
}
