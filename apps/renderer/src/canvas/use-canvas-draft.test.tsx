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
  it('ignores React Flow remove changes because durable deletion is handled by the workspace', () => {
    const initialNodes = [draftNode('module-1', 0, 0)];
    const { result } = renderHook(() => useCanvasDraft({
      nodes: initialNodes,
      onCommitPositions: async () => true,
    }));

    act(() => {
      result.current.onNodesChange([{ id: 'module-1', type: 'remove' }]);
    });

    expect(result.current.nodes.map((node) => node.id)).toEqual(['module-1']);
  });

  it('updates draft position through multiple pointer moves without committing until drag stop', async () => {
    const initialNodes = [draftNode('module-1', 0, 0)];
    const onCommitPositions = vi.fn(async () => true);
    const { result } = renderHook(({ nodes }) => useCanvasDraft({ nodes, onCommitPositions }), {
      initialProps: { nodes: initialNodes },
    });

    act(() => {
      result.current.onNodesChange([{ id: 'module-1', type: 'position', position: { x: 20, y: 30 }, dragging: true }]);
      result.current.onNodesChange([{ id: 'module-1', type: 'position', position: { x: 40, y: 50 }, dragging: true }]);
      result.current.onNodesChange([{ id: 'module-1', type: 'position', position: { x: 60, y: 70 }, dragging: true }]);
    });

    expect(result.current.nodes.find((node) => node.id === 'module-1')?.position).toEqual({ x: 60, y: 70 });
    expect(onCommitPositions).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.onNodeDragStop({} as never, result.current.nodes[0]!);
    });

    expect(onCommitPositions).toHaveBeenCalledTimes(1);
    expect(onCommitPositions).toHaveBeenCalledWith([{ nodeId: 'module-1', position: { x: 60, y: 70 } }]);
  });

  it('commits every selected draggable node in one batch after a group drag', async () => {
    const initialNodes = [
      draftNode('a', 0, 0, { selected: true }),
      draftNode('b', 100, 100, { selected: true }),
      draftNode('locked', 200, 200, { draggable: false, selected: true }),
    ];
    const onCommitPositions = vi.fn(async () => true);
    const { result } = renderHook(({ nodes }) => useCanvasDraft({ nodes, onCommitPositions }), {
      initialProps: { nodes: initialNodes },
    });

    act(() => {
      result.current.onNodesChange([
        { id: 'a', type: 'position', position: { x: 20, y: 30 }, dragging: true },
        { id: 'b', type: 'position', position: { x: 120, y: 130 }, dragging: true },
      ]);
    });

    await act(async () => {
      await result.current.onNodeDragStop({} as never, result.current.nodes.find((node) => node.id === 'a')!);
    });

    expect(onCommitPositions).toHaveBeenCalledTimes(1);
    expect(onCommitPositions).toHaveBeenCalledWith([
      { nodeId: 'a', position: { x: 20, y: 30 } },
      { nodeId: 'b', position: { x: 120, y: 130 } },
    ]);
  });
  it('merges durable source updates around an active drag and rolls back the stopped node after failure', async () => {
    const initialNodes = [draftNode('a', 0, 0), draftNode('b', 100, 100), draftNode('removed', 200, 200)];
    const onCommitPositions = vi.fn(async () => false);
    const { result, rerender } = renderHook(({ nodes }) => useCanvasDraft({ nodes, onCommitPositions }), {
      initialProps: { nodes: initialNodes },
    });

    act(() => {
      result.current.onNodesChange([{ id: 'b', type: 'position', position: { x: 800, y: 900 }, dragging: true }]);
    });

    rerender({ nodes: [draftNode('a', 20, 30), draftNode('b', 100, 100), draftNode('added', 300, 300)] });

    expect(result.current.nodes.map((node) => [node.id, node.position])).toEqual([
      ['a', { x: 20, y: 30 }],
      ['b', { x: 800, y: 900 }],
      ['added', { x: 300, y: 300 }],
    ]);

    await act(async () => {
      await result.current.onNodeDragStop({} as never, result.current.nodes.find((node) => node.id === 'b')!);
    });
    rerender({ nodes: [draftNode('a', 20, 30), draftNode('b', 100, 100), draftNode('added', 300, 300)] });

    expect(onCommitPositions).toHaveBeenCalledWith([{ nodeId: 'b', position: { x: 800, y: 900 } }]);
    expect(result.current.nodes.map((node) => [node.id, node.position])).toEqual([
      ['a', { x: 20, y: 30 }],
      ['b', { x: 100, y: 100 }],
      ['added', { x: 300, y: 300 }],
    ]);
  });

  it('preserves active draft position and React Flow interaction metadata across durable source updates', () => {
    const initialNodes = [draftNode('a', 0, 0), draftNode('b', 100, 100, { selected: true, dragging: true })];
    const { result, rerender } = renderHook(({ nodes }) => useCanvasDraft({
      nodes,
      onCommitPositions: async () => true,
    }), { initialProps: { nodes: initialNodes } });

    act(() => {
      result.current.onNodesChange([{ id: 'b', type: 'position', position: { x: 800, y: 900 }, dragging: true }]);
    });
    rerender({ nodes: [draftNode('a', 20, 30), draftNode('b', 100, 100, { selected: false, dragging: false })] });

    const activeNode = result.current.nodes.find((node) => node.id === 'b');
    expect(activeNode?.position).toEqual({ x: 800, y: 900 });
    expect(activeNode?.selected).toBe(true);
    expect(activeNode?.dragging).toBe(true);
  });

  it('preserves React Flow measurement metadata when text edits replace durable node data', () => {
    const initialNodes = [draftNode('a', 0, 0, {
      width: 426,
      height: 594,
      measured: { width: 426, height: 594 },
    })];
    const { result, rerender } = renderHook(({ nodes }) => useCanvasDraft({
      nodes,
      onCommitPositions: async () => true,
    }), { initialProps: { nodes: initialNodes } });

    rerender({ nodes: [draftNode('a', 0, 0, {
      data: { title: 'after backspace' },
    })] });

    const updatedNode = result.current.nodes[0];
    expect(updatedNode?.data).toEqual({ title: 'after backspace' });
    expect(updatedNode?.width).toBe(426);
    expect(updatedNode?.height).toBe(594);
    expect(updatedNode?.measured).toEqual({ width: 426, height: 594 });
  });

  it('does not publish an identical React Flow measurement change twice', () => {
    const initialNodes = [draftNode('a', 0, 0)];
    const { result } = renderHook(() => useCanvasDraft({
      nodes: initialNodes,
      onCommitPositions: async () => true,
    }));
    const measuredChange = {
      id: 'a',
      type: 'dimensions' as const,
      dimensions: { width: 426, height: 594 },
      resizing: false,
    };

    act(() => result.current.onNodesChange([measuredChange]));
    const firstResult = result.current.nodes;
    act(() => result.current.onNodesChange([measuredChange]));

    expect(result.current.nodes).toBe(firstResult);
  });

  it('keeps a stopped draft stable while its commit waits behind another commit and reconciles failure', async () => {
    const firstCommit = deferred<boolean>();
    const queuedCommitGate = deferred<void>();
    const secondCommitStarted = deferred<void>();
    const secondCommit = deferred<boolean>();
    const onCommitPositions = vi.fn((updates: readonly { nodeId: string }[]) => {
      if (updates[0]?.nodeId === 'a') return firstCommit.promise;
      return queuedCommitGate.promise.then(() => {
        secondCommitStarted.resolve();
        return secondCommit.promise;
      });
    });
    const initialNodes = [draftNode('a', 0, 0), draftNode('b', 100, 100)];
    const { result, rerender } = renderHook(({ nodes }) => useCanvasDraft({ nodes, onCommitPositions }), {
      initialProps: { nodes: initialNodes },
    });

    act(() => {
      result.current.onNodesChange([{ id: 'a', type: 'position', position: { x: 20, y: 30 }, dragging: true }]);
    });
    const firstStop = result.current.onNodeDragStop({} as never, result.current.nodes.find((node) => node.id === 'a')!);

    act(() => {
      result.current.onNodesChange([{ id: 'b', type: 'position', position: { x: 800, y: 900 }, dragging: true }]);
    });
    const secondStop = result.current.onNodeDragStop({} as never, result.current.nodes.find((node) => node.id === 'b')!);

    firstCommit.resolve(true);
    await act(async () => {
      await firstStop;
    });
    rerender({ nodes: [draftNode('a', 20, 30), draftNode('b', 100, 100)] });

    expect(result.current.nodes.find((node) => node.id === 'b')?.position).toEqual({ x: 800, y: 900 });

    queuedCommitGate.resolve();
    await act(async () => {
      await secondCommitStarted.promise;
    });
    expect(result.current.nodes.find((node) => node.id === 'b')?.position).toEqual({ x: 800, y: 900 });

    secondCommit.resolve(false);
    await act(async () => {
      await secondStop;
    });
    expect(result.current.nodes.find((node) => node.id === 'b')?.position).toEqual({ x: 100, y: 100 });
  });

  it('resynchronizes from a changed durable source and culls using the draft position', async () => {
    const initialNodes = [draftNode('module-1', 1600, 1600)];
    const { result, rerender } = renderHook(({ nodes }) => useCanvasDraft({
      nodes,
      onCommitPositions: async () => true,
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

    await act(async () => {
      await result.current.onNodeDragStop({} as never, result.current.nodes[0]!);
    });
    rerender({ nodes: [draftNode('module-1', 320, 240)] });
    expect(result.current.nodes.find((node) => node.id === 'module-1')?.position).toEqual({ x: 320, y: 240 });
  });
});

function draftNode(id: string, x: number, y: number, overrides: Partial<Node<DraftNodeData>> = {}): Node<DraftNodeData> {
  return { id, type: 'module', position: { x, y }, data: { title: id }, ...overrides };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
