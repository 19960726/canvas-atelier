import path from 'node:path';
import { expect, test } from './helpers/e2e-test';
import { openAgentPanel, openEmptyApp } from './helpers/app';

const artifact = path.join(process.cwd(), 'artifacts', 'CanvasAtelier-1.6.55-agent-layout', 'agent-layout.png');
const composerArtifact = path.join(process.cwd(), 'artifacts', 'CanvasAtelier-1.6.55-agent-layout', 'agent-composer-compact.png');

test('keeps every Codex Agent control inside the panel on one unified compact geometry', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openEmptyApp(page);
  await openAgentPanel(page);

  const panel = page.getByTestId('agent-panel');
  await expect(panel.getByRole('combobox', { name: 'Codex 任务' })).toBeVisible();
  await expect(panel.getByRole('button', { name: '新建任务' })).toBeVisible();
  await expect(panel.getByRole('button', { name: '关闭 Codex Agent' })).toBeVisible();

  const metrics = await panel.evaluate((element) => {
    const footer = element.querySelector('.skill-chat-workbench__composer-footer');
    const composer = element.querySelector('.skill-chat-workbench__composer');
    const visible = (control: HTMLElement) => getComputedStyle(control).display !== 'none';
    const controls = footer === null ? [] : [...footer.querySelectorAll<HTMLElement>('button, select')]
      .filter(visible)
      .map((control) => {
        const rect = control.getBoundingClientRect();
        return {
          className: control.className,
          height: rect.height,
          left: rect.left,
          right: rect.right,
        };
      });
    const panelRect = element.getBoundingClientRect();
    const composerRect = composer?.getBoundingClientRect();
    const footerRect = footer?.getBoundingClientRect();
    return {
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      panelWidth: panelRect.width,
      panelLeft: panelRect.left,
      panelRight: panelRect.right,
      panelTop: panelRect.top,
      panelBottom: panelRect.bottom,
      composerLeft: composerRect?.left ?? 0,
      composerRight: composerRect?.right ?? 0,
      composerHeight: composerRect?.height ?? 0,
      footerLeft: footerRect?.left ?? 0,
      footerRight: footerRect?.right ?? 0,
      controls,
    };
  });

  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
  expect(metrics.panelWidth).toBeGreaterThanOrEqual(399);
  expect(metrics.panelWidth).toBeLessThanOrEqual(461);
  expect(metrics.panelTop).toBeLessThanOrEqual(1);
  expect(metrics.panelRight).toBeGreaterThanOrEqual(1279);
  expect(metrics.panelBottom).toBeGreaterThanOrEqual(799);
  expect(metrics.composerHeight).toBeGreaterThanOrEqual(126);
  expect(metrics.composerHeight).toBeLessThanOrEqual(146);
  expect(metrics.footerLeft).toBeGreaterThanOrEqual(metrics.composerLeft);
  expect(metrics.footerRight, JSON.stringify(metrics)).toBeLessThanOrEqual(metrics.composerRight + 1);
  expect(metrics.controls.length).toBeGreaterThanOrEqual(8);
  for (const control of metrics.controls) {
    expect(control.height).toBeGreaterThanOrEqual(29);
    expect(control.height).toBeLessThanOrEqual(34);
    expect(control.left).toBeGreaterThanOrEqual(metrics.panelLeft);
    expect(control.right).toBeLessThanOrEqual(metrics.panelRight);
    expect(control.right).toBeLessThanOrEqual(metrics.composerRight + 1);
  }

  await page.screenshot({ path: artifact, fullPage: true });
  await panel.locator('.skill-chat-workbench__composer').screenshot({ path: composerArtifact });
});
