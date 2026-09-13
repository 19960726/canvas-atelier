import type { ProviderBridgeProfile } from '@agent-canvas/desktop-core';
import { generationProfiles, type GenerationKind, type GenerationPreferences } from './generation-preferences';

export interface CreativeWorkflowStep { title: string; detail: string }
export interface CreativePlanOption { id: string; title: string; reason: string; kind: GenerationKind; prompt: string; modelRoute?: string; workflow?: CreativeWorkflowStep[] }
export interface CreativeRequirementAnalysis {
  goal: string;
  mustKeep: string[];
  mustChange: string[];
  mustAvoid: string[];
  acceptanceCriteria: string[];
}
export interface CreativePlan { summary: string; requirements: CreativeRequirementAnalysis; observations: string[]; estimates: string[]; unknowns: string[]; options: CreativePlanOption[] }
export interface ConstrainedCreativePlan { plan: CreativePlan; selectedKind: GenerationKind; rejectedCount: number }
export type CreativePromptQuality = { valid: true } | { valid: false; reason: 'copied' | 'contains-mention' | 'underspecified' };
const text = (value: unknown, max = 6000): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item) => text(item, 1200)).slice(0, 12) : [];

function normalizeRequirements(value: unknown, fallbackGoal: string): CreativeRequirementAnalysis {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    goal: text(record.goal, 1200) ? record.goal.trim() : fallbackGoal.trim(),
    mustKeep: strings(record.mustKeep),
    mustChange: strings(record.mustChange),
    mustAvoid: strings(record.mustAvoid),
    acceptanceCriteria: strings(record.acceptanceCriteria),
  };
}

function analyzeRequestRequirements(request: string, summary: string, kind: GenerationKind, referenceCount: number): CreativeRequirementAnalysis {
  const goal = request.replace(/@(?:图片|视频)\d+/gu, ' ').replace(/\s+/gu, ' ').trim() || summary.trim();
  const clauses = goal.split(/[，。；;、\n]+/u).map((clause) => clause.trim()).filter(Boolean).slice(0, 16);
  const keep = clauses.filter((clause) => /(?:保留|保持|锁定|维持|一致|不变|不(?:需要|要|得|可)?改变|原样)/u.test(clause));
  const change = clauses.filter((clause) => /(?:精修|修改|调整|替换|移除|增加|新增|生成|制作|优化|美化|改为|变成)/u.test(clause));
  const avoid = clauses.filter((clause) => /(?:禁止|不得|避免|不要(?!改变)|不能(?!改变)|去除|删掉)/u.test(clause));
  return {
    goal,
    mustKeep: keep,
    mustChange: change,
    mustAvoid: avoid,
    acceptanceCriteria: [
      `最终交付为${kind === 'image' ? '图片' : '视频'}，不得改成其他输出类型。`,
      ...(referenceCount > 0 ? [`按发送顺序使用 ${referenceCount} 个参考素材，并逐项核对需要保留和允许修改的内容。`] : []),
      `使用已确认的模型与参数执行，完成后检查${kind === 'image' ? '返图、实际像素和清晰度' : '视频文件、时长和分辨率'}。`,
    ],
  };
}

export function assessCreativeGenerationPrompt(prompt: string, request?: string): CreativePromptQuality {
  if (/@(?:图片|视频)\d+/u.test(prompt)) return { valid: false, reason: 'contains-mention' };
  const normalizedPrompt = normalizePromptForQuality(prompt);
  const normalizedRequest = request === undefined ? '' : normalizePromptForQuality(request);
  if (normalizedRequest.length >= 6) {
    const shorter = Math.min(normalizedPrompt.length, normalizedRequest.length);
    const longer = Math.max(normalizedPrompt.length, normalizedRequest.length);
    const addedLength = Math.max(0, normalizedPrompt.length - normalizedRequest.length);
    if (normalizedPrompt === normalizedRequest
      || (normalizedPrompt.includes(normalizedRequest) && addedLength <= Math.max(24, Math.floor(normalizedRequest.length * 0.5)))
      || (longer > 0 && shorter / longer >= 0.67 && bigramDice(normalizedPrompt, normalizedRequest) >= 0.88)) {
      return { valid: false, reason: 'copied' };
    }
  }
  if (normalizedPrompt.length < 12 || !hasExecutablePromptDetail(prompt, normalizedPrompt.length)) {
    return { valid: false, reason: 'underspecified' };
  }
  return { valid: true };
}

function normalizePromptForQuality(value: string): string {
  return value
    .replace(/@(?:图片|视频)\d+/gu, ' ')
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, '');
}

function hasExecutablePromptDetail(prompt: string, normalizedLength: number): boolean {
  const segments = prompt
    .replace(/@(?:图片|视频)\d+/gu, ' ')
    .split(/[，,。.;；：:\n]+/u)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length >= 2);
  const words = prompt.trim().split(/\s+/u).filter(Boolean);
  const dimensionPatterns = [
    /(?:产品|商品|主体|人物|物体|包装|设备|机器|杯|瓶|product|subject|object|person)/iu,
    /(?:构图|居中|视角|镜头|景别|透视|俯拍|平视|前景|中景|composition|camera|angle|lens|framing)/iu,
    /(?:柔和(?:侧|顶|逆)?光|侧光|顶光|逆光|轮廓光|自然光|窗光|棚拍光|环境光|硬光|软光|光线|照明|阴影|明暗|lighting|light|shadow)/iu,
    /(?:材质|(?<!品)质感|纹理|细节|金属|玻璃|织物|material|texture|detail|metal|glass|fabric)/iu,
    /(?:背景|场景|环境|色调|配色|色彩|(?:红|蓝|绿|黑|白|灰|暖|冷|中性|浅|深|低饱和|高饱和)色|棚拍|厨房|户外|background|scene|environment|color|palette|studio)/iu,
    /(?:保持|保留|禁止|不得|不要|避免|不变|清晰度|高清|输出|分辨率|keep|preserve|avoid|without|resolution|high[- ]?res)/iu,
  ];
  const dimensionCount = dimensionPatterns.filter((pattern) => pattern.test(prompt)).length;
  const hasEnoughStructure = segments.length >= 3 || words.length >= 8 || normalizedLength >= 28;
  return hasEnoughStructure && dimensionCount >= 3;
}

function bigramDice(left: string, right: string): number {
  const leftBigrams = new Map<string, number>();
  for (let index = 0; index < left.length - 1; index += 1) {
    const bigram = left.slice(index, index + 2);
    leftBigrams.set(bigram, (leftBigrams.get(bigram) ?? 0) + 1);
  }
  let overlap = 0;
  for (let index = 0; index < right.length - 1; index += 1) {
    const bigram = right.slice(index, index + 2);
    const available = leftBigrams.get(bigram) ?? 0;
    if (available <= 0) continue;
    overlap += 1;
    leftBigrams.set(bigram, available - 1);
  }
  return (2 * overlap) / Math.max(1, left.length - 1 + right.length - 1);
}

export function parseCreativePlan(message: string): CreativePlan | null {
  try {
    const source = JSON.parse(message.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, ''));
    if (!source || !text(source.summary, 2000) || !Array.isArray(source.options) || source.options.length < 1 || source.options.length > 3) return null;
    const options: CreativePlanOption[] = [];
    for (const option of source.options) {
      if (!option || !text(option.id, 80) || !text(option.title, 160) || !text(option.reason, 1200) || !text(option.prompt) || !['image', 'video'].includes(option.kind) || options.some((item) => item.id === option.id)) return null;
      const workflow = Array.isArray(option.workflow)
        ? option.workflow.flatMap((step: unknown) => {
          if (!step || typeof step !== 'object') return [];
          const record = step as Record<string, unknown>;
          return text(record.title, 160) && text(record.detail, 1200)
            ? [{ title: record.title.trim(), detail: record.detail.trim() }]
            : [];
        }).slice(0, 6)
        : [];
      options.push({ id: option.id, title: option.title, reason: option.reason, kind: option.kind, prompt: option.prompt, ...(text(option.modelRoute, 200) ? { modelRoute: option.modelRoute } : {}), ...(workflow.length > 0 ? { workflow } : {}) });
    }
    return {
      summary: source.summary,
      requirements: normalizeRequirements(source.requirements, source.summary),
      observations: strings(source.observations),
      estimates: strings(source.estimates),
      unknowns: strings(source.unknowns),
      options,
    };
  } catch { return null; }
}

export function creativeWorkflowSteps(option: CreativePlanOption, referenceCount: number): CreativeWorkflowStep[] {
  if ((option.workflow?.length ?? 0) >= 3) return option.workflow!;
  const kindLabel = option.kind === 'video' ? '视频' : '图片';
  return [
    {
      title: '整理需求与素材',
      detail: referenceCount > 0
        ? `连接 ${referenceCount} 个参考素材，按发送顺序保留主体、构图或风格约束。`
        : '把方案要求写入提示词节点，明确主体、场景、构图和禁止改变的内容。',
    },
    {
      title: `执行${kindLabel}生成`,
      detail: `使用${option.modelRoute ? ` ${option.modelRoute} ` : '已选择的生成模型'}执行完整提示词，保留已确认的比例、清晰度、质量和数量。`,
    },
    {
      title: '回写并检查结果',
      detail: `把${kindLabel}结果连接到输出节点，检查返图、实际尺寸和任务状态，应用重启后仍可恢复。`,
    },
  ];
}

export function constrainCreativePlanKind(plan: CreativePlan, selectedKind: GenerationKind): ConstrainedCreativePlan {
  const options = plan.options.filter((option) => option.kind === selectedKind);
  return {
    plan: { ...plan, options },
    selectedKind,
    rejectedCount: plan.options.length - options.length,
  };
}

export function recoverEmptyCreativePlan(
  message: string,
  request: string,
  preferences: GenerationPreferences,
  profiles: readonly ProviderBridgeProfile[],
  referenceCount = 0,
): CreativePlan | null {
  try {
    const source = JSON.parse(stripJsonFence(message));
    if (!source || !text(source.summary, 2000) || !Array.isArray(source.options) || source.options.length !== 0) return null;
    const kind = preferences.kind;
    const sourceRecord = source as Record<string, unknown>;
    const requirements = sourceRecord.requirements && typeof sourceRecord.requirements === 'object'
      ? normalizeRequirements(source.requirements, source.summary)
      : analyzeRequestRequirements(request, source.summary, kind, referenceCount);
    return {
      summary: source.summary,
      requirements,
      observations: strings(source.observations),
      estimates: strings(source.estimates),
      unknowns: strings(source.unknowns),
      options: [],
    };
  } catch {
    return null;
  }
}

function stripJsonFence(message: string): string {
  return message.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '');
}

export function creativePlanningInstructions(
  preferences: GenerationPreferences,
  profiles: readonly ProviderBridgeProfile[],
  referenceCount = 0,
  analysisDepth: 'fast' | 'standard' | 'deep' = 'standard',
): string {
  const routes = (['image', 'video'] as const).map((kind) => {
    const candidates = generationProfiles(profiles, kind, referenceCount);
    const fixed = candidates.find((profile) => profile.modelRoute === preferences[kind].modelRoute);
    const ordered = fixed ? [fixed, ...candidates.filter((profile) => profile !== fixed)] : candidates;
    const models: { route: string; name: string; parameters: unknown }[] = [];
    let budget = 3200;
    for (const profile of ordered) {
      const model = { route: profile.modelRoute, name: profile.displayName.slice(0, 100), parameters: profile.constraints?.[kind] };
      const size = JSON.stringify(model).length;
      if (size > budget) continue;
      models.push(model);
      budget -= size;
    }
    return { kind, preference: preferences[kind], models };
  });
  const analysisLabel = analysisDepth === 'fast' ? '快速分析' : analysisDepth === 'deep' ? '深度分析' : '标准分析';
  const depthInstruction = analysisDepth === 'fast'
    ? '快速分析只保留明确目标、硬约束和可执行步骤，避免重复描述。'
    : analysisDepth === 'deep'
      ? '深度分析需要检查要求之间的冲突、参考图证据、模型能力边界、构图与材质风险，并把无法确认的内容列入 unknowns；方案差异必须说明代价。'
      : '标准分析需要覆盖参考证据、修改边界、模型能力和交付验收，避免泛泛而谈。';
  return [
    '请先分析需求，给出合理的创作方案，等待用户选择，再由界面请求确认执行。不能声称已生成或修改画布。不输出隐藏思考，只提供可核查的分析摘要。',
    `需求分析强度：${analysisDepth}（${analysisLabel}）。${depthInstruction}`,
    '先逐句拆解用户要求：goal 是最终目标；mustKeep 是必须保留；mustChange 是只允许或明确要求修改；mustAvoid 是禁止出现或禁止改动；acceptanceCriteria 是用户可以检查的交付标准。区分 observations（观察：参考素材中直接可见）、estimates（估计，含依据）、unknowns（未知）。要求冲突或信息不足时列入 unknowns，不得自行放宽“其他不要改变”等限制。',
    '图片/视频生成需求明确时，返回纯 JSON：{"summary":"需求与取舍摘要","requirements":{"goal":"最终目标","mustKeep":[],"mustChange":[],"mustAvoid":[],"acceptanceCriteria":[]},"observations":[],"estimates":[],"unknowns":[],"options":[{"id":"option-1","title":"方案名称","reason":"适用原因与取舍","kind":"image 或 video","prompt":"根据你的分析重新编写的完整可执行提示词，包含主体锁定、修改范围、禁止项、构图、光线、材质、清晰度与输出要求","modelRoute":"从可用生成模型中选择","workflow":[{"title":"用户能理解的步骤名称","detail":"该步骤会使用什么输入、创建什么节点、落实哪条要求并做什么检查"}]}]}。提示词必须是你分析后的执行语言，不能原样复制用户请求、@图片标记或聊天套话。提供1至3个有实质差异的方案，每个方案提供3至6个具体 workflow 步骤，不能只给关键词或用相同提示词填充。每条要求必须落实到完整提示词或 workflow；验收标准必须出现在最后的检查步骤。',
    `本次已明确选择输出类型：${preferences.kind}。所有 options.kind 必须为 ${preferences.kind}，不得自动改成 ${preferences.kind === 'image' ? 'video' : 'image'}。如果所选类型没有兼容路线，返回 options:[] 并明确提示用户配置兼容模型；不能用另一种产物代替。固定模型与参数必须遵守，可用目录：${JSON.stringify(routes)}`,
    ...(referenceCount > 0 ? ['本次请求含有参考图，图片方案只能引用支持 image_edit 或 gemini_native 的路线；视频方案必须匹配参考图数量对应的输入模式。'] : []),
    '聊天模型只负责规划。选项中只引用生成目录的路线，不能使用聊天路线。没有可用生成模型时给出建议并说明需配置，不能声称可以执行。',
  ].join('\n');
}
