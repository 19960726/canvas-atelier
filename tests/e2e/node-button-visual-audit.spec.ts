import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from './helpers/e2e-test';
import { openAgentPanel, openEmptyApp } from './helpers/app';
import { makeReferenceImage } from './helpers/fixtures';

const auditDirectory = path.join(process.cwd(), 'artifacts', '2026-08-26-final-node-audit');

test('captures every current node family and verifies visible controls stay inside their cards', async ({ page }) => {
  mkdirSync(auditDirectory, { recursive: true });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.addInitScript(() => localStorage.setItem('novus.theme.mode', 'light'));

  const captureGroup = async (
    name: string,
    modules: ReadonlyArray<{ type: 'image_input' | 'upload_image' | 'video_input' | 'canvas_library' | 'text_prompt' | 'image_generation' | 'video_generation' | 'reverse_agent' | 'video_result' | 'reverse_result'; x: number; y: number }>,
  ) => {
    await openEmptyApp(page);
    await page.evaluate(async (entries) => {
      for (const entry of entries) {
        await window.__NOVUS_E2E__!.createModule(entry.type, { x: entry.x, y: entry.y });
      }
    }, modules);
    await page.locator('.react-flow__controls-fitview').evaluate((button) => (button as HTMLButtonElement).click());
    await expect(page.locator('.react-flow__node')).toHaveCount(modules.length);

    const violations = await page.locator('.react-flow__node').evaluateAll((nodes) => nodes.flatMap((node) => {
      const card = node.querySelector<HTMLElement>('[data-module-type]');
      if (card === null) return ['unknown:missing-module-card'];
      const nodeRect = card.getBoundingClientRect();
      const buttons = Array.from(card.querySelectorAll<HTMLElement>('button')).filter((button) => {
        const style = getComputedStyle(button);
        return style.display !== 'none' && style.visibility !== 'hidden' && button.getBoundingClientRect().width > 0;
      });
      const outsideButtons = buttons.filter((button) => {
        const rect = button.getBoundingClientRect();
        return rect.left < nodeRect.left - 1 || rect.right > nodeRect.right + 1 || rect.top < nodeRect.top - 1 || rect.bottom > nodeRect.bottom + 1;
      }).map((button) => `button-outside:${button.getAttribute('aria-label') ?? button.textContent?.trim() ?? 'unnamed'}`);
      return outsideButtons.map((violation) => `${card.getAttribute('data-module-type')}:${violation}`);
    }));
    expect(violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: path.join(auditDirectory, `${name}.png`), fullPage: true });
  };

  await captureGroup('01-input-nodes', [
    { type: 'image_input', x: 0, y: 0 },
    { type: 'upload_image', x: 520, y: 0 },
    { type: 'video_input', x: 1040, y: 0 },
    { type: 'canvas_library', x: 260, y: 520 },
    { type: 'text_prompt', x: 780, y: 520 },
  ]);
  await captureGroup('02-generation-and-reverse-nodes', [
    { type: 'image_generation', x: 0, y: 0 },
    { type: 'video_generation', x: 520, y: 0 },
    { type: 'reverse_agent', x: 1040, y: 0 },
  ]);
  await captureGroup('03-output-nodes', [
    { type: 'video_result', x: 260, y: 0 },
    { type: 'reverse_result', x: 780, y: 0 },
  ]);

  await openEmptyApp(page);
  await openAgentPanel(page);
  const panel = page.getByTestId('agent-panel');
  await panel.getByRole('tab', { name: '对话' }).click();
  await panel.getByTestId('agent-model-trigger').click();
  await panel.getByRole('button', { name: '使用 gpt-5.6-sol' }).first().click();
  const pastedImage = makeReferenceImage('agent-paste-proof.png', [24, 142, 122, 255], { width: 160, height: 120 });
  await panel.getByTestId('agent-composer-input').evaluate((element, bytes) => {
    const clipboardData = new DataTransfer();
    clipboardData.items.add(new File([new Uint8Array(bytes)], 'agent-paste-proof.png', { type: 'image/png' }));
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
  }, Array.from(pastedImage.buffer));
  await expect(panel.getByTestId('agent-composer-input')).toContainText('图片1');
  await expect(panel.getByLabel('Selected image references')).toBeVisible();
  await page.screenshot({ path: path.join(auditDirectory, '04-agent-image-paste.png'), fullPage: true });

  await panel.getByRole('button', { name: '关闭 Codex Agent' }).click();
  await page.getByTestId('settings-toggle').click();
  const settings = page.getByTestId('settings-drawer');
  await settings.getByRole('tab', { name: '存储与备份' }).click();
  await expect(settings.getByRole('button', { name: '刷新' })).toBeVisible();
  await page.screenshot({ path: path.join(auditDirectory, '05-settings-buttons.png'), fullPage: true });
});
