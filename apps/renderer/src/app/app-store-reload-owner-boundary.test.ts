import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectImageAssetSummary } from '@agent-canvas/desktop-core';
import { createCanvasModuleNode } from '@agent-canvas/domain';
import { replaceProjectPersistenceClientForTests, resetAppStoreForTests, useAppStore } from './app-store';
import { createBrowserPersistenceClient, type ProjectHydrationResult } from './desktop-persistence';

const boundaries = ['project', 'reset', 'session', 'client'] as const;
type Boundary = typeof boundaries[number];

beforeEach(() => {
  delete window.novusDesktop;
  localStorage.clear();
  replaceProjectPersistenceClientForTests(createBrowserPersistenceClient());
  resetAppStoreForTests({ project: 'empty' });
});

afterEach(() => {
  resetAppStoreForTests({ project: 'empty' });
  vi.restoreAllMocks();
  delete window.novusDesktop;
});

describe('public durable reload owner boundary', () => {
  it.each(boundaries)('does not adopt an awaited native reload after the %s owner changes', async boundary => {
    const f = fixture();
    const nativeResult = deferred<ProjectHydrationResult>();
    f.reload.mockReturnValueOnce(nativeResult.promise);
    const pending = useAppStore.getState().reloadDurableProject();
    expect(f.reload).toHaveBeenCalledOnce();
    f.changeOwner(boundary);
    const replacement = snapshot();
    nativeResult.resolve(f.hydration);

    await expect(pending).resolves.toBe(false);
    expect(snapshot()).toEqual(replacement);
    expect(f.listImages).not.toHaveBeenCalled();
    expect(f.listVideos).not.toHaveBeenCalled();
  });

  it.each(boundaries)('does not adopt an awaited media hydration after the %s owner changes', async boundary => {
    const f = fixture();
    const images = deferred<ProjectImageAssetSummary[]>();
    f.listImages.mockReturnValueOnce(images.promise);
    const pending = useAppStore.getState().reloadDurableProject();
    await vi.waitFor(() => expect(f.listImages).toHaveBeenCalledOnce());
    f.changeOwner(boundary);
    const replacement = snapshot();
    images.resolve([f.durableImage]);

    await expect(pending).resolves.toBe(false);
    expect(snapshot()).toEqual(replacement);
  });

  it('rejects a saved native result from a foreign project before reading its media', async () => {
    const f = fixture();
    f.reload.mockResolvedValueOnce({ ...f.hydration, project: { ...f.hydration.project, id: 'foreign-project' } });
    const original = snapshot();

    await expect(useAppStore.getState().reloadDurableProject()).resolves.toBe(false);

    expect(snapshot()).toEqual(original);
    expect(f.listImages).not.toHaveBeenCalled();
  });

  it('restores a same-project same-session conflict and advances the canvas reset once', async () => {
    const f = fixture();
    const resetKey = useAppStore.getState().canvasDraftResetKey;

    await expect(useAppStore.getState().reloadDurableProject()).resolves.toBe(true);

    expect(useAppStore.getState()).toMatchObject({
      project: f.hydration.project,
      projectImages: [f.durableImage],
      canvasDraftResetKey: resetKey + 1,
      canReloadDurableProject: false,
      saveStatus: 'saved',
      desktopRevision: 8,
      projectCommitConflictCode: null,
      saveErrorCode: null,
      undoStack: [],
    });
    expect(f.listImages).toHaveBeenCalledOnce();
    expect(f.listVideos).toHaveBeenCalledOnce();
  });
});

function fixture() {
  const node = createCanvasModuleNode('same-node', 'image_generation', { x: 0, y: 0 });
  const project = { ...useAppStore.getState().project, id: 'reload-owned-project', name: 'Local conflict', nodes: [node] };
  const durableImage: ProjectImageAssetSummary = {
    assetId: '0123456789abcdef', sha256: '0123456789abcdef'.repeat(4), byteSize: 42,
    extension: 'png', width: 2, height: 3, label: 'Durable image', mediaType: 'image/png',
    origin: 'imported', usageCount: 1, displayUrl: 'novus-asset://project/reload-owner/0123456789abcdef',
  };
  const hydration: ProjectHydrationResult = {
    availableSnapshotIds: ['durable-snapshot'], lifecycle: 'durable', mode: 'desktop',
    project: { ...project, name: 'Durable project', assets: [durableImage] }, revision: 8, saveStatus: 'saved',
  };
  let sessionId = 'reload-owned-session';
  const reload = vi.fn<() => Promise<ProjectHydrationResult | null>>().mockResolvedValue(hydration);
  const listImages = vi.fn<() => Promise<ProjectImageAssetSummary[]>>().mockResolvedValue([durableImage]);
  const listVideos = vi.fn(async () => []);
  const client = {
    ...createBrowserPersistenceClient(), getSessionId: () => sessionId,
    reloadDurableProject: reload, listProjectImages: listImages, listProjectVideos: listVideos,
  };
  replaceProjectPersistenceClientForTests(client);
  useAppStore.setState({
    project, projectImages: [], persistenceMode: 'desktop', projectLifecycle: 'durable',
    canReloadDurableProject: true, desktopRevision: 7, saveStatus: 'error',
    saveErrorCode: 'REVISION_CONFLICT', projectCommitConflictCode: 'REVISION_CONFLICT',
  });
  return {
    reload, listImages, listVideos, hydration, durableImage,
    changeOwner(boundary: Boundary) {
      if (boundary === 'session') sessionId = 'replacement-session';
      else if (boundary === 'client') replaceProjectPersistenceClientForTests({ ...client });
      else useAppStore.setState(state => ({
        ...(boundary === 'project' ? { project: { ...state.project, id: 'replacement-project', name: 'Replacement project' } } : {}),
        canvasDraftResetKey: state.canvasDraftResetKey + 1,
        projectImages: [{ ...durableImage, label: 'Replacement image' }],
      }));
    },
  };
}

function snapshot() {
  const state = useAppStore.getState();
  return {
    project: state.project, projectImages: state.projectImages, projectVideos: state.projectVideos,
    canvasDraftResetKey: state.canvasDraftResetKey, desktopRevision: state.desktopRevision,
    canReloadDurableProject: state.canReloadDurableProject, canRetryProjectCommit: state.canRetryProjectCommit,
    projectCommitConflictCode: state.projectCommitConflictCode, saveErrorCode: state.saveErrorCode,
    saveStatus: state.saveStatus, undoStack: state.undoStack,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
