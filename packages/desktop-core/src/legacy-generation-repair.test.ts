import { describe, expect, it } from 'vitest';
import { createCanvasModuleNode, type CanvasNode, type CanvasProject } from '@agent-canvas/domain';
import { buildLegacyOrphanedImageResultRepair } from './legacy-generation-repair';

describe('legacy generated image repair', () => {
  it('repairs the exact old-project pattern where the asset commit succeeded after the result commit conflicted', () => {
    const node: Extract<CanvasNode, { type: 'module' }> = createCanvasModuleNode('image-generation-old-project', 'image_generation', { x: 0, y: 0 });
    node.data.config = {
      ...node.data.config,
      lastResultJobId: 'model-job-old-project',
      resultAssetIds: [],
      resultState: 'pending',
    };
    node.data.execution = { ...node.data.execution, state: 'queued' };
    const stable = { ...emptyProject('old-project', 'Old project'), nodes: [node] };
    const generated = {
      assetId: '1fcb93e29c44dd8e',
      byteSize: 3_389_269,
      extension: 'jpg' as const,
      height: null,
      label: 'History generated',
      mediaType: 'image/jpeg' as const,
      origin: 'generated' as const,
      sha256: '1fcb93e29c44dd8ed70ee6c5247bf45e8da514998260c6a5f026284a512c1821',
      width: null,
    };
    const current = { ...stable, assets: [generated] };

    const repair = buildLegacyOrphanedImageResultRepair(stable, current);

    expect(repair).not.toBeNull();
    const repairOperation = repair?.operations[0];
    const repairedConfig = repairOperation?.kind === 'canvas'
      && repairOperation.operation.kind === 'update_node'
      && repairOperation.operation.node.type === 'module'
      ? repairOperation.operation.node.data.config
      : null;
    expect(repairedConfig).not.toHaveProperty('resultHeight');
    expect(repairedConfig).not.toHaveProperty('resultWidth');
    expect(repair?.operations).toEqual([{
      kind: 'canvas',
      operation: {
        kind: 'update_node',
        node: expect.objectContaining({
          id: node.id,
          data: expect.objectContaining({
            config: expect.objectContaining({
              lastResultJobId: 'model-job-old-project',
              resultAssetIds: [generated.assetId],
              resultState: 'fresh',
            }),
            execution: expect.objectContaining({ state: 'completed' }),
          }),
        }),
      },
    }]);
  });

  it('does not guess when the active journal added more than one generated image', () => {
    const node: Extract<CanvasNode, { type: 'module' }> = createCanvasModuleNode('ambiguous-image-generation', 'image_generation', { x: 0, y: 0 });
    node.data.config = { ...node.data.config, lastResultJobId: 'ambiguous-job', resultAssetIds: [], resultState: 'pending' };
    node.data.execution = { ...node.data.execution, state: 'queued' };
    const stable = { ...emptyProject('ambiguous-project', 'Ambiguous'), nodes: [node] };
    const generated = (assetId: string) => ({
      assetId,
      byteSize: 128,
      extension: 'png' as const,
      height: 512,
      label: 'Generated',
      mediaType: 'image/png' as const,
      origin: 'generated' as const,
      sha256: assetId.repeat(4),
      width: 512,
    });

    expect(buildLegacyOrphanedImageResultRepair(stable, {
      ...stable,
      assets: [generated('a'.repeat(16)), generated('b'.repeat(16))],
    })).toBeNull();
  });

  it('does not attach an older generated asset when the active journal added none', () => {
    const node: Extract<CanvasNode, { type: 'module' }> = createCanvasModuleNode('still-running-image-generation', 'image_generation', { x: 0, y: 0 });
    node.data.config = { ...node.data.config, lastResultJobId: 'still-running-job', resultAssetIds: [], resultState: 'pending' };
    node.data.execution = { ...node.data.execution, state: 'queued' };
    const generated = {
      assetId: 'c'.repeat(16),
      byteSize: 128,
      extension: 'png' as const,
      height: 512,
      label: 'Older generated image',
      mediaType: 'image/png' as const,
      origin: 'generated' as const,
      sha256: 'c'.repeat(64),
      width: 512,
    };
    const stable = { ...emptyProject('running-project', 'Running'), nodes: [node], assets: [generated] };

    expect(buildLegacyOrphanedImageResultRepair(stable, stable)).toBeNull();
  });
});

function emptyProject(id: string, name: string): CanvasProject {
  return {
    version: 1,
    id,
    name,
    nodes: [],
    edges: [],
    projectMemory: [],
    skillPromotionCandidates: [],
  };
}
