import { expect, test } from './helpers/e2e-test';
import { openAgentPanel, openApp } from './helpers/app';

for (const theme of ['dark', 'light'] as const) {
  test(`compact Agent controls keep visible keyboard focus in ${theme} theme`, async ({ page }) => {
    await page.addInitScript((mode) => localStorage.setItem('novus.theme.mode', mode), theme);
    await openApp(page);
    await openAgentPanel(page);

    const addMedia = page.getByTestId('agent-panel').getByRole('button', { name: '添加素材' });
    await expect(addMedia).toBeVisible();
    await addMedia.focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(addMedia).toBeFocused();

    const style = await addMedia.evaluate((button) => {
      const workspace = button.closest('.workspace--canvas-layout');
      const controlStyle = getComputedStyle(button);
      const workspaceStyle = workspace ? getComputedStyle(workspace) : null;
      return {
        control: workspaceStyle?.getPropertyValue('--canvas-compact-control').trim(),
        hit: workspaceStyle?.getPropertyValue('--canvas-compact-hit').trim(),
        gap: workspaceStyle?.getPropertyValue('--canvas-compact-gap').trim(),
        outlineStyle: controlStyle.outlineStyle,
        outlineWidth: parseFloat(controlStyle.outlineWidth),
      };
    });
    expect(style).toMatchObject({ control: '30px', hit: '38px', gap: '6px' });
    expect(style.outlineStyle).toBe('solid');
    expect(style.outlineWidth).toBeGreaterThanOrEqual(2);
  });
}
