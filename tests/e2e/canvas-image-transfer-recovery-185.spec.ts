import { expect, test } from './helpers/e2e-test';
import { e2eState, openEmptyApp, queueProjectImageImport } from './helpers/app';
import { makeReferenceImage } from './helpers/fixtures';

for (const retryViaSave of [false, true]) {
  test(`image transfer recovers its original node with ${retryViaSave ? 'explicit save' : 'send'} retry`, async ({ page }, testInfo) => {
    await page.addInitScript(() => {
      const errors: string[] = [];
      (window as unknown as { canvasTransferErrors: string[] }).canvasTransferErrors = errors;
      window.addEventListener('error', event => errors.push(event.message));
    });
    await openEmptyApp(page);
    await page.evaluate(() => window.__NOVUS_E2E__!.createModule('image_input', { x: 180, y: 130 }));
    await queueProjectImageImport(page, makeReferenceImage('Transfer recovery.png', [48, 140, 112, 255], { width: 320, height: 240 }), { preservePixels: true });
    const input = page.locator('[data-module-type="image_input"]').first();
    await input.getByRole('button', { name: /Import image/u }).click();
    const originalId = await input.locator('xpath=..').getAttribute('data-id');
    const original = page.locator(`.react-flow__node[data-id="${originalId}"]`);
    const send = async () => {
      await original.getByRole('img', { name: 'Transfer recovery', exact: true }).dblclick();
      const preview = page.getByRole('dialog', { name: 'Generated image preview' });
      await preview.getByRole('img').click({ button: 'right' });
      await page.getByRole('menuitem', { name: '发送到画布', exact: true }).click();
      await expect(preview).toBeHidden();
    };
    const before = await e2eState(page);
    await page.evaluate(() => window.__NOVUS_E2E__!.failNextProjectCommit());
    await send();
    await expect(page.getByRole('alert', { name: '图片发送提示' })).toBeVisible();
    await expect.poll(async () => (await e2eState(page)).nodeCount).toBe(before.nodeCount + 1);
    if (retryViaSave) {
      await page.getByRole('button', { name: '保存项目', exact: true }).click();
      await expect.poll(async () => (await e2eState(page)).saveStatus).toBe('saved');
    }
    await send();
    await expect(page.getByRole('status', { name: '图片发送提示' })).toContainText('图片已添加到画布');
    const recovered = await e2eState(page);
    expect(recovered.nodeCount).toBe(before.nodeCount + 1);
    expect(recovered.durableNodeCount).toBe(recovered.nodeCount);
    expect(recovered.commitCount).toBe(before.commitCount + 1);
    const selected = page.locator('.react-flow__node.selected');
    await expect(selected).toHaveCount(1);
    expect(await selected.getAttribute('data-id')).not.toBe(originalId);
    await page.screenshot({ path: testInfo.outputPath(`recovered-${retryViaSave ? 'save' : 'send'}.png`) });
    await send();
    await expect.poll(async () => (await e2eState(page)).nodeCount).toBe(before.nodeCount + 2);
    expect((await e2eState(page)).durableNodeCount).toBe(before.nodeCount + 2);
    const undo = page.getByRole('button', { name: '撤销', exact: true });
    await undo.click();
    await expect.poll(async () => (await e2eState(page)).nodeCount).toBe(before.nodeCount + 1);
    await undo.click();
    await expect.poll(async () => (await e2eState(page)).nodeCount).toBe(before.nodeCount);
    const undone = await e2eState(page);
    expect(undone.durableNodeCount).toBe(before.nodeCount);
    expect(undone.undoDepth).toBe(before.undoDepth);
    await expect(original).toBeVisible();
    await page.evaluate(() => window.__NOVUS_E2E__!.reopenProject());
    await expect.poll(async () => (await e2eState(page)).nodeCount).toBe(before.nodeCount);
    expect((await e2eState(page)).durableNodeCount).toBe(before.nodeCount);
    await expect(original).toBeVisible();
    expect((await e2eState(page)).modelSubmissions).toHaveLength(0);
    expect(await page.evaluate(() => (window as unknown as { canvasTransferErrors: string[] }).canvasTransferErrors)).toEqual([]);
  });
}
