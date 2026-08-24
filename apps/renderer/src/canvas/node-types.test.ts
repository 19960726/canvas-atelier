import { describe, expect, it, vi } from 'vitest';
import { createCanvasModuleNode, type CanvasNode } from '@agent-canvas/domain';
import { reconcileFlowEdges, toFlowEdges, toFlowNodes } from './node-types';

describe('toFlowEdges', () => {
  it('reuses the previous edge array when edge content is unchanged', () => {
    const previous = toFlowEdges([{ id: 'stable', source: 'a', target: 'b' }]);
    const next = toFlowEdges([{ id: 'stable', source: 'a', target: 'b' }]);

    expect(reconcileFlowEdges(previous, next)).toBe(previous);
  });

  it('reuses edges when only the generated cancel callback identity changes', () => {
    const previous = toFlowEdges([{ id: 'stable-cancel', source: 'a', target: 'b' }], () => undefined);
    const next = toFlowEdges([{ id: 'stable-cancel', source: 'a', target: 'b' }], () => undefined);

    expect(reconcileFlowEdges(previous, next)).toBe(previous);
  });
  it('hides the internal agent-plan marker without animating persisted edges', () => {
    expect(toFlowEdges([{
      id: 'edge-1',
      source: 'source-1',
      target: 'target-1',
      label: 'agent-plan',
    }])).toEqual([{
      id: 'edge-1',
      source: 'source-1',
      target: 'target-1',
      type: 'canvas-bezier',
      label: undefined,
      animated: false,
    }]);
  });

  it('does not animate ordinary persisted Agent edges', () => {
    expect(toFlowEdges([{ id: 'applied', source: 'a', target: 'b' }])[0]?.animated).toBe(false);
  });

  it('maps persisted port ids and input order to React Flow edge handles', () => {
    expect(toFlowEdges([{
      id: 'edge-1',
      source: 'prompt',
      sourcePortId: 'prompt',
      target: 'generator',
      targetPortId: 'prompt',
      order: 0,
    }])[0]).toMatchObject({
      sourceHandle: 'prompt',
      targetHandle: 'prompt',
      data: { order: 0 },
    });
  });

  it('renders every durable canvas edge as one smooth Bezier connector', () => {
    expect(toFlowEdges([{
      id: 'video-result-edge',
      source: 'video-generation',
      sourcePortId: 'result',
      target: 'video-result',
      targetPortId: 'video',
    }])[0]).toMatchObject({
      type: 'canvas-bezier',
    });
  });

  it('carries an explicit cancel action for the midpoint edge control', () => {
    const onDeleteEdge = vi.fn();
    const edge = toFlowEdges([{
      id: 'cancelable-edge',
      source: 'source',
      target: 'target',
    }], onDeleteEdge)[0];

    expect(edge?.data).toHaveProperty('onCancel');
    (edge?.data as { onCancel: () => void }).onCancel();
    expect(onDeleteEdge).toHaveBeenCalledWith('cancelable-edge');
  });
});

describe('toFlowNodes', () => {
  it('adds semantic presentation fields for every shared node family', () => {
    const nodes: CanvasNode[] = [
      {
        id: 'reference-product',
        type: 'reference',
        position: { x: 40, y: 80 },
        data: { assetId: 'asset-product', role: 'product_identity' },
      },
      {
        id: 'placement-preview',
        type: 'placement_preview',
        position: { x: 120, y: 160 },
        data: {
          board: { id: 'board-1', aspectRatio: '4:5', width: 1080, height: 1350, safeAreas: [] },
          objects: [
            {
              id: 'object-1',
              assetId: 'asset-product',
              role: 'product_identity',
              x: 0.4,
              y: 0.4,
              w: 0.3,
              h: 0.3,
              rotation: 0,
              zIndex: 1,
              locked: false,
              visible: true,
              flipX: false,
              flipY: false,
              semanticLayer: 'hero_product',
              name: 'Product',
            },
            {
              id: 'object-2',
              assetId: 'asset-scene',
              role: 'scene_composition',
              x: 0.2,
              y: 0.2,
              w: 0.8,
              h: 0.8,
              rotation: 0,
              zIndex: 0,
              locked: false,
              visible: true,
              flipX: false,
              flipY: false,
              semanticLayer: 'background',
              name: 'Scene',
            },
          ],
        },
      },
      {
        id: 'prompt-node',
        type: 'prompt',
        position: { x: 200, y: 200 },
        data: { prompt: 'Hero product composition', requirementIds: [] },
      },
      {
        id: 'model-job',
        type: 'model_job',
        position: { x: 280, y: 240 },
        data: {
          job: {
            id: 'job-1',
            kind: 'image',
            modelId: 'gpt-image-1',
            status: 'running',
            promptNodeId: 'prompt-node',
            retryCount: 0,
            referenceAssetIds: ['asset-product'],
          },
        },
      },
      {
        id: 'image-result',
        type: 'image_result',
        position: { x: 320, y: 260 },
        data: {
          assetId: 'asset-result-direct',
          modelId: 'gpt-image-1',
          provider: 'comfly',
          modelRoute: 'gpt-image',
          displayName: 'GPT Image result',
          parentNodeIds: ['prompt-node'],
          referenceAssetIds: ['asset-product'],
          promptNodeId: 'prompt-node',
          jobId: 'job-1',
          width: 1024,
          height: 1024,
        },
      },
      {
        id: 'review-node',
        type: 'review',
        position: { x: 360, y: 280 },
        data: { keep: ['hero'], change: ['shadow'], never: [] },
      },
      {
        id: 'memory-diff',
        type: 'memory_diff',
        position: { x: 440, y: 320 },
        data: { diffId: 'diff-1', status: 'pending_review' },
      },
      {
        id: 'agent-plan',
        type: 'agent_plan',
        position: { x: 520, y: 360 },
        data: {
          plan: {
            id: 'plan-1',
            state: 'waiting_for_confirmation',
            proposedOperationIds: [],
            requiresModelConfirmation: true,
          },
        },
      },
    ];

    const flowNodes = toFlowNodes(nodes);

    expect(flowNodes[0]?.data).toMatchObject({
      kind: 'reference',
      eyebrow: 'Reference',
      tone: 'teal',
      status: 'Reference',
    });
    expect(flowNodes[1]?.data).toMatchObject({
      kind: 'placement_preview',
      eyebrow: 'Placement',
      tone: 'blue',
      status: '2 layers',
    });
    expect(flowNodes[2]?.data).toMatchObject({
      kind: 'prompt',
      eyebrow: 'Agent plan',
      tone: 'teal',
      status: 'Ready',
    });
    expect(flowNodes[3]?.data).toMatchObject({
      kind: 'model_job',
      eyebrow: 'Model job',
      tone: 'slate',
      status: 'running',
    });
    expect(flowNodes[4]?.data).toMatchObject({
      kind: 'image_result',
      eyebrow: 'Image result',
      tone: 'teal',
      subtitle: 'GPT Image result',
      status: 'Result',
      resultAssetId: 'asset-result-direct',
    });
    expect(flowNodes[5]?.data).toMatchObject({
      kind: 'review',
      eyebrow: 'Review',
      tone: 'amber',
      status: 'Review',
    });
    expect(flowNodes[6]?.data).toMatchObject({
      kind: 'memory_diff',
      eyebrow: 'Memory diff',
      tone: 'amber',
      status: 'pending_review',
    });
    expect(flowNodes[7]?.data).toMatchObject({
      kind: 'agent_plan',
      eyebrow: 'Agent plan',
      tone: 'blue',
      status: 'waiting_for_confirmation',
    });
  });

  it('passes module node data directly to the module renderer', () => {
    const node = createCanvasModuleNode('generator', 'image_generation', { x: 12, y: 24 });
    const flowNode = toFlowNodes([node])[0];

    expect(flowNode).toMatchObject({
      id: 'generator',
      type: 'module',
      position: { x: 12, y: 24 },
      data: node.data,
    });
  });

  it('keeps formal video wrappers interactive so visible ports can accept a connection', () => {
    const node = createCanvasModuleNode('video', 'video_generation', { x: 12, y: 24 });
    const flowNode = toFlowNodes([node])[0];

    expect(flowNode).toMatchObject({ className: 'canvas-flow-node--module-video_generation' });
    expect(flowNode?.style).toBeUndefined();
  });

  it('passes configured storyboard chat routes to storyboard-sheet nodes', () => {
    const node = createCanvasModuleNode('storyboard', 'storyboard_sheet', { x: 12, y: 24 });
    const storyboardRoutes = [{
      provider: 'comfly',
      modelRoute: 'scene-chat',
      displayName: 'Scene chat',
      capabilities: ['chat'],
    }];

    const flowNode = toFlowNodes([node], {
      imageGenerationRoutes: [],
      reverseAgentRoutes: [],
      storyboardRoutes,
      onOpenReverseAgentSettings: () => undefined,
      onGenerateImage: async () => true,
      onReversePrompt: async () => ({ positivePrompt: 'Test prompt' }),
      onCancelJob: async () => undefined,
      onGenerateStoryboard: async () => true,
      generationEditorExpandedNodeId: null,
      onOpenGenerationEditor: () => undefined,
      onCloseGenerationEditor: () => undefined,
      resultOutputMenuNodeId: null,
      onResultOutputMenuChange: () => undefined,
    });

    expect(flowNode[0]?.data).toMatchObject({ storyboardRoutes });
  });

  it('marks both durable edge endpoints as connected for module rendering', () => {
    const image = createCanvasModuleNode('image-input', 'image_input', { x: 0, y: 0 });
    const generator = createCanvasModuleNode('generator', 'image_generation', { x: 320, y: 0 });

    const flowNodes = toFlowNodes([image, generator], undefined, [{
      id: 'image-to-generator',
      source: image.id,
      sourcePortId: 'image',
      target: generator.id,
      targetPortId: 'references',
    }]);

    expect(flowNodes.find((node) => node.id === image.id)?.data).toMatchObject({ connectedPortIds: ['image'] });
    expect(flowNodes.find((node) => node.id === generator.id)?.data).toMatchObject({ connectedPortIds: ['references'] });
  });

  it('marks generic-card input and output sockets as connected from durable edges', () => {
    const reference: CanvasNode = {
      id: 'reference',
      type: 'reference',
      position: { x: 0, y: 0 },
      data: { assetId: 'asset-1', role: 'product_identity' },
    };
    const prompt: CanvasNode = {
      id: 'prompt',
      type: 'prompt',
      position: { x: 320, y: 0 },
      data: { prompt: '', requirementIds: [] },
    };

    const flowNodes = toFlowNodes([reference, prompt], undefined, [{
      id: 'reference-to-prompt',
      source: reference.id,
      target: prompt.id,
    }]);

    expect(flowNodes.find((node) => node.id === reference.id)?.data).toMatchObject({ outputConnected: true });
    expect(flowNodes.find((node) => node.id === prompt.id)?.data).toMatchObject({ inputConnected: true });
  });

  it('keeps same-named input and output ports distinct when only the input is connected', () => {
    const reverseAgent = createCanvasModuleNode('reverse-agent', 'reverse_agent', { x: 0, y: 0 });
    const reverseResult = createCanvasModuleNode('reverse-result', 'reverse_result', { x: 620, y: 0 });

    const flowNodes = toFlowNodes([reverseAgent, reverseResult], undefined, [{
      id: 'reverse-analysis-result',
      source: reverseAgent.id,
      sourcePortId: 'analysis',
      target: reverseResult.id,
      targetPortId: 'analysis',
    }]);

    expect(flowNodes.find((node) => node.id === reverseResult.id)?.data).toMatchObject({
      connectedPortKeys: ['input:analysis'],
    });
  });

  it('reuses unchanged flow-node objects while replacing only nodes whose runtime or position changed', async () => {
    const module = await import('./node-types');
    const reconcileFlowNodes = (module as unknown as {
      reconcileFlowNodes?: <T extends { id: string }>(previous: readonly T[], next: readonly T[]) => T[];
    }).reconcileFlowNodes;
    expect(reconcileFlowNodes).toBeTypeOf('function');

    const image = createCanvasModuleNode('image-input', 'image_input', { x: 0, y: 0 });
    const generator = createCanvasModuleNode('generator', 'image_generation', { x: 320, y: 0 });
    const runtime = {
      imageGenerationRoutes: [],
      reverseAgentRoutes: [],
      storyboardRoutes: [],
      onOpenReverseAgentSettings: () => undefined,
      onGenerateImage: async () => true,
      onReversePrompt: async () => ({ positivePrompt: 'Test prompt' }),
      onCancelJob: async () => undefined,
      onGenerateStoryboard: async () => true,
      generationEditorExpandedNodeId: null,
      onOpenGenerationEditor: () => undefined,
      onCloseGenerationEditor: () => undefined,
      resultOutputMenuNodeId: null,
      onResultOutputMenuChange: () => undefined,
    };
    const edges = [{
      id: 'image-to-generator',
      source: image.id,
      sourcePortId: 'image',
      target: generator.id,
      targetPortId: 'references',
    }];
    const first = toFlowNodes([image, generator], runtime, edges);
    const expanded = toFlowNodes([image, generator], { ...runtime, generationEditorExpandedNodeId: generator.id }, edges);
    const second = reconcileFlowNodes!(first, expanded);

    expect(second.find((node) => node.id === image.id)).toBe(first.find((node) => node.id === image.id));
    expect(second.find((node) => node.id === generator.id)).not.toBe(first.find((node) => node.id === generator.id));

    const movedImage = { ...image, position: { x: 48, y: 64 } };
    const moved = reconcileFlowNodes!(second, toFlowNodes([movedImage, generator], { ...runtime, generationEditorExpandedNodeId: generator.id }, edges));
    expect(moved.find((node) => node.id === image.id)).not.toBe(second.find((node) => node.id === image.id));
    expect(moved.find((node) => node.id === generator.id)).toBe(second.find((node) => node.id === generator.id));
  });});
