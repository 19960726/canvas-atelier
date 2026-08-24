import type { Edge, Node, Viewport } from '@xyflow/react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { selectViewportCulledElements, useViewportCulling } from './use-viewport-culling';

interface TestNodeData extends Record<string, unknown> {
  title: string;
  subtitle: string;
}

const viewport: Viewport = { x: 0, y: 0, zoom: 1 };
const viewportSize = { width: 800, height: 600 };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('selectViewportCulledElements', () => {
  it('preserves controlled node and edge references when culling is disabled', () => {
    const nodes = [testNode('source', 20, 20), testNode('target', 320, 20)];
    const edges = [testEdge('connected', 'source', 'target')];

    const result = selectViewportCulledElements({
      edges,
      enabled: false,
      nodes,
      viewport: { x: 0, y: 0, zoom: 1 },
      viewportSize: { width: 800, height: 600 },
    });

    expect(result.nodes).toBe(nodes);
    expect(result.edges).toBe(edges);
  });
  it('keeps viewport, selected-connected, active-edge, and ghost nodes without reordering or mutating inputs', () => {
    const nodes = [
      testNode('visible', 40, 40),
      testNode('hidden', 1400, 1400),
      testNode('selected-neighbor', 1620, 1200),
      testNode('selected', 1880, 1200, { selected: true }),
      testNode('active-source', 2200, 1200),
      testNode('active-target', 2520, 1200),
      testNode('ghost', 2840, 1200, { className: 'agent-ghost-node' }),
    ];
    const originalSnapshot = JSON.parse(JSON.stringify(nodes));
    const edges = [
      testEdge('edge-selected', 'selected', 'selected-neighbor'),
      testEdge('edge-hidden', 'hidden', 'active-source'),
      testEdge('edge-active', 'active-source', 'active-target'),
    ];

    const result = selectViewportCulledElements({
      activeEdgeIds: ['edge-active'],
      edges,
      ghostNodeIds: ['ghost'],
      nodes,
      overscan: 80,
      viewport,
      viewportSize,
    });

    expect(result.nodes.map((node) => node.id)).toEqual([
      'visible',
      'selected-neighbor',
      'selected',
      'active-source',
      'active-target',
      'ghost',
    ]);
    expect(result.edges.map((edge) => edge.id)).toEqual(['edge-selected', 'edge-active']);
    expect(nodes).toEqual(originalSnapshot);
    expect(result.nodes[0]).toBe(nodes[0]);
  });

  it('keeps a bounded subset for a 1000 node canvas while preserving source order', () => {
    const nodes = Array.from({ length: 1000 }, (_, index) => testNode(
      `node-${index}`,
      (index % 50) * 320,
      Math.floor(index / 50) * 180,
    ));

    const result = selectViewportCulledElements({
      edges: [],
      nodes,
      overscan: 128,
      viewport,
      viewportSize,
    });

    expect(result.nodes.length).toBeGreaterThan(0);
    expect(result.nodes.length).toBeLessThan(50);
    expect(result.nodes.map((node) => node.id)).toEqual(
      nodes.filter((node) => result.nodes.some((visible) => visible.id === node.id)).map((node) => node.id),
    );
  });

  it('does not mount offscreen neighbors when the selected node is already visible', () => {
    const nodes = [
      testNode('selected-visible', 40, 40, { selected: true }),
      testNode('offscreen-neighbor', 2400, 1800),
    ];
    const edges = [testEdge('connected', 'selected-visible', 'offscreen-neighbor')];

    const result = selectViewportCulledElements({
      edges,
      nodes,
      overscan: 80,
      viewport,
      viewportSize,
    });

    expect(result.nodes.map((node) => node.id)).toEqual(['selected-visible']);
    expect(result.edges).toHaveLength(0);
  });
});

describe('useViewportCulling', () => {
  it('coalesces repeated viewport changes into one animation-frame publication', () => {
    const callbacks: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const { result } = renderHook(() => useViewportCulling({ edges: [], nodes: [] }));

    act(() => {
      result.current.handleViewportChange(null, { x: 10, y: 20, zoom: 1 });
      result.current.handleViewportChange(null, { x: 30, y: 40, zoom: 1.2 });
      result.current.handleViewportChange(null, { x: 50, y: 60, zoom: 1.4 });
    });

    expect(result.current.viewport).toEqual({ x: 0, y: 0, zoom: 1 });
    expect(callbacks).toHaveLength(1);
    act(() => callbacks[0]!(16));
    expect(result.current.viewport).toEqual({ x: 50, y: 60, zoom: 1.4 });
  });
  it('keeps all nodes for fitView until React Flow reports the first real viewport', () => {
    const nodes = [
      testNode('far-a', 4800, 5200),
      testNode('far-b', 5200, 5200),
    ];
    const { result } = renderHook(() => useViewportCulling({
      edges: [],
      nodes,
      overscan: 80,
    }));
    const container = document.createElement('main');
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
      bottom: 600,
      height: 600,
      left: 0,
      right: 800,
      toJSON: () => ({}),
      top: 0,
      width: 800,
      x: 0,
      y: 0,
    } as DOMRect);

    act(() => result.current.containerRef(container));

    expect(result.current.nodes.map((node) => node.id)).toEqual(['far-a', 'far-b']);

    act(() => result.current.handleViewportInitialized({ getViewport: () => viewport }));

    expect(result.current.nodes).toHaveLength(0);
  });
});

function testNode(id: string, x: number, y: number, overrides: Partial<Node<TestNodeData>> = {}): Node<TestNodeData> {
  return {
    id,
    position: { x, y },
    data: { title: id, subtitle: id },
    height: 74,
    width: 220,
    ...overrides,
  };
}

function testEdge(id: string, source: string, target: string): Edge {
  return { id, source, target };
}
