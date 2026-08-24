import { test, expect } from './helpers/e2e-test';
import { e2eState, openAgentPanel, openApp } from './helpers/app';

test('Skill chat lists only chat routes and keeps its advice separate from model jobs', async ({ page }) => {
  await openApp(page);
  await openAgentPanel(page);

  await page.getByTestId('agent-model-trigger').click();
  const routes = page.getByRole('dialog', { name: '选择聊天模型' });
  await expect(routes).toContainText('Gemini Vision');
  await expect(routes).not.toContainText('GPT Image');
  await expect(routes).not.toContainText('Nano Banana 2');

  await page.getByRole('button', { name: '使用 Gemini Vision' }).first().click();
  await page.getByTestId('agent-composer-input').fill('give me a lighting direction');
  await page.getByRole('button', { name: '发送' }).click();

  await expect(page.getByLabel('知识库请求: Gemini Vision')).toBeVisible();
  await expect(page.getByText('Mock Skill reply: give me a lighting direction')).toBeVisible();
  const state = await e2eState(page);
  expect(state.modelJobs).toHaveLength(0);
  expect(state.modelSubmissions).toHaveLength(0);
});
