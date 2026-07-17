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

export interface CanvasModulePortDefinition {
  readonly id: string;
  readonly label: string;
  readonly dataType: CanvasPortDataType;
  readonly direction: 'input' | 'output';
  readonly cardinality: 'one' | 'many';
  readonly required: boolean;
}

export interface CanvasModuleDefinition {
  readonly type: CanvasModuleType;
  readonly version: 1;
  readonly category: 'input' | 'generation' | 'editing' | 'analysis' | 'output';
  readonly displayName: string;
  readonly iconKey: string;
  readonly searchAliases: readonly string[];
  readonly runtimeProfiles: readonly RuntimeProfileId[];
  readonly executionMode: 'local' | 'provider' | 'agent' | 'composite';
  readonly capabilities: readonly string[];
  readonly ports: readonly CanvasModulePortDefinition[];
  readonly createDefaultConfig: () => Record<string, unknown>;
}

export type CanvasModuleExecutionState =
  | 'idle' | 'invalid' | 'ready' | 'waiting_confirmation' | 'queued'
  | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled';

export interface CanvasModuleNodeData {
  readonly moduleType: CanvasModuleType;
  readonly moduleVersion: 1;
  readonly config: Record<string, unknown>;
  readonly execution: { readonly state: CanvasModuleExecutionState; readonly latestExecutionId?: string };
}

const CANONICAL_RUNTIME_PROFILES = Object.freeze(['legacy-win7', 'modern'] as const);

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
  const frozenInputs = inputs.map(freezePort);
  const frozenOutputs = outputs.map(freezePort);
  return Object.freeze({
    type,
    version: 1 as const,
    category,
    displayName,
    iconKey,
    searchAliases: Object.freeze([...searchAliases]),
    runtimeProfiles: CANONICAL_RUNTIME_PROFILES,
    executionMode,
    capabilities: Object.freeze([...capabilities]),
    ports: Object.freeze([...frozenInputs, ...frozenOutputs]),
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
  } as const;
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
  } as const;
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
  } as const;
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
  } as const;
}

function freezePort(port: CanvasModulePortDefinition): CanvasModulePortDefinition {
  return Object.freeze({ ...port });
}

function cloneDefinition(item: CanvasModuleDefinition): CanvasModuleDefinition {
  return Object.freeze({
    ...item,
    searchAliases: Object.freeze([...item.searchAliases]),
    runtimeProfiles: Object.freeze([...item.runtimeProfiles]),
    capabilities: Object.freeze([...item.capabilities]),
    ports: Object.freeze(item.ports.map((port) => freezePort(port))),
  });
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
  return Object.freeze(CANVAS_MODULE_DEFINITIONS.map((item) => cloneDefinition(item))) as CanvasModuleDefinition[];
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
