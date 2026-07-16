import type { AgentCanvasPlan, CanvasEdge, CanvasNode, CanvasProject } from '@agent-canvas/domain';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStarterProject, resetAppStoreForTests, useAppStore } from '../../apps/renderer/src/app/app-store';
import { toFlowEdges, toFlowNodes } from '../../apps/renderer/src/canvas/node-types';
import { selectViewportCulledElements } from '../../apps/renderer/src/canvas/use-viewport-culling';

const viewport = { x: 0, y: 0, zoom: 1 };
const viewportSize = { width: 1024, height: 768 };

describe('large canvas integration', () => {
  beforeEach(() => {
    delete window.novusDesktop;
    resetAppStoreForTests();
  });

  it('bounds a 1000 lightweight-node canvas to viewport plus overscan while retaining selected and connected nodes', () => {
    const nodes = createReferenceNodes(1000).map((node) => (
      node.id === 'node-999' ? { ...node, position: { x: 16000, y: 8000 } } : node
    ));
    const edges: CanvasEdge[] = [{ id: 'edge-selected', source: 'node-998', target: 'node-999' }];
    const flowNodes = toFlowNodes(nodes).map((node) => (
      node.id === 'node-999' ? { ...node, selected: true } : node
    ));

    const result = selectViewportCulledElements({
      edges: toFlowEdges(edges),
      nodes: flowNodes,
      overscan: 128,
      viewport,
      viewportSize,
    });

    expect(result.nodes.length).toBeLessThan(50);
    expect(result.nodes.map((node) => node.id)).toEqual(expect.arrayContaining(['node-998', 'node-999']));
    expect(result.edges.map((edge) => edge.id)).toEqual(['edge-selected']);
  });

  it('keeps 200 image-result nodes bounded so the renderer never mounts every image at once', () => {
    const nodes = createImageNodes(200);
    const result = selectViewportCulledElements({
      edges: [],
      nodes: toFlowNodes(nodes),
      overscan: 128,
      viewport,
      viewportSize,
    });

    expect(result.nodes.length).toBeLessThan(40);
    expect(result.nodes.every((node) => node.type === 'image_result')).toBe(true);
  });

  it('adds Agent ghosts as one store update and keeps all ghost nodes through viewport culling', () => {
    const listener = vi.fn();
    const unsubscribe = useAppStore.subscribe(listener);
    const project = { ...createStarterProject(), nodes: createReferenceNodes(20), edges: [] };
    const plan = createGhostPlan(12);

    useAppStore.setState({ agentPlan: plan, project });
    unsubscribe();

    const existingNodeIds = new Set(project.nodes.map((node) => node.id));
    const ghostNodes = plan.transaction.operations.flatMap((operation) => (
      operation.kind === 'create_node' && !existingNodeIds.has(operation.node.id)
        ? [{ ...toFlowNodes([operation.node])[0]!, className: 'agent-ghost-node' }]
        : []
    ));
    const flowNodes = [...toFlowNodes(project.nodes), ...ghostNodes];
    const result = selectViewportCulledElements({
      edges: [],
      ghostNodeIds: ghostNodes.map((node) => node.id),
      nodes: flowNodes,
      overscan: 128,
      viewport,
      viewportSize,
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(result.nodes.map((node) => node.id)).toEqual(expect.arrayContaining(ghostNodes.map((node) => node.id)));
  });
});

function createReferenceNodes(count: number): CanvasNode[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `node-${index}`,
    type: 'reference',
    position: {
      x: (index % 50) * 320,
      y: Math.floor(index / 50) * 180,
    },
    data: { assetId: `asset-${index}`, role: 'product_identity' },
  }));
}

function createImageNodes(count: number): CanvasNode[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `image-${index}`,
    type: 'image_result',
    position: {
      x: (index % 25) * 320,
      y: Math.floor(index / 25) * 180,
    },
    data: {
      assetId: `asset-image-${index}`,
      modelId: 'model-image',
      parentNodeIds: [],
      referenceAssetIds: [],
    },
  }));
}

function createGhostPlan(count: number): AgentCanvasPlan {
  return {
    id: 'agent-plan-large-ghost',
    state: 'waiting_for_confirmation',
    requestedCapabilities: ['model_execution'],
    confirmations: {},
    conflicts: [],
    jobCount: 0,
    transaction: {
      id: 'agent-ghost-transaction',
      label: 'Insert ghost nodes',
      operations: Array.from({ length: count }, (_, index) => ({
        kind: 'create_node',
        node: {
          id: `ghost-${index}`,
          type: 'review',
          position: { x: 20000 + index * 260, y: 12000 },
          data: { keep: [], change: [`ghost-${index}`], never: [] },
        },
      })),
    },
  };
}
