import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReactFlowProvider } from '@xyflow/react';
import type { ProjectImageAssetSummary } from '@agent-canvas/desktop-core';
import { createCanvasModuleNode } from '@agent-canvas/domain';
import { replaceProjectPersistenceClientForTests, resetAppStoreForTests, useAppStore } from '../app/app-store';
import { createBrowserPersistenceClient, type ProjectHydrationResult } from '../app/desktop-persistence';
import { ModuleNodeCard } from './ModuleNodeCard';

const boundaries = ['project', 'reset', 'session', 'client'] as const;
type Boundary = typeof boundaries[number];

beforeEach(() => {
  delete window.novusDesktop;
  localStorage.clear();
  replaceProjectPersistenceClientForTests(createBrowserPersistenceClient());
  resetAppStoreForTests({ project: 'empty' });
});

afterEach(() => {
  cleanup();
  resetAppStoreForTests({ project: 'empty' });
  vi.restoreAllMocks();
  delete window.novusDesktop;
});

describe('connected slot reorder owner boundary', () => {
  it.each(boundaries)('does not reload or retry an old reorder after the %s owner changes', async boundary => {
    const f = fixture();
    const firstResult = deferred<boolean>();
    const reorder = vi.fn<() => Promise<boolean>>().mockReturnValueOnce(firstResult.promise).mockResolvedValue(true);
    const reload = vi.fn(async () => true);
    useAppStore.setState({ reorderModuleInput: reorder, reloadDurableProject: reload });
    f.renderAndReorder();
    expect(reorder).toHaveBeenCalledOnce();
    act(() => f.changeOwner(boundary));
    const replacement = useAppStore.getState().project;
    await act(async () => { firstResult.resolve(false); });

    expect(reload).not.toHaveBeenCalled();
    expect(reorder).toHaveBeenCalledOnce();
    expect(useAppStore.getState().project).toBe(replacement);
  });

  it.each(boundaries)('does not retry an old reorder after the %s owner changes during reload', async boundary => {
    const f = fixture();
    const nativeResult = deferred<ProjectHydrationResult>();
    f.reload.mockReturnValueOnce(nativeResult.promise);
    const reorder = vi.spyOn(useAppStore.getState(), 'reorderModuleInput');
    f.renderAndReorder();
    await vi.waitFor(() => expect(f.reload).toHaveBeenCalledOnce());
    act(() => f.changeOwner(boundary));
    const replacement = useAppStore.getState().project;
    await act(async () => { nativeResult.resolve(f.hydration); });

    expect(reorder).toHaveBeenCalledOnce();
    expect(useAppStore.getState().project).toBe(replacement);
  });

  it('retries exactly once after the real same-owner reload advances the reset boundary', async () => {
    const f = fixture();
    const reorder = vi.spyOn(useAppStore.getState(), 'reorderModuleInput');
    const resetKey = useAppStore.getState().canvasDraftResetKey;
    f.renderAndReorder();
    await vi.waitFor(() => expect(reorder).toHaveBeenCalledTimes(2));

    expect(f.reload).toHaveBeenCalledOnce();
    expect(useAppStore.getState().canvasDraftResetKey).toBe(resetKey + 1);
    expect(useAppStore.getState().desktopRevision).toBe(8);
    expect(useAppStore.getState().project.edges.map(edge => [edge.id, edge.order])).toEqual([
      ['same-A', 1], ['same-B', 0],
    ]);
    expect(reorder).toHaveBeenNthCalledWith(2, 'same-target', 'references', ['same-B', 'same-A']);
  });
});

function fixture() {
  const images: ProjectImageAssetSummary[] = ['a', 'b'].map(key => ({
    assetId: key.repeat(16), sha256: key.repeat(64), byteSize: 42, extension: 'png',
    width: 2, height: 3, label: `Image ${key}`, mediaType: 'image/png', origin: 'imported', usageCount: 1,
    displayUrl: `novus-asset://project/reorder-owner/${key.repeat(16)}`,
  }));
  const sources = images.map((image, index) => {
    const source = createCanvasModuleNode(`same-source-${index}`, 'image_input', { x: 0, y: index * 100 });
    source.data.config = { assetId: image.assetId };
    return source;
  });
  const target = createCanvasModuleNode('same-target', 'reverse_agent', { x: 420, y: 0 });
  const project = {
    ...useAppStore.getState().project, id: 'reorder-owner-project', nodes: [...sources, target], assets: images,
    edges: sources.map((source, index) => ({
      id: `same-${index === 0 ? 'A' : 'B'}`, source: source.id, sourcePortId: 'image',
      target: target.id, targetPortId: 'references', order: index,
    })),
  };
  const hydration: ProjectHydrationResult = {
    availableSnapshotIds: [], lifecycle: 'durable', mode: 'desktop', project, revision: 8, saveStatus: 'saved',
  };
  let sessionId = 'reorder-owner-session';
  const reload = vi.fn<() => Promise<ProjectHydrationResult | null>>().mockResolvedValue(hydration);
  const client = {
    ...createBrowserPersistenceClient(), getSessionId: () => sessionId, reloadDurableProject: reload,
    listProjectImages: async () => images, listProjectVideos: async () => [],
  };
  replaceProjectPersistenceClientForTests(client);
  useAppStore.setState({
    project, projectImages: images, persistenceMode: 'desktop', projectLifecycle: 'durable',
    canReloadDurableProject: true, desktopRevision: 7, saveStatus: 'error',
    saveErrorCode: 'REVISION_CONFLICT', projectCommitConflictCode: 'REVISION_CONFLICT',
  });
  return {
    reload, hydration,
    changeOwner(boundary: Boundary) {
      if (boundary === 'session') sessionId = 'replacement-session';
      else if (boundary === 'client') replaceProjectPersistenceClientForTests({ ...client });
      else useAppStore.setState(state => ({
        ...(boundary === 'project' ? { project: { ...state.project, id: 'replacement-project' } } : {}),
        canvasDraftResetKey: state.canvasDraftResetKey + 1,
      }));
    },
    renderAndReorder() {
      render(<ReactFlowProvider><ModuleNodeCard id={target.id} data={target.data} selected={false} /></ReactFlowProvider>);
      fireEvent.dragStart(screen.getByLabelText('Agent media slot 2'));
      fireEvent.drop(screen.getByLabelText('Agent media slot 1'));
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
