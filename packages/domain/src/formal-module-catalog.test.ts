import { describe, expect, it } from 'vitest';
import {
  createCanvasModuleNode,
  getCanvasModuleDefinition,
  listCanvasModuleDefinitions,
} from './canvas-module';
import { migrateCanvasProjectGraph } from './module-graph';
import { parseCanvasProject } from './project-schema';

const CURRENT_TYPES = [
  'image_input',
  'upload_image',
  'video_input',
  'canvas_library',
  'text_prompt',
  'image_generation',
  'image_editor',
  'drawing_mask',
  'local_redraw',
  'image_compare',
  'openpose',
  'reverse_agent',
  'skill_agent',
  'detail_page_agent',
  'storyboard_sheet',
  'storyboard_chart',
  'line_art_material',
  'comfy_workflow',
  'music_generation',
  'speech_generation',
  'result_output',
] as const;

const LEGACY_TYPES = ['image_generation_v1', 'image_generation_v2', 'video_analysis'] as const;

describe('formal current module catalog', () => {
  it('lists exactly the current creatable types once and never lists legacy aliases', () => {
    const definitions = listCanvasModuleDefinitions();
    expect(definitions.map((definition) => definition.type)).toEqual(CURRENT_TYPES);
    expect(new Set(definitions.map((definition) => definition.type)).size).toBe(CURRENT_TYPES.length);
    for (const legacyType of LEGACY_TYPES) {
      expect(definitions.some((definition) => (definition.type as string) === legacyType)).toBe(false);
      expect(() => createCanvasModuleNode('legacy', legacyType as never, { x: 0, y: 0 })).toThrow(/legacy|unknown/i);
    }
  });

  it('publishes immutable bilingual metadata, typed ports, limitations, and valid downstream contracts', () => {
    const definitions = listCanvasModuleDefinitions();
    const currentTypes = new Set(definitions.map((definition) => definition.type));

    for (const definition of definitions) {
      expect(definition.primaryName).toMatch(/[\u3400-\u9fff]/u);
      expect(definition.secondaryName).toMatch(/[A-Za-z]/u);
      expect(definition.description).toMatch(/[\u3400-\u9fff]/u);
      expect(definition.purpose).toMatch(/[\u3400-\u9fff]/u);
      expect(definition.usage).toMatch(/[\u3400-\u9fff]/u);
      expect((definition as { limitations?: string }).limitations).toMatch(/[\u3400-\u9fff]/u);
      expect(definition.categoryDisplay.primaryName).toMatch(/[\u3400-\u9fff]/u);
      expect(definition.categoryDisplay.secondaryName).toMatch(/[A-Za-z]/u);
      expect(definition.searchAliases.length).toBeGreaterThan(0);
      expect(definition.capabilities).toBeInstanceOf(Array);
      expect(definition.ports.every((port) => port.id && port.primaryLabel && port.secondaryLabel && port.dataType)).toBe(true);
      const downstream = (definition as { recommendedDownstreamModuleTypes?: readonly string[] }).recommendedDownstreamModuleTypes;
      expect(downstream).toBeInstanceOf(Array);
      expect(downstream?.every((type) => currentTypes.has(type as never))).toBe(true);
      expect(Object.isFrozen(definition)).toBe(true);
      expect(Object.isFrozen(definition.ports)).toBe(true);
      expect(Object.isFrozen(downstream)).toBe(true);
    }
  });

  it('locks the unified generation, reverse, storyboard, audio, comparison, and controlled workflow ports', () => {
    expect(portSnapshot('image_generation')).toEqual([
      ['prompt', 'text_prompt', 'input', 'one', true],
      ['references', 'image_list', 'input', 'many', false],
      ['mask', 'mask_asset', 'input', 'one', false],
      ['pose', 'pose_data', 'input', 'one', false],
      ['result', 'generation_result', 'output', 'one', true],
    ]);
    expect(portSnapshot('reverse_agent')).toEqual([
      ['references', 'image_list', 'input', 'many', false],
      ['video', 'video_ranges', 'input', 'many', false],
      ['task', 'text_prompt', 'input', 'one', false],
      ['line_art', 'image_asset', 'input', 'one', false],
      ['analysis', 'analysis_document', 'output', 'one', true],
      ['timeline', 'camera_timeline', 'output', 'one', false],
    ]);
    expect(portSnapshot('image_compare')).toEqual(expect.arrayContaining([
      ['images', 'image_list', 'input', 'many', true],
      ['comparison', 'comparison_document', 'output', 'one', true],
      ['selected', 'image_asset', 'output', 'one', true],
    ]));
    expect(portSnapshot('storyboard_sheet')).toEqual(expect.arrayContaining([
      ['storyboard', 'storyboard_document', 'output', 'one', true],
    ]));
    expect(portSnapshot('storyboard_chart')).toEqual(expect.arrayContaining([
      ['chart', 'storyboard_chart', 'output', 'one', true],
    ]));
    expect(portSnapshot('music_generation')).toEqual(expect.arrayContaining([
      ['audio', 'audio_asset', 'output', 'one', true],
    ]));
    expect(portSnapshot('speech_generation')).toEqual(expect.arrayContaining([
      ['audio', 'audio_asset', 'output', 'one', true],
    ]));
    expect(portSnapshot('comfy_workflow')).toEqual(expect.arrayContaining([
      ['workflow', 'sanitized_workflow', 'input', 'one', true],
      ['result', 'generation_result', 'output', 'one', true],
    ]));
  });
});

describe('formal legacy graph migration', () => {
  it.each([
    ['image_generation_v1', 'image_generation'],
    ['image_generation_v2', 'image_generation'],
    ['video_analysis', 'reverse_agent'],
  ] as const)('migrates %s to %s without mutating or losing node identity and execution data', (legacyType, currentType) => {
    const input = legacyProject(legacyType);
    const before = cloneFixture(input);
    const migrated = migrateCanvasProjectGraph(input) as typeof input;

    expect(input).toEqual(before);
    expect(migrated.nodes[1]).toMatchObject({
      id: 'legacy-node',
      data: {
        moduleType: currentType,
        config: before.nodes[1]!.data.config,
        execution: before.nodes[1]!.data.execution,
      },
    });
    const migratedLegacyData = migrated.nodes[1]!.data as Record<string, unknown>;
    const beforeLegacyData = before.nodes[1]!.data as Record<string, unknown>;
    expect(migratedLegacyData.job).toEqual(beforeLegacyData.job);
    expect(migratedLegacyData.result).toEqual(beforeLegacyData.result);
    expect(migrated.edges.map((edge) => edge.id)).toEqual(before.edges.map((edge) => edge.id));
    expect(migrateCanvasProjectGraph(migrated)).toEqual(migrated);
    expect(parseCanvasProject(input).nodes[1]).toMatchObject({ data: { moduleType: currentType } });
  });

  it.each([
    ['image_generation_v1', ['references']],
    ['image_generation_v2', ['references', 'mask', 'pose']],
  ] as const)('normalizes %s capability slots for the current generation workbench', (legacyType, enabledInputCapabilities) => {
    const parsed = parseCanvasProject(legacyProject(legacyType));
    const node = parsed.nodes[1];
    expect(node).toMatchObject({
      type: 'module',
      data: {
        moduleType: 'image_generation',
        config: {
          enabledInputCapabilities,
          referenceAssetIds: ['ref-a', 'ref-b'],
          route: 'image-route',
        },
      },
    });
  });

  it('normalizes legacy video media and ranges for the current Reverse Agent workbench', () => {
    const parsed = parseCanvasProject(legacyProject('video_analysis'));
    expect(parsed.nodes[1]).toMatchObject({
      type: 'module',
      data: {
        moduleType: 'reverse_agent',
        config: {
          assetId: 'video-asset',
          ranges: [{ startMs: 1200, endMs: 4200 }],
          route: 'vision-long',
          orderedMedia: [{
            kind: 'video',
            assetId: 'video-asset',
            label: '迁移视频',
            ranges: [{ startMs: 1200, endMs: 4200 }],
          }],
        },
      },
    });
  });

  it('migrates mixed graphs and translates legacy video ports without changing ids or ordering', () => {
    const input = {
      version: 1,
      graphVersion: 2,
      id: 'mixed',
      name: 'mixed graph',
      nodes: [
        legacyProject('image_generation_v1').nodes[1],
        { ...legacyProject('image_generation_v2').nodes[1], id: 'legacy-v2' },
        { ...legacyProject('video_analysis').nodes[1], id: 'legacy-video' },
        createCanvasModuleNode('current', 'reverse_agent', { x: 900, y: 0 }),
      ],
      edges: [
        { id: 'video-in', source: 'current', sourcePortId: 'analysis', target: 'legacy-video', targetPortId: 'video', order: 0 },
        { id: 'camera-out', source: 'legacy-video', sourcePortId: 'camera', target: 'current', targetPortId: 'task', order: 1 },
      ],
    };

    const migrated = migrateCanvasProjectGraph(input) as typeof input;
    expect(migrated.nodes.map((node) => (node as { id: string }).id)).toEqual(input.nodes.map((node) => (node as { id: string }).id));
    expect(migrated.nodes.map((node) => (node as { data: { moduleType: string } }).data.moduleType)).toEqual([
      'image_generation', 'image_generation', 'reverse_agent', 'reverse_agent',
    ]);
    expect(migrated.edges).toEqual([
      { ...input.edges[0], targetPortId: 'video' },
      { ...input.edges[1], sourcePortId: 'timeline' },
    ]);
  });

  it('serializes parsed projects with current types only', () => {
    const parsed = parseCanvasProject(legacyProject('image_generation_v2'));
    const serialized = JSON.parse(JSON.stringify(parsed)) as { nodes: Array<{ data?: { moduleType?: string } }> };
    const serializedTypes = serialized.nodes.map((node) => node.data?.moduleType).filter(Boolean);
    expect(serializedTypes).toEqual(['text_prompt', 'image_generation']);
    expect(serializedTypes.join('|')).not.toMatch(/image_generation_v1|image_generation_v2|video_analysis/u);
  });

  it.each(['job', 'result'] as const)('rejects protected payloads preserved in migrated %s data', (field) => {
    const input = legacyProject('image_generation_v1');
    const legacyData = input.nodes[1]!.data as Record<string, unknown>;
    const protectedKey = ['authoriz', 'ation'].join('');
    legacyData[field] = {
      id: `${field}-protected`,
      [protectedKey]: ['Bearer', 'abcdefghijklmnop'].join(' '),
    };

    expect(() => parseCanvasProject(input)).toThrow(/protected payload/i);
  });

  it.each([
    ['job', 'rawProviderPayload'],
    ['job', 'providerResponse'],
    ['job', 'request'],
    ['result', 'response'],
    ['result', 'payload'],
    ['result', 'body'],
  ] as const)('rejects non-public durable %s field %s', (field, forbiddenField) => {
    const input = legacyProject('image_generation_v2');
    const legacyData = input.nodes[1]!.data as Record<string, unknown>;
    legacyData[field] = { id: `${field}-unsafe`, [forbiddenField]: 'opaque-provider-data' };

    expect(() => parseCanvasProject(input)).toThrow(/Unrecognized key|public summary/i);
  });

  it('rejects unmanaged durable result asset references', () => {
    const input = legacyProject('image_generation_v2');
    const legacyData = input.nodes[1]!.data as Record<string, unknown>;
    legacyData.result = { id: 'result-unmanaged', assetId: 'provider-result-url-id' };

    expect(() => parseCanvasProject(input)).toThrow(/managed|asset/i);
  });
});

function portSnapshot(type: string) {
  return getCanvasModuleDefinition(type as never).ports.map((port) => [
    port.id,
    port.dataType,
    port.direction,
    port.cardinality,
    port.required,
  ]);
}

function cloneFixture<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function legacyProject(legacyType: typeof LEGACY_TYPES[number]) {
  const isVideo = legacyType === 'video_analysis';
  const isV2 = legacyType === 'image_generation_v2';
  return {
    version: 1,
    graphVersion: 2,
    id: `project-${legacyType}`,
    name: `legacy ${legacyType}`,
    nodes: [
      createCanvasModuleNode('prompt', 'text_prompt', { x: 0, y: 0 }),
      {
        id: 'legacy-node',
        type: 'module' as const,
        position: { x: 320, y: 0 },
        data: {
          moduleType: legacyType,
          moduleVersion: 1 as const,
          config: isVideo
            ? { assetId: 'video-asset', ranges: [{ startMs: 1200, endMs: 4200 }], route: 'vision-long' }
            : {
                prompt: 'studio light',
                referenceAssetIds: ['ref-a', 'ref-b'],
                ...(isV2 ? { maskAssetId: 'mask-a', poseId: 'pose-a' } : {}),
                route: 'image-route',
              },
          execution: { state: 'completed' as const, latestExecutionId: 'execution-7' },
          job: { id: 'job-7', executionId: 'execution-7', status: 'completed' as const, provider: 'compatible-provider', route: isVideo ? 'vision-long' : 'image-route', progress: 1 },
          result: { id: 'result-7', assetId: '0123456789abcdef', mediaType: 'image/png' as const, width: 1024, height: 1024 },
        },
      },
    ],
    edges: isVideo
      ? [{ id: 'video-edge', source: 'prompt', sourcePortId: 'prompt', target: 'legacy-node', targetPortId: 'video', order: 0 }]
      : [{ id: 'prompt-edge', source: 'prompt', sourcePortId: 'prompt', target: 'legacy-node', targetPortId: 'prompt', order: 0 }],
  };
}
