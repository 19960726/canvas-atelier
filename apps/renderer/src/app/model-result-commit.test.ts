import { describe, expect, it, vi } from 'vitest';
import { createCanvasModuleNode } from '@agent-canvas/domain';
import { createStarterProject } from './app-store';
import { commitGeneratedResultWithRefresh, mergeGeneratedAssetRevision } from './model-result-commit';

describe('generated result commit coordinator', () => {
  it('keeps local node edits while adopting generated assets and the latest revision', () => {
    const localNode = createCanvasModuleNode('image-node', 'image_generation', { x: 0, y: 0 });
    localNode.data.config = { ...localNode.data.config, prompt: 'new local prompt' };
    const durableNode = createCanvasModuleNode('image-node', 'image_generation', { x: 0, y: 0 });
    durableNode.data.config = { ...durableNode.data.config, prompt: 'old durable prompt' };
    const generated = {
      assetId: 'a'.repeat(16),
      sha256: 'a'.repeat(64),
      byteSize: 128,
      extension: 'png' as const,
      height: 1024,
      label: 'Generated image',
      mediaType: 'image/png' as const,
      origin: 'generated' as const,
      width: 1024,
    };
    const local = { ...createStarterProject(), nodes: [localNode], edges: [], assets: [] };
    const durable = { ...local, nodes: [durableNode], assets: [generated] };

    const merged = mergeGeneratedAssetRevision(local, durable);

    expect(merged.nodes[0]?.type === 'module' ? merged.nodes[0].data.config.prompt : undefined)
      .toBe('new local prompt');
    expect(merged.assets?.map((asset) => asset.assetId)).toContain('a'.repeat(16));
  });

  it('reloads and rebuilds at most twice after revision conflicts', async () => {
    const imageNode = createCanvasModuleNode('image-node', 'image_generation', { x: 0, y: 0 });
    const localProject = { ...createStarterProject(), nodes: [imageNode], edges: [], assets: [] };
    const durableProject = {
      ...localProject,
      assets: [{
        assetId: 'a'.repeat(16), sha256: 'a'.repeat(64), byteSize: 128,
        extension: 'png' as const, height: 1024, label: 'Generated image',
        mediaType: 'image/png' as const, origin: 'generated' as const, width: 1024,
      }],
    };
    const commit = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    let currentProject = localProject;
    const builtProjects: Array<typeof localProject> = [];
    const result = await commitGeneratedResultWithRefresh({
      build: (project) => {
        builtProjects.push(project as typeof localProject);
        return {
        resultNodeId: 'image-node',
        transaction: {
          id: `result-${project?.id ?? 'missing'}`,
          label: 'Store generated result',
          operations: [],
        },
        };
      },
      canContinue: vi.fn(async () => true),
      commit,
      getLocalProject: () => currentProject,
      reloadDurableProject: vi.fn(async () => ({ project: durableProject, revision: 2 })),
      adoptRefreshedProject: vi.fn((project) => { currentProject = project; }),
    });

    expect(result.committed).toBe(true);
    expect(commit).toHaveBeenCalledTimes(3);
    expect(builtProjects[1]?.assets).toEqual(durableProject.assets);
  });

  it('aborts without adoption or another commit when the guard changes during reload', async () => {
    const imageNode = createCanvasModuleNode('guarded-image-node', 'image_generation', { x: 0, y: 0 });
    const localProject = { ...createStarterProject(), nodes: [imageNode], edges: [], assets: [] };
    const reload = deferred<{ project: typeof localProject; revision: number }>();
    let current = true;
    const commit = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const adoptRefreshedProject = vi.fn();
    const reloadDurableProject = vi.fn(() => reload.promise);
    const operation = commitGeneratedResultWithRefresh({
      build: () => ({
        resultNodeId: imageNode.id,
        transaction: { id: 'guarded-result', label: 'Guarded result', operations: [] },
      }),
      canContinue: vi.fn(async () => current),
      commit,
      getLocalProject: () => localProject,
      reloadDurableProject,
      adoptRefreshedProject,
    });
    await vi.waitFor(() => expect(reloadDurableProject).toHaveBeenCalledOnce());
    current = false;
    reload.resolve({ project: localProject, revision: 2 });

    await expect(operation).resolves.toEqual({ committed: false, resultNodeId: imageNode.id });
    expect(adoptRefreshedProject).not.toHaveBeenCalled();
    expect(commit).toHaveBeenCalledOnce();
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}
