import { describe, expect, it } from 'vitest';
import { createStarterProject } from '../app/app-store';
import { applyTransaction } from '@agent-canvas/domain';
import { buildReverseAgentCanvasPlan, buildReverseWorkflowProposal } from './reverse-workflow-proposal';
import type { ReverseAnalysisResult } from './reverse-workflow-contract';

const analysis: ReverseAnalysisResult = {
  intent: { deliverable: '产品海报', useCase: '详情页', defaults: [], missing: [] },
  referenceDuties: [],
  visual: { subject: '主体', environment: '环境', material: '材质', lighting: '灯光', camera: '镜头', depth: '景深', composition: '构图', perspective: '透视', layers: '前中后景' },
  prompts: { zh: '中文提示词', en: 'English prompt', negative: ['水印'] },
  variants: [
    { id: 'faithful', name: 'faithful', change: '保留', prompt: 'A' },
    { id: 'balanced', name: 'balanced', change: '平衡', prompt: 'B' },
    { id: 'exploratory', name: 'exploratory', change: '探索', prompt: 'C' },
  ],
  checklist: [],
  missing: [],
  runnable: true,
};

describe('reverse workflow proposal', () => {
  it('creates deterministic reverse and variant nodes without touching durable state', () => {
    const input = {
      projectId: 'project-1',
      persistenceGeneration: 4,
      modelRoute: 'chat/vision',
      references: [
        { assetId: 'scene', mention: '@图片1', label: '场景' },
        { assetId: 'product', mention: '@图片2', label: '产品' },
      ],
      analysis,
    };
    const first = buildReverseWorkflowProposal(input);
    const second = buildReverseWorkflowProposal(input);

    expect(first).toEqual(second);
    expect(first.plannedNodes.map((node) => node.moduleType)).toEqual(['reverse_agent', 'image_generation', 'image_generation', 'image_generation']);
    expect(first.plannedEdges.slice(0, 2).map((edge) => [edge.source, edge.order])).toEqual([['scene', 0], ['product', 1]]);
    expect(first.state).toBe('proposal_ready');
  });

  it('materializes an ordered reverse workflow proposal without mutating the project', () => {
    const project = {
      ...createStarterProject(),
      id: 'project-1',
      name: '反推项目',
      assets: [
        { assetId: 'a'.repeat(16), mediaType: 'image/png' as const, byteSize: 10, extension: 'png' as const, height: 100, width: 100, origin: 'imported' as const, sha256: 'a'.repeat(64), label: '产品' },
        { assetId: 'b'.repeat(16), mediaType: 'image/png' as const, byteSize: 10, extension: 'png' as const, height: 100, width: 100, origin: 'imported' as const, sha256: 'b'.repeat(64), label: '场景' },
      ],
    };
    const before = structuredClone(project);

    const plan = buildReverseAgentCanvasPlan({
      project,
      persistenceGeneration: 7,
      modelRoute: 'chat/vision',
      modelRouteDisplayName: 'Vision chat',
      references: [
        { assetId: 'a'.repeat(16), mention: '@图片1', label: '产品' },
        { assetId: 'b'.repeat(16), mention: '@图片2', label: '场景' },
      ],
      analysis,
    });

    expect(project).toEqual(before);
    expect(plan.state).toBe('waiting_for_confirmation');
    expect(plan.requestedCapabilities).toEqual(['model_execution']);
    expect(plan.jobCount).toBe(3);
    const createdNodes = plan.transaction.operations.flatMap((operation) => operation.kind === 'create_node' ? [operation.node] : []);
    expect(createdNodes.filter((node) => node.type === 'module').map((node) => node.type === 'module' ? node.data.moduleType : '')).toEqual([
      'image_input',
      'image_input',
      'reverse_agent',
      'reverse_result',
      'text_prompt',
      'image_generation',
      'text_prompt',
      'image_generation',
      'text_prompt',
      'image_generation',
    ]);
    const reverseNode = createdNodes.find((node) => node.type === 'module' && node.data.moduleType === 'reverse_agent');
    expect(reverseNode?.type === 'module' ? reverseNode.data.config : null).toMatchObject({
      modelRoute: 'chat/vision',
      referenceAssetIds: ['a'.repeat(16), 'b'.repeat(16)],
    });
    const reverseReferenceEdges = plan.transaction.operations.flatMap((operation) => (
      operation.kind === 'create_edge' && operation.edge.target === reverseNode?.id
        ? [operation.edge]
        : []
    ));
    expect(reverseReferenceEdges.map((edge) => edge.order)).toEqual([0, 1]);
    expect(reverseReferenceEdges.map((edge) => edge.targetPortId)).toEqual(['references', 'references']);
    const generationPrompts = createdNodes.flatMap((node) => (
      node.type === 'module' && node.data.moduleType === 'image_generation'
        ? [node.data.config.prompt]
        : []
    ));
    expect(generationPrompts).toEqual(['A', 'B', 'C']);
    const applied = applyTransaction(project, plan.transaction);
    expect(applied.project.nodes.filter((node) => node.type === 'module' && node.data.moduleType === 'reverse_agent')).toHaveLength(1);
    expect(applied.project.edges.filter((edge) => edge.targetPortId === 'references').map((edge) => edge.order)).toEqual([0, 1]);
  });
});
