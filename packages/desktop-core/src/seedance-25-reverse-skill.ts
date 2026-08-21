export const SEEDANCE_25_REVERSE_SKILL_ID = 'seedance-2-5-reverse' as const;
export const SEEDANCE_25_REVERSE_SKILL_VERSION = '2026-08-21.1' as const;

export type Seedance25TaskType =
  | 'text_to_video'
  | 'multi_reference'
  | 'long_video'
  | 'video_edit'
  | 'extend_forward'
  | 'extend_backward'
  | 'first_last_frame'
  | 'multi_keyframe'
  | 'storyboard'
  | 'coarse_blocking'
  | 'fine_blocking'
  | 'one_click_film'
  | 'seamless_transition';

export interface Seedance25ReverseSkill {
  readonly id: typeof SEEDANCE_25_REVERSE_SKILL_ID;
  readonly version: typeof SEEDANCE_25_REVERSE_SKILL_VERSION;
  readonly source: string;
  readonly purpose: string;
  readonly taskTypes: readonly Seedance25TaskType[];
  readonly rules: readonly string[];
  readonly outputContract: Readonly<Record<string, unknown>>;
}

const SKILL = deepFreeze({
  id: SEEDANCE_25_REVERSE_SKILL_ID,
  version: SEEDANCE_25_REVERSE_SKILL_VERSION,
  source: 'https://mp.weixin.qq.com/s/Jv5iCILkg10q8o-KZ4GpNQ',
  purpose: '把图片、视频和用户任务反推为适配 Seedance 2.5 的制作级素材调度、镜头时间线、连续性与声音提示词。',
  taskTypes: [
    'text_to_video',
    'multi_reference',
    'long_video',
    'video_edit',
    'extend_forward',
    'extend_backward',
    'first_last_frame',
    'multi_keyframe',
    'storyboard',
    'coarse_blocking',
    'fine_blocking',
    'one_click_film',
    'seamless_transition',
  ],
  rules: [
    '先根据真实输入和用户任务选择 seedanceTaskType；证据不足时说明不确定性，不虚构编辑母版、首帧、尾帧、音频或延长方向。',
    '逐份写明素材职责：每张图片、每段视频和每段音频分别采用什么、不采用什么、绑定哪个人物/商品/道具/场景/动作/声音；不得把多份素材模糊合并为一个映射。',
    '同一主体的多视角必须声明为同一个连续对象；人物身份、五官、服装、商品结构、Logo 与包装文字、数量、道具归属和空间方向不得互换或漂移。',
    '长视频按连续阶段组织，每个阶段只安排一个主要状态变化，并写清开始状态、主要事件、结束时可直接观察的状态和下一阶段需要承接的内容。',
    '视频编辑必须把原视频定义为唯一母版，明确编辑对象、时间或区域范围、目标素材、时间线继承和保持内容；未指定部分保持人物、场景、动作、遮挡、镜头、声音与事件顺序。',
    '向后延长先锁定原视频尾帧作为新片段首画面；向前延长把原视频首帧写成新片段末画面；两种方向都保持身份、道具、背景、摄影轴线、运动趋势、光线和声音连续。',
    '首帧、尾帧和每张关键帧分别说明构图、主体位置、姿态、道具状态和镜头方向；首尾画幅保持一致；关键帧控制阶段顺序与状态，不承诺逐帧复刻。',
    '宫格分镜必须说明读取顺序、逐格景别/动作/运镜和最终画风与声音，不继承线稿风格、文字标注或占位人物；建议不超过十五格。',
    '先判断白模职责：粗粒度白模只继承动作路径、站位、机位、运镜、切镜、光影和声音时序；细粒度白模保持完整结构与镜头，只重渲染人物、材质、色彩、场景和风格。',
    '一键成片必须输出素材顺序、每张图片的动态幅度、剪辑节奏、转场、视觉包装和声音，不得只写“把素材做成视频”。',
    '无缝转场必须定义前后视频职责、触发动作、镜头方向与速度、形状/材质/光线变化、到达状态和声音衔接；连续不等于逐像素不变。',
    '镜头时间线逐镜头写景别、机位、可见焦距效果、运镜路径、速度曲线、稳定方式、主体动作、光线与扫光、特效/流体、转场、关键状态和声音。',
    '抽象情绪必须翻译为二至四个可观察或可听见的眼神、眉头、嘴角、呼吸、视线、手部或说话变化；小众摄影术语同时解释作用主体、画面变化、前后景关系、方向和速度。',
    '声音区分对白、语言与口音、环境声、动作音效、音乐和字幕；可用 {台词}、<音效>、(音乐)、【字幕】表达，未提供声音证据时不得捏造具体台词。',
    '时间戳只用于分配事件节奏，时间段连续且不重叠，不视为帧级剪辑点；生成参数由页面或接口控制，不把参数控件重复写成叙事提示词。',
    '能力边界必须明确：视频编辑不保证逐帧重合，准确字幕/公式/标牌需前期合成和后期制作，编辑时长可能有轻微误差，生成式转场只追求视觉与声音连续。',
    '最终中文和英文提示词都按“目标→素材职责→主体映射→阶段/镜头→连续性→声音→保持/禁止→参数锁定与能力边界”组织，可脱离分析正文直接执行。',
  ],
  outputContract: {
    taskType: 'one supported Seedance25TaskType',
    rationale: '基于输入素材和用户任务的选择依据与不确定性',
    assetBindings: [{ sourceId: 'source id', target: '绑定主体或职责', adopt: ['采用内容'], reject: ['不采用内容'] }],
    subjectContinuity: ['人物、商品、道具、空间和声音连续性'],
    stages: [{ label: '阶段', startState: '开始状态', mainEvent: '一个主要变化', endState: '结束可见状态', carryForward: ['承接内容'] }],
    shots: [{ label: '镜头', shotSize: '景别', camera: '机位与焦距效果', movement: '运镜路径与速度', action: '动作', lightingAndEffects: '灯光/扫光/VFX/流体', transition: '转场', audio: '声音' }],
    audioPlan: ['对白、语言、环境声、音效、音乐与字幕'],
    parameterLocks: ['任务导致的比例与时长锁定，以及页面参数建议'],
    promptZh: '可直接执行的中文 Seedance 2.5 提示词',
    promptEn: 'copy-ready English Seedance 2.5 prompt',
    negativeConstraints: ['身份漂移、产品变形、数量变化、错配、跳轴、重复动作和边界断裂约束'],
    capabilityBoundaries: ['时间戳、逐帧一致、准确文字、时长误差和转场能力边界'],
  },
} satisfies Seedance25ReverseSkill);

export function getSeedance25ReverseSkill(): Seedance25ReverseSkill {
  return SKILL;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
