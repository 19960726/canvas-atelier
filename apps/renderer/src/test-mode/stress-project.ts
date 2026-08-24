import {
  createCanvasModuleNode,
  parseCanvasProject,
  type CanvasEdge,
  type CanvasModuleExecutionState,
  type CanvasModuleNode,
  type CanvasModuleType,
  type CanvasProject,
  type PlacementObject,
  type ProjectImageAsset,
} from '@agent-canvas/domain';

export interface DurableCanvasStressFixture {
  readonly project: CanvasProject;
}

const MODULE_GROUPS = [
  ['image_input', 80],
  ['canvas_library', 40],
  ['reverse_agent', 50],
  ['text_prompt', 50],
  ['image_generation', 50],
  ['video_generation', 29],
] as const satisfies ReadonlyArray<readonly [CanvasModuleType, number]>;

const EXECUTION_STATES: readonly CanvasModuleExecutionState[] = ['idle', 'running', 'failed', 'completed'];

export function createDurableCanvasStressProject(): DurableCanvasStressFixture {
  const assets = createManagedAssets(80);
  const nodes = createStressModules(assets);
  const placement = createPlacementNode(assets);
  const edges = createStressEdges();
  const project = parseCanvasProject({
    version: 1,
    graphVersion: 2,
    id: 'durable-canvas-stress-project',
    name: 'Novus Atelier 300 节点耐久画布 / Durable canvas acceptance',
    nodes: [...nodes, placement],
    edges,
    assets,
    projectMemory: [],
    skillPromotionCandidates: [],
  });
  return { project };
}

function createManagedAssets(count: number): ProjectImageAsset[] {
  return Array.from({ length: count }, (_, index) => {
    const assetId = (index + 1).toString(16).padStart(16, '0');
    return {
      assetId,
      byteSize: 48_000 + index * 137,
      extension: 'png' as const,
      height: 180,
      label: `受管缩略图 ${String(index + 1).padStart(2, '0')} · 高端产品长名称 / Managed thumbnail ${String(index + 1).padStart(2, '0')} for durable stress evidence`,
      mediaType: 'image/png' as const,
      origin: 'imported' as const,
      sha256: assetId.repeat(4),
      width: 240,
    };
  });
}

function createStressModules(assets: readonly ProjectImageAsset[]): CanvasModuleNode[] {
  const nodes: CanvasModuleNode[] = [];
  let globalIndex = 0;
  for (const [moduleType, count] of MODULE_GROUPS) {
    for (let index = 0; index < count; index += 1) {
      const id = `stress-${moduleType}-${index}`;
      const baseNode = createCanvasModuleNode(id, moduleType, {
        x: (globalIndex % 20) * 310,
        y: Math.floor(globalIndex / 20) * 330,
      });
      const executionState = EXECUTION_STATES[globalIndex % EXECUTION_STATES.length]!;
      const node: CanvasModuleNode = {
        ...baseNode,
        data: {
          ...baseNode.data,
          execution: {
            state: executionState,
            ...(executionState === 'idle' ? {} : { latestExecutionId: `stress-execution-${globalIndex}` }),
          },
          config: configureStressModule(baseNode, index, assets),
        },
      };
      nodes.push(node);
      globalIndex += 1;
    }
  }
  return nodes;
}

function configureStressModule(
  node: CanvasModuleNode,
  index: number,
  assets: readonly ProjectImageAsset[],
): Record<string, unknown> {
  const asset = assets[index % assets.length]!;
  if (node.data.moduleType === 'image_input') {
    return { ...node.data.config, assetId: asset.assetId };
  }
  if (node.data.moduleType === 'canvas_library') {
    return {
      ...node.data.config,
      assetIds: [asset.assetId, assets[(index + 7) % assets.length]!.assetId],
    };
  }
  if (node.data.moduleType === 'reverse_agent') {
    return {
      ...node.data.config,
      orderedMedia: [
        { kind: 'image', assetId: asset.assetId, label: asset.label },
        {
          kind: 'video',
          assetId: `managed-video-${String(index).padStart(3, '0')}`,
          label: `广告片段 ${index + 1} / Campaign video range ${index + 1}`,
          ranges: [{ startMs: 1_500 + index * 10, endMs: 6_250 + index * 10 }],
        },
      ],
      resultState: index % 3 === 0 ? 'stale' : 'fresh',
      skillName: '商业视觉反推 / Commercial visual reverse',
    };
  }
  if (node.data.moduleType === 'text_prompt') {
    return {
      ...node.data.config,
      prompt: `第 ${index + 1} 组高端产品场景提示 / Premium product scene prompt ${index + 1}`,
    };
  }
  if (node.data.moduleType === 'image_generation') {
    return {
      ...node.data.config,
      referenceAssetIds: [asset.assetId],
      resultState: index % 2 === 0 ? 'stale' : 'fresh',
      routeDisplayName: 'Deterministic acceptance route',
    };
  }
  return {
    ...node.data.config,
    resultState: index % 2 === 0 ? 'stale' : 'fresh',
  };
}

function createPlacementNode(assets: readonly ProjectImageAsset[]): CanvasProject['nodes'][number] {
  const roles = ['product_identity', 'scene_composition', 'prop_reference'] as const;
  const objects: PlacementObject[] = roles.map((role, index) => ({
    id: `stress-reference-${index + 1}`,
    assetId: assets[index]!.assetId,
    role,
    x: 0.12 + index * 0.22,
    y: 0.18 + index * 0.16,
    w: 0.24,
    h: 0.28,
    rotation: 0,
    zIndex: index + 1,
    locked: false,
    visible: true,
    flipX: false,
    flipY: false,
    semanticLayer: role === 'product_identity' ? 'hero_product' : role === 'scene_composition' ? 'background' : 'optional_prop',
    name: assets[index]!.label,
  }));
  return {
    id: 'stress-placement-references',
    type: 'placement_preview',
    position: { x: 0, y: 5_280 },
    data: {
      board: {
        id: 'stress-placement-board',
        aspectRatio: '4:5',
        width: 1080,
        height: 1350,
        safeAreas: [],
      },
      objects,
    },
  };
}

function createStressEdges(): CanvasEdge[] {
  const edges: CanvasEdge[] = [];
  const reverseReferenceOrder = new Map<string, number>();
  const generationReferenceOrder = new Map<string, number>();

  for (let index = 0; index < 300; index += 1) {
    const target = `stress-reverse_agent-${index % 50}`;
    const order = reverseReferenceOrder.get(target) ?? 0;
    reverseReferenceOrder.set(target, order + 1);
    edges.push({
      id: `stress-edge-reverse-reference-${index}`,
      source: `stress-image_input-${index % 80}`,
      sourcePortId: 'image',
      target,
      targetPortId: 'references',
      order,
    });
  }
  for (let index = 0; index < 100; index += 1) {
    const target = `stress-image_generation-${index % 50}`;
    const order = generationReferenceOrder.get(target) ?? 0;
    generationReferenceOrder.set(target, order + 1);
    edges.push({
      id: `stress-edge-generation-reference-${index}`,
      source: `stress-canvas_library-${index % 40}`,
      sourcePortId: 'images',
      target,
      targetPortId: 'references',
      order,
    });
  }
  for (let index = 0; index < 50; index += 1) {
    edges.push({
      id: `stress-edge-generation-prompt-${index}`,
      source: `stress-text_prompt-${index}`,
      sourcePortId: 'prompt',
      target: `stress-image_generation-${index}`,
      targetPortId: 'prompt',
      order: 0,
    });
  }
  for (let index = 0; index < 29; index += 1) {
    edges.push({
      id: `stress-edge-video-prompt-${index}`,
      source: `stress-text_prompt-${index}`,
      sourcePortId: 'prompt',
      target: `stress-video_generation-${index}`,
      targetPortId: 'prompt',
      order: 0,
    });
  }
  for (let index = 0; index < 21; index += 1) {
    const target = `stress-reverse_agent-${index}`;
    const order = reverseReferenceOrder.get(target) ?? 0;
    reverseReferenceOrder.set(target, order + 1);
    edges.push({
      id: `stress-edge-extra-reference-${index}`,
      source: `stress-image_input-${index}`,
      sourcePortId: 'image',
      target,
      targetPortId: 'references',
      order,
    });
  }
  return edges;
}
