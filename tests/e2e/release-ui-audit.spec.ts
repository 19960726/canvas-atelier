import { test, expect } from './helpers/e2e-test';
import {
  captureLayoutScreenshot,
  openAgentPanel,
  openEmptyApp,
  queueProjectImageImport,
} from './helpers/app';
import { makeReferenceImage } from './helpers/fixtures';

async function captureSurface(
  page: Parameters<typeof openEmptyApp>[0],
  testInfo: Parameters<typeof captureLayoutScreenshot>[1],
  name: string,
): Promise<void> {
  await expect(page.getByTestId('workspace')).toBeVisible();
  await captureLayoutScreenshot(page, testInfo, name);
}

async function assertReversePortCentersOnCardEdges(
  page: Parameters<typeof openEmptyApp>[0],
  context: string,
): Promise<number> {
  const reverse = page.locator('[data-module-type="reverse_agent"]');
  const [nodeBox, inputBox, outputBox, zoom] = await Promise.all([
    reverse.boundingBox(),
    reverse.locator('[data-port-id="references"][data-port-direction="input"] .react-flow__handle').boundingBox(),
    reverse.locator('[data-port-id="analysis"][data-port-direction="output"] .react-flow__handle').boundingBox(),
    page.locator('.react-flow__viewport').evaluate((element) => {
      const transform = getComputedStyle(element).transform;
      return transform === 'none' ? 1 : new DOMMatrixReadOnly(transform).a;
    }),
  ]);
  expect(nodeBox, `${context}: reverse card must be measurable`).not.toBeNull();
  expect(inputBox, `${context}: reverse input must be measurable`).not.toBeNull();
  expect(outputBox, `${context}: reverse output must be measurable`).not.toBeNull();
  const roundingAllowance = Math.max(2, zoom * 1.5);
  expect(
    Math.abs((inputBox!.x + inputBox!.width / 2) - nodeBox!.x),
    `${context}: reverse input centre must remain on the left card edge`,
  ).toBeLessThanOrEqual(roundingAllowance);
  expect(
    Math.abs((outputBox!.x + outputBox!.width / 2) - (nodeBox!.x + nodeBox!.width)),
    `${context}: reverse output centre must remain on the right card edge`,
  ).toBeLessThanOrEqual(roundingAllowance);
  expect(inputBox!.x, `${context}: the input socket must retain its outer half`).toBeLessThan(nodeBox!.x);
  expect(inputBox!.x + inputBox!.width, `${context}: the input socket must retain its inner half`).toBeGreaterThan(nodeBox!.x);
  expect(outputBox!.x, `${context}: the output socket must retain its inner half`).toBeLessThan(nodeBox!.x + nodeBox!.width);
  expect(outputBox!.x + outputBox!.width, `${context}: the output socket must retain its outer half`).toBeGreaterThan(nodeBox!.x + nodeBox!.width);
  const outerHitEvidence = await page.evaluate(({ inputPoint, outputPoint }) => {
    const reverseNode = document.querySelector('[data-module-type="reverse_agent"]');
    const input = reverseNode?.querySelector('[data-port-id="references"][data-port-direction="input"] .react-flow__handle');
    const output = reverseNode?.querySelector('[data-port-id="analysis"][data-port-direction="output"] .react-flow__handle');
    const hits = (element: Element | null | undefined, point: { x: number; y: number }) => (
      element !== null
      && element !== undefined
      && document.elementsFromPoint(point.x, point.y).includes(element)
    );
    return {
      inputOuterHit: hits(input, inputPoint),
      outputOuterHit: hits(output, outputPoint),
    };
  }, {
    inputPoint: { x: nodeBox!.x - inputBox!.width / 4, y: inputBox!.y + inputBox!.height / 2 },
    outputPoint: { x: nodeBox!.x + nodeBox!.width + outputBox!.width / 4, y: outputBox!.y + outputBox!.height / 2 },
  });
  expect(outerHitEvidence.inputOuterHit, `${context}: the visible outer half of the input socket must remain hit-testable`).toBe(true);
  expect(outerHitEvidence.outputOuterHit, `${context}: the visible outer half of the output socket must remain hit-testable`).toBe(true);
  return zoom;
}

for (const theme of ['dark', 'light'] as const) {
  test(`keeps the Canvas 408 reverse-agent form intact in ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript((nextTheme) => localStorage.setItem('novus.theme.mode', nextTheme), theme);
    await openEmptyApp(page);
    await page.evaluate(async () => {
      await window.__NOVUS_E2E__!.createModule('image_input', { x: 110, y: 320 });
      await window.__NOVUS_E2E__!.createModule('reverse_agent', { x: 300, y: 154 });
    });

    const reverse = page.locator('[data-module-type="reverse_agent"]');
    const reverseTitle = reverse.locator('.module-node__workbench-header > span');
    expect(await reverseTitle.evaluate((element) => getComputedStyle(element, '::before').content)).toBe('"✦"');
    await expect(reverse.locator('.module-node__workbench-header > b')).toHaveCSS('border-radius', '999px');
    const emptyRail = reverse.getByLabel('Reverse media workspace');
    await expect(emptyRail).toBeVisible();
    await expect(emptyRail).toHaveClass(/module-node__agent-media-empty-hint/);
    await expect(emptyRail.locator('img')).toHaveCount(0);
    await captureSurface(page, testInfo, `reverse-agent-empty-${theme}`);

    const image = page.locator('[data-module-type="image_input"]');
    await queueProjectImageImport(page, makeReferenceImage('Reverse layout reference.png', [34, 120, 168, 255], { width: 640, height: 360 }));
    await image.getByRole('button', { name: '导入图像 / Import image' }).click();
    await expect(image.getByRole('img', { name: 'Reverse layout reference' })).toBeVisible();
    await page.evaluate(() => window.__NOVUS_E2E__!.connectModules('image_input', 'image', 'reverse_agent', 'references'));

    await expect(reverse).toHaveCSS('width', '426px');
    await expect(reverse.getByLabel('Agent model route')).toBeVisible();
    await expect(reverse.getByRole('button', { name: '添加反推素材' })).toBeVisible();
    await expect(reverse.getByRole('textbox', { name: 'Role positioning' })).toBeVisible();
    const analysisTask = reverse.getByRole('textbox', { name: 'Analysis task' });
    await expect(analysisTask).toBeVisible();
    await expect(reverse.getByRole('button', { name: '引用图片' })).toHaveCount(0);
    await analysisTask.fill('@');
    const mentionMenu = reverse.getByRole('menu', { name: 'Select reference image' });
    await expect(mentionMenu).toBeVisible();
    await mentionMenu.getByRole('menuitem', { name: /Reverse layout reference/u }).click();
    await expect.poll(() => analysisTask.evaluate((element) => (
      (element as HTMLDivElement & { value?: string }).value ?? ''
    ))).toBe('@图片1');
    await expect(mentionMenu).toBeHidden();
    const reverseChip = analysisTask.locator('[data-media-mention="image"]');
    await expect(reverseChip).toBeVisible();
    const [reverseChipBox, analysisTaskBox] = await Promise.all([
      reverseChip.boundingBox(),
      analysisTask.boundingBox(),
    ]);
    expect(reverseChipBox).not.toBeNull();
    expect(analysisTaskBox).not.toBeNull();
    expect(reverseChipBox!.width, 'Reference capsules must size to their content, not become a full-width bar').toBeLessThan(240);
    expect(reverseChipBox!.width).toBeLessThan(analysisTaskBox!.width);
    expect(reverseChipBox!.height).toBe(24);
    expect(reverseChipBox!.x).toBeGreaterThanOrEqual(analysisTaskBox!.x);
    expect(reverseChipBox!.x + reverseChipBox!.width).toBeLessThanOrEqual(analysisTaskBox!.x + analysisTaskBox!.width);
    const knowledgeTrigger = reverse.getByLabel('Reverse knowledge context').getByRole('button');
    await expect(knowledgeTrigger).toHaveCSS('width', '390px');
    await expect(knowledgeTrigger).toHaveCSS('height', '38px');
    const [reverseBox, mediaBox, routeRegionBox, routeBox, roleBox, taskBox, addReferenceBox, knowledgeBox, actionsBox] = await Promise.all([
      reverse.boundingBox(),
      reverse.getByLabel('Reverse media workspace').boundingBox(),
      reverse.getByLabel('Reverse model workspace').boundingBox(),
      reverse.getByLabel('Agent model route').boundingBox(),
      reverse.getByRole('textbox', { name: 'Role positioning' }).boundingBox(),
      analysisTask.boundingBox(),
      reverse.getByRole('button', { name: '添加反推素材' }).boundingBox(),
      knowledgeTrigger.boundingBox(),
      reverse.getByLabel('Reverse task actions').boundingBox(),
    ]);
    expect([reverseBox, mediaBox, routeRegionBox, routeBox, roleBox, taskBox, addReferenceBox, knowledgeBox, actionsBox].every(Boolean)).toBe(true);
    expect(reverseBox!.height).toBeGreaterThanOrEqual(646);
    expect(routeRegionBox!.width, 'The language-model region must occupy the full 390px content row').toBe(390);
    expect(routeBox!.width, 'The language-model select must occupy the full 390px content row').toBe(390);
    expect(routeRegionBox!.x, 'The language-model row must align with the media workspace').toBe(mediaBox!.x);
    expect(routeBox!.x, 'The language-model select must align with the media workspace').toBe(mediaBox!.x);
    expect(routeRegionBox!.y, 'The language-model row must follow the reference rail').toBeGreaterThanOrEqual(mediaBox!.y + mediaBox!.height);
    await testInfo.attach('reverse-agent-layout.json', {
      body: JSON.stringify({
        media: mediaBox!.y - reverseBox!.y,
        route: routeBox!.y - reverseBox!.y,
        role: roleBox!.y - reverseBox!.y,
        task: taskBox!.y - reverseBox!.y,
        knowledge: knowledgeBox!.y - reverseBox!.y,
        actions: actionsBox!.y - reverseBox!.y,
      }),
      contentType: 'application/json',
    });
    expect(addReferenceBox!.width).toBeGreaterThan(0);
    const formFlow = [mediaBox!, routeBox!, roleBox!, taskBox!, knowledgeBox!, actionsBox!];
    for (let index = 1; index < formFlow.length; index += 1) {
      expect(formFlow[index].y).toBeGreaterThanOrEqual(formFlow[index - 1].y + formFlow[index - 1].height);
    }
    expect(actionsBox!.y + actionsBox!.height, 'Reverse task actions must remain inside the reverse-agent card').toBeLessThanOrEqual(reverseBox!.y + reverseBox!.height);
    expect(
      Math.abs((actionsBox!.x + actionsBox!.width / 2) - (reverseBox!.x + reverseBox!.width / 2)),
      'Reverse action buttons must stay centered on the Canvas card midpoint in both themes',
    ).toBeLessThanOrEqual(1);
    await captureSurface(page, testInfo, `reverse-agent-${theme}`);
    const initialZoom = await assertReversePortCentersOnCardEdges(page, `${theme} initial zoom`);
    await page.locator('.react-flow__controls-zoomin').evaluate((element) => {
      if (!(element instanceof HTMLButtonElement)) throw new Error('React Flow zoom-in control is unavailable');
      element.click();
    });
    await expect.poll(() => page.locator('.react-flow__viewport').evaluate((element) => {
      const transform = getComputedStyle(element).transform;
      return transform === 'none' ? 1 : new DOMMatrixReadOnly(transform).a;
    })).toBeGreaterThan(initialZoom);
    await assertReversePortCentersOnCardEdges(page, `${theme} zoomed in`);
  });
}

test('captures the current floating-Agent release surfaces in dark and light themes', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openEmptyApp(page);
  await expect(page.getByTestId('topbar')).toContainText('Canvas Atelier');
  await expect(page.getByTestId('job-strip')).toBeHidden();
  await expect(page.locator('.react-flow__minimap')).toBeVisible();
  await page.evaluate(async () => {
    await window.__NOVUS_E2E__!.createModule('image_generation', { x: 100, y: 112 });
    await window.__NOVUS_E2E__!.createModule('reverse_agent', { x: 1000, y: 88 });
    await window.__NOVUS_E2E__!.createModule('result_output', { x: 720, y: 620 });
  });
  const generation = page.locator('[data-module-type="image_generation"]');
  const reverse = page.locator('[data-module-type="reverse_agent"]');
  await expect(generation).toBeVisible();
  await expect(reverse).toBeVisible();
  await expect(page.locator('[data-module-type="result_output"]')).toBeVisible();
  await generation.getByRole('button', { name: 'Open image generation editor' }).click();
  const prompt = generation.getByRole('textbox', { name: 'Image generation prompt' });
  await expect(prompt).toBeVisible();
  const [nodeBox, promptBox] = await Promise.all([generation.boundingBox(), prompt.boundingBox()]);
  expect(nodeBox).not.toBeNull();
  expect(promptBox).not.toBeNull();
  expect(promptBox!.x).toBeGreaterThanOrEqual(nodeBox!.x);
  expect(promptBox!.x + promptBox!.width).toBeLessThanOrEqual(nodeBox!.x + nodeBox!.width + 1);
  await expect(page.locator('.react-flow__minimap')).toBeHidden();
  await captureSurface(page, testInfo, 'release-canvas-dark');

  await openAgentPanel(page);
  const agent = page.getByTestId('agent-panel');
  await expect(agent.getByTestId('agent-composer-input')).toBeVisible();
  await expect(agent.getByTestId('agent-model-trigger')).toBeVisible();
  await expect(agent.getByRole('button', { name: '新建任务' })).toBeVisible();
  const bounds = await agent.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.width).toBeGreaterThanOrEqual(400);
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(1440);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(900);
  await captureSurface(page, testInfo, 'release-agent-dark');

  await page.getByTestId('history-toggle').click();
  await expect(page.getByTestId('history-drawer')).toBeVisible();
  await captureSurface(page, testInfo, 'release-history-dark');
  await page.getByTestId('history-drawer-close').click();

  await page.getByTestId('settings-toggle').click();
  const settings = page.getByTestId('settings-drawer');
  await expect(settings).toBeVisible();
  await expect(settings.getByLabel('供应商设置')).toBeVisible();
  await captureSurface(page, testInfo, 'release-settings-dark');
  await page.getByLabel('主题 Theme').selectOption('light', { force: true });
  await captureSurface(page, testInfo, 'release-settings-light');
  await page.getByTestId('settings-toggle').click();
  await openAgentPanel(page);
  await expect(agent.getByTestId('agent-composer-input')).toBeVisible();
  await captureSurface(page, testInfo, 'release-agent-light');
});
for (const theme of ['dark', 'light'] as const) {
  test(`captures visible image-input connections in ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openEmptyApp(page);
    await page.locator('.theme-control select').selectOption(theme, { force: true });
    await page.evaluate(async () => {
      await window.__NOVUS_E2E__!.createModule('image_input', { x: 110, y: 320 });
      await window.__NOVUS_E2E__!.createModule('reverse_agent', { x: 440, y: 70 });
      await window.__NOVUS_E2E__!.createModule('image_generation', { x: 920, y: 70 });
      await window.__NOVUS_E2E__!.createModule('video_generation', { x: 110, y: 650 });
    });

    await queueProjectImageImport(
      page,
      makeReferenceImage('Connected media reference.png', [34, 120, 168, 255], { width: 640, height: 360 }),
    );
    const imageNode = page.locator('[data-module-type="image_input"]');
    await imageNode.getByRole('button', { name: '导入图像 / Import image' }).click();
    await expect(imageNode.getByRole('img', { name: 'Connected media reference' })).toBeVisible();

    const imageOutput = page.locator('[data-module-type="image_input"] [data-port-id="image"].react-flow__handle');
    await expect(imageOutput).toBeVisible();
    const [expectedAccent, expectedPortSurface] = await page.evaluate(() => {
      const read = (property: 'background' | 'border-color') => {
        const probe = document.createElement('div');
        probe.style.setProperty(property, property === 'background' ? 'var(--accent)' : 'var(--border-strong)');
        document.body.append(probe);
        const value = property === 'background'
          ? getComputedStyle(probe).backgroundColor
          : getComputedStyle(probe).borderColor;
        probe.remove();
        return value;
      };
      const workspace = document.querySelector<HTMLElement>('.workspace--canvas-layout');
      const surface = workspace === null
        ? 'rgba(0, 0, 0, 0)'
        : getComputedStyle(workspace).getPropertyValue('--gate-card').trim();
      const colorProbe = document.createElement('div');
      colorProbe.style.background = surface;
      document.body.append(colorProbe);
      const resolvedSurface = getComputedStyle(colorProbe).backgroundColor;
      colorProbe.remove();
      return [read('background'), resolvedSurface];
    });
    await expect(imageOutput).toHaveCSS('background-color', expectedPortSurface);
    await expect(imageOutput).toHaveCSS('border-color', expectedAccent);
    for (const { label, portAxis, target, node } of [
      {
        label: 'Reverse Agent primary media input',
        portAxis: 'card-center',
        node: page.locator('[data-module-type="reverse_agent"]'),
        target: page.locator('[data-module-type="reverse_agent"] [data-port-id="references"].react-flow__handle'),
      },
      {
        label: 'Image Generation primary media input',
        portAxis: 'card-center',
        node: page.locator('[data-module-type="image_generation"]'),
        target: page.locator('[data-module-type="image_generation"] [data-port-id="references"].react-flow__handle'),
      },
      {
        label: 'Video Generation primary media input',
        // Canvas 332:2: node top=120 and the 16px input socket starts at
        // y=328, so its centre is 216px down the canonical 672×720 card.
        portAxis: 'video-preview-axis',
        node: page.locator('[data-module-type="video_generation"]'),
        target: page.locator('[data-module-type="video_generation"] [data-port-id="media"].react-flow__handle'),
      },
      {
        label: 'Video Generation result output',
        // Canvas puts the result output on the same 216px preview axis.
        portAxis: 'video-preview-axis',
        node: page.locator('[data-module-type="video_generation"]'),
        target: page.locator('[data-module-type="video_generation"] [data-port-id="result"].react-flow__handle'),
      },
    ] as const) {
      await expect(target).toBeVisible();
      const [targetBox, nodeBox] = await Promise.all([
        target.boundingBox(),
        node.boundingBox(),
      ]);
      expect(targetBox).not.toBeNull();
      expect(nodeBox).not.toBeNull();
      expect(targetBox!.width).toBe(16);
      const targetCenterY = targetBox!.y + targetBox!.height / 2;
      const expectedCenterY = portAxis === 'video-preview-axis'
        ? nodeBox!.y + (216 / 720) * nodeBox!.height
        : nodeBox!.y + nodeBox!.height / 2;
      expect(
        Math.abs(targetCenterY - expectedCenterY),
        portAxis === 'video-preview-axis'
          ? `${label} must align with Canvas's preview connection axis`
          : `${label} must remain on its card midpoint`,
      ).toBeLessThanOrEqual(16);
      await expect(target).toHaveCSS('background-color', expectedPortSurface);
      await expect(target).toHaveCSS('border-color', expectedAccent);
      if (label !== 'Video Generation result output') await imageOutput.dragTo(target);
    }

    const imageGeneration = page.locator('[data-module-type="image_generation"]');
    await imageGeneration.getByRole('button', { name: 'Open image generation editor' }).click();
    const imagePrompt = imageGeneration.getByRole('textbox', { name: 'Image generation prompt' });
    const imageReferenceSlots = imageGeneration.getByLabel('Image generation reference slots');
    await expect(imageReferenceSlots).toBeVisible();
    await expect(
      imageGeneration.getByLabel('Image generation connected references'),
      'The Canvas image card uses a dedicated reference tray; the legacy managed-reference badge must not render as a second surface.',
    ).toBeHidden();
    const [imagePromptBox, imageReferenceSlotsBox] = await Promise.all([
      imagePrompt.boundingBox(),
      imageReferenceSlots.boundingBox(),
    ]);
    expect(imagePromptBox).not.toBeNull();
    expect(imageReferenceSlotsBox).not.toBeNull();
    expect(imageReferenceSlotsBox!.x).toBeLessThanOrEqual(imagePromptBox!.x);
    expect(imageReferenceSlotsBox!.x + imageReferenceSlotsBox!.width).toBeGreaterThanOrEqual(imagePromptBox!.x + imagePromptBox!.width);
    const firstImageReference = imageReferenceSlots.getByLabel('Agent media slot 1');
    const firstImageReferenceBox = await firstImageReference.boundingBox();
    expect(firstImageReferenceBox).not.toBeNull();
    expect(
      firstImageReferenceBox!.x,
      'Canvas 411:2 pins connected image thumbnails to the tray start; legacy CSS must not center them.',
    ).toBeLessThanOrEqual(imageReferenceSlotsBox!.x + 16);
    expect(
      imageReferenceSlotsBox!.y + imageReferenceSlotsBox!.height,
      'Canvas 411:2 places connected reference media in its own tray above the prompt, never inside the text area.',
    ).toBeLessThanOrEqual(imagePromptBox!.y);
    const resolutionTrigger = imageGeneration.getByRole('button', { name: 'Image generation resolution' });
    await expect(resolutionTrigger).toHaveAttribute('value', '2K');
    await resolutionTrigger.focus();
    await page.keyboard.press('Enter');
    const resolutionOptions = imageGeneration
      .getByRole('menu', { name: 'Image generation resolution options' })
      .getByRole('menuitemradio');
    await expect(resolutionOptions).toHaveText(['1K', '2K', '4K']);
    await resolutionOptions.filter({ hasText: '4K' }).focus();
    await page.keyboard.press('Enter');
    await expect(resolutionTrigger).toHaveAttribute('value', '4K');
    const generateImage = imageGeneration.getByRole('button', { name: 'Generate image' });
    await expect(generateImage).toHaveCSS('font-size', '11px');
    expect(await generateImage.evaluate((element) => getComputedStyle(element, '::after').content)).toBe('none');
    const imageGenerationResult = imageGeneration.locator('[data-port-id="result"][data-port-direction="output"] .react-flow__handle:not([data-visual-alias="true"])');
    const [previewBox, resultBox] = await Promise.all([
      imageGeneration.locator('.module-node__generation-editor-preview').boundingBox(),
      imageGenerationResult.boundingBox(),
    ]);
    expect(previewBox).not.toBeNull();
    expect(resultBox).not.toBeNull();
    expect(
      Math.abs((resultBox!.y + resultBox!.height / 2) - (previewBox!.y + previewBox!.height / 2)),
      'Image Generation result endpoint must stay on the current preview connection rail',
    ).toBeLessThanOrEqual(14);

    await expect(page.locator('.react-flow__edge')).toHaveCount(3);
    await expect.poll(async () => page.locator('.react-flow__edge-path').evaluateAll((paths) => (
      paths.every((path) => {
        const stroke = getComputedStyle(path).stroke;
        return stroke !== 'none' && stroke !== 'transparent' && stroke !== 'rgba(0, 0, 0, 0)';
      })
    ))).toBe(true);
    await expect.poll(async () => page.locator('.react-flow__edge-path').evaluateAll((paths, expectedAccent) => (
      paths.every((path) => {
        const style = getComputedStyle(path);
        return style.stroke === expectedAccent && Number.parseFloat(style.strokeWidth) === 2;
      })
    ), expectedAccent)).toBe(true);
    await captureSurface(page, testInfo, `image-input-connections-${theme}`);
  });

  test(`keeps reverse analysis in its dedicated result flow without an inline legacy result in ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openEmptyApp(page);
    await page.locator('.theme-control select').selectOption(theme, { force: true });
    await page.evaluate(async () => {
      await window.__NOVUS_E2E__!.createModule('image_input', { x: 160, y: 260 });
      await window.__NOVUS_E2E__!.createModule('reverse_agent', { x: 660, y: 160 });
    });

    const imageNode = page.locator('[data-module-type="image_input"]');
    const reverseNode = page.locator('[data-module-type="reverse_agent"]');
    await expect(imageNode).toBeVisible();
    await expect(reverseNode).toBeVisible();

    await queueProjectImageImport(
      page,
      makeReferenceImage('Reverse audit reference.png', [34, 120, 168, 255], { width: 640, height: 360 }),
    );
    await imageNode.locator('.module-node__media-empty').click();
    await expect(imageNode.getByRole('img', { name: 'Reverse audit reference' })).toBeVisible();
    await page.evaluate(() => window.__NOVUS_E2E__!.connectModules(
      'image_input',
      'image',
      'reverse_agent',
      'references',
    ));
    await expect(page.locator('.react-flow__edge')).toHaveCount(1);

    await page.getByRole('textbox', { name: 'Role positioning' }).fill('Commercial visual analyst');
    await page.getByRole('textbox', { name: 'Analysis task' }).fill('Analyze the connected reference.');
    const route = page.getByLabel('Agent model route');
    await expect(route.locator('option:not([value=""])')).not.toHaveCount(0);
    await expect(route).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start reverse analysis' })).toBeEnabled();
    await page.evaluate(() => {
      const bridge = window.novusDesktop.provider;
      const analyzeReversePrompt = bridge.analyzeReversePrompt;
      bridge.analyzeReversePrompt = async (input) => {
        document.documentElement.dataset.e2eReverseProviderInvoked = 'true';
        const result = await analyzeReversePrompt(input);
        document.documentElement.dataset.e2eReverseProviderResolved = 'true';
        return result;
      };
    });
    await page.getByRole('button', { name: 'Start reverse analysis' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-e2e-reverse-provider-invoked', 'true');
    await expect(page.locator('html')).toHaveAttribute('data-e2e-reverse-provider-resolved', 'true');

    await expect(reverseNode.getByLabel('AI analysis output')).toHaveCount(0);
    await expect(reverseNode.getByRole('textbox', { name: 'Role positioning' })).toBeVisible();
    await expect(reverseNode.getByRole('textbox', { name: 'Analysis task' })).toBeVisible();
    const referenceInput = reverseNode.locator('[data-port-id="references"].react-flow__handle');
    const analysisOutput = reverseNode.locator('[data-port-id="analysis"].react-flow__handle');
    await expect(referenceInput).toHaveCount(1);
    await expect(referenceInput).toBeVisible();
    await expect(analysisOutput).toHaveCount(1);
    await expect(analysisOutput).toBeVisible();
    const completedReverseBounds = await reverseNode.boundingBox();
    expect(completedReverseBounds).not.toBeNull();
    expect(completedReverseBounds!.height).toBeGreaterThanOrEqual(646);
    await captureSurface(page, testInfo, `reverse-agent-completed-${theme}`);
  });

  test(`keeps the reverse workbench and connects its completed analysis to a dedicated result in ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openEmptyApp(page);
    await page.locator('.theme-control select').selectOption(theme, { force: true });
    await page.evaluate(async () => {
      await window.__NOVUS_E2E__!.createModule('reverse_agent', { x: 300, y: 154 });
      await window.__NOVUS_E2E__!.createModule('reverse_result', { x: 760, y: 126 });
      await window.__NOVUS_E2E__!.configureModule('reverse_agent', {
        config: {
          modelRoute: 'comfly-gpt-5-6-sol',
          role: 'Commercial visual analyst',
          task: 'Analyze the connected reference.',
          knowledgeBaseIds: [],
          reverseAgentResult: { positivePrompt: 'Structured reverse analysis from the dedicated result workflow.' },
          resultState: 'fresh',
        },
        execution: { state: 'completed' },
      });
    });

    const reverse = page.locator('[data-module-type="reverse_agent"]');
    const result = page.locator('[data-module-type="reverse_result"]');
    const source = reverse.locator('[data-port-id="analysis"].react-flow__handle');
    const target = result.locator('[data-port-id="analysis"][data-port-direction="input"].react-flow__handle');
    await expect(source).toBeVisible();
    await expect(target).toBeVisible();
    const [reverseBox, resultBox, sourceBox, targetBox] = await Promise.all([
      reverse.boundingBox(),
      result.boundingBox(),
      source.boundingBox(),
      target.boundingBox(),
    ]);
    expect(reverseBox).not.toBeNull();
    expect(resultBox).not.toBeNull();
    expect(sourceBox).not.toBeNull();
    expect(targetBox).not.toBeNull();
    expect(Math.abs((sourceBox!.x + sourceBox!.width / 2) - (reverseBox!.x + reverseBox!.width))).toBeLessThanOrEqual(1.5);
    expect(Math.abs((targetBox!.x + targetBox!.width / 2) - resultBox!.x)).toBeLessThanOrEqual(1);
    await source.dragTo(target);
    await expect.poll(async () => page.locator('.react-flow__edge').count()).toBe(1);
    await expect(source).toHaveAttribute('data-port-connected', 'true');
    await expect(target).toHaveAttribute('data-port-connected', 'true');
    await expect(result.locator('[data-port-id="analysis"][data-port-direction="output"].react-flow__handle')).not.toHaveAttribute('data-port-connected');
    await expect(reverse.getByRole('textbox', { name: 'Role positioning' })).toBeVisible();
    await expect(reverse.getByRole('textbox', { name: 'Analysis task' })).toBeVisible();
    await expect(result.getByLabel('Reverse analysis result')).toContainText('Structured reverse analysis from the dedicated result workflow.');
    await expect(result).toHaveCSS('width', '520px');
    await expect(result).toHaveCSS('height', '648px');
    await captureSurface(page, testInfo, `reverse-agent-dedicated-result-${theme}`);
  });

  test(`captures the result action menu in ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript((nextTheme) => localStorage.setItem('novus.theme.mode', nextTheme), theme);
    await openEmptyApp(page);
    const seeded = await page.evaluate(async () => {
      await window.__NOVUS_E2E__.createModule('image_generation', { x: 100, y: 112 });
      return await window.__NOVUS_E2E__.seedGeneratedImageResult?.() ?? false;
    });
    expect(seeded).toBe(true);
    const generation = page.locator('[data-module-type="image_generation"]');
    await generation.getByRole('button', { name: 'Open image generation editor' }).click();
    await generation.getByRole('button', { name: 'Generated image 1; double click to preview' }).click({ button: 'right' });
    await expect(page.getByRole('menu', { name: 'Generated image actions' })).toBeVisible();
    await captureSurface(page, testInfo, `result-action-menu-${theme}`);
  });
}
