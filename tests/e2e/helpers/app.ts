import type { Locator, Page, TestInfo } from '@playwright/test';
import { expect } from './e2e-test';
import type { GeneratedImageFixture } from './fixtures';

type E2EState = {
  commitCount: number;
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
  projectNodeTypes: string[];
  skillSyncWrites: Array<{
    candidateId: string;
    decision: string;
    projectId: string;
  }>;
};

export async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction((nonce) => window.__NOVUS_E2E__?.nonce === nonce, process.env.NOVUS_E2E_NONCE);
  await page.evaluate(() => window.__NOVUS_E2E__!.reset());
  await expect(page.getByTestId('workspace')).toBeVisible();
}

export async function uploadReference(page: Page, testId: string, fixture: GeneratedImageFixture): Promise<void> {
  await page.getByTestId(testId).setInputFiles({
    name: fixture.name,
    mimeType: fixture.mimeType,
    buffer: fixture.buffer,
  });
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

export async function captureLayoutScreenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    fullPage: true,
    path: testInfo.outputPath(`${name}.png`),
  });
}

export async function medianPanZoomFrameInterval(page: Page): Promise<number> {
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
  await page.mouse.wheel(0, -160);

  const marks = await page.evaluate(() => performance.getEntriesByName('novus-pan-zoom-frame').map((entry) => entry.startTime));
  expect(marks.length).toBeGreaterThanOrEqual(4);
  const intervals = marks.slice(1).map((value, index) => value - marks[index]!);
  const sorted = intervals.filter((value) => value >= 0).sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.POSITIVE_INFINITY;
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
      getState(): E2EState;
      nonce: string;
      failNextModelJobEnqueue(): void;
      reset(): Promise<void>;
      seedSkillSyncDivergence(): Promise<void>;
    };
  }
}
