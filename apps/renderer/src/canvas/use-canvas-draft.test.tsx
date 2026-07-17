import type { Node } from '@xyflow/react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { selectViewportCulledElements } from './use-viewport-culling';
import { useCanvasDraft } from './use-canvas-draft';

interface DraftNodeData extends Record<string, unknown> {
  title: string;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('useCanvasDraft', () => {
  it('updates draft position through multiple pointer moves without committing until drag stop', async () => {
    const initialNodes = [draftNode('module-1', 0, 0)];
    const onCommitPosition = vi.fn(async () => true);
    const { result } = renderHook(({ nodes }) => useCanvasDraft({ nodes, onCommitPosition }), {
      initialProps: { nodes: initialNodes },
    });

    act(() => {
      result.current.onNodesChange([{ id: 'module-1', type: 'position', position: { x: 20, y: 30 }, dragging: true }]);
      result.current.onNodesChange([{ id: 'module-1', type: 'position', position: { x: 40, y: 50 }, dragging: true }]);
      result.current.onNodesChange([{ id: 'module-1', type: 'position', position: { x: 60, y: 70 }, dragging: true }]);
    });

    expect(result.current.nodes.find((node) => node.id === 'module-1')?.position).toEqual({ x: 60, y: 70 });
    expect(onCommitPosition).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.onNodeDragStop({} as never, result.current.nodes[0]!);
    });

    expect(onCommitPosition).toHaveBeenCalledTimes(1);
    expect(onCommitPosition).toHaveBeenCalledWith('module-1', { x: 60, y: 70 });
  });

  it('does not let a stale same-source effect overwrite an active draft', () => {
    const initialNodes = [draftNode('module-1', 0, 0)];
    const { result, rerender } = renderHook(({ nodes }) => useCanvasDraft({
      nodes,
      onCommitPosition: async () => true,
    }), { initialProps: { nodes: initialNodes } });

    act(() => {
      result.current.onNodesChange([{ id: 'module-1', type: 'position', position: { x: 80, y: 90 }, dragging: true }]);
    });
    rerender({ nodes: initialNodes });

    expect(result.current.nodes.find((node) => node.id === 'module-1')?.position).toEqual({ x: 80, y: 90 });
  });

  it('resynchronizes from a changed durable source and culls using the draft position', () => {
    const initialNodes = [draftNode('module-1', 1600, 1600)];
    const { result, rerender } = renderHook(({ nodes }) => useCanvasDraft({
      nodes,
      onCommitPosition: async () => true,
    }), { initialProps: { nodes: initialNodes } });

    act(() => {
      result.current.onNodesChange([{ id: 'module-1', type: 'position', position: { x: 40, y: 40 }, dragging: true }]);
    });

    const culled = selectViewportCulledElements({
      edges: [],
      nodes: result.current.nodes,
      overscan: 0,
      viewport: { x: 0, y: 0, zoom: 1 },
      viewportSize: { width: 800, height: 600 },
    });
    expect(culled.nodes.map((node) => node.id)).toEqual(['module-1']);

    rerender({ nodes: [draftNode('module-1', 320, 240)] });
    expect(result.current.nodes.find((node) => node.id === 'module-1')?.position).toEqual({ x: 320, y: 240 });
  });
});

function draftNode(id: string, x: number, y: number): Node<DraftNodeData> {
  return { id, type: 'module', position: { x, y }, data: { title: id } };
}
