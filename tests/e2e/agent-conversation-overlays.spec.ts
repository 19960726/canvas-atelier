import { expect, test } from './helpers/e2e-test';
import { openAgentPanel, openApp, openEmptyApp } from './helpers/app';

const conversationKey = 'agent-canvas:skill-chat:v2:local-project';
const proposal = JSON.stringify({
  summary: '保留产品外观，调整构图与光线。',
  requirements: {
    goal: '制作清晰的产品场景图',
    mustKeep: ['产品结构'],
    mustChange: ['光线方向'],
    mustAvoid: ['产品变形'],
    acceptanceCriteria: ['轮廓清晰'],
  },
  observations: ['产品在画面中心。'],
  estimates: ['侧光可保留细节。'],
  unknowns: [],
  options: [{
    id: 'window-light', title: '自然窗光方案', reason: '保留产品外观和真实材质。', kind: 'image',
    prompt: '产品居中构图，保持产品比例与 Logo，以柔和自然窗光突出外壳材质，浅色真实场景背景，高清商业摄影，避免产品变形和虚假投影。', modelRoute: 'comfly-gemini-3-1-flash-image-preview',
    workflow: [{ title: '准备', detail: '锁定产品结构。' }, { title: '生成', detail: '生成候选图。' }],
  }],
});

async function expectTopmost(page: import('@playwright/test').Page, selector: string) {
  await page.locator(selector).scrollIntoViewIfNeeded();
  const result = await page.locator(selector).evaluate((element) => {
    const box = element.getBoundingClientRect();
    const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return element === top || element.contains(top);
  });
  expect(result, `${selector} must be usable above conversation bubbles`).toBe(true);
}

async function expectWorkbenchRows(panel: import('@playwright/test').Locator) {
  const boxes = await Promise.all([
    panel.locator('.skill-chat-workbench__header').boundingBox(),
    panel.locator('.skill-chat-workbench__context').boundingBox(),
    panel.locator('.skill-chat-workbench__stream').boundingBox(),
    panel.locator('.skill-chat-workbench__composer').boundingBox(),
    panel.boundingBox(),
  ]);
  for (const box of boxes) expect(box).not.toBeNull();
  const [header, context, stream, composer, boundary] = boxes.map((box) => box!);
  expect(header.y + header.height).toBeLessThanOrEqual(context.y + 1);
  expect(context.y + context.height).toBeLessThanOrEqual(stream.y + 1);
  expect(stream.y + stream.height).toBeLessThanOrEqual(composer.y + 6);
  expect(composer.y + composer.height).toBeLessThanOrEqual(boundary.y + boundary.height + 1);
  const memory = await panel.locator('.agent-thread__memory').boundingBox();
  const conversation = await panel.locator('.agent-thread__conversation').boundingBox();
  if (memory !== null && conversation !== null) {
    expect(conversation.y + conversation.height).toBeLessThanOrEqual(memory.y + 1);
    expect(memory.y + memory.height).toBeLessThanOrEqual(boundary.y + boundary.height + 1);
  }
}

for (const theme of ['light', 'dark'] as const) {
  for (const width of [360, 1440]) {
    test(`keeps task, project context and proposal actions usable above bubbles in ${theme} at ${width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(({ key, nextTheme, content }) => {
        localStorage.setItem('novus.theme.mode', nextTheme);
        localStorage.setItem(key, JSON.stringify({
          version: 2,
          activeConversationId: 'conversation-plan',
          conversations: [
            { id: 'conversation-plan', title: '方案任务', mode: 'original', reasoningEfforts: { chat: 'medium', original: 'medium', codex: 'medium' }, reverseAnalysisDepth: 'standard', knowledgeBaseIds: [], projectMemoryIds: [], messages: [
              { id: 'request', role: 'user', mode: 'original', content: '请给出产品场景方案。' },
              { id: 'proposal', role: 'assistant', mode: 'original', content },
            ], createdAt: 1, updatedAt: 3 },
            { id: 'conversation-other', title: '另一项任务', mode: 'chat', reasoningEfforts: { chat: 'medium', original: 'medium', codex: 'medium' }, reverseAnalysisDepth: 'standard', knowledgeBaseIds: [], projectMemoryIds: [], messages: [
              { id: 'other-request', role: 'user', mode: 'chat', content: '另一项任务的内容。' },
            ], createdAt: 2, updatedAt: 2 },
          ],
        }));
      }, { key: conversationKey, nextTheme: theme, content: proposal });

      await openApp(page);
      await openAgentPanel(page);
      const panel = page.getByTestId('agent-panel');
      const task = panel.getByRole('combobox', { name: 'Codex 任务' });
      const plan = panel.getByRole('region', { name: '创作方案' });
      const option = plan.getByRole('button', { name: '选择方案：自然窗光方案' });
      await expect(plan).toBeVisible();
      await expect(task).toBeVisible();
      await expectWorkbenchRows(panel);
      await expectTopmost(page, '[aria-label="Codex 任务"]');
      await expectTopmost(page, '[aria-label="选择方案：自然窗光方案"]');

      await panel.getByRole('button', { name: '历史对话' }).click();
      const history = panel.getByRole('dialog', { name: '历史对话' });
      await expect(history).toBeVisible();
      await expectTopmost(page, '.agent-history-popover__list > button:first-child');
      await history.getByRole('button', { name: /另一项任务/u }).click();
      await expect(task).toHaveValue('conversation-other');
      await expect(plan).toHaveCount(0);
      await task.selectOption('conversation-plan');
      await expect(plan).toBeVisible();

      await panel.getByRole('region', { name: '对话上下文' }).getByRole('button', { name: '展开上下文' }).click();
      await expect(panel.getByText('项目记忆', { exact: true }).first()).toBeVisible();
      await expectWorkbenchRows(panel);
      await expectTopmost(page, '.skill-chat-workbench__context-detail');
      await panel.getByRole('region', { name: '对话上下文' }).getByRole('button', { name: '收起上下文' }).click();
      await expect(panel.locator('.skill-chat-workbench__context-detail')).toHaveCount(0);

      await panel.getByRole('button', { name: '打开知识库' }).click();
      const library = panel.getByRole('dialog', { name: '选择知识库' });
      await expect(library).toBeVisible();
      await expectTopmost(page, '.skill-chat-workbench__sheet--library > header > button');
      await library.getByRole('button', { name: '关闭知识库' }).click();
      await expect(library).toHaveCount(0);
      await expectWorkbenchRows(panel);

      const stream = panel.locator('.skill-chat-workbench__stream');
      const [streamBox, planBox, optionBox] = await Promise.all([stream.boundingBox(), plan.boundingBox(), option.boundingBox()]);
      expect(streamBox).not.toBeNull();
      expect(planBox).not.toBeNull();
      expect(optionBox).not.toBeNull();
      expect(planBox!.x).toBeGreaterThanOrEqual(streamBox!.x);
      expect(planBox!.x + planBox!.width).toBeLessThanOrEqual(streamBox!.x + streamBox!.width + 1);
      expect(optionBox!.x).toBeGreaterThanOrEqual(planBox!.x);
      expect(optionBox!.x + optionBox!.width).toBeLessThanOrEqual(planBox!.x + planBox!.width + 1);
      await page.screenshot({ path: testInfo.outputPath(`agent-overlays-${theme}-${width}.png`) });
      await option.click();
      await expect(option).toHaveAttribute('aria-pressed', 'true');
      const confirmation = panel.getByLabel('待确认画布操作');
      await expect(confirmation).toBeVisible();
      const confirmAction = confirmation.locator('button.is-primary');
      await expect(confirmAction).toBeVisible();
      const [streamAfter, actionAfter] = await Promise.all([stream.boundingBox(), confirmAction.boundingBox()]);
      expect(streamAfter).not.toBeNull();
      expect(actionAfter).not.toBeNull();
      expect(actionAfter!.y).toBeGreaterThanOrEqual(streamAfter!.y);
      expect(actionAfter!.y + actionAfter!.height).toBeLessThanOrEqual(streamAfter!.y + streamAfter!.height + 1);
      await expectWorkbenchRows(panel);
      await page.screenshot({ path: testInfo.outputPath(`agent-proposal-selected-${theme}-${width}.png`) });
    });
  }
}

for (const width of [360, 1440]) {
  test(`keeps every Agent mode's composer controls inside the window at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await openEmptyApp(page);
    await openAgentPanel(page);
    const panel = page.getByTestId('agent-panel');
    for (const mode of ['chat', 'original', 'codex'] as const) {
      await panel.getByLabel('Agent 模式').selectOption(mode);
      const geometry = await panel.locator('.skill-chat-workbench__composer-footer').evaluate((footer) => {
        const box = footer.getBoundingClientRect();
        const visible = [...footer.children].filter((child) => getComputedStyle(child).display !== 'none' && !child.classList.contains('sr-only'));
        return {
          clientWidth: footer.clientWidth,
          scrollWidth: footer.scrollWidth,
          left: box.left,
          right: box.right,
          children: visible.map((child) => ({ name: child.className, rect: child.getBoundingClientRect().toJSON() })),
        };
      });
      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
      for (const child of geometry.children) {
        expect(child.rect.left, `${mode}: ${child.name} left`).toBeGreaterThanOrEqual(geometry.left - 1);
        expect(child.rect.right, `${mode}: ${child.name} right`).toBeLessThanOrEqual(geometry.right + 1);
      }
      await panel.locator('.skill-chat-workbench__composer').screenshot({ path: testInfo.outputPath(`composer-${mode}-${width}.png`) });
    }
  });
}
