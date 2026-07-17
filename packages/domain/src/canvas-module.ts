import type { RuntimeProfileId } from './runtime-profile';

export type CanvasPortDataType =
  | 'image_asset' | 'image_list' | 'mask_asset' | 'pose_data'
  | 'text_prompt' | 'analysis_document' | 'video_asset'
  | 'camera_timeline' | 'material_plan' | 'generation_request'
  | 'generation_result';

export type CanvasModuleType =
  | 'image_input' | 'upload_image' | 'video_input' | 'canvas_library' | 'text_prompt'
  | 'image_generation_v1' | 'image_generation_v2' | 'image_editor'
  | 'openpose' | 'reverse_agent' | 'skill_agent' | 'detail_page_agent'
  | 'video_analysis' | 'line_art_material' | 'result_output';

interface CanvasModulePortDefinition {
  id: string;
  label: string;
  dataType: CanvasPortDataType;
  direction: 'input' | 'output';
  cardinality: 'one' | 'many';
  required: boolean;
}

export interface CanvasModuleDefinition {
  type: CanvasModuleType;
  version: 1;
  category: 'input' | 'generation' | 'editing' | 'analysis' | 'output';
  displayName: string;
  iconKey: string;
  searchAliases: readonly string[];
  runtimeProfiles: readonly RuntimeProfileId[];
  executionMode: 'local' | 'provider' | 'agent' | 'composite';
  capabilities: readonly string[];
  ports: readonly CanvasModulePortDefinition[];
  createDefaultConfig: () => Record<string, unknown>;
}

type CanvasModuleExecutionState =
  | 'idle' | 'invalid' | 'ready' | 'waiting_confirmation' | 'queued'
  | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled';

export interface CanvasModuleNodeData {
  moduleType: CanvasModuleType;
  moduleVersion: 1;
  config: Record<string, unknown>;
  execution: { state: CanvasModuleExecutionState; latestExecutionId?: string };
}

function definition(
  type: CanvasModuleType,
  category: CanvasModuleDefinition['category'],
  displayName: string,
  iconKey: string,
  searchAliases: readonly string[],
  executionMode: CanvasModuleDefinition['executionMode'],
  capabilities: readonly string[],
  inputs: readonly CanvasModulePortDefinition[],
  outputs: readonly CanvasModulePortDefinition[],
): CanvasModuleDefinition {
  return Object.freeze({
    type,
    version: 1 as const,
    category,
    displayName,
    iconKey,
    searchAliases: Object.freeze([...searchAliases]),
    runtimeProfiles: Object.freeze(['legacy-win7', 'modern'] as const),
    executionMode,
    capabilities: Object.freeze([...capabilities]),
    ports: Object.freeze([...inputs, ...outputs]),
    createDefaultConfig: () => ({}),
  });
}

function input(
  id: string,
  label: string,
  dataType: CanvasPortDataType,
  required = true,
): CanvasModulePortDefinition {
  return {
    id,
    label,
    dataType,
    direction: 'input',
    cardinality: 'one',
    required,
  };
}

function inputMany(
  id: string,
  label: string,
  dataType: CanvasPortDataType,
  required = true,
): CanvasModulePortDefinition {
  return {
    id,
    label,
    dataType,
    direction: 'input',
    cardinality: 'many',
    required,
  };
}

function out(
  id: string,
  label: string,
  dataType: CanvasPortDataType,
): CanvasModulePortDefinition {
  return {
    id,
    label,
    dataType,
    direction: 'output',
    cardinality: 'one',
    required: true,
  };
}

function outMany(
  id: string,
  label: string,
  dataType: CanvasPortDataType,
): CanvasModulePortDefinition {
  return {
    id,
    label,
    dataType,
    direction: 'output',
    cardinality: 'many',
    required: true,
  };
}

export const CANVAS_MODULE_DEFINITIONS = Object.freeze([
  definition('image_input', 'input', 'Image Input', 'image_input', ['image', 'input image'], 'local', [], [], [
    out('image', 'Image', 'image_asset'),
  ]),
  definition('upload_image', 'input', 'Upload Image', 'upload_image', ['upload', 'import image'], 'local', [], [], [
    out('image', 'Image', 'image_asset'),
  ]),
  definition('video_input', 'input', 'Video Input', 'video_input', ['video', 'input video'], 'local', [], [], [
    out('video', 'Video', 'video_asset'),
  ]),
  definition('canvas_library', 'input', 'Canvas Library', 'canvas_library', ['library', 'reference library'], 'local', [], [], [
    out('images', 'Images', 'image_list'),
  ]),
  definition('text_prompt', 'input', 'Text Prompt', 'text_prompt', ['prompt', 'text'], 'local', [], [], [
    out('prompt', 'Prompt', 'text_prompt'),
  ]),
  definition('image_generation_v1', 'generation', 'Image Generation v1', 'image_generation_v1', ['image generation', 'generation v1'], 'provider', ['image_generation'], [
    input('prompt', 'Prompt', 'text_prompt'),
    inputMany('references', 'References', 'image_list'),
  ], [
    out('result', 'Result', 'generation_result'),
  ]),
  definition('image_generation_v2', 'generation', 'Image Generation v2', 'image_generation_v2', ['image generation', 'generation v2'], 'composite', ['image_generation'], [
    input('prompt', 'Prompt', 'text_prompt'),
    inputMany('references', 'References', 'image_list'),
    input('mask', 'Mask', 'mask_asset', false),
    input('pose', 'Pose', 'pose_data', false),
  ], [
    out('result', 'Result', 'generation_result'),
  ]),
  definition('image_editor', 'editing', 'Image Editor', 'image_editor', ['image edit', 'editor'], 'composite', ['image_edit'], [
    input('image', 'Image', 'image_asset'),
    input('mask', 'Mask', 'mask_asset', false),
  ], [
    out('image', 'Image', 'image_asset'),
    out('mask', 'Mask', 'mask_asset'),
  ]),
  definition('openpose', 'editing', 'OpenPose', 'openpose', ['pose', 'open pose'], 'provider', ['vision'], [
    input('image', 'Image', 'image_asset'),
  ], [
    out('pose', 'Pose', 'pose_data'),
  ]),
  definition('reverse_agent', 'analysis', 'Reverse Agent', 'reverse_agent', ['reverse prompt', 'reference analysis'], 'agent', ['vision'], [
    inputMany('references', 'References', 'image_list'),
  ], [
    out('analysis', 'Analysis', 'analysis_document'),
  ]),
  definition('skill_agent', 'analysis', 'Skill Agent', 'skill_agent', ['skill', 'analysis agent'], 'agent', ['chat'], [
    inputMany('references', 'References', 'image_list', false),
  ], [
    out('analysis', 'Analysis', 'analysis_document'),
  ]),
  definition('detail_page_agent', 'analysis', 'Detail Page Agent', 'detail_page_agent', ['detail page', 'analysis agent'], 'agent', ['chat', 'vision'], [
    inputMany('references', 'References', 'image_list', false),
  ], [
    out('analysis', 'Analysis', 'analysis_document'),
  ]),
  definition('video_analysis', 'analysis', 'Video Analysis', 'video_analysis', ['video understanding', 'analysis'], 'agent', ['video_understanding'], [
    input('video', 'Video', 'video_asset'),
  ], [
    out('analysis', 'Analysis', 'analysis_document'),
    out('camera', 'Camera', 'camera_timeline'),
  ]),
  definition('line_art_material', 'analysis', 'Line Art Material', 'line_art_material', ['line art', 'material analysis'], 'agent', ['vision'], [
    input('image', 'Image', 'image_asset'),
  ], [
    out('analysis', 'Analysis', 'analysis_document'),
    out('materials', 'Materials', 'material_plan'),
  ]),
  definition('result_output', 'output', 'Result Output', 'result_output', ['result', 'output'], 'local', [], [
    input('result', 'Result', 'generation_result'),
  ], [
    out('image', 'Image', 'image_asset'),
  ]),
] as const);

export function listCanvasModuleDefinitions(): CanvasModuleDefinition[] {
  return CANVAS_MODULE_DEFINITIONS.map((item) => ({ ...item, ports: [...item.ports] }));
}

export function getCanvasModuleDefinition(type: CanvasModuleType): CanvasModuleDefinition {
  const found = CANVAS_MODULE_DEFINITIONS.find((item) => item.type === type);
  if (!found) throw new Error(`Unknown canvas module: ${String(type)}`);
  return found;
}

export function createCanvasModuleNode(id: string, moduleType: CanvasModuleType, position: { x: number; y: number }) {
  const module = getCanvasModuleDefinition(moduleType);
  return {
    id,
    type: 'module' as const,
    position,
    data: {
      moduleType,
      moduleVersion: module.version,
      config: module.createDefaultConfig(),
      execution: { state: 'idle' as const },
    },
  };
}
