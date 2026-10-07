import { expect, test } from './helpers/e2e-test';
import { e2eState, openAgentPanel, openApp, queueProjectImageImport } from './helpers/app';
import { makeReferenceImage } from './helpers/fixtures';

for (const theme of ['light', 'dark'] as const) {
  test(`recovers the exact historical video request and reference without dispatching in ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: theme === 'light' ? 1100 : 380, height: 960 });
    await page.addInitScript(theme => {
      const layoutErrors: string[] = [];
      (window as unknown as { agentLayoutErrors: string[] }).agentLayoutErrors = layoutErrors;
      window.addEventListener('error', event => {
        if (event.message.includes('ResizeObserver')) layoutErrors.push(event.message);
      });
      localStorage.setItem('novus.theme.mode', theme);
      localStorage.setItem('agent-canvas:skill-chat:v2:local-project', JSON.stringify({ version: 2, activeConversationId: 'recovery', conversations: [{
        id: 'recovery', title: '产品视频', mode: 'original', modelRoute: 'chat-default',
        reasoningEfforts: { chat: 'medium', original: 'medium', codex: 'medium' }, reverseAnalysisDepth: 'standard',
        knowledgeBaseIds: [], projectMemoryIds: [], createdAt: 1, updatedAt: 2,
        messages: [
          { id: 'original', role: 'user', mode: 'original', content: '@图片8 制作四角度视频，产品原位置和比例不变', request: { modelDisplayName: 'Chat', modelRoute: 'chat-default', knowledgeBaseCount: 0, projectMemoryCount: 0, references: [{ assetId: '0000000000000001', label: '产品原图', mention: '@图片8' }], status: 'completed', generationKind: 'video' } },
          { id: 'empty', role: 'assistant', mode: 'original', content: JSON.stringify({ summary: '四角度视频分析', requirements: { goal: '产品视频', mustKeep: ['产品原位置和比例'], mustChange: ['只换机位'], mustAvoid: ['禁止红色'], acceptanceCriteria: ['四个角度，无变形'] }, referenceDuties: [{ mention: '@图片8', role: 'product', inherit: ['金属轮廓'], doNotCopy: ['背景人物'] }] }) },
          { id: 'later', role: 'user', mode: 'original', content: '另一个任务：红色汽车海报' },
          { id: 'reply', role: 'assistant', mode: 'original', content: '已记录另一个任务。' },
        ],
      }] }));
    }, theme);
    await openApp(page);
    expect(await page.evaluate(async () => {
      const modulePath = '/src/app/app-store.ts';
      const { useAppStore } = await import(modulePath);
      return useAppStore.getState().project.id;
    })).toBe('local-project');
    const importReference = page.getByTestId('rf__node-canvas-image-input').getByRole('button', { name: /Import image/u });
    await expect(importReference).toBeVisible();
    await queueProjectImageImport(page, makeReferenceImage('产品原图.png', [34, 128, 104, 255]));
    await importReference.click();
    expect((await e2eState(page)).projectAssetIds).toEqual(['0000000000000001']);
    await openAgentPanel(page);
    const panel = page.getByTestId('agent-panel');
    await panel.getByRole('button', { name: '补全可执行方案' }).click();
    const draft = await panel.getByTestId('agent-composer-input').evaluate(element => (element as HTMLDivElement & { value: string }).value);
    for (const item of ['@图片8 制作四角度视频', '产品原位置和比例', '只换机位', '禁止红色', '四个角度，无变形', '金属轮廓', '背景人物']) expect(draft).toContain(item);
    expect(draft).not.toContain('红色汽车海报');
    const selectedReferences = panel.getByLabel('Selected image references');
    await expect(selectedReferences).toContainText('产品原图');
    await expect(selectedReferences).toContainText('@图片8');
    await expect(selectedReferences.locator('button')).toHaveCount(1);
    const sourceImages = (await e2eState(page)).projectImages.filter(image => image.assetId === '0000000000000001');
    expect(sourceImages).toHaveLength(1);
    const sourceImage = sourceImages[0]!;
    await expect(selectedReferences.locator('img')).toHaveAttribute('src', sourceImage.displayUrl);
    const expectedMentions = draft.match(/@(?:图片|视频)[1-9]\d{0,8}/gu) ?? [];
    expect([...new Set(expectedMentions)]).toEqual(['@图片8']);
    const mentionBindings = await panel.getByTestId('agent-composer-input').locator('[data-token]').evaluateAll(elements => elements.map(element => ({
      token: (element as HTMLElement).dataset.token,
      imageUrl: element.querySelector('img')?.getAttribute('src'),
      label: element.getAttribute('aria-label'),
    })));
    expect(mentionBindings).toEqual(expectedMentions.map(token => ({
      token,
      imageUrl: sourceImage.displayUrl,
      label: `图片8，${sourceImage.label}，图片引用。按退格键或删除键移除`,
    })));
    await panel.getByRole('button', { name: '配置生成模型' }).click();
    const preferences = panel.getByRole('dialog', { name: '生成偏好' });
    await expect(preferences.getByRole('tab', { name: '视频', exact: true })).toHaveAttribute('aria-selected', 'true');
    await preferences.getByRole('button', { name: '关闭生成偏好' }).click();
    await panel.screenshot({ path: testInfo.outputPath(`exact-recovery-${theme}.png`) });
    expect((await e2eState(page)).modelSubmissions).toHaveLength(0);
    await expect(panel.getByRole('button', { name: '确认执行生图' })).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { agentLayoutErrors: string[] }).agentLayoutErrors)).toEqual([]);
  });
}
