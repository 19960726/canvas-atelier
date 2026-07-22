import { test, expect } from './helpers/e2e-test';
import { openEmptyApp } from './helpers/app';

test('opens and closes the generation history drawer from an empty canvas', async ({ page }) => {
  await openEmptyApp(page);

  const toggle = page.getByTestId('history-toggle');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');

  await toggle.click();
  const drawer = page.getByTestId('history-drawer');
  await expect(drawer).toBeVisible();
  await expect(drawer.locator('.history-empty')).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');

  await drawer.locator('header button').last().click();
  await expect(drawer).toBeHidden();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
});
