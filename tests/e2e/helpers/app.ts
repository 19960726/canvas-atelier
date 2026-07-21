import type { Locator, Page, TestInfo } from '@playwright/test';
import { expect } from './e2e-test';
import type { GeneratedImageFixture } from './fixtures';
import type { CanvasModuleType } from '@agent-canvas/domain';

export interface PanZoomFrameMetrics {
  medianFrameMs: number;
  markCount: number;
}

export interface InteractionStallEvidence {
  edgeCount: number;
  maxStallMs: number;
  measurementSupported: boolean;
  nodeCount: number;
  observerTypes: string[];
  operation: string;
  sampleCount: number;
  theme: 'light' | 'dark';
  viewport: string;
  zeroSample: boolean;
}

type E2EState = {
  commitCount: number;
  durableProjectContainsTransientImageUrl: boolean;
  edgeCount: number;
  nodeCount: number;
  moduleTypes: CanvasModuleType[];
  modulePositions: Array<{
    id: string;
    moduleType: CanvasModuleType;
    position: { x: number; y: number };
  }>;
  modelJobs: Array<{
    conversationId: string;
    id: string;
    modelRoute: string;
    retryCount: number;
    status: string;
  }>;
  modelSubmissions: Array<{
    conversationId: string;
    id: string;
    modelRoute: string;
    retryCount: number;
  }>;
  projectAssetIds: string[];
  projectImages: Array<{
    assetId: string;
    displayUrl: string;
    label: string;
  }>;
  projectVideos: Array<{
    assetId: string;
    displayUrl: string;
    label: string;
  }>;
  projectNodeTypes: string[];
  skillSyncWrites: Array<{
    candidateId: string;
    decision: string;
    projectId: string;
  }>;
  undoDepth: number;
};

const previewDimensionsByPage = new WeakMap<Page, Array<{ height: number; width: number }>>();

export async function openApp(page: Page): Promise<void> {
  previewDimensionsByPage.set(page, []);
  await page.route('**/__novus_e2e_asset/*.svg', async (route) => {
    const assetSequence = Number.parseInt(route.request().url().match(/([a-f0-9]{16})\.svg$/u)?.[1] ?? '0', 16);
    const dimensions = previewDimensionsByPage.get(page)?.[assetSequence - 1] ?? { height: 120, width: 120 };
    await route.fulfill({
      body: `<svg xmlns="http://www.w3.org/2000/svg" width="${dimensions.width}" height="${dimensions.height}" viewBox="0 0 ${dimensions.width} ${dimensions.height}"><rect width="100%" height="100%" rx="8" fill="#dbeafe"/><path d="M${dimensions.width * 0.14} ${dimensions.height * 0.72} ${dimensions.width * 0.37} ${dimensions.height * 0.44}l${dimensions.width * 0.16} ${dimensions.height * 0.18} ${dimensions.width * 0.12}-${dimensions.height * 0.13} ${dimensions.width * 0.2} ${dimensions.height * 0.23}" fill="none" stroke="#2563eb" stroke-width="${Math.max(5, dimensions.width * 0.06)}" stroke-linecap="round" stroke-linejoin="round"/><circle cx="${dimensions.width * 0.7}" cy="${dimensions.height * 0.3}" r="${Math.min(dimensions.width, dimensions.height) * 0.09}" fill="#0f766e"/></svg>`,
      contentType: 'image/svg+xml',
      headers: { 'cache-control': 'no-store' },
      status: 200,
    });
  });
  await page.route('**/__novus_e2e_asset/*.mp4', async (route) => {
    const bytes = createE2EMp4Fixture();
    const range = route.request().headers().range?.match(/^bytes=(\d+)-(\d*)$/u);
    if (range) {
      const start = Number.parseInt(range[1]!, 10);
      const requestedEnd = range[2] ? Number.parseInt(range[2], 10) : bytes.length - 1;
      if (start >= bytes.length || requestedEnd < start) {
        await route.fulfill({ status: 416, headers: { 'content-range': `bytes */${bytes.length}` } });
        return;
      }
      const end = Math.min(requestedEnd, bytes.length - 1);
      await route.fulfill({
        body: bytes.subarray(start, end + 1),
        contentType: 'video/mp4',
        headers: {
          'accept-ranges': 'bytes',
          'cache-control': 'no-store',
          'content-range': `bytes ${start}-${end}/${bytes.length}`,
        },
        status: 206,
      });
      return;
    }
    await route.fulfill({
      body: bytes,
      contentType: 'video/mp4',
      headers: { 'accept-ranges': 'bytes', 'cache-control': 'no-store' },
      status: 200,
    });
  });
  await page.goto('/');
  await page.waitForFunction((nonce) => window.__NOVUS_E2E__?.nonce === nonce, process.env.NOVUS_E2E_NONCE);
  await page.evaluate(() => window.__NOVUS_E2E__!.reset());
  await expect(page.getByTestId('workspace')).toBeVisible();
}

export async function openEmptyApp(page: Page): Promise<void> {
  await openApp(page);
  await page.evaluate(() => window.__NOVUS_E2E__!.resetEmpty());
  await expect(page.getByRole('status').filter({ hasText: '双击空白处添加模块' })).toBeVisible();
}

export async function openAgentPanel(page: Page): Promise<void> {
  const panel = page.getByTestId('agent-panel');
  if (!(await panel.isVisible())) {
    await page.getByTestId('agent-toggle').click();
  }
  await expect(panel).toBeVisible();
}

export async function uploadReference(page: Page, testId: string, fixture: GeneratedImageFixture): Promise<void> {
  await queueProjectImageImport(page, fixture);
  await page.getByTestId(testId).click();
}

export async function queueProjectImageImport(page: Page, fixture: GeneratedImageFixture): Promise<void> {
  const dimensions = {
    height: clampE2EDimension(fixture.height),
    width: clampE2EDimension(fixture.width),
  };
  previewDimensionsByPage.get(page)?.push(dimensions);
  await page.evaluate(({ byteSize, height, label, mediaType, width }) => {
    window.__NOVUS_E2E__!.queueProjectImageImport({ byteSize, height, label, mediaType, width });
  }, {
    byteSize: fixture.buffer.byteLength,
    height: dimensions.height,
    label: fixture.name,
    mediaType: fixture.mimeType,
    width: dimensions.width,
  });
}

export async function queueProjectVideoImport(
  page: Page,
  input: { byteSize?: number; label: string },
): Promise<void> {
  await page.evaluate(({ byteSize, label }) => {
    window.__NOVUS_E2E__!.queueProjectVideoImport({ byteSize, label, mediaType: 'video/mp4' });
  }, {
    byteSize: input.byteSize ?? createE2EMp4Fixture().byteLength,
    label: input.label,
  });
}

function createE2EMp4Fixture(): Buffer {
  const box = (type: string, payload: Buffer) => {
    const result = Buffer.alloc(8 + payload.length);
    result.writeUInt32BE(result.length, 0);
    result.write(type, 4, 4, 'ascii');
    payload.copy(result, 8);
    return result;
  };
  const movieHeader = Buffer.alloc(100);
  movieHeader.writeUInt32BE(1_000, 12);
  return Buffer.concat([
    box('ftyp', Buffer.from([
      0x69, 0x73, 0x6f, 0x6d,
      0x00, 0x00, 0x02, 0x00,
      0x69, 0x73, 0x6f, 0x6d,
      0x6d, 0x70, 0x34, 0x31,
    ])),
    box('moov', Buffer.concat([
      box('mvhd', movieHeader),
      box('trak', box('tkhd', Buffer.alloc(4))),
    ])),
    box('mdat', Buffer.from([0, 0, 0, 0])),
  ]);
}

function clampE2EDimension(value: number): number {
  return Math.max(1, Math.min(8192, Math.floor(value)));
}

export async function e2eState(page: Page): Promise<E2EState> {
  return page.evaluate(() => window.__NOVUS_E2E__!.getState());
}

export async function seedSkillSyncDivergence(page: Page): Promise<void> {
  await page.evaluate(() => window.__NOVUS_E2E__!.seedSkillSyncDivergence());
}

export async function failNextModelJobEnqueue(page: Page): Promise<void> {
  await page.evaluate(() => window.__NOVUS_E2E__!.failNextModelJobEnqueue());
}

export async function waitForModelSubmissions(page: Page, count: number): Promise<E2EState> {
  await page.waitForFunction((expected) => window.__NOVUS_E2E__!.getState().modelSubmissions.length >= expected, count);
  return e2eState(page);
}

export async function assertNoTrackedRegionsOverlap(page: Page, testIds: string[]): Promise<void> {
  const boxes = await Promise.all(testIds.map(async (testId) => ({
    testId,
    box: await page.getByTestId(testId).boundingBox(),
  })));
  for (const { testId, box } of boxes) {
    expect(box, `${testId} should be visible and measurable`).not.toBeNull();
    expect(box!.width, `${testId} width`).toBeGreaterThan(0);
    expect(box!.height, `${testId} height`).toBeGreaterThan(0);
  }

  for (let leftIndex = 0; leftIndex < boxes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < boxes.length; rightIndex += 1) {
      const left = boxes[leftIndex]!;
      const right = boxes[rightIndex]!;
      const area = intersectionArea(left.box!, right.box!);
      expect(area, `${left.testId} overlaps ${right.testId}`).toBeLessThanOrEqual(1);
    }
  }
}

export async function assertLocatorInside(
  outer: Locator,
  inner: Locator,
  label: string,
  tolerance = 1,
): Promise<void> {
  await expect(outer, `${label} outer should be visible`).toBeVisible();
  await expect(inner, `${label} inner should be visible`).toBeVisible();
  const [outerBox, innerBox] = await Promise.all([
    outer.boundingBox(),
    inner.boundingBox(),
  ]);
  expect(outerBox, `${label} outer should be visible and measurable`).not.toBeNull();
  expect(innerBox, `${label} inner should be visible and measurable`).not.toBeNull();
  expect(innerBox!.x, `${label} left edge`).toBeGreaterThanOrEqual(outerBox!.x - tolerance);
  expect(innerBox!.y, `${label} top edge`).toBeGreaterThanOrEqual(outerBox!.y - tolerance);
  expect(innerBox!.x + innerBox!.width, `${label} right edge`).toBeLessThanOrEqual(
    outerBox!.x + outerBox!.width + tolerance,
  );
  expect(innerBox!.y + innerBox!.height, `${label} bottom edge`).toBeLessThanOrEqual(
    outerBox!.y + outerBox!.height + tolerance,
  );
}

export async function captureLayoutScreenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    fullPage: true,
    path: testInfo.outputPath(`${name}.png`),
  });
}

export async function medianPanZoomFrameInterval(page: Page): Promise<PanZoomFrameMetrics> {
  await page.evaluate(() => performance.clearMarks('novus-pan-zoom-frame'));
  const canvas = page.getByTestId('canvas-stage');
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  for (let index = 0; index < 12; index += 1) {
    await page.mouse.move(box!.x + box!.width / 2 + 12 + index * 4, box!.y + box!.height / 2 + 8, { steps: 2 });
  }
  await page.mouse.up();
  for (let index = 0; index < 6; index += 1) {
    await page.mouse.wheel(0, index % 2 === 0 ? -160 : 120);
  }
  await page.waitForFunction(
    () => performance.getEntriesByName('novus-pan-zoom-frame').length >= 4,
    undefined,
    { timeout: 3_000 },
  ).catch(() => undefined);

  const marks = await page.evaluate(() => performance.getEntriesByName('novus-pan-zoom-frame').map((entry) => entry.startTime));
  expect(marks.length).toBeGreaterThanOrEqual(4);
  const intervals = marks.slice(1).map((value, index) => value - marks[index]!);
  const sorted = intervals.filter((value) => value >= 0).sort((left, right) => left - right);
  return {
    medianFrameMs: sorted[Math.floor(sorted.length / 2)] ?? Number.POSITIVE_INFINITY,
    markCount: marks.length,
  };
}

export async function startInteractionStallObserver(page: Page): Promise<void> {
  await page.evaluate(() => {
    const previous = window.__NOVUS_STALL_OBSERVER__;
    previous?.observers.forEach((observer) => observer.disconnect());
    const state: NonNullable<typeof window.__NOVUS_STALL_OBSERVER__> = {
      entries: [],
      observers: [],
      observerTypes: [],
      windows: [],
    };
    const recordEntries = (entries: PerformanceEntry[]) => {
      for (const entry of entries) {
        state.entries.push({
          duration: entry.duration,
          entryType: entry.entryType,
          startTime: entry.startTime,
        });
      }
    };
    const record = (list: PerformanceObserverEntryList) => recordEntries(list.getEntries());
    try {
      const observer = new PerformanceObserver(record);
      observer.observe({ type: 'longtask', buffered: true });
      state.observers.push(observer);
      state.observerTypes.push('longtask');
    } catch {
      // Event Timing remains available on browser variants without Long Tasks.
    }
    try {
      const observer = new PerformanceObserver(record);
      observer.observe({ type: 'event', buffered: true, durationThreshold: 16 } as PerformanceObserverInit);
      state.observers.push(observer);
      state.observerTypes.push('event');
    } catch {
      // Long Tasks remain available on browser variants without Event Timing.
    }
    window.__NOVUS_STALL_OBSERVER__ = state;
  });
}

export async function measureInteractionStalls(
  page: Page,
  operation: string,
  action: () => Promise<void>,
): Promise<void> {
  const startTime = await page.evaluate(() => performance.now());
  await action();
  await page.evaluate(async ({ operationName, operationStart }) => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    window.__NOVUS_STALL_OBSERVER__?.windows.push({
      operation: operationName,
      startTime: operationStart,
      endTime: performance.now(),
    });
  }, { operationName: operation, operationStart: startTime });
}

export async function finishInteractionStallObserver(
  page: Page,
  graph: Pick<InteractionStallEvidence, 'edgeCount' | 'nodeCount' | 'theme' | 'viewport'>,
): Promise<InteractionStallEvidence[]> {
  const operations = await page.evaluate(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const state = window.__NOVUS_STALL_OBSERVER__;
    if (!state) return [];
    for (const observer of state.observers) {
      for (const entry of observer.takeRecords()) {
        state.entries.push({
          duration: entry.duration,
          entryType: entry.entryType,
          startTime: entry.startTime,
        });
      }
      observer.disconnect();
    }
    return state.windows.map((windowEntry) => {
      const durations = state.entries
        .filter((entry) => entry.startTime <= windowEntry.endTime
          && entry.startTime + entry.duration >= windowEntry.startTime)
        .map((entry) => entry.duration);
      return {
        maxStallMs: durations.length === 0 ? 0 : Math.max(...durations),
        measurementSupported: state.observerTypes.length > 0,
        observerTypes: [...state.observerTypes],
        operation: windowEntry.operation,
        sampleCount: durations.length,
        zeroSample: durations.length === 0,
      };
    });
  });
  return operations.map((operation) => ({ ...graph, ...operation }));
}

export async function expectVisibleMainRegion(page: Page): Promise<void> {
  await expect(page.getByTestId('canvas-stage')).toBeVisible();
  const visibleArea = await page.getByTestId('canvas-stage').evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const nodes = element.querySelectorAll('.react-flow__node').length;
    const background = getComputedStyle(element).backgroundColor;
    return { area: rect.width * rect.height, background, nodes };
  });
  expect(visibleArea.area).toBeGreaterThan(200_000);
  expect(visibleArea.nodes).toBeGreaterThan(2);
  expect(visibleArea.background).not.toBe('rgb(255, 255, 255)');
}

export async function dragPlacementObject(page: Page, locator: Locator): Promise<void> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2 + 32, box!.y + box!.height / 2 + 26, { steps: 6 });
}

function intersectionArea(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number },
): number {
  const x = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const y = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  return x * y;
}

declare global {
  interface Window {
    __NOVUS_E2E__?: {
      commitCount: number;
      connectModules(
        sourceType: CanvasModuleType,
        sourcePortId: string,
        targetType: CanvasModuleType,
        targetPortId: string,
      ): Promise<boolean>;
      createModule(moduleType: CanvasModuleType, position?: { x: number; y: number }): Promise<boolean>;
      configureModule(moduleType: CanvasModuleType, patch: {
        config?: Record<string, unknown>;
        execution?: { state: import('@agent-canvas/domain').CanvasModuleExecutionState; latestExecutionId?: string };
      }): Promise<boolean>;
      getState(): E2EState;
      nonce: string;
      queueProjectImageImport(input: {
        byteSize: number;
        height: number;
        label: string;
        mediaType: 'image/png';
        width: number;
      }): void;
      queueProjectVideoImport(input: {
        byteSize: number;
        label: string;
        mediaType: 'video/mp4';
      }): void;
      failNextModelJobEnqueue(): void;
      reset(): Promise<void>;
      seedSkillSyncDivergence(): Promise<void>;
      seedModuleStressGraph(nodeCount: number, edgeCount: number): Promise<boolean>;
    };
    __NOVUS_STALL_OBSERVER__?: {
      entries: Array<{ duration: number; entryType: string; startTime: number }>;
      observers: PerformanceObserver[];
      observerTypes: string[];
      windows: Array<{ endTime: number; operation: string; startTime: number }>;
    };
  }
}
