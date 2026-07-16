import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import type { ReactNode } from 'react';
import type { CanvasEdge, CanvasNode, CanvasProject } from '@agent-canvas/domain';
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
  selectedNodeIds: new Set<string>(),
  viewport: { x: 0, y: 0, zoom: 1 },
}));

vi.mock('@xyflow/react', async () => {
  const React = await import('react');
  const passthrough = ({ children }: { children?: ReactNode }) => (
    React.createElement(React.Fragment, null, children)
  );
  return {
    Background: () => null,
    BackgroundVariant: { Dots: 'dots' },
    Controls: () => null,
    Handle: () => null,
    MiniMap: () => null,
    Position: { Left: 'left', Right: 'right' },
    ReactFlow: (props: {
      children?: ReactNode;
      edges: Array<{ id: string; selected?: boolean }>;
      nodes: Array<{ className?: string; data?: Record<string, unknown>; id: string; selected?: boolean; type?: string }>;
      onInit?: (instance: { getViewport: () => typeof flowHarness.viewport }) => void;
      onMove?: (event: null, viewport: typeof flowHarness.viewport) => void;
      onSelectionChange?: (selection: { edges: Array<{ id: string }>; nodes: Array<{ id: string }> }) => void;
    }) => {
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

  it('renders CanvasWorkspace with 1000 lightweight nodes while mounting only the culled viewport and selected connection', async () => {
    const nodes = createReferenceNodes(1000).map((node) => (
      node.id === 'node-999' ? { ...node, position: { x: 16000, y: 8000 } } : node
    ));
    const edges: CanvasEdge[] = [{ id: 'edge-selected', source: 'node-998', target: 'node-999' }];
    flowHarness.selectedNodeIds = new Set(['node-999']);
    useAppStore.setState({
      project: projectWith({ edges, nodes }),
    });

    render(createElement(CanvasWorkspace));

    await waitFor(() => expect(screen.getAllByTestId('flow-node').length).toBeLessThan(80));
    const mountedIds = mountedFlowNodeIds();
    expect(flowHarness.initCalls).toBeGreaterThan(0);
    expect(mountedIds).toEqual(expect.arrayContaining(['node-998', 'node-999']));
    expect(mountedIds[0]).toBe('node-0');
  });

  it('renders CanvasWorkspace with 200 image results without mounting every image result node after viewport initialization', async () => {
    useAppStore.setState({
      project: projectWith({ edges: [], nodes: createImageNodes(200) }),
    });

    render(createElement(CanvasWorkspace));

    await waitFor(() => expect(mountedFlowNodesByType('image_result').length).toBeLessThan(50));
    expect(flowHarness.initCalls).toBeGreaterThan(0);
    expect(mountedFlowNodesByType('image_result').length).toBeGreaterThan(0);
  });

  it('previews Agent ghost nodes through the real composer flow as one store update before confirmation', async () => {
    render(createElement(CanvasWorkspace));
    const listener = vi.fn();
    const unsubscribe = useAppStore.subscribe(listener);
    const textarea = document.querySelector<HTMLTextAreaElement>('.agent-composer textarea');
    const sendButton = document.querySelector<HTMLButtonElement>('.agent-composer__footer button');
    if (!textarea || !sendButton) throw new Error('Missing Agent composer');

    fireEvent.change(textarea, { target: { value: 'Create a large-canvas ghost preview' } });
    fireEvent.click(sendButton);

    await waitFor(() => expect(useAppStore.getState().agentPlan?.state).toBe('waiting_for_confirmation'));
    unsubscribe();

    expect(listener).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(document.querySelectorAll('[data-ghost="node"]').length).toBe(1));

    await useAppStore.getState().confirmAgentPlan({ deleteNodes: false, models: false, skillWriteback: false });

    await waitFor(() => expect(useAppStore.getState().agentPlan?.state).toBe('reviewing_results'));
    expect(document.querySelectorAll('[data-ghost="node"]')).toHaveLength(0);
    expect(mountedFlowNodeIds().some((id) => id.startsWith('agent-review-'))).toBe(true);
  });
});

function mountedFlowNodeIds(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-testid="flow-node"]'))
    .map((element) => element.dataset.nodeId ?? '');
}

function mountedFlowNodesByType(type: string): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(`[data-node-type="${type}"]`));
}

function projectWith({ edges, nodes }: { edges: CanvasEdge[]; nodes: CanvasNode[] }): CanvasProject {
  const base = createStarterProject();
  return {
    ...base,
    edges,
    nodes,
  };
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
