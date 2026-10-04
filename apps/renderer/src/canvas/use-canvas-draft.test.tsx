import type { Node } from '@xyflow/react';
import { StrictMode, type ReactNode } from 'react';
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
  it('keeps passive large-canvas measurements without rerendering the controlled graph and preserves them for the next interaction', () => {
    const initialNodes = [draftNode('module-1', 0, 0)];
    const renders = vi.fn();
    const { result } = renderHook(() => {
      renders();
      return useCanvasDraft({
        nodes: initialNodes,
        ...{ keepPassiveMeasurementsInternal: true },
        onCommitPositions: async () => true,
      });
    });
    renders.mockClear();

    act(() => result.current.onNodesChange([
      { id: 'module-1', type: 'dimensions', dimensions: { width: 292, height: 260 } },
    ]));
    act(() => result.current.onNodesChange([
      { id: 'module-1', type: 'dimensions', dimensions: { width: 292, height: 612 } },
    ]));
    expect(renders).not.toHaveBeenCalled();

    act(() => result.current.onNodesChange([
      { id: 'module-1', type: 'select', selected: true },
      { id: 'module-1', type: 'position', position: { x: 20, y: 30 }, dragging: true },
    ]));
    expect(result.current.nodes[0]).toMatchObject({
      selected: true, position: { x: 20, y: 30 }, measured: { width: 292, height: 612 },
    });
  });

  it('retains the latest passive measurement through an unrelated render and durable text edit', () => {
    const initialNodes = [draftNode('module-1', 0, 0)];
    const renders = vi.fn();
    const { result, rerender } = renderHook(({ nodes }) => {
      renders();
      return useCanvasDraft({ nodes, ...{ keepPassiveMeasurementsInternal: true }, onCommitPositions: async () => true });
    }, { initialProps: { nodes: initialNodes } });
    renders.mockClear();
    act(() => result.current.onNodesChange([
      { id: 'module-1', type: 'dimensions', dimensions: { width: 704, height: 1665 } },
    ]));
    expect(renders).not.toHaveBeenCalled();
    rerender({ nodes: initialNodes });
    rerender({ nodes: [{ ...initialNodes[0]!, data: { title: 'Edited prompt' } }] });
    expect(result.current.nodes[0]).toMatchObject({ data: { title: 'Edited prompt' }, measured: { width: 704, height: 1665 } });
  });

  it('still publishes explicit resize attributes on a large canvas', () => {
    const initialNodes = [draftNode('module-1', 0, 0)];
    const renders = vi.fn();
    const { result } = renderHook(() => {
      renders();
      return useCanvasDraft({ nodes: initialNodes, ...{ keepPassiveMeasurementsInternal: true }, onCommitPositions: async () => true });
    });
    renders.mockClear();
    act(() => result.current.onNodesChange([
      { id: 'module-1', type: 'dimensions', dimensions: { width: 480, height: 320 }, resizing: true, setAttributes: true },
    ]));
    expect(renders).toHaveBeenCalled();
    expect(result.current.nodes[0]).toMatchObject({ width: 480, height: 320, resizing: true, measured: { width: 480, height: 320 } });
    renders.mockClear();
    act(() => result.current.onNodesChange([
      { id: 'module-1', type: 'dimensions', dimensions: { width: 480, height: 320 }, resizing: false },
    ]));
    expect(renders).toHaveBeenCalled();
    expect(result.current.nodes[0]?.resizing).toBe(false);
  });

  it('keeps passive dimensions through a completed drag commit', async () => {
    const commit = deferred<boolean>();
    const initialNodes = [draftNode('module-1', 0, 0)];
    const { result, rerender } = renderHook(({ nodes }) => useCanvasDraft({
      nodes, ...{ keepPassiveMeasurementsInternal: true }, onCommitPositions: () => commit.promise,
    }), { initialProps: { nodes: initialNodes } });
    act(() => result.current.onNodesChange([
      { id: 'module-1', type: 'dimensions', dimensions: { width: 704, height: 1665 } },
    ]));
    act(() => result.current.onNodesChange([
      { id: 'module-1', type: 'position', position: { x: 120, y: 70 }, dragging: true },
    ]));
    const stop = result.current.onNodeDragStop({} as never, result.current.nodes[0]!);
    rerender({ nodes: [draftNode('module-1', 120, 70)] });
    commit.resolve(true);
    await act(async () => { await stop; });
    expect(result.current.nodes[0]).toMatchObject({ position: { x: 120, y: 70 }, measured: { width: 704, height: 1665 } });
  });

  it('does not leak passive measurements into a different project or resurrect a deleted node', () => {
    const initialNodes = [draftNode('module-1', 0, 0), draftNode('removed', 100, 0)];
    const { result, rerender } = renderHook(({ nodes, resetKey }) => useCanvasDraft({
      nodes, resetKey, ...{ keepPassiveMeasurementsInternal: true }, onCommitPositions: async () => true,
    }), { initialProps: { nodes: initialNodes, resetKey: 'project-a' } });
    act(() => result.current.onNodesChange([
      { id: 'module-1', type: 'dimensions', dimensions: { width: 704, height: 1665 } },
      { id: 'removed', type: 'dimensions', dimensions: { width: 292, height: 612 } },
    ]));
    rerender({ nodes: [draftNode('module-1', 0, 0)], resetKey: 'project-a' });
    expect(result.current.nodes.map(node => node.id)).toEqual(['module-1']);
    expect(result.current.nodes[0]?.measured).toEqual({ width: 704, height: 1665 });
    rerender({ nodes: [draftNode('module-1', 0, 0)], resetKey: 'project-b' });
    expect(result.current.nodes[0]?.measured).toBeUndefined();
  });

  it('publishes the latest drag and selection to the host under StrictMode', () => {
    const initialNodes = [draftNode('module-1', 0, 0)];
    const renderedPositions: Array<{ x: number; y: number; selected?: boolean }> = [];
    const { result } = renderHook(() => {
      const draft = useCanvasDraft({ nodes: initialNodes, ...{ keepPassiveMeasurementsInternal: true }, onCommitPositions: async () => true });
      renderedPositions.push({ ...draft.nodes[0]!.position, selected: draft.nodes[0]!.selected });
      return draft;
    }, { wrapper: ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode> });
    act(() => result.current.onNodesChange([{ id: 'module-1', type: 'dimensions', dimensions: { width: 292, height: 612 } }]));
    act(() => result.current.onNodesChange([{ id: 'module-1', type: 'position', position: { x: 10, y: 20 }, dragging: true }]));
    act(() => result.current.onNodesChange([{ id: 'module-1', type: 'position', position: { x: 30, y: 40 }, dragging: true }]));
    act(() => result.current.onNodesChange([{ id: 'module-1', type: 'select', selected: true }]));
    expect(renderedPositions[renderedPositions.length - 1]).toEqual({ x: 30, y: 40, selected: true });
    expect(result.current.nodes[0]?.measured).toEqual({ width: 292, height: 612 });
  });

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

  it('keeps React Flow measurements when a successful drag commit reconciles to an unmeasured durable node', async () => {
    const commit = deferred<boolean>();
    const initialNodes = [draftNode('module-1', 0, 0)];
    const { result, rerender } = renderHook(({ nodes }) => useCanvasDraft({
      nodes,
      onCommitPositions: () => commit.promise,
    }), { initialProps: { nodes: initialNodes } });

    act(() => {
      result.current.onNodesChange([
        { id: 'module-1', type: 'dimensions', dimensions: { width: 654, height: 486 }, setAttributes: true },
        { id: 'module-1', type: 'position', position: { x: 120, y: 70 }, dragging: true },
      ]);
    });
    const stop = result.current.onNodeDragStop({} as never, result.current.nodes[0]!);
    rerender({ nodes: [draftNode('module-1', 120, 70)] });

    commit.resolve(true);
    await act(async () => { await stop; });

    expect(result.current.nodes[0]).toMatchObject({
      position: { x: 120, y: 70 },
      measured: { width: 654, height: 486 },
      width: 654,
      height: 486,
    });
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
  it('merges durable source updates around an active drag and keeps the stopped node after a save failure', async () => {
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
      ['b', { x: 800, y: 900 }],
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

  it('keeps a stopped draft stable while its commit waits behind another commit and after failure', async () => {
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
    expect(result.current.nodes.find((node) => node.id === 'b')?.position).toEqual({ x: 800, y: 900 });
  });

  it.each([true, false])('keeps a newer active drag on the same node when the first ACK is %s and preserves the second commit', async (acknowledged) => {
    const firstCommit = deferred<boolean>();
    const secondCommit = deferred<boolean>();
    const onCommitPositions = vi.fn()
      .mockImplementationOnce(() => firstCommit.promise)
      .mockImplementationOnce(() => secondCommit.promise);
    const initialNodes = [draftNode('a', 100, 100)];
    const { result, rerender } = renderHook(({ nodes }) => useCanvasDraft({
      nodes, keepPassiveMeasurementsInternal: true, onCommitPositions,
    }), { initialProps: { nodes: initialNodes } });
    act(() => result.current.onNodesChange([{ id: 'a', type: 'dimensions', dimensions: { width: 704, height: 1665 } }]));
    act(() => result.current.onNodesChange([{ id: 'a', type: 'position', position: { x: 200, y: 220 }, dragging: true }]));
    const firstStop = result.current.onNodeDragStop({} as never, result.current.nodes[0]!);
    act(() => result.current.onNodesChange([{ id: 'a', type: 'position', position: { x: 700, y: 720 }, dragging: true }]));
    rerender({ nodes: [draftNode('a', 200, 220)] });

    firstCommit.resolve(acknowledged);
    await act(async () => { expect(await firstStop).toBe(acknowledged); });
    expect(result.current.nodes[0]?.position).toEqual({ x: 700, y: 720 });
    expect(result.current.nodes[0]?.measured).toEqual({ width: 704, height: 1665 });

    act(() => result.current.onNodesChange([{ id: 'a', type: 'position', position: { x: 780, y: 790 }, dragging: true }]));
    const secondStop = result.current.onNodeDragStop({} as never, result.current.nodes[0]!);
    expect(onCommitPositions).toHaveBeenNthCalledWith(2, [{ nodeId: 'a', position: { x: 780, y: 790 } }]);
    rerender({ nodes: [draftNode('a', 200, 220)] });
    secondCommit.resolve(acknowledged);
    await act(async () => { expect(await secondStop).toBe(acknowledged); });
    expect(result.current.nodes[0]?.position).toEqual({ x: 780, y: 790 });
    rerender({ nodes: [draftNode('a', 200, 220, { data: { title: 'Unrelated text edit' } })] });
    expect(result.current.nodes[0]).toMatchObject({ position: { x: 780, y: 790 }, data: { title: 'Unrelated text edit' }, measured: { width: 704, height: 1665 } });
    rerender({ nodes: [draftNode('a', 920, 940)] });
    expect(result.current.nodes[0]?.position).toEqual({ x: 920, y: 940 });
  });

  it.each([true, false])('ignores the previous project ACK %s after resetting during a newer same-node drag', async (acknowledged) => {
    const firstCommit = deferred<boolean>();
    const initialNodes = [draftNode('a', 100, 100)];
    const { result, rerender } = renderHook(({ nodes, resetKey }) => useCanvasDraft({
      nodes, resetKey, keepPassiveMeasurementsInternal: true, onCommitPositions: () => firstCommit.promise,
    }), { initialProps: { nodes: initialNodes, resetKey: 'project-a' } });
    act(() => result.current.onNodesChange([{ id: 'a', type: 'position', position: { x: 200, y: 220 }, dragging: true }]));
    const firstStop = result.current.onNodeDragStop({} as never, result.current.nodes[0]!);
    act(() => result.current.onNodesChange([{ id: 'a', type: 'position', position: { x: 700, y: 720 }, dragging: true }]));
    rerender({ nodes: [draftNode('a', 5, 6)], resetKey: 'project-b' });
    firstCommit.resolve(acknowledged);
    await act(async () => { await firstStop; });
    expect(result.current.nodes[0]?.position).toEqual({ x: 5, y: 6 });
    expect(result.current.nodes[0]?.measured).toBeUndefined();
    expect(result.current.nodes[0]?.dragging).toBeUndefined();
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

  it('keeps the committed drag position while the durable source is still stale', async () => {
    const commit = deferred<boolean>();
    const initialNodes = [draftNode('a', 100, 100)];
    const { result, rerender } = renderHook(({ nodes }) => useCanvasDraft({
      nodes,
      onCommitPositions: async () => commit.promise,
    }), { initialProps: { nodes: initialNodes } });

    act(() => {
      result.current.onNodesChange([{ id: 'a', type: 'position', position: { x: 800, y: 900 }, dragging: true }]);
    });
    const stopping = result.current.onNodeDragStop({} as never, result.current.nodes[0]!);

    rerender({ nodes: initialNodes });
    expect(result.current.nodes[0]?.position).toEqual({ x: 800, y: 900 });

    commit.resolve(true);
    await act(async () => { await stopping; });
    expect(result.current.nodes[0]?.position).toEqual({ x: 800, y: 900 });

    rerender({ nodes: [draftNode('a', 800, 900)] });
    expect(result.current.nodes[0]?.position).toEqual({ x: 800, y: 900 });
  });

  it('clears optimistic drag state when the same project starts a replacement persistence session', () => {
    const initialNodes = [draftNode('a', 100, 100)];
    const { result, rerender } = renderHook(({ nodes, resetKey }) => useCanvasDraft({
      nodes,
      resetKey,
      onCommitPositions: async () => false,
    }), { initialProps: { nodes: initialNodes, resetKey: 1 } });

    act(() => {
      result.current.onNodesChange([{ id: 'a', type: 'position', position: { x: 800, y: 900 }, dragging: true }]);
    });
    expect(result.current.nodes[0]?.position).toEqual({ x: 800, y: 900 });

    rerender({ nodes: initialNodes, resetKey: 2 });

    expect(result.current.nodes[0]?.position).toEqual({ x: 100, y: 100 });
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
