import { act, cleanup, render, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import type { ReactNode } from 'react';
import { createCanvasModuleNode, type CanvasEdge, type CanvasNode, type CanvasProject } from '@agent-canvas/domain';
import {
  createStarterProject,
  replaceProjectPersistenceClientForTests,
  resetAppStoreForTests,
  useAppStore,
} from '../../apps/renderer/src/app/app-store';
import type {
  ProjectCommitRequest,
  ProjectCommitResult,
  ProjectPersistenceClient,
} from '../../apps/renderer/src/app/desktop-persistence';
import { CanvasWorkspace } from '../../apps/renderer/src/canvas/CanvasWorkspace';

const flowHarness = vi.hoisted(() => ({
  initCalls: 0,
  moveCalls: 0,
  onNodesChange: null as null | ((changes: Array<{ id: string; selected: boolean; type: 'select' }>) => void),
  nodeSnapshots: [] as Array<Array<{ id: string; position?: { x: number; y: number }; selected?: boolean; type?: string }>>,
  edgeSnapshots: [] as Array<Array<{ id: string; source: string; target: string }>>,
  visibleElementsOnly: [] as Array<boolean | undefined>,
  selectedNodeIds: new Set<string>(),
  viewport: { x: 0, y: 0, zoom: 1 },
}));

vi.mock('@xyflow/react', async (importOriginal) => {
  const React = await import('react');
  const actual = await importOriginal<typeof import('@xyflow/react')>();
  const storeApi = { setState: vi.fn() };
  const passthrough = ({ children }: { children?: ReactNode }) => (
    React.createElement(React.Fragment, null, children)
  );
  return {
    applyNodeChanges: actual.applyNodeChanges,
    Background: () => null,
    BackgroundVariant: { Dots: 'dots' },
    ConnectionLineType: { Straight: 'straight' },
    ConnectionMode: { Loose: 'loose' },
    Controls: () => null,
    Handle: () => null,
    MiniMap: () => null,
    Position: { Left: 'left', Right: 'right' },
    SelectionMode: { Partial: 'partial' },
    useStoreApi: () => storeApi,
    useStore: (selector: (state: {
      nodeLookup: Map<string, { internals: { handleBounds?: unknown } }>;
      transform: [number, number, number];
    }) => unknown) => (
      selector({ nodeLookup: new Map(), transform: [flowHarness.viewport.x, flowHarness.viewport.y, flowHarness.viewport.zoom] })
    ),
    useUpdateNodeInternals: () => () => undefined,
    ReactFlow: (props: {
      children?: ReactNode;
      edges: Array<{ id: string; selected?: boolean; source: string; target: string }>;
      nodes: Array<{ className?: string; data?: Record<string, unknown>; id: string; selected?: boolean; type?: string }>;
      onlyRenderVisibleElements?: boolean;
      onInit?: (instance: { getViewport: () => typeof flowHarness.viewport }) => void;
      onMove?: (event: null, viewport: typeof flowHarness.viewport) => void;
      onNodesChange?: (changes: Array<{ id: string; selected: boolean; type: 'select' }>) => void;
      onSelectionChange?: (selection: { edges: Array<{ id: string }>; nodes: Array<{ id: string }> }) => void;
    }) => {
      flowHarness.nodeSnapshots.push(props.nodes);
      flowHarness.edgeSnapshots.push(props.edges);
      flowHarness.visibleElementsOnly.push(props.onlyRenderVisibleElements);
      flowHarness.onNodesChange = props.onNodesChange ?? null;
      React.useEffect(() => {
        if (props.onInit) {
          flowHarness.initCalls += 1;
          props.onInit({ getViewport: () => flowHarness.viewport });
        }
        flowHarness.moveCalls += 1;
        props.onMove?.(null, flowHarness.viewport);
        props.onSelectionChange?.({
          edges: [],
          nodes: props.nodes.filter((node) => flowHarness.selectedNodeIds.has(node.id)),
        });
      }, [props]);

      return React.createElement(
        'div',
        { 'data-testid': 'mock-react-flow' },
        props.nodes.map((node) => React.createElement(
          'div',
          {
            'data-ghost': typeof node.className === 'string' && node.className.includes('agent-ghost-node') ? 'node' : 'false',
            'data-node-id': node.id,
            'data-node-type': node.type,
            'data-selected': node.selected ? 'true' : 'false',
            'data-testid': 'flow-node',
            key: node.id,
          },
          String(node.data?.resultAssetId ?? node.id),
        )),
        props.children,
      );
    },
    ReactFlowProvider: passthrough,
  };
});

describe('large canvas integration', () => {
  beforeEach(() => {
    delete window.novusDesktop;
    flowHarness.initCalls = 0;
    flowHarness.moveCalls = 0;
    flowHarness.onNodesChange = null;
    flowHarness.nodeSnapshots = [];
    flowHarness.edgeSnapshots = [];
    flowHarness.visibleElementsOnly = [];
    flowHarness.selectedNodeIds = new Set();
    flowHarness.viewport = { x: 0, y: 0, zoom: 1 };
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      bottom: 768,
      height: 768,
      left: 0,
      right: 1024,
      toJSON: () => ({}),
      top: 0,
      width: 1024,
      x: 0,
      y: 0,
    } as DOMRect);
    replaceProjectPersistenceClientForTests(createMockClient());
    resetAppStoreForTests();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('passes all 1000 nodes and selected connection endpoints to React Flow with native visibility enabled', async () => {
    const nodes = createModuleNodes(1000).map((node) => (
      node.id === 'module-999' ? { ...node, position: { x: 16000, y: 8000 } } : node
    ));
    const edges: CanvasEdge[] = [{ id: 'edge-selected', source: 'module-998', target: 'module-999' }];
    flowHarness.selectedNodeIds = new Set(['module-999']);
    useAppStore.setState({
      project: projectWith({ edges, nodes }),
    });

    render(createElement(CanvasWorkspace));

    await waitFor(() => expect(flowHarness.onNodesChange).not.toBeNull());
    act(() => flowHarness.onNodesChange?.([{ id: 'module-999', selected: true, type: 'select' }]));
    await waitFor(() => expect(flowHarness.nodeSnapshots.at(-1)?.find((node) => node.id === 'module-999')?.selected).toBe(true));
    const receivedNodes = flowHarness.nodeSnapshots.at(-1)!;
    const receivedIds = receivedNodes.map((node) => node.id);
    expect(flowHarness.initCalls).toBeGreaterThan(0);
    expect(receivedIds).toEqual(nodes.map((node) => node.id));
    expect(flowHarness.visibleElementsOnly.at(-1)).toBe(true);
    expect(flowHarness.edgeSnapshots.at(-1)).toEqual([
      expect.objectContaining({ id: 'edge-selected', source: 'module-998', target: 'module-999' }),
    ]);
    for (const edge of flowHarness.edgeSnapshots.at(-1)!) {
      expect(receivedIds).toContain(edge.source);
      expect(receivedIds).toContain(edge.target);
    }
  });

  it('passes all 200 image-generation nodes to React Flow with native visibility enabled', async () => {
    useAppStore.setState({
      project: projectWith({ edges: [], nodes: createModuleNodes(200, 'image_generation') }),
    });

    render(createElement(CanvasWorkspace));

    await waitFor(() => expect(flowHarness.nodeSnapshots.at(-1)).toHaveLength(200));
    expect(flowHarness.initCalls).toBeGreaterThan(0);
    expect(flowHarness.nodeSnapshots.at(-1)?.every((node) => node.type === 'module')).toBe(true);
    expect(flowHarness.visibleElementsOnly.at(-1)).toBe(true);
  });

  it('preserves unchanged React Flow node identities when one durable node moves', async () => {
    const nodes = Array.from({ length: 120 }, (_, index) => createCanvasModuleNode(
      `module-${index}`,
      'image_input',
      { x: (index % 12) * 280, y: Math.floor(index / 12) * 180 },
    ));
    useAppStore.setState({ project: projectWith({ edges: [], nodes }) });
    render(createElement(CanvasWorkspace));

    await waitFor(() => expect(flowHarness.nodeSnapshots.at(-1)).toHaveLength(120));
    const before = flowHarness.nodeSnapshots.at(-1)!;
    const stableBefore = before.find((node) => node.id === 'module-1');
    const offscreenBefore = before.find((node) => node.id === 'module-119');
    const movedBefore = before.find((node) => node.id === 'module-0');
    expect(stableBefore).toBeDefined();
    expect(offscreenBefore).toBeDefined();
    expect(movedBefore).toBeDefined();
    const snapshotCount = flowHarness.nodeSnapshots.length;

    act(() => useAppStore.setState((state) => ({
      project: {
        ...state.project,
        nodes: state.project.nodes.map((node) => node.id === 'module-0'
          ? { ...node, position: { x: 48, y: 64 } }
          : node),
      },
    })));

    await waitFor(() => {
      expect(flowHarness.nodeSnapshots.length).toBeGreaterThan(snapshotCount);
      expect(flowHarness.nodeSnapshots.at(-1)?.find((node) => node.id === 'module-0')?.position).toEqual({ x: 48, y: 64 });
    });
    const after = flowHarness.nodeSnapshots.at(-1)!;
    expect(after.find((node) => node.id === 'module-1')).toBe(stableBefore);
    expect(after.find((node) => node.id === 'module-119')).toBe(offscreenBefore);
    expect(after.find((node) => node.id === 'module-0')).not.toBe(movedBefore);
  });
  it('does not mount the retired canvas-mutating Agent composer or ghost nodes', async () => {
    render(createElement(CanvasWorkspace));
    await waitFor(() => expect(flowHarness.initCalls).toBeGreaterThan(0));

    expect(document.querySelector('.agent-composer')).toBeNull();
    expect(document.querySelectorAll('[data-ghost="node"]')).toHaveLength(0);
    expect(useAppStore.getState().agentPlan).toBeNull();
  });
});

function projectWith({ edges, nodes }: { edges: CanvasEdge[]; nodes: CanvasNode[] }): CanvasProject {
  const base = createStarterProject();
  return {
    ...base,
    edges,
    nodes,
  };
}

function createModuleNodes(count: number, moduleType: 'image_input' | 'image_generation' = 'image_input'): CanvasNode[] {
  return Array.from({ length: count }, (_, index) => createCanvasModuleNode(
    `module-${index}`,
    moduleType,
    { x: (index % 20) * 280, y: Math.floor(index / 20) * 180 },
  ));
}
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

function createMockClient(overrides: Partial<ProjectPersistenceClient> = {}): ProjectPersistenceClient {
  return {
    close: overrides.close ?? (async () => {}),
    commit: overrides.commit ?? (async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: nextProject,
      revision: 1,
    })),
    hydrate: overrides.hydrate ?? (async () => ({
      availableSnapshotIds: [],
      mode: 'browser',
      project: createStarterProject(),
      revision: 0,
      saveStatus: 'pending',
    })),
    restore: overrides.restore ?? (async () => ({
      availableSnapshotIds: [],
      project: createStarterProject(),
      revision: 0,
      saveStatus: 'saved',
    })),
    stablePoint: overrides.stablePoint ?? (async () => ({
      availableSnapshotIds: [],
      project: createStarterProject(),
      revision: 0,
    })),
  };
}
