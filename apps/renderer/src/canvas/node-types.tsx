import { memo } from 'react';
import type { Edge, Node, NodeProps, NodeTypes } from '@xyflow/react';
import type { CanvasEdge, CanvasModuleNodeData, CanvasNode, ReferenceRole } from '@agent-canvas/domain';
import { CanvasNodeCard, type CanvasNodePresentation, type CanvasNodeTone } from './CanvasNodeCard';
import { ImageResultNode } from '../jobs/ImageResultNode';
import { ModuleNodeCard } from './ModuleNodeCard';

export type CanvasNodeData = Record<string, unknown> & CanvasNodePresentation;
export type CanvasFlowNodeData = CanvasNodeData | (Record<string, unknown> & CanvasModuleNodeData);

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
    case 'review':
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

export function toFlowNodes(nodes: readonly CanvasNode[]): Node<CanvasFlowNodeData>[] {
  return nodes.map((node) => ({
    id: node.id,
    type: node.type,
    position: node.position,
    draggable: node.locked !== true,
    data: { ...getViewData(node), locked: node.locked === true },
  }));
}

export function toFlowEdges(edges: readonly CanvasEdge[]): Edge[] {
  return edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: edge.label === 'agent-plan' ? undefined : edge.label,
    animated: false,
    ...(edge.sourcePortId ? { sourceHandle: edge.sourcePortId } : {}),
    ...(edge.targetPortId ? { targetHandle: edge.targetPortId } : {}),
    ...(edge.order !== undefined ? { data: { order: edge.order } } : {}),
  }));
}
