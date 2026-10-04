import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createCanvasModuleNode, type CanvasModuleNode, type CanvasProject } from '@agent-canvas/domain';
import { createBrowserPersistenceClient } from './desktop-persistence';
import { retainedImagePreviewIds, retainedVideoPreviews } from './generation-previous-results';
import { normalizeImageColorCorrections, type ImageColorCorrection } from './image-color-correction';
import { createInMemoryModelJobStorage, type ModelJobPollResult } from '../jobs/job-store';
import { createStarterProject, replaceModelJobExecutorForTests, replaceModelJobStorageForTests,
  replaceProjectPersistenceClientForTests, resetAppStoreForTests, useAppStore } from './app-store';

const oldImageId = 'a'.repeat(16);
const oldVideoId = 'b'.repeat(16);
const newImageId = 'c'.repeat(16);
const newVideoId = 'd'.repeat(16);
const oldCorrection: ImageColorCorrection = { version: 2, mode: 'custom', contrast: 95,
  saturation: 108, temperature: 12, tint: -4, brightness: 103 };
const imageAsset = (assetId: string) => ({ assetId, byteSize: 64, extension: 'png' as const,
  width: 16, height: 16, label: 'Managed image', mediaType: 'image/png' as const,
  origin: 'generated' as const, sha256: assetId.repeat(4) });
const videoAsset = (assetId: string) => ({ assetId, byteSize: 64, extension: 'mp4' as const,
  width: 16, height: 16, durationMs: 4000, label: 'Managed video', mediaType: 'video/mp4' as const,
  origin: 'imported' as const, sha256: assetId.repeat(4) });

beforeEach(() => { delete window.novusDesktop; localStorage.clear(); });
afterEach(() => { resetAppStoreForTests(); delete window.novusDesktop; });

function prepare(kind: 'image' | 'video', legacyColor = false) {
  let finish!: (result: ModelJobPollResult) => void;
  const pending = new Promise<ModelJobPollResult>(resolve => { finish = resolve; });
  replaceProjectPersistenceClientForTests(createBrowserPersistenceClient());
  replaceModelJobStorageForTests(createInMemoryModelJobStorage());
  replaceModelJobExecutorForTests({ submit: async job => ({ providerTaskId: `qa-${job.id}` }),
    poll: async () => pending, cancel: async () => {} });
  resetAppStoreForTests();
  window.novusDesktop = { provider: {
    getStatus: async () => ({ configured: true, locked: false, encryption: 'safeStorage' }),
    listProfiles: async () => [{ provider: 'relayme', modelRoute: 'qa-generation', displayName: 'QA generation',
      modelId: 'qa-generation', capabilities: ['image_generation', 'video_generation', 'async_tasks'] }],
  } } as unknown as typeof window.novusDesktop;
  const node = createCanvasModuleNode('retained-generation', kind === 'image' ? 'image_generation' : 'video_generation', { x: 0, y: 0 });
  node.data.config = { ...node.data.config, resultState: 'fresh',
    ...(legacyColor ? { colorCorrection: oldCorrection } : { imageColorCorrections: { [oldImageId]: oldCorrection } }),
    ...(kind === 'image' ? { resultAssetIds: [oldImageId] }
      : { videoResults: [{ assetId: oldVideoId, mediaType: 'video/mp4', durationMs: 4000, posterAssetId: oldImageId }] }),
  };
  const project: CanvasProject = { ...createStarterProject(), nodes: [node], edges: [],
    assets: [imageAsset(oldImageId), imageAsset(newImageId), videoAsset(oldVideoId), videoAsset(newVideoId)] };
  useAppStore.setState({ project, modelJobs: [], saveStatus: 'saved' });
  const start = () => kind === 'image'
    ? useAppStore.getState().runImageGenerationNode(node.id, { prompt: 'A new image request', modelRoute: 'qa-generation', outputCount: 1 })
    : useAppStore.getState().runVideoPreviewNode(node.id, { prompt: 'A new video request', modelRoute: 'qa-generation',
      referenceAssetIds: [], aspectRatio: '16:9', keyframe: 'auto', durationSeconds: 4, resolution: '720p', outputCount: 1, audioEnabled: false });
  const config = () => (useAppStore.getState().project.nodes[0] as CanvasModuleNode).data.config;
  return { finish, start, config };
}

it('migrates a legacy single-image correction to the old asset before pending clears current IDs', async () => {
  const { finish, start, config } = prepare('image', true);
  await expect(start()).resolves.toBe(true);
  await vi.waitFor(() => expect(useAppStore.getState().modelJobs[0]?.status).toBe('running'));
  expect(normalizeImageColorCorrections(config().imageColorCorrections, config().colorCorrection, config().resultAssetIds))
    .toEqual({ [oldImageId]: oldCorrection });
  finish({ status: 'completed', result: { assetId: newImageId } });
  await vi.waitFor(() => expect(useAppStore.getState().modelJobs[0]?.status).toBe('completed'));
  expect(normalizeImageColorCorrections(config().imageColorCorrections, config().colorCorrection, config().resultAssetIds))
    .toEqual({ [oldImageId]: oldCorrection });
});

for (const kind of ['image', 'video'] as const) {
  it.each(['completed', 'failed', 'cancelled'] as const)(`keeps managed previous ${kind} separate from the current task until %s`, async terminal => {
    const { finish, start, config } = prepare(kind);
    await expect(start()).resolves.toBe(true);
    await vi.waitFor(() => expect(useAppStore.getState().modelJobs[0]?.status).toBe('running'));
    expect(config()).toMatchObject({ resultState: 'pending', pendingResultJobIds: [useAppStore.getState().modelJobs[0]!.id],
      imageColorCorrections: { [oldImageId]: oldCorrection },
      ...(kind === 'image' ? { resultAssetIds: [], previousResultAssetIds: [oldImageId] }
        : { previousVideoResults: [expect.objectContaining({ assetId: oldVideoId, posterAssetId: oldImageId })] }),
    });
    if (kind === 'video') expect(config().videoResults ?? []).toEqual([]);
    expect(normalizeImageColorCorrections(config().imageColorCorrections, config().colorCorrection, config().resultAssetIds))
      .toEqual({ [oldImageId]: oldCorrection });
    finish(terminal === 'completed' ? { status: 'completed', result: { assetId: kind === 'image' ? newImageId : newVideoId, durationSeconds: 4 } }
      : terminal === 'failed' ? { status: 'failed', error: new Error('Controlled generation failure') } : { status: 'cancelled' });
    await vi.waitFor(() => expect(useAppStore.getState().modelJobs[0]?.status).toBe(terminal));
    expect(config().imageColorCorrections).toEqual({ [oldImageId]: oldCorrection });
    if (terminal === 'completed') {
      expect(config()).toMatchObject({ resultState: 'fresh', ...(kind === 'image' ? { resultAssetIds: [newImageId] }
        : { videoResults: [expect.objectContaining({ assetId: newVideoId })] }) });
      expect(JSON.stringify(kind === 'image' ? config().resultAssetIds : config().videoResults)).not.toContain(kind === 'image' ? oldImageId : oldVideoId);
      expect(useAppStore.getState().modelJobs[0]?.resultAssetId).toBe(kind === 'image' ? newImageId : newVideoId);
    } else {
      expect(config()).toMatchObject(kind === 'image' ? { previousResultAssetIds: [oldImageId] }
        : { previousVideoResults: [expect.objectContaining({ assetId: oldVideoId })] });
      if (terminal === 'failed') {
        await expect(start()).resolves.toBe(true);
        expect(config()).toMatchObject(kind === 'image' ? { previousResultAssetIds: [oldImageId] }
          : { previousVideoResults: [expect.objectContaining({ assetId: oldVideoId })] });
      }
    }
  });
}

it('only retains project-owned image previews and gives new results precedence', () => {
  const project = { ...createStarterProject(), assets: [imageAsset(oldImageId), imageAsset(newImageId)] };
  expect(retainedImagePreviewIds(project, { previousResultAssetIds: [oldImageId, oldVideoId] })).toEqual([oldImageId]);
  expect(retainedImagePreviewIds(project, { resultAssetIds: [newImageId], previousResultAssetIds: [oldImageId] })).toEqual([newImageId]);
});

it('retains owned video/poster IDs without persisting raw or foreign poster URLs', () => {
  const project = { ...createStarterProject(), assets: [imageAsset(oldImageId), videoAsset(oldVideoId), videoAsset(newVideoId)] };
  const posterUrl = `novus-asset://project/session/${oldImageId}`;
  const oldResult = { assetId: oldVideoId, durationMs: 4000, mediaType: 'video/mp4', posterUrl };
  expect(retainedVideoPreviews(project, { videoResults: [oldResult, { ...oldResult, assetId: newImageId }] }, [{ assetId: oldImageId, displayUrl: posterUrl }]))
    .toEqual([{ assetId: oldVideoId, durationMs: 4000, mediaType: 'video/mp4', posterAssetId: oldImageId }]);
  expect(retainedVideoPreviews(project, { videoResults: [{ ...oldResult, posterUrl: 'https://foreign.invalid/poster.png' }] }))
    .toEqual([{ assetId: oldVideoId, durationMs: 4000, mediaType: 'video/mp4' }]);
  expect(retainedVideoPreviews(project, { videoResults: [{ ...oldResult, assetId: newVideoId }], previousVideoResults: [oldResult] })[0]?.assetId).toBe(newVideoId);
});
