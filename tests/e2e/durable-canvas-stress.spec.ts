import { writeFile } from 'node:fs/promises';
import { test, expect } from './helpers/e2e-test';
import type { CDPSession, Page } from '@playwright/test';
import {
  captureLayoutScreenshot,
  e2eState,
  finishInteractionStallObserver,
  measureCanvasFrameGaps,
  measureInteractionStalls,
  openAgentPanel,
  openApp,
  startInteractionStallObserver,
} from './helpers/app';

type CpuProfileNode = {
  callFrame: { functionName?: string; lineNumber: number; url: string };
  children?: number[];
  id: number;
};

type TransactionSnapshot = { recentTransactionLabels: Array<{ id: string; label: string }> };

function newCanvasMutations(before: TransactionSnapshot, after: TransactionSnapshot) {
  const previousIds = new Set(before.recentTransactionLabels.map(({ id }) => id));
  return after.recentTransactionLabels.filter((transaction) => (
    !previousIds.has(transaction.id) && transaction.label !== 'Persist current project draft'
  ));
}

async function startCpuProfile(page: Page): Promise<CDPSession | null> {
  if (process.env.CANVAS_CAPTURE_CPU_PROFILE !== '1') return null;
  const session = await page.context().newCDPSession(page);
  await session.send('Profiler.enable');
  await session.send('Profiler.setSamplingInterval', { interval: 500 });
  await session.send('Profiler.start');
  return session;
}

async function stopCpuProfile(session: CDPSession | null) {
  if (!session) return null;
  const result = await session.send('Profiler.stop') as { profile: { nodes: CpuProfileNode[]; samples?: number[]; timeDeltas?: number[] } };
  const parents = new Map<number, number>();
  const nodes = new Map(result.profile.nodes.map((node) => [node.id, node]));
  for (const node of result.profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id);
  const stacks = new Map<string, { sampleCount: number; timeUs: number }>();
  const selfTime = new Map<string, { sampleCount: number; timeUs: number }>();
  for (const [index, sampleId] of (result.profile.samples ?? []).entries()) {
    const frames: string[] = [];
    let current: number | undefined = sampleId;
    while (current !== undefined && frames.length < 9) {
      const node = nodes.get(current);
      if (!node) break;
      frames.unshift(`${node.callFrame.functionName || '(anonymous)'}@${node.callFrame.url}:${node.callFrame.lineNumber + 1}`);
      current = parents.get(current);
    }
    const key = frames.join(' > ');
    const currentStack = stacks.get(key) ?? { sampleCount: 0, timeUs: 0 };
    currentStack.sampleCount += 1;
    currentStack.timeUs += result.profile.timeDeltas?.[index] ?? 0;
    stacks.set(key, currentStack);
    const leaf = nodes.get(sampleId);
    if (leaf) {
      const leafKey = `${leaf.callFrame.functionName || '(anonymous)'}@${leaf.callFrame.url}:${leaf.callFrame.lineNumber + 1}`;
      const currentLeaf = selfTime.get(leafKey) ?? { sampleCount: 0, timeUs: 0 };
      currentLeaf.sampleCount += 1;
      currentLeaf.timeUs += result.profile.timeDeltas?.[index] ?? 0;
      selfTime.set(leafKey, currentLeaf);
    }
  }
  await session.send('Profiler.disable');
  await session.detach();
  const hottestStacks = [...stacks.entries()].map(([stack, value]) => ({ stack, ...value }))
    .sort((left, right) => right.timeUs - left.timeUs).slice(0, 15);
  const hottestFunctions = [...selfTime.entries()].map(([functionName, value]) => ({ stack: `[SELF] ${functionName}`, ...value }))
    .sort((left, right) => right.timeUs - left.timeUs).slice(0, 15);
  return [...hottestStacks, ...hottestFunctions];
}

async function startPerformanceTrace(page: Page): Promise<CDPSession | null> {
  if (process.env.CANVAS_CAPTURE_TRACE !== '1') return null;
  const session = await page.context().newCDPSession(page);
  await session.send('Tracing.start', {
    categories: 'devtools.timeline,disabled-by-default-devtools.timeline,blink.user_timing,v8',
    transferMode: 'ReturnAsStream',
  });
  return session;
}

async function stopPerformanceTrace(session: CDPSession | null): Promise<string | null> {
  if (!session) return null;
  const finished = new Promise<{ stream?: string }>((resolve) => {
    session.once('Tracing.tracingComplete', (event: { stream?: string }) => resolve(event));
  });
  await session.send('Tracing.end');
  const { stream } = await finished;
  if (!stream) {
    await session.detach();
    return null;
  }
  let trace = '';
  let eof = false;
  while (!eof) {
    const chunk = await session.send('IO.read', { handle: stream }) as { data?: string; eof: boolean };
    trace += chunk.data ?? '';
    eof = chunk.eof;
  }
  await session.send('IO.close', { handle: stream });
  await session.detach();
  return trace;
}

const viewports = [
  { name: '1366x768', width: 1366, height: 768 },
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1920x1080', width: 1920, height: 1080 },
];

for (const theme of ['light', 'dark'] as const) {
  for (const viewport of viewports) {
    test(`durable 300/500 canvas stays responsive at ${viewport.name} ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      await page.addInitScript((nextTheme) => localStorage.setItem('novus.theme.mode', nextTheme), theme);
      await openApp(page);
      await page.getByTestId('tool-modules').click();

      expect(await page.evaluate(() => window.__NOVUS_E2E__!.seedModuleStressGraph(300, 500))).toBe(true);
      // The durable graph has 299 draggable module cards plus one placement-workbench data node.
      await expect(page.getByTestId('canvas-stage')).toHaveAttribute('data-graph-node-count', '299');
      await expect(page.getByTestId('canvas-stage')).toHaveAttribute('data-graph-edge-count', '500');
      const graph = await e2eState(page);
      expect(graph.nodeCount).toBe(300);
      expect(graph.edgeCount).toBe(500);
      expect(graph.projectImages).toHaveLength(80);
      const renderedNodeCount = await page.locator('.react-flow__node').count();
      expect(renderedNodeCount).toBeLessThan(50);

      await expect(page.getByTestId('agent-panel')).toBeHidden();
      await expect(page.getByTestId('module-library')).toBeVisible();
      await expect(page.locator('.react-flow__node')).not.toHaveCount(0);
      const portLabel = page.locator('.module-node__port-label').first();
      await expect(portLabel).toHaveCount(1);
      expect((await portLabel.getAttribute('title') ?? '').trim().length).toBeGreaterThan(0);
      await expect(page.getByText('IMG', { exact: true })).toHaveCount(0);
      // Floating surfaces are mutually exclusive. Validate the library first,
      // close it, and only then open Agent so performance checks target canvas.
      await page.getByTestId('tool-modules').click();
      await expect(page.getByTestId('module-library')).toBeHidden();
      await openAgentPanel(page);
      await expect(page.getByTestId('agent-panel')).toBeVisible();
      // Keep the conversation mounted so its parent/context can still update,
      // while making the canvas itself unobstructed for pointer and wheel input.
      await page.getByTestId('agent-toggle').click();
      await expect(page.getByTestId('agent-panel')).toBeHidden();
      console.log(`CANVAS_FOCUS ${JSON.stringify(await page.evaluate(() => ({
        activeTag: document.activeElement?.tagName ?? null,
        activeTestId: document.activeElement?.getAttribute('data-testid') ?? null,
        activeContentEditable: document.activeElement?.getAttribute('contenteditable') ?? null,
        activeInsideAgent: document.activeElement?.closest('[data-testid="agent-panel"]') !== null,
        activeInsideComposer: document.activeElement?.closest('.media-mention-textarea') !== null,
        hiddenAgentComposers: document.querySelectorAll('[data-testid="agent-panel"] .media-mention-textarea').length,
      })))}`);

      await page.waitForFunction(() => window.__NOVUS_E2E__?.getState().saveStatus === 'saved', undefined, { timeout: 10_000 });
      await startInteractionStallObserver(page);
      // Seed commits can schedule one final idle-draft write. Let that startup
      // transaction settle before measuring gesture-only durability.
      let previousCommitCount = -1;
      let commitCount = graph.commitCount;
      for (let attempt = 0; attempt < 4 && commitCount !== previousCommitCount; attempt += 1) {
        previousCommitCount = commitCount;
        await page.waitForTimeout(250);
        commitCount = (await e2eState(page)).commitCount;
      }
      const frameGaps = [];
      let zoomCpuProfile: Awaited<ReturnType<typeof stopCpuProfile>> = null;
      let dragCpuProfile: Awaited<ReturnType<typeof stopCpuProfile>> = null;
      // The Canvas shell keeps the 56px top bar above the canvas. Use a stress
      // node from the second canvas row so pointer-based interaction is not
      // hidden beneath that chrome while preserving the same node contract.
      const node = page.locator('.react-flow__node[data-id="stress-image_input-20"]');
      await expect(node).toBeVisible();
      const beforeSelection = await e2eState(page);
      await measureInteractionStalls(page, 'selection', async () => {
        await node.click({ position: { x: 180, y: 24 } });
      });
      const afterSelectionState = await e2eState(page);
      expect(newCanvasMutations(beforeSelection, afterSelectionState), `durable transactions during selection: ${JSON.stringify(afterSelectionState.recentTransactionLabels)}`).toEqual([]);

      const beforeDrag = await e2eState(page);
      await measureInteractionStalls(page, 'drag-drop', async () => {
        const profileSession = await startCpuProfile(page);
        frameGaps.push(await measureCanvasFrameGaps(page, '10-direction-changes-in-one-drag', async () => {
          const box = await node.boundingBox();
          expect(box).not.toBeNull();
          const originX = box!.x + 180;
          const originY = box!.y + 24;
          await page.mouse.move(originX, originY);
          await page.mouse.down();
          for (let index = 0; index < 10; index += 1) {
            const direction = index % 2 === 0 ? 1 : -1;
            await page.mouse.move(originX + direction * 28, originY + (index % 3 === 0 ? 8 : -8), { steps: 3 });
          }
          const duringDragState = await e2eState(page);
          expect(newCanvasMutations(beforeDrag, duringDragState), `durable transactions during pointer drag: ${JSON.stringify(duringDragState.recentTransactionLabels)}`).toEqual([]);
          await page.mouse.up();
        }));
        dragCpuProfile = await stopCpuProfile(profileSession);
      });
      await page.waitForFunction((previousIds) => window.__NOVUS_E2E__!.getState().recentTransactionLabels.some(({ id, label }) => (
        !previousIds.includes(id) && label === 'Move 1 canvas node'
      )), beforeDrag.recentTransactionLabels.map(({ id }) => id));
      // Position persistence schedules one idle draft flush after the direct
      // drag transaction. The production autosave idle window is 750ms, so
      // wait past it before measuring the next gesture.
      await page.waitForTimeout(800);
      await page.waitForFunction(() => window.__NOVUS_E2E__?.getState().saveStatus === 'saved', undefined, { timeout: 10_000 });

      const pane = page.locator('.react-flow__pane');
      const beforePan = await e2eState(page);
      await measureInteractionStalls(page, 'pan', async () => {
        frameGaps.push(await measureCanvasFrameGaps(page, '10-direction-changes-in-one-pan', async () => {
          const box = await pane.boundingBox();
          expect(box).not.toBeNull();
          const originX = box!.x + box!.width * 0.55;
          const originY = box!.y + box!.height * 0.55;
          await page.mouse.move(originX, originY);
          await page.mouse.down({ button: 'middle' });
          for (let index = 0; index < 10; index += 1) {
            const direction = index % 2 === 0 ? 1 : -1;
            await page.mouse.move(originX + direction * 32, originY + direction * 18, { steps: 3 });
          }
          await page.mouse.up({ button: 'middle' });
        }));
      });
      const afterPanState = await e2eState(page);
      expect(newCanvasMutations(beforePan, afterPanState), `durable transactions during pan: ${JSON.stringify(afterPanState.recentTransactionLabels)}`).toEqual([]);

      // Finding an unobstructed point is test setup, not part of the user's
      // zoom interaction, so keep the DOM scan outside the measured window.
      const zoomPoint = await page.evaluate(() => {
        const paneElement = document.querySelector<HTMLElement>('.react-flow__pane');
        if (!paneElement) return null;
        const rect = paneElement.getBoundingClientRect();
        for (let x = rect.left + 24; x < rect.right - 24; x += 24) {
          for (let y = rect.top + 24; y < rect.bottom - 24; y += 24) {
            const target = document.elementFromPoint(x, y);
            if (target?.closest('.react-flow__pane')
              && !target.closest('.nowheel')
              && !target.closest('[data-testid="agent-panel"]')) return { x, y };
          }
        }
        return null;
      });
      expect(zoomPoint, 'zoom must target an uncovered React Flow pane region').not.toBeNull();
      await page.mouse.move(zoomPoint!.x, zoomPoint!.y);
      await page.evaluate(() => performance.clearMarks('novus-pan-zoom-frame'));
      const beforeZoom = await e2eState(page);
      const zoomRenderCounts: Array<{
        renderedNodes: number;
        renderedEdges: number;
        minimapNodes: number;
        fullDetailNodes: number;
        overviewNodes: number;
      }> = [];
      const traceSession = await startPerformanceTrace(page);

      await measureInteractionStalls(page, 'zoom', async () => {
        frameGaps.push(await measureCanvasFrameGaps(page, '10-wheel-zooms-in-and-out', async () => {
          const profileSession = await startCpuProfile(page);
          const readViewportStyle = () => page.evaluate(() => document.querySelector<HTMLElement>('.react-flow__viewport')?.getAttribute('style') ?? null);
          const beforeZoomIn = await readViewportStyle();
          for (let index = 0; index < 10; index += 1) {
            await page.mouse.wheel(0, -120);
            await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
            if (index === 0) {
              const minimapPresent = await page.evaluate(() => document.querySelector('.react-flow__minimap') !== null);
              expect(minimapPresent, 'large-canvas minimap should pause rendering during active viewport interaction').toBe(false);
            }
          }
          await page.waitForFunction((previous) => document.querySelector<HTMLElement>('.react-flow__viewport')?.getAttribute('style') !== previous, beforeZoomIn);
          const afterZoomIn = await readViewportStyle();
          zoomRenderCounts.push(await page.evaluate(() => ({
            renderedNodes: document.querySelectorAll('.react-flow__node').length,
            renderedEdges: document.querySelectorAll('.react-flow__edge').length,
            minimapNodes: document.querySelectorAll('.react-flow__minimap-node').length,
            fullDetailNodes: document.querySelectorAll('.module-node[data-render-detail="full"]').length,
            overviewNodes: document.querySelectorAll('.module-node[data-render-detail="overview"]').length,
          })));
          for (let index = 0; index < 10; index += 1) {
            await page.mouse.wheel(0, 120);
            await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
          }
          await page.waitForFunction((previous) => document.querySelector<HTMLElement>('.react-flow__viewport')?.getAttribute('style') !== previous, afterZoomIn);
          zoomRenderCounts.push(await page.evaluate(() => ({
            renderedNodes: document.querySelectorAll('.react-flow__node').length,
            renderedEdges: document.querySelectorAll('.react-flow__edge').length,
            minimapNodes: document.querySelectorAll('.react-flow__minimap-node').length,
            fullDetailNodes: document.querySelectorAll('.module-node[data-render-detail="full"]').length,
            overviewNodes: document.querySelectorAll('.module-node[data-render-detail="overview"]').length,
          })));
          zoomCpuProfile = await stopCpuProfile(profileSession);
        }));
      });
      const performanceTrace = await stopPerformanceTrace(traceSession);
      if (performanceTrace !== null) {
        const tracePath = testInfo.outputPath(`zoom-performance-trace-${viewport.name}-${theme}.json`);
        await writeFile(tracePath, performanceTrace, 'utf8');
        await testInfo.attach(`zoom-performance-trace-${viewport.name}-${theme}.json`, {
          path: tracePath,
          contentType: 'application/json',
        });
        console.log(`ZOOM_PERFORMANCE_TRACE_PATH ${tracePath}`);
      }
      const zoomViewportActivity = await page.evaluate(() => {
        const timestamps = performance.getEntriesByName('novus-pan-zoom-frame').map((entry) => entry.startTime);
        const intervals = timestamps.slice(1).map((timestamp, index) => timestamp - timestamps[index]!);
        return {
          callbackCount: timestamps.length,
          intervalsOver120ms: intervals.filter((interval) => interval > 120).length,
          maximumIntervalMs: Math.max(0, ...intervals),
          intervals: intervals.map((interval) => Math.round(interval * 10) / 10),
        };
      });
      console.log(`ZOOM_VIEWPORT_ACTIVITY ${JSON.stringify(zoomViewportActivity)}`);
      console.log(`ZOOM_RENDER_COUNTS ${JSON.stringify(zoomRenderCounts)}`);
      if (graph.nodeCount > 100) {
        const overview = zoomRenderCounts[zoomRenderCounts.length - 1];
        expect(overview?.overviewNodes, 'zoomed-out large canvases keep visible nodes in lightweight overview mode').toBeGreaterThan(0);
        expect(overview?.fullDetailNodes, 'zoomed-out large canvases avoid mounting dozens of full workbenches').toBeLessThan(50);
      }
      const afterZoomState = await e2eState(page);
      expect(newCanvasMutations(beforeZoom, afterZoomState), `durable transactions during zoom: ${JSON.stringify(afterZoomState.recentTransactionLabels)}`).toEqual([]);
      await page.waitForTimeout(450);
      await expect(page.getByTestId('rf__minimap')).toHaveCount(0);
      await expect(page.getByRole('button', { name: '显示大型画布导航地图' })).toBeVisible();

      const beforeConnection = await e2eState(page);
      await measureInteractionStalls(page, 'connection-preview', async () => {
        const handle = node.locator('.react-flow__handle.source').first();
        const handleBox = await handle.boundingBox();
        const paneBox = await pane.boundingBox();
        expect(handleBox).not.toBeNull();
        expect(paneBox).not.toBeNull();
        await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2);
        await page.mouse.down();
        await page.mouse.move(paneBox!.x + paneBox!.width * 0.5, paneBox!.y + paneBox!.height * 0.35, { steps: 5 });
        expect(handleBox!.width).toBeGreaterThan(0);
        expect(newCanvasMutations(beforeConnection, await e2eState(page))).toEqual([]);
        await page.keyboard.press('Escape');
        await page.mouse.up();
      });
      await expect(page.locator('.react-flow__connection')).toHaveCount(0);
      const afterConnection = await e2eState(page);
      expect(newCanvasMutations(beforeConnection, afterConnection), `durable transactions during connection preview: ${JSON.stringify(afterConnection.recentTransactionLabels)}`).toEqual([]);
      // Escape belongs to the active connector gesture. It must not also
      // collapse the Agent surface and force the whole workspace to rerender.
      await openAgentPanel(page);
      await expect(page.getByTestId('agent-panel')).toBeVisible();


      const evidence = await finishInteractionStallObserver(page, {
        edgeCount: 500,
        nodeCount: 300,
        theme,
        viewport: viewport.name,
      });
      await testInfo.attach(`stress-evidence-${viewport.name}-${theme}.json`, {
        body: JSON.stringify(evidence, null, 2),
        contentType: 'application/json',
      });
      console.log(`STRESS_EVIDENCE ${JSON.stringify(evidence)}`);
      expect(evidence).toHaveLength(5);
      for (const sample of evidence) {
        expect(sample.measurementSupported, `${sample.operation} observer support`).toBe(true);
        expect(sample.observerTypes.length, `${sample.operation} observer types`).toBeGreaterThan(0);
        expect(sample.sampleCount, `${sample.operation} sample count`).toBeGreaterThanOrEqual(0);
        expect(sample.zeroSample, `${sample.operation} zero-sample identity`).toBe(sample.sampleCount === 0);
      }
      await testInfo.attach(`frame-gaps-${viewport.name}-${theme}.json`, {
        body: JSON.stringify(frameGaps, null, 2),
        contentType: 'application/json',
      });
      console.log(`FRAME_GAP_EVIDENCE ${JSON.stringify(frameGaps)}`);
      for (const sample of frameGaps) expect(sample.frameCount, `${sample.operation} must produce real animation-frame samples`).toBeGreaterThan(0);
      if (process.env.CANVAS_PERF_DIAGNOSTIC !== '1') {
        for (const sample of evidence) {
          expect(sample.maxStallOverlapMs, `${sample.operation} stall overlap (${sample.maxStallMs}ms full entry, starts ${sample.maxStallStartOffsetMs}ms from window)`).toBeLessThan(250);
        }
        for (const sample of frameGaps) expect(sample.maxFrameGapMs, `${sample.operation} maximum visible frame gap`).toBeLessThan(250);
      }
      if (dragCpuProfile !== null) {
        await testInfo.attach(`drag-cpu-profile-${viewport.name}-${theme}.json`, {
          body: JSON.stringify(dragCpuProfile, null, 2),
          contentType: 'application/json',
        });
        console.log(`DRAG_CPU_PROFILE ${JSON.stringify(dragCpuProfile)}`);
      }
      if (zoomCpuProfile !== null) {
        await testInfo.attach(`zoom-cpu-profile-${viewport.name}-${theme}.json`, {
          body: JSON.stringify(zoomCpuProfile, null, 2),
          contentType: 'application/json',
        });
        console.log(`ZOOM_CPU_PROFILE ${JSON.stringify(zoomCpuProfile)}`);
      }
      await captureLayoutScreenshot(page, testInfo, `durable-canvas-stress-${viewport.name}-${theme}`);
    });
  }
}
