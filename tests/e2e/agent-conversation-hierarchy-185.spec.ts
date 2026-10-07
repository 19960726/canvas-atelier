import { expect, test } from './helpers/e2e-test';
import { e2eState, openAgentPanel, openApp } from './helpers/app';

const conversationKey = 'agent-canvas:skill-chat:v2:local-project';
const proposal = JSON.stringify({
  summary: '保留家庭空间与原始机位，分别处理人物姿态、桌面材质和早餐餐具。先核对完整约束，再选择执行方案。',
  requirements: {
    goal: '重构一家人的早餐场景，保持前中后景层次自然。',
    mustKeep: ['整体机位高度与原始透视角度', '左右人物关系与手部真实接触', '原产品轮廓、比例和结构'],
    mustChange: ['女孩站立并用双手拿起透明玻璃杯', '右侧女士坐下，与小孩一起吃早餐', '桌面替换为浅色大理石纹理'],
    mustAvoid: ['整张画面出现红色元素', '拉伸或改变产品比例', '背景景深过强导致橱柜和花瓶无法辨认'],
    acceptanceCriteria: ['女士面前盘子里恰好 6 个烧卖', '前景桌面、中景人物、背景墙面层次可辨', '所有手部动作与杯子接触关系真实'],
  },
  observations: ['人物与桌面已有明确空间关系，原始机位应保持。'],
  estimates: ['温和窗光有助于保留大理石与陶瓷的细节。'],
  unknowns: ['原始人物的完整身体姿态不可见，生成时需要检查手部和座椅。'],
  options: [
    { id: 'window-light', title: '自然窗光方案', reason: '柔和侧光保留原场景关系，强调桌面与人物的自然层次。', kind: 'image',
      prompt: 'Maintain the original camera angle and product proportions. A family breakfast scene with a standing girl holding a clear glass and a seated woman. Precisely six traditional shaomai on the plate. No red elements.',
      modelRoute: 'comfly-gemini-3-1-flash-image-preview',
      workflow: [{ title: '整理完整约束', detail: '保留机位、产品比例与人物关系。' }, { title: '执行自然窗光方案', detail: '处理人物姿态、材质与餐具。' }, { title: '检查数量与接触', detail: '核对 6 个烧卖、玻璃杯与手部接触。' }] },
    { id: 'soft-studio', title: '柔和补光方案', reason: '以轻量补光突出早餐餐具，并保持背景纹理可辨。', kind: 'image',
      prompt: 'Maintain the original perspective with subtle studio fill. Preserve the original product outline and proportions. The girl stands and the woman sits. Exactly six shaomai and no red elements; keep cabinet and vase textures readable.',
      modelRoute: 'comfly-gemini-3-1-flash-image-preview',
      workflow: [{ title: '保留主体关系', detail: '保持原产品及左右人物位置。' }, { title: '补光与材质处理', detail: '控制桌面与墙面的细节。' }, { title: '核验硬性要求', detail: '逐项核对数量、手部与颜色。' }] },
  ],
});

for (const theme of ['light', 'dark'] as const) {
  for (const width of [380, 1100]) {
    test(`retains complete requirements and real selection/confirmation in ${theme} at ${width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 960 });
      await page.addInitScript(({ key, content, nextTheme }) => {
        localStorage.setItem('novus.theme.mode', nextTheme);
        localStorage.setItem(key, JSON.stringify({ version: 2, activeConversationId: 'conversation-hierarchy', conversations: [{
          id: 'conversation-hierarchy', title: '早餐场景方案', mode: 'original',
          reasoningEfforts: { chat: 'medium', original: 'medium', codex: 'medium' }, reverseAnalysisDepth: 'deep',
          knowledgeBaseIds: [], projectMemoryIds: [], createdAt: 1, updatedAt: 2,
          messages: [{ id: 'request', role: 'user', mode: 'original', content: '请为家庭早餐场景制作工作流，保持原比例，女士面前恰好 6 个烧卖，禁止红色。' },
            { id: 'proposal', role: 'assistant', mode: 'original', content }],
        }] }));
      }, { key: conversationKey, content: proposal, nextTheme: theme });
      const pageErrors: string[] = [];
      page.on('pageerror', error => pageErrors.push(error.message));
      await openApp(page);
      await openAgentPanel(page);
      const panel = page.getByTestId('agent-panel');
      const plan = panel.getByRole('region', { name: '创作方案' });
      const requirements = plan.getByRole('region', { name: '需求分析' });
      await expect(requirements).toContainText('女士面前盘子里恰好 6 个烧卖');
      await expect(requirements).toContainText('拉伸或改变产品比例');
      await expect(requirements).toContainText('左右人物关系与手部真实接触');
      const geometry = await plan.evaluate(element => {
        const panelElement = element.closest('.agent-panel')!;
        const box = panelElement.getBoundingClientRect();
        const elements = [...element.querySelectorAll<HTMLElement>('section, dl, dd, .creative-plan__option, button, summary')];
        return { left: box.left, right: box.right, clipped: elements.filter(target => {
          const style = getComputedStyle(target);
          return style.display === 'none' || style.visibility === 'hidden'
            || (style.overflowY === 'hidden' && target.scrollHeight > target.clientHeight + 1)
            || target.getBoundingClientRect().left < box.left - 1 || target.getBoundingClientRect().right > box.right + 1;
        }).map(target => target.className || target.tagName) };
      });
      expect(geometry.clipped).toEqual([]);
      await panel.locator('.skill-chat-workbench__stream').evaluate(element => { element.scrollTop = 0; });
      await panel.screenshot({ path: testInfo.outputPath(`agent-requirements-${theme}-${width}.png`) });

      const option = plan.getByRole('button', { name: '选择方案：自然窗光方案' });
      const executionDetails = option.locator('..').locator('details');
      await executionDetails.locator('summary').click();
      await expect(executionDetails).toContainText('6 个烧卖');
      await expect(executionDetails).toContainText('原产品轮廓、比例和结构');
      await option.focus();
      await page.keyboard.press('Tab');
      await page.keyboard.press('Shift+Tab');
      await expect(option).toBeFocused();
      expect(await option.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe('none');
      const before = (await e2eState(page)).modelSubmissions.length;
      await option.click();
      await expect(option).toHaveAttribute('aria-pressed', 'true');
      await option.scrollIntoViewIfNeeded();
      await panel.screenshot({ path: testInfo.outputPath(`agent-selected-${theme}-${width}.png`) });

      const confirmation = panel.getByLabel('待确认画布操作');
      await expect(confirmation).toBeVisible();
      const confirm = confirmation.getByRole('button', { name: '确认执行生图', exact: true });
      await expect(confirm).toBeEnabled();
      await confirm.focus();
      await page.keyboard.press('Tab');
      await page.keyboard.press('Shift+Tab');
      await expect(confirm).toBeFocused();
      expect(await confirm.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe('none');
      await confirmation.locator('details > summary').click();
      await expect(confirmation.locator('details')).toContainText('6 个烧卖');
      await confirm.scrollIntoViewIfNeeded();
      const confirmBounds = (await confirm.boundingBox())!;
      const streamBounds = (await panel.locator('.skill-chat-workbench__stream').boundingBox())!;
      expect(confirmBounds.y).toBeGreaterThanOrEqual(streamBounds.y - 1);
      expect(confirmBounds.y + confirmBounds.height).toBeLessThanOrEqual(streamBounds.y + streamBounds.height + 1);
      await panel.screenshot({ path: testInfo.outputPath(`agent-confirmation-${theme}-${width}.png`) });
      await confirmation.getByRole('button', { name: '取消画布操作' }).click();
      await expect(confirmation).toHaveCount(0);
      await expect(option).toHaveAttribute('aria-pressed', 'false');
      await expect.poll(async () => (await e2eState(page)).modelSubmissions.length).toBe(before);
      expect(pageErrors).toEqual([]);
    });
  }
}
