import { test, expect } from './helpers/e2e-test';
import { openAgentPanel, openEmptyApp, queueProjectImageImport } from './helpers/app';
import { makeReferenceImage } from './helpers/fixtures';

test('creative analysis controls retain their geometry beside a long model catalog', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    localStorage.setItem('novus.theme.mode', 'dark');
    localStorage.setItem('novus.agent-window.v1', JSON.stringify({ x: 150, y: 40, width: 380, height: 600 }));
    let bridge: typeof window.novusDesktop;
    Object.defineProperty(window, 'novusDesktop', { configurable: true, get: () => bridge, set: value => {
      const profiles = Array.from({ length: 30 }, (_, i) => ({
        provider: 'comfly' as const, modelRoute: `qa-vision-${i}`, modelId: `gemini-qa-vision-${i}`, displayName: `Vision model ${i}`,
        capabilities: ['chat', 'vision'] as const, reasoning: { efforts: ['low', 'medium', 'high'] as const, defaultEffort: 'medium' as const, protocol: 'system_instruction' as const },
      }));
      bridge = { ...value, provider: { ...value.provider,
        getActiveProvider: async () => ({ activeProvider: 'comfly' as const }),
        getStatus: async () => ({ configured: true, locked: false, encryption: 'safeStorage' as const }),
        listProfiles: async request => request?.provider === 'comfly' ? profiles : [],
        listAvailableModelIds: async request => request?.provider === 'comfly' ? profiles.map(p => p.modelId) : [],
      } };
    } });
  });
  await openEmptyApp(page);
  await page.evaluate(() => window.__NOVUS_E2E__!.createModule('image_input', { x: 100, y: 100 }));
  await queueProjectImageImport(page, makeReferenceImage('Depth reference.png', [36, 112, 144, 255]));
  await page.locator('[data-module-type="image_input"]').getByRole('button', { name: /Import image/ }).click();
  await openAgentPanel(page);
  const panel = page.getByTestId('agent-panel');
  await panel.getByLabel('Agent 模式').selectOption('original');
  await panel.getByTestId('agent-composer-input').fill('@');
  await panel.getByRole('menuitem', { name: 'Mention Depth reference' }).click();
  await panel.getByTestId('agent-model-trigger').click();
  const popup = panel.getByRole('dialog', { name: '模型与分析深度设置' });
  await expect(popup.getByRole('dialog', { name: '选择聊天模型' })).toBeVisible();
  const metrics = await popup.evaluate(element => {
    const track = element.querySelector('.codex-reasoning__track')!.getBoundingClientRect();
    const input = element.querySelector('input[type="range"]')!.getBoundingClientRect();
    const buttons = [...element.querySelectorAll('.codex-reasoning__reverse-depth button')].map(b => b.getBoundingClientRect().height);
    return { trackHeight: track.height, centerDelta: (input.y + input.height / 2) - (track.y + track.height / 2), buttonHeights: buttons };
  });
  await popup.screenshot({ path: testInfo.outputPath('depth-long-catalog.png') });
  expect(metrics.trackHeight, 'model list must not collapse the reasoning track').toBeGreaterThanOrEqual(16);
  expect(Math.abs(metrics.centerDelta)).toBeLessThanOrEqual(1);
  expect(metrics.buttonHeights.every(height => height >= 32)).toBe(true);
});
