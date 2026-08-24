import { test, expect } from './helpers/e2e-test';
import { openEmptyApp } from './helpers/app';

test('opens and closes the generation history drawer from an empty canvas', async ({ page }) => {
  await openEmptyApp(page);

  const toggle = page.getByTestId('history-toggle');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');

  await toggle.click();
  const drawer = page.getByTestId('history-drawer');
  await expect(drawer).toBeVisible();
  await expect(drawer.locator('.history-empty')).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');

  await drawer.locator('header button').last().click();
  await expect(drawer).toBeHidden();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
});

test('filters real image and video history cards and renders an MP4 preview', async ({ page }) => {
  await openEmptyApp(page);
  await page.evaluate(() => {
    const records = [
      {
        schemaVersion: 2,
        kind: 'image',
        id: 'history_browser_image_0001',
        createdAt: '2026-08-11T08:00:00.000Z',
        updatedAt: '2026-08-11T08:00:02.000Z',
        completedAt: '2026-08-11T08:00:02.000Z',
        project: { projectId: 'project_browser_history', displayLabel: 'Browser history' },
        job: { jobId: 'job_browser_image_0001', resultId: 'result_browser_image_0001' },
        status: 'succeeded',
        provider: { displayName: 'Comfly', modelDisplayName: 'Nano Banana 2', capabilityRevision: '2026-08' },
        promptSummary: 'Browser image history',
        parameters: { aspectRatio: '1:1', outputCount: 1, quality: '2K' },
        output: {
          width: 2048,
          height: 2048,
          format: 'png',
          mediaType: 'image/png',
          byteSize: 4096,
          availability: 'available',
          historyAssetId: 'history_browser_image_asset',
          sha256: 'a'.repeat(64),
        },
        favorite: false,
        tags: [],
        projectReferenceCount: 0,
        projectReferences: [],
        trash: null,
        termination: null,
      },
      {
        schemaVersion: 2,
        kind: 'video',
        id: 'history_browser_video_0001',
        createdAt: '2026-08-11T09:00:00.000Z',
        updatedAt: '2026-08-11T09:00:06.000Z',
        completedAt: '2026-08-11T09:00:06.000Z',
        project: { projectId: 'project_browser_history', displayLabel: 'Browser history' },
        job: { jobId: 'job_browser_video_0001', resultId: 'result_browser_video_0001' },
        status: 'succeeded',
        provider: { displayName: 'RelayMe', modelDisplayName: 'Seedance 2.0 Pro', capabilityRevision: '2026-08' },
        promptSummary: 'Browser video history',
        parameters: { aspectRatio: '16:9', outputCount: 1, quality: '1080p' },
        output: {
          width: 1920,
          height: 1080,
          durationMs: 6000,
          format: 'mp4',
          mediaType: 'video/mp4',
          byteSize: 8192,
          availability: 'available',
          historyAssetId: 'history_browser_video_asset',
          sha256: 'b'.repeat(64),
        },
        favorite: false,
        tags: [],
        projectReferenceCount: 0,
        projectReferences: [],
        trash: null,
        termination: null,
      },
    ];
    Object.assign(window.novusDesktop!.history, {
      getCapacity: async () => ({ activeBytes: 12288, activeCount: 2, missingOrCorruptCount: 0, trashBytes: 0, trashCount: 0 }),
      list: async (request: { filters: { kind: 'all' | 'image' | 'video' } }) => {
        const filtered = request.filters.kind === 'all'
          ? records
          : records.filter((record) => record.kind === request.filters.kind);
        return { nextCursor: null, records: filtered, revision: 1, total: filtered.length };
      },
    });
  });

  await page.getByTestId('history-toggle').click();
  const drawer = page.getByTestId('history-drawer');
  await expect(drawer.getByRole('img', { name: 'Browser image history' })).toBeVisible();
  const videoPreview = drawer.locator('video.history-video-preview[aria-label="Browser video history"]');
  await expect(videoPreview).toHaveCount(1);
  await expect(videoPreview).toHaveAttribute('src', 'novus-history://asset/history_browser_video_asset');

  await drawer.getByRole('button', { name: '视频', exact: true }).click();
  await expect(drawer.getByRole('img', { name: 'Browser image history' })).toHaveCount(0);
  await expect(videoPreview).toHaveCount(1);

  await drawer.getByRole('button', { name: '图片', exact: true }).click();
  await expect(drawer.getByRole('img', { name: 'Browser image history' })).toBeVisible();
  await expect(videoPreview).toHaveCount(0);
});
