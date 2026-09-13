import { expect, test } from './helpers/e2e-test';
import { openAgentPanel, openApp } from './helpers/app';

const conversationKey = 'agent-canvas:skill-chat:v2:local-project';

test('keeps every creative Agent message surface readable in dark theme', async ({ page }) => {
  await page.addInitScript(({ key, content }) => {
    localStorage.setItem('novus.theme.mode', 'dark');
    localStorage.setItem(key, JSON.stringify({
      version: 2,
      activeConversationId: 'conversation-dark-theme',
      conversations: [{
        id: 'conversation-dark-theme',
        title: '深色方案验收',
        mode: 'original',
        reasoningEfforts: { chat: 'medium', original: 'medium', codex: 'medium' },
        reverseAnalysisDepth: 'deep',
        knowledgeBaseIds: [],
        projectMemoryIds: [],
        messages: [
          {
            id: 'message-user-dark-theme',
            role: 'user',
            mode: 'original',
            content: '保留产品和人物，只调整构图与光线。',
          },
          {
            id: 'message-assistant-dark-theme',
            role: 'assistant',
            mode: 'original',
            content,
          },
        ],
        createdAt: 1,
        updatedAt: 2,
      }],
    }));
  }, {
    key: conversationKey,
    content: JSON.stringify({
      summary: '保留产品外观和人物关系，使用自然窗光优化画面层次。',
      requirements: {
        goal: '生成清晰自然的产品场景图',
        mustKeep: ['产品结构', '人物关系'],
        mustChange: ['构图层次', '窗光方向'],
        mustAvoid: ['虚假投影', '人物变形'],
        acceptanceCriteria: ['产品轮廓清晰', '前中后景关系自然'],
      },
      observations: ['产品位于画面中心，人物分列两侧。'],
      estimates: ['柔和侧光能保留外壳细节。'],
      unknowns: ['产品实际尺寸未知。'],
      options: [{
        id: 'window-light',
        title: '自然窗光方案',
        reason: '强化产品轮廓并保留真实环境。',
        kind: 'image',
        prompt: '保持产品结构和人物关系，以自然窗光塑造清晰层次，前中后景关系自然。',
        modelRoute: 'comfly-gemini-3-1-flash-image-preview',
        workflow: [
          { title: '整理约束', detail: '锁定产品、人物和禁止修改项。' },
          { title: '执行生图', detail: '使用自然窗光方案生成候选图。' },
          { title: '检查结果', detail: '核对轮廓、人物和景深关系。' },
        ],
      }],
    }),
  });

  await openApp(page);
  await openAgentPanel(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  const panel = page.getByTestId('agent-panel');
  const creativeMessage = panel.locator('.skill-chat-workbench__message--creative-plan');
  await expect(creativeMessage).toBeVisible();
  await expect(creativeMessage.getByText('自然窗光方案', { exact: true })).toBeVisible();

  const evidence = await panel.evaluate((element) => {
    type Rgba = readonly [number, number, number, number];
    const parseColor = (value: string): Rgba => {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (context === null) throw new Error('Canvas color parser is unavailable');
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
      return [red, green, blue, alpha / 255] as const;
    };
    const composite = (foreground: Rgba, background: Rgba): Rgba => {
      const alpha = foreground[3] + background[3] * (1 - foreground[3]);
      if (alpha === 0) return [0, 0, 0, 0] as const;
      return [
        Math.round((foreground[0] * foreground[3] + background[0] * background[3] * (1 - foreground[3])) / alpha),
        Math.round((foreground[1] * foreground[3] + background[1] * background[3] * (1 - foreground[3])) / alpha),
        Math.round((foreground[2] * foreground[3] + background[2] * background[3] * (1 - foreground[3])) / alpha),
        alpha,
      ] as const;
    };
    const effectiveBackground = (target: Element): Rgba => {
      const layers: Rgba[] = [];
      for (let current: Element | null = target; current !== null; current = current.parentElement) {
        layers.push(parseColor(getComputedStyle(current).backgroundColor));
      }
      return layers.reverse().reduce<Rgba>((background, foreground) => composite(foreground, background), [255, 255, 255, 1]);
    };
    const channel = (value: number) => {
      const normalized = value / 255;
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (color: Rgba) => 0.2126 * channel(color[0]) + 0.7152 * channel(color[1]) + 0.0722 * channel(color[2]);
    const contrast = (foreground: Rgba, background: Rgba) => {
      const lighter = Math.max(luminance(foreground), luminance(background));
      const darker = Math.min(luminance(foreground), luminance(background));
      return (lighter + 0.05) / (darker + 0.05);
    };
    const requireElement = (selector: string) => {
      const target = element.querySelector(selector);
      if (target === null) throw new Error(`Missing dark-theme probe: ${selector}`);
      return target;
    };
    const readText = (selector: string) => {
      const target = requireElement(selector);
      const style = getComputedStyle(target);
      const foreground = parseColor(style.color);
      const background = effectiveBackground(target);
      return {
        selector,
        color: style.color,
        background,
        contrast: contrast(foreground, background),
      };
    };
    const readSurface = (selector: string) => {
      const target = requireElement(selector);
      const style = getComputedStyle(target);
      return {
        selector,
        background: parseColor(style.backgroundColor),
        color: style.color,
      };
    };

    return {
      surfaces: [
        readSurface('.skill-chat-workbench__message--user'),
        readSurface('.skill-chat-workbench__message--creative-plan'),
        readSurface('.creative-plan__requirements'),
        readSurface('.creative-plan__option'),
        readSurface('.creative-plan__workflow'),
        readSurface('.creative-plan__select'),
      ],
      text: [
        readText('.skill-chat-workbench__message--user > p'),
        readText('.skill-chat-workbench__message--creative-plan > span'),
        readText('.skill-chat-workbench__message--creative-plan > p'),
        readText('.creative-plan__requirements dt'),
        readText('.creative-plan__requirements dd'),
        readText('.creative-plan > div:not(.creative-plan__option) > strong'),
        readText('.creative-plan > div:not(.creative-plan__option) > p'),
        readText('.creative-plan__option > strong'),
        readText('.creative-plan__option > p'),
        readText('.creative-plan__workflow li p'),
        readText('.creative-plan__option details > summary'),
        readText('.creative-plan__select'),
      ],
    };
  });

  for (const surface of evidence.surfaces) {
    expect(surface.background[3], JSON.stringify(surface)).toBeGreaterThanOrEqual(0.99);
    expect(Math.max(...surface.background.slice(0, 3)), JSON.stringify(surface)).toBeLessThan(96);
  }
  for (const text of evidence.text) {
    expect(text.contrast, JSON.stringify(text)).toBeGreaterThanOrEqual(4.5);
  }
});
