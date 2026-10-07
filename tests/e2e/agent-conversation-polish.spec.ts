import { expect, test } from './helpers/e2e-test';
import { e2eState, openAgentPanel, openApp } from './helpers/app';

const conversationKey = 'agent-canvas:skill-chat:v2:local-project';
const latestTitle = '保留产品结构与原始机位，调整早餐场景的光线、材质和人物动作';
const proposal = JSON.stringify({
  summary: '保留产品外观与原始机位，通过自然窗光整理早餐场景的层次。',
  requirements: {
    goal: '调整人物动作、桌面材质和餐具，保持原有空间关系。',
    mustKeep: ['产品结构与比例', '原始机位和透视关系'],
    mustChange: ['女孩双手拿起透明玻璃杯', '桌面改为浅色大理石纹理'],
    mustAvoid: ['产品变形', '手部与杯子接触错误'],
    acceptanceCriteria: ['盘内恰好 6 个烧卖', '前中后景层次自然'],
  },
  observations: ['产品位于画面中心，人物分列两侧。'],
  estimates: [], unknowns: [],
  options: [{
    id: 'window-light', title: '自然窗光方案', kind: 'image',
    reason: '柔和侧光保留真实材质，让桌面与人物的关系更自然。',
    modelRoute: 'comfly-gemini-3-1-flash-image-preview',
    prompt: '保持原始透视与产品比例，女孩双手拿起透明玻璃杯，浅色大理石桌面，盘内恰好 6 个烧卖，手部接触真实。',
    workflow: [
      { title: '整理完整约束', detail: '锁定产品、人物关系与禁止修改项。' },
      { title: '处理光线与材质', detail: '以自然窗光保留玻璃、大理石和产品表面纹理。' },
      { title: '逐项核对结果', detail: '核对 6 个烧卖、手部接触与产品比例。' },
    ],
  }],
});

for (const theme of ['light', 'dark'] as const) {
  for (const width of [380, 1100]) {
    test(`polishes bubbles, workflow and memory without changing Agent flow in ${theme} at ${width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 960 });
      await page.addInitScript(({ key, content, theme }) => {
        localStorage.setItem('novus.theme.mode', theme);
        localStorage.setItem(key, JSON.stringify({ version: 2, activeConversationId: 'polish', conversations: [{
          id: 'polish', title: '早餐场景方案', mode: 'original',
          reasoningEfforts: { chat: 'medium', original: 'medium', codex: 'medium' }, reverseAnalysisDepth: 'deep',
          knowledgeBaseIds: [], projectMemoryIds: [], createdAt: 1, updatedAt: Date.now(),
          messages: [
            { id: 'request', role: 'user', mode: 'original', content: '优化早餐场景，保留产品结构和原机位，检查杯子与手部接触，盘内恰好 6 个烧卖。' },
            { id: 'proposal', role: 'assistant', mode: 'original', content },
          ],
        }, ...Array.from({ length: 6 }, (_, index) => ({
          id: `history-${index}`, title: `旧任务 ${index + 1}：保留完整产品结构与真实光线`, mode: 'chat',
          reasoningEfforts: { chat: 'medium', original: 'medium', codex: 'medium' }, reverseAnalysisDepth: 'deep',
          knowledgeBaseIds: [], projectMemoryIds: [], createdAt: 1, updatedAt: Date.now() - (index + 1) * 60_000,
          messages: [],
        }))] }));
      }, { key: conversationKey, content: proposal, theme });
      await openApp(page);
      await page.evaluate(async latestTitle => {
        const modulePath = '/src/app/app-store.ts';
        const { useAppStore } = await import(modulePath);
        const state = useAppStore.getState();
        const entries = Array.from({ length: 16 }, (_, index) => ({
          schemaVersion: 1, id: `memory-polish-${index}`, projectId: state.project.id,
          projectRevision: index === 15 ? 15 : index + 1,
          createdAt: new Date(Date.UTC(2026, 9, 6, 8, index)).toISOString(),
          kind: 'decision', actor: 'user', title: index === 15 ? latestTitle : `构图决策 ${index + 1}`,
          changeSummary: '保留结构，调整光线与人物动作。', rationale: '使场景关系与真实产品保持一致。',
          snapshots: { beforeId: `before-${index}`, afterId: `after-${index}` },
          context: { referenceAssetIds: [], resultAssetIds: [] },
          feedback: { keep: ['产品结构'], change: ['光线'], never: ['产品变形'] },
          nextStep: '按完整约束核对下一版。',
        }));
        useAppStore.setState({ project: { ...state.project, projectMemory: entries } });
      }, latestTitle);
      await openAgentPanel(page);
      const panel = page.getByTestId('agent-panel');
      const stream = panel.locator('.skill-chat-workbench__stream');
      await stream.evaluate(element => { element.scrollTop = 0; });
      await panel.screenshot({ path: testInfo.outputPath(`conversation-${theme}-${width}.png`) });

      const originalStream = (await stream.boundingBox())!;
      const originalComposer = (await panel.locator('.skill-chat-workbench__composer').boundingBox())!;
      const memoryTrigger = panel.getByRole('button', { name: '项目记忆', exact: true });
      await memoryTrigger.focus();
      await page.keyboard.press('Enter');
      const memory = panel.getByRole('dialog', { name: '项目记忆' });
      const summary = memory.locator('.agent-memory-summary');
      await expect(summary).toContainText('16 条');
      await expect(summary).toContainText(latestTitle);
      await expect(memoryTrigger).toHaveAttribute('aria-expanded', 'true');
      const list = memory.locator('.project-memory__list');
      await expect(list.locator('article')).toHaveCount(16);
      await expect(list.locator('article').first()).toContainText(latestTitle);
      await expect(list.locator('article').first()).toBeVisible();
      await expect(memory.getByRole('combobox', { name: '记忆类型筛选' })).toBeVisible();
      await panel.screenshot({ path: testInfo.outputPath(`memory-top-${theme}-${width}.png`) });
      await list.evaluate(element => { element.scrollTop = element.scrollHeight; });
      await expect(summary).toBeVisible();
      const recordVisibility = await list.evaluate(element => {
        const box = element.getBoundingClientRect();
        const last = element.lastElementChild!.getBoundingClientRect();
        const title = element.lastElementChild!.querySelector('h3')!;
        const titleBox = title.getBoundingClientRect();
        const top = document.elementFromPoint(titleBox.left + 2, titleBox.top + 2);
        return { list: box.toJSON(), last: last.toJSON(), clientHeight: element.clientHeight,
          scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, style: getComputedStyle(element).display,
          lastVisibility: getComputedStyle(element.lastElementChild!).visibility,
          titleBox: titleBox.toJSON(), topmost: top?.className, titleIsTopmost: title === top || title.contains(top),
          ancestors: [element.parentElement!, element.parentElement!.parentElement!].map(parent => ({
            name: parent.className, box: parent.getBoundingClientRect().toJSON(), display: getComputedStyle(parent).display,
            height: getComputedStyle(parent).height, padding: getComputedStyle(parent).padding,
            flexDirection: getComputedStyle(parent).flexDirection, rows: getComputedStyle(parent).gridTemplateRows,
          })) };
      });
      await testInfo.attach('memory-scroll-geometry', { body: JSON.stringify(recordVisibility, null, 2), contentType: 'application/json' });
      expect(recordVisibility.last.bottom).toBeGreaterThan(recordVisibility.list.top);
      expect(recordVisibility.last.top).toBeLessThan(recordVisibility.list.bottom);
      expect(recordVisibility.clientHeight).toBeGreaterThan(60);
      expect(recordVisibility.titleIsTopmost).toBe(true);
      const bounds = await panel.evaluate(element => {
        const box = (selector: string) => element.querySelector(selector)!.getBoundingClientRect().toJSON();
        const list = element.querySelector('.project-memory__list')!;
        return { panel: element.getBoundingClientRect().toJSON(), composer: box('.skill-chat-workbench__composer'),
          memory: box('.agent-thread__memory'), stream: box('.skill-chat-workbench__stream'),
          listOverflows: list.scrollHeight > list.clientHeight, memoryOverflow: element.querySelector('.agent-thread__memory')!.scrollWidth > element.querySelector('.agent-thread__memory')!.clientWidth + 1 };
      });
      expect(bounds.listOverflows).toBe(true);
      expect(bounds.memoryOverflow).toBe(false);
      expect(bounds.stream.height).toBeGreaterThan(80);
      expect(bounds.memory.y + bounds.memory.height).toBeLessThanOrEqual(bounds.composer.y - 6);
      expect(bounds.stream.y).toBe(originalStream.y);
      expect(bounds.stream.height).toBe(originalStream.height);
      expect(bounds.composer.y).toBe(originalComposer.y);
      await panel.screenshot({ path: testInfo.outputPath(`memory-expanded-${theme}-${width}.png`) });
      await page.keyboard.press('Escape');
      await expect(memory).toHaveCount(0);
      await expect(memoryTrigger).toBeFocused();

      const historyTrigger = panel.getByRole('button', { name: '历史对话', exact: true });
      await expect(historyTrigger).toContainText('早餐场景方案');
      await historyTrigger.click();
      const history = panel.getByRole('dialog', { name: '历史对话' });
      await expect(history.getByRole('button', { name: '新建对话', exact: true })).toBeVisible();
      await expect(history.locator('.agent-history-popover__list > button')).toHaveCount(3);
      await expect(history.locator('[aria-current="true"]')).toContainText('早餐场景方案');
      await panel.screenshot({ path: testInfo.outputPath(`history-recent-${theme}-${width}.png`) });
      await history.getByRole('button', { name: '更多对话 · 4', exact: true }).click();
      await expect(history.locator('.agent-history-popover__list > button')).toHaveCount(7);
      await panel.screenshot({ path: testInfo.outputPath(`history-${theme}-${width}.png`) });
      await memoryTrigger.click();
      await expect(history).toHaveCount(0);
      await expect(memory).toBeVisible();
      await memory.getByRole('button', { name: '关闭项目记忆' }).click();
      await expect(memory).toHaveCount(0);

      const user = panel.locator('.skill-chat-workbench__message--user').first();
      const bubble = await user.evaluate(element => {
        const style = getComputedStyle(element);
        const parent = element.parentElement!.getBoundingClientRect();
        const box = element.getBoundingClientRect();
        return { radius: Number.parseFloat(style.borderTopLeftRadius), rightGap: parent.right - box.right, leftGap: box.left - parent.left };
      });
      expect(bubble.radius).toBeLessThanOrEqual(8);
      expect(bubble.rightGap).toBeLessThan(bubble.leftGap);
      const workflow = panel.getByRole('region', { name: '工作流预览：自然窗光方案' });
      const line = await workflow.locator('li').first().evaluate(element => {
        const style = getComputedStyle(element, '::after');
        return { content: style.content, width: Number.parseFloat(style.width) };
      });
      expect(line.content).toBe('""');
      expect(line.width).toBe(1);
      const before = (await e2eState(page)).modelSubmissions.length;
      const option = panel.getByRole('button', { name: '选择方案：自然窗光方案' });
      await option.click();
      await expect(option).toHaveAttribute('aria-pressed', 'true');
      const confirmation = panel.getByLabel('待确认画布操作');
      await expect(confirmation.getByRole('button', { name: '确认执行生图', exact: true })).toBeEnabled();
      await confirmation.getByRole('button', { name: '取消画布操作' }).click();
      await expect(option).toHaveAttribute('aria-pressed', 'false');
      expect((await e2eState(page)).modelSubmissions.length).toBe(before);
      await workflow.scrollIntoViewIfNeeded();
      await panel.screenshot({ path: testInfo.outputPath(`workflow-${theme}-${width}.png`) });
      await historyTrigger.click();
      await panel.getByRole('dialog', { name: '历史对话' }).getByRole('button', { name: '新建对话', exact: true }).click();
      await expect(panel.getByRole('region', { name: '创作方案' })).toHaveCount(0);
      await expect(panel.getByRole('dialog', { name: '历史对话' })).toHaveCount(0);
      await historyTrigger.click();
      await panel.getByRole('dialog', { name: '历史对话' }).getByRole('button', { name: /早餐场景方案/u }).click();
      await expect(panel.getByRole('region', { name: '创作方案' })).toBeVisible();
      await expect(panel.getByLabel('Agent 模式')).toHaveValue('original');
      await page.setViewportSize({ width, height: 580 });
      await memoryTrigger.click();
      await expect(memory).toBeVisible();
      const shortBounds = await memory.boundingBox();
      const shortComposer = await panel.locator('.skill-chat-workbench__composer').boundingBox();
      expect(shortBounds!.y + shortBounds!.height).toBeLessThanOrEqual(shortComposer!.y - 6);
      await panel.screenshot({ path: testInfo.outputPath(`memory-short-${theme}-${width}.png`) });
      await panel.getByTestId('agent-composer-input').click();
      await expect(memory).toHaveCount(0);
      expect((await e2eState(page)).modelSubmissions.length).toBe(before);
    });
  }
}
