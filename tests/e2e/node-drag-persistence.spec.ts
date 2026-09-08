import { expect, test } from './helpers/e2e-test';
import { openEmptyApp } from './helpers/app';

test('keeps a dragged node in place through a save failure, retry, and project reopen', async ({ page }) => {
  await page.setViewportSize({ width: 1680, height: 1050 });
  await openEmptyApp(page);
  await page.evaluate(() => window.__NOVUS_E2E__!.createModule('image_input', { x: 260, y: 180 }));

  const card = page.locator('[data-module-type="image_input"]').last();
  const flowNode = card.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " react-flow__node ")]');
  await expect(flowNode).toBeVisible();
  const nodeId = await flowNode.getAttribute('data-id');
  expect(nodeId).toBeTruthy();
  const initialPosition = await readModulePosition(page, nodeId!);
  const initialBox = await flowNode.boundingBox();
  expect(initialBox).not.toBeNull();

  await page.evaluate(() => window.__NOVUS_E2E__!.failNextProjectCommit());
  const header = card.locator('.module-node__header');
  const headerBox = await header.boundingBox();
  expect(headerBox).not.toBeNull();
  await page.mouse.move(headerBox!.x + 28, headerBox!.y + headerBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(headerBox!.x + 328, headerBox!.y + headerBox!.height / 2 + 180, { steps: 12 });
  await page.mouse.up();

  await expect(page.getByTestId('save-state')).toHaveAttribute('data-save-state', 'error');
  await expect(page.getByRole('status', { name: '画布保存状态' })).toContainText('本地写入失败');
  const failedPosition = await readModulePosition(page, nodeId!);
  expect(failedPosition.x).toBeGreaterThan(initialPosition.x + 250);
  expect(failedPosition.y).toBeGreaterThan(initialPosition.y + 130);
  const failedBox = await flowNode.boundingBox();
  expect(failedBox!.x).toBeGreaterThan(initialBox!.x + 250);
  expect(failedBox!.y).toBeGreaterThan(initialBox!.y + 130);

  await page.getByRole('button', { name: '保存项目', exact: true }).click();
  await expect(page.getByTestId('save-state')).not.toHaveAttribute('data-save-state', 'error');
  await page.evaluate(() => window.__NOVUS_E2E__!.reopenProject());

  await expect(flowNode).toBeVisible();
  expect(await readModulePosition(page, nodeId!)).toEqual(failedPosition);
  const reopenedBox = await flowNode.boundingBox();
  expect(reopenedBox!.x).toBeCloseTo(failedBox!.x, 0);
  expect(reopenedBox!.y).toBeCloseTo(failedBox!.y, 0);
});

async function readModulePosition(page: import('@playwright/test').Page, nodeId: string) {
  return page.evaluate((id) => {
    const node = window.__NOVUS_E2E__!.getState().modulePositions.find((candidate) => candidate.id === id);
    if (!node) throw new Error(`Missing E2E module ${id}`);
    return node.position;
  }, nodeId);
}
