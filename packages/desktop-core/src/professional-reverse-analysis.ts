import {
  normalizeReverseRolePreference,
  type ReversePromptRun,
} from '@agent-canvas/domain';
import {
  getSeedance25ReverseSkill,
  type Seedance25ReverseSkill,
} from './seedance-25-reverse-skill.js';

export type ProfessionalReverseAnalysisMode = 'single_image' | 'multi_reference' | 'video';

export interface ProfessionalReverseRequest {
  readonly systemRole: string;
  readonly userPreference?: string;
  readonly analysisMode: ProfessionalReverseAnalysisMode;
  readonly task: string;
  readonly knowledge: unknown;
  readonly builtinSkills: readonly Seedance25ReverseSkill[];
  readonly taskRoutingHints: {
    readonly hasVideo: boolean;
    readonly imageCount: number;
    readonly videoCount: number;
    readonly taskText: string;
  };
  readonly mediaManifest: Array<{
    readonly sourceId: string;
    readonly order: number;
    readonly kind: 'image' | 'video';
    readonly label: string;
    readonly mention: string;
    readonly declaredRole?: string;
    readonly durationMs?: number;
  }>;
  readonly evidenceRules: readonly string[];
  readonly modeInstructions: readonly string[];
  readonly requiredOutput: Record<string, unknown>;
}

const SYSTEM_ROLE = [
  '你是资深商业视觉导演、产品摄影指导、VFX 特效总监、流体与灯光合成指导、镜头语言分析师和提示词工程师。',
  '必须基于可见证据做制作级拆解，区分观察事实、合理估计和不确定内容；不得用空泛风格词代替空间、材质、灯光、镜头或特效分析。',
  '最终方案必须能迁移到用户的白底产品图，并保护产品轮廓、比例、Logo、包装文字、接触阴影和真实反射。',
  '当用户在任务中用@图片N或@视频N指定素材职责时，这些映射是合成约束，必须逐条执行并保留来源追踪。',
  '素材事实、用户明确的素材分工和产品适配目标优先于自由创意；无来源或任务依据的新增人物、道具、食物、装饰、品牌和文字不得混入默认正向提示词。',
].join(' ');

const COMMON_EVIDENCE_RULES = [
  '先解析任务中的@图片N/@视频N映射，建立“引用编号→sourceId→职责→采用内容”的素材绑定表，编号不能错位。',
  '逐张、逐段覆盖所有引用素材，不得遗漏；每项结论注明来自哪个 sourceId。',
  '逐张分析纹理与材质证据，包括粗糙度、反射、透明/半透明、纹理尺度、微表面细节和可复现制作方法。',
  '明确每张素材的职责、优先级、应继承内容、冲突内容、不可复制内容以及如何参与最终融合。',
  '如果任务明确指定某素材只提供镜头、材质、道具、服装或构图，就只继承该职责，不得把该素材中的其他主体整体复制进最终画面。',
  '必须单独分析场景结构与空间感：前景、中景、背景、主体位置、遮挡关系、纵深层次、透视线、机位高度、镜头压缩感、前后景距离和景深衰减。',
  '必须单独分析构图：视觉中心、主体占比、留白与安全区、水平线、引导线、画面比例、裁切方式以及各素材如何共同形成构图。',
  '分析主体/模特/产品/食物/道具的位置、画面占比、真实比例、遮挡关系、前中后景和场景结构。',
  '估计焦距、机位和透视时必须给出范围、可见依据和置信度，不得伪造 EXIF 或隐藏制作参数。',
  '如存在特效，逐层说明视觉职责、发射源、运动与时间、关键参数、遮罩、混合模式、合成顺序、渲染通道和复现步骤。',
  '如存在流体，说明用途、形态、黏度、表面张力、速度方向、模拟或二维替代方法、网格/着色以及与产品的遮挡和安全距离。',
  '逐一拆解主光、辅光、轮廓光、环境光、扫光、体积光、反射和高光衰减，并解释高级感来自何处。',
  '给出适配白底产品图的保轮廓、落地阴影、反射锚定、颜色污染控制、特效隔离和禁止照搬清单。',
  '关键词与最终提示词必须具体到对象、位置、比例、动作、表面、光线、镜头、特效或时间，不得只返回一行空泛风格形容词。',
  '最终提示词按“主体与产品身份→场景结构与空间感→构图与镜头→材质与道具→人物与动作→灯光与色彩→白底产品适配→质量与限制”组织，并保留@图片N的职责来源。',
  '图片提示词按 Subject → Action → Environment → Camera/Composition → Lighting/Color → Materials/Textures → Effects/Fluids → Style/Quality 组织。',
  'Seedance 2.5 提示词按目标 → 素材职责 → 主体映射 → 阶段/镜头 → 连续性 → 声音 → 保持/禁止 → 参数锁定与能力边界组织。',
] as const;

const REQUIRED_OUTPUT = {
  sessionId: 'copy the supplied session id exactly',
  nonce: 'copy the supplied nonce exactly',
  knowledgeSnapshotVersion: 'copy the supplied knowledge snapshot version exactly',
  analysis: '完整中文结论摘要，必须覆盖空间、比例、材质、灯光、镜头、特效和产品适配',
  keywords: ['具体且可执行的中英文视觉关键词'],
  mediaResponsibilities: [{
    mention: '@图片N or @视频N',
    sourceId: 'source asset id',
    label: 'source label',
    role: 'product_identity | composition | material_texture | lighting | model_pose | food_scale | camera_motion | effects',
    priority: 'primary | secondary | supporting',
    inheritance: ['应继承的具体元素'],
    conflicts: ['与其他素材冲突的具体元素及处理方式'],
    usableElements: ['该素材可用于最终方案的具体内容，必须包含纹理/材质证据'],
  }],
  sceneDecomposition: {
    spatialStructure: '场景结构、前景/中景/背景、纵深层次、遮挡关系、空间连接和场景空间感',
    spatialDepth: '机位高度、透视线、镜头压缩感、前后景距离、景深衰减及空间感来源',
    objects: [{ name: '对象', role: '职责', placement: '归一化位置', scaleAndProportion: '占比和比例', depthLayer: 'foreground | midground | background', occlusionAndZOrder: '遮挡与层级' }],
  },
  composition: { visualCenter: '视觉中心与主体占比', whitespaceAndSafeArea: '留白与安全区', guidingLinesAndBalance: '水平线、引导线和平衡', cropAndAspectRatio: '裁切方式和画幅比例' },
  camera: { estimatedFocalLength: '估计焦距范围', shotSize: '景别', positionAndAngle: '高度/俯仰/方位', perspectiveAndVanishingPoints: '透视与消失点', distortion: '畸变', confidence: '依据和置信度' },
  depthAndFocus: { focusSubjectAndPlane: '焦点与焦平面', depthOfField: '景深', foregroundBlur: '前景虚化', backgroundBlur: '背景虚化', separationMethod: '主体分离方法' },
  materialsAndTextures: [{ object: '对象', material: '材质', roughnessReflectionTransmission: '粗糙/反射/透射', textureScaleAndDetail: '纹理尺度和细节', productionMethod: '制作方法' }],
  lightingAndColor: { keyFillRimEnvironment: ['逐灯拆解'], sweepLight: '扫光路径/宽度/软硬/速度/强度/作用材质', colorTemperatureAndPalette: '色温与色板', contrastAndHighlightRolloff: '对比与高光衰减', reflectionsAndVolumetrics: '反射与体积光', premiumLookRationale: ['高级感的具体来源'] },
  effects: [{ type: '特效类型', purpose: '视觉职责', sourceOrEmitter: '发射源', motionAndTiming: '运动和时间', parameters: ['参数'], masksAndCompositing: ['遮罩与合成顺序'], renderPasses: ['渲染通道'], recreation: ['复现步骤'], productAdaptation: '适配白底产品的方法' }],
  fluids: [{ type: '流体类型', purpose: '用途', physicalBehavior: '黏度/表面张力/方向', productionMethod: ['模拟或二维替代步骤'], shadingAndTexture: '网格与着色', productInteraction: '与产品交互', safetyConstraints: ['安全约束'] }],
  whiteBackgroundAdaptation: { silhouetteProtection: ['轮廓保护'], grounding: ['接触阴影与反射锚定'], contaminationPrevention: ['防止白底和产品颜色污染'], doNotCopy: ['不可照搬元素'] },
  subjectScaleAndPlacement: [{ subject: '模特/产品/食物/道具', relativeScale: '相对比例', placement: '位置', constraints: ['约束'] }],
  videoTimeline: [{ timeRange: '00:00.000-00:02.000', shotType: '景别', estimatedFocalLength: '焦距', cameraMovement: '运镜', speedCurveAndStabilization: '速度曲线和稳定方式', subjectAction: '主体动作', lightingAndSweep: '灯光与扫光', effects: ['特效'], transition: '转场', keyframes: ['关键帧'], productAdaptation: '白底产品适配' }],
  promptLogic: {
    subject: '主体身份、外观、比例和保护约束',
    action: '主体动作或事件',
    environment: '场景、时间、天气、空间关系和背景状态',
    cameraAndComposition: '景别、机位、焦距效果、透视、运镜和构图',
    lightingAndColor: '主辅轮廓环境光、扫光、色温、色板和高光衰减',
    materialsAndTextures: '逐对象材质、粗糙/反射/透射、纹理尺度与细节',
    effectsOrFluids: '特效/流体职责、运动、参数、遮罩合成与产品适配',
    styleAndQuality: '风格、摄影质感、色彩管理和质量要求',
    rationale: ['各段组织理由与可修改项'],
  },
  seedance25: getSeedance25ReverseSkill().outputContract,
  positivePrompt: '兼容旧界面的主提示词',
  positivePromptZh: '可直接执行的中文提示词',
  positivePromptEn: 'copy-ready English prompt',
  negativeConstraints: ['具体负面约束'],
  executionChecklist: ['按制作顺序排列的检查清单'],
  uncertainties: ['不可见或只能估计的内容'],
};

export function buildProfessionalReverseRequest(
  run: ReversePromptRun,
  knowledge: unknown,
): ProfessionalReverseRequest {
  const hasVideo = run.orderedMedia.some((item) => item.kind === 'video');
  const analysisMode: ProfessionalReverseAnalysisMode = hasVideo
    ? 'video'
    : run.orderedMedia.length > 1
      ? 'multi_reference'
      : 'single_image';
  const userPreference = normalizeReverseRolePreference(run.agentConfig?.role ?? '');
  const modeInstructions = analysisMode === 'video'
    ? [
      '按时间轴逐镜头拆解视频，镜头边界不得只按均匀时长猜测；说明切镜依据。',
      '逐镜头分析景别、估计焦距、机位、推拉摇移跟、升降环绕、手持/稳定器、速度曲线、稳定方式、主体动作、转场和关键帧。',
      '检查是否存在扫光、轮廓光、体积光、粒子、流体、烟雾、折射、辉光、光带或其他特效，逐层说明高级感来源和制作方式。',
      '把可复用的运镜、灯光和特效提炼成适配用户白底产品素材的镜头表，明确不能照搬的背景、品牌和比例。',
    ]
    : analysisMode === 'multi_reference'
      ? [
        '先逐张素材独立分析，再综合；逐张输出职责、纹理、材质、空间、构图、光线和可复现手法，不得遗漏任何 sourceId。',
        '建立素材职责表，明确主参考、产品身份、构图、纹理材质、人物/食物比例、灯光、特效各自来源和优先级。',
        '列出继承关系、冲突关系和裁决理由，最终提示词中的关键要求必须能追溯到具体素材。',
      ]
      : [
        '对单张素材做深度取证：空间结构、主体/模特/食物位置与比例、前中后景、景深、焦点、纹理材质、灯光、焦距、机位和透视。',
        '检查所有可见特效、流体和光效，逐层说明用途、实现和白底产品适配，不得只罗列风格形容词。',
      ];

  return {
    systemRole: SYSTEM_ROLE,
    ...(userPreference === undefined ? {} : { userPreference }),
    analysisMode,
    task: run.agentConfig?.task ?? '对引用素材进行专业视觉反推并适配用户产品。',
    knowledge,
    builtinSkills: [getSeedance25ReverseSkill()],
    taskRoutingHints: {
      hasVideo,
      imageCount: run.orderedMedia.filter((item) => item.kind === 'image').length,
      videoCount: run.orderedMedia.filter((item) => item.kind === 'video').length,
      taskText: run.agentConfig?.task ?? '对引用素材进行专业视觉反推并适配用户产品。',
    },
    mediaManifest: buildMediaManifest(run),
    evidenceRules: COMMON_EVIDENCE_RULES,
    modeInstructions,
    requiredOutput: {
      ...REQUIRED_OUTPUT,
      sessionId: run.sessionId,
      nonce: run.nonce,
      knowledgeSnapshotVersion: run.knowledgeLease.versionKey,
    },
  };
}

function buildMediaManifest(run: ReversePromptRun): ProfessionalReverseRequest['mediaManifest'] {
  let imageNumber = 0;
  let videoNumber = 0;
  return run.orderedMedia.map((item) => {
    const mention = item.kind === 'image'
      ? `@图片${++imageNumber}`
      : `@视频${++videoNumber}`;
    return {
      sourceId: item.assetId,
      order: item.order,
      kind: item.kind,
      label: item.label,
      mention,
      ...(item.kind === 'image' ? { declaredRole: item.role } : { durationMs: item.durationMs }),
    };
  });
}
