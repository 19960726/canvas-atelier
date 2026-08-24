import path from 'node:path';
import { expect, test } from './helpers/e2e-test';
import { openEmptyApp } from './helpers/app';

const artifact = (name: string) => path.join(process.cwd(), 'artifacts', '2026-08-06-agent-multimedia', name);

test('captures Agent bottom selectors and the Figma reverse knowledge picker', async ({ page }) => {
  await page.setViewportSize({ width: 1680, height: 1050 });
  await page.addInitScript(() => localStorage.setItem('novus.theme.mode', 'dark'));
  await openEmptyApp(page);

  await page.getByTestId('agent-toggle').click();
  await expect(page.getByTestId('agent-panel')).toBeVisible();
  await expect(page.getByTestId('knowledge-base-trigger')).toBeVisible();
  await expect(page.getByRole('button', { name: '添加素材' })).toBeEnabled();
  await expect(page.getByTestId('agent-model-trigger')).toBeVisible();
  await page.screenshot({ path: artifact('ui-check-agent-bottom-selectors-dark.png'), fullPage: true });

  await page.getByTestId('knowledge-base-trigger').click();
  const knowledgePicker = page.getByRole('dialog', { name: '选择知识库' });
  await expect(knowledgePicker).toHaveAttribute('data-anchor', 'composer-footer');
  await expect(knowledgePicker.getByRole('button', { name: /场景 Skill/ })).toBeEnabled();
  await expect(knowledgePicker.getByRole('button', { name: /电商详情页知识库/ })).toBeEnabled();
  await expect(knowledgePicker.getByRole('button', { name: /场景 Skill/ })).toContainText(/已同步|尚未同步/);
  await expect(knowledgePicker.getByRole('button', { name: /电商详情页知识库/ })).toContainText(/已同步|尚未同步/);
  await page.screenshot({ path: artifact('ui-check-agent-knowledge-picker-dark.png'), fullPage: true });
  await knowledgePicker.getByRole('button', { name: '关闭知识库' }).click();

  await page.getByTestId('agent-model-trigger').click();
  const modelPicker = page.getByRole('dialog', { name: '选择聊天模型' });
  await expect(modelPicker).toHaveAttribute('data-anchor', 'composer-footer');
  await page.screenshot({ path: artifact('ui-check-agent-model-picker-dark.png'), fullPage: true });

  await page.getByTestId('agent-toggle').click();
  await page.evaluate(async () => {
    await window.__NOVUS_E2E__!.createModule('reverse_agent', { x: 420, y: 150 });
  });
  const reverse = page.locator('[data-module-type="reverse_agent"]');
  await expect(reverse).toBeVisible();
  await expect(reverse.locator('.module-node__knowledge-label')).toHaveCount(1);
  const pseudoContent = await reverse.locator('.module-node__agent-knowledge').evaluate((element) => (
    getComputedStyle(element, '::before').content
  ));
  expect(['none', 'normal', '']).toContain(pseudoContent);
  await reverse.getByTestId('reverse-knowledge-trigger').click();
  const reversePicker = reverse.getByTestId('reverse-knowledge-picker');
  await expect(reversePicker).toHaveAttribute('data-anchor', 'reverse-agent-footer');
  await expect(reversePicker.getByTestId('knowledge-picker-search')).toBeVisible();
  await expect(reversePicker.getByRole('button', { name: /knowledge-option-/ })).toHaveCount(2);
  await page.screenshot({ path: artifact('ui-check-reverse-knowledge-picker-dark.png'), fullPage: true });
});

test('captures the same reverse knowledge surface in light theme', async ({ page }) => {
  await page.setViewportSize({ width: 1680, height: 1050 });
  await page.addInitScript(() => localStorage.setItem('novus.theme.mode', 'light'));
  await openEmptyApp(page);

  await page.evaluate(async () => {
    await window.__NOVUS_E2E__!.createModule('reverse_agent', { x: 420, y: 150 });
  });
  const reverse = page.locator('[data-module-type="reverse_agent"]');
  await reverse.getByTestId('reverse-knowledge-trigger').click();
  await expect(reverse.getByTestId('reverse-knowledge-picker')).toBeVisible();
  await page.screenshot({ path: artifact('ui-check-reverse-knowledge-picker-light.png'), fullPage: true });
});
