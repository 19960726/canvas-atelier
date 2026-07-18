import type { RuntimeProfileId } from './runtime-profile';

export type CanvasPortDataType =
  | 'image_asset' | 'image_list' | 'mask_asset' | 'mask_list' | 'pose_data'
  | 'text_prompt' | 'analysis_document' | 'video_asset' | 'video_ranges'
  | 'camera_timeline' | 'material_plan' | 'generation_request'
  | 'generation_result' | 'comparison_document' | 'storyboard_document'
  | 'storyboard_chart' | 'sanitized_workflow' | 'audio_asset' | 'voice_profile_id';

export type CanvasModuleType =
  | 'image_input' | 'upload_image' | 'video_input' | 'canvas_library' | 'text_prompt'
  | 'image_generation' | 'image_editor' | 'drawing_mask' | 'local_redraw'
  | 'image_compare' | 'openpose' | 'reverse_agent' | 'skill_agent'
  | 'detail_page_agent' | 'storyboard_sheet' | 'storyboard_chart'
  | 'line_art_material' | 'comfy_workflow' | 'music_generation'
  | 'speech_generation' | 'result_output';

export type LegacyCanvasModuleType = 'image_generation_v1' | 'image_generation_v2' | 'video_analysis';
export type SerializedCanvasModuleType = CanvasModuleType | LegacyCanvasModuleType;

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
  readonly limitations: string;
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
  readonly recommendedDownstreamModuleTypes: readonly CanvasModuleType[];
  readonly createDefaultConfig: () => Record<string, unknown>;
}

export type CanvasModuleExecutionState =
  | 'idle' | 'invalid' | 'ready' | 'waiting_confirmation' | 'queued'
  | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled';

export interface CanvasModuleNodeData {
  readonly moduleType: CanvasModuleType;
  readonly moduleVersion: 1;
  config: Record<string, unknown>;
  execution: { readonly state: CanvasModuleExecutionState; readonly latestExecutionId?: string };
  readonly job?: Record<string, unknown>;
  readonly result?: Record<string, unknown>;
}

interface ModuleCopy {
  readonly primaryName: string;
  readonly secondaryName: string;
  readonly description: string;
  readonly purpose: string;
  readonly usage: string;
  readonly limitations: string;
  readonly aliases: readonly string[];
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
  Audio: '音频',
  Chart: '图表',
  Comparison: '对比',
  Image: '图片',
  Images: '图片组',
  Knowledge: '知识',
  'Line art': '线稿',
  Mask: '蒙版',
  Masks: '蒙版组',
  Materials: '材质方案',
  Pose: '姿态',
  Prompt: '提示词',
  References: '参考图',
  Result: '结果',
  Selected: '选中图片',
  Storyboard: '分镜',
  Task: '任务',
  Timeline: '时间线',
  Video: '视频',
  Voice: '声音配置',
  Workflow: '工作流',
});

const MODULE_COPY: Readonly<Record<CanvasModuleType, ModuleCopy>> = Object.freeze({
  image_input: copy('图片输入', 'Image Input', '从项目素材中选择一张受管图片。', '为工作流提供稳定的图片资产输入。', '选择项目图片后连接到编辑、分析或生成模块。', '仅接受项目受管资产，不读取任意本地路径。', ['图像输入', '参考图']),
  upload_image: copy('上传图片', 'Upload Image', '通过桌面安全选择器导入受管图片。', '将本地图片安全加入项目素材。', '激活模块后使用受限导入操作选择图片。', '导入由桌面主进程完成，渲染器不接触文件路径。', ['导入图片', '上传图像']),
  video_input: copy('视频输入', 'Video Input', '为多模态分析提供受管视频和范围。', '绑定待分析的视频资产。', '选择项目视频并标注需要分析的时间范围。', '当前仅定义受管视频合同，不提供任意网络视频抓取。', ['视频素材', '输入视频']),
  canvas_library: copy('画布素材库', 'Canvas Library', '整理并输出有序的项目参考图集合。', '集中管理多张生成或分析参考图。', '勾选素材、调整顺序，再连接到支持多参考图的模块。', '最多使用项目允许的参考图数量。', ['素材库', '参考图库']),
  text_prompt: copy('文本提示词', 'Text Prompt', '编写可复用的生成或分析文本。', '向下游模块提供结构化提示词。', '填写文本后连接到生成或 Agent 模块。', '文本本身不会触发付费执行。', ['提示词', '文本']),
  image_generation: copy('图片生成', 'Image Generation', '根据提示词和模型能力生成图片。', '提供唯一的图片生成入口。', '连接必需提示词，可按兼容模型能力添加参考图、蒙版与姿态。', '运行前必须配置兼容模型并确认；V1/V2 仅作为旧项目迁移别名。', ['图像生成', '生图', 'image generation v1', 'image generation v2', 'generation v1', 'generation v2', 'v1', 'v2']),
  image_editor: copy('图片编辑', 'Image Editor', '组合图片、提示词与可选蒙版执行受控编辑。', '完成常规图片修改和编辑准备。', '连接原图及可选蒙版、提示词，再选择兼容编辑路线。', '具体模型执行能力由后续动态路由提供。', ['图像编辑', '图片修改']),
  drawing_mask: copy('绘制蒙版', 'Drawing Mask', '在受管图片上定义可编辑区域。', '为编辑和局部重绘提供受管蒙版。', '连接图片并在画布工具中绘制需要修改的区域。', '本任务只提供合同和节点状态，不实现完整绘制器。', ['蒙版绘制', 'mask drawing']),
  local_redraw: copy('局部重绘', 'Local Redraw', '使用图片、蒙版和提示词生成局部修改结果。', '把明确的局部编辑意图转为生成结果。', '连接原图、蒙版和提示词，确认兼容模型后执行。', '必须同时提供图片、蒙版和提示词。', ['局部编辑', 'inpaint', 'local edit']),
  image_compare: copy('图片对比', 'Image Compare', '对比两张或更多受管图片并记录选择。', '支持结果评审、差异说明和首选图选择。', '连接至少两张图片，填写评审标准后进行对比。', '不会自动替用户做不可逆选择。', ['图像对比', 'compare images', 'comparison']),
  openpose: copy('姿态提取', 'OpenPose', '从图片中提取姿态结构数据。', '为可控生成提供人物姿态约束。', '连接人物图片，执行后将姿态输出到生成模块。', '仅适用于兼容姿态能力的模型路线。', ['姿势', '骨骼', 'open pose']),
  reverse_agent: copy('Agent 反推', 'Reverse Agent', '按顺序分析图片、视频、文本任务与线稿。', '把多模态参考转为结构化分析和视频时间线。', '连接任意可分析输入，选择 Skill、知识版本与兼容路线后运行。', '创建节点时可为空；执行时至少需要一个可分析的媒体或文本输入。', ['反推', '反推提示词', 'reverse prompt', 'reference analysis', '视频反推', 'video analysis', 'video understanding']),
  skill_agent: copy('Skill 助手', 'Skill Agent', '结合项目知识分析并提出可复用建议。', '辅助整理工作流经验与技能候选。', '连接可选参考图并描述需要分析的问题。', '不会自动发布知识或执行付费模型。', ['技能助手', '知识分析']),
  detail_page_agent: copy('详情页 Agent', 'Detail Page Agent', '分析电商详情页的内容与视觉结构。', '规划商品详情页信息层级和视觉表达。', '连接商品参考素材并说明目标平台与受众。', '输出为建议和结构，不保证平台审核结果。', ['详情页', '电商分析']),
  storyboard_sheet: copy('分镜表', 'Storyboard Sheet', '把分析、时间线、提示词和图片整理为分镜文档。', '形成可检查的镜头清单与生成计划。', '连接分析或时间线，可选加入提示词和参考图。', '只创建分镜合同，不在本任务中批量执行模型。', ['故事板', '镜头表', 'storyboard']),
  storyboard_chart: copy('分镜图表', 'Storyboard Chart', '把分镜文档呈现为结构化图表。', '便于检查镜头顺序、节奏和依赖。', '连接分镜表后生成图表视图。', '依赖有效的分镜文档输入。', ['分镜图', 'shot chart', 'storyboard chart']),
  line_art_material: copy('线稿材质分析', 'Line-art Material Analysis', '识别线稿区域、材质、色彩与光照方向。', '为受控上色和材质复现提供结构化区域方案。', '连接受管线稿，可选加入已批准知识上下文。', '不应静默改变线稿几何或主体比例。', ['线稿', '材质分析', 'line art', 'material color']),
  comfy_workflow: copy('受控工作流', 'Controlled Comfy Workflow', '执行经过清理的 Comfy 工作流合同。', '为节点式图像流程提供受控适配入口。', '连接已清理工作流，可选加入提示词、参考图、蒙版和姿态。', '拒绝任意路径、任意 URL、凭据和未清理节点。', ['受控 Comfy 工作流', 'comfy workflow', 'controlled comfy']),
  music_generation: copy('音乐生成', 'Music Generation', '根据文本、分析或时间线生成受管音频。', '为后续兼容音乐模型执行预留严格合同。', '连接创作文本或镜头节奏信息，配置兼容模型后运行。', '当前不可执行；需要后续任务提供兼容音乐模型。', ['配乐', 'music', 'audio generation']),
  speech_generation: copy('语音生成', 'Speech Generation', '根据文本和可选声音配置生成受管音频。', '为后续兼容语音合成执行预留严格合同。', '连接文本，可选指定不含凭据的声音配置标识。', '当前不可执行；需要后续任务提供兼容语音模型。', ['语音合成', 'tts', 'speech synthesis']),
  result_output: copy('结果输出', 'Result Output', '汇总生成结果并输出受管图片。', '作为工作流结果的稳定出口。', '连接生成结果后检查并加入项目素材。', '只接收受管生成结果，不暴露供应商原始地址。', ['输出', '最终结果']),
});

function copy(primaryName: string, secondaryName: string, description: string, purpose: string, usage: string, limitations: string, aliases: readonly string[]): ModuleCopy {
  return Object.freeze({ primaryName, secondaryName, description, purpose, usage, limitations, aliases: Object.freeze([...aliases]) });
}

function input(id: string, label: string, dataType: CanvasPortDataType, required = true): CanvasModulePortDefinition {
  return port(id, label, dataType, 'input', 'one', required);
}

function inputMany(id: string, label: string, dataType: CanvasPortDataType, required = true): CanvasModulePortDefinition {
  return port(id, label, dataType, 'input', 'many', required);
}

function out(id: string, label: string, dataType: CanvasPortDataType, required = true): CanvasModulePortDefinition {
  return port(id, label, dataType, 'output', 'one', required);
}

function port(id: string, label: string, dataType: CanvasPortDataType, direction: 'input' | 'output', cardinality: 'one' | 'many', required: boolean): CanvasModulePortDefinition {
  return Object.freeze({ id, label, primaryLabel: PORT_PRIMARY_LABELS[label] ?? label, secondaryLabel: label, dataType, direction, cardinality, required });
}

function definition(
  type: CanvasModuleType,
  category: CanvasModuleDefinition['category'],
  iconKey: string,
  executionMode: CanvasModuleDefinition['executionMode'],
  capabilities: readonly string[],
  ports: readonly CanvasModulePortDefinition[],
  downstream: readonly CanvasModuleType[],
  defaultConfig: Readonly<Record<string, unknown>> = Object.freeze({}),
): CanvasModuleDefinition {
  const metadata = MODULE_COPY[type];
  return Object.freeze({
    type,
    version: 1 as const,
    category,
    displayName: `${metadata.primaryName} / ${metadata.secondaryName}`,
    primaryName: metadata.primaryName,
    secondaryName: metadata.secondaryName,
    description: metadata.description,
    purpose: metadata.purpose,
    usage: metadata.usage,
    limitations: metadata.limitations,
    categoryDisplay: CATEGORY_DISPLAY[category],
    iconKey,
    searchAliases: Object.freeze([...new Set([metadata.primaryName, metadata.secondaryName, ...metadata.aliases, ...capabilities])]),
    runtimeProfiles: CANONICAL_RUNTIME_PROFILES,
    executionMode,
    capabilities: Object.freeze([...capabilities]),
    ports: Object.freeze([...ports]),
    recommendedDownstreamModuleTypes: Object.freeze([...downstream]),
    createDefaultConfig: () => cloneConfig(defaultConfig),
  });
}

function cloneConfig(config: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
}

export const CANVAS_MODULE_DEFINITIONS: readonly CanvasModuleDefinition[] = Object.freeze([
  definition('image_input', 'input', 'image_input', 'local', [], [out('image', 'Image', 'image_asset')], ['image_editor', 'drawing_mask', 'image_compare', 'reverse_agent', 'line_art_material']),
  definition('upload_image', 'input', 'upload_image', 'local', [], [out('image', 'Image', 'image_asset')], ['canvas_library', 'image_editor', 'reverse_agent']),
  definition('video_input', 'input', 'video_input', 'local', [], [out('video', 'Video', 'video_asset')], ['reverse_agent']),
  definition('canvas_library', 'input', 'canvas_library', 'local', [], [out('images', 'Images', 'image_list')], ['image_generation', 'image_compare', 'reverse_agent']),
  definition('text_prompt', 'input', 'text_prompt', 'local', [], [out('prompt', 'Prompt', 'text_prompt')], ['image_generation', 'local_redraw', 'reverse_agent', 'music_generation', 'speech_generation']),
  definition('image_generation', 'generation', 'image_generation', 'provider', ['image_generation'], [
    input('prompt', 'Prompt', 'text_prompt'),
    inputMany('references', 'References', 'image_list', false),
    input('mask', 'Mask', 'mask_asset', false),
    input('pose', 'Pose', 'pose_data', false),
    out('result', 'Result', 'generation_result'),
  ], ['result_output', 'image_compare', 'image_editor'], Object.freeze({ enabledInputCapabilities: ['references'], resultState: 'empty' })),
  definition('image_editor', 'editing', 'image_editor', 'composite', ['image_edit'], [
    input('image', 'Image', 'image_asset'), input('mask', 'Mask', 'mask_asset', false), input('prompt', 'Prompt', 'text_prompt', false),
    out('image', 'Image', 'image_asset'), out('mask', 'Mask', 'mask_asset', false),
  ], ['result_output', 'image_compare', 'drawing_mask']),
  definition('drawing_mask', 'editing', 'drawing_mask', 'local', ['mask_edit'], [input('image', 'Image', 'image_asset'), out('mask', 'Mask', 'mask_asset')], ['local_redraw', 'image_editor', 'image_generation']),
  definition('local_redraw', 'editing', 'local_redraw', 'composite', ['image_edit', 'local_redraw'], [
    input('image', 'Image', 'image_asset'), input('mask', 'Mask', 'mask_asset'), input('prompt', 'Prompt', 'text_prompt'), out('result', 'Result', 'generation_result'),
  ], ['result_output', 'image_compare']),
  definition('image_compare', 'analysis', 'image_compare', 'local', ['structured_comparison'], [
    inputMany('images', 'Images', 'image_list'), out('comparison', 'Comparison', 'comparison_document'), out('selected', 'Selected', 'image_asset'),
  ], ['result_output', 'local_redraw']),
  definition('openpose', 'editing', 'openpose', 'provider', ['vision', 'pose'], [input('image', 'Image', 'image_asset'), out('pose', 'Pose', 'pose_data')], ['image_generation', 'comfy_workflow']),
  definition('reverse_agent', 'analysis', 'reverse_agent', 'agent', ['chat', 'vision', 'video_understanding', 'structured_output'], [
    inputMany('references', 'References', 'image_list', false),
    inputMany('video', 'Video', 'video_ranges', false),
    input('task', 'Task', 'text_prompt', false),
    input('line_art', 'Line art', 'image_asset', false),
    out('analysis', 'Analysis', 'analysis_document'),
    out('timeline', 'Timeline', 'camera_timeline', false),
  ], ['image_generation', 'storyboard_sheet', 'line_art_material', 'detail_page_agent'], Object.freeze({ orderedMedia: [], mode: 'auto', resultState: 'empty' })),
  definition('skill_agent', 'analysis', 'skill_agent', 'agent', ['chat'], [inputMany('references', 'References', 'image_list', false), input('task', 'Task', 'text_prompt', false), out('analysis', 'Analysis', 'analysis_document')], ['reverse_agent', 'image_generation']),
  definition('detail_page_agent', 'analysis', 'detail_page_agent', 'agent', ['chat', 'vision', 'structured_output'], [inputMany('references', 'References', 'image_list', false), input('analysis', 'Analysis', 'analysis_document', false), out('analysis', 'Analysis', 'analysis_document')], ['storyboard_sheet', 'image_generation']),
  definition('storyboard_sheet', 'analysis', 'storyboard_sheet', 'composite', ['storyboard'], [
    input('analysis', 'Analysis', 'analysis_document', false), input('timeline', 'Timeline', 'camera_timeline', false), inputMany('prompts', 'Prompt', 'text_prompt', false), inputMany('images', 'Images', 'image_list', false), out('storyboard', 'Storyboard', 'storyboard_document'),
  ], ['storyboard_chart', 'image_generation', 'music_generation']),
  definition('storyboard_chart', 'analysis', 'storyboard_chart', 'local', ['storyboard'], [input('storyboard', 'Storyboard', 'storyboard_document'), out('chart', 'Chart', 'storyboard_chart')], ['result_output']),
  definition('line_art_material', 'analysis', 'line_art_material', 'agent', ['vision', 'structured_output', 'line_art_material'], [
    input('image', 'Line art', 'image_asset'), input('knowledge', 'Knowledge', 'analysis_document', false), out('materials', 'Materials', 'material_plan'), out('masks', 'Masks', 'mask_list'),
  ], ['image_generation', 'comfy_workflow', 'local_redraw']),
  definition('comfy_workflow', 'generation', 'comfy_workflow', 'composite', ['comfy_workflow', 'image_generation'], [
    input('workflow', 'Workflow', 'sanitized_workflow'), input('prompt', 'Prompt', 'text_prompt', false), inputMany('references', 'References', 'image_list', false), input('mask', 'Mask', 'mask_asset', false), input('pose', 'Pose', 'pose_data', false), out('result', 'Result', 'generation_result'),
  ], ['result_output', 'image_compare'], Object.freeze({ sanitized: true, resultState: 'empty' })),
  definition('music_generation', 'generation', 'music_generation', 'provider', ['music_generation'], [
    input('prompt', 'Prompt', 'text_prompt', false), input('analysis', 'Analysis', 'analysis_document', false), input('timeline', 'Timeline', 'camera_timeline', false), out('audio', 'Audio', 'audio_asset'),
  ], [], Object.freeze({ routeAvailable: false, availability: 'compatible_model_required' })),
  definition('speech_generation', 'generation', 'speech_generation', 'provider', ['speech_synthesis'], [
    input('prompt', 'Prompt', 'text_prompt'), input('voice', 'Voice', 'voice_profile_id', false), out('audio', 'Audio', 'audio_asset'),
  ], [], Object.freeze({ routeAvailable: false, availability: 'compatible_model_required' })),
  definition('result_output', 'output', 'result_output', 'local', [], [input('result', 'Result', 'generation_result'), out('image', 'Image', 'image_asset')], ['image_compare', 'canvas_library']),
]);

export function listCanvasModuleDefinitions(): CanvasModuleDefinition[] {
  return Object.freeze(CANVAS_MODULE_DEFINITIONS.map(cloneDefinition)) as CanvasModuleDefinition[];
}

export function getCanvasModuleDefinition(type: CanvasModuleType): CanvasModuleDefinition {
  const found = CANVAS_MODULE_DEFINITIONS.find((item) => item.type === type);
  if (!found) throw new Error(`Unknown or legacy canvas module: ${String(type)}`);
  return found;
}

function cloneDefinition(item: CanvasModuleDefinition): CanvasModuleDefinition {
  return Object.freeze({
    ...item,
    categoryDisplay: Object.freeze({ ...item.categoryDisplay }),
    searchAliases: Object.freeze([...item.searchAliases]),
    runtimeProfiles: Object.freeze([...item.runtimeProfiles]),
    capabilities: Object.freeze([...item.capabilities]),
    ports: Object.freeze(item.ports.map((portValue) => Object.freeze({ ...portValue }))),
    recommendedDownstreamModuleTypes: Object.freeze([...item.recommendedDownstreamModuleTypes]),
  });
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
