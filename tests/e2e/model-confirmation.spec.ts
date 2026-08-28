import { test, expect } from './helpers/e2e-test';
import { e2eState, openAgentPanel, openApp } from './helpers/app';

test('Skill chat lists only chat routes and keeps its advice separate from model jobs', async ({ page }) => {
  await openApp(page);
  await openAgentPanel(page);

  await page.getByRole('tab', { name: '对话' }).click();
  await page.getByTestId('agent-model-trigger').click();
  const routes = page.getByRole('dialog', { name: '选择聊天模型' });
  await expect(routes).toContainText('gpt-5.6-sol');
  await expect(routes).not.toContainText('GPT Image');
  await expect(routes).not.toContainText('Nano Banana 2');

  await page.getByRole('button', { name: '使用 gpt-5.6-sol' }).first().click();
  const composer = page.getByTestId('agent-composer-input');
  await composer.fill('give me a lighting direction');
  await composer.press('Enter');

  await expect(page.getByText('Mock Skill reply: give me a lighting direction')).toBeVisible();
  await expect(page.getByLabel('知识库请求: Gemini Vision')).toHaveCount(0);
  const state = await e2eState(page);
  expect(state.modelJobs).toHaveLength(0);
  expect(state.modelSubmissions).toHaveLength(0);
});
