import { expect, test } from './helpers/e2e-test';
import { captureLayoutScreenshot, openEmptyApp } from './helpers/app';

const canvasRailOrder = [
  'tool-select',
  'tool-add-node',
  'tool-modules',
  'tool-undo',
  'tool-arrange',
  'agent-toggle',
  'history-toggle',
  'settings-toggle',
] as const;

const canvasRailIcons = [
  'select',
  'add-node',
  'modules',
  'undo',
  'arrange',
  'agent',
  'history',
  'settings',
] as const;

for (const theme of ['dark', 'light'] as const) {
  test(`matches the Canvas eight-action left rail in ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript((nextTheme) => localStorage.setItem('novus.theme.mode', nextTheme), theme);
    await openEmptyApp(page);

    const rail = page.getByTestId('toolrail');
    await expect(rail).toHaveJSProperty('offsetWidth', 60);
    const railBox = await rail.boundingBox();
    expect(railBox).not.toBeNull();
    expect(railBox!.height).toBeGreaterThan(400);
    expect(railBox!.height).toBeLessThan(470);
    await expect(rail.getByRole('button')).toHaveCount(8);
    await expect(rail.getByRole('group', { name: '画布编辑' }).getByRole('button')).toHaveCount(5);
    await expect(rail.getByRole('group', { name: '工作区' }).getByRole('button')).toHaveCount(2);
    await expect(rail.getByRole('group', { name: '应用' }).getByRole('button')).toHaveCount(1);
    await expect(rail.locator(':scope > .toolrail__spacer')).toHaveCount(0);
    await expect(page.getByTestId('tool-upload')).toHaveCount(0);
    await expect(page.getByTestId('tool-placement')).toBeHidden();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    let previousBottom = 0;

    for (const [index, testId] of canvasRailOrder.entries()) {
      const button = page.getByTestId(testId);
      await expect(button).toBeVisible();
      const box = await button.boundingBox();
      expect(box).toMatchObject({ width: 40, height: 40 });
      expect(box!.x - railBox!.x).toBe(10);
      if (index > 0) expect(box!.y).toBeGreaterThanOrEqual(previousBottom + 8);
      previousBottom = box!.y + box!.height;
      await expect(button).toHaveCSS('display', 'grid');
      await expect(button).toHaveCSS('border-radius', '11px');
      expect(await button.evaluate((element) => getComputedStyle(element, '::before').display)).toBe('none');
      await expect(button.locator('[data-rail-icon]')).toHaveAttribute(
        'data-rail-icon',
        canvasRailIcons[index],
      );
      if (testId === 'agent-toggle') {
        await expect(button.locator('.canvas-ai-orb--rail')).toBeVisible();
      } else {
        await expect(button.locator('[data-rail-icon] svg')).toBeVisible();
      }
    }

    await page.getByTestId('tool-add-node').click();
    await expect(page.getByTestId('quick-insert')).toBeVisible();
    await captureLayoutScreenshot(page, testInfo, `canvas-left-rail-${theme}`);
  });
}
