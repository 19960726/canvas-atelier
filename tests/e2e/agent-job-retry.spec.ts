import { test, expect } from './helpers/e2e-test';
import { e2eState, openAgentPanel, openApp } from './helpers/app';

test('Skill chat shows a controlled error and allows a later retry without canvas changes', async ({ page }) => {
  await openApp(page);
  await openAgentPanel(page);

  const commitCount = (await e2eState(page)).commitCount;
  await page.getByTestId('agent-composer-input').fill('force skill chat failure');
  await page.getByRole('button', { name: '发送' }).click();

  await expect(page.getByRole('alert')).toContainText('Agent 对话暂时不可用');
  expect((await e2eState(page)).commitCount).toBe(commitCount);
  expect((await e2eState(page)).modelJobs).toHaveLength(0);
  expect((await e2eState(page)).modelSubmissions).toHaveLength(0);

  await page.getByTestId('agent-composer-input').fill('retry with a concise art direction');
  await page.getByRole('button', { name: '发送' }).click();

  await expect(page.getByText('Mock Skill reply: retry with a concise art direction')).toBeVisible();
  expect((await e2eState(page)).commitCount).toBe(commitCount);
  expect((await e2eState(page)).modelJobs).toHaveLength(0);
  expect((await e2eState(page)).modelSubmissions).toHaveLength(0);
});
