import { expect, test } from './helpers/e2e-test';
import { captureLayoutScreenshot, e2eState, openApp, openEmptyApp } from './helpers/app';

for (const theme of ['dark', 'light'] as const) {
  test(`keeps reverse Agent visible in the Figma quick-insert menu in ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript((selectedTheme) => localStorage.setItem('novus.theme.mode', selectedTheme), theme);
    await openEmptyApp(page);

    await page.locator('.react-flow__pane').dblclick({ position: { x: 960, y: 360 } });
    const quickInsert = page.getByTestId('quick-insert');
    const reverseAgent = quickInsert.locator('[data-module-type="reverse_agent"]');
    const videoGeneration = quickInsert.locator('[data-module-type="video_generation"]');

    await expect(quickInsert).toBeVisible();
    // Figma 202:143: the formal double-click palette is one 300 × 578
    // surface with a 16px outer radius, not the compact legacy menu.
    await expect(quickInsert).toHaveJSProperty('offsetWidth', 300);
    await expect(quickInsert).toHaveJSProperty('offsetHeight', 578);
    await expect(quickInsert).toHaveCSS('border-radius', '16px');
    const imageInput = quickInsert.locator('[data-module-type="image_input"]');
    const videoInput = quickInsert.locator('[data-module-type="video_input"]');
    const imageInputBox = await imageInput.boundingBox();
    const videoInputBox = await videoInput.boundingBox();
    expect(imageInputBox).not.toBeNull();
    expect(videoInputBox).not.toBeNull();
    expect(imageInputBox!.height).toBe(40);
    expect(videoInputBox!.y - imageInputBox!.y).toBe(48);
    await expect(imageInput.locator('.quick-insert__module')).toHaveCSS('display', 'grid');
    const labelBox = await imageInput.locator('strong').boundingBox();
    expect(labelBox).not.toBeNull();
    expect(Math.round(labelBox!.x - imageInputBox!.x)).toBe(47);
    await expect(videoGeneration).toBeVisible();
    await expect(videoGeneration).toContainText('视频生成');
    await expect(reverseAgent).toBeVisible();
    await expect(reverseAgent).toContainText('Agent 反推');
    await captureLayoutScreenshot(page, testInfo, `quick-insert-reverse-${theme}`);
  });
}

test('creates an upstream module from a left input port Quick Insert connection', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.addInitScript(() => localStorage.setItem('novus.theme.mode', 'light'));
  await openApp(page);

  const before = await e2eState(page);
  expect(before.edgeCount).toBeGreaterThan(0);

  const target = page.locator('.react-flow__node[data-id="figma-image-generation"] .react-flow__handle.target[data-handleid="references"]');
  await expect(target).toBeVisible();
  const targetBox = await target.boundingBox();
  expect(targetBox).not.toBeNull();
  await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetBox!.x - 80, targetBox!.y + 360, { steps: 20 });
  await page.mouse.up();

  const quickInsert = page.getByTestId('quick-insert');
  await expect(quickInsert).toBeVisible();
  await expect(quickInsert.locator('[data-module-type="image_input"]')).toHaveCount(1);
  await quickInsert.locator('[data-module-type="image_input"] .quick-insert__module').click();

  await expect.poll(async () => (await e2eState(page)).edgeCount).toBe(before.edgeCount + 1);
  const after = await e2eState(page);
  expect(after.moduleTypes.filter((type) => type === 'image_input')).toHaveLength(2);
  const upstreamEdge = page.locator('.react-flow__edge[data-id^="module-edge-module-image_input-"]');
  await expect(upstreamEdge).toHaveCount(1);
  await expect(upstreamEdge.locator('.react-flow__edge-path')).toHaveAttribute('d', / C /u);
  await expect(quickInsert).toBeHidden();
  await captureLayoutScreenshot(page, testInfo, 'quick-insert-left-input-upstream');
});

test('creates a downstream generation module from an image output Quick Insert connection', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.addInitScript(() => localStorage.setItem('novus.theme.mode', 'light'));
  await openApp(page);

  const before = await e2eState(page);
  const source = page.locator('.react-flow__node[data-id="figma-image-input"] .react-flow__handle.source[data-handleid="image"]');
  await expect(source).toBeVisible();
  const sourceBox = await source.boundingBox();
  expect(sourceBox).not.toBeNull();
  await page.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(sourceBox!.x + 360, sourceBox!.y + 360, { steps: 20 });
  await page.mouse.up();

  const quickInsert = page.getByTestId('quick-insert');
  await expect(quickInsert).toBeVisible();
  await expect(quickInsert.locator('[data-module-type="image_generation"]')).toHaveCount(1);
  await quickInsert.locator('[data-module-type="image_generation"] .quick-insert__module').click();

  await expect.poll(async () => (await e2eState(page)).edgeCount).toBe(before.edgeCount + 1);
  const after = await e2eState(page);
  expect(after.moduleTypes.filter((type) => type === 'image_generation')).toHaveLength(
    before.moduleTypes.filter((type) => type === 'image_generation').length + 1,
  );
  await expect(quickInsert).toBeHidden();
});
