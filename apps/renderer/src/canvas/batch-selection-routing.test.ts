import { describe, expect, it } from 'vitest';
import { createCanvasModuleNode, type CanvasEdge, type CanvasModuleNode } from '@agent-canvas/domain';
import { planBatchConnections, sortSelectedMediaNodes } from './batch-selection-routing';

function edge(id: string, source: string, target: string, targetPortId: string, order: number): CanvasEdge {
  return { id, source, sourcePortId: 'image', target, targetPortId, order };
}

describe('batch selection routing', () => {
  it('sorts selected nodes top-to-bottom, left-to-right, then by id', () => {
    const nodes = [
      createCanvasModuleNode('b', 'image_input', { x: 40, y: 200 }),
      createCanvasModuleNode('a', 'image_input', { x: 20, y: 200 }),
      createCanvasModuleNode('c', 'image_input', { x: 0, y: 100 }),
    ];

    expect(sortSelectedMediaNodes(nodes).map((node) => node.id)).toEqual(['c', 'a', 'b']);
  });

  it('plans ordered image connections for image generation and appends existing references', () => {
    const first = createCanvasModuleNode('first', 'image_input', { x: 0, y: 0 });
    const second = createCanvasModuleNode('second', 'image_input', { x: 100, y: 0 });
    const target = createCanvasModuleNode('target', 'image_generation', { x: 400, y: 0 });

    const result = planBatchConnections({
      selectedNodes: [second, first],
      targetNode: target,
      existingEdges: [edge('existing', 'old', target.id, 'references', 0)],
    });

    expect(result.connections.map((connection) => [connection.source, connection.targetHandle, connection.order]))
      .toEqual([[first.id, 'references', 1], [second.id, 'references', 2]]);
    expect(result.skipped).toEqual([]);
  });

  it('routes mixed image and video media to reverse references and skips incompatible nodes', () => {
    const image = createCanvasModuleNode('image', 'image_input', { x: 0, y: 0 });
    const video = createCanvasModuleNode('video', 'video_input', { x: 0, y: 100 });
    const prompt = createCanvasModuleNode('prompt', 'text_prompt', { x: 0, y: 200 });
    const target = createCanvasModuleNode('target', 'reverse_agent', { x: 400, y: 0 });

    const result = planBatchConnections({ selectedNodes: [prompt, video, image], targetNode: target, existingEdges: [] });

    expect(result.connections.map((connection) => connection.source)).toEqual([image.id, video.id]);
    expect(result.connections.map((connection) => connection.targetHandle)).toEqual(['references', 'references']);
    expect(result.skipped.map((item) => item.nodeId)).toEqual([prompt.id]);
  });

  it('does not create more than the project media limit', () => {
    const selectedNodes = Array.from({ length: 21 }, (_, index) => createCanvasModuleNode(`image-${index}`, 'image_input', { x: index, y: 0 }));
    const target = createCanvasModuleNode('target', 'reverse_agent', { x: 400, y: 0 });

    const result = planBatchConnections({ selectedNodes, targetNode: target, existingEdges: [] });

    expect(result.connections).toHaveLength(20);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toMatch(/20|limit/i);
  });
});
