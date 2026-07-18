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
  readonly primaryLabel: string;
  readonly secondaryLabel: string;
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
  readonly primaryName: string;
  readonly secondaryName: string;
  readonly description: string;
  readonly purpose: string;
  readonly usage: string;
  readonly categoryDisplay: {
    readonly primaryName: string;
    readonly secondaryName: string;
  };
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

const CATEGORY_DISPLAY = Object.freeze({
  input: Object.freeze({ primaryName: '输入', secondaryName: 'Input' }),
  generation: Object.freeze({ primaryName: '生成', secondaryName: 'Generation' }),
  editing: Object.freeze({ primaryName: '编辑', secondaryName: 'Editing' }),
  analysis: Object.freeze({ primaryName: '分析', secondaryName: 'Analysis' }),
  output: Object.freeze({ primaryName: '输出', secondaryName: 'Output' }),
} as const);

const PORT_PRIMARY_LABELS: Readonly<Record<string, string>> = Object.freeze({
  Analysis: '分析',
  Camera: '镜头',
  Image: '图像',
  Images: '图像组',
  Mask: '蒙版',
  Materials: '材质',
  Pose: '姿态',
  Prompt: '提示词',
  References: '参考图',
  Result: '结果',
  Video: '视频',
});

const MODULE_LOCALIZATION: Readonly<Record<CanvasModuleType, {
  readonly primaryName: string;
  readonly secondaryName: string;
  readonly description: string;
  readonly purpose: string;
  readonly usage: string;
  readonly aliases: readonly string[];
}>> = Object.freeze({
  image_input: Object.freeze({ primaryName: '图像输入', secondaryName: 'Image Input', description: '从项目素材中选择一张受管图像。', purpose: '为工作流提供稳定的图像资产输入。', usage: '选择或导入项目图像后连接到编辑、分析或生成模块。', aliases: ['图片输入', '参考图'] }),
  upload_image: Object.freeze({ primaryName: '上传图片', secondaryName: 'Upload Image', description: '通过桌面安全选择器导入受管图像。', purpose: '将本地图像安全加入项目素材。', usage: '激活模块后使用受限导入操作选择图片。', aliases: ['导入图片', '上传图像'] }),
  video_input: Object.freeze({ primaryName: '视频输入', secondaryName: 'Video Input', description: '为视频分析工作流提供受管视频输入。', purpose: '绑定待拆解的视频资产。', usage: '选择项目视频并连接到视频反推拆解。', aliases: ['视频素材', '输入视频'] }),
  canvas_library: Object.freeze({ primaryName: '画布素材库', secondaryName: 'Canvas Library', description: '整理并输出有序的项目参考图集合。', purpose: '集中管理多张生成或分析参考图。', usage: '勾选素材、调整顺序，再连接到支持多参考图的模块。', aliases: ['素材库', '参考图库'] }),
  text_prompt: Object.freeze({ primaryName: '文本提示词', secondaryName: 'Text Prompt', description: '编写可复用的生成或分析文本。', purpose: '向下游模块提供结构化提示词。', usage: '填写文本后连接到图像生成或 Agent 模块。', aliases: ['提示词', '文本'] }),
  image_generation_v1: Object.freeze({ primaryName: '图像生成 v1', secondaryName: 'Image Generation v1', description: '使用基础参考图与提示词执行图像生成。', purpose: '提供兼容的基础生图路线。', usage: '连接提示词和参考图，确认模型路线后执行。', aliases: ['生图 v1', '图片生成'] }),
  image_generation_v2: Object.freeze({ primaryName: '图像生成 v2', secondaryName: 'Image Generation v2', description: '组合提示词、参考图、蒙版和姿态执行图像生成。', purpose: '提供更完整的可控图像生成能力。', usage: '至少连接提示词与参考图，可选连接蒙版和姿态。', aliases: ['生图 v2', '可控生图'] }),
  image_editor: Object.freeze({ primaryName: '图像编辑', secondaryName: 'Image Editor', description: '结合图像与可选蒙版进行受控编辑。', purpose: '完成局部修改与蒙版工作流。', usage: '连接原图和可选蒙版，再选择兼容编辑路线。', aliases: ['图片编辑', '局部编辑'] }),
  openpose: Object.freeze({ primaryName: '姿态提取', secondaryName: 'OpenPose', description: '从图像中提取姿态结构数据。', purpose: '为可控生成提供人物姿态约束。', usage: '连接人物图像，执行后将姿态输出到生成模块。', aliases: ['姿势', '骨骼', 'open pose'] }),
  reverse_agent: Object.freeze({ primaryName: 'Agent 反推', secondaryName: 'Reverse Agent', description: '分析参考图并整理可执行的复现方向。', purpose: '将视觉参考转化为结构化分析与提示词依据。', usage: '按顺序连接参考图，确认知识与路线后开始反推。', aliases: ['反推', '反推提示词', 'reverse prompt', 'reference analysis'] }),
  skill_agent: Object.freeze({ primaryName: 'Skill 助手', secondaryName: 'Skill Agent', description: '结合项目知识分析并提出可复用建议。', purpose: '辅助整理工作流经验与技能候选。', usage: '连接可选参考图并描述需要分析的问题。', aliases: ['技能助手', '知识分析'] }),
  detail_page_agent: Object.freeze({ primaryName: '详情页 Agent', secondaryName: 'Detail Page Agent', description: '分析电商详情页的内容与视觉结构。', purpose: '规划商品详情页信息层级和视觉表达。', usage: '连接商品参考素材并说明目标平台与受众。', aliases: ['详情页', '电商分析'] }),
  video_analysis: Object.freeze({ primaryName: '视频反推拆解', secondaryName: 'Video Reverse Analysis', description: '拆解视频镜头、节奏、场景和视觉关系。', purpose: '把视频参考整理为可执行的镜头分析。', usage: '连接视频资产并选择支持长视频的分析路线。', aliases: ['视频反推', '视频拆解', 'video understanding'] }),
  line_art_material: Object.freeze({ primaryName: '线稿材质分析', secondaryName: 'Line Art Material', description: '识别线稿结构、材质与光照方向。', purpose: '为重绘和材质复现提供分析依据。', usage: '连接图像后执行视觉分析并输出材质计划。', aliases: ['线稿', '材质分析', 'line art'] }),
  result_output: Object.freeze({ primaryName: '结果输出', secondaryName: 'Result Output', description: '汇总生成结果并输出受管图像。', purpose: '作为工作流结果的稳定出口。', usage: '连接生成结果后检查并加入项目素材。', aliases: ['输出', '最终结果'] }),
});

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
  const localization = MODULE_LOCALIZATION[type];
  const frozenInputs = inputs.map(freezePort);
  const frozenOutputs = outputs.map(freezePort);
  return Object.freeze({
    type,
    version: 1 as const,
    category,
    displayName,
    primaryName: localization.primaryName,
    secondaryName: localization.secondaryName,
    description: localization.description,
    purpose: localization.purpose,
    usage: localization.usage,
    categoryDisplay: CATEGORY_DISPLAY[category],
    iconKey,
    searchAliases: Object.freeze([...new Set([...searchAliases, ...localization.aliases, ...capabilities])]),
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
    primaryLabel: PORT_PRIMARY_LABELS[label] ?? label,
    secondaryLabel: label,
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
    primaryLabel: PORT_PRIMARY_LABELS[label] ?? label,
    secondaryLabel: label,
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
    primaryLabel: PORT_PRIMARY_LABELS[label] ?? label,
    secondaryLabel: label,
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
    primaryLabel: PORT_PRIMARY_LABELS[label] ?? label,
    secondaryLabel: label,
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
    categoryDisplay: Object.freeze({ ...item.categoryDisplay }),
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
