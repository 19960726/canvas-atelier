import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from './helpers/e2e-test';
import { openAgentPanel, openEmptyApp } from './helpers/app';

const output = path.join(process.cwd(), 'work', process.env.CANVAS_AGENT_INTRO_AUDIT_DIR ?? 'qa-agent-empty-intro-20260924-r1');

for (const theme of ['light', 'dark'] as const) {
  test(`centers the empty Agent conversation intro in ${theme}`, async ({ page }) => {
    await mkdir(output, { recursive: true });
    await page.setViewportSize({ width: 504, height: 720 });
    await page.addInitScript((mode) => localStorage.setItem('novus.theme.mode', mode), theme);
    await openEmptyApp(page);
    await openAgentPanel(page);
    const panel = page.getByTestId('agent-panel');
    await panel.getByLabel('Agent 模式').selectOption('chat');
    const metrics = await panel.evaluate((element) => {
      const rect = (selector: string) => element.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
      const target = rect('.skill-chat-workbench__composer');
      const orb = rect('.skill-chat-workbench__intro-orb');
      const title = element.querySelector<HTMLElement>('.skill-chat-workbench__intro--codex > strong')!;
      const range = document.createRange();
      range.selectNodeContents(title);
      const titleText = range.getBoundingClientRect();
      const parents = ['.floating-agent__content', '.skill-chat-workbench', '.skill-chat-workbench__stream', '.skill-chat-workbench__messages', '.skill-chat-workbench__empty-state', '.skill-chat-workbench__intro--codex']
        .map((selector) => {
          const node = element.querySelector<HTMLElement>(selector)!;
          const box = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          return { selector, left: box.left, right: box.right, width: box.width, display: style.display,
            grid: style.gridTemplateColumns, justify: style.justifyContent, align: style.alignContent, margin: style.marginInline, padding: style.paddingInline, transform: style.transform };
        });
      return {
        targetCenter: (target.left + target.right) / 2,
        orbCenter: (orb.left + orb.right) / 2,
        titleCenter: (titleText.left + titleText.right) / 2,
        panel: { left: target.left, right: target.right },
        parents,
      };
    });
    expect(Math.abs(metrics.orbCenter - metrics.targetCenter), JSON.stringify(metrics)).toBeLessThanOrEqual(2);
    expect(Math.abs(metrics.titleCenter - metrics.targetCenter), JSON.stringify(metrics)).toBeLessThanOrEqual(2);
    await page.screenshot({ path: path.join(output, `agent-empty-intro-${theme}.png`), fullPage: true });
    await writeFile(path.join(output, `agent-empty-intro-${theme}.json`), JSON.stringify({
      theme,
      viewport: { width: 504, height: 720 },
      measuredCenterPx: { composer: metrics.targetCenter, orb: metrics.orbCenter, title: metrics.titleCenter },
      centerOffsetPx: { orb: metrics.orbCenter - metrics.targetCenter, title: metrics.titleCenter - metrics.targetCenter },
      beforeFixOffsetPx: { orb: -55, title: -55.0078125 },
      cause: 'The 300px intro max-width remained left-anchored after a high-specificity margin reset.',
    }, null, 2));
  });
}
