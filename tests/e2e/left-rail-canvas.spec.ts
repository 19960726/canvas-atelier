import { expect, test } from './helpers/e2e-test';
import { captureLayoutScreenshot, openEmptyApp } from './helpers/app';

const canvasRailOrder = [
  'tool-select',
  'tool-add-node',
  'tool-modules',
  'tool-undo',
  'agent-toggle',
  'history-toggle',
  'settings-toggle',
] as const;

const canvasRailIcons = [
  'select',
  'add-node',
  'modules',
  'undo',
  'agent',
  'history',
  'settings',
] as const;

// UI Gate 425:152 uses these glyphs, not the generic icon-library drawings.
// Keeping the actual rendered glyphs in the assertion prevents the legacy
// Lucide rail from returning while the dimensions still happen to match.
const canvasRailGlyphs = ['⌖', '＋', '▦', '↶', '✦', '◷', null] as const;

for (const theme of ['dark', 'light'] as const) {
  test(`matches the Canvas seven-action left rail in ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript((nextTheme) => localStorage.setItem('novus.theme.mode', nextTheme), theme);
    await openEmptyApp(page);

    const rail = page.getByTestId('toolrail');
    await expect(rail).toHaveJSProperty('offsetWidth', 60);
    await expect(rail).toHaveJSProperty('offsetHeight', 390);
    await expect(rail.locator(':scope > button:visible')).toHaveCount(7);
    await expect(rail.locator(':scope > .toolrail__spacer')).toHaveCount(0);
    await expect(page.getByTestId('tool-upload')).toHaveCount(0);
    await expect(page.getByTestId('tool-placement')).toBeHidden();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const railBox = await rail.boundingBox();
    expect(railBox).not.toBeNull();

    for (const [index, testId] of canvasRailOrder.entries()) {
      const button = page.getByTestId(testId);
      await expect(button).toBeVisible();
      const box = await button.boundingBox();
      expect(box).toMatchObject({ width: 40, height: 40 });
      expect(box!.x - railBox!.x).toBe(10);
      expect(box!.y - railBox!.y).toBe(19 + index * 52);
      await expect(button).toHaveCSS('display', 'grid');
      await expect(button).toHaveCSS('border-radius', '11px');
      expect(await button.evaluate((element) => getComputedStyle(element, '::before').display)).toBe('none');
      await expect(button.locator('[data-rail-icon]')).toHaveAttribute(
        'data-rail-icon',
        canvasRailIcons[index],
      );
      if (canvasRailGlyphs[index] === null) {
        await expect(button.locator('[data-rail-icon] svg')).toBeVisible();
      } else {
        await expect(button.locator('[data-rail-icon]')).toHaveText(canvasRailGlyphs[index]!);
      }
    }

    await page.getByTestId('tool-add-node').click();
    await expect(page.getByTestId('quick-insert')).toBeVisible();
    await captureLayoutScreenshot(page, testInfo, `canvas-left-rail-${theme}`);
  });
}
