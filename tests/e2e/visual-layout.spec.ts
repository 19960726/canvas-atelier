import { test, expect } from './helpers/e2e-test';
import type { Locator } from '@playwright/test';
import {
  assertLocatorInside,
  assertNoTrackedRegionsOverlap,
  captureLayoutScreenshot,
  e2eState,
  expectVisibleMainRegion,
  medianPanZoomFrameInterval,
  openAgentPanel,
  openApp,
  openEmptyApp,
} from './helpers/app';

interface FocusStyleSnapshot {
  borderColor: string;
  boxShadow: string;
  outlineStyle: string;
  outlineWidth: number;
}

const viewports = [
  { name: '1366x768', width: 1366, height: 768 },
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1920x1080', width: 1920, height: 1080 },
];

for (const viewport of viewports) {
  test(`desktop layout has no overlaps and records pan/zoom frame marks at ${viewport.name}`, async ({ page }, testInfo) => {
    testInfo.annotations.push({
      type: 'runtime-profile-target',
      description: 'Renderer CI threshold only; physical Windows 7/10/11 FPS remains pending manual evidence.',
    });
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.addInitScript(() => localStorage.setItem('novus.theme.mode', 'dark'));
    await openApp(page);

    await expect(page.getByTestId('agent-panel')).toBeHidden();
    const toolRail = page.getByTestId('toolrail');
    await assertNoTrackedRegionsOverlap(page, [
      'topbar',
      'toolrail',
      'canvas-stage',
    ], [['toolrail', 'canvas-stage'], ['topbar', 'canvas-stage']]);
    if (viewport.width >= 760) {
      const toolRailBox = await toolRail.boundingBox();
      expect(toolRailBox).not.toBeNull();
      expect(toolRailBox).toMatchObject({ x: 52, y: 142, width: 60, height: 442 });
    }
    await expectVisibleMainRegion(page, viewport.width < 760 ? 2 : 3);
    await captureLayoutScreenshot(page, testInfo, `renderer-default-${viewport.name}`);
    const visibleNode = page.locator('[data-testid="module-node-card"][data-module-type="image_generation"]');
    await expect(visibleNode).toBeVisible();
    await expect(visibleNode).toHaveAttribute('data-module-type', /.+/);
    await expect(visibleNode.locator('.module-node__footer')).toBeHidden();
    await assertLocatorInside(visibleNode, visibleNode.getByRole('button', { name: 'Open image generation editor' }), `collapsed image preview at ${viewport.name}`);
    const focusableFlowNode = page.locator('.react-flow__node:not(.selected)', {
      has: page.locator('[data-testid="module-node-card"][data-module-type="image_generation"]'),
    }).first();
    await expect(focusableFlowNode).toBeVisible();
    await expectCanvasNodeFocusRing(focusableFlowNode, `canvas node focus at ${viewport.name}`);

    await openAgentPanel(page);
    const agentPanel = page.getByTestId('agent-panel');
    await expect(page.getByTestId('agent-composer-input')).toBeVisible();
    await expect(agentPanel).toHaveCSS('width', `${Math.min(440, viewport.width - 16)}px`);
    if (viewport.width >= 760) {
      const [canvasStageBox, agentPanelBox] = await Promise.all([
        page.getByTestId('canvas-stage').boundingBox(),
        agentPanel.boundingBox(),
      ]);
      expect(canvasStageBox, `canvas stage geometry at ${viewport.name}`).not.toBeNull();
      expect(agentPanelBox, `Agent panel geometry at ${viewport.name}`).not.toBeNull();
      expect(canvasStageBox!.x, `free canvas remains left of Agent panel at ${viewport.name}`)
        .toBeLessThan(agentPanelBox!.x);
    }
    await captureLayoutScreenshot(page, testInfo, `renderer-agent-${viewport.name}`);

    await page.getByTestId('tool-modules').click();
    await expect(page.getByTestId('agent-panel')).toBeHidden();
    await expect(page.getByTestId('job-strip')).toBeHidden();
    await expect(page.getByTestId('module-library')).toBeVisible();
    await page.evaluate(() => window.__NOVUS_E2E__?.createModule('image_generation', { x: 440, y: 120 }));
    const imageGenerationNode = page.locator('[data-module-type="image_generation"]').last();
    await expect(imageGenerationNode).toHaveCSS('width', '448px');
    // The current generation card separates its preview surface from the
    // transparent node shell; a shell color is no longer a layout invariant.
    await page.evaluate((position) => window.__NOVUS_E2E__?.createModule('reverse_agent', position), {
      x: viewport.width < 760 ? 16 : 900,
      y: 120,
    });
    const reverseAgentNode = page.locator('[data-module-type="reverse_agent"]').last();
    if (viewport.width >= 760) {
      await expect(reverseAgentNode).toHaveCSS('width', '426px');
    } else {
      await expect(reverseAgentNode).toHaveCSS(
        'width',
        `${Math.min(404, viewport.width - 32)}px`,
      );
    }
    const reverseBorder = await reverseAgentNode.evaluate((element) => {
      const probe = document.createElement('div');
      element.append(probe);
      probe.style.borderColor = 'var(--gate-border)';
      const color = getComputedStyle(probe).borderColor;
      probe.remove();
      return color;
    });
    await expect(reverseAgentNode).toHaveCSS('border-color', reverseBorder);

    await page.getByTestId('module-library-close').click();
    await expect(page.getByTestId('module-library')).toBeHidden();
    const panZoomMetrics = viewport.width >= 760
      ? await medianPanZoomFrameInterval(page)
      : null;

    const beforeStress = await e2eState(page);
    await page.evaluate(() => window.__NOVUS_E2E__?.seedModuleStressGraph(100, 150));
    const stressState = await e2eState(page);
    // The formal starter intentionally contains one image-input source; the
    // stress harness adds 50 more without mutating that durable starter.
    expect(stressState.moduleTypes.filter((type) => type === 'image_input')).toHaveLength(
      beforeStress.moduleTypes.filter((type) => type === 'image_input').length + 50,
    );
    expect(stressState.moduleTypes.filter((type) => type === 'reverse_agent')).toHaveLength(
      beforeStress.moduleTypes.filter((type) => type === 'reverse_agent').length + 50,
    );
    expect(stressState.edgeCount).toBeGreaterThanOrEqual(150);
    await expectVisibleMainRegion(page);
    expect(await page.locator('[data-module-type="image_input"], [data-module-type="reverse_agent"]').count())
      .toBeGreaterThan(1);
    const moduleBox = await page.locator('[data-module-type="image_input"]').first().boundingBox();
    expect(moduleBox, `stress module geometry at ${viewport.name}`).not.toBeNull();
    const [moduleCssWidth, moduleCssHeight] = await page.locator('[data-module-type="image_input"]').first().evaluate((element) => {
      const style = getComputedStyle(element);
      return [Number.parseFloat(style.width), Number.parseFloat(style.height)];
    });
    // Current UI Gate keeps the import slot large enough to show the real media cover.
    expect(moduleCssWidth, `Canvas media source width at ${viewport.name}`).toBe(292);
    expect(moduleCssHeight, `Canvas media source height at ${viewport.name}`).toBe(326);
    await captureLayoutScreenshot(page, testInfo, `renderer-module-stress-${viewport.name}`);

    // Placement preview belongs to the retired canvas and must not reappear
    // through a visual-layout check in the UI Gate workspace.
    await expect(page.getByTestId('tool-placement')).toBeHidden();

    await testInfo.attach(`pan-zoom-median-${viewport.name}.txt`, {
      body: panZoomMetrics
        ? `medianFrameMs=${panZoomMetrics.medianFrameMs.toFixed(2)}\nmarkCount=${panZoomMetrics.markCount}\nruntimeProfileTarget=renderer-local-ci\n`
        : 'skipped=narrow viewport stress graph has no uncovered pane point\nruntimeProfileTarget=renderer-local-ci\n',
      contentType: 'text/plain',
    });
    if (panZoomMetrics) {
      expect(panZoomMetrics.medianFrameMs).toBeGreaterThanOrEqual(0);
      expect(panZoomMetrics.medianFrameMs).toBeLessThan(150);
      expect(panZoomMetrics.markCount).toBeGreaterThanOrEqual(4);
    }
  });
}

test('整理画布按连线层级排列全部节点并保存为一次可撤销事务', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openEmptyApp(page);
  await page.evaluate(async () => {
    const e2e = window.__NOVUS_E2E__!;
    await e2e.createModule('image_input', { x: 980, y: 680 });
    await e2e.createModule('reverse_agent', { x: 60, y: 80 });
    await e2e.createModule('reverse_result', { x: 520, y: 520 });
    await e2e.createModule('image_generation', { x: 90, y: 720 });
    await e2e.connectModules('image_input', 'image', 'reverse_agent', 'references');
    await e2e.connectModules('reverse_agent', 'analysis', 'reverse_result', 'analysis');
  });

  await expect(page.getByTestId('canvas-arrange-button')).toHaveCount(0);
  const arrangeCanvasButton = page.getByTestId('tool-arrange');
  await expect(arrangeCanvasButton).toBeVisible();
  await expect(arrangeCanvasButton).toHaveAccessibleName('整理画布');
  const before = await e2eState(page);
  const beforeCommitCount = before.commitCount;
  await arrangeCanvasButton.click();

  await expect.poll(async () => (await e2eState(page)).commitCount).toBe(beforeCommitCount + 1);
  const after = await e2eState(page);
  expect(after.modulePositions).toHaveLength(4);
  expect(new Set(after.modulePositions.map((node) => `${node.position.x}:${node.position.y}`)).size).toBe(4);
  const input = after.modulePositions.find((node) => node.moduleType === 'image_input')!;
  const reverse = after.modulePositions.find((node) => node.moduleType === 'reverse_agent')!;
  const result = after.modulePositions.find((node) => node.moduleType === 'reverse_result')!;
  expect(input.position.x).toBeLessThan(reverse.position.x);
  expect(reverse.position.x).toBeLessThan(result.position.x);
  await expect(page.getByRole('button', { name: '撤销' })).toBeEnabled();
  await page.getByRole('button', { name: '撤销' }).click();
  await expect.poll(async () => (await e2eState(page)).commitCount).toBeGreaterThan(beforeCommitCount + 1);
  expect((await e2eState(page)).modulePositions).toEqual(before.modulePositions);

  await arrangeCanvasButton.click();
  await expect.poll(async () => (await e2eState(page)).commitCount).toBeGreaterThan(beforeCommitCount + 2);
  const persisted = await e2eState(page);
  await page.evaluate(() => window.__NOVUS_E2E__!.reopenProject());
  const reloaded = await e2eState(page);
  expect(reloaded.modulePositions).toEqual(persisted.modulePositions);
});

for (const theme of ['dark', 'light'] as const) {
  for (const viewport of viewports) {
    test(`captures the formal default canvas in ${theme} theme at ${viewport.name}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.addInitScript((selectedTheme) => localStorage.setItem('novus.theme.mode', selectedTheme), theme);
      await openApp(page);
      await expectVisibleMainRegion(page, 3);
      await captureLayoutScreenshot(page, testInfo, `renderer-default-${theme}-${viewport.name}`);
    });
  }
}

for (const theme of ['dark', 'light'] as const) {
  for (const viewport of viewports) {
    test(`keeps persisted reverse result regions in flow without horizontal overflow in ${theme} at ${viewport.name}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.addInitScript((selectedTheme) => localStorage.setItem('novus.theme.mode', selectedTheme), theme);
      await openApp(page);
      const configured = await page.evaluate(async () => {
        return window.__NOVUS_E2E__!.configureModule('reverse_agent', {
          config: {
            modelRoute: 'comfly-gpt-5-6-sol',
            role: '视觉分析师',
            task: '分析构图、材质与镜头。',
            reverseAgentRunState: 'completed',
            reverseAgentError: `request-id-${'A'.repeat(512)}`,
            reverseAgentResult: {
              analysis: 'Keep the centered camera and rim light.',
              positivePrompt: 'Verified product prompt',
              negativeConstraints: ['Do not change the logo'],
              executionChecklist: ['Check product identity'],
            },
          },
          execution: { state: 'completed' },
        });
      });
      expect(configured).toBe(true);

      const reverse = page.locator('[data-module-type="reverse_agent"]').first();
      await expect(reverse).toBeVisible();
      await expect(reverse.getByText('Verified product prompt')).toBeVisible();
      const regions = ['route', 'task', 'knowledge', 'result', 'actions'];
      const boxes = await Promise.all(regions.map(async (region) => ({
        region,
        box: await reverse.locator(`[data-agent-region="${region}"]`).boundingBox(),
      })));

      for (const entry of boxes) {
        expect(entry.box, `${entry.region} bounds in ${theme} at ${viewport.name}`).not.toBeNull();
      }
      for (let index = 1; index < boxes.length; index += 1) {
        expect(boxes[index]!.box!.y, `${boxes[index]!.region} follows ${boxes[index - 1]!.region} in ${theme} at ${viewport.name}`).toBeGreaterThanOrEqual(
          boxes[index - 1]!.box!.y + boxes[index - 1]!.box!.height,
        );
      }
      const knowledge = reverse.locator('[data-agent-region="knowledge"]');
      const childGeometry = await knowledge.evaluate((element) => {
        const sectionBox = element.getBoundingClientRect();
        const label = element.querySelector<HTMLElement>('.module-node__knowledge-label');
        const trigger = element.querySelector<HTMLElement>('.module-node__knowledge-trigger');
        const box = (child: HTMLElement | null) => {
          if (!child) return null;
          const rect = child.getBoundingClientRect();
          return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, height: rect.height };
        };
        return {
          position: getComputedStyle(element).position,
          section: { top: sectionBox.top, right: sectionBox.right, bottom: sectionBox.bottom, left: sectionBox.left },
          label: box(label),
          trigger: box(trigger),
        };
      });
      expect(childGeometry.position, `knowledge containing block in ${theme} at ${viewport.name}`).toBe('relative');
      expect(childGeometry.label).not.toBeNull();
      expect(childGeometry.trigger).not.toBeNull();
      expect(childGeometry.label!.left).toBeGreaterThanOrEqual(childGeometry.section.left);
      expect(childGeometry.label!.right).toBeLessThanOrEqual(childGeometry.section.right);
      expect(childGeometry.label!.top).toBeGreaterThanOrEqual(childGeometry.section.top);
      expect(childGeometry.label!.bottom).toBeLessThanOrEqual(childGeometry.section.bottom);
      expect(childGeometry.trigger!.left).toBeGreaterThanOrEqual(childGeometry.section.left);
      expect(childGeometry.trigger!.right).toBeLessThanOrEqual(childGeometry.section.right);
      expect(childGeometry.trigger!.top).toBeGreaterThanOrEqual(childGeometry.label!.bottom);
      expect(childGeometry.trigger!.bottom).toBeLessThanOrEqual(childGeometry.section.bottom);
      expect(childGeometry.label!.top).toBeGreaterThanOrEqual(boxes[1]!.box!.y + boxes[1]!.box!.height);
      expect(childGeometry.trigger!.bottom).toBeLessThanOrEqual(boxes[3]!.box!.y);
      const alert = reverse.getByRole('alert');
      await expect(alert).toBeVisible();
      const content = reverse.locator('.module-node__summary--agent-studio');
      await expect(content).toBeVisible();
      const horizontalMetrics = await content.evaluate((element) => ({
        contentRight: element.getBoundingClientRect().left + element.clientLeft + element.clientWidth,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        overflowingDescendants: [...element.querySelectorAll<HTMLElement>('*')].map((child) => {
          const rect = child.getBoundingClientRect();
          const contentRight = element.getBoundingClientRect().left + element.clientLeft + element.clientWidth;
          return {
            className: typeof child.className === 'string' ? child.className : '',
            clientWidth: child.clientWidth,
            height: Math.round(rect.height * 100) / 100,
            internalOverflowPx: child.scrollWidth - child.clientWidth,
            right: Math.round(rect.right * 100) / 100,
            scrollWidth: child.scrollWidth,
            tagName: child.tagName,
            width: Math.round(rect.width * 100) / 100,
            overflowPx: Math.round(Math.max(0, rect.right - contentRight) * 100) / 100,
          };
        })
          .filter((child) => child.overflowPx > 0 || child.internalOverflowPx > 0)
          .sort((left, right) => Math.max(right.overflowPx, right.internalOverflowPx) - Math.max(left.overflowPx, left.internalOverflowPx)),
      }));
      expect(horizontalMetrics.scrollWidth, JSON.stringify(horizontalMetrics)).toBeLessThanOrEqual(horizontalMetrics.clientWidth);
      const alertMetrics = await alert.evaluate((element) => ({
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
      }));
      expect(alertMetrics.scrollWidth, JSON.stringify(alertMetrics)).toBeLessThanOrEqual(alertMetrics.clientWidth);
      await captureLayoutScreenshot(page, testInfo, `reverse-result-flow-${theme}-${viewport.name}`);
    });
  }
}

async function expectCanvasNodeFocusRing(flowNode: Locator, label: string): Promise<void> {
  const card = flowNode.locator('[data-testid="module-node-card"]');
  const before = await focusStyleSnapshot(card);
  await flowNode.focus();
  await expect(flowNode, `${label} active element`).toBeFocused();
  const after = await focusStyleSnapshot(card);
  expect(
    hasVisibleFocusTreatment(before, after),
    `${label}: ${JSON.stringify({ after, before })}`,
  ).toBe(true);
}

async function focusStyleSnapshot(locator: Locator): Promise<FocusStyleSnapshot> {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      borderColor: style.borderColor,
      boxShadow: style.boxShadow,
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth) || 0,
    };
  });
}

function hasVisibleFocusTreatment(before: FocusStyleSnapshot, after: FocusStyleSnapshot): boolean {
  const hasOutline = after.outlineStyle !== 'none' && after.outlineWidth >= 2;
  return hasOutline && (
    after.borderColor !== before.borderColor
    || after.boxShadow !== before.boxShadow
    || after.outlineWidth !== before.outlineWidth
  );
}
