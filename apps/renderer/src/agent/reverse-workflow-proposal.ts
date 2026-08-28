import type { AgentCanvasPlan, CanvasProject, CanvasOperation } from '@agent-canvas/domain';
import { createCanvasModuleNode } from '@agent-canvas/domain';
import type { ReverseAnalysisResult, ReverseWorkflowProposal } from './reverse-workflow-contract';

export interface ReverseWorkflowProposalInput {
  projectId: string;
  persistenceGeneration: number;
  modelRoute: string;
  references: Array<{ assetId: string; mention: string; label: string }>;
  analysis: ReverseAnalysisResult;
}

export function buildReverseWorkflowProposal(input: ReverseWorkflowProposalInput): ReverseWorkflowProposal {
  const proposalId = `proposal-${input.projectId}-${stableHash(JSON.stringify({ references: input.references, analysis: input.analysis }))}`;
  const reverseNodeId = `${proposalId}:reverse`;
  const variantNodes = input.analysis.variants.map((variant) => ({
    id: `${proposalId}:variant:${variant.id}`,
    moduleType: 'image_generation',
    variantId: variant.id,
  }));
  const plannedNodes = [
    { id: reverseNodeId, moduleType: 'reverse_agent' },
    ...variantNodes,
  ];
  const plannedEdges = [
    ...input.references.map((reference, order) => ({
      source: reference.assetId,
      target: reverseNodeId,
      targetPortId: 'references',
      order,
    })),
    ...variantNodes.map((variant, order) => ({
      source: reverseNodeId,
      target: variant.id,
      targetPortId: 'prompt',
      order,
    })),
  ];
  return {
    id: proposalId,
    projectId: input.projectId,
    persistenceGeneration: input.persistenceGeneration,
    referenceAssetIds: input.references.map((reference) => reference.assetId),
    modelRoute: input.modelRoute,
    state: 'proposal_ready',
    analysis: input.analysis,
    editedAnalysis: structuredClone(input.analysis),
    plannedNodes,
    plannedEdges,
  };
}

export interface ReverseAgentCanvasPlanInput {
  project: CanvasProject;
  persistenceGeneration: number;
  modelRoute: string;
  modelRouteDisplayName?: string;
  knowledgeBaseIds?: readonly string[];
  references: Array<{ assetId: string; mention: string; label: string }>;
  analysis: ReverseAnalysisResult;
}

/**
 * Build a confirmation-only canvas transaction. The function is deliberately
 * pure: before confirmation it can only produce ghost nodes/edges and cannot
 * write to the project or submit provider jobs.
 */
export function buildReverseAgentCanvasPlan(input: ReverseAgentCanvasPlanInput): AgentCanvasPlan {
  const proposal = buildReverseWorkflowProposal({
    projectId: input.project.id,
    persistenceGeneration: input.persistenceGeneration,
    modelRoute: input.modelRoute,
    references: input.references,
    analysis: input.analysis,
  });
  const suffix = proposal.id;
  const operations: CanvasOperation[] = [];
  const existingIds = new Set(input.project.nodes.map((node) => node.id));
  const referenceNodeIds = input.references.map((reference, index) => {
    const existing = input.project.nodes.find((node) => (
      node.type === 'module'
      && (node.data.moduleType === 'image_input' || node.data.moduleType === 'upload_image')
      && node.data.config.assetId === reference.assetId
    ));
    if (existing?.type === 'module') return existing.id;
    const nodeId = `${suffix}:input:${index + 1}`;
    const node = createCanvasModuleNode(nodeId, 'image_input', { x: 120, y: 160 + index * 180 });
    node.data.config = { ...node.data.config, assetId: reference.assetId, label: reference.label };
    operations.push({ kind: 'create_node', node });
    return nodeId;
  });

  const reverseNodeId = `${suffix}:reverse`;
  const reverseNode = createCanvasModuleNode(reverseNodeId, 'reverse_agent', { x: 460, y: 220 });
  reverseNode.data.config = {
    ...reverseNode.data.config,
    modelRoute: input.modelRoute,
    routeDisplayName: input.modelRouteDisplayName,
    role: '产品视觉分析师 + 提示词工程师',
    task: '按参考图顺序执行桥豆麻衣酱式反推：拆解主体、环境、材质、灯光、镜头、景深、构图、透视和前中后景；输出中文/英文提示词、负向约束、每张参考图职责和可执行检查清单。',
    knowledgeBaseIds: [...(input.knowledgeBaseIds ?? [])],
    referenceAssetIds: input.references.map((reference) => reference.assetId),
  };
  operations.push({ kind: 'create_node', node: reverseNode });

  const reverseResultId = `${suffix}:result`;
  const reverseResult = createCanvasModuleNode(reverseResultId, 'reverse_result', { x: 820, y: 220 });
  operations.push({ kind: 'create_node', node: reverseResult });

  for (const [index, sourceId] of referenceNodeIds.entries()) {
    operations.push({
      kind: 'create_edge',
      edge: { id: `${suffix}:reference-edge:${index + 1}`, source: sourceId, sourcePortId: 'image', target: reverseNodeId, targetPortId: 'references', order: index },
    });
  }
  operations.push({
    kind: 'create_edge',
    edge: { id: `${suffix}:analysis-edge`, source: reverseNodeId, sourcePortId: 'analysis', target: reverseResultId, targetPortId: 'analysis', order: 0 },
  });

  for (const [index, variant] of input.analysis.variants.entries()) {
    const promptNodeId = `${suffix}:prompt:${variant.id}`;
    const promptBaseNode = createCanvasModuleNode(promptNodeId, 'text_prompt', { x: 820, y: 80 + index * 220 });
    const promptNode = {
      ...promptBaseNode,
      data: {
        ...promptBaseNode.data,
        config: { prompt: variant.prompt, variantId: variant.id, variantName: variant.name },
      },
    };
    operations.push({ kind: 'create_node', node: promptNode });
    const nodeId = `${suffix}:generation:${variant.id}`;
    const generationNode = createCanvasModuleNode(nodeId, 'image_generation', { x: 1180, y: 80 + index * 220 });
    generationNode.data.config = {
      ...generationNode.data.config,
      prompt: variant.prompt,
      negativePrompt: input.analysis.prompts.negative.join('\n'),
      modelRoute: input.modelRoute,
      routeDisplayName: input.modelRouteDisplayName,
      variantId: variant.id,
      variantName: variant.name,
      referenceAssetIds: input.references.map((reference) => reference.assetId),
      resultState: 'empty',
    };
    operations.push({ kind: 'create_node', node: generationNode });
    operations.push({
      kind: 'create_edge',
      edge: { id: `${suffix}:prompt-edge:${variant.id}`, source: promptNodeId, sourcePortId: 'prompt', target: nodeId, targetPortId: 'prompt', order: 0 },
    });
  }

  return {
    id: `${suffix}:canvas-plan`,
    state: 'waiting_for_confirmation',
    transaction: {
      id: `${suffix}:transaction`,
      label: '反推参考图并生成三版可编辑工作流',
      operations,
    },
    requestedCapabilities: ['model_execution'],
    confirmations: {},
    conflicts: input.references.length === 0 ? ['至少需要一张有序参考图'] : [],
    modelRoute: input.modelRoute,
    modelRouteDisplayName: input.modelRouteDisplayName,
    jobCount: input.analysis.variants.length,
  };
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
