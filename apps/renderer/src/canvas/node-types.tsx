import { memo } from 'react';
import type { Edge, Node, NodeProps, NodeTypes } from '@xyflow/react';
import { Handle, Position } from '@xyflow/react';
import type { CanvasEdge, CanvasNode, ReferenceRole } from '@agent-canvas/domain';

export interface CanvasNodeData extends Record<string, unknown> {
  title: string;
  subtitle: string;
}

const referenceTitles: Record<ReferenceRole, string> = {
  product_identity: '产品身份参考',
  scene_composition: '场景构图参考',
  prop_reference: '道具参考',
  material_lighting: '材质与光照参考',
  placement_preview: '摆放预览参考',
};

function getViewData(node: CanvasNode): CanvasNodeData {
  switch (node.type) {
    case 'reference':
      return { title: referenceTitles[node.data.role], subtitle: `资源 ${node.data.assetId}` };
    case 'placement_preview':
      return { title: '摆放预览', subtitle: `${node.data.board.aspectRatio} · ${node.data.objects.length} 个对象` };
    case 'prompt':
      return { title: 'Agent 生成计划', subtitle: node.data.prompt || '等待提示词' };
    case 'model_job':
      return { title: '模型任务', subtitle: `${node.data.job.modelId} · ${node.data.job.status}` };
    case 'image_result':
      return { title: '生成结果', subtitle: node.data.modelId };
    case 'review':
      return { title: 'KEEP / CHANGE / NEVER', subtitle: `${node.data.keep.length + node.data.change.length + node.data.never.length} 条要求` };
    case 'memory_diff':
      return { title: 'Skill 记忆差异', subtitle: node.data.status };
    case 'agent_plan':
      return { title: 'Agent 方案', subtitle: node.data.plan.state };
  }
}

const BaseNode = memo(function BaseNode({ data, selected }: NodeProps) {
  const nodeData = data as CanvasNodeData;
  return (
    <div className={`canvas-node${selected ? ' is-selected' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className="canvas-node__title">{nodeData.title}</div>
      <div className="canvas-node__meta">{nodeData.subtitle}</div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
});

export const nodeTypes: NodeTypes = {
  reference: BaseNode,
  prompt: BaseNode,
  placement_preview: BaseNode,
  model_job: BaseNode,
  image_result: BaseNode,
  review: BaseNode,
  memory_diff: BaseNode,
  agent_plan: BaseNode,
};

export function toFlowNodes(nodes: readonly CanvasNode[]): Node<CanvasNodeData>[] {
  return nodes.map((node) => ({
    id: node.id,
    type: node.type,
    position: node.position,
    data: getViewData(node),
  }));
}

export function toFlowEdges(edges: readonly CanvasEdge[]): Edge[] {
  return edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: edge.label === 'agent-plan' ? undefined : edge.label,
    animated: edge.label === 'agent-plan',
  }));
}
