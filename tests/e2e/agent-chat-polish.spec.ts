import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from './helpers/e2e-test';
import { openAgentPanel, openEmptyApp } from './helpers/app';

const evidenceDirectory = path.join(process.cwd(), 'work', process.env.CANVAS_AGENT_AUDIT_DIR ?? 'qa-agent-chat-polish-2026-09-24');

test('keeps the Agent roomy, textured, animated and functional in both themes without sending a request', async ({ page }) => {
  await mkdir(evidenceDirectory, { recursive: true });
  await page.setViewportSize({ width: 1365, height: 900 });
  await openEmptyApp(page);
  await openAgentPanel(page);

  const panel = page.getByTestId('agent-panel');
  await panel.getByLabel('Agent 模式').selectOption('chat');
  await expect(panel).toBeVisible();
  await expect(panel.getByLabel('Agent 模式')).toHaveValue('chat');
  const toolbarOrb = page.locator('.topbar-agent-entry__orb');
  const centerOrb = panel.locator('.skill-chat-workbench__intro-orb');
  await expect(toolbarOrb).toBeVisible();
  await expect(centerOrb).toBeVisible();

  const tasks = panel.locator('.skill-chat-workbench__suggestions > button:not([data-testid="agent-more-suggestions"])');
  const more = panel.getByTestId('agent-more-suggestions');
  await expect(tasks).toHaveCount(7);
  await expect(tasks.nth(0)).toBeVisible();
  await expect(tasks.nth(3)).toBeVisible();
  await expect(tasks.nth(4)).toBeHidden();
  await expect(more).toBeVisible();
  await expect(more).toHaveAttribute('aria-expanded', 'false');

  const roomyMetrics = await panel.evaluate((element) => {
    const rect = (selector: string) => {
      const box = element.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height, bottom: box.bottom };
    };
    const composer = element.querySelector<HTMLElement>('.skill-chat-workbench__composer')!;
    const parents = [] as Array<{ className: string; x: number; width: number; padding: string; maxWidth: string }>;
    for (let ancestor = composer.parentElement; ancestor && ancestor !== element; ancestor = ancestor.parentElement) {
      const box = ancestor.getBoundingClientRect();
      const style = getComputedStyle(ancestor);
      parents.push({ className: typeof ancestor.className === 'string' ? ancestor.className : ancestor.tagName, x: box.x, width: box.width, padding: style.paddingInline, maxWidth: style.maxWidth });
    }
    const suggestions = element.querySelector<HTMLElement>('.skill-chat-workbench__suggestions')!.getBoundingClientRect();
    return { panel: rect('.floating-agent__content'), composer: rect('.skill-chat-workbench__composer'), editor: rect('[data-testid="agent-composer-input"]'), parents, suggestions: { x: suggestions.x, width: suggestions.width } };
  });
  console.log(`AGENT_CHAT_ROOMY ${JSON.stringify(roomyMetrics)}`);
  expect(roomyMetrics.composer.x - roomyMetrics.panel.x).toBeLessThanOrEqual(8);
  expect(roomyMetrics.panel.x + roomyMetrics.panel.width - (roomyMetrics.composer.x + roomyMetrics.composer.width)).toBeLessThanOrEqual(8);
  expect(roomyMetrics.suggestions.width).toBeGreaterThan(roomyMetrics.panel.width * 0.85);
  await expect(panel.locator('.floating-agent__header:visible')).toHaveCount(0);
  await expect(panel.locator('.skill-chat-workbench__header--codex:visible')).toHaveCount(1);

  const orbMetrics = await Promise.all([toolbarOrb, centerOrb].map((orb) => orb.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { width: rect.width, height: rect.height, animation: getComputedStyle(element).animationName };
  })));
  expect(orbMetrics[0]?.animation).toContain('canvas-ai-orb-breathe');
  expect(orbMetrics[1]?.animation).toContain('canvas-ai-orb-breathe');
  for (const orb of [toolbarOrb, centerOrb]) {
    const movingGlint = await orb.locator('i').evaluate((element) => {
      const animation = element.getAnimations().find((candidate) => (candidate as CSSAnimation).animationName === 'canvas-ai-orb-glint');
      if (!animation) return null;
      animation.pause();
      animation.currentTime = 0;
      const start = getComputedStyle(element).transform;
      animation.currentTime = 1200;
      const middle = getComputedStyle(element).transform;
      return { start, middle };
    });
    expect(movingGlint?.start).not.toBe(movingGlint?.middle);
  }
  console.log(`AGENT_CHAT_ORBS ${JSON.stringify(orbMetrics)}`);

  await page.screenshot({ path: path.join(evidenceDirectory, 'agent-chat-light.png'), fullPage: true });
  await panel.screenshot({ path: path.join(evidenceDirectory, 'agent-chat-light-panel.png') });
  await panel.locator('.skill-chat-workbench__composer').screenshot({ path: path.join(evidenceDirectory, 'agent-chat-light-composer.png') });
  await panel.getByRole('button', { name: '停靠到侧边' }).click();
  await expect(panel).toHaveAttribute('data-presentation-mode', 'docked');
  await panel.screenshot({ path: path.join(evidenceDirectory, 'agent-chat-docked-light-panel.png') });
  await panel.getByRole('button', { name: '切换为浮窗' }).click();
  await expect(panel).toHaveAttribute('data-presentation-mode', 'floating');
  const rowLayout = await tasks.nth(0).evaluate((first, second) => {
    const a = first.getBoundingClientRect();
    const b = second.getBoundingClientRect();
    return { first: { x: a.x, y: a.y, width: a.width, height: a.height }, second: { x: b.x, y: b.y, width: b.width, height: b.height } };
  }, await tasks.nth(1).elementHandle());
  expect(rowLayout.second.x).toBe(rowLayout.first.x);
  expect(rowLayout.second.y).toBeGreaterThan(rowLayout.first.y);
  expect(rowLayout.second.width).toBe(rowLayout.first.width);

  await more.click();
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  await expect(tasks.nth(6)).toBeVisible();
  await panel.locator('.skill-chat-workbench__stream').evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(tasks.nth(6)).toBeInViewport();
  await panel.screenshot({ path: path.join(evidenceDirectory, 'agent-chat-expanded-suggestions-bottom.png') });
  await panel.screenshot({ path: path.join(evidenceDirectory, 'agent-chat-expanded-suggestions.png') });
  await more.click();
  await panel.getByRole('button', { name: '梳理创作目标' }).click();
  await expect(panel.getByTestId('agent-composer-input')).toContainText('请帮我梳理创作目标、约束条件和下一步方案。');
  await expect(panel.getByRole('button', { name: '发送' })).toBeEnabled();
  await panel.screenshot({ path: path.join(evidenceDirectory, 'agent-chat-draft-light.png') });

  await page.getByLabel('主题 Theme').selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await panel.screenshot({ path: path.join(evidenceDirectory, 'agent-chat-draft-dark.png') });

  await panel.evaluate((element) => {
    element.style.setProperty('--agent-height', '460px');
    element.style.setProperty('--agent-y', '16px');
  });
  await expect(panel.getByLabel('Agent 模式')).toBeVisible();
  await expect(panel.getByLabel('Agent 模式').locator('option')).toHaveCount(3);
  await panel.screenshot({ path: path.join(evidenceDirectory, 'agent-chat-narrow-dark.png') });

  const metrics = await panel.evaluate((element) => {
    const panelRect = element.getBoundingClientRect();
    const composer = element.querySelector<HTMLElement>('.skill-chat-workbench__composer')!;
    const footer = element.querySelector<HTMLElement>('.skill-chat-workbench__composer-footer')!;
    const editor = element.querySelector<HTMLElement>('[data-testid="agent-composer-input"]')!;
    const stream = element.querySelector<HTMLElement>('.skill-chat-workbench__stream')!;
    const rect = (target: HTMLElement) => {
      const box = target.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom };
    };
    return {
      panel: rect(element),
      composer: rect(composer),
      footer: rect(footer),
      footerStyle: {
        position: getComputedStyle(footer).position,
        left: getComputedStyle(footer).left,
        right: getComputedStyle(footer).right,
        marginLeft: getComputedStyle(footer).marginLeft,
        marginRight: getComputedStyle(footer).marginRight,
        alignSelf: getComputedStyle(footer).alignSelf,
        transform: getComputedStyle(footer).transform,
        boxSizing: getComputedStyle(footer).boxSizing,
      },
      editor: rect(editor),
      stream: rect(stream),
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      panelBottom: panelRect.bottom,
    };
  });
  const modelSubmissions = await page.evaluate(() => window.__NOVUS_E2E__!.getState().modelSubmissions.length);
  console.log(`AGENT_CHAT_METRICS ${JSON.stringify({ metrics, modelSubmissions })}`);
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
  expect(metrics.footer.x).toBeGreaterThanOrEqual(metrics.composer.x);
  expect(metrics.footer.right).toBeLessThanOrEqual(metrics.composer.right + 1);
  expect(modelSubmissions).toBe(0);
});
