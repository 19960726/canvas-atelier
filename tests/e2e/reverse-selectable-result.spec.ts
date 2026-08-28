import { expect, test } from './helpers/e2e-test';
import { openEmptyApp } from './helpers/app';

for (const theme of ['light', 'dark'] as const) {
  test(`reverse result exposes selectable image and Seedance prompts in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1680, height: 1050 });
    await page.addInitScript((nextTheme) => localStorage.setItem('novus.theme.mode', nextTheme), theme);
    await openEmptyApp(page);
    await page.evaluate(async () => {
      await window.__NOVUS_E2E__!.createModule('reverse_agent', { x: 480, y: 80 });
      await window.__NOVUS_E2E__!.configureModule('reverse_agent', {
        config: {
          modelRoute: 'comfly-gpt-5-6-sol',
          role: 'Commercial visual analyst',
          task: 'Analyze @图片1.',
          knowledgeBaseIds: [],
          reverseAgentRunState: 'completed',
          reverseAgentResult: {
            sessionId: 'session-1', nonce: 'nonce-1', knowledgeSnapshotVersion: 'knowledge-1',
            analysis: '完整商业视觉分析', keywords: ['产品', '暖光'], positivePrompt: '基础生图提示词',
            negativeConstraints: ['不要改变产品结构'], executionChecklist: ['检查 Logo'],
            promptLogic: {
              subject: '唯一产品', action: '静止展示', environment: '暖色居家场景', cameraAndComposition: '45 度俯拍',
              lightingAndColor: '午后侧逆光', materialsAndTextures: '针织与玻璃', effectsOrFluids: '轻微热气',
              styleAndQuality: '高级电商摄影', rationale: ['主体到摄影参数'],
            },
            positivePromptZh: '可直接复制的中文生图提示词',
            seedance25: {
              taskType: 'video_edit', rationale: '存在唯一编辑母版。',
              assetBindings: [{ sourceId: '@视频1', target: '唯一编辑母版', adopt: ['运镜'], reject: ['原商品'] }],
              subjectContinuity: ['产品结构不变'],
              stages: [{ label: '阶段一', startState: '静止', mainEvent: '扫光', endState: '扫光离场', carryForward: ['机位连续'] }],
              shots: [{ label: '镜头一', shotSize: '中近景', camera: '固定', movement: '推进', action: '静止', lightingAndEffects: '扫光', transition: '无', audio: '环境声' }],
              audioPlan: ['保留环境声'], parameterLocks: ['保持比例'], promptZh: '编辑@视频1并保持商品不变。', promptEn: 'Edit @video1.',
              negativeConstraints: ['不要新增商品'], capabilityBoundaries: ['不承诺逐帧重合'],
            },
          },
        },
      });
    });

    const reverse = page.locator('[data-module-type="reverse_agent"]');
    const article = reverse.getByRole('article', { name: 'Selectable reverse result' });
    await expect(article).toBeVisible();
    await expect(article.getByRole('region', { name: '中文生图提示词' })).toContainText('可直接复制的中文生图提示词');
    await expect(article.getByRole('region', { name: 'Seedance 中文提示词' })).toContainText('编辑@视频1');
    await expect(article.locator('pre').first()).toHaveCSS('user-select', 'text');
  });
}
