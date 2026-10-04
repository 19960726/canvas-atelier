import { getCanvasModuleDefinition, type CanvasMcpRequest, type CanvasMcpResponse, type CanvasModulePortDefinition, type CanvasModuleType } from '@agent-canvas/domain';
import type { Page, TestInfo } from '@playwright/test';
import { expect, test } from './helpers/e2e-test';
import { e2eState, openEmptyApp } from './helpers/app';

// This gate proves typed graph editing and mounted connection endpoints. Empty
// source nodes are valid editor structures; no provider execution or generated
// layer/image/video quality is claimed by this test.
type AliasExpectation = { moduleType: CanvasModuleType; direction: 'input' | 'output'; aliasId: string; mainId: string };
type TypedPair = { sourceType: CanvasModuleType; sourcePortId: string; targetType: CanvasModuleType; targetPortId: string };
type Workflow = { revision: number; nodes: Array<{ id: string; moduleType: CanvasModuleType }>; edges: Array<{ id: string; sourceNodeId: string; sourcePortId: string; targetNodeId: string; targetPortId: string }> };

const aliases: AliasExpectation[] = [
  ...['prompt', 'mask', 'pose'].map(aliasId => ({ moduleType: 'image_generation' as const, direction: 'input' as const, aliasId, mainId: 'references' })),
  { moduleType: 'image_generation', direction: 'output', aliasId: 'image', mainId: 'result' },
  ...['prompt', 'sourceVideo', 'firstFrame', 'lastFrame'].map(aliasId => ({ moduleType: 'video_generation' as const, direction: 'input' as const, aliasId, mainId: 'media' })),
  ...['video', 'task', 'line_art'].map(aliasId => ({ moduleType: 'reverse_agent' as const, direction: 'input' as const, aliasId, mainId: 'references' })),
  { moduleType: 'reverse_agent', direction: 'output', aliasId: 'timeline', mainId: 'analysis' },
  { moduleType: 'image_layering', direction: 'input', aliasId: 'layerImages', mainId: 'image' },
];

function compatibleOutput(target: CanvasModulePortDefinition, source: CanvasModulePortDefinition) {
  return source.direction === 'output' && (source.dataType === target.dataType
    || source.dataType === 'image_asset' && target.dataType === 'image_list'
    || source.dataType === 'video_asset' && target.dataType === 'video_ranges'
    || target.dataType === 'media_asset' && ['image_asset', 'video_asset'].includes(source.dataType));
}

// Choose real registered source ports by their actual data types. If a future
// catalog removes every matching source, keep the Handle assertion but do not
// fabricate an output type or an edge to make the gate pass.
const pairs = aliases.flatMap(alias => {
  const definition = getCanvasModuleDefinition(alias.moduleType);
  const actualPort = definition.ports.find(port => port.id === alias.aliasId && port.direction === alias.direction);
  if (!actualPort) throw new Error(`Typed alias is not a real registered port: ${alias.moduleType}.${alias.aliasId}`);
  if (alias.direction === 'output') {
    const targetType = alias.aliasId === 'timeline' ? 'storyboard_sheet' : 'image_editor';
    const target = getCanvasModuleDefinition(targetType).ports.find(port => port.direction === 'input' && port.dataType === actualPort.dataType);
    return target ? [{ sourceType: alias.moduleType, sourcePortId: actualPort.id, targetType, targetPortId: target.id } satisfies TypedPair] : [];
  }
  const candidates: CanvasModuleType[] = alias.moduleType === 'image_layering'
    ? ['image_layer'] : ['text_prompt', 'drawing_mask', 'openpose', 'image_input', 'video_input'];
  for (const sourceType of candidates) {
    const source = getCanvasModuleDefinition(sourceType).ports.find(port => compatibleOutput(actualPort, port));
    if (source) return [{ sourceType, sourcePortId: source.id, targetType: alias.moduleType, targetPortId: actualPort.id } satisfies TypedPair];
  }
  return [];
});

const positions: Partial<Record<CanvasModuleType, { x: number; y: number }>> = {
  drawing_mask: { x: 130, y: 150 }, openpose: { x: 130, y: 710 },
  text_prompt: { x: 130, y: 1130 }, image_input: { x: 130, y: 1680 }, video_input: { x: 130, y: 2280 },
  image_generation: { x: 800, y: 150 }, video_generation: { x: 1710, y: 150 },
  reverse_agent: { x: 2630, y: 150 }, image_layering: { x: 3520, y: 150 },
  image_editor: { x: 800, y: 1530 }, image_layer: { x: 2630, y: 1530 }, storyboard_sheet: { x: 3520, y: 1530 },
};

async function invokeMcp<T>(page: Page, request: CanvasMcpRequest): Promise<T> {
  const response = await page.evaluate(async request => {
    const harness = window.__NOVUS_E2E__ as unknown as { invokeMcp(request: CanvasMcpRequest): Promise<CanvasMcpResponse> };
    return harness.invokeMcp(request);
  }, request);
  expect(response.ok, `Actual App MCP operation ${request.tool}: ${JSON.stringify(response)}`).toBe(true);
  if (!response.ok) throw new Error(JSON.stringify(response.error));
  return response.result as T;
}

const nodeFor = (page: Page, nodeId: string) => page.locator(`.react-flow__node[data-id="${nodeId}"] [data-testid="module-node-card"]`);
const readWorkflow = (page: Page) => invokeMcp<Workflow>(page, { tool: 'canvas_read_workflow' });
const nextPaint = (page: Page) => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
const zoom = (page: Page) => page.locator('.react-flow__viewport').evaluate(element => new DOMMatrixReadOnly(getComputedStyle(element).transform).a);

async function measureEndpoints(page: Page, nodeIds: Partial<Record<CanvasModuleType, string>>) {
  return page.evaluate(({ aliases, nodeIds }) => aliases.map(alias => {
    const card = document.querySelector(`.react-flow__node[data-id="${nodeIds[alias.moduleType]}"] [data-testid="module-node-card"]`);
    const selector = (id: string) => `.react-flow__handle[data-port-direction="${alias.direction}"][data-port-id="${id}"]`;
    const handle = card?.querySelector(selector(alias.aliasId));
    const main = card?.querySelector(selector(alias.mainId));
    const bounds = (element: Element | null | undefined) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      const css = getComputedStyle(element);
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, centerX: rect.x + rect.width / 2, centerY: rect.y + rect.height / 2,
        display: css.display, visibility: css.visibility, opacity: css.opacity, pointerEvents: css.pointerEvents,
        connected: element.getAttribute('data-port-connected'), type: element.getAttribute('data-port-type'),
        alias: element.getAttribute('data-visual-alias'), ariaHidden: element.getAttribute('aria-hidden') };
    };
    return { ...alias, detail: card?.getAttribute('data-render-detail'), handle: bounds(handle), main: bounds(main),
      handleCount: card?.querySelectorAll(selector(alias.aliasId)).length ?? 0,
      visibleSocketCount: Array.from(card?.querySelectorAll('.react-flow__handle') ?? []).filter(element => {
        const css = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && css.display !== 'none' && css.visibility !== 'hidden' && Number(css.opacity) > 0;
      }).length };
  }), { aliases, nodeIds });
}

async function checkStage(page: Page, testInfo: TestInfo, stage: string, nodeIds: Partial<Record<CanvasModuleType, string>>, expectedEdges: Workflow['edges']) {
  await nextPaint(page);
  const metrics = await measureEndpoints(page, nodeIds);
  for (const metric of metrics) {
    const label = `${stage}: ${metric.moduleType}.${metric.direction}.${metric.aliasId}`;
    expect(metric.handleCount, label).toBe(1);
    expect(metric.handle, label).not.toBeNull(); expect(metric.main, label).not.toBeNull();
    const actual = metric.handle!, main = metric.main!;
    expect(actual.width, label).toBeGreaterThan(0); expect(actual.height, label).toBeGreaterThan(0);
    expect(main.width, label).toBeGreaterThan(0); expect(main.height, label).toBeGreaterThan(0);
    expect(actual.display, label).not.toBe('none'); expect(actual.visibility, label).not.toBe('hidden');
    expect(actual.opacity, label).toBe('0'); expect(actual.pointerEvents, label).toBe('none');
    expect(actual.alias, label).toBe('true'); expect(actual.ariaHidden, label).toBe('true');
    expect(Math.abs(actual.centerX - main.centerX), `${label} actual horizontal anchor`).toBeLessThanOrEqual(1);
    expect(Math.abs(actual.centerY - main.centerY), `${label} actual vertical anchor`).toBeLessThanOrEqual(1);
    expect(actual.type, `${label} preserves typed compatibility`).toBe(getCanvasModuleDefinition(metric.moduleType).ports.find(port => port.id === metric.aliasId && port.direction === metric.direction)!.dataType);
    expect(metric.visibleSocketCount, `${label} stays one visible input and output`).toBe(2);
    const usedByEdge = expectedEdges.some(edge => metric.direction === 'input'
      ? edge.targetNodeId === nodeIds[metric.moduleType] && edge.targetPortId === metric.aliasId
      : edge.sourceNodeId === nodeIds[metric.moduleType] && edge.sourcePortId === metric.aliasId);
    if (usedByEdge) expect(main.connected, `${label} connected alias lights the shared socket`).toBe('true');
  }
  const edgeMetrics = [];
  for (const edge of expectedEdges) {
    const path = page.locator(`[data-testid="rf__edge-${edge.id}"] .react-flow__edge-path`);
    await expect(path, `${stage}: ${edge.id}`).toHaveCount(1);
    await expect(path, `${stage}: ${edge.id}`).toHaveAttribute('d', /^M/u);
    await expect(path, `${stage}: ${edge.id}`).toBeVisible();
    const geometry = await path.evaluate((element: SVGPathElement) => {
      const length = element.getTotalLength(), start = element.getPointAtLength(0), end = element.getPointAtLength(length);
      return { length, start: { x: start.x, y: start.y }, end: { x: end.x, y: end.y }, d: element.getAttribute('d') };
    });
    expect(geometry.length, `${stage}: ${edge.id} is an actual nonempty SVG curve`).toBeGreaterThan(0);
    expect([geometry.start.x, geometry.start.y, geometry.end.x, geometry.end.y].every(Number.isFinite)).toBe(true);
    edgeMetrics.push({ ...edge, geometry });
  }
  expect((await readWorkflow(page)).edges, `${stage} retains exact durable typed port IDs`).toEqual(expectedEdges);
  const state = await e2eState(page);
  expect(state.modelSubmissions, `${stage} paid/model submissions`).toHaveLength(0);
  expect(state.modelJobs, `${stage} generated jobs`).toHaveLength(0);
  expect(state.reverseAnalysisRequests, `${stage} provider analyses`).toHaveLength(0);
  await testInfo.attach(`typed-endpoints-${stage}`, { body: JSON.stringify({ stage, metrics, edgeMetrics, providerExecutionVerified: false }, null, 2), contentType: 'application/json' });
  await page.screenshot({ path: testInfo.outputPath(`typed-endpoints-${stage}.png`) });
}

for (const theme of ['light', 'dark'] as const) {
  test(`typed hidden endpoints retain real edges without extra sockets in ${theme}`, async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const warnings: string[] = [];
    page.on('console', message => { if (/Couldn't create edge|reactflow\.dev\/error#008/iu.test(message.text())) warnings.push(message.text()); });
    page.on('pageerror', error => warnings.push(error.message));
    await page.setViewportSize({ width: 4300, height: 2900 });
    await page.addInitScript(mode => {
      localStorage.setItem('novus.theme.mode', mode);
      localStorage.setItem('agent-canvas:mcp-permissions:v1', JSON.stringify({ readCanvas: true, editCanvas: true, executeAiGeneration: false,
        exportFiles: false, externalFileAccess: false, dangerousOperations: false, manageCanvas: false }));
    }, theme);
    await openEmptyApp(page);
    const nodeIds: Partial<Record<CanvasModuleType, string>> = {};
    const requiredTypes = new Set<CanvasModuleType>([...aliases.map(alias => alias.moduleType), ...pairs.flatMap(pair => [pair.sourceType, pair.targetType])]);
    for (const moduleType of requiredTypes) {
      const before = await readWorkflow(page);
      expect(positions[moduleType], `Actual fixture placement for ${moduleType}`).toBeDefined();
      const created = await invokeMcp<{ applied: boolean; revision: number; nodeId: string }>(page, {
        tool: 'canvas_create_node', expectedRevision: before.revision, moduleType, position: positions[moduleType]!,
      });
      expect(created.applied).toBe(true); expect(created.revision).toBe(before.revision + 1);
      nodeIds[moduleType] = created.nodeId;
      await expect(nodeFor(page, created.nodeId)).toBeVisible();
    }
    for (const pair of pairs) {
      const before = await readWorkflow(page);
      const connected = await invokeMcp<{ applied: boolean; revision: number; edgeId: string }>(page, {
        tool: 'canvas_connect_nodes', expectedRevision: before.revision,
        sourceNodeId: nodeIds[pair.sourceType]!, sourcePortId: pair.sourcePortId,
        targetNodeId: nodeIds[pair.targetType]!, targetPortId: pair.targetPortId,
      });
      expect(connected.applied).toBe(true); expect(connected.revision).toBe(before.revision + 1);
      await expect(page.locator(`[data-testid="rf__edge-${connected.edgeId}"] .react-flow__edge-path`)).toHaveAttribute('d', /^M/u);
    }
    const workflow = await readWorkflow(page);
    expect(workflow.edges).toHaveLength(pairs.length);
    expect(aliases).toHaveLength(13);
    await checkStage(page, testInfo, `${theme}-collapsed`, nodeIds, workflow.edges);

    const image = nodeFor(page, nodeIds.image_generation!), video = nodeFor(page, nodeIds.video_generation!);
    await image.getByRole('button', { name: 'Open image generation editor' }).click();
    await expect(image.locator('.module-node__summary--generation')).toHaveAttribute('data-editor-expanded', 'true');
    await expect(image.getByRole('textbox', { name: 'Image generation prompt' })).toBeVisible();
    await checkStage(page, testInfo, `${theme}-image-expanded`, nodeIds, workflow.edges);
    await video.getByRole('button', { name: 'Open video generation editor' }).click();
    await expect(video.locator('.module-node__summary--generation')).toHaveAttribute('data-editor-expanded', 'true');
    await expect(video.getByRole('textbox', { name: 'Video preview prompt' })).toBeVisible();
    await checkStage(page, testInfo, `${theme}-video-expanded`, nodeIds, workflow.edges);

    // Use genuine canvas interactions to close and zoom; no store zoom edits,
    // injected CSS or forced clicks are used to manufacture measurable handles.
    await page.mouse.click(4220, 2800);
    await expect(video.locator('.module-node__summary--generation')).toHaveAttribute('data-editor-expanded', 'false');
    await page.mouse.move(4220, 2800);
    await page.mouse.wheel(0, 1000);
    await expect.poll(() => zoom(page)).toBeLessThan(0.45);
    for (const moduleType of requiredTypes) await expect(nodeFor(page, nodeIds[moduleType]!)).toHaveAttribute('data-render-detail', 'overview');
    await checkStage(page, testInfo, `${theme}-overview`, nodeIds, workflow.edges);
    await page.mouse.wheel(0, -1000);
    await expect.poll(() => zoom(page)).toBeGreaterThan(0.6);
    for (const moduleType of requiredTypes) await expect(nodeFor(page, nodeIds[moduleType]!)).toHaveAttribute('data-render-detail', 'full');
    await checkStage(page, testInfo, `${theme}-restored`, nodeIds, workflow.edges);

    await page.evaluate(() => window.__NOVUS_E2E__!.reopenProject());
    for (const moduleType of requiredTypes) await expect(nodeFor(page, nodeIds[moduleType]!)).toBeVisible();
    await checkStage(page, testInfo, `${theme}-reopened`, nodeIds, workflow.edges);
    await testInfo.attach('missing-handle-warnings', { body: JSON.stringify(warnings, null, 2), contentType: 'application/json' });
    expect(warnings, 'All real typed edge endpoints stay mounted through every presentation').toEqual([]);
  });
}
