import { test, expect } from './helpers/e2e-test';
import { openEmptyApp } from './helpers/app';

test('Agent floats, drags, resizes and minimizes without changing the canvas or draft', async ({ page }, testInfo) => {
  await openEmptyApp(page);
  await page.getByTestId('agent-toggle').click();
  const panel = page.getByTestId('agent-panel');
  await expect(panel).toBeVisible();
  const before = (await panel.boundingBox())!;
  expect(before.width).toBe(440);
  expect(before.height).toBe(720);
  const canvasTransform = await page.locator('.react-flow__viewport').getAttribute('style');
  const draft = panel.getByTestId('agent-composer-input');
  await draft.fill('请保留这个未发送的草稿');
  const handle = panel.getByRole('button', { name: '拖动 Agent 窗口' });
  const grip = (await handle.boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 - 220, grip.y + grip.height / 2 + 46, { steps: 15 });
  await page.mouse.up();
  const moved = (await panel.boundingBox())!;
  expect(moved.x).toBeCloseTo(before.x - 220, 0);
  expect(moved.y).toBeCloseTo(before.y + 46, 0);
  expect(await page.locator('.react-flow__viewport').getAttribute('style')).toBe(canvasTransform);
  await panel.getByRole('button', { name: '调整 Agent 窗口大小' }).focus();
  await page.keyboard.press('ArrowRight');
  expect((await panel.boundingBox())!.width).toBe(456);
  await panel.getByRole('button', { name: '最小化 Agent' }).click();
  expect((await panel.boundingBox())!.height).toBe(44);
  await expect(draft).not.toBeVisible();
  await panel.getByRole('button', { name: '展开 Agent' }).click();
  await expect(draft).toContainText('保留这个未发送');
  const modeSelect = panel.getByLabel('Agent 模式');
  await expect(modeSelect).toBeVisible();
  await expect(modeSelect.locator('option')).toHaveCount(3);
  await panel.getByRole('button', { name: '停靠到侧边' }).click();
  await expect(panel).toHaveAttribute('data-presentation-mode', 'docked');
  await expect(panel.getByRole('button', { name: '切换为浮窗' })).toBeVisible();
  const dockedBounds = (await panel.boundingBox())!;
  expect(dockedBounds.y).toBe(56);
  expect(dockedBounds.x + dockedBounds.width).toBe(page.viewportSize()!.width);
  expect(dockedBounds.height).toBeGreaterThan(800);
  await expect(draft).toContainText('保留这个未发送');
  await panel.getByRole('button', { name: '切换为浮窗' }).click();
  await expect(panel).toHaveAttribute('data-presentation-mode', 'floating');
  await expect(draft).toContainText('保留这个未发送');
  await panel.getByRole('button', { name: '历史对话', exact: true }).click();
  await expect(panel.getByRole('dialog', { name: '历史对话' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel.getByRole('dialog', { name: '历史对话' })).not.toBeVisible();
  const bounds = (await panel.boundingBox())!;
  for (const control of [draft, panel.getByRole('button', { name: '发送', exact: true }), panel.getByLabel('Agent 模式')]) {
    const rect = (await control.boundingBox())!;
    expect(rect.x).toBeGreaterThanOrEqual(bounds.x);
    expect(rect.x + rect.width).toBeLessThanOrEqual(bounds.x + bounds.width);
    expect(rect.y + rect.height).toBeLessThanOrEqual(bounds.y + bounds.height);
  }
  await page.screenshot({ path: testInfo.outputPath('floating-agent-light.png') });
  await page.setViewportSize({ width: 800, height: 600 });
  await expect.poll(async () => { const rect = (await panel.boundingBox())!; return rect.x + rect.width <= 792 && rect.y + rect.height <= 592; }).toBe(true);
});

for (const theme of ['light', 'dark'] as const) {
  test(`Agent history control uses a quiet active surface in ${theme}`, async ({ page }, testInfo) => {
    await page.addInitScript((mode) => localStorage.setItem('novus.theme.mode', mode), theme);
    await openEmptyApp(page);
    await page.getByTestId('agent-toggle').click();
    const panel = page.getByTestId('agent-panel');
    const history = panel.getByRole('button', { name: '历史对话', exact: true });
    await history.click();
    const historyDialog = panel.getByRole('dialog', { name: '历史对话' });
    await expect(historyDialog).toBeVisible();
    const closeHistory = historyDialog.getByRole('button', { name: '关闭历史对话' });
    await expect(closeHistory).toHaveCSS('width', '28px');
    await expect(closeHistory).toHaveCSS('height', '28px');
    await expect(closeHistory).toHaveCSS('border-radius', '7px');
    const historyBox = await historyDialog.boundingBox();
    const panelBox = await panel.boundingBox();
    expect(historyBox).not.toBeNull();
    expect(panelBox).not.toBeNull();
    expect(historyBox!.width).toBeLessThanOrEqual(340);
    expect(historyBox!.x).toBeGreaterThan(panelBox!.x + panelBox!.width - 360);
    await expect(historyDialog.locator('.agent-history-popover__item-icon')).toBeVisible();
    const activeBackground = await history.evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(activeBackground, 'The open history control should have a soft active surface instead of a floating bright outline.').not.toBe('rgba(0, 0, 0, 0)');
    await panel.screenshot({ path: testInfo.outputPath(`agent-history-${theme}.png`) });
  });
}

for (const theme of ['light', 'dark'] as const) {
  test(`Agent action strip stays reachable at its 360px minimum in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 720 });
    await page.addInitScript((mode) => {
      localStorage.setItem('novus.theme.mode', mode);
      localStorage.setItem('novus.agent-window.v1', JSON.stringify({ x: 620, y: 72, width: 360, height: 580 }));
    }, theme);
    await openEmptyApp(page);
    await page.getByTestId('agent-toggle').click();
    const panel = page.getByTestId('agent-panel');
    await expect(panel).toBeVisible();
    const composer = panel.locator('.skill-chat-workbench__composer');
    await expect(composer).toHaveCSS('gap', '6px');
    await expect(composer).toHaveCSS('border-radius', '14px');
    for (const [mode, value] of [['对话', 'chat'], ['创作 Agent', 'original'], ['Codex', 'codex']] as const) {
      await panel.getByLabel('Agent 模式').selectOption(value);
      const controls = [
        panel.getByLabel('Agent 模式'),
        panel.getByRole('button', { name: '添加素材' }),
        panel.getByRole('button', { name: '打开聊天模型菜单' }),
        panel.getByRole('button', { name: '新建对话' }),
        panel.getByRole('button', { name: '发送', exact: true }),
      ];
      if (mode !== 'Codex') controls.push(panel.getByRole('button', { name: '生成偏好' }));
      const bounds = (await panel.boundingBox())!;
      for (const control of controls) {
        await expect(control).toBeVisible();
        const rect = (await control.boundingBox())!;
        expect(rect.x, `${mode}: control left`).toBeGreaterThanOrEqual(bounds.x);
        expect(rect.x + rect.width, `${mode}: control right`).toBeLessThanOrEqual(bounds.x + bounds.width);
        expect(rect.y + rect.height, `${mode}: control bottom`).toBeLessThanOrEqual(bounds.y + bounds.height);
      }
    }
  });
}
