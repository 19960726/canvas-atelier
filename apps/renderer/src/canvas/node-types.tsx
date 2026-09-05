import { memo } from 'react';
import type { Edge, Node, NodeProps, NodeTypes } from '@xyflow/react';
import type { CanvasEdge, CanvasModuleNodeData, CanvasNode, ReferenceRole } from '@agent-canvas/domain';
import { CanvasNodeCard, type CanvasNodePresentation, type CanvasNodeTone } from './CanvasNodeCard';
import { ImageResultNode } from '../jobs/ImageResultNode';
import { ModuleNodeCard } from './ModuleNodeCard';
import type { WorkspaceApi } from '../app/workspace-api';

export type CanvasNodeData = Record<string, unknown> & CanvasNodePresentation;
export type CanvasFlowNodeData = CanvasNodeData | (Record<string, unknown> & CanvasModuleNodeData);
export interface CanvasFlowEdgeData {
  readonly order?: number;
  readonly onCancel?: () => void;
}

export interface ModuleNodeRuntimeContext {
  readonly imageGenerationRoutes: readonly {
    readonly provider: string;
    readonly modelRoute: string;
    readonly displayName: string;
    readonly modelId?: string;
    readonly capabilities: readonly string[];
    readonly capabilityStatus?: 'complete' | 'incomplete';
    readonly constraints?: import('@agent-canvas/desktop-core').ProviderBridgeProfile['constraints'];
  }[];
  readonly videoGenerationRoutes?: readonly {
    readonly provider: string;
    readonly modelRoute: string;
    readonly displayName: string;
    readonly modelId?: string;
    readonly capabilities: readonly string[];
    readonly capabilityStatus?: 'complete' | 'incomplete';
    readonly constraints?: import('@agent-canvas/desktop-core').ProviderBridgeProfile['constraints'];
  }[];
  readonly reverseAgentRoutes: readonly {
    readonly provider: string;
    readonly modelRoute: string;
    readonly displayName: string;
    readonly modelId?: string;
    readonly capabilities: readonly string[];
    readonly capabilityStatus?: 'complete' | 'incomplete';
    readonly constraints?: import('@agent-canvas/desktop-core').ProviderBridgeProfile['constraints'];
  }[];
  readonly storyboardRoutes: readonly {
    readonly provider: string;
    readonly modelRoute: string;
    readonly displayName: string;
    readonly modelId?: string;
    readonly capabilities: readonly string[];
    readonly capabilityStatus?: 'complete' | 'incomplete';
    readonly constraints?: import('@agent-canvas/desktop-core').ProviderBridgeProfile['constraints'];
  }[];
  readonly onGenerateImage: WorkspaceApi['generateImage'];
  readonly onReversePrompt: WorkspaceApi['reversePrompt'];
  readonly onCancelJob: WorkspaceApi['cancelJob'];
  readonly onGenerateStoryboard: WorkspaceApi['generateStoryboard'];
  readonly generationEditorExpandedNodeId: string | null;
  readonly onOpenGenerationEditor: (nodeId: string) => void;
  readonly onCloseGenerationEditor: () => void;
  readonly resultOutputMenuNodeId: string | null;
  readonly onResultOutputMenuChange: (nodeId: string, open: boolean) => void;
}

const referenceTitles: Record<ReferenceRole, string> = {
  product_identity: '\u4ea7\u54c1\u8eab\u4efd\u53c2\u8003',
  scene_composition: '\u573a\u666f\u6784\u56fe\u53c2\u8003',
  prop_reference: '\u9053\u5177\u53c2\u8003',
  material_lighting: '\u6750\u8d28\u4e0e\u5149\u7167\u53c2\u8003',
  placement_preview: '\u6446\u653e\u9884\u89c8\u53c2\u8003',
};

const referenceTones: Record<ReferenceRole, CanvasNodeTone> = {
  product_identity: 'teal',
  scene_composition: 'blue',
  prop_reference: 'amber',
  material_lighting: 'amber',
  placement_preview: 'blue',
};

function getModelJobTone(status: Extract<CanvasNode, { type: 'model_job' }>['data']['job']['status']): CanvasNodeTone {
  if (status === 'failed') return 'red';
  if (status === 'completed') return 'teal';
  return 'slate';
}

function getMemoryDiffTone(status: Extract<CanvasNode, { type: 'memory_diff' }>['data']['status']): CanvasNodeTone {
  return status === 'approved' || status === 'synced' ? 'blue' : 'amber';
}

function getViewData(node: CanvasNode): CanvasFlowNodeData {
  switch (node.type) {
    case 'reference':
      return {
        kind: node.type,
        tone: referenceTones[node.data.role],
        eyebrow: 'Reference',
        title: referenceTitles[node.data.role],
        subtitle: `\u8d44\u6e90 ${node.data.assetId}`,
        status: 'Reference',
      };
    case 'placement_preview':
      return {
        kind: node.type,
        tone: 'blue',
        eyebrow: 'Placement',
        title: '\u6446\u653e\u9884\u89c8',
        subtitle: `${node.data.board.aspectRatio} / ${node.data.objects.length} \u4e2a\u5bf9\u8c61`,
        status: `${node.data.objects.length} layers`,
      };
    case 'prompt':
      return {
        kind: node.type,
        tone: 'teal',
        eyebrow: 'Agent plan',
        title: 'Agent \u751f\u6210\u8ba1\u5212',
        subtitle: node.data.prompt || '\u7b49\u5f85\u63d0\u793a\u8bcd',
        status: node.data.prompt.trim().length > 0 ? 'Ready' : 'Draft',
      };
    case 'model_job':
      return {
        kind: node.type,
        tone: getModelJobTone(node.data.job.status),
        eyebrow: 'Model job',
        title: '\u6a21\u578b\u4efb\u52a1',
        subtitle: `${node.data.job.displayName ?? node.data.job.modelRoute ?? node.data.job.modelId} / ${node.data.job.status}`,
        status: node.data.job.status,
      };
    case 'image_result':
      return {
        kind: node.type,
        tone: 'teal',
        eyebrow: 'Image result',
        title: '\u751f\u6210\u7ed3\u679c',
        subtitle: node.data.displayName ?? node.data.modelRoute ?? node.data.modelId,
        status: 'Result',
        resultAssetId: node.data.assetId,
      };
    case 'video_result':
      return {
        kind: node.type,
        tone: 'blue',
        eyebrow: 'Video result',
        title: '生成视频',
        subtitle: node.data.displayName ?? node.data.modelRoute ?? node.data.modelId,
        status: node.data.durationSeconds === undefined ? 'Result' : `${node.data.durationSeconds}s`,
        resultAssetId: node.data.assetId,
      };    case 'review':
      return {
        kind: node.type,
        tone: 'amber',
        eyebrow: 'Review',
        title: 'KEEP / CHANGE / NEVER',
        subtitle: `${node.data.keep.length + node.data.change.length + node.data.never.length} \u6761\u8981\u70b9`,
        status: 'Review',
      };
    case 'memory_diff':
      return {
        kind: node.type,
        tone: getMemoryDiffTone(node.data.status),
        eyebrow: 'Memory diff',
        title: 'Skill \u8bb0\u5fc6\u5dee\u5f02',
        subtitle: node.data.status,
        status: node.data.status,
      };
    case 'agent_plan':
      return {
        kind: node.type,
        tone: 'blue',
        eyebrow: 'Agent plan',
        title: 'Agent \u65b9\u6848',
        subtitle: node.data.plan.state,
        status: node.data.plan.state,
      };
    case 'module':
      return node.data as Record<string, unknown> & CanvasModuleNodeData;
  }
}

const SharedCanvasNode = memo(function SharedCanvasNode({ data, selected }: NodeProps) {
  const nodeData = data as unknown as CanvasNodePresentation;
  return <CanvasNodeCard {...nodeData} selected={selected} />;
});

export const nodeTypes: NodeTypes = {
  reference: SharedCanvasNode,
  prompt: SharedCanvasNode,
  placement_preview: SharedCanvasNode,
  model_job: SharedCanvasNode,
  image_result: ImageResultNode,
  review: SharedCanvasNode,
  memory_diff: SharedCanvasNode,
  agent_plan: SharedCanvasNode,
  module: ModuleNodeCard,
};

function stableModuleRuntimeContext(
  context: ModuleNodeRuntimeContext,
): Omit<ModuleNodeRuntimeContext, 'generationEditorExpandedNodeId' | 'resultOutputMenuNodeId'> {
  const {
    generationEditorExpandedNodeId: _generationEditorExpandedNodeId,
    resultOutputMenuNodeId: _resultOutputMenuNodeId,
    ...stable
  } = context;
  return stable;
}
export function toFlowNodes(
  nodes: readonly CanvasNode[],
  moduleRuntimeContext?: ModuleNodeRuntimeContext,
  durableEdges: readonly CanvasEdge[] = [],
): Node<CanvasFlowNodeData>[] {
  const connectedPortIdsByNode = new Map<string, Set<string>>();
  const connectedPortKeysByNode = new Map<string, Set<string>>();
  const connectedDirectionsByNode = new Map<string, Set<'input' | 'output'>>();
  const markConnected = (nodeId: string, direction: 'input' | 'output', portId: string | undefined) => {
    if (!portId) return;
    const ports = connectedPortIdsByNode.get(nodeId) ?? new Set<string>();
    ports.add(portId);
    connectedPortIdsByNode.set(nodeId, ports);
    const keys = connectedPortKeysByNode.get(nodeId) ?? new Set<string>();
    keys.add(`${direction}:${portId}`);
    connectedPortKeysByNode.set(nodeId, keys);
  };
  for (const edge of durableEdges) {
    markConnected(edge.source, 'output', edge.sourcePortId);
    markConnected(edge.target, 'input', edge.targetPortId);
    const sourceDirections = connectedDirectionsByNode.get(edge.source) ?? new Set<'input' | 'output'>();
    sourceDirections.add('output');
    connectedDirectionsByNode.set(edge.source, sourceDirections);
    const targetDirections = connectedDirectionsByNode.get(edge.target) ?? new Set<'input' | 'output'>();
    targetDirections.add('input');
    connectedDirectionsByNode.set(edge.target, targetDirections);
  }

  const stableRuntime = moduleRuntimeContext === undefined
    ? undefined
    : stableModuleRuntimeContext(moduleRuntimeContext);

  return nodes.map((node) => ({
    id: node.id,
    type: node.type,
    position: node.position,
    draggable: node.locked !== true,
    ...(node.type === 'module'
      ? {
        className: `canvas-flow-node--module-${node.data.moduleType}`,
      }
      : {}),
    data: {
      ...getViewData(node),
      locked: node.locked === true,
      ...(node.type === 'module' && moduleRuntimeContext && stableRuntime ? {
        ...stableRuntime,
        generationEditorExpanded: moduleRuntimeContext.generationEditorExpandedNodeId === node.id,
        resultOutputMenuOpen: moduleRuntimeContext.resultOutputMenuNodeId === node.id,
      } : {}),
      ...(node.type === 'module' && connectedPortIdsByNode.has(node.id)
        ? {
          connectedPortIds: [...connectedPortIdsByNode.get(node.id)!],
          connectedPortKeys: [...connectedPortKeysByNode.get(node.id)!],
        }
        : {}),
      ...(node.type !== 'module' && connectedDirectionsByNode.has(node.id)
        ? {
          inputConnected: connectedDirectionsByNode.get(node.id)!.has('input'),
          outputConnected: connectedDirectionsByNode.get(node.id)!.has('output'),
        }
        : {}),
    },
  }));
}

export function reconcileFlowNodes<TData extends Record<string, unknown>>(
  previous: readonly Node<TData>[],
  next: readonly Node<TData>[],
): Node<TData>[] {
  if (previous.length === 0 || next.length === 0) return [...next];
  const previousById = new Map(previous.map((node) => [node.id, node]));
  return next.map((nextNode) => {
    const previousNode = previousById.get(nextNode.id);
    return previousNode !== undefined && sameFlowNode(previousNode, nextNode)
      ? previousNode
      : nextNode;
  });
}

function sameFlowNode<TData extends Record<string, unknown>>(left: Node<TData>, right: Node<TData>): boolean {
  return left.id === right.id
    && left.type === right.type
    && left.position.x === right.position.x
    && left.position.y === right.position.y
    && left.draggable === right.draggable
    && left.selectable === right.selectable
    && left.connectable === right.connectable
    && left.deletable === right.deletable
    && left.focusable === right.focusable
    && left.hidden === right.hidden
    && left.className === right.className
    && left.parentId === right.parentId
    && left.zIndex === right.zIndex
    && sameFlowNodeData(left.data, right.data);
}

function sameFlowNodeData(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  if (left === right) return true;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!Object.prototype.hasOwnProperty.call(right, key)) return false;
    const leftValue = left[key];
    const rightValue = right[key];
    if (Object.is(leftValue, rightValue)) continue;
    if (Array.isArray(leftValue) && Array.isArray(rightValue) && samePrimitiveArray(leftValue, rightValue)) continue;
    return false;
  }
  return true;
}

function samePrimitiveArray(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
}
const EMPTY_FLOW_EDGES: Edge[] = [];

export function toFlowEdges(edges: readonly CanvasEdge[], onDeleteEdge?: (edgeId: string) => void): Edge[] {
  if (edges.length === 0) return EMPTY_FLOW_EDGES;
  return edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    // Every durable relation uses the same visibly curved connector. This is
    // deliberately not SmoothStep: workflow edges must never become elbows.
    type: 'canvas-bezier',
    label: edge.label === 'agent-plan' ? undefined : edge.label,
    animated: false,
    ...(edge.sourcePortId ? { sourceHandle: edge.sourcePortId } : {}),
    ...(edge.targetPortId ? { targetHandle: edge.targetPortId } : {}),
    ...(edge.order !== undefined || onDeleteEdge !== undefined
      ? {
        data: {
          ...(edge.order !== undefined ? { order: edge.order } : {}),
          ...(onDeleteEdge !== undefined ? { onCancel: () => onDeleteEdge(edge.id) } : {}),
        } satisfies CanvasFlowEdgeData,
      }
      : {}),
  }));
}

export function reconcileFlowEdges(previous: readonly Edge[], next: readonly Edge[]): Edge[] {
  if (previous.length !== next.length) return [...next];
  const unchanged = next.every((edge, index) => {
    const prior = previous[index];
    return prior !== undefined
      && prior.id === edge.id
      && prior.source === edge.source
      && prior.target === edge.target
      && prior.sourceHandle === edge.sourceHandle
      && prior.targetHandle === edge.targetHandle
      && prior.type === edge.type
      && prior.label === edge.label
      && prior.animated === edge.animated
      && prior.className === edge.className
      && prior.data?.order === edge.data?.order
      // `toFlowEdges` intentionally creates the tiny edge-id closure used
      // by the cancel affordance on every conversion. The callback's
      // identity is not durable edge data; comparing it would make every
      // render look like an edge update and React Flow would loop on
      // `setEdges` during unrelated text edits.
      && (prior.data?.onCancel !== undefined) === (edge.data?.onCancel !== undefined);
  });
  return unchanged ? previous as Edge[] : [...next];
}
