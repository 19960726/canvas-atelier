import { describe, expect, it } from 'vitest';
import type {
  CanvasModuleExecutionState,
  CanvasModulePortDefinition,
} from './canvas-module';
import type {
  CanvasModuleExecutionState as PublicCanvasModuleExecutionState,
  CanvasModulePortDefinition as PublicCanvasModulePortDefinition,
} from './index';
import {
  CANVAS_MODULE_DEFINITIONS,
  createCanvasModuleNode,
  getCanvasModuleDefinition,
  listCanvasModuleDefinitions,
} from './canvas-module';

function snapshotPort(port: Pick<CanvasModulePortDefinition, 'id' | 'label' | 'dataType' | 'direction' | 'cardinality' | 'required'>) {
  return {
    id: port.id,
    label: port.label,
    dataType: port.dataType,
    direction: port.direction,
    cardinality: port.cardinality,
    required: port.required,
  };
}

function snapshotDefinition(type: string) {
  const definition = getCanvasModuleDefinition(type as never);
  return {
    type: definition.type,
    category: definition.category,
    executionMode: definition.executionMode,
    capabilities: [...definition.capabilities],
    runtimeProfiles: [...definition.runtimeProfiles],
    ports: definition.ports.map(snapshotPort),
  };
}

describe('canvas module registry', () => {
  it('exposes immutable bilingual discovery metadata without changing stable type ids or versions', () => {
    const reverseAgent = getCanvasModuleDefinition('reverse_agent');
    const videoAnalysis = getCanvasModuleDefinition('video_analysis');

    expect(reverseAgent).toMatchObject({
      type: 'reverse_agent',
      version: 1,
      primaryName: 'Agent 反推',
      secondaryName: 'Reverse Agent',
      description: expect.stringContaining('参考'),
      purpose: expect.any(String),
      usage: expect.any(String),
      categoryDisplay: { primaryName: '分析', secondaryName: 'Analysis' },
    });
    expect(videoAnalysis).toMatchObject({
      primaryName: '视频反推拆解',
      secondaryName: 'Video Reverse Analysis',
    });
    expect(reverseAgent.searchAliases).toEqual(expect.arrayContaining(['反推', 'reverse prompt', 'vision']));
    expect(Object.isFrozen(reverseAgent.categoryDisplay)).toBe(true);
    expect(Object.isFrozen(reverseAgent.searchAliases)).toBe(true);
  });

  it('exposes the Task 1 type surface through the module and barrel exports', () => {
    const modulePort: CanvasModulePortDefinition = getCanvasModuleDefinition('image_generation_v2').ports[0]!;
    const publicPort: PublicCanvasModulePortDefinition = modulePort;
    const moduleState: CanvasModuleExecutionState = 'idle';
    const publicState: PublicCanvasModuleExecutionState = moduleState;

    expect(publicPort.id).toBe('prompt');
    expect(publicState).toBe('idle');
  });

  it('registers every approved type exactly once', () => {
    expect(listCanvasModuleDefinitions().map((item) => item.type)).toEqual([
      'image_input', 'upload_image', 'video_input', 'canvas_library', 'text_prompt',
      'image_generation_v1', 'image_generation_v2', 'image_editor',
      'openpose', 'reverse_agent', 'skill_agent', 'detail_page_agent',
      'video_analysis', 'line_art_material', 'result_output',
    ]);
    expect(new Set(CANVAS_MODULE_DEFINITIONS.map((item) => item.type)).size)
      .toBe(CANVAS_MODULE_DEFINITIONS.length);
  });

  it('exposes the exact approved contract table', () => {
    expect(listCanvasModuleDefinitions().map((item) => ({
      type: item.type,
      category: item.category,
      executionMode: item.executionMode,
      capabilities: [...item.capabilities],
      runtimeProfiles: [...item.runtimeProfiles],
      ports: item.ports.map(snapshotPort),
    }))).toEqual([
      {
        type: 'image_input',
        category: 'input',
        executionMode: 'local',
        capabilities: [],
        runtimeProfiles: ['legacy-win7', 'modern'],
        ports: [snapshotPort({
          id: 'image',
          label: 'Image',
          dataType: 'image_asset',
          direction: 'output',
          cardinality: 'one',
          required: true,
        })],
      },
      {
        type: 'upload_image',
        category: 'input',
        executionMode: 'local',
        capabilities: [],
        runtimeProfiles: ['legacy-win7', 'modern'],
        ports: [snapshotPort({
          id: 'image',
          label: 'Image',
          dataType: 'image_asset',
          direction: 'output',
          cardinality: 'one',
          required: true,
        })],
      },
      {
        type: 'video_input',
        category: 'input',
        executionMode: 'local',
        capabilities: [],
        runtimeProfiles: ['legacy-win7', 'modern'],
        ports: [snapshotPort({
          id: 'video',
          label: 'Video',
          dataType: 'video_asset',
          direction: 'output',
          cardinality: 'one',
          required: true,
        })],
      },
      {
        type: 'canvas_library',
        category: 'input',
        executionMode: 'local',
        capabilities: [],
        runtimeProfiles: ['legacy-win7', 'modern'],
        ports: [snapshotPort({
          id: 'images',
          label: 'Images',
          dataType: 'image_list',
          direction: 'output',
          cardinality: 'one',
          required: true,
        })],
      },
      {
        type: 'text_prompt',
        category: 'input',
        executionMode: 'local',
        capabilities: [],
        runtimeProfiles: ['legacy-win7', 'modern'],
        ports: [snapshotPort({
          id: 'prompt',
          label: 'Prompt',
          dataType: 'text_prompt',
          direction: 'output',
          cardinality: 'one',
          required: true,
        })],
      },
      {
        type: 'image_generation_v1',
        category: 'generation',
        executionMode: 'provider',
        capabilities: ['image_generation'],
        runtimeProfiles: ['legacy-win7', 'modern'],
        ports: [
          snapshotPort({
            id: 'prompt',
            label: 'Prompt',
            dataType: 'text_prompt',
            direction: 'input',
            cardinality: 'one',
            required: true,
          }),
          snapshotPort({
            id: 'references',
            label: 'References',
            dataType: 'image_list',
            direction: 'input',
            cardinality: 'many',
            required: true,
          }),
          snapshotPort({
            id: 'result',
            label: 'Result',
            dataType: 'generation_result',
            direction: 'output',
            cardinality: 'one',
            required: true,
          }),
        ],
      },
      {
        type: 'image_generation_v2',
        category: 'generation',
        executionMode: 'composite',
        capabilities: ['image_generation'],
        runtimeProfiles: ['legacy-win7', 'modern'],
        ports: [
          snapshotPort({
            id: 'prompt',
            label: 'Prompt',
            dataType: 'text_prompt',
            direction: 'input',
            cardinality: 'one',
            required: true,
          }),
          snapshotPort({
            id: 'references',
            label: 'References',
            dataType: 'image_list',
            direction: 'input',
            cardinality: 'many',
            required: true,
          }),
          snapshotPort({
            id: 'mask',
            label: 'Mask',
            dataType: 'mask_asset',
            direction: 'input',
            cardinality: 'one',
            required: false,
          }),
          snapshotPort({
            id: 'pose',
            label: 'Pose',
            dataType: 'pose_data',
            direction: 'input',
            cardinality: 'one',
            required: false,
          }),
          snapshotPort({
            id: 'result',
            label: 'Result',
            dataType: 'generation_result',
            direction: 'output',
            cardinality: 'one',
            required: true,
          }),
        ],
      },
      {
        type: 'image_editor',
        category: 'editing',
        executionMode: 'composite',
        capabilities: ['image_edit'],
        runtimeProfiles: ['legacy-win7', 'modern'],
        ports: [
          snapshotPort({
            id: 'image',
            label: 'Image',
            dataType: 'image_asset',
            direction: 'input',
            cardinality: 'one',
            required: true,
          }),
          snapshotPort({
            id: 'mask',
            label: 'Mask',
            dataType: 'mask_asset',
            direction: 'input',
            cardinality: 'one',
            required: false,
          }),
          snapshotPort({
            id: 'image',
            label: 'Image',
            dataType: 'image_asset',
            direction: 'output',
            cardinality: 'one',
            required: true,
          }),
          snapshotPort({
            id: 'mask',
            label: 'Mask',
            dataType: 'mask_asset',
            direction: 'output',
            cardinality: 'one',
            required: true,
          }),
        ],
      },
      {
        type: 'openpose',
        category: 'editing',
        executionMode: 'provider',
        capabilities: ['vision'],
        runtimeProfiles: ['legacy-win7', 'modern'],
        ports: [
          snapshotPort({
            id: 'image',
            label: 'Image',
            dataType: 'image_asset',
            direction: 'input',
            cardinality: 'one',
            required: true,
          }),
          snapshotPort({
            id: 'pose',
            label: 'Pose',
            dataType: 'pose_data',
            direction: 'output',
            cardinality: 'one',
            required: true,
          }),
        ],
      },
      {
        type: 'reverse_agent',
        category: 'analysis',
        executionMode: 'agent',
        capabilities: ['vision'],
        runtimeProfiles: ['legacy-win7', 'modern'],
        ports: [
          snapshotPort({
            id: 'references',
            label: 'References',
            dataType: 'image_list',
            direction: 'input',
            cardinality: 'many',
            required: true,
          }),
          snapshotPort({
            id: 'analysis',
            label: 'Analysis',
            dataType: 'analysis_document',
            direction: 'output',
            cardinality: 'one',
            required: true,
          }),
        ],
      },
      {
        type: 'skill_agent',
        category: 'analysis',
        executionMode: 'agent',
        capabilities: ['chat'],
        runtimeProfiles: ['legacy-win7', 'modern'],
        ports: [
          snapshotPort({
            id: 'references',
            label: 'References',
            dataType: 'image_list',
            direction: 'input',
            cardinality: 'many',
            required: false,
          }),
          snapshotPort({
            id: 'analysis',
            label: 'Analysis',
            dataType: 'analysis_document',
            direction: 'output',
            cardinality: 'one',
            required: true,
          }),
        ],
      },
      {
        type: 'detail_page_agent',
        category: 'analysis',
        executionMode: 'agent',
        capabilities: ['chat', 'vision'],
        runtimeProfiles: ['legacy-win7', 'modern'],
        ports: [
          snapshotPort({
            id: 'references',
            label: 'References',
            dataType: 'image_list',
            direction: 'input',
            cardinality: 'many',
            required: false,
          }),
          snapshotPort({
            id: 'analysis',
            label: 'Analysis',
            dataType: 'analysis_document',
            direction: 'output',
            cardinality: 'one',
            required: true,
          }),
        ],
      },
      {
        type: 'video_analysis',
        category: 'analysis',
        executionMode: 'agent',
        capabilities: ['video_understanding'],
        runtimeProfiles: ['legacy-win7', 'modern'],
        ports: [
          snapshotPort({
            id: 'video',
            label: 'Video',
            dataType: 'video_asset',
            direction: 'input',
            cardinality: 'one',
            required: true,
          }),
          snapshotPort({
            id: 'analysis',
            label: 'Analysis',
            dataType: 'analysis_document',
            direction: 'output',
            cardinality: 'one',
            required: true,
          }),
          snapshotPort({
            id: 'camera',
            label: 'Camera',
            dataType: 'camera_timeline',
            direction: 'output',
            cardinality: 'one',
            required: true,
          }),
        ],
      },
      {
        type: 'line_art_material',
        category: 'analysis',
        executionMode: 'agent',
        capabilities: ['vision'],
        runtimeProfiles: ['legacy-win7', 'modern'],
        ports: [
          snapshotPort({
            id: 'image',
            label: 'Image',
            dataType: 'image_asset',
            direction: 'input',
            cardinality: 'one',
            required: true,
          }),
          snapshotPort({
            id: 'analysis',
            label: 'Analysis',
            dataType: 'analysis_document',
            direction: 'output',
            cardinality: 'one',
            required: true,
          }),
          snapshotPort({
            id: 'materials',
            label: 'Materials',
            dataType: 'material_plan',
            direction: 'output',
            cardinality: 'one',
            required: true,
          }),
        ],
      },
      {
        type: 'result_output',
        category: 'output',
        executionMode: 'local',
        capabilities: [],
        runtimeProfiles: ['legacy-win7', 'modern'],
        ports: [
          snapshotPort({
            id: 'result',
            label: 'Result',
            dataType: 'generation_result',
            direction: 'input',
            cardinality: 'one',
            required: true,
          }),
          snapshotPort({
            id: 'image',
            label: 'Image',
            dataType: 'image_asset',
            direction: 'output',
            cardinality: 'one',
            required: true,
          }),
        ],
      },
    ]);
  });

  it('keeps canonical metadata immutable across lookup boundaries', () => {
    const expected = snapshotDefinition('image_generation_v2');
    const listed = listCanvasModuleDefinitions().find((item) => item.type === 'image_generation_v2');
    if (!listed) throw new Error('Missing image_generation_v2');

    const mutationAttempts = [
      () => { (listed.searchAliases as string[]).push('tampered'); },
      () => { (listed.capabilities as string[]).push('tampered'); },
      () => { (listed.runtimeProfiles as string[]).push('tampered'); },
      () => { ((listed.ports[0] as unknown as { label: string }).label) = 'Tampered'; },
      () => {
        ((listed.ports as unknown as CanvasModulePortDefinition[])).push({
          ...(listed.ports[0] as CanvasModulePortDefinition),
          id: 'extra',
        });
      },
    ];

    for (const attempt of mutationAttempts) {
      try {
        attempt();
      } catch {
        // Expected for frozen structures.
      }
    }

    expect(snapshotDefinition('image_generation_v2')).toEqual(expected);
    expect(snapshotDefinition(listCanvasModuleDefinitions().find((item) => item.type === 'image_generation_v2')!.type)).toEqual(expected);
  });

  it('creates fresh public config without protected payloads', () => {
    const first = createCanvasModuleNode('node-1', 'image_generation_v2', { x: 120, y: 80 });
    const second = createCanvasModuleNode('node-2', 'image_generation_v2', { x: 320, y: 80 });
    expect(first.data.config).not.toBe(second.data.config);
    expect(JSON.stringify(first)).not.toMatch(/Authorization|apiKey|token|base64|[A-Z]:\\/i);
    expect(first.data.moduleVersion).toBe(getCanvasModuleDefinition('image_generation_v2').version);
  });

  it('rejects unknown module lookup', () => {
    expect(() => getCanvasModuleDefinition('missing' as never)).toThrow(/unknown canvas module/i);
  });
});
