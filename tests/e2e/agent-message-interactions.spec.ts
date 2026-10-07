import { expect, test } from './helpers/e2e-test';
import { e2eState, openAgentPanel, openApp } from './helpers/app';

const response = ('## 边缘检查\n\n保留 **金属轮廓**，只整理背景。\n\n- 检查手部与杯盖的归属\n- 保留透明边缘\n\n| 对象 | 验收 |\n| --- | --- |\n| 杯盖 | 独立图层与原坐标一致 |\n| 手部 | 不含杯身和背景 |\n\n```text\n' + 'source-coordinate-proof-'.repeat(15) + '\n```\n\n' + '逐项核对蒙版、原始颜色和图层位置。\n\n'.repeat(24)).trimEnd();

for (const theme of ['light', 'dark'] as const) {
  for (const viewport of [{ width: 360, height: 760 }, { width: 1100, height: 760 }]) {
    test(`keeps message actions, rich replies and latest navigation usable in ${theme} ${viewport.width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      await page.addInitScript(({ theme, response }) => {
        localStorage.setItem('novus.theme.mode', theme);
        localStorage.setItem('agent-canvas:skill-chat:v2:local-project', JSON.stringify({ version: 2, activeConversationId: 'messages', conversations: [{
          id: 'messages', title: '边缘与图层检查', mode: 'chat', modelRoute: 'chat-default',
          reasoningEfforts: { chat: 'medium', original: 'medium', codex: 'medium' }, reverseAnalysisDepth: 'standard',
          knowledgeBaseIds: [], projectMemoryIds: [], createdAt: 1, updatedAt: 2,
          messages: [
            { id: 'request', role: 'user', mode: 'chat', content: '保留 **产品原结构** 与原机位，整理边缘，保持真实图层。' },
            { id: 'response', role: 'assistant', mode: 'chat', content: response },
          ],
        }] }));
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { (window as unknown as { copiedText: string }).copiedText = text; } } });
      }, { theme, response });
      await openApp(page);
      await openAgentPanel(page);
      const panel = page.getByTestId('agent-panel');
      const stream = panel.getByLabel('Agent 消息流');
      await expect.poll(() => stream.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(2);
      await stream.hover();
      await page.mouse.wheel(0, -10000);
      await expect.poll(() => stream.evaluate(element => element.scrollTop)).toBeLessThan(2);
      await expect(panel.getByRole('heading', { name: '边缘检查' })).toBeVisible();
      await expect(panel.getByRole('table')).toBeVisible();
      const reply = panel.locator('.skill-chat-workbench__message--assistant').first();
      await reply.getByRole('button', { name: '复制回复' }).click();
      await expect(reply.getByRole('status')).toHaveText('已复制');
      expect(await page.evaluate(() => (window as unknown as { copiedText: string }).copiedText)).toBe(response);
      await panel.screenshot({ path: testInfo.outputPath(`rich-message-${theme}-${viewport.width}.png`) });
      const geometry = await stream.evaluate(element => {
        const box = element.getBoundingClientRect();
        const messages = element.querySelector('.skill-chat-workbench__messages')!.getBoundingClientRect();
        const bodies = Array.from(element.querySelectorAll<HTMLElement>('.agent-message-body'));
        return { overflow: element.scrollWidth > element.clientWidth + 1, inset: messages.left - box.left,
          escapedBodies: bodies.filter(body => body.getBoundingClientRect().right > box.right).length,
          codeScroll: element.querySelector('pre')!.scrollWidth > element.querySelector('pre')!.clientWidth,
          buttonSize: element.querySelector('.agent-message-actions button')!.getBoundingClientRect().toJSON() };
      });
      expect(geometry.overflow).toBe(false);
      expect(geometry.inset).toBeGreaterThanOrEqual(12);
      expect(geometry.escapedBodies).toBe(0);
      expect(geometry.codeScroll).toBe(true);
      expect(geometry.buttonSize.width).toBe(28);
      expect(geometry.buttonSize.height).toBe(28);
      await testInfo.attach('message-scroll-geometry', { body: JSON.stringify(await stream.evaluate(element => ({
        scrollTop: element.scrollTop, clientHeight: element.clientHeight, scrollHeight: element.scrollHeight,
        messageHeight: element.querySelector('.skill-chat-workbench__messages')!.getBoundingClientRect().height,
        messagesOverflow: getComputedStyle(element.querySelector('.skill-chat-workbench__messages')!).overflow,
      }))), contentType: 'application/json' });
      await expect(panel.getByRole('button', { name: '回到最新消息' })).toBeVisible();
      await panel.getByRole('button', { name: '回到最新消息' }).click();
      await expect.poll(() => stream.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(2);
      await expect(panel.getByRole('button', { name: '回到最新消息' })).toHaveCount(0);
      await stream.evaluate(element => { element.scrollTop = 0; });
      await reply.getByRole('button', { name: '复制回复' }).focus();
      await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('fixture denied'); } } }); });
      await page.keyboard.press('Enter');
      await expect(reply.getByRole('status')).toHaveText('复制失败');
      await panel.getByRole('button', { name: '历史对话', exact: true }).click();
      const history = panel.getByRole('dialog', { name: '历史对话' });
      await history.locator('[aria-current="true"]').click();
      await expect(history).toHaveCount(0);
      await expect(panel.getByRole('button', { name: '历史对话', exact: true })).toBeFocused();
      expect((await e2eState(page)).modelSubmissions).toHaveLength(0);
    });
  }
}
