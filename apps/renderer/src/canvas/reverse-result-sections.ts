import type { ReversePromptResult } from '@agent-canvas/domain';

export interface ReverseResultSection {
  readonly id: string;
  readonly title: string;
  readonly text: string;
  readonly kind: 'analysis' | 'prompt' | 'constraint' | 'checklist';
  readonly sendTarget: 'image_generation' | 'video_generation' | 'either' | 'none';
}

export function buildReverseResultSections(result: Partial<ReversePromptResult>): ReverseResultSection[] {
  const sections: ReverseResultSection[] = [];
  addSection(sections, 'analysis', '分析', result.analysis, 'analysis', 'none');
  addSection(sections, 'keywords', '关键词', result.keywords?.join(' · '), 'analysis', 'either');

  if (result.mediaResponsibilities?.length) {
    addSection(
      sections,
      'scene-responsibilities',
      '素材职责与取舍',
      result.mediaResponsibilities.map((item, index) => [
        `${item.mention === undefined
          ? `${index + 1}. ${item.label ?? item.sourceId}`
          : item.label === undefined || item.label === item.mention
            ? item.mention
            : `${item.mention} · ${item.label}`}（${item.sourceId}）`,
        `职责：${item.role}`,
        `优先级：${item.priority}`,
        `可用元素：${item.usableElements.join('；')}`,
        `继承：${item.inheritance.length > 0 ? item.inheritance.join('；') : '无'}`,
        `冲突：${item.conflicts.length > 0 ? item.conflicts.join('；') : '无'}`,
      ].join('\n')).join('\n\n'),
      'analysis',
      'none',
    );
  }

  for (const [key, id, title, target] of PROFESSIONAL_CHAPTERS) {
    const value = result[key];
    if (value !== undefined) addSection(sections, id, title, formatChapterValue(value), 'analysis', target);
  }
  if (result.completeness?.status === 'partial') {
    const names = (keys: readonly string[]) => keys.map(chapterTitle).join('、');
    addSection(sections, 'completeness', '部分分析 · 待补充', [
      result.completeness.missingSections.length ? '缺失章节：' + names(result.completeness.missingSections) : '',
      result.completeness.invalidSections.length ? '格式不完整：' + names(result.completeness.invalidSections) : '',
      '以下保留已返回的内容；缺失部分不能据此认定为已完成。',
    ].filter(Boolean).join('\n'), 'checklist', 'none');
  }
  for (const part of result.partialSections ?? []) {
    let value: unknown = part.content;
    try { value = JSON.parse(part.content); } catch { /* Legacy partial text remains readable. */ }
    addSection(sections, 'partial-' + part.section, chapterTitle(part.section) + '（部分内容）', formatChapterValue(value), 'analysis', 'none');
  }

  if (result.promptLogic) {
    const logic = result.promptLogic;
    addSection(sections, 'prompt-logic', '生图提示词逻辑', [
      `主体：${logic.subject}`,
      `动作：${logic.action}`,
      `环境：${logic.environment}`,
      `相机与构图：${logic.cameraAndComposition}`,
      `灯光与色彩：${logic.lightingAndColor}`,
      `材质与纹理：${logic.materialsAndTextures}`,
      `特效或流体：${logic.effectsOrFluids}`,
      `风格与质量：${logic.styleAndQuality}`,
      `逻辑说明：${logic.rationale.join('；')}`,
    ].join('\n'), 'analysis', 'image_generation');
  }

  addSection(sections, 'prompt-zh', result.positivePromptZh ? '中文生图提示词' : '反推正向提示词', result.positivePromptZh ?? result.positivePrompt, 'prompt', 'image_generation');
  addSection(sections, 'prompt-en', 'English Image Prompt', result.positivePromptEn, 'prompt', 'image_generation');
  addSection(sections, 'negative-constraints', '负面约束', result.negativeConstraints?.map((item) => '- ' + item).join('\n'), 'constraint', 'either');
  addSection(sections, 'execution-checklist', '执行检查清单', result.executionChecklist?.map((item, index) => (index + 1) + '. ' + item).join('\n'), 'checklist', 'none');

  const seedance = result.seedance25;
  if (seedance) {
    addSection(sections, 'seedance-task', 'Seedance 2.5 任务判断', `任务类型：${seedance.taskType}\n判断依据：${seedance.rationale}`, 'analysis', 'video_generation');
    addSection(sections, 'seedance-assets', 'Seedance 素材职责', seedance.assetBindings.map((binding, index) => [
      `${index + 1}. ${binding.sourceId} → ${binding.target}`,
      `采用：${binding.adopt.join('；')}`,
      `拒绝：${binding.reject.length > 0 ? binding.reject.join('；') : '无'}`,
    ].join('\n')).join('\n\n'), 'analysis', 'video_generation');
    addSection(sections, 'seedance-continuity', '主体连续性', seedance.subjectContinuity.join('\n'), 'constraint', 'video_generation');
    addSection(sections, 'seedance-stages', '阶段与结束状态', seedance.stages.map((stage, index) => [
      `${index + 1}. ${stage.label}`,
      `开始状态：${stage.startState}`,
      `主要事件：${stage.mainEvent}`,
      `结束状态：${stage.endState}`,
      `延续条件：${stage.carryForward.join('；')}`,
    ].join('\n')).join('\n\n'), 'analysis', 'video_generation');
    addSection(sections, 'seedance-shots', '镜头拆解', seedance.shots.map((shot, index) => [
      `${index + 1}. ${shot.label}｜${shot.shotSize}`,
      `机位：${shot.camera}`,
      `运镜：${shot.movement}`,
      `动作：${shot.action}`,
      `灯光与特效：${shot.lightingAndEffects}`,
      `转场：${shot.transition}`,
      `声音：${shot.audio}`,
    ].join('\n')).join('\n\n'), 'analysis', 'video_generation');
    addSection(sections, 'seedance-audio', '声音与参数锁定', [
      `声音：${seedance.audioPlan.join('；')}`,
      `参数：${seedance.parameterLocks.join('；')}`,
    ].join('\n'), 'checklist', 'video_generation');
    addSection(sections, 'seedance-prompt-zh', 'Seedance 中文提示词', seedance.promptZh, 'prompt', 'video_generation');
    addSection(sections, 'seedance-prompt-en', 'Seedance English Prompt', seedance.promptEn, 'prompt', 'video_generation');
    addSection(sections, 'seedance-negative', 'Seedance 负向约束', seedance.negativeConstraints.join('\n'), 'constraint', 'video_generation');
    addSection(sections, 'seedance-boundaries', '能力边界', seedance.capabilityBoundaries.join('\n'), 'constraint', 'video_generation');
  }

  return sections;
}

function addSection(
  sections: ReverseResultSection[],
  id: string,
  title: string,
  text: string | undefined,
  kind: ReverseResultSection['kind'],
  sendTarget: ReverseResultSection['sendTarget'],
): void {
  if (text?.trim()) sections.push({ id, title, text: text.trim(), kind, sendTarget });
}

export function formatReverseResultDocument(result: Partial<ReversePromptResult>): string {
  return buildReverseResultSections(result).map((section) => section.title + '\n' + section.text).join('\n\n');
}

const PROFESSIONAL_CHAPTERS = [
  ['sceneDecomposition', 'scene-decomposition', '场景、形态与空间结构', 'either'],
  ['composition', 'composition', '构图与画幅', 'either'],
  ['camera', 'camera', '相机、透视与焦距估计', 'either'],
  ['depthAndFocus', 'depth-and-focus', '景深与对焦', 'either'],
  ['materialsAndTextures', 'materials-and-textures', '材质与纹理', 'either'],
  ['lightingAndColor', 'lighting-and-color', '灯光与色彩', 'either'],
  ['effects', 'effects', '特效与运动', 'either'],
  ['fluids', 'fluids', '流体运动与功能', 'either'],
  ['whiteBackgroundAdaptation', 'white-background', '白底产品适配', 'either'],
  ['subjectScaleAndPlacement', 'subject-scale', '主体比例与位置', 'either'],
  ['videoTimeline', 'video-timeline', '视频时间轴与分解动作', 'video_generation'],
  ['evidence', 'evidence', '观察、估计与未知', 'none'],
  ['uncertainties', 'uncertainties', '不确定性与待核实项', 'none'],
] as const;
const LABELS: Record<string, string> = {
  spatialStructure:'空间结构',spatialDepth:'空间深度',objects:'场景物体',name:'名称',role:'职责',placement:'位置',scaleAndProportion:'尺度与比例',depthLayer:'所在景层',occlusionAndZOrder:'遮挡与前后关系',shapeAndGeometry:'形态与几何',modelAndStructure:'模型与结构',
  visualCenter:'视觉中心',whitespaceAndSafeArea:'留白与安全区',guidingLinesAndBalance:'引导线与平衡',cropAndAspectRatio:'裁切与画幅',
  estimatedFocalLength:'估计焦距',shotSize:'景别',positionAndAngle:'机位与角度',perspectiveAndVanishingPoints:'透视与消失点',distortion:'畸变',confidence:'依据与置信度',
  focusSubjectAndPlane:'焦点主体与焦平面',depthOfField:'景深',foregroundBlur:'前景虚化',backgroundBlur:'背景虚化',separationMethod:'主体分离方式',
  object:'对象',material:'材质',roughnessReflectionTransmission:'粗糙度、反射与透射',textureScaleAndDetail:'纹理尺度与细节',productionMethod:'制作方法',
  keyFillRimEnvironment:'主光、补光、轮廓光与环境光',sweepLight:'扫光',colorTemperatureAndPalette:'色温与配色',contrastAndHighlightRolloff:'对比与高光过渡',reflectionsAndVolumetrics:'反射与体积光',premiumLookRationale:'质感依据',
  type:'类型',purpose:'功能与目的',recreation:'复现方法',productAdaptation:'产品适配',sourceOrEmitter:'来源与发射体',motionAndTiming:'运动与时序',parameters:'参数',masksAndCompositing:'遮罩与合成',renderPasses:'渲染通道',
  physicalBehavior:'物理行为',shadingAndTexture:'着色与纹理',productInteraction:'与产品的交互',safetyConstraints:'约束',silhouetteProtection:'轮廓保护',grounding:'接地',contaminationPrevention:'防止串色与污染',doNotCopy:'禁止照搬',
  subject:'主体',relativeScale:'相对比例',constraints:'约束',timeRange:'时间范围',shotType:'镜头景别',cameraMovement:'运镜',speedCurveAndStabilization:'速度曲线与稳定',subjectAction:'主体动作',lightingAndSweep:'灯光与扫光',effects:'特效',transition:'转场',keyframes:'关键帧',explodedViewMotion:'零件拆分与分解运动',fluidMotionAndFunction:'流体运动与功能',
  observations:'观察',estimates:'估计及依据',unknowns:'未知',promptLogic:'提示词逻辑',seedance25:'Seedance 视频方案',uncertainties:'不确定性',evidence:'观察、估计与未知',
};
function chapterTitle(key: string): string { return PROFESSIONAL_CHAPTERS.find((entry) => entry[0] === key)?.[2] ?? LABELS[key] ?? key; }
function formatChapterValue(value: unknown, depth = 0): string {
  if (depth > 10 || value === null || value === undefined) return '';
  if (typeof value === 'string') return ({ foreground: '前景', midground: '中景', background: '背景' } as Record<string,string>)[value] ?? value;
  if (Array.isArray(value)) return value.length ? value.map((item,index) => (index+1) + '. ' + formatChapterValue(item,depth+1)).join('\n') : '未观察到 / 不适用（以分析说明为准）';
  if (typeof value === 'object') return Object.entries(value).map(([key,item]) => (LABELS[key] ?? key) + '：' + formatChapterValue(item,depth+1)).join('\n');
  return String(value);
}
