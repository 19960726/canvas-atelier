import { test, expect } from './helpers/e2e-test';
import { e2eState, openAgentPanel, openApp } from './helpers/app';

test('Skill chat shows a controlled error and allows a later retry without canvas changes', async ({ page }) => {
  await openApp(page);
  await openAgentPanel(page);
  await page.getByRole('tab', { name: '对话' }).click();

  const commitCount = (await e2eState(page)).commitCount;
  const composer = page.getByTestId('agent-composer-input');
  await composer.fill('force skill chat failure');
  await composer.press('Enter');

  await expect(page.getByRole('alert')).toContainText('Agent 对话暂时不可用');
  expect((await e2eState(page)).commitCount).toBe(commitCount);
  expect((await e2eState(page)).modelJobs).toHaveLength(0);
  expect((await e2eState(page)).modelSubmissions).toHaveLength(0);

  await composer.fill('retry with a concise art direction');
  await composer.press('Enter');

  await expect(page.getByText('Mock Skill reply: retry with a concise art direction')).toBeVisible();
  expect((await e2eState(page)).commitCount).toBe(commitCount);
  expect((await e2eState(page)).modelJobs).toHaveLength(0);
  expect((await e2eState(page)).modelSubmissions).toHaveLength(0);
});
