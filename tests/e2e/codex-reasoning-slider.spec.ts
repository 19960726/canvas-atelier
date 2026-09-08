import { test, expect } from './helpers/e2e-test';
import { openAgentPanel, openEmptyApp } from './helpers/app';

for (const [theme, width] of [['light', 1440], ['dark', 1440], ['light', 800]] as const) {
  test(`Codex reasoning slider supports five stops in ${theme} at ${width}`, async ({ page }, testInfo) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.setViewportSize({ width, height: 900 });
    // Exercise the real renderer with an isolated catalog; no upstream calls.
    await page.addInitScript((nextTheme) => {
      localStorage.setItem('novus.theme.mode', nextTheme);
      let bridge: unknown;
      Object.defineProperty(window, 'novusDesktop', {
        configurable: true,
        get: () => bridge,
        set: (value) => {
          bridge = { ...value, codexCli: {
            listProfiles: async () => [{ provider: 'codex', modelRoute: 'codex/gpt-5.6-sol', modelId: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', capabilities: ['responses'], capabilityStatus: 'complete', availability: 'installed', transport: 'codex-cli', supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'ultra'], defaultReasoningEffort: 'medium' }],
          } };
        },
      });
    }, theme);
    await openEmptyApp(page);
    await openAgentPanel(page);
    const headerStatus = (await page.locator('.skill-chat-workbench__header p').boundingBox())!;
    const taskSelect = (await page.getByRole('combobox', { name: 'Codex 任务' }).boundingBox())!;
    expect(headerStatus.y + headerStatus.height, 'status must not overlap the task picker').toBeLessThanOrEqual(taskSelect.y);
    const composerBox = (await page.locator('.skill-chat-workbench__composer').boundingBox())!;
    const sendBox = (await page.getByRole('button', { name: '发送' }).boundingBox())!;
    expect(sendBox.x + sendBox.width, 'send button needs inset from the rounded border').toBeLessThanOrEqual(composerBox.x + composerBox.width - 8);
    expect(sendBox.y + sendBox.height, 'toolbar needs bottom padding').toBeLessThanOrEqual(composerBox.y + composerBox.height - 8);
    await page.getByRole('button', { name: '思考能力：中' }).click();
    const popup = page.getByRole('dialog', { name: '思考能力设置' });
    const slider = popup.getByRole('slider', { name: '思考能力' });
    await expect(slider).toBeFocused();
    const sliderBox = (await slider.boundingBox())!;
    for (const [index, label] of ['轻度', '中', '高', '极高', 'Ultra'].entries()) {
      await page.mouse.click(sliderBox.x + 20 + (sliderBox.width - 40) * index / 4, sliderBox.y + sliderBox.height / 2);
      await expect(slider).toHaveAttribute('aria-valuetext', label);
      await expect(slider).toHaveValue(String(index));
      if (width === 1440 && theme === 'light') {
        await popup.screenshot({ path: testInfo.outputPath(`reasoning-${index}.png`) });
      }
    }
    await slider.press('Home');
    await expect(slider).toHaveAttribute('aria-valuetext', '轻度');
    await slider.press('ArrowRight');
    await expect(slider).toHaveAttribute('aria-valuetext', '中');
    await slider.press('End');
    await expect(slider).toHaveAttribute('aria-valuetext', 'Ultra');
    await popup.getByRole('button', { name: '恢复默认思考能力' }).click();
    await expect(slider).toHaveAttribute('aria-valuetext', '中');
    await slider.focus();
    await slider.press('End');
    const panel = page.getByTestId('agent-panel');
    const selectedComposerBox = (await page.locator('.skill-chat-workbench__composer').boundingBox())!;
    const selectedSendBox = (await page.getByRole('button', { name: '发送' }).boundingBox())!;
    expect(selectedSendBox.y + selectedSendBox.height, 'Ultra label must not wrap actions outside the composer').toBeLessThanOrEqual(selectedComposerBox.y + selectedComposerBox.height - 8);
    const panelBox = (await panel.boundingBox())!;
    const popupBox = (await popup.boundingBox())!;
    expect(popupBox.x).toBeGreaterThanOrEqual(panelBox.x);
    expect(popupBox.x + popupBox.width).toBeLessThanOrEqual(panelBox.x + panelBox.width);
    expect(popupBox.y).toBeGreaterThanOrEqual(panelBox.y);
    // A screenshot alone does not prove hit targets are above the conversation.
    expect(await slider.evaluate((input) => {
      const rect = input.getBoundingClientRect();
      return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === input;
    })).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('agent-ultra.png') });
    await slider.press('Escape');
    await expect(popup).toHaveCount(0);
    await expect(page.getByRole('button', { name: '思考能力：Ultra' })).toBeFocused();
    await page.getByRole('button', { name: '思考能力：Ultra' }).click();
    await popup.getByRole('button', { name: '切换思考模型' }).click();
    await expect(popup).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: '选择聊天模型' })).toBeVisible();
    expect(pageErrors).toEqual([]);
  });
}
