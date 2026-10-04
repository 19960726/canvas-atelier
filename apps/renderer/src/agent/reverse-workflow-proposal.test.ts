import { describe, expect, it } from 'vitest';
import { createStarterProject } from '../app/app-store';
import { applyTransaction, createCanvasModuleNode } from '@agent-canvas/domain';
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
  it('keeps new reverse materials clear of an existing expanded generation and each other at full portrait ratio', () => {
    const existing = createCanvasModuleNode('existing-expanded', 'image_generation', { x: 120, y: 160 });
    const assets = ['a', 'b'].map(character => ({ assetId: character.repeat(16), mediaType: 'image/png' as const, byteSize: 10, extension: 'png' as const, height: 1280, width: 720, origin: 'imported' as const, sha256: character.repeat(64), label: 'Portrait material' }));
    const project = { ...createStarterProject(), nodes: [existing], edges: [], assets };
    const before = structuredClone(project);
    const plan = buildReverseAgentCanvasPlan({ project, persistenceGeneration: 1, modelRoute: 'vision',
      references: assets.map((asset, index) => ({ assetId: asset.assetId, mention: `@图片${index + 1}`, label: asset.label })), analysis });
    const references = plan.transaction.operations.flatMap(operation => operation.kind === 'create_node' && operation.node.type === 'module' && operation.node.data.moduleType === 'image_input' ? [operation.node] : []);
    expect(references).toHaveLength(2);
    for (const reference of references) expect.soft(reference.position.x).toBeGreaterThan(existing.position.x + 704);
    expect.soft(references[1]!.position.y).toBeGreaterThan(references[0]!.position.y + 272 * 1280 / 720 + 77);
    expect(project).toEqual(before);
  });

  it('separates the full analysis result from editable variants and leaves room for portrait generation frames', () => {
    const project = { ...createStarterProject(), nodes: [], edges: [], assets: [] };
    const plan = buildReverseAgentCanvasPlan({ project, persistenceGeneration: 1, modelRoute: 'vision',
      generation: { kind: 'image', parameters: { aspectRatio: '9:16' } }, references: [], analysis });
    const nodes = plan.transaction.operations.flatMap(operation => operation.kind === 'create_node' && operation.node.type === 'module' ? [operation.node] : []);
    const result = nodes.find(node => node.data.moduleType === 'reverse_result')!;
    const prompts = nodes.filter(node => node.data.moduleType === 'text_prompt');
    const first = prompts[0]!;
    const separated = result.position.x + 520 <= first.position.x || first.position.x + 218 <= result.position.x
      || result.position.y + 648 <= first.position.y || first.position.y + 307.5 <= result.position.y;
    expect.soft(separated).toBe(true);
    expect.soft(prompts[1]!.position.y - first.position.y).toBeGreaterThan(676 * 16 / 9 + 464);
  });

  it('keeps every approved reference boundary and delivery check in the connected executable prompt', () => {
    const project = { ...createStarterProject(), id: 'reverse-boundaries' };
    const reference = { assetId: 'a'.repeat(16), mention: '@图片8', label: '原始产品' };
    const detailed: ReverseAnalysisResult = {
      ...analysis,
      referenceDuties: [{ ...reference, responsibility: '产品几何', inherit: ['原机位和物体大小比例'],
        replace: ['仅去除产品主体'], doNotCopy: ['不要复制橙色挂环到新背景'] }],
      prompts: { ...analysis.prompts, negative: ['禁止增加第二只杯子', '禁止水印'] },
      checklist: [{ id: 'check-scale', label: '位置及大小与原图一致', state: 'pending' }],
      variants: [analysis.variants[0]!],
    };
    const plan = buildReverseAgentCanvasPlan({ project, persistenceGeneration: 1, modelRoute: 'vision',
      references: [reference], analysis: detailed, generation: { kind: 'image', modelRoute: 'image' } });
    const prompts = plan.transaction.operations.flatMap(operation => operation.kind === 'create_node'
      && operation.node.type === 'module' && ['text_prompt', 'image_generation'].includes(operation.node.data.moduleType)
      ? [String(operation.node.data.config.prompt)] : []);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toBe(prompts[1]);
    for (const prompt of prompts) {
      expect(prompt.startsWith('A')).toBe(true);
      for (const constraint of ['参考图片8', '原机位和物体大小比例', '仅去除产品主体',
        '不要复制橙色挂环到新背景', '禁止增加第二只杯子', '禁止水印', '位置及大小与原图一致']) {
        expect(prompt).toContain(constraint);
      }
      expect(prompt).not.toContain('@图片');
    }
  });

  it.each(['image', 'video'] as const)('connects a real %s output to each separate reverse variant', kind => {
    const project = { ...createStarterProject(), id: `reverse-output-${kind}` };
    const plan = buildReverseAgentCanvasPlan({ project, persistenceGeneration: 1, modelRoute: 'vision',
      references: [], analysis, generation: { kind, modelRoute: 'generation' } });
    const applied = applyTransaction(project, plan.transaction).project;
    const generations = applied.nodes.filter(node => node.type === 'module' && node.data.moduleType === `${kind}_generation`);
    const outputs = applied.nodes.filter(node => node.type === 'module' && node.data.moduleType === (kind === 'image' ? 'result_output' : 'video_result'));
    expect(generations).toHaveLength(3);
    expect(outputs).toHaveLength(3);
    for (const generation of generations) {
      const outputEdges = applied.edges.filter(edge => edge.source === generation.id && edge.sourcePortId === 'result');
      expect(outputEdges).toHaveLength(1);
      expect(outputEdges[0]!.targetPortId).toBe(kind === 'image' ? 'result' : 'video');
      expect(outputs.some(output => output.id === outputEdges[0]!.target)).toBe(true);
    }
  });

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
      generation: { kind: 'image', modelRoute: 'image/chosen', modelRouteDisplayName: 'Chosen image', parameters: { aspectRatio: '4:5' } },
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
    expect(plan.modelRoute).toBe('image/chosen');
    const createdNodes = plan.transaction.operations.flatMap((operation) => operation.kind === 'create_node' ? [operation.node] : []);
    expect(createdNodes.filter((node) => node.type === 'module').map((node) => node.type === 'module' ? node.data.moduleType : '')).toEqual([
      'image_input',
      'image_input',
      'reverse_agent',
      'reverse_result',
      'text_prompt',
      'image_generation',
      'result_output',
      'text_prompt',
      'image_generation',
      'result_output',
      'text_prompt',
      'image_generation',
      'result_output',
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
    expect(generationPrompts.map(prompt => String(prompt).split('\n')[0])).toEqual(['A', 'B', 'C']);
    expect(generationPrompts.every(prompt => String(prompt).includes('禁止事项：\n- 水印'))).toBe(true);
    expect(createdNodes.filter((node) => node.type === 'module' && node.data.moduleType === 'image_generation').every((node) => node.type === 'module' && node.data.config.modelRoute === 'image/chosen')).toBe(true);
    const applied = applyTransaction(project, plan.transaction);
    expect(applied.project.nodes.filter((node) => node.type === 'module' && node.data.moduleType === 'reverse_agent')).toHaveLength(1);
    expect(applied.project.edges.filter((edge) => edge.targetPortId === 'references' && edge.target === reverseNode?.id).map((edge) => edge.order)).toEqual([0, 1]);
    const generationNodes = applied.project.nodes.filter((node) => node.type === 'module' && node.data.moduleType === 'image_generation');
    for (const generationNode of generationNodes) {
      const edges = applied.project.edges.filter((edge) => edge.target === generationNode.id && edge.targetPortId === 'references');
      expect(edges).toHaveLength(2);
      expect(edges.map((edge) => {
        const sourceNode = applied.project.nodes.find((node) => node.id === edge.source);
        return sourceNode?.type === 'module' ? sourceNode.data.config.assetId : undefined;
      }))
        .toEqual(['a'.repeat(16), 'b'.repeat(16)]);
      expect(edges.map((edge) => edge.order)).toEqual([0, 1]);
    }
  });
});
