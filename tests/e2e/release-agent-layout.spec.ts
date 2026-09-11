import path from 'node:path';
import { expect, test } from './helpers/e2e-test';
import { openAgentPanel, openEmptyApp, queueProjectImageImport } from './helpers/app';
import { makeReferenceImage } from './helpers/fixtures';

const artifact = path.join(process.cwd(), 'artifacts', 'CanvasAtelier-1.6.55-agent-layout', 'agent-layout.png');
const composerArtifact = path.join(process.cwd(), 'artifacts', 'CanvasAtelier-1.6.55-agent-layout', 'agent-composer-compact.png');
const compactActionsArtifact = path.join(process.cwd(), 'artifacts', 'CanvasAtelier-1.6.133-agent-compact-actions', 'agent-compact-actions.png');

test('keeps the Agent header aligned and lets a referenced long-form composer grow without overflow', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openEmptyApp(page);
  await page.evaluate(async () => {
    await window.__NOVUS_E2E__!.createModule('image_input', { x: 100, y: 120 });
    await window.__NOVUS_E2E__!.createModule('image_input', { x: 340, y: 120 });
    await window.__NOVUS_E2E__!.createModule('image_input', { x: 580, y: 120 });
  });
  const imageNodes = page.locator('[data-module-type="image_input"]');
  for (const [index, name] of ['Layout product.png', 'Layout scene.png', 'Layout detail.png'].entries()) {
    await queueProjectImageImport(page, makeReferenceImage(name, [24 + index * 24, 120, 110, 255]));
    await imageNodes.nth(index).getByRole('button', { name: '导入图像 / Import image' }).click();
  }
  await openAgentPanel(page);

  const panel = page.getByTestId('agent-panel');
  await expect(panel.getByRole('combobox', { name: 'Codex 任务' })).toBeVisible();
  await expect(panel.getByRole('button', { name: '新建任务' })).toBeVisible();
  await expect(panel.getByRole('button', { name: '关闭 Codex Agent' })).toBeVisible();

  const initialMetrics = await panel.evaluate((element) => {
    const footer = element.querySelector('.skill-chat-workbench__composer-footer');
    const composer = element.querySelector('.skill-chat-workbench__composer');
    const taskSelect = element.querySelector<HTMLElement>('.skill-chat-workbench__header-actions select');
    const newTask = element.querySelector<HTMLElement>('.skill-chat-workbench__new-chat');
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
      composerCssHeight: composer instanceof HTMLElement ? getComputedStyle(composer).height : '',
      footerLeft: footerRect?.left ?? 0,
      footerRight: footerRect?.right ?? 0,
      taskSelect: taskSelect?.getBoundingClientRect().toJSON() ?? null,
      newTask: newTask?.getBoundingClientRect().toJSON() ?? null,
      controls,
    };
  });

  expect(initialMetrics.scrollWidth).toBeLessThanOrEqual(initialMetrics.clientWidth + 1);
  expect(initialMetrics.panelWidth).toBeGreaterThanOrEqual(520);
  expect(initialMetrics.panelWidth).toBeLessThanOrEqual(561);
  expect(initialMetrics.panelTop).toBeLessThanOrEqual(1);
  expect(initialMetrics.panelRight).toBeGreaterThanOrEqual(1279);
  expect(initialMetrics.panelBottom).toBeGreaterThanOrEqual(799);
  expect(initialMetrics.composerHeight).toBeGreaterThanOrEqual(216);
  expect(initialMetrics.composerCssHeight).not.toBe('184px');
  expect(initialMetrics.taskSelect).not.toBeNull();
  expect(initialMetrics.newTask).not.toBeNull();
  expect(initialMetrics.taskSelect!.height).toBe(42);
  expect(initialMetrics.newTask!.height).toBe(42);
  expect(initialMetrics.taskSelect!.width).toBeGreaterThan(42);
  expect(initialMetrics.newTask!.width).toBe(42);
  expect(Math.abs(initialMetrics.taskSelect!.y - initialMetrics.newTask!.y)).toBeLessThanOrEqual(0.5);
  expect(initialMetrics.footerLeft).toBeGreaterThanOrEqual(initialMetrics.composerLeft);
  expect(initialMetrics.footerRight, JSON.stringify(initialMetrics)).toBeLessThanOrEqual(initialMetrics.composerRight + 1);
  expect(initialMetrics.controls.length).toBeGreaterThanOrEqual(8);
  for (const control of initialMetrics.controls) {
    // Mode tabs use the compact 30px text row; action controls use 34px.
    expect(control.height).toBeGreaterThanOrEqual(30);
    expect(control.height).toBeLessThanOrEqual(42);
    expect(control.left).toBeGreaterThanOrEqual(initialMetrics.panelLeft);
    expect(control.right).toBeLessThanOrEqual(initialMetrics.panelRight);
    expect(control.right).toBeLessThanOrEqual(initialMetrics.composerRight + 1);
  }

  await panel.getByRole('tab', { name: '对话' }).click();
  await panel.getByTestId('agent-model-trigger').click();
  await panel.getByRole('button', { name: '使用 gpt-5.6-sol' }).first().click();
  const input = panel.getByTestId('agent-composer-input');
  await input.fill('请保持产品比例、材质和场景透视，并基于这些参考素材给出完整的构图、光线、镜头与动作说明。');
  for (const label of ['Layout product', 'Layout scene', 'Layout detail']) {
    await input.focus();
    await input.press('End');
    await input.pressSequentially(' @');
    await panel.getByRole('menuitem', { name: `Mention ${label}` }).click();
  }
  await input.focus();
  await input.press('End');
  await input.press('Shift+Enter');
  await input.pressSequentially('第二段需要保留足够的编辑空间，并确保引用胶囊始终位于文字流中，底部模式、模型、设置和发送按钮全部留在圆角边界内。');

  const expandedMetrics = await panel.evaluate((element) => {
    const composer = element.querySelector<HTMLElement>('.skill-chat-workbench__composer')!;
    const editor = element.querySelector<HTMLElement>('[data-testid="agent-composer-input"]')!;
    const rail = element.querySelector<HTMLElement>('.skill-chat-workbench__image-tags')!;
    const footer = element.querySelector<HTMLElement>('.skill-chat-workbench__composer-footer')!;
    const box = (target: HTMLElement) => target.getBoundingClientRect().toJSON();
    return {
      composer: box(composer),
      editor: box(editor),
      rail: box(rail),
      footer: box(footer),
      railItems: [...rail.querySelectorAll<HTMLElement>(':scope > button')].map(box),
      chips: [...editor.querySelectorAll<HTMLElement>('.media-mention-textarea__chip')].map((chip) => ({
        ...box(chip),
        display: getComputedStyle(chip).display,
      })),
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    };
  });
  expect(expandedMetrics.composer.height).toBeGreaterThan(initialMetrics.composerHeight + 32);
  expect(expandedMetrics.editor.height).toBeGreaterThanOrEqual(104);
  expect(expandedMetrics.editor.height).toBeLessThanOrEqual(168);
  expect(expandedMetrics.rail.height).toBeGreaterThanOrEqual(36);
  expect(expandedMetrics.rail.height).toBeLessThanOrEqual(44);
  expect(expandedMetrics.railItems).toHaveLength(3);
  expect(expandedMetrics.chips).toHaveLength(3);
  for (const item of expandedMetrics.railItems) {
    expect(item.width).toBeLessThan(220);
    expect(item.height).toBe(24);
  }
  for (const chip of expandedMetrics.chips) {
    expect(chip.display).toBe('inline-flex');
    expect(chip.height).toBe(24);
    expect(chip.width).toBeLessThan(expandedMetrics.editor.width);
  }
  expect(expandedMetrics.footer.y).toBeGreaterThanOrEqual(expandedMetrics.rail.y + expandedMetrics.rail.height);
  expect(expandedMetrics.footer.y + expandedMetrics.footer.height).toBeLessThanOrEqual(expandedMetrics.composer.y + expandedMetrics.composer.height + 1);
  expect(expandedMetrics.scrollWidth).toBeLessThanOrEqual(expandedMetrics.clientWidth + 1);

  await page.screenshot({ path: artifact, fullPage: true });
  await panel.locator('.skill-chat-workbench__composer').screenshot({ path: composerArtifact });
});

test('keeps reverse depth readable above reasoning, generation preferences, knowledge and send controls', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    let bridge: typeof window.novusDesktop | undefined;
    Object.defineProperty(window, 'novusDesktop', {
      configurable: true,
      get: () => bridge,
      set: (value: typeof window.novusDesktop) => {
        const reasoningProfile = {
          provider: 'comfly' as const,
          modelRoute: 'comfly-qa-reasoning-vision',
          modelId: 'qa-reasoning-vision',
          displayName: 'QA Reasoning Vision',
          capabilities: ['chat', 'vision', 'reverse_prompt'] as const,
          capabilityStatus: 'complete' as const,
          reasoning: { efforts: ['low', 'medium', 'high'] as const, defaultEffort: 'medium' as const, protocol: 'system_instruction' as const },
        };
        bridge = { ...value, provider: {
          ...value?.provider,
          getActiveProvider: async () => ({ activeProvider: 'comfly' as const }),
          getStatus: async () => ({ configured: true, locked: false, encryption: 'safeStorage' as const }),
          listProfiles: async (request) => request?.provider === 'comfly' ? [reasoningProfile] : [],
          listAvailableModelIds: async (request) => request?.provider === 'comfly' ? [reasoningProfile.modelId] : [],
        } } as typeof window.novusDesktop;
      },
    });
  });
  await openEmptyApp(page);
  await openAgentPanel(page);
  await page.getByRole('tab', { name: '创作 Agent' }).click();

  const panel = page.getByTestId('agent-panel');
  await expect(panel.getByTestId('agent-model-trigger')).toHaveAttribute('data-selected-model', 'QA Reasoning Vision');
  const controls = await panel.evaluate((element) => {
    const rect = (selector: string) => element.querySelector<HTMLElement>(selector)!.getBoundingClientRect().toJSON();
    const reverseDepth = [...element.querySelectorAll<HTMLElement>('.skill-chat-workbench__reverse-depth > button')].map((button) => ({
      ...button.getBoundingClientRect().toJSON(),
      clientWidth: button.clientWidth,
      scrollWidth: button.scrollWidth,
      text: button.textContent,
    }));
    return {
      modeTabs: rect('.skill-chat-workbench__mode-tabs'),
      reverseDepthGroup: rect('.skill-chat-workbench__reverse-depth'),
      reverseDepth,
      reasoning: rect('.codex-reasoning'),
      generation: rect('.skill-chat-workbench__generation-trigger'),
      knowledge: rect('.skill-chat-workbench__knowledge-compact'),
      send: rect('.skill-chat-workbench__send'),
    };
  });

  expect(controls.generation.x - (controls.reasoning.x + controls.reasoning.width)).toBeLessThanOrEqual(10);
  expect(controls.knowledge.x - (controls.generation.x + controls.generation.width)).toBeLessThanOrEqual(10);
  expect(controls.send.x - (controls.knowledge.x + controls.knowledge.width)).toBeLessThanOrEqual(10);
  expect(controls.reverseDepth).toHaveLength(3);
  expect(controls.reverseDepth.map((button) => button.text)).toEqual(['快速反推', '标准反推', '深度反推']);
  expect(controls.reverseDepthGroup.y).toBeGreaterThanOrEqual(controls.modeTabs.y + controls.modeTabs.height);
  expect(controls.reasoning.y).toBeGreaterThanOrEqual(controls.reverseDepthGroup.y + controls.reverseDepthGroup.height);
  for (const button of controls.reverseDepth) {
    expect(button.width).toBeGreaterThanOrEqual(80);
    expect(button.scrollWidth).toBeLessThanOrEqual(button.clientWidth);
  }
  await panel.locator('.skill-chat-workbench__composer').screenshot({ path: compactActionsArtifact });
});
