import { describe, expect, it } from 'vitest';
import { createCanvasModuleNode, type CanvasProject, type CanvasModuleType } from '@agent-canvas/domain';
import type { ProjectImageAssetSummary } from '@agent-canvas/desktop-core';
import { resolveMcpLayeringSource } from './mcp-layering-source';

function fixture(type: CanvasModuleType = 'image_generation') {
  const assetId = 'a'.repeat(16);
  const asset = { assetId, width: 24, height: 24, displayUrl: 'managed-source', mediaType: 'image/png', origin: 'generated' } as ProjectImageAssetSummary;
  const node = createCanvasModuleNode('source', type, { x: 0, y: 0 });
  node.data.config = type === 'image_generation' ? { resultAssetIds: [assetId] } : { assetId };
  const project = { id: 'owned', nodes: [node], edges: [], assets: [asset] } as unknown as CanvasProject;
  return { node, project, asset };
}
describe('actual MCP source resolver for generated and imported images', () => {
  it('resolves a single current generated result with its managed dimensions', () => {
    const f = fixture(); expect(resolveMcpLayeringSource(f.project, [f.asset], 'source')).toEqual({ asset: f.asset, sourceNodeId: 'source' });
  });
  it('rejects no result and ambiguous batches instead of choosing the first attachment', () => {
    const f = fixture(); f.node.data.config.resultAssetIds = [];
    expect(() => resolveMcpLayeringSource(f.project, [f.asset], 'source')).toThrow('LAYERING_SOURCE_UNAVAILABLE');
    f.node.data.config.resultAssetIds = [f.asset.assetId, 'b'.repeat(16)];
    expect(() => resolveMcpLayeringSource(f.project, [f.asset], 'source')).toThrow('LAYERING_SOURCE_AMBIGUOUS');
  });
  it('rejects assets from another project even when its preview is cached', () => {
    const f = fixture('image_input'); f.project.assets = [];
    expect(() => resolveMcpLayeringSource(f.project, [f.asset], 'source')).toThrow('LAYERING_SOURCE_UNAVAILABLE');
  });
  it('rejects a wrong module type even if its public config mentions a managed asset', () => {
    const f = fixture('text_prompt');
    expect(() => resolveMcpLayeringSource(f.project, [f.asset], 'source')).toThrow('LAYERING_SOURCE_TYPE_UNSUPPORTED');
  });
  it.each(['image_input', 'upload_image'] as const)('preserves the ordinary %s source', type => {
    const f = fixture(type); expect(resolveMcpLayeringSource(f.project, [f.asset], 'source').asset.assetId).toBe(f.asset.assetId);
  });
  it('resolves result_output through exactly one current image-generation edge', () => {
    const f = fixture(); const output = createCanvasModuleNode('output', 'result_output', { x: 400, y: 0 });
    f.project.nodes.push(output); f.project.edges.push({ id: 'result-edge', source: 'source', sourcePortId: 'result', target: 'output', targetPortId: 'result', order: 0 });
    expect(resolveMcpLayeringSource(f.project, [f.asset], 'output')).toEqual({ asset: f.asset, sourceNodeId: 'source' });
  });
});
