import { describe, expect, it } from 'vitest';
import { createCanvasModuleNode, type CanvasNode } from '@agent-canvas/domain';
import { toFlowEdges, toFlowNodes } from './node-types';

describe('toFlowEdges', () => {
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
});
