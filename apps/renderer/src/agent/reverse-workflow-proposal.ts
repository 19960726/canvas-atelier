import type { AgentCanvasPlan, CanvasProject, CanvasOperation } from '@agent-canvas/domain';
import { createCanvasModuleNode } from '@agent-canvas/domain';
import type { GenerationParameters } from './generation-preferences';
import type { ReverseAnalysisResult, ReverseWorkflowProposal } from './reverse-workflow-contract';
import { generationVariantRowStep, materialNodeRowStep, nextWorkflowColumnX } from './workflow-layout';

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
  generation?: { kind: 'image' | 'video'; modelRoute?: string; modelRouteDisplayName?: string; parameters?: GenerationParameters };
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
  const suffix = proposal.id + (input.generation ? ":" + stableHash(JSON.stringify(input.generation)) : "");
  const operations: CanvasOperation[] = [];
  const baseX = nextWorkflowColumnX(input.project);
  const baseY = 160;
  let nextReferenceY = baseY;
  const referenceNodeIds = input.references.map((reference, index) => {
    const existing = input.project.nodes.find((node) => (
      node.type === 'module'
      && (node.data.moduleType === 'image_input' || node.data.moduleType === 'upload_image')
      && node.data.config.assetId === reference.assetId
    ));
    if (existing?.type === 'module') return existing.id;
    const nodeId = `${suffix}:input:${index + 1}`;
    const node = createCanvasModuleNode(nodeId, 'image_input', { x: baseX, y: nextReferenceY });
    node.data.config = { ...node.data.config, assetId: reference.assetId, label: reference.label };
    operations.push({ kind: 'create_node', node });
    nextReferenceY += materialNodeRowStep(input.project.assets?.find(asset => asset.assetId === reference.assetId));
    return nodeId;
  });

  const reverseNodeId = `${suffix}:reverse`;
  const reverseNode = createCanvasModuleNode(reverseNodeId, 'reverse_agent', { x: baseX + 380, y: baseY });
  reverseNode.data.config = {
    ...reverseNode.data.config,
    modelRoute: input.modelRoute,
    routeDisplayName: input.modelRouteDisplayName,
    role: '产品视觉分析师 + 提示词工程师',
    task: '按参考图顺序分析主体、环境、材质、灯光、镜头、景深、构图、透视和前中后景；输出中文/英文执行提示词、负向约束、每张参考图职责和可核验的检查清单。',
    knowledgeBaseIds: [...(input.knowledgeBaseIds ?? [])],
    referenceAssetIds: input.references.map((reference) => reference.assetId),
  };
  operations.push({ kind: 'create_node', node: reverseNode });

  const reverseResultId = `${suffix}:result`;
  const reverseResult = createCanvasModuleNode(reverseResultId, 'reverse_result', { x: baseX + 380, y: baseY + 940 });
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

  const variantRowStep = generationVariantRowStep(input.project, input.references.map(reference => reference.assetId), input.generation?.parameters?.aspectRatio);
  for (const [index, variant] of input.analysis.variants.entries()) {
    const executionPrompt = buildReverseExecutionPrompt(variant.prompt, input.analysis, input.references);
    const variantY = baseY + index * variantRowStep;
    const promptNodeId = `${suffix}:prompt:${variant.id}`;
    const promptBaseNode = createCanvasModuleNode(promptNodeId, 'text_prompt', { x: baseX + 980, y: variantY });
    const promptNode = {
      ...promptBaseNode,
      data: {
        ...promptBaseNode.data,
        config: { prompt: executionPrompt, variantId: variant.id, variantName: variant.name },
      },
    };
    operations.push({ kind: 'create_node', node: promptNode });
    const nodeId = `${suffix}:generation:${variant.id}`;
    const generationNode = createCanvasModuleNode(nodeId, input.generation?.kind === 'video' ? 'video_generation' : 'image_generation', { x: baseX + 1420, y: variantY });
    generationNode.data.config = {
      ...generationNode.data.config,
      prompt: executionPrompt,
      negativePrompt: input.analysis.prompts.negative.join('\n'),
      modelRoute: input.generation?.modelRoute,
      routeDisplayName: input.generation?.modelRouteDisplayName,
      ...input.generation?.parameters,
      variantId: variant.id,
      variantName: variant.name,
      referenceAssetIds: input.references.map((reference) => reference.assetId),
      resultState: 'empty',
    };
    operations.push({ kind: 'create_node', node: generationNode });
    for (const [order, sourceId] of referenceNodeIds.entries()) {
      operations.push({ kind: 'create_edge', edge: {
        id: `${suffix}:generation-reference:${variant.id}:${order + 1}`,
        source: sourceId, sourcePortId: 'image', target: nodeId,
        targetPortId: input.generation?.kind === 'video' ? 'media' : 'references', order,
      } });
    }
    operations.push({
      kind: 'create_edge',
      edge: { id: `${suffix}:prompt-edge:${variant.id}`, source: promptNodeId, sourcePortId: 'prompt', target: nodeId, targetPortId: 'prompt', order: 0 },
    });
    const outputNodeId = `${suffix}:output:${variant.id}`;
    const outputNode = createCanvasModuleNode(outputNodeId, input.generation?.kind === 'video' ? 'video_result' : 'result_output', { x: baseX + 2200, y: variantY });
    outputNode.data.config = { ...outputNode.data.config, variantId: variant.id, variantName: variant.name };
    operations.push({ kind: 'create_node', node: outputNode });
    operations.push({ kind: 'create_edge', edge: {
      id: `${suffix}:output-edge:${variant.id}`, source: nodeId, sourcePortId: 'result', target: outputNodeId,
      targetPortId: input.generation?.kind === 'video' ? 'video' : 'result', order: 0,
    } });
  }

  return {
    id: `${suffix}:canvas-plan`,
    state: 'waiting_for_confirmation',
    transaction: {
      id: `${suffix}:transaction`,
      label: `反推参考图并生成 ${input.analysis.variants.length} 版可编辑工作流`,
      operations,
    },
    requestedCapabilities: ['model_execution'],
    confirmations: {},
    conflicts: input.references.length === 0 ? ['至少需要一张有序参考图'] : [],
    modelRoute: input.generation?.modelRoute,
    modelRouteDisplayName: input.generation?.modelRouteDisplayName,
    jobCount: input.analysis.variants.length,
  };
}

function buildReverseExecutionPrompt(prompt: string, analysis: ReverseAnalysisResult, references: readonly { mention: string }[]): string {
  const sections = analysis.referenceDuties.flatMap(duty => {
    const label = duty.mention.replace('@', '参考');
    return ([['保留', duty.inherit], ['允许修改', duty.replace], ['禁止复制', duty.doNotCopy]] as const)
      .flatMap(([boundary, items]) => items.length > 0 ? [`${label}${boundary}：${items.join('；')}`] : []);
  });
  if (references.length > 0) sections.unshift(`实际素材输入顺序（对应原编号）：\n${references.map((reference, index) => `第${index + 1}张输入：${reference.mention.replace('@', '参考')}`).join('\n')}`);
  if (analysis.prompts.negative.length > 0) sections.push(`禁止事项：\n${analysis.prompts.negative.map(item => `- ${item}`).join('\n')}`);
  const checks = analysis.checklist.map(item => item.label).filter(Boolean);
  if (checks.length > 0) sections.push(`交付检查（生成后逐项核验）：\n${checks.map(item => `- ${item}`).join('\n')}`);
  const compiled = sections.length > 0 ? `${prompt}\n\n已确认的执行约束：\n${sections.join('\n\n')}` : prompt;
  return compiled.replace(/@(图片|视频)(\d+)/gu, '参考$1$2');
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
