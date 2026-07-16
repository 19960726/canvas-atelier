import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Edge, Node, Viewport } from '@xyflow/react';

export interface ViewportSize {
  width: number;
  height: number;
}

export interface CanvasNodeSize {
  width: number;
  height: number;
}

export const DEFAULT_CANVAS_NODE_SIZE: CanvasNodeSize = Object.freeze({ width: 250, height: 104 });
export const DEFAULT_VIEWPORT_OVERSCAN = 256;

export interface ViewportCullingInput<
  TNode extends Node = Node,
  TEdge extends Edge = Edge,
> {
  activeEdgeIds?: Iterable<string>;
  activeNodeIds?: Iterable<string>;
  edges: readonly TEdge[];
  enabled?: boolean;
  ghostEdgeIds?: Iterable<string>;
  ghostNodeIds?: Iterable<string>;
  nodeSize?: CanvasNodeSize;
  nodes: readonly TNode[];
  overscan?: number;
  selectedNodeIds?: Iterable<string>;
  viewport: Viewport | null;
  viewportSize: ViewportSize | null;
}

export interface ViewportCullingResult<
  TNode extends Node = Node,
  TEdge extends Edge = Edge,
> {
  edges: TEdge[];
  nodes: TNode[];
}

interface ViewportInitializer {
  getViewport: () => Viewport;
}

export function selectViewportCulledElements<
  TNode extends Node = Node,
  TEdge extends Edge = Edge,
>(input: ViewportCullingInput<TNode, TEdge>): ViewportCullingResult<TNode, TEdge> {
  if (
    input.enabled === false ||
    input.viewport === null ||
    input.viewportSize === null ||
    input.viewportSize.width <= 0 ||
    input.viewportSize.height <= 0 ||
    input.viewport.zoom <= 0
  ) {
    return { edges: [...input.edges], nodes: [...input.nodes] };
  }

  const nodeSize = input.nodeSize ?? DEFAULT_CANVAS_NODE_SIZE;
  const viewportBounds = getWorldViewportBounds(
    input.viewport,
    input.viewportSize,
    input.overscan ?? DEFAULT_VIEWPORT_OVERSCAN,
  );
  const activeEdgeIds = toSet(input.activeEdgeIds);
  const activeNodeIds = toSet(input.activeNodeIds);
  const ghostEdgeIds = toSet(input.ghostEdgeIds);
  const ghostNodeIds = toSet(input.ghostNodeIds);
  const selectedNodeIds = toSet(input.selectedNodeIds);
  const retainedNodeIds = new Set<string>(activeNodeIds);
  const selectedAnchorNodeIds = new Set<string>();

  for (const node of input.nodes) {
    if (node.selected || selectedNodeIds.has(node.id)) {
      retainedNodeIds.add(node.id);
      selectedAnchorNodeIds.add(node.id);
    }
    if (ghostNodeIds.has(node.id) || hasClassName(node, 'agent-ghost-node')) retainedNodeIds.add(node.id);
  }

  for (const edge of input.edges) {
    const edgeIsActive = edge.selected || activeEdgeIds.has(edge.id) || ghostEdgeIds.has(edge.id) || hasClassName(edge, 'agent-ghost-edge');
    if (edgeIsActive) {
      retainedNodeIds.add(edge.source);
      retainedNodeIds.add(edge.target);
    }
  }

  for (const edge of input.edges) {
    if (selectedAnchorNodeIds.has(edge.source) || selectedAnchorNodeIds.has(edge.target)) {
      retainedNodeIds.add(edge.source);
      retainedNodeIds.add(edge.target);
    }
  }

  const visibleNodeIds = new Set<string>();
  const nodes = input.nodes.filter((node) => {
    if (retainedNodeIds.has(node.id)) {
      visibleNodeIds.add(node.id);
      return true;
    }
    if (!intersects(viewportBounds, getNodeBounds(node, nodeSize))) {
      return false;
    }
    visibleNodeIds.add(node.id);
    return true;
  });

  const edges = input.edges.filter((edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target));
  return { edges, nodes };
}

export function useViewportCulling<
  TNode extends Node = Node,
  TEdge extends Edge = Edge,
>(input: Omit<ViewportCullingInput<TNode, TEdge>, 'viewport' | 'viewportSize'>) {
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const [isViewportInitialized, setIsViewportInitialized] = useState(false);
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
  const [viewportSize, setViewportSize] = useState<ViewportSize | null>(null);

  const containerRef = useCallback((element: HTMLElement | null) => {
    resizeObserverRef.current?.disconnect();
    resizeObserverRef.current = null;

    if (element === null) {
      setViewportSize(null);
      return;
    }

    const publishSize = () => {
      const rect = element.getBoundingClientRect();
      setViewportSize({ width: rect.width, height: rect.height });
    };
    publishSize();

    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(publishSize);
      observer.observe(element);
      resizeObserverRef.current = observer;
    }
  }, []);

  useEffect(() => () => {
    resizeObserverRef.current?.disconnect();
    resizeObserverRef.current = null;
  }, []);

  const publishViewport = useCallback((nextViewport: Viewport) => {
    setViewport(nextViewport);
    setIsViewportInitialized(true);
  }, []);

  const handleViewportChange = useCallback((_event: MouseEvent | TouchEvent | null, nextViewport: Viewport) => {
    publishViewport(nextViewport);
  }, [publishViewport]);

  const handleViewportInitialized = useCallback((instance: ViewportInitializer) => {
    publishViewport(instance.getViewport());
  }, [publishViewport]);

  const cullingEnabled = input.enabled !== false && isViewportInitialized;

  const culled = useMemo(() => selectViewportCulledElements({
    ...input,
    enabled: cullingEnabled,
    viewport,
    viewportSize,
  }), [
    cullingEnabled,
    input.activeEdgeIds,
    input.activeNodeIds,
    input.edges,
    input.ghostEdgeIds,
    input.ghostNodeIds,
    input.nodeSize,
    input.nodes,
    input.overscan,
    input.selectedNodeIds,
    viewport,
    viewportSize,
  ]);

  return {
    ...culled,
    containerRef,
    handleViewportChange,
    handleViewportInitialized,
    isViewportInitialized,
    viewport,
    viewportSize,
  };
}

interface Rect {
  bottom: number;
  left: number;
  right: number;
  top: number;
}

function getWorldViewportBounds(viewport: Viewport, viewportSize: ViewportSize, overscan: number): Rect {
  const overscanWorld = Math.max(0, overscan) / viewport.zoom;
  return {
    bottom: (viewportSize.height - viewport.y) / viewport.zoom + overscanWorld,
    left: -viewport.x / viewport.zoom - overscanWorld,
    right: (viewportSize.width - viewport.x) / viewport.zoom + overscanWorld,
    top: -viewport.y / viewport.zoom - overscanWorld,
  };
}

function getNodeBounds(node: Node, fallback: CanvasNodeSize): Rect {
  const measured = (node as { measured?: { width?: number; height?: number } }).measured;
  const width = finiteNumber(node.width) ?? finiteNumber(measured?.width) ?? fallback.width;
  const height = finiteNumber(node.height) ?? finiteNumber(measured?.height) ?? fallback.height;
  return {
    bottom: node.position.y + height,
    left: node.position.x,
    right: node.position.x + width,
    top: node.position.y,
  };
}

function intersects(left: Rect, right: Rect): boolean {
  return left.left <= right.right
    && left.right >= right.left
    && left.top <= right.bottom
    && left.bottom >= right.top;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function toSet(values: Iterable<string> | undefined): Set<string> {
  return values === undefined ? new Set() : new Set(values);
}

function hasClassName(value: { className?: unknown }, className: string): boolean {
  return typeof value.className === 'string' && value.className.split(/\s+/u).includes(className);
}
