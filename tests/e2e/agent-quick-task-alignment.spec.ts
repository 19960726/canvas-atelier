import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from './helpers/e2e-test';
import { openAgentPanel, openEmptyApp } from './helpers/app';

const output = path.join(process.cwd(), 'work', process.env.CANVAS_AGENT_ALIGNMENT_AUDIT_DIR ?? 'qa-agent-quicktask-alignment-20260924-r1');

for (const theme of ['light', 'dark'] as const) {
  test(`keeps Agent quick-task titles aligned after their icons in ${theme}`, async ({ page }) => {
    await mkdir(output, { recursive: true });
    await page.setViewportSize({ width: 1024, height: 900 });
    await page.addInitScript((mode) => localStorage.setItem('novus.theme.mode', mode), theme);
    await openEmptyApp(page);
    await openAgentPanel(page);
    const panel = page.getByTestId('agent-panel');
    await panel.getByLabel('Agent 模式').selectOption('chat');
    const tasks = panel.locator('.skill-chat-workbench__suggestions > button:not([data-testid="agent-more-suggestions"])');
    const rows = await tasks.evaluateAll((buttons) => buttons.slice(0, 4).map((button) => {
      const icon = button.querySelector<HTMLElement>('.skill-chat-workbench__suggestion-icon')!;
      const title = button.querySelector<HTMLElement>('strong')!;
      const buttonRect = button.getBoundingClientRect();
      const iconRect = icon.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(title);
      const textRect = range.getBoundingClientRect();
      const style = getComputedStyle(button);
      return {
        row: { left: buttonRect.left, right: buttonRect.right, center: (buttonRect.left + buttonRect.right) / 2 },
        icon: { left: iconRect.left, right: iconRect.right },
        title: { textLeft: textRect.left, textRight: textRect.right },
        textAlign: style.textAlign,
      };
    }));
    for (const row of rows) {
      expect(row.textAlign).toBe('left');
      expect(row.title.textLeft - row.icon.right).toBeGreaterThanOrEqual(8);
      expect(row.title.textLeft - row.icon.right).toBeLessThanOrEqual(18);
      expect(row.title.textRight).toBeLessThan(row.row.center - 36);
    }
    await page.screenshot({ path: path.join(output, `agent-quick-tasks-${theme}.png`), fullPage: true });
    await writeFile(path.join(output, `agent-quick-tasks-${theme}.json`), JSON.stringify({ theme, viewport: { width: 1024, height: 900 }, rows }, null, 2));
  });
}
