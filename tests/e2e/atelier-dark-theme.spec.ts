import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from './helpers/e2e-test';
import { openAgentPanel, openEmptyApp } from './helpers/app';

const output = path.join(process.cwd(), 'work/qa-atelier-dark-20260925');

test('dark workspace shares the settings graphite palette across canvas, nodes, Agent and drawers', async ({ page }) => {
  test.setTimeout(60_000);
  mkdirSync(output, { recursive: true });
  await page.setViewportSize({ width: 1680, height: 1050 });
  await page.addInitScript(() => localStorage.setItem('novus.theme.mode', 'dark'));
  await openEmptyApp(page);
  await page.evaluate(async () => {
    await window.__NOVUS_E2E__!.createModule('image_generation', { x: 60, y: 80 });
    await window.__NOVUS_E2E__!.createModule('reverse_agent', { x: 650, y: 80 });
    await window.__NOVUS_E2E__!.createModule('image_layering', { x: 1160, y: 80 });
  });
  await page.locator('.react-flow__controls-fitview').evaluate(button => (button as HTMLButtonElement).click());
  const colors: Record<string, unknown> = {};
  const capture = async (name: string) => {
    colors[name] = await page.evaluate(() => {
      const selectors = ['.workspace--canvas-layout', '.topbar', '.toolrail--floating', '.module-node', '.module-node__result-stage', '.module-node__agent-task', '.agent-panel', '.skill-chat-workbench', '.skill-chat-workbench__composer', '.history-drawer', '.settings-drawer'];
      return selectors.flatMap((selector) => [...document.querySelectorAll(selector)].filter(element => element.getBoundingClientRect().width > 0).map(element => ({ selector, type: element.getAttribute('data-module-type'), background: getComputedStyle(element).backgroundColor, color: getComputedStyle(element).color, border: getComputedStyle(element).borderColor })));
    });
    await page.screenshot({ path: path.join(output, `${name}.png`) });
  };
  await capture('01-canvas');
  await expect(page.getByRole('button', { name: '保存项目', exact: true })).toHaveCSS('background-color', 'rgb(142, 213, 190)');
  await expect(page.locator('.module-node__knowledge-trigger')).toHaveCSS('background-color', 'rgb(39, 45, 42)');
  await openAgentPanel(page);
  await capture('02-agent');
  await expect(page.locator('.skill-chat-workbench').first()).toHaveCSS('background-color', 'rgb(32, 37, 35)');
  await page.getByTestId('settings-toggle').click();
  await capture('03-settings');
  await expect(page.getByTestId('settings-drawer')).toHaveCSS('background-color', 'rgb(32, 37, 35)');
  await page.getByTestId('settings-drawer-close').click();
  await page.getByTestId('history-toggle').click();
  await capture('04-history');
  const historyCoversRail = await page.locator('.toolrail--floating').evaluate(rail => {
    const bounds = rail.getBoundingClientRect();
    const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + 40);
    const ancestors = (element: Element | null) => {
      const values = [];
      while (element) { const style = getComputedStyle(element); values.push({ class: element.className, z: style.zIndex, transform: style.transform, position: style.position }); element = element.parentElement; }
      return values;
    };
    return { covers: Boolean(hit?.closest('.history-drawer')), hit: ancestors(hit), history: ancestors(document.querySelector('.history-drawer')) };
  });
  expect(historyCoversRail.covers, JSON.stringify(historyCoversRail)).toBe(true);
  writeFileSync(path.join(output, 'colors.json'), JSON.stringify(colors, null, 2));

  const workspace = page.getByTestId('workspace');
  await expect(workspace).toHaveCSS('background-color', 'rgb(25, 30, 28)');
  await expect(page.locator('.module-node[data-module-type="reverse_agent"]')).toHaveCSS('background-color', 'rgb(32, 37, 35)');
  await expect(page.locator('.module-node[data-module-type="image_layering"]')).toHaveCSS('background-color', 'rgb(32, 37, 35)');
  const contrast = await workspace.evaluate(element => {
    const style = getComputedStyle(element);
    const luminance = (hex: string) => {
      const rgb = hex.trim().replace('#', '').match(/../g)!.map(part => parseInt(part, 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
      return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
    };
    const ratio = (foreground: string, background: string) => {
      const a = luminance(style.getPropertyValue(foreground));
      const b = luminance(style.getPropertyValue(background));
      return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
    };
    return { body: ratio('--text', '--surface'), muted: ratio('--muted', '--surface-muted'), action: ratio('--on-accent', '--accent') };
  });
  for (const ratio of Object.values(contrast)) expect(ratio).toBeGreaterThanOrEqual(4.5);
  writeFileSync(path.join(output, 'contrast.json'), JSON.stringify(contrast, null, 2));
});
