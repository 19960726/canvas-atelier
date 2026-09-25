import { expect, test } from './helpers/e2e-test';
import { openAgentPanel, openApp } from './helpers/app';

for (const theme of ['light', 'dark']) {
 for (const width of [580, 360]) {
  test(`long conversation context and bottom model picker remain usable in ${theme} at ${width}`, async ({ page }, testInfo) => {
    await page.addInitScript(({ theme, width }) => {
      localStorage.setItem('novus.theme.mode', theme);
      localStorage.setItem('novus.agent-window.v1', JSON.stringify({ x: 100, y: 20, width, height: width === 360 ? 520 : 760 }));
      localStorage.setItem('agent-canvas:skill-chat:v2:local-project', JSON.stringify({ version: 2, activeConversationId: 'long', conversations: [{
        id: 'long', title: '长对话与展开上下文', mode: 'chat', reasoningEfforts: { chat: 'medium', original: 'medium', codex: 'medium' },
        reverseAnalysisDepth: 'standard', knowledgeBaseIds: [], projectMemoryIds: [], createdAt: 1, updatedAt: 1,
        messages: Array.from({ length: 12 }, (_, i) => ({ id: `message-${i}`, role: i % 2 ? 'assistant' : 'user', mode: 'chat', content: '保留产品结构、空间透视与真实材质，调整摄影焦点和光线方向。'.repeat(15) })),
      }] }));
    }, { theme, width });
    await openApp(page);
    await openAgentPanel(page);
    const panel = page.getByTestId('agent-panel');
    await expect(panel.locator('.skill-chat-workbench__message')).toHaveCount(12);
    expect(await panel.getByLabel('Codex 任务').evaluate((select) => {
      const box = select.getBoundingClientRect();
      return select === document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    }), 'task selector must also stay above floating canvas tools').toBe(true);
    await panel.getByRole('button', { name: /展开上下文/u }).click();
    const geometry = await panel.evaluate((panel) => {
      const detail = panel.querySelector('.skill-chat-workbench__context-detail')!;
      const context = panel.querySelector('.skill-chat-workbench__context')!.getBoundingClientRect();
      const stream = panel.querySelector('.skill-chat-workbench__stream')!.getBoundingClientRect();
      const box = detail.getBoundingClientRect();
      const top = document.elementFromPoint(box.left + box.width / 2, box.bottom - 12);
      return { detailBottom: box.bottom, contextBottom: context.bottom, streamTop: stream.top, topmost: detail.contains(top) };
    });
    expect(geometry.detailBottom).toBeLessThanOrEqual(geometry.contextBottom + 1);
    expect(geometry.detailBottom).toBeLessThanOrEqual(geometry.streamTop + 1);
    expect(geometry.topmost).toBe(true);
    await panel.screenshot({ path: testInfo.outputPath(`long-context-${theme}.png`) });
    await panel.getByRole('button', { name: '收起上下文' }).click();
    for (const mode of ['chat', 'original']) {
      await panel.getByLabel('Agent 模式').selectOption(mode);
      await panel.getByTestId('agent-model-trigger').click();
      const picker = panel.getByRole('dialog', { name: '选择聊天模型' });
      await expect(picker).toBeVisible();
      const box = await picker.boundingBox();
      const boundary = await panel.boundingBox();
      const popup = await panel.locator('.codex-reasoning__popover').boundingBox();
      expect(popup!.y).toBeGreaterThanOrEqual(boundary!.y);
      expect(popup!.x).toBeGreaterThanOrEqual(boundary!.x);
      expect(popup!.x + popup!.width).toBeLessThanOrEqual(boundary!.x + boundary!.width);
      const footer = await panel.locator('.skill-chat-workbench__composer-footer').boundingBox();
      expect(Math.abs(footer!.y - (box!.y + box!.height)), 'model list must end directly above composer controls').toBeLessThan(35);
      await panel.screenshot({ path: testInfo.outputPath(`models-${mode}-${theme}.png`) });
      await picker.getByRole('button', { name: '关闭模型选择' }).click();
    }
    const colors = await panel.getByLabel('Agent 模式').locator('option').first().evaluate((option) => ({ color: getComputedStyle(option).color, background: getComputedStyle(option).backgroundColor }));
    expect(colors.background).not.toBe('rgba(0, 0, 0, 0)');
    expect(colors.color).not.toBe(colors.background);
  });
  test(`workflow models stay searchable and selected in ${theme} at ${width}`, async ({ page }, testInfo) => {
    await page.addInitScript(({ theme, width }) => {
      localStorage.setItem('novus.theme.mode', theme);
      localStorage.setItem('novus.agent-window.v1', JSON.stringify({ x: 100, y: 20, width, height: width === 360 ? 520 : 760 }));
    }, { theme, width });
    await openApp(page);
    await openAgentPanel(page);
    const panel = page.getByTestId('agent-panel');
    await panel.getByLabel('Agent 模式').selectOption('original');
    await panel.getByRole('button', { name: '生成偏好', exact: true }).click();
    const sheet = panel.getByRole('dialog', { name: '生成偏好' });
    const names: string[] = [];
    for (const kind of ['图片', '视频']) {
      await sheet.getByRole('tab', { name: kind, exact: true }).click();
      const list = sheet.getByRole('list', { name: `可用${kind}模型` });
      const accessibleNames = await list.locator('button').evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label') ?? ''));
      const duplicates = accessibleNames.filter((name, index) => accessibleNames.indexOf(name) !== index);
      expect(duplicates, `${kind}模型列表不应包含用户无法区分的同名选项`).toEqual([]);
      const candidate = list.getByRole('button').first();
      const name = (await candidate.getAttribute('aria-label'))!;
      names.push(name);
      await candidate.click();
      await expect(candidate).toHaveAttribute('aria-pressed', 'true');
      expect((await candidate.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      const unselected = list.locator('button[aria-pressed="false"]').first();
      if (await unselected.count()) {
        const colors = await unselected.evaluate((button) => ({ background: getComputedStyle(button).backgroundColor, selected: getComputedStyle(button.closest('[role="list"]')!.querySelector('[aria-pressed="true"]')!).backgroundColor }));
        expect(colors.background).not.toBe(colors.selected);
      }
      await expect(sheet.getByLabel('生成模型选择方式')).toHaveValue('fixed');
      const search = sheet.getByRole('searchbox');
      await search.fill('no-model-matches-this');
      await expect(list.getByRole('status')).toHaveText('没有匹配的模型。');
      await search.fill('');
      await list.getByRole('button', { name, exact: true }).scrollIntoViewIfNeeded();
      const metrics = await sheet.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const panel = element.closest('.agent-panel')!.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom, panelTop: panel.top, panelBottom: panel.bottom, width: element.clientWidth, scrollWidth: element.scrollWidth };
      });
      expect(metrics.top).toBeGreaterThanOrEqual(metrics.panelTop);
      expect(metrics.bottom).toBeLessThanOrEqual(metrics.panelBottom);
      expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.width + 1);
      await sheet.screenshot({ path: testInfo.outputPath(`workflow-${theme}-${kind}.png`) });
    }
    await sheet.getByRole('tab', { name: '图片', exact: true }).click();
    await expect(sheet.getByRole('button', { name: names[0], exact: true })).toHaveAttribute('aria-pressed', 'true');
    await sheet.getByRole('button', { name: '关闭生成偏好' }).click();
    await panel.getByRole('button', { name: '生成偏好', exact: true }).click();
    await expect(sheet.getByRole('button', { name: names[0], exact: true })).toHaveAttribute('aria-pressed', 'true');
  });
 }
}
